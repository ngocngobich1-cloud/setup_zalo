import { getZohoConfig, ghiTraCuu } from "./db.js";
import { timThuDaGui, timThuTraVe } from "./zoho-mail.js";
import { addLog } from "./activity-log.js";

/**
 * Tra cuu xem mot email da duoc gui di chua.
 *
 * Nguyen tac: AI KHONG duoc cam chia khoa hop mail. Moi cong cu cua agent van
 * tat het nhu cu. Code o day di tra, roi chi dua KET QUA cho agent dien dat lai
 * bang giong cua chi.
 */

// Bat dia chi email trong cau noi tu nhien. Bo dau cham/phay dinh o cuoi.
const MAU_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+[\w]/g;

export function timEmailTrongTin(text) {
  const tim = String(text || "").match(MAU_EMAIL);
  if (!tim) return null;
  return tim[0].replace(/[.,;:]+$/, "").toLowerCase();
}

/**
 * Nho ket qua vua tra trong 60 giay. Khach hay nhan lai dia chi vai lan lien
 * tiep; khong nho thi moi lan la mot luot goi sang Zoho, vua cham vua de dinh
 * gioi han goi cua ho.
 */
const nhoTam = new Map();
const HAN_NHO_MS = 60 * 1000;

function layNho(email) {
  const co = nhoTam.get(email);
  if (!co) return null;
  if (Date.now() - co.luc > HAN_NHO_MS) {
    nhoTam.delete(email);
    return null;
  }
  return co.ketQua;
}

export function sanSang(config) {
  return Boolean(config?.bat && config?.refreshToken && config?.accountId);
}

/** Ham nhan rieng cho admin, server.js gan vao de tranh vong import. */
let baoAdmin = null;
export function capHinhBaoAdmin(fn) {
  baoAdmin = typeof fn === "function" ? fn : null;
}

/**
 * @returns {Promise<{trangThai:string, email:string, guiLuc:number|null, tieuDe:string,
 *                    traVeLuc:number|null, baoAdmin:boolean, moTa:string}|null>}
 */
