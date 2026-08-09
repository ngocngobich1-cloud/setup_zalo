import {
  getAdminZalo,
  getAiChatConfig,
  huyLichHen,
  listLichHen,
  listThreads,
  themLichHen,
} from "./db.js";
import { call, extractReply, splitModel, KHONG_TOOL } from "./opencode.js";
import { dinhDangGio } from "./scheduler.js";
import * as emailCheck from "./email-check.js";
import { addLog } from "./activity-log.js";

const LAP_LAI_HOP_LE = ["", "hang_ngay", "hang_tuan"];
const TEN_LAP_LAI = { hang_ngay: "hằng ngày", hang_tuan: "hằng tuần" };

/**
 * Doc moc thoi gian model tra ve. Bat buoc dung dang YYYY-MM-DD HH:mm va phai
 * khop lai sau khi dung Date: viet 2026-02-30 thi Date se tu nhay sang 02/03,
 * gui tin sai ngay ma khong ai biet.
 */
function docMoc(chuoi) {
  const m = String(chuoi || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, nam, thang, ngay, gio, phut] = m.map(Number);
  const d = new Date(nam, thang - 1, ngay, gio, phut, 0, 0);
  if (
    d.getFullYear() !== nam ||
    d.getMonth() !== thang - 1 ||
    d.getDate() !== ngay ||
    d.getHours() !== gio ||
    d.getMinutes() !== phut
  ) {
    return null;
  }
  return Math.floor(d.getTime() / 1000);
}

/** Lenh cho cho xac nhan, theo tung cuoc tro chuyen. Mat khi restart - khong sao,
 *  chi can nhan lai lenh. Co han de mot lenh cu khong bat ngo duoc gui di sau nhieu gio. */
const cho = new Map();
const HAN_XAC_NHAN_MS = 10 * 60 * 1000;

const TU_DONG_Y = ["ok", "oke", "okey", "đồng ý", "dong y", "xác nhận", "xac nhan", "gửi", "gui", "ừ", "u"];
const TU_HUY = ["huỷ", "huy", "hủy", "không", "khong", "thôi", "thoi", "cancel", "dừng", "dung"];

function chuanHoa(text) {
  return String(text || "").trim().toLowerCase().replace(/[.!,]+$/g, "");
}

/**
 * Lenh CHI duoc nhan trong chat RIENG voi dung nick admin.
 * Neu nhan ca trong nhom thi bat ky ai go dung cau do cung sai khien duoc bot.
 */
export async function laLenhAdmin(message) {
  if (Number(message?.threadType) !== 0) return false;
  const admin = await getAdminZalo();
  if (!admin.uid) return false;
  return String(message.senderId) === String(admin.uid);
}

async function danhSachDichDen() {
  const threads = await listThreads({ recentOnly: true });
  return threads.map((t) => ({
    id: t.id,
    ten: t.title || t.id,
    loai: Number(t.threadType) === 1 ? "nhom" : "nick",
  }));
}

