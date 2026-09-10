import { addLog } from "./activity-log.js";
import * as emailCheck from "./email-check.js";
import { normalize } from "./knowledge-retrieval.js";
import { fetchWebsiteCustomerStatus, getSafeWebsiteConfig } from "./website.js";

export const TRA_EMAIL_STATUS_MOI_GIO = 8;

const Y_KIEM_TRA_EMAIL = Object.freeze([
  "kiem tra email",
  "kiem tra mail",
  "kiem tra giup",
  "check email",
  "check mail",
  "email gui chua",
  "mail gui chua",
  "gui email chua",
  "gui mail chua",
  "da gui email chua",
  "da gui mail chua",
  "email xac nhan",
  "mail xac nhan",
  "xem email giup",
  "xem mail giup",
]);

const lichSuTra = new Map();
let ghiLog = addLog;

/** Seam hẹp để focused test không ghi activity DB thật. */
export function capHinhLogChoKiemThu(fn) {
  ghiLog = typeof fn === "function" ? fn : addLog;
}

function khoaNguoiHoi(ownerUid, messageObj) {
  const requester = messageObj?.senderId || messageObj?.threadId || messageObj?.senderName || "?";
  return `${String(ownerUid || "?")}:${String(requester)}`;
}

function conLuotTra(ownerUid, messageObj) {
  const khoa = khoaNguoiHoi(ownerUid, messageObj);
  const moc = Date.now() - 60 * 60 * 1000;
  const ds = (lichSuTra.get(khoa) || []).filter((thoiDiem) => thoiDiem > moc);
  if (ds.length >= TRA_EMAIL_STATUS_MOI_GIO) {
    lichSuTra.set(khoa, ds);
    return false;
  }
  ds.push(Date.now());
  lichSuTra.set(khoa, ds);
  return true;
}

export function laYKiemTraEmail(text) {
  const daChuanHoa = normalize(text);
  return Y_KIEM_TRA_EMAIL.some((cumTu) => daChuanHoa.includes(cumTu));
}

function giaTriChuoiTuyChon(value, maxLength) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("WEBSITE_EMAIL_STATUS_INVALID");
  if (value.length > maxLength || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new Error("WEBSITE_EMAIL_STATUS_INVALID");
  }
  return value;
}

function taoContextDaGui(emailStatus) {
  const dong = [
    "# KẾT QUẢ TRẠNG THÁI EMAIL TỪ WEBSITE (dữ kiện hệ thống vừa tra)",
    "Chỉ dùng đúng các dữ kiện dưới đây; không suy diễn trạng thái hoặc thời gian.",
    `sent_at: ${emailStatus.sent_at}`,
  ];
  if (emailStatus.status != null) dong.push(`status: ${emailStatus.status}`);
  if (emailStatus.email_type != null) dong.push(`email_type: ${emailStatus.email_type}`);
  if (emailStatus.template_key != null) dong.push(`template_key: ${emailStatus.template_key}`);
  return `${dong.join("\n")}\n\n`;
}

function canLyDo(classification, email) {
  if (classification === "NOT_TRACKED") {
    return `Website chưa có dữ liệu tracking email cho ${email}.`;
  }
  if (classification === "FOUND_FALSE") {
    return `Website không tìm thấy customer với email ${email}.`;
  }
  if (classification === "UNRESOLVED") {
    return `Website tìm thấy customer nhưng chưa có dữ liệu đủ để xác nhận thời điểm gửi email cho ${email}.`;
  }
  return `Hiện không tra được trạng thái email từ Website cho ${email}.`;
}

export function phanLoaiCustomerStatus(data, email) {
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.found !== "boolean") {
    throw new Error("WEBSITE_EMAIL_STATUS_INVALID");
  }
  if (data.found === false) {
    const classification = "FOUND_FALSE";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      email,
      adminReasonText: canLyDo(classification, email),
    };
  }

  if (!data.email_status || typeof data.email_status !== "object" || Array.isArray(data.email_status)) {
    const classification = "UNRESOLVED";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      reason: "email_status_unresolved",
      email,
      adminReasonText: canLyDo(classification, email),
    };
  }

  const emailStatus = {
    sent_at: giaTriChuoiTuyChon(data.email_status.sent_at, 128),
    status: giaTriChuoiTuyChon(data.email_status.status, 64),
    email_type: giaTriChuoiTuyChon(data.email_status.email_type, 128),
    template_key: giaTriChuoiTuyChon(data.email_status.template_key, 128),
  };
  const coThoiDiemGui = emailStatus.sent_at != null && emailStatus.sent_at.trim() !== "";
  if (emailStatus.status === "not_tracked" && coThoiDiemGui) {
    throw new Error("WEBSITE_EMAIL_STATUS_INVALID");
  }
  if (emailStatus.status === "not_tracked") {
    const classification = "NOT_TRACKED";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      email,
      adminReasonText: canLyDo(classification, email),
    };
  }
  if (coThoiDiemGui) {
    return {
      outcome: "SENT",
      classification: "SENT",
      email,
      aiContext: taoContextDaGui(emailStatus),
    };
  }

  const classification = "UNRESOLVED";
  return {
    outcome: "NEEDS_ADMIN",
    classification,
    reason: "email_status_unresolved",
    email,
    adminReasonText: canLyDo(classification, email),
  };
}

export async function lookupCustomerEmailStatus({
  userMessage,
  messageObj,
  ownerUid,
  privateOneToOne = false,
} = {}) {
  if (!privateOneToOne) return { outcome: "NO_MATCH", reason: "PRIVATE_ONLY" };

  const email = emailCheck.timEmailTrongTin(userMessage);
  if (!email) return { outcome: "NO_MATCH", reason: "EMAIL_MISSING" };
  if (!laYKiemTraEmail(userMessage)) return { outcome: "NO_MATCH", reason: "INTENT_MISSING" };

  try {
    const websiteConfig = await getSafeWebsiteConfig();
    if (!websiteConfig.configured) return { outcome: "NOT_CONFIGURED" };
  } catch {
    const classification = "SOURCE_ERROR";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      email,
      adminReasonText: canLyDo(classification, email),
    };
  }

  if (!conLuotTra(ownerUid, messageObj)) {
    await ghiLog({
      event: "email_status_tra_qua_nhieu",
      level: "warn",
      summary: `Chặn tra trạng thái email: ${messageObj?.senderName || messageObj?.senderId || "?"} đã tra quá ${TRA_EMAIL_STATUS_MOI_GIO} địa chỉ trong 1 giờ`,
      detail: {
        ownerUid,
        nguoiHoiUid: messageObj?.senderId || "",
        email,
      },
    }).catch(() => {});
    return { outcome: "RATE_LIMITED", email };
  }

  try {
    const data = await fetchWebsiteCustomerStatus(email);
    return phanLoaiCustomerStatus(data, email);
  } catch (error) {
    if (error?.ma === "WEBSITE_CONFIG_INCOMPLETE") {
      return { outcome: "NOT_CONFIGURED" };
    }
    const classification = "SOURCE_ERROR";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      email,
      adminReasonText: canLyDo(classification, email),
    };
  }
}