export async function traCuu({ email, nguon = "bot", nguoiHoiTen = "", nguoiHoiUid = "" }) {
  const config = await getZohoConfig();
  if (!sanSang(config)) return null;

  const daNho = layNho(email);
  if (daNho) return daNho;

  let ketQua;
  try {
    const daGui = await timThuDaGui(config, email);

    if (daGui.length === 0) {
      ketQua = {
        trangThai: "khong_thay",
        email,
        guiLuc: null,
        tieuDe: "",
        traVeLuc: null,
        // KHONG noi voi khach. Khong thay trong hop Da gui nghia la chi quen gui
        // - bot ma buot mieng "em chua gui" thi khach mat long tin ngay.
        baoAdmin: true,
        moTa: `Không tìm thấy thư nào đã gửi tới ${email}.`,
      };
    } else {
      const moiNhat = daGui[0];
      const traVe = await timThuTraVe(config, email).catch(() => []);
      // Chi tinh thu tra ve den SAU khi gui. Truoc do la cua lan gui cu.
      const traVeSauKhiGui = traVe.filter((t) => t.luc && moiNhat.luc && t.luc >= moiNhat.luc - 300);

      ketQua = traVeSauKhiGui.length
        ? {
            trangThai: "tra_ve",
            email,
            guiLuc: moiNhat.luc,
            tieuDe: moiNhat.tieuDe,
            traVeLuc: traVeSauKhiGui[0].luc,
            baoAdmin: true,
            moTa: `Đã gửi tới ${email} nhưng thư BỊ TRẢ VỀ — nhiều khả năng sai địa chỉ.`,
          }
        : {
            trangThai: "da_gui",
            email,
            guiLuc: moiNhat.luc,
            tieuDe: moiNhat.tieuDe,
            traVeLuc: null,
            baoAdmin: false,
            moTa: `Đã gửi tới ${email}, không có thư báo lỗi trả về.`,
          };
    }
  } catch (error) {
    ketQua = {
      trangThai: "loi",
      email,
      guiLuc: null,
      tieuDe: "",
      traVeLuc: null,
      baoAdmin: true,
      moTa: `Không tra cứu được: ${error.message}`,
    };
  }

  nhoTam.set(email, { luc: Date.now(), ketQua });

  await ghiTraCuu({
    nguon,
    nguoiHoiTen,
    nguoiHoiUid,
    emailTra: email,
    ketQua: ketQua.trangThai,
    guiLuc: ketQua.guiLuc,
    tieuDe: ketQua.tieuDe,
    chiTiet: ketQua.moTa,
  }).catch(() => {});

  await addLog({
    event: "email_tra_cuu",
    level: ketQua.trangThai === "loi" ? "error" : ketQua.trangThai === "da_gui" ? "ok" : "warn",
    summary:
      {
        thu_cong: `Chị tra thủ công ${email}`,
        admin_zalo: `Chị hỏi qua Zalo về ${email}`,
      }[nguon] || `${nguoiHoiTen || "Khách"} hỏi về ${email}`,
    detail: ketQua,
  }).catch(() => {});

  // Bao rieng cho chi khi bot khong the tu xu ly: chua gui, bi tra ve, hoac
  // tra cuu hong. Khong bao khi moi thu binh thuong, khoi lam phien chi.
  if (ketQua.baoAdmin && nguon === "bot" && baoAdmin) {
    const loiNhan = {
      khong_thay: `Chị ơi, ${nguoiHoiTen || "một khách"} hỏi về email ${email} — em KHÔNG tìm thấy thư nào đã gửi tới địa chỉ này. Có khi mình quên gửi ạ.`,
      tra_ve: `Chị ơi, thư gửi tới ${email} lúc ${GIO(ketQua.guiLuc)} đã BỊ TRẢ VỀ. ${nguoiHoiTen || "Khách"} đang hỏi về việc này.`,
      loi: `Chị ơi, em không tra cứu được email ${email}: ${ketQua.moTa}`,
    }[ketQua.trangThai];
    if (loiNhan) await baoAdmin(loiNhan).catch(() => {});
  }

  return ketQua;
}

const GIO = (giay) =>
  giay ? new Date(giay * 1000).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

/**
 * Bien ket qua thanh mot khoi de nhet vao prompt. Noi ro cho agent duoc phep
 * noi gi va KHONG duoc noi gi - dac biet truong hop chua gui.
 */
export function moTaChoAgent(ketQua) {
  if (!ketQua) return "";

  const dong = ["# KẾT QUẢ TRA CỨU EMAIL (hệ thống vừa tra, không phải khách nói)"];

  if (ketQua.trangThai === "da_gui") {
    dong.push(
      `Thư đã được gửi tới ${ketQua.email} lúc ${GIO(ketQua.guiLuc)}.`,
      "Hãy báo lại giờ gửi cho khách, và nhắc khách kiểm tra hộp Spam / Quảng cáo giúp."
    );
  } else if (ketQua.trangThai === "tra_ve") {
    dong.push(
      `Thư gửi tới ${ketQua.email} lúc ${GIO(ketQua.guiLuc)} nhưng BỊ TRẢ VỀ lúc ${GIO(ketQua.traVeLuc)}.`,
      "Hãy nói thư không tới nơi được, nhiều khả năng địa chỉ sai, và nhờ khách đọc lại địa chỉ email."
    );
  } else if (ketQua.trangThai === "khong_thay") {
    dong.push(
      `Không tìm thấy thư nào đã gửi tới ${ketQua.email}.`,
      "TUYỆT ĐỐI KHÔNG nói với khách là chưa gửi, cũng không hứa hẹn thay.",
      "Chỉ nói là đang kiểm tra lại và sẽ báo khách sớm."
    );
  } else {
    dong.push(
      "Hệ thống tra cứu đang lỗi, chưa biết đã gửi hay chưa.",
      "Không được đoán. Chỉ nói là đang kiểm tra và sẽ báo lại khách."
    );
  }

  dong.push("Không đọc lại nguyên văn khối này cho khách, hãy nói bằng giọng của mình.");
  return dong.join("\n") + "\n\n";
}