const HUONG_DAN = `Bạn là bộ phân tích lệnh. Chủ shop nhắn một câu tiếng Việt, bạn phải chuyển thành JSON.

Chỉ trả về JSON thuần, không kèm giải thích, không kèm dấu \`\`\`.

GỬI NGAY:
{"hanhDong":"gui_tin","dichId":"<id>","dichTen":"<tên>","noiDung":"<nội dung>"}

HẸN GIỜ GỬI (một câu lệnh có thể chứa NHIỀU mốc giờ):
{"hanhDong":"dat_lich","lich":[
  {"dichId":"<id>","dichTen":"<tên>","noiDung":"<nội dung>","luc":"YYYY-MM-DD HH:mm","lapLai":""}
]}

XEM DANH SÁCH LỊCH: {"hanhDong":"xem_lich"}
HUỶ MỘT LỊCH:       {"hanhDong":"huy_lich","id":<số>}

TRA CỨU EMAIL ĐÃ GỬI CHƯA:
{"hanhDong":"tra_mail","email":"<địa chỉ email trong câu>"}
Dùng khi chủ shop hỏi đã gửi mail cho ai đó chưa, mail có tới nơi không, kiểm tra mail...
Ví dụ: "tra xem mail gửi a@b.com thành công chưa", "check mail c@d.com giúp chị",
"đã gửi mail cho e@f.com chưa em".

KHÔNG HIỂU:         {"hanhDong":"khong_hieu","lyDo":"<ngắn gọn, tiếng Việt>"}

Quy tắc chung:
- dichId PHẢI lấy đúng từ danh sách bên dưới, không được bịa.
- noiDung là nội dung sẽ gửi cho người nhận, KHÔNG kèm phần ra lệnh như "hãy nhắn vào nhóm..." hay phần chỉ giờ.
- Giữ nguyên đường link và cách xuống dòng trong nội dung.

Quy tắc về thời gian:
- "luc" luôn theo giờ Việt Nam, dạng YYYY-MM-DD HH:mm, dùng đồng hồ 24 giờ.
- Dựa vào MỐC HIỆN TẠI bên dưới để hiểu "mai", "thứ Ba tới", "8h sáng 10/8".
- "8h sáng"=08:00, "2h chiều"/"14h"=14:00, "8h tối"=20:00, "14h45 chiều"=14:45.
- Nếu một mốc chỉ ghi giờ mà không ghi ngày, lấy ngày của mốc ĐỨNG NGAY TRƯỚC trong cùng câu lệnh. Nếu không có mốc nào trước đó thì lấy ngày hôm nay; nếu giờ đó đã trôi qua rồi thì lấy ngày mai.
- "lapLai": để "" nếu chỉ gửi một lần; "hang_ngay" nếu lặp mỗi ngày; "hang_tuan" nếu lặp mỗi tuần.
- Nếu câu lệnh mơ hồ về thời gian, trả về khong_hieu chứ TUYỆT ĐỐI KHÔNG đoán bừa.`;

