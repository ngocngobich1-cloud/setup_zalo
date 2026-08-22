import {
  bumpCustomerTurns,
  getCustomerMemory,
  resetCustomerTurns,
  saveCustomerMemory,
} from "./db.js";
import { buildRecentHistory } from "./conversation-context.js";
import * as opencode from "./opencode.js";
import { addLog } from "./activity-log.js";

/** Tran do dai ho so. Ho so duoc nap lai moi phien nen dai la ton tien mai mai. */
export const HO_SO_MAX_CHARS = 1200;

/** Cu bao nhieu tin cua khach thi duc ket lai ho so mot lan. */
export const DUC_KET_MOI_N_LUOT = 6;

/** Nguyen lieu duc ket: lay rong hon lich su nap vao session. */
const DUC_KET_SO_TIN = 40;
const DUC_KET_MAX_CHARS = 6000;

// Chong hai lan duc ket cung mot khach chay chong len nhau (khach nhan lien tuc).
const dangDucKet = new Set();

/**
 * Ho so nao da duoc nap vao phien nao. Ho so chi can vao MOT LAN cho moi phien:
 * sau do no nam san trong lich su cua phien, nap lai la tra tien hai lan.
 * Mat khi restart -> nap lai dung mot lan nua, vo hai.
 */
const daNapHoSo = new Map(); // sessionId -> Set<uid>
const GIOI_HAN_PHIEN_NHO = 500;

export function quenPhien(sessionId) {
  daNapHoSo.delete(sessionId);
}

export function quenTatCaPhien() {
  daNapHoSo.clear();
}

/**
 * Boc tin cua khach truoc khi bom vao session.
 *  - Lan dau nguoi nay noi trong phien: kem ho so cua ho.
 *  - Trong nhom: gan ten nguoi gui vao dau tin, khong thi agent nhin thay mot
 *    dong tin lien tuc ma khong biet ai dang noi.
 */
export async function bocPrompt(sessionId, messageObj, userMessage) {
  const uid = messageObj?.senderId ? String(messageObj.senderId) : "";
  const ten = messageObj?.senderName || "Khách";
  const laNhom = String(messageObj?.threadType) === "1";

  let dauTrang = "";
  if (uid && sessionId) {
    if (daNapHoSo.size > GIOI_HAN_PHIEN_NHO) daNapHoSo.clear();
    let daNap = daNapHoSo.get(sessionId);
    if (!daNap) {
      daNap = new Set();
      daNapHoSo.set(sessionId, daNap);
    }
    if (!daNap.has(uid)) {
      const hoSo = await getCustomerMemory(uid).catch(() => null);
      // Chi danh dau khi da nap duoc that. Khach chua co ho so thi cu hoi lai
      // moi tin (mot cau truy van co chi muc, rat re) - de ho so vua duoc duc
      // ket giua chung phien duoc dung ngay, khong phai cho den luc xoay phien.
      if (hoSo?.profile?.trim()) {
        daNap.add(uid);
        dauTrang =
          `# HỒ SƠ NGƯỜI ĐANG NHẮN — ${ten}\n` +
          `${hoSo.profile.trim()}\n` +
          `(Đây là ghi chú nội bộ để bạn hiểu ngữ cảnh. KHÔNG đọc lại nguyên văn cho khách, ` +
          `KHÔNG khoe rằng bạn có hồ sơ. Chỉ dùng để trả lời cho nhất quán.)\n\n`;
      }
    }
  }

  return dauTrang + (laNhom ? `${ten}: ${userMessage}` : userMessage);
}

