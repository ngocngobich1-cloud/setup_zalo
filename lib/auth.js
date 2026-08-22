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
  const password = tuEnv || sinhMatKhau();

  if (tuEnv && tuEnv.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD phải dài ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
  }

  const user = await createUser({ username, passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) });

  if (tuEnv) {
    console.log(`[auth] Da tao tai khoan "${username}" bang ADMIN_PASSWORD trong moi truong.`);
  } else {
    console.log(
      "\n" +
        "=".repeat(64) + "\n" +
        "  TAI KHOAN QUAN TRI VUA DUOC TAO - GHI LAI NGAY, CHI HIEN MOT LAN\n" +
        `     Ten dang nhap : ${username}\n` +
        `     Mat khau      : ${password}\n` +
        "  Dang nhap xong hay doi sang mat khau cua rieng chi.\n" +
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
