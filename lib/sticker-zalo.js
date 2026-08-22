/**
 * Sticker bot duoc phep dung.
 *
 * DANH SACH TRANG, giong het cach da khoa bieu tuong cam xuc. Zalo co ham
 * searchSticker() tim trong kho theo tu khoa, nhung KHONG dung luc dang chat:
 * kho tra ve gi minh khong kiem soat duoc, ra mot cai hai huoc lo hoac lech
 * ngu canh thi khach da nhin thay roi, khong rut lai duoc.
 *
 * Muon doi sticker thi sua bang duoi day, khong phai sua logic.
 */

const CHO_PHEP = {
  chao_hoi: { id: 25826, cateId: 10617, type: 7, moTa: "Hello — thỏ trắng vẫy chào" },
  cam_on: { id: 25709, cateId: 10610, type: 7, moTa: "Thank you — vịt cảm ơn" },
  dong_vien: { id: 19781, cateId: 10233, type: 7, moTa: "CỐ LÊN — nắm đấm tiếp sức" },
  lang_nghe: { id: 32050, cateId: 11031, type: 7, moTa: "Hai chú thỏ ôm nhau" },
  vui_mung: { id: 19787, cateId: 10233, type: 7, moTa: "CHÚC MỪNG" },
  cho_chut: { id: 19780, cateId: 10233, type: 7, moTa: "CHỜ CHÚT — đồng hồ cát" },
  dong_y: { id: 47231, cateId: 12017, type: 7, moTa: "ok" },
  chao_buoi_toi: { id: 16720, cateId: 10047, type: 7, moTa: "Gà con ngủ" },
};

/**
 * Chot chan cuoi. Du sau nay ai do sua chonTinhHuong tra ve ten la, den day van
 * bi chan - bot khong the gui sticker ngoai danh sach chi da duyet.
 */
export function layStickerHopLe(viec) {
  return Object.prototype.hasOwnProperty.call(CHO_PHEP, viec) ? CHO_PHEP[viec] : null;
}

export function danhSachSticker() {
  return Object.entries(CHO_PHEP).map(([viec, s]) => ({ viec, ...s }));
}

function bocDau(s) {
  return String(s || "")
    .normalize("NFD") // tach dau ra thanh ky tu rieng
    .toLowerCase()
    // XOA HAN dau, khong doi thanh khoang trang: doi thanh khoang trang thi
    // "buon" bi cat thanh "buo n" va khong con khop tu khoa nao nua.
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d") // chu "d" gach ngang khong tach duoc bang NFD
    .replace(/[^a-z0-9]+/g, " ") // dau cau, ky tu la -> khoang trang
    .trim();
}

/**
 * Cau chuyen dang nang. Khach ke chuyen buon ma bot ban con ga nhay mua thi
 * hong ca cuoc tro chuyen - ma chi khong kiem soat duoc vi bot tu chon.
 */
const NANG = [
  "buon", "khoc", "met moi", "kiet suc", "ap luc", "be tac", "tuyet vong", "chan nan",
  "lo lang", "so hai", "hoang mang", "dau kho", "tui than", "co don", "trong rong",
  "ly hon", "chia tay", "that bai", "benh", "dau", "mat ngu", "stress", "tram cam",
];

/** Loi khach doc len la thay vui. */
const NHE = {
  cam_on: ["cam on", "cam on em", "thanks", "thank you", "biet on"],
  chao_hoi: ["chao em", "chao vizen", "hello", "alo", "chao buoi sang"],
  chao_buoi_toi: ["ngu ngon", "chuc ngu ngon", "di ngu day", "good night"],
  vui_mung: ["tuyet qua", "vui qua", "thanh cong roi", "lam duoc roi", "dat roi", "hoan thanh roi"],
  dong_y: ["ok em", "okie", "duoc roi em", "chot vay", "dong y"],
};

/**
 * Chon tinh huong dua tren LOI KHACH. Tra ve ten tinh huong hoac null.
 *
 * Chuyen nang -> chi cho phep sticker an ui, khong bao gio cho sticker vui.
 * Khong ro -> tra null, im lang. Tha khong gui con hon gui sai luc.
 *
 * @param {string} loiKhach
 * @returns {string|null}
 */
export function chonTinhHuong(loiKhach) {
  const t = bocDau(loiKhach);
  if (!t.trim()) return null;

  if (NANG.some((k) => t.includes(k))) return "lang_nghe";

  for (const [viec, tuKhoa] of Object.entries(NHE)) {
    if (tuKhoa.some((k) => t.includes(k))) return viec;
  }
  return null;
}
