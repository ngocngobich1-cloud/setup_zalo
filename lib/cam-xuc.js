import { Reactions } from "zca-js";

/**
 * DANH SACH TRANG - bot CHI duoc dung dung hai bieu tuong nay.
 *
 * Zalo cho 29 bieu tuong, nhung nghe cua chu app la huan luyen vien cuoc song:
 * khach ke chuyen tram cam, ly hon, mat viec. Bot tha 😆 hay 😡 vao mot tin
 * nhu vay la mat khach vinh vien, va khong co cach nao chua.
 *
 * De o dang danh sach TRANG chu khong phai danh sach den: thu vien them bieu
 * tuong moi trong ban sau thi chung tu dong bi chan, khong phai nho cap nhat.
 */
const CHO_PHEP = {
  HEART: Reactions.HEART, // ❤️ am ap, dung cho loi cam on
  LIKE: Reactions.LIKE, //  👍 ghi nhan, dung cho cau dong y
};

/**
 * Doi ten bieu tuong thanh ma Zalo. Tra ve null neu khong nam trong danh sach
 * trang - noi goi PHAI kiem null va bo qua, tuyet doi khong tu tim cach khac.
 */
export function layBieuTuong(ten) {
  return Object.prototype.hasOwnProperty.call(CHO_PHEP, ten) ? CHO_PHEP[ten] : null;
}

export function danhSachChoPhep() {
  return Object.keys(CHO_PHEP);
}

/**
 * Tha cam xuc thay cho tra loi bang chu.
 *
 * Khach nhan "cam on em" ma bot dap lai "da khong co gi a" thi vua ton tien
 * (~48d moi cau), vua keo dai cuoc tro chuyen mot cach vo duyen. Nguoi that
 * trong truong hop nay chi tha mot cai tim.
 *
 * Lam bang luat CUNG, khong hoi AI: vua mien phi hoan toan, vua chac chan
 * khong bao gio tha cam xuc vao mot cau hoi that su can tra loi.
 */

/** Cau ngan het y, khong con gi de tra loi -> tha tim. */
const CAM_ON = [
  "cảm ơn", "cám ơn", "cam on", "cảm ơn em", "cảm ơn chị", "thank", "thanks", "tks", "tq",
  "biết ơn em", "em tốt quá", "chị cảm ơn", "cảm ơn nhiều",
];

/** Cau xac nhan -> tha like. */
const DONG_Y = [
  "ok", "oke", "okie", "okay", "okey", "vâng", "vâng ạ", "dạ", "dạ vâng", "dạ em biết rồi",
  "ừ", "uhm", "um", "uh", "hiểu rồi", "em hiểu rồi", "chị hiểu rồi", "rõ rồi",
  "được rồi", "ok em", "ok chị", "chuẩn", "đúng rồi",
];

/**
 * Bieu tuong don than khach gui -> tha tim lai.
 * Phai ke ca ️ (bo chon kieu hien thi) va ‍ (dau noi): "❤️" that ra
 * la HAI ky tu U+2764 + U+FE0F, thieu cai sau la khong khop.
 */
const CHI_EMOJI = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}️‍\s]+$/u;

/**
 * Khach gui bieu tuong TIEU CUC thi PHAI tra loi bang loi, khong duoc tha tim.
 * Khach dang buc hoac dang khoc ma bot tha mot cai tim vao do thi vo cam hon
 * ca im lang - va day dung la luc khach can nguoi that nhat.
 */
const EMOJI_XAU = /[\u{1F620}-\u{1F624}\u{1F62D}\u{1F622}\u{1F61E}\u{1F614}\u{1F616}\u{1F621}\u{1F92C}\u{1F44E}\u{1F494}\u{1F62B}\u{1F625}\u{1F613}]/u;

const DAI_NHAT = 28;

/** Gom cac bien the ve mot dang: "oke em", "okie em", "okay em" -> "ok em". */
function chuanHoa(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!,~\s]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(oke|okie|okay|okey)\b/g, "ok");
}

/**
 * @returns {"HEART"|"LIKE"|null} ten bieu tuong, hoac null neu phai tra loi that.
 * Ket qua LUON nam trong danh sach trang o dau file.
 */
export function chonCamXuc(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // Co dau hoi la khach dang hoi that -> phai tra loi, khong duoc tha cam xuc
  // roi im lang.
  if (raw.includes("?")) return null;
  if (raw.length > DAI_NHAT) return null;

  if (CHI_EMOJI.test(raw)) return EMOJI_XAU.test(raw) ? null : "HEART";

  const s = chuanHoa(raw);
  if (!s) return null;
  if (CAM_ON.some((t) => s === t || s.startsWith(t + " ") || s.endsWith(" " + t))) return "HEART";
  if (DONG_Y.includes(s)) return "LIKE";
  return null;
}

/** Rut ma tin de tha cam xuc. Thieu mot trong hai la Zalo tu choi. */
export function layMaTin(message) {
  const dt = message?.rawJson?.data;
  if (!dt?.msgId || !dt?.cliMsgId) return null;
  return { msgId: String(dt.msgId), cliMsgId: String(dt.cliMsgId) };
}
