import bcrypt from "bcryptjs";
import {
  countUsers,
  createUser,
  getUserById,
  getUserByUsername,
  updateUsername,
  updateUserPassword,
} from "./db.js";

const BCRYPT_ROUNDS = 10;
const DEFAULT_USERNAME = "admin";
const DEFAULT_PASSWORD = "admin";
export const MIN_PASSWORD_LENGTH = 6;

/** Lan dau chay: chua co user nao thi tao admin/admin (da bam). */
export async function ensureDefaultUser() {
  if ((await countUsers()) > 0) return null;
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_ROUNDS);
  const user = await createUser({ username: DEFAULT_USERNAME, passwordHash });
  console.log(`[auth] Da tao tai khoan mac dinh: ${DEFAULT_USERNAME}/${DEFAULT_PASSWORD} - hay doi mat khau ngay.`);
  return user;
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
