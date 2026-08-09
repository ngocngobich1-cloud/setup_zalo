import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { sendEmail } from "./email-sender.js";
import { isLoggedIn, sendChatMessage } from "./zalo-service.js";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_LENGTH = 6;

function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  if (!domain) return "***";
  const head = name.slice(0, 1);
  return `${head}${"*".repeat(Math.max(2, name.length - 1))}@${domain}`;
}

function maskZalo(user) {
  if (user.otpZaloLabel) return user.otpZaloLabel;
  const id = String(user.otpZaloThreadId);
  return `***${id.slice(-4)}`;
}

/** Cac kenh da duoc cau hinh cho tai khoan; dich den luon o dang che bot. */
export function availableChannels(user) {
  const channels = [];
  if (user.otpZaloThreadId) channels.push({ id: "zalo", label: "Nick Zalo", target: maskZalo(user) });
  if (user.otpEmail) channels.push({ id: "email", label: "Email", target: maskEmail(user.otpEmail) });
  return channels;
}

function generateCode() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

async function deliver(user, channel, code) {
  const message =
    `Mã xác thực đăng nhập Zalo Web của bạn là: ${code}\n` +
    `Mã có hiệu lực trong 5 phút. Không chia sẻ mã này cho bất kỳ ai.`;

  if (channel === "zalo") {
    if (!user.otpZaloThreadId) throw new Error("Chưa cấu hình nick Zalo nhận OTP.");
    if (!isLoggedIn()) {
      throw new Error("Zalo chưa đăng nhập nên không gửi được OTP. Hãy chọn kênh Email.");
    }
    await sendChatMessage({ threadId: user.otpZaloThreadId, threadType: 0, text: message });
    return;
  }

  if (channel === "email") {
    if (!user.otpEmail) throw new Error("Chưa cấu hình email nhận OTP.");
    await sendEmail({ to: user.otpEmail, subject: "Mã xác thực đăng nhập Zalo Web", text: message });
    return;
  }

  throw new Error("Kênh nhận OTP không hợp lệ.");
}

/**
 * Tao ma moi va gui qua kenh da chon. Ma chi luu duoi dang hash trong session
 * phia server, khong bao gio tra ve client.
 */
export async function sendChallenge(session, user, channel) {
  const now = Date.now();
  if (session.otp?.lastSentAt && now - session.otp.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
    const conLai = Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - session.otp.lastSentAt)) / 1000);
    throw new Error(`Vui lòng đợi ${conLai} giây trước khi gửi lại mã.`);
  }

  const code = generateCode();
  await deliver(user, channel, code);

  session.otp = {
    hash: await bcrypt.hash(code, 10),
    channel,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  };
  return { channel, expiresInSeconds: Math.floor(OTP_TTL_MS / 1000) };
}

export async function verifyChallenge(session, code) {
  const challenge = session.otp;
  if (!challenge) return { ok: false, error: "Chưa có mã xác thực. Hãy yêu cầu gửi mã." };
  if (Date.now() > challenge.expiresAt) {
    delete session.otp;
    return { ok: false, error: "Mã đã hết hạn. Hãy yêu cầu gửi lại." };
  }
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    delete session.otp;
    return { ok: false, error: "Nhập sai quá nhiều lần. Hãy yêu cầu gửi lại mã." };
  }

  challenge.attempts += 1;
  const ok = await bcrypt.compare(String(code || "").trim(), challenge.hash);
  if (!ok) {
    const conLai = OTP_MAX_ATTEMPTS - challenge.attempts;
    return { ok: false, error: `Mã không đúng. Còn ${conLai} lần thử.` };
  }

  delete session.otp;
  return { ok: true };
}