async function phanTichLenh(config, cauLenh, dichDen) {
  const model = splitModel(config.opencodeModel);
  const session = await call(config, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "Phan tich lenh admin", agent: config.opencodeAgent || "general" }),
  });

  try {
    const danhSach = dichDen.map((d) => `- id=${d.id} | loại=${d.loai} | tên="${d.ten}"`).join("\n");
    // Model khong tu biet hom nay la ngay may. Khong dua moc hien tai vao thi
    // "mai", "thu Ba toi", "15h" deu khong the tinh ra ngay that.
    const bayGio = new Date();
    const moc =
      `Bây giờ là ${bayGio.toLocaleString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}` +
      ` (dạng máy: ${bayGio.getFullYear()}-${String(bayGio.getMonth() + 1).padStart(2, "0")}-${String(bayGio.getDate()).padStart(2, "0")} ${String(bayGio.getHours()).padStart(2, "0")}:${String(bayGio.getMinutes()).padStart(2, "0")}), giờ Việt Nam.`;

    const response = await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
      method: "POST",
      body: JSON.stringify({
        agent: config.opencodeAgent || "general",
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
        tools: KHONG_TOOL,
        parts: [
          {
            type: "text",
            text: `${HUONG_DAN}\n\n# MỐC HIỆN TẠI\n${moc}\n\n# DANH SÁCH ĐÍCH ĐẾN\n${danhSach}\n\n# CÂU LỆNH\n${cauLenh}`,
          },
        ],
      }),
    });
    if (response?.info?.error) throw new Error(response.info.error?.data?.message || "OpenCode lỗi");

    const tho = extractReply(response).replace(/^```(?:json)?|```$/gim, "").trim();
    try {
      return JSON.parse(tho);
    } catch {
      return { hanhDong: "khong_hieu", lyDo: "Không đọc được kết quả phân tích." };
    }
  } finally {
    await call(config, `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" }).catch(() => {});
  }
}

/**
 * @param {object} message tin nhan da normalize
 * @param {(payload) => Promise<any>} gui ham gui tin (truyen tu zalo-service de tranh vong import)
 * @returns {Promise<string|null>} cau tra loi gui lai cho admin
 */
export async function xuLyLenh(message, gui) {
  const config = await getAiChatConfig();
  const noiDung = String(message.content || "").trim();
  const khoa = String(message.threadId);
  const dangCho = cho.get(khoa);

  // Buoc xac nhan: chi khi dang co lenh cho san
  if (dangCho) {
    if (Date.now() > dangCho.hetHan) {
      cho.delete(khoa);
    } else if (TU_DONG_Y.includes(chuanHoa(noiDung))) {
      cho.delete(khoa);
      return dangCho.loai === "dat_lich" ? datLich(dangCho) : guiNgay(dangCho, gui);
    } else if (TU_HUY.includes(chuanHoa(noiDung))) {
      cho.delete(khoa);
      await addLog({ event: "admin_cancel", level: "warn", summary: "Admin huỷ lệnh", detail: { loai: dangCho.loai } });
      return dangCho.loai === "dat_lich" ? "Đã huỷ, em không đặt lịch nào cả." : "Đã huỷ, em không gửi gì cả.";
    }
    // Khong phai OK/HUY -> coi la lenh moi, thay the lenh dang cho
  }

  const dichDen = await danhSachDichDen();
  if (dichDen.length === 0) return "Chưa có cuộc trò chuyện nào để gửi ạ.";

  let ketQua;
  try {
    ketQua = await phanTichLenh(config, noiDung, dichDen);
  } catch (error) {
    await addLog({ event: "admin_error", level: "error", summary: `Không phân tích được lệnh: ${error.message}`, detail: { noiDung } });
    return `Em chưa hiểu được lệnh: ${error.message}`;
  }

  if (ketQua?.hanhDong === "tra_mail") return traMailChoAdmin(ketQua.email || noiDung, message);
  if (ketQua?.hanhDong === "xem_lich") return xemLich();
  if (ketQua?.hanhDong === "huy_lich") return huyMotLich(ketQua.id);
  if (ketQua?.hanhDong === "dat_lich") return chuanBiDatLich(ketQua, dichDen, khoa, noiDung);

  if (ketQua?.hanhDong !== "gui_tin" || !ketQua.dichId || !ketQua.noiDung) {
    await addLog({ event: "admin_unknown", level: "warn", summary: `Không hiểu lệnh: ${noiDung.slice(0, 60)}`, detail: { ketQua } });
    // Liet ke dung nhung viec bot lam duoc. Truoc day cau nay chi noi ve gui tin,
    // nen chi hoi tra mail thieu dia chi lai bi khuyen "noi ro gui vao nhom nao".
    return [
      `Em chưa hiểu ạ${ketQua?.lyDo ? ` (${ketQua.lyDo})` : ""}.`,
      "Em làm được mấy việc này:",
      "• Gửi tin — “nhắn vào nhóm masterclass là ...”",
      "• Hẹn giờ gửi — “8h sáng 10/8 gửi nhóm masterclass là ...”",
      "• Xem lịch / huỷ lịch — “xem lịch”, “huỷ lịch 3”",
      "• Tra mail — “tra xem mail gửi abc@gmail.com chưa”",
    ].join("\n");
  }

  // Model co the bia id -> doi chieu lai voi danh sach that truoc khi chap nhan.
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) {
    await addLog({ event: "admin_unknown", level: "warn", summary: "Model tra ve dich den khong co that", detail: { ketQua } });
    return "Em không tìm thấy nhóm/nick đó trong danh sách. Chị nói rõ tên giúp em.";
  }

  cho.set(khoa, {
    loai: "gui_tin",
    dichId: dich.id,
    dichTen: dich.ten,
    loaiDich: dich.loai,
    noiDung: ketQua.noiDung,
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });
  await addLog({
    event: "admin_command",
    level: "info",
    summary: `Lệnh admin — chờ xác nhận gửi vào "${dich.ten}"`,
    detail: { dichId: dich.id, dichTen: dich.ten, loai: dich.loai, noiDung: ketQua.noiDung, cauLenh: noiDung },
  });

  return [
    `Em sẽ gửi vào ${dich.loai === "nhom" ? "nhóm" : "nick"} 「${dich.ten}」 nội dung:`,
    "",
    ketQua.noiDung,
    "",
    "Chị gõ OK để em gửi, hoặc HUỶ để bỏ.",
  ].join("\n");
}

async function guiNgay(dangCho, gui) {
  try {
    await gui({
      threadId: dangCho.dichId,
      threadType: dangCho.loaiDich === "nhom" ? 1 : 0,
      text: dangCho.noiDung,
    });
    await addLog({
      event: "admin_sent",
      level: "ok",
      summary: `Đã gửi theo lệnh admin vào "${dangCho.dichTen}"`,
      detail: { dichId: dangCho.dichId, dichTen: dangCho.dichTen, noiDung: dangCho.noiDung },
    });
    return `Đã gửi vào ${dangCho.loaiDich === "nhom" ? "nhóm" : "nick"} "${dangCho.dichTen}" rồi ạ.`;
  } catch (error) {
    await addLog({ event: "admin_error", level: "error", summary: `Gửi thất bại: ${error.message}`, detail: { dichId: dangCho.dichId } });
    return `Em gửi không được: ${error.message}`;
  }
}

/**
 * Kiem tra tung moc gio truoc khi cho chi duyet. Model co the tra ve gio trong
 * qua khu, ngay khong ton tai, hoac dich den bia ra - de lot mot cai la tin bay
 * vao ca nhom sai gio, ma gui roi thi khong rut lai duoc.
 */
async function chuanBiDatLich(ketQua, dichDen, khoa, cauLenh) {
  const danhSach = Array.isArray(ketQua.lich) ? ketQua.lich : [];
  if (danhSach.length === 0) return "Em không thấy mốc giờ nào trong lệnh của chị ạ.";

  const bayGioGiay = Math.floor(Date.now() / 1000);
  const hopLe = [];
  const loi = [];

  for (const [i, muc] of danhSach.entries()) {
    const dich = dichDen.find((d) => String(d.id) === String(muc.dichId));
    if (!dich) {
      loi.push(`Mục ${i + 1}: không tìm thấy nhóm/nick "${muc.dichTen || muc.dichId}"`);
      continue;
    }
    const lucGui = docMoc(muc.luc);
    if (!lucGui) {
      loi.push(`Mục ${i + 1}: không đọc được mốc giờ "${muc.luc}"`);
      continue;
    }
    if (lucGui <= bayGioGiay) {
      loi.push(`Mục ${i + 1}: ${dinhDangGio(lucGui)} đã trôi qua rồi`);
      continue;
    }
    if (!String(muc.noiDung || "").trim()) {
      loi.push(`Mục ${i + 1}: không có nội dung để gửi`);
      continue;
    }
    const lapLai = LAP_LAI_HOP_LE.includes(muc.lapLai) ? muc.lapLai || "" : "";
    hopLe.push({ dichId: dich.id, dichTen: dich.ten, loaiDich: dich.loai, noiDung: String(muc.noiDung).trim(), lucGui, lapLai });
  }

  if (hopLe.length === 0) {
    await addLog({ event: "admin_unknown", level: "warn", summary: "Đặt lịch thất bại — không mục nào hợp lệ", detail: { cauLenh, loi } });
    return "Em chưa đặt được lịch nào ạ:\n" + loi.map((l) => "• " + l).join("\n");
  }

  cho.set(khoa, { loai: "dat_lich", lich: hopLe, cauLenh, hetHan: Date.now() + HAN_XAC_NHAN_MS });
  await addLog({
    event: "admin_command",
    level: "info",
    summary: `Lệnh admin — chờ xác nhận đặt ${hopLe.length} lịch hẹn`,
    detail: { cauLenh, soLich: hopLe.length, loi },
  });

  const dong = hopLe.map((l, i) =>
    [
      `${i + 1}. ${dinhDangGio(l.lucGui)}${l.lapLai ? ` — lặp lại ${TEN_LAP_LAI[l.lapLai]}` : ""}`,
      `   → ${l.loaiDich === "nhom" ? "nhóm" : "nick"} 「${l.dichTen}」`,
      `   "${l.noiDung}"`,
    ].join("\n")
  );

  return [
    `Em ghi ${hopLe.length} lịch hẹn:`,
    "",
    dong.join("\n\n"),
    ...(loi.length ? ["", "Bỏ qua vì lỗi:", ...loi.map((l) => "• " + l)] : []),
    "",
    "Chị kiểm lại ngày giờ giúp em. Gõ OK để đặt, HUỶ để bỏ.",
  ].join("\n");
}

async function datLich(dangCho) {
  const daDat = [];
  for (const l of dangCho.lich) {
    const lich = await themLichHen({
      dichId: l.dichId,
      dichTen: l.dichTen,
      loai: l.loaiDich,
      noiDung: l.noiDung,
      lucGui: l.lucGui,
      lapLai: l.lapLai,
      cauLenh: dangCho.cauLenh,
    });
    daDat.push(lich);
  }
  await addLog({
    event: "lich_dat",
    level: "ok",
    summary: `Đã đặt ${daDat.length} lịch hẹn theo lệnh admin`,
    detail: { soLich: daDat.length, lich: daDat.map((l) => ({ id: l.id, dichTen: l.dichTen, luc: dinhDangGio(l.lucGui) })) },
  });

  return [
    `Đã đặt xong ${daDat.length} lịch ạ:`,
    ...daDat.map((l) => `#${l.id} — ${dinhDangGio(l.lucGui)} → 「${l.dichTen}」`),
    "",
    'Chị nhắn "xem lịch" để xem lại, hoặc "huỷ lịch <số>" để bỏ.',
  ].join("\n");
}

