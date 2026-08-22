import nodemailer from "nodemailer";
import { getSmtpConfig } from "./db.js";

export function isSmtpReady(config) {
  return Boolean(config?.host?.trim() && config?.fromAddress?.trim());
}

export async function sendEmail({ to, subject, text }) {
  const config = await getSmtpConfig();
  if (!isSmtpReady(config)) {
    throw new Error("Chưa cấu hình SMTP (máy chủ gửi mail).");
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Server SMTP khong yeu cau dang nhap thi bo qua auth.
    ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
  });

  await transporter.sendMail({ from: config.fromAddress, to, subject, text });
}

/** Kiem tra ket noi SMTP ma khong gui mail that. */
export async function verifySmtp() {
  const config = await getSmtpConfig();
  if (!isSmtpReady(config)) throw new Error("Chưa cấu hình SMTP (máy chủ gửi mail).");

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
  });
  await transporter.verify();
}