function buildDucKetPrompt({ ten, hoSoCu, lichSu }) {
  return [
    "Bạn đang làm nhiệm vụ GHI CHÉP, không phải tư vấn.",
    "",
    "# HỒ SƠ HIỆN CÓ",
    hoSoCu?.trim() || "(chưa có hồ sơ)",
    "",
    "# ĐOẠN HỘI THOẠI GẦN ĐÂY",
    lichSu,
    "",
    "# YÊU CẦU",
    `Viết lại hồ sơ của "${ten}" dựa trên hồ sơ cũ cộng với đoạn hội thoại trên.`,
    "- Giữ thông tin cũ vẫn đúng, bổ sung thông tin mới, sửa lại thông tin đã thay đổi.",
    "- CHỈ ghi những gì khách đã thật sự nói. Tuyệt đối không suy diễn, không phỏng đoán, không bịa.",
    `- Tối đa ${HO_SO_MAX_CHARS} ký tự.`,
    '- Viết đúng khung dưới đây. Mục nào chưa biết thì ghi "chưa rõ".',
    "",
    "Xưng hô:",
    "Hoàn cảnh:",
    "Vấn đề đang gặp:",
    "Đã tư vấn / đã hứa:",
    "Trạng thái:",
    "Cần tránh:",
    "",
    "Chỉ xuất ra hồ sơ theo khung trên. Không lời dẫn, không giải thích, không markdown.",
  ].join("\n");
}

/**
 * Duc ket ho so mot khach. Chay bang session dung-mot-lan roi xoa: nhet chung
 * vao phien dang noi chuyen voi khach thi cau lenh ghi chep nay se lot vao
 * lich su va anh huong den cac cau tra loi sau.
 */
export async function ducKetHoSo(config, { uid, ten, threadId }) {
  const lichSu = await buildRecentHistory(threadId, null, {
    soTin: DUC_KET_SO_TIN,
    maxChars: DUC_KET_MAX_CHARS,
  });
  if (!lichSu) return null;

  const cu = await getCustomerMemory(uid);
  const prompt = buildDucKetPrompt({ ten, hoSoCu: cu?.profile || "", lichSu });

  const ketQua = await opencode.runOneShot(config, `Hồ sơ - ${ten}`, prompt);
  const hoSoMoi = String(ketQua.text || "").trim().slice(0, HO_SO_MAX_CHARS);
  if (!hoSoMoi) return null;

  await saveCustomerMemory({ uid, displayName: ten, profile: hoSoMoi });
  await resetCustomerTurns(uid);

  await addLog({
    event: "customer_memory",
    level: "ok",
    summary: `Đã cập nhật hồ sơ khách "${ten}" (${hoSoMoi.length} ký tự)`,
    detail: { uid, ten, threadId, hoSo: hoSoMoi, tokens: ketQua.tokens },
  });

  return hoSoMoi;
}

/**
 * Goi sau MOI lan bot tra loi. Tang bo dem, den nguong thi duc ket lai ho so.
 * Nem loi ra ngoai la khong duoc: khach da nhan duoc cau tra loi roi, hong
 * viec ghi chep khong duoc lam hong luong tra loi.
 */
export async function ducKetNeuDenLuot(config, messageObj) {
  const uid = messageObj?.senderId ? String(messageObj.senderId) : "";
  if (!uid || messageObj?.isSelf) return null;
  const ten = messageObj?.senderName || "Khách";

  try {
    const soLuot = await bumpCustomerTurns(uid, ten);
    if (soLuot < DUC_KET_MOI_N_LUOT) return null;
    if (dangDucKet.has(uid)) return null;

    // Chi da sua tay va khoa lai -> khong ghi de. Van reset bo dem de khong
    // phai kiem tra lai sau moi tin.
    const cu = await getCustomerMemory(uid);
    if (cu?.locked) {
      await resetCustomerTurns(uid);
      return null;
    }

    dangDucKet.add(uid);
    try {
      return await ducKetHoSo(config, { uid, ten, threadId: messageObj.threadId });
    } finally {
      dangDucKet.delete(uid);
    }
  } catch (error) {
    console.warn("[ho-so] Duc ket that bai:", error.message);
    await addLog({
      event: "customer_memory",
      level: "error",
      summary: `Không cập nhật được hồ sơ khách "${ten}" — ${error.message}`,
      detail: { uid, ten, error: error.message },
    }).catch(() => {});
    return null;
  }
}