/**
 * Tra cuu mail cho CHINH CHU SHOP. Khac han cach tra loi khach:
 * chi duoc nghe thang su that - ke ca "khong tim thay", ke ca tieu de thu.
 * Khach thi khong bao gio duoc nghe "chua gui" (xem email-check.js).
 *
 * Khong can buoc xac nhan OK: tra cuu chi la doc, khong gui gi cho ai.
 */
async function traMailChoAdmin(chuoiCoEmail, message) {
  const email = emailCheck.timEmailTrongTin(chuoiCoEmail);
  if (!email) return "Chị cho em địa chỉ email cần tra giúp em ạ.";

  const ketQua = await emailCheck.traCuu({
    email,
    nguon: "admin_zalo",
    nguoiHoiTen: message?.senderName || "Chị",
    nguoiHoiUid: message?.senderId || "",
  });

  if (!ketQua) {
    return "Em chưa nối được với hộp mail Zoho ạ. Chị vào phân hệ Email trong app kết nối giúp em, hoặc bật lại tính năng tra cứu.";
  }

  if (ketQua.trangThai === "da_gui") {
    return [
      `Mail gửi tới ${email} vào lúc ${dinhDangGio(ketQua.guiLuc)} ạ.`,
      ketQua.tieuDe ? `Tiêu đề: 「${ketQua.tieuDe}」` : "",
      "Thư đi thành công, không có báo lỗi trả về.",
    ].filter(Boolean).join("\n");
  }

  if (ketQua.trangThai === "tra_ve") {
    return [
      `Mail gửi tới ${email} vào lúc ${dinhDangGio(ketQua.guiLuc)}, NHƯNG BỊ TRẢ VỀ lúc ${dinhDangGio(ketQua.traVeLuc)} ạ.`,
      ketQua.tieuDe ? `Tiêu đề: 「${ketQua.tieuDe}」` : "",
      "Nhiều khả năng địa chỉ sai. Chị kiểm lại giúp em rồi gửi lại nhé.",
    ].filter(Boolean).join("\n");
  }

  if (ketQua.trangThai === "khong_thay") {
    return `Em KHÔNG tìm thấy thư nào đã gửi tới ${email} trong hộp Đã gửi ạ. Có khi mình chưa gửi.`;
  }

  return `Em không tra cứu được ạ: ${ketQua.moTa}`;
}

