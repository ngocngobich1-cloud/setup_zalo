import { addLog } from "./activity-log.js";
import * as emailCheck from "./email-check.js";
import { normalize } from "./knowledge-retrieval.js";
import { fetchWebsiteCustomerStatus, getSafeWebsiteConfig } from "./website.js";
import { normalizePhone } from "./website-data.js";

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

// Match one numeric run in the current batch. Separators are allowed only
// between digit groups; never strip punctuation from the entire message.
const PHONE_RUN = /(?<![\p{L}\p{N}@])\+?\d+(?:[ .-]\d+)*(?![\p{L}\p{N}@])/gu;
const NON_PHONE_LABEL = /(?:^|[\s,;:])(?:mã\s+đơn|ma\s+don|mã|ma|đơn|don|order(?:\s+id)?|transaction(?:\s+id)?|mst|tax\s+id|id|giá|gia|số\s+tiền|so\s+tien)\s*[:#-]?\s*$/iu;

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

export function timSoDienThoaiTrongTin(text) {
  const message = String(text || "");
  const phones = new Set();
  for (const match of message.matchAll(PHONE_RUN)) {
    const preceding = message.slice(Math.max(0, match.index - 48), match.index);
    if (NON_PHONE_LABEL.test(preceding)) continue;
    const phone = normalizePhone(match[0]);
    if (phone) phones.add(phone);
  }
  return phones;
}

function giaTriChuoiTuyChon(value, maxLength) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("WEBSITE_EMAIL_STATUS_INVALID");
  if (value.length > maxLength || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new Error("WEBSITE_EMAIL_STATUS_INVALID");
  }
  return value;
}

function registeredEmailAnToan(value) {
  if (value == null) return null;
  try {
    const normalized = giaTriChuoiTuyChon(value, 254).trim().toLowerCase();
    return normalized && emailCheck.timEmailTrongTin(normalized) === normalized ? normalized : null;
  } catch {
    return null;
  }
}

function taoContextDaGui(emailStatus, registeredEmail) {
  const dong = [
    "# KẾT QUẢ TRẠNG THÁI EMAIL TỪ WEBSITE (dữ kiện hệ thống vừa tra)",
    "Chỉ dùng đúng các dữ kiện dưới đây; không suy diễn trạng thái hoặc thời gian.",
    `sent_at: ${emailStatus.sent_at}`,
  ];
  if (emailStatus.status != null) dong.push(`status: ${emailStatus.status}`);
  if (emailStatus.email_type != null) dong.push(`email_type: ${emailStatus.email_type}`);
  if (emailStatus.template_key != null) dong.push(`template_key: ${emailStatus.template_key}`);
  if (registeredEmail) {
    dong.push(`registered_email: ${registeredEmail}`);
    dong.push("Khi trả lời, dùng registered_email làm địa chỉ đích Website đã xác nhận; email khách tự nhập chỉ để đối chiếu.");
  }
  return `${dong.join("\n")}\n\n`;
}

function canLyDo(classification, email, phone = null) {
  const identifier = email || (phone ? "SĐT khách cung cấp" : "thông tin khách cung cấp");
  if (classification === "AMBIGUOUS_PHONE") {
    return "Tin khách có nhiều SĐT khác nhau; cần Admin xác minh hồ sơ cần tra.";
  }
  if (classification === "NOT_TRACKED") {
    return `Website chưa có dữ liệu tracking email cho ${identifier}.`;
  }
  if (classification === "FOUND_FALSE") {
    return `Website không tìm thấy customer với ${email ? `email ${email}` : identifier}.`;
  }
  if (classification === "UNRESOLVED") {
    return `Website tìm thấy customer nhưng chưa có dữ liệu đủ để xác nhận thời điểm gửi email cho ${identifier}.`;
  }
  return `Hiện không tra được trạng thái email từ Website cho ${identifier}.`;
}

export function phanLoaiCustomerStatus(data, email, phone = null) {
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.found !== "boolean") {
    throw new Error("WEBSITE_EMAIL_STATUS_INVALID");
  }
  if (data.found === false) {
    const classification = "FOUND_FALSE";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      email,
      adminReasonText: canLyDo(classification, email, phone),
    };
  }

  if (!data.email_status || typeof data.email_status !== "object" || Array.isArray(data.email_status)) {
    const classification = "UNRESOLVED";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      reason: "email_status_unresolved",
      email,
      adminReasonText: canLyDo(classification, email, phone),
    };
  }

  const emailStatus = {
    sent_at: giaTriChuoiTuyChon(data.email_status.sent_at, 128),
    status: giaTriChuoiTuyChon(data.email_status.status, 64),
    email_type: giaTriChuoiTuyChon(data.email_status.email_type, 128),
    template_key: giaTriChuoiTuyChon(data.email_status.template_key, 128),
  };
  const registeredEmail = registeredEmailAnToan(data.registered_email);
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
      adminReasonText: canLyDo(classification, email, phone),
    };
  }
  if (coThoiDiemGui) {
    return {
      outcome: "SENT",
      classification: "SENT",
      email,
      ...(registeredEmail ? { registered_email: registeredEmail } : {}),
      aiContext: taoContextDaGui(emailStatus, registeredEmail),
    };
  }

  const classification = "UNRESOLVED";
  return {
    outcome: "NEEDS_ADMIN",
    classification,
    reason: "email_status_unresolved",
    email,
    adminReasonText: canLyDo(classification, email, phone),
  };
}

export async function lookupCustomerEmailStatus({
  userMessage,
  messageObj,
  ownerUid,
  privateOneToOne = false,
} = {}) {
  if (process.env.VIZEN_EMAIL_STATUS_LOOKUP_ENABLED !== "1") {
    return { outcome: "NO_MATCH", reason: "DEFERRED" };
  }
  if (!privateOneToOne) return { outcome: "NO_MATCH", reason: "PRIVATE_ONLY" };

  const email = emailCheck.timEmailTrongTin(userMessage);
  const phones = timSoDienThoaiTrongTin(userMessage);
  if (!email && phones.size === 0) return { outcome: "NO_MATCH", reason: "EMAIL_MISSING" };
  if (!laYKiemTraEmail(userMessage)) return { outcome: "NO_MATCH", reason: "INTENT_MISSING" };
  if (phones.size > 1) {
    const classification = "AMBIGUOUS_PHONE";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      email,
      adminReasonText: canLyDo(classification, email),
    };
  }
  const phone = phones.values().next().value || null;

  try {
    const websiteConfig = await getSafeWebsiteConfig();
    if (!websiteConfig.configured) return { outcome: "NOT_CONFIGURED" };
  } catch {
    const classification = "SOURCE_ERROR";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      email,
      adminReasonText: canLyDo(classification, email, phone),
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
    const data = await fetchWebsiteCustomerStatus(phone ? { phone, email } : email);
    return phanLoaiCustomerStatus(data, email, phone);
  } catch (error) {
    if (error?.ma === "WEBSITE_CONFIG_INCOMPLETE") {
      return { outcome: "NOT_CONFIGURED" };
    }
    const classification = "SOURCE_ERROR";
    return {
      outcome: "NEEDS_ADMIN",
      classification,
      email,
      adminReasonText: canLyDo(classification, email, phone),
    };
  }
}
