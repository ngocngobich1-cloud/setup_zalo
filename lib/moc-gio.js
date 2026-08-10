/**
 * Cho bot biet BAY GIO LA MAY GIO.
 *
 * Truoc day khong co cho nao noi cho bot biet thoi gian ca. Hau qua that: toi
 * chi chao "chi di ngu day", sang hom sau chi nhan lai, bot van tuong chi chua
 * ngu va khuyen chi dat dien thoai xuong di nghi. Voi bot, hai cau do nam sat
 * nhau trong mot dong lien mach - khong co gi bao hieu da qua 10 tieng.
 *
 * Container dat TZ=Asia/Ho_Chi_Minh nen new Date() da la gio Viet Nam.
 */

const THU = ["Chủ Nhật", "thứ Hai", "thứ Ba", "thứ Tư", "thứ Năm", "thứ Sáu", "thứ Bảy"];

/** Nghi tu day tro len thi dang mot vach cho de nhin. */
export const NGUONG_NGHI_MS = 4 * 60 * 60 * 1000;

const hai = (n) => String(n).padStart(2, "0");
const gioPhut = (d) => `${hai(d.getHours())}:${hai(d.getMinutes())}`;

/** Buoi trong ngay theo cach noi cua nguoi Viet. */
export function buoiTrongNgay(gio) {
  if (gio < 4) return "đêm";
  if (gio < 11) return "sáng";
  if (gio < 13) return "trưa";
  if (gio < 18) return "chiều";
  if (gio < 22) return "tối";
  return "khuya";
}

/** Mốc đọc cho bot mỗi lượt trả lời. */
export function mocHienTai(bayGio = new Date()) {
  const d = bayGio;
  return (
    `${gioPhut(d)} ${buoiTrongNgay(d.getHours())} ${THU[d.getDay()]}, ` +
    `${hai(d.getDate())}/${hai(d.getMonth() + 1)}/${d.getFullYear()} (giờ Việt Nam)`
  );
}

/** So ngay lech giua hai moc, tinh theo NGAY LICH chu khong theo 24 tieng. */
function lechNgay(a, b) {
  const x = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const y = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((y - x) / 86400000);
}

/**
 * Nhan thoi gian cho mot dong lich su: "hom nay 09:54", "hom qua 23:24",
 * "thu Ba 14:00", "05/08 10:30".
 */
export function nhanThoiGian(ts, bayGio = new Date()) {
  if (!ts) return "";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "";

  const lech = lechNgay(d, bayGio);
  if (lech === 0) return `hôm nay ${gioPhut(d)}`;
  if (lech === 1) return `hôm qua ${gioPhut(d)}`;
  if (lech >= 2 && lech <= 6) return `${THU[d.getDay()]} ${gioPhut(d)}`;
  return `${hai(d.getDate())}/${hai(d.getMonth() + 1)} ${gioPhut(d)}`;
}

/**
 * Mo ta khoang nghi giua hai tin lien tiep. Tra ve null neu nghi ngan, khong
 * dang danh dau.
 *
 * Day moi la thu giai quyet dung ca cua chi: mot vach "nghi 10 tieng, sang ngay
 * moi" thi bot hieu ngay khach da di ngu day, khong phai suy doan.
 */
export function moTaKhoangNghi(tsTruoc, tsSau) {
  if (!tsTruoc || !tsSau) return null;
  const a = new Date(Number(tsTruoc));
  const b = new Date(Number(tsSau));
  const cach = b - a;
  if (!(cach >= NGUONG_NGHI_MS)) return null;

  const ngay = lechNgay(a, b);
  if (cach >= 48 * 3600000) return `— nghỉ ${Math.round(cach / 86400000)} ngày —`;

  const tieng = Math.round(cach / 3600000);
  return ngay >= 1 ? `— nghỉ ${tieng} tiếng, sang ngày mới —` : `— nghỉ ${tieng} tiếng —`;
}