async function xemLich() {
  const danhSach = await listLichHen({ chiChoGui: true, gioiHan: 30 });
  if (danhSach.length === 0) return "Hiện không có lịch hẹn nào đang chờ ạ.";
  return [
    `Có ${danhSach.length} lịch đang chờ:`,
    "",
    ...danhSach.map((l) =>
      `#${l.id} — ${dinhDangGio(l.lucGui)}${l.lapLai ? ` (${TEN_LAP_LAI[l.lapLai]})` : ""}\n` +
      `   → 「${l.dichTen}」: ${l.noiDung.slice(0, 60)}${l.noiDung.length > 60 ? "…" : ""}`
    ),
    "",
    'Muốn bỏ cái nào thì nhắn "huỷ lịch <số>".',
  ].join("\n");
}

async function huyMotLich(id) {
  if (!id) return 'Chị cho em số của lịch cần huỷ, ví dụ "huỷ lịch 3".';
  const daHuy = await huyLichHen(id);
  if (!daHuy) return `Không có lịch #${id} đang chờ, hoặc nó đã gửi/đã huỷ rồi ạ.`;
  await addLog({ event: "lich_huy", level: "warn", summary: `Admin huỷ lịch hẹn #${id}`, detail: { id } });
  return `Đã huỷ lịch #${id} ạ.`;
}
