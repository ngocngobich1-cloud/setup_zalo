import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import {
  countUsers,
  createUser,
  getUserById,
  getUserByUsername,
  updateUsername,
  updateUserPassword,
} from "./db.js";

const BCRYPT_ROUNDS = 10;
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Mat khau cho dung mot lan tren may vua cai xong, de nguoi dung khong phai di
 * mo log tim mat khau ngau nhien. No CHI song duoc toi khi dang nhap lan dau:
 * tai khoan tao ra kem co must_change_password = 1, va toan bo app bi khoa lai
 * cho toi khi doi xong. Doi mat khau van phai theo dung MIN_PASSWORD_LENGTH,
 * nen chuoi 5 ky tu nay khong bao gio duoc chon lai.
 */
export const MAT_KHAU_KHOI_TAO = "admin";

/**
 * Lan dau chay tren mot CSDL trong.
 *
 * Truoc day tao san admin/admin roi in ra man hinh kem loi nhac "hay doi ngay".
 * Loi nhac khong phai la bien phap bao ve: tren VPS cong khai, tu luc container
 * len den luc chi kip dang nhap lan dau, bat ky ai mo dung dia chi deu vao duoc
 * bang mot cap chu ai cung doan ra - va co ngay ca Zalo, Zoho lan cau hinh AI.
 *
 * Gio: lay tu bien moi truong neu co, khong thi SINH NGAU NHIEN va in dung mot
 * lan. Khong con mat khau nao doan truoc duoc.
 */
export async function ensureDefaultUser() {
  if ((await countUsers()) > 0) return null;

  const username = String(process.env.ADMIN_USERNAME || "admin").trim() || "admin";
  const tuEnv = String(process.env.ADMIN_PASSWORD || "");

  if (tuEnv && tuEnv.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD phải dài ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
  }

  // Khong dat ADMIN_PASSWORD -> dung mat khau khoi tao de nho, NHUNG danh dau
  // bat buoc doi ngay. Nguong MIN_PASSWORD_LENGTH khong he bi ha xuong: no van
  // ap dung cho MOI mat khau nguoi dung tu chon sau nay; "admin" chi song duoc
  // dung mot lan, cho tro dang nhap dau tien.
  const password = tuEnv || MAT_KHAU_KHOI_TAO;
  const batBuocDoi = !tuEnv;

  const user = await createUser({
    username,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    mustChangePassword: batBuocDoi,
  });

  if (tuEnv) {
    console.log(`[auth] Da tao tai khoan "${username}" bang ADMIN_PASSWORD trong moi truong.`);
  } else {
    console.log(
      "\n" +
        "=".repeat(64) + "\n" +
        "  TAI KHOAN QUAN TRI VUA DUOC TAO\n" +
        `     Ten dang nhap : ${username}\n` +
        `     Mat khau      : ${MAT_KHAU_KHOI_TAO}\n` +
        "  Dang nhap lan dau se BAT BUOC doi sang mat khau rieng.\n" +
        "=".repeat(64) + "\n"
    );
  }
  return user;
}

/** Mat khau ngau nhien de doc: bo ky tu de nhin nham (0/O, 1/l/I). */
function sinhMatKhau(soKyTu = 20) {
  const BANG = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(soKyTu);
  let s = "";
  for (let i = 0; i < soKyTu; i++) s += BANG[bytes[i] % BANG.length];
  return s;
}

/** Tra ve user neu dung mat khau, nguoc lai null. Khong bao gio noi ro sai o dau. */
export async function verifyCredentials(username, password) {
  const user = await getUserByUsername(username);
  if (!user) {
    // So sanh gia de thoi gian phan hoi khong to ra la username khong ton tai.
    await bcrypt.compare(String(password || ""), "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin");
    return null;
  }
  const ok = await bcrypt.compare(String(password || ""), user.passwordHash);
  return ok ? user : null;
}

export async function changePassword(userId, currentPassword, newPassword, confirmPassword) {
  const user = await getUserById(userId);
  if (!user) return { ok: false, error: "Không tìm thấy tài khoản." };

  const ok = await bcrypt.compare(String(currentPassword || ""), user.passwordHash);
  if (!ok) return { ok: false, error: "Mật khẩu hiện tại không đúng." };

  const next = String(newPassword || "");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Mật khẩu mới phải từ ${MIN_PASSWORD_LENGTH} ký tự.` };
  }
  // Chan tuong minh: khong duoc chon lai chinh mat khau khoi tao. Ngưỡng độ dài
  // ở trên đã loại nó rồi, nhưng nói rõ ra để nếu sau này ai đổi ngưỡng thì cửa
  // này vẫn đóng.
  if (next === MAT_KHAU_KHOI_TAO) {
    return { ok: false, error: "Không được dùng lại mật khẩu mặc định. Hãy chọn mật khẩu khác." };
  }
  if (next !== String(confirmPassword || "")) {
    return { ok: false, error: "Xác nhận mật khẩu không khớp." };
  }

  await updateUserPassword(user.id, await bcrypt.hash(next, BCRYPT_ROUNDS));
  return { ok: true };
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

export async function changeUsername(userId, currentPassword, newUsername) {
  const user = await getUserById(userId);
  if (!user) return { ok: false, error: "Không tìm thấy tài khoản." };

  const ok = await bcrypt.compare(String(currentPassword || ""), user.passwordHash);
  if (!ok) return { ok: false, error: "Mật khẩu hiện tại không đúng." };

  const ten = String(newUsername || "").trim();
  if (!USERNAME_PATTERN.test(ten)) {
    return { ok: false, error: "Tên đăng nhập 3-32 ký tự, chỉ gồm chữ, số, dấu chấm, gạch ngang, gạch dưới." };
  }
  if (ten.toLowerCase() !== user.username.toLowerCase()) {
    const trung = await getUserByUsername(ten);
    if (trung) return { ok: false, error: "Tên đăng nhập này đã có người dùng." };
  }

  await updateUsername(user.id, ten);
  return { ok: true, username: ten };
}

export function publicUser(user) {
  return user ? { id: user.id, username: user.username } : null;
}
