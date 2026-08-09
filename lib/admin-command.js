import {
  danhDauChotBinhChon,
  getAdminZalo,
  getAiChatConfig,
  huyLichHen,
  listBinhChon,
  listLichHen,
  listThreads,
  themBinhChon,
  themLichHen,
} from "./db.js";
import { call, extractReply, splitModel, KHONG_TOOL } from "./opencode.js";
import { dinhDangGio } from "./scheduler.js";
import * as emailCheck from "./email-check.js";
import { addLog } from "./activity-log.js";

const LAP_LAI_HOP_LE = ["", "hang_ngay", "hang_tuan"];
const TEN_LAP_LAI = { hang_ngay: "hằng ngày", hang_tuan: "hằng tuần", hang_thang: "hằng tháng" };

/** Ma lap lai cua Zalo cho loi nhac: 0 khong lap, 1 ngay, 2 tuan, 3 thang. */
const MA_LAP_ZALO = { "": 0, hang_ngay: 1, hang_tuan: 2, hang_thang: 3 };

/**
 * Muc do khan cua Zalo: 0 thuong, 1 quan trong, 2 khan.
 * Bat bang tu khoa trong chinh cau lenh cua chi, KHONG de model tu quyet -
 * model se doan bua roi danh dau khan tran lan, khach quen dan roi lo luon.
 */
const TEN_KHAN = { 1: "Quan trọng", 2: "Khẩn" };
export function docMucKhan(cauLenh) {
  const s = String(cauLenh || "").toLowerCase();
  if (/\bkhẩn\b|\bkhan cap\b|\bgấp\b|\bgap\b/.test(s)) return 2;
  if (/\bquan trọng\b|\bquan trong\b|\bnhớ\b.*\bnhé\b/.test(s)) return 1;
  return 0;
}

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
 * Ten hanh dong trong huong dan viet khong dau ("duyet_vao_nhom"), nhung tieu de
 * ngay tren no lai co dau ("DUYET hoac TU CHOI"), nen model thinh thoang chep
 * lai thanh "duyet_vao_nhom" co dau. Bo dau truoc khi so sanh cho chac.
 */
