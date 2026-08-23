import { getActivityLogs, insertActivityLog } from "./db.js";

let emitter = null;

/**
 * server.js tiem ham lay uid tai khoan Zalo dang dang nhap vao day.
 * Nhat ky phai biet no thuoc ve tai khoan nao, neu khong log cua tai khoan cu
 * se hien lan trong man LOG cua tai khoan moi.
 */
let layChuTaiKhoan = () => null;
export function capHinhChuTaiKhoan(fn) {
  layChuTaiKhoan = fn;
}

/** server.js gan ham nay de day log realtime qua Socket.IO. */
export function setEmitter(fn) {
  emitter = typeof fn === "function" ? fn : null;
}

/**
 * Ghi mot dong nhat ky. Khong bao gio nem loi ra ngoai: log hong thi ke,
 * khong duoc phep lam chet luong xu ly tin nhan.
 */
export async function addLog({ event, level = "info", summary = "", detail = null }) {
  try {
    const row = await insertActivityLog({ ownerUid: layChuTaiKhoan(), event, level, summary, detail });
    if (row && emitter) emitter(row);
    return row;
  } catch (error) {
    console.warn("[activity-log] Khong ghi duoc log:", error.message);
    return null;
  }
}

export async function getRecentLogs(limit = 150) {
  try {
    return await getActivityLogs(layChuTaiKhoan(), limit);
  } catch (error) {
    console.warn("[activity-log] Khong doc duoc log:", error.message);
    return [];
  }
}