function chuanHoaHanhDong(ten) {
  return String(ten || "")
    .normalize("NFD") // tach dau ra thanh ky tu rieng
    .toLowerCase()
    .replace(/đ/g, "d") // chu "d" gach ngang khong tach duoc bang NFD
    .replace(/[^a-z0-9_]/g, ""); // bo dau va moi ky tu la
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

GỬI NGAY (có thể gửi tới NHIỀU nhóm/nick cùng lúc):
{"hanhDong":"gui_tin","dichIds":["<id1>","<id2>"],"noiDung":"<nội dung>"}
Chỉ một đích thì vẫn để mảng một phần tử.
Ví dụ "nhắn vào nhóm masterclass và nhóm lớp 2: mai nghỉ học" → dichIds có 2 id.

HẸN GIỜ GỬI (một câu lệnh có thể chứa NHIỀU mốc giờ):
{"hanhDong":"dat_lich","lich":[
  {"dichId":"<id>","dichTen":"<tên>","noiDung":"<nội dung>","luc":"YYYY-MM-DD HH:mm","lapLai":""}
]}

TẠO LỜI NHẮC CỦA ZALO (thẻ nhắc hiện trong nhóm, Zalo tự đẩy thông báo cho mọi thành viên):
{"hanhDong":"dat_nhac","dichId":"<id>","tieuDe":"<nội dung nhắc, ngắn gọn>","luc":"YYYY-MM-DD HH:mm","lapLai":""}
lapLai: "" | "hang_ngay" | "hang_tuan" | "hang_thang"

PHÂN BIỆT dat_nhac với dat_lich — rất quan trọng:
- dat_nhac = một SỰ KIỆN cần mọi người biết và nhớ. Zalo hiện thẻ nhắc, đẩy thông báo.
  Ví dụ: "nhắc cả lớp 15h mai vào zoom", "đặt lời nhắc 8h thứ 2 hằng tuần họp lớp"
- dat_lich = một TIN NHẮN cần bot gửi đúng giờ. Hiện ra như tin nhắn bình thường.
  Ví dụ: "8h sáng 10/8 gửi nhóm: mn cho em xin cảm nhận", "14h nhắn chị Tú Anh link zoom"
Nếu câu lệnh có nội dung dài, có lời văn, có link → dat_lich.
Nếu chỉ là mốc sự kiện ngắn cần cả nhóm nhớ → dat_nhac.

XEM DANH SÁCH NGƯỜI XIN VÀO NHÓM:
{"hanhDong":"xem_cho_duyet","dichId":"<id nhóm>"}
Ví dụ: "ai đang xin vào nhóm masterclass", "xem danh sách chờ duyệt nhóm lớp 2".

DUYỆT hoặc TỪ CHỐI người xin vào nhóm:
{"hanhDong":"duyet_vao_nhom","dichId":"<id nhóm>","soThuTu":[1,2],"dongY":true}
soThuTu là số thứ tự trong danh sách chờ vừa xem. dongY=false nghĩa là từ chối.
Cứ chép đúng con số admin nói, dù to hay nhỏ — hệ thống tự kiểm tra số đó có
hợp lệ không, đừng tự đoán là sai rồi trả về khong_hieu.
Ví dụ: "duyệt số 1 và 2 vào nhóm masterclass", "từ chối số 3", "duyệt số 12".

TÌM NGƯỜI THEO SỐ ĐIỆN THOẠI:
{"hanhDong":"tim_nguoi","so":"<số điện thoại trong câu>"}
Ví dụ: "tìm số 0901234567 là ai", "check số 0987654321 giúp chị".

GHIM GHI CHÚ lên đầu nhóm:
{"hanhDong":"ghim_ghi_chu","dichId":"<id nhóm>","noiDung":"<nội dung ghi chú>"}
Dùng khi chủ shop muốn ghim một thông tin cố định cho cả nhóm luôn nhìn thấy —
lịch học, quy định lớp, link tài liệu. Khác với gửi tin: ghi chú nằm ở đầu nhóm,
không trôi đi. Ví dụ: "ghim lên nhóm masterclass: lịch học thứ 3 và thứ 5, 20h".

TẠO BÌNH CHỌN trong nhóm:
{"hanhDong":"tao_binh_chon","dichId":"<id nhóm>","cauHoi":"<câu hỏi>","luaChon":["<a>","<b>"],
 "nhieuLuaChon":false,"choThemLuaChon":false,"anDanh":false}
nhieuLuaChon=true nếu cho chọn nhiều đáp án; choThemLuaChon=true nếu cho thành viên tự thêm;
anDanh=true nếu không ai thấy ai bỏ phiếu gì. Phải có ít nhất 2 lựa chọn.

XEM KẾT QUẢ BÌNH CHỌN: {"hanhDong":"xem_binh_chon"}
CHỐT BÌNH CHỌN:        {"hanhDong":"chot_binh_chon","id":<số thứ tự trong danh sách>}

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
      const doc = JSON.parse(tho);
      if (doc && typeof doc === "object") doc.hanhDong = chuanHoaHanhDong(doc.hanhDong);
      return doc;
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
      if (dangCho.loai === "dat_lich") return datLich(dangCho);
      if (dangCho.loai === "dat_nhac") return datNhac(dangCho);
      if (dangCho.loai === "binh_chon") return taoBinhChon(dangCho);
      if (dangCho.loai === "ghi_chu") return ghimGhiChu(dangCho);
      if (dangCho.loai === "duyet_nhom") return duyetVaoNhom(dangCho);
      return guiNgay(dangCho, gui);
    } else if (TU_HUY.includes(chuanHoa(noiDung))) {
      cho.delete(khoa);
      await addLog({ event: "admin_cancel", level: "warn", summary: "Admin huỷ lệnh", detail: { loai: dangCho.loai } });
      if (dangCho.loai === "dat_lich") return "Đã huỷ, em không đặt lịch nào cả.";
      if (dangCho.loai === "duyet_nhom") return "Đã huỷ, em không duyệt ai cả.";
      return "Đã huỷ, em không gửi gì cả.";
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
  if (ketQua?.hanhDong === "dat_nhac") return chuanBiDatNhac(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "xem_cho_duyet") return xemChoDuyet(ketQua, dichDen);
  if (ketQua?.hanhDong === "duyet_vao_nhom") return chuanBiDuyet(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "tim_nguoi") return timNguoi(ketQua.so || noiDung, message);
  if (ketQua?.hanhDong === "ghim_ghi_chu") return chuanBiGhiChu(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "tao_binh_chon") return chuanBiBinhChon(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "xem_binh_chon") return xemBinhChon();
  if (ketQua?.hanhDong === "chot_binh_chon") return chotBinhChon(ketQua.id);

  // Model co the tra ve dang cu (dichId le) hoac dang moi (dichIds mang).
  const idMongMuon = Array.isArray(ketQua?.dichIds)
    ? ketQua.dichIds
    : ketQua?.dichId
      ? [ketQua.dichId]
      : [];

  if (ketQua?.hanhDong !== "gui_tin" || idMongMuon.length === 0 || !ketQua.noiDung) {
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
  // Loc trung: model hay tra ve cung mot id hai lan khi chi noi ten nhom hai kieu.
  const dsDich = [];
  const daCo = new Set();
  const khongThay = [];
  for (const id of idMongMuon) {
    const d = dichDen.find((x) => String(x.id) === String(id));
    if (!d) khongThay.push(String(id));
    else if (!daCo.has(d.id)) {
      daCo.add(d.id);
      dsDich.push(d);
    }
  }

  if (dsDich.length === 0) {
    await addLog({ event: "admin_unknown", level: "warn", summary: "Model tra ve dich den khong co that", detail: { ketQua } });
    return "Em không tìm thấy nhóm/nick đó trong danh sách. Chị nói rõ tên giúp em.";
  }

  const khan = docMucKhan(noiDung);
  cho.set(khoa, {
    loai: "gui_tin",
    dsDich,
    noiDung: ketQua.noiDung,
    khan,
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });
  await addLog({
    event: "admin_command",
    level: "info",
    summary: `Lệnh admin — chờ xác nhận gửi tới ${dsDich.length} nơi`,
    detail: { dich: dsDich, khan, noiDung: ketQua.noiDung, cauLenh: noiDung, khongThay },
  });

  const tenDich = dsDich.map((d) => `${d.loai === "nhom" ? "nhóm" : "nick"} 「${d.ten}」`);
  return [
    dsDich.length === 1
      ? `Em sẽ gửi vào ${tenDich[0]} nội dung:`
      : `Em sẽ gửi vào ${dsDich.length} nơi — ${tenDich.join(", ")} — nội dung:`,
    "",
    ketQua.noiDung,
    ...(khan ? ["", `Đánh dấu: ${TEN_KHAN[khan]}`] : []),
    ...(khongThay.length ? ["", `(Bỏ qua vì không tìm thấy: ${khongThay.join(", ")})`] : []),
    "",
    "Chị gõ OK để em gửi, hoặc HUỶ để bỏ.",
  ].join("\n");
}

async function guiNgay(dangCho, gui) {
  const xong = [];
  const hong = [];

  // Gui tung noi mot. Mot noi hong khong duoc keo do ca chum - nhom kia van
  // phai nhan duoc tin.
  for (const d of dangCho.dsDich) {
    try {
      await gui({
        threadId: d.id,
        threadType: d.loai === "nhom" ? 1 : 0,
        text: dangCho.noiDung,
        urgency: dangCho.khan || 0,
      });
      xong.push(d.ten);
    } catch (error) {
      hong.push(`${d.ten} (${error.message})`);
    }
  }

  await addLog({
    event: xong.length ? "admin_sent" : "admin_error",
    level: hong.length ? "warn" : "ok",
    summary: `Lệnh admin — gửi được ${xong.length}/${dangCho.dsDich.length} nơi`,
    detail: { xong, hong, noiDung: dangCho.noiDung, khan: dangCho.khan || 0 },
  });

  if (!xong.length) return `Em gửi không được ạ:\n${hong.map((h) => "• " + h).join("\n")}`;
  return [
    xong.length === 1 ? `Đã gửi vào "${xong[0]}" rồi ạ.` : `Đã gửi xong ${xong.length} nơi ạ:`,
    ...(xong.length > 1 ? xong.map((t) => "• " + t) : []),
    ...(hong.length ? ["", "Không gửi được:", ...hong.map((h) => "• " + h)] : []),
  ].join("\n");
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

  const khan = docMucKhan(cauLenh);
  cho.set(khoa, { loai: "dat_lich", lich: hopLe, cauLenh, khan, hetHan: Date.now() + HAN_XAC_NHAN_MS });
  await addLog({
    event: "admin_command",
    level: "info",
    summary: `Lệnh admin — chờ xác nhận đặt ${hopLe.length} lịch hẹn`,
    detail: { cauLenh, soLich: hopLe.length, loi },
  });

  const dong = hopLe.map((l, i) =>
    [
      `${i + 1}. ${dinhDangGio(l.lucGui)}${l.lapLai ? ` — lặp lại ${TEN_LAP_LAI[l.lapLai]}` : ""}${khan ? ` — đánh dấu ${TEN_KHAN[khan]}` : ""}`,
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
      khan: dangCho.khan || 0,
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

/**
 * Loi nhac cua CHINH ZALO - khac han lich hen cua app.
 *  - Lich hen cua app: bot gui mot tin nhan dung gio.
 *  - Loi nhac Zalo: hien the nhac trong nhom, Zalo tu day thong bao cho MOI
 *    thanh vien, va no nam lai trong muc Nhac hen cua nhom.
 * Nen "nhac ca lop 15h vao zoom" thi dung cai nay moi dung viec.
 */
async function chuanBiDatNhac(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm/nick đó trong danh sách. Chị nói rõ tên giúp em.";

  const tieuDe = String(ketQua.tieuDe || "").trim();
  if (!tieuDe) return "Chị cho em nội dung cần nhắc là gì ạ.";

  const lucGui = docMoc(ketQua.luc);
  if (!lucGui) return `Em không đọc được mốc giờ "${ketQua.luc}" ạ.`;
  if (lucGui <= Math.floor(Date.now() / 1000)) return `${dinhDangGio(lucGui)} đã trôi qua rồi ạ.`;

  const lapLai = Object.prototype.hasOwnProperty.call(MA_LAP_ZALO, ketQua.lapLai) ? ketQua.lapLai || "" : "";

  cho.set(khoa, {
    loai: "dat_nhac",
    dichId: dich.id,
    dichTen: dich.ten,
    loaiDich: dich.loai,
    tieuDe,
    lucGui,
    lapLai,
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });

  return [
    `Em sẽ tạo LỜI NHẮC CỦA ZALO trong ${dich.loai === "nhom" ? "nhóm" : "nick"} 「${dich.ten}」:`,
    "",
    `⏰ ${tieuDe}`,
    `   ${dinhDangGio(lucGui)}${lapLai ? ` — lặp lại ${TEN_LAP_LAI[lapLai]}` : ""}`,
    "",
    "Khác với lịch hẹn: cái này Zalo đẩy thông báo cho cả nhóm và nằm lại ở mục Nhắc hẹn.",
    "Chị gõ OK để tạo, HUỶ để bỏ.",
  ].join("\n");
}

let taoNhacZalo = null;
/** zalo-service gan ham nay vao de tranh vong import. */
export function capHinhTaoNhac(fn) {
  taoNhacZalo = fn;
}

async function datNhac(dangCho) {
  if (!taoNhacZalo) return "Em chưa nối được với Zalo để tạo lời nhắc ạ.";
  try {
    await taoNhacZalo({
      threadId: dangCho.dichId,
      threadType: dangCho.loaiDich === "nhom" ? 1 : 0,
      tieuDe: dangCho.tieuDe,
      lucGui: dangCho.lucGui,
      maLap: MA_LAP_ZALO[dangCho.lapLai] ?? 0,
    });
    await addLog({
      event: "nhac_zalo",
      level: "ok",
      summary: `Đã tạo lời nhắc Zalo trong "${dangCho.dichTen}": ${dangCho.tieuDe}`,
      detail: { dichTen: dangCho.dichTen, tieuDe: dangCho.tieuDe, luc: dinhDangGio(dangCho.lucGui), lapLai: dangCho.lapLai },
    });
    return [
      `Đã tạo lời nhắc trong 「${dangCho.dichTen}」 ạ:`,
      `⏰ ${dangCho.tieuDe} — ${dinhDangGio(dangCho.lucGui)}${dangCho.lapLai ? ` (${TEN_LAP_LAI[dangCho.lapLai]})` : ""}`,
      "Cả nhóm sẽ nhận được thông báo của Zalo khi tới giờ.",
    ].join("\n");
  } catch (error) {
    await addLog({ event: "nhac_zalo", level: "error", summary: `Tạo lời nhắc thất bại — ${error.message}`, detail: { dangCho } });
    return `Em tạo lời nhắc không được ạ: ${error.message}`;
  }
}

/* --- DUYET NGUOI XIN VAO NHOM --- */

let nhomZalo = null;
export function capHinhNhom(fns) {
  nhomZalo = fns;
}

/** Danh sach cho duyet lan gan nhat, theo tung nhom. Can nho de chi noi "duyet
 *  so 1, 2" thay vi phai doc ra day uid dai loang ngoang. */
const choDuyetGanDay = new Map();

async function xemChoDuyet(ketQua, dichDen) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ.";
  if (dich.loai !== "nhom") return "Chỉ nhóm mới có danh sách chờ duyệt ạ.";
  if (!nhomZalo?.xemCho) return "Em chưa nối được với Zalo ạ.";

  try {
    const ds = await nhomZalo.xemCho(dich.id);
    choDuyetGanDay.set(String(dich.id), ds);
    if (!ds.length) return `Không có ai đang chờ vào nhóm 「${dich.ten}」 ạ.`;
    return [
      `Có ${ds.length} người đang xin vào nhóm 「${dich.ten}」:`,
      "",
      ...ds.map((u, i) => `${i + 1}. ${u.ten || "(không có tên)"}`),
      "",
      'Duyệt thì nhắn "duyệt số 1, 2 vào nhóm ..." — từ chối thì "từ chối số 3".',
    ].join("\n");
  } catch (error) {
    return `Em không xem được ạ: ${error.message}`;
  }
}

async function chuanBiDuyet(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ.";

  const ds = choDuyetGanDay.get(String(dich.id));
  if (!ds?.length) return `Chị nhắn "xem danh sách chờ duyệt nhóm ${dich.ten}" trước để em biết ai với ai ạ.`;

  const soTT = Array.isArray(ketQua.soThuTu) ? ketQua.soThuTu : [ketQua.soThuTu];
  const chon = [];
  const sai = [];
  for (const s of soTT) {
    const i = Number(s) - 1;
    if (Number.isInteger(i) && i >= 0 && i < ds.length) chon.push(ds[i]);
    else sai.push(String(s));
  }
  if (!chon.length) return `Số thứ tự không đúng ạ. Danh sách chỉ có ${ds.length} người.`;

  const dongY = ketQua.dongY !== false;
  cho.set(khoa, { loai: "duyet_nhom", dichId: dich.id, dichTen: dich.ten, chon, dongY, hetHan: Date.now() + HAN_XAC_NHAN_MS });

  return [
    dongY
      ? `Em sẽ DUYỆT ${chon.length} người vào nhóm 「${dich.ten}」:`
      : `Em sẽ TỪ CHỐI ${chon.length} người xin vào nhóm 「${dich.ten}」:`,
    ...chon.map((u) => `   • ${u.ten || "(không có tên)"}`),
    ...(sai.length ? ["", `(Bỏ qua số không hợp lệ: ${sai.join(", ")})`] : []),
    "",
    dongY ? "Chị gõ OK để duyệt, HUỶ để bỏ." : "Từ chối rồi thì họ phải xin lại. Chị gõ OK để từ chối, HUỶ để bỏ.",
  ].join("\n");
}

async function duyetVaoNhom(dangCho) {
  if (!nhomZalo?.duyet) return "Em chưa nối được với Zalo ạ.";
  try {
    const kq = await nhomZalo.duyet(dangCho.dichId, dangCho.chon.map((u) => u.uid), dangCho.dongY);
    const ten = new Map(dangCho.chon.map((u) => [u.uid, u.ten]));
    const xong = kq.filter((x) => x.xong);
    const hong = kq.filter((x) => !x.xong);

    // Danh sach cu da doi -> bo di, bat chi xem lai truoc khi duyet tiep.
    choDuyetGanDay.delete(String(dangCho.dichId));

    await addLog({
      event: "duyet_nhom",
      level: hong.length ? "warn" : "ok",
      summary: `${dangCho.dongY ? "Duyệt" : "Từ chối"} ${xong.length}/${kq.length} người vào "${dangCho.dichTen}"`,
      detail: { dichTen: dangCho.dichTen, dongY: dangCho.dongY, kq },
    });

    return [
      `${dangCho.dongY ? "Đã duyệt" : "Đã từ chối"} ${xong.length}/${kq.length} người ạ.`,
      ...xong.map((x) => `   ✓ ${ten.get(x.uid) || x.uid}`),
      ...(hong.length ? ["", "Không xong:", ...hong.map((x) => `   ✗ ${ten.get(x.uid) || x.uid} — ${x.moTa}`)] : []),
    ].join("\n");
  } catch (error) {
    return `Em làm không được ạ: ${error.message}`;
  }
}

/* --- TIM NGUOI THEO SO DIEN THOAI --- */

let timNguoiZalo = null;
export function capHinhTimNguoi(fns) {
  timNguoiZalo = fns;
}

/**
 * Tra so ra danh tinh Zalo. KHONG can buoc xac nhan (chi doc), nhung GHI NHAT KY
 * moi luot: day la tra danh tinh nguoi that, phai co dau vet de soi lai.
 */
async function timNguoi(chuoi, message) {
  if (!timNguoiZalo?.tim) return "Em chưa nối được với Zalo ạ.";

  const so = String(chuoi || "").match(/(?:\+?84|0)\d{9}\b/)?.[0];
  if (!so) return 'Chị cho em số điện thoại 10 số giúp em, ví dụ "tìm số 0901234567 là ai".';

  try {
    const u = await timNguoiZalo.tim(so);
    await addLog({
      event: "tim_nguoi",
      level: "warn",
      summary: `Tra số ${so} → ${u.ten || "(không rõ tên)"}`,
      detail: { so, uid: u.uid, ten: u.ten, nguoiHoi: message?.senderName || "" },
    });
    if (!u.uid) return `Em không tìm thấy ai dùng Zalo với số ${so} ạ.`;
    return [
      `Số ${so} là:`,
      `👤 ${u.ten || "(không có tên hiển thị)"}`,
      "",
      `Còn ${timNguoiZalo.conLuot()} lượt tra trong giờ này.`,
    ].join("\n");
  } catch (error) {
    await addLog({ event: "tim_nguoi", level: "error", summary: `Tra số ${so} thất bại — ${error.message}`, detail: { so } });
    return `Em tra không được ạ: ${error.message}`;
  }
}

/* --- GHI CHU GHIM DAU NHOM --- */

let ghiChuZalo = null;
export function capHinhGhiChu(fn) {
  ghiChuZalo = fn;
}

async function chuanBiGhiChu(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ. Chị nói rõ tên nhóm giúp em.";
  if (dich.loai !== "nhom") return "Ghi chú chỉ ghim được trong NHÓM, không ghim trong chat riêng ạ.";

  const noiDung = String(ketQua.noiDung || "").trim();
  if (!noiDung) return "Chị cho em nội dung cần ghim ạ.";

  cho.set(khoa, { loai: "ghi_chu", dichId: dich.id, dichTen: dich.ten, noiDung, hetHan: Date.now() + HAN_XAC_NHAN_MS });

  return [
    `Em sẽ ghim ghi chú lên đầu nhóm 「${dich.ten}」:`,
    "",
    `📌 ${noiDung}`,
    "",
    "Lưu ý: Zalo KHÔNG cho xoá ghi chú bằng lệnh. Ghim rồi thì chỉ sửa được,",
    "muốn bỏ hẳn phải vào Zalo xoá tay. Chị đọc lại nội dung giúp em.",
    "",
    "Chị gõ OK để ghim, HUỶ để bỏ.",
  ].join("\n");
}

async function ghimGhiChu(dangCho) {
  if (!ghiChuZalo) return "Em chưa nối được với Zalo ạ.";
  try {
    await ghiChuZalo({ groupId: dangCho.dichId, noiDung: dangCho.noiDung, ghim: true });
    await addLog({
      event: "ghi_chu",
      level: "ok",
      summary: `Đã ghim ghi chú trong "${dangCho.dichTen}": ${dangCho.noiDung.slice(0, 50)}`,
      detail: { dichTen: dangCho.dichTen, noiDung: dangCho.noiDung },
    });
    return `Đã ghim lên đầu nhóm 「${dangCho.dichTen}」 ạ. Cả nhóm mở ra là thấy ngay.`;
  } catch (error) {
    await addLog({ event: "ghi_chu", level: "error", summary: `Ghim ghi chú thất bại — ${error.message}`, detail: { dangCho } });
    return `Em ghim không được ạ: ${error.message}`;
  }
}

/* --- BINH CHON --- */

let binhChonZalo = null;
/** zalo-service gan cac ham that vao day, tranh vong import. */
export function capHinhBinhChon(fns) {
  binhChonZalo = fns;
}

async function chuanBiBinhChon(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ. Chị nói rõ tên nhóm giúp em.";
  if (dich.loai !== "nhom") return "Bình chọn chỉ tạo được trong NHÓM, không tạo trong chat riêng ạ.";

  const cauHoi = String(ketQua.cauHoi || "").trim();
  const luaChon = (Array.isArray(ketQua.luaChon) ? ketQua.luaChon : [])
    .map((x) => String(x).trim())
    .filter(Boolean);

  if (!cauHoi) return "Chị cho em câu hỏi của bình chọn ạ.";
  if (luaChon.length < 2) return "Bình chọn cần ít nhất 2 lựa chọn ạ. Chị liệt kê giúp em.";

  cho.set(khoa, {
    loai: "binh_chon",
    dichId: dich.id,
    dichTen: dich.ten,
    cauHoi,
    luaChon,
    nhieuLuaChon: Boolean(ketQua.nhieuLuaChon),
    choThemLuaChon: Boolean(ketQua.choThemLuaChon),
    anDanh: Boolean(ketQua.anDanh),
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });

  const tuyChon = [
    ketQua.nhieuLuaChon ? "cho chọn nhiều đáp án" : "chỉ chọn một",
    ketQua.choThemLuaChon ? "cho thành viên thêm lựa chọn" : null,
    ketQua.anDanh ? "ẩn danh" : null,
  ].filter(Boolean);

  return [
    `Em sẽ tạo bình chọn trong nhóm 「${dich.ten}」:`,
    "",
    `📊 ${cauHoi}`,
    ...luaChon.map((x, i) => `   ${i + 1}. ${x}`),
    "",
    `(${tuyChon.join(" · ")})`,
    "",
    "Chị gõ OK để tạo, HUỶ để bỏ.",
  ].join("\n");
}

async function taoBinhChon(dangCho) {
  if (!binhChonZalo?.tao) return "Em chưa nối được với Zalo ạ.";
  try {
    const r = await binhChonZalo.tao({
      groupId: dangCho.dichId,
      cauHoi: dangCho.cauHoi,
      luaChon: dangCho.luaChon,
      nhieuLuaChon: dangCho.nhieuLuaChon,
      choThemLuaChon: dangCho.choThemLuaChon,
      anDanh: dangCho.anDanh,
    });
    await themBinhChon({
      pollId: r.pollId,
      threadId: dangCho.dichId,
      dichTen: dangCho.dichTen,
      cauHoi: dangCho.cauHoi,
      luaChon: dangCho.luaChon,
    });
    await addLog({
      event: "binh_chon",
      level: "ok",
      summary: `Đã tạo bình chọn trong "${dangCho.dichTen}": ${dangCho.cauHoi}`,
      detail: { pollId: r.pollId, dichTen: dangCho.dichTen, cauHoi: dangCho.cauHoi, luaChon: dangCho.luaChon },
    });
    return [
      `Đã tạo bình chọn trong 「${dangCho.dichTen}」 ạ.`,
      'Chị nhắn "xem bình chọn" để coi kết quả, hoặc "chốt bình chọn 1" để khoá.',
    ].join("\n");
  } catch (error) {
    await addLog({ event: "binh_chon", level: "error", summary: `Tạo bình chọn thất bại — ${error.message}`, detail: { dangCho } });
    return `Em tạo bình chọn không được ạ: ${error.message}`;
  }
}

async function xemBinhChon() {
  const ds = await listBinhChon(10);
  if (!ds.length) return "Chưa có bình chọn nào em tạo ạ.";
  if (!binhChonZalo?.doc) return "Em chưa nối được với Zalo ạ.";

  const dong = [];
  for (const [i, bc] of ds.entries()) {
    try {
      const kq = await binhChonZalo.doc(bc.pollId);
      const sapXep = [...kq.luaChon].sort((a, b) => b.phieu - a.phieu);
      dong.push(
        `${i + 1}. 📊 ${kq.cauHoi}${kq.daDong ? "  [đã chốt]" : ""}`,
        `   nhóm 「${bc.dichTen}」 · ${kq.tongPhieu} người đã chọn`,
        ...sapXep.map((o) => `      ${o.phieu} phiếu — ${o.noiDung}`)
      );
    } catch {
      dong.push(`${i + 1}. 📊 ${bc.cauHoi}`, `   (không đọc được kết quả)`);
    }
  }
  return ["Các bình chọn gần đây:", "", ...dong, "", 'Chốt cái nào thì nhắn "chốt bình chọn <số>".'].join("\n");
}

async function chotBinhChon(soThuTu) {
  const ds = await listBinhChon(10);
  const i = Number(soThuTu) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= ds.length) {
    return 'Chị cho em số thứ tự trong danh sách, ví dụ "chốt bình chọn 1". Nhắn "xem bình chọn" để coi danh sách.';
  }
  const bc = ds[i];
  if (bc.daChot) return `Bình chọn "${bc.cauHoi}" đã chốt từ trước rồi ạ.`;

  try {
    await binhChonZalo.chot(bc.pollId);
    await danhDauChotBinhChon(bc.pollId);
    await addLog({ event: "binh_chon", level: "warn", summary: `Đã chốt bình chọn: ${bc.cauHoi}`, detail: { pollId: bc.pollId } });
    return `Đã chốt bình chọn "${bc.cauHoi}" — cả nhóm không bỏ phiếu thêm được nữa ạ.`;
  } catch (error) {
    return `Em chốt không được ạ: ${error.message}`;
  }
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
