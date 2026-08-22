import { getThreadMessages } from "./db.js";
import { nhanThoiGian, moTaKhoangNghi } from "./moc-gio.js";

// Lich su nap vao session MOI. So tin va tran ky tu deu co han vi khoi nay
// duoc tra tien lai moi lan session bi tao lai.
export const LICH_SU_SO_TIN = 15;
export const LICH_SU_MAX_CHARS = 3000;
const LICH_SU_MAX_MOI_TIN = 280;

/** Bo sticker/anh (con nguyen cuc JSON trong DB) va cat tin qua dai. */
function lamSachNoiDung(raw, tranMoiTin) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("{") || s.startsWith("[")) return "";
  return s.length > tranMoiTin ? s.slice(0, tranMoiTin) + "…" : s;
}

/**
 * Doc lai vai tin gan nhat tu SQLite, dung lam ngu canh cho session vua tao
 * va lam nguyen lieu cho viec duc ket ho so khach.
 *
 * Session OpenCode la thu de mat nhat trong he thong: doi Soul la xoa sach,
 * OpenCode restart la 404, phien dai qua thi bi xoay. SQLite thi khong mat.
 * Nho khoi nay, mot session moi khong bao gio bat dau tu con so 0.
 *
 * boQuaMessageId: tin dang duoc tra loi. No da nam trong DB truoc khi tryReply
 * chay (zalo-service goi persistAndBroadcastMessage truoc), va se duoc bom vao
 * ngay sau bootstrap - nap o day nua thi agent nhin thay trung hai lan.
 */
export async function buildRecentHistory(threadId, boQuaMessageId, tuyChon = {}) {
  if (!threadId) return "";

  const soTin = tuyChon.soTin || LICH_SU_SO_TIN;
  const maxChars = tuyChon.maxChars || LICH_SU_MAX_CHARS;
  const tranMoiTin = tuyChon.tranMoiTin || LICH_SU_MAX_MOI_TIN;

  let rows;
  try {
    rows = await getThreadMessages(threadId, soTin + 10);
  } catch (error) {
    console.warn("[ngu-canh] Khong doc duoc lich su:", error.message);
    return "";
  }

  const bayGio = tuyChon.bayGio || new Date();
  const chon = [];
  let tong = 0;
  // Duyet tu MOI NHAT ve cu, de khi cham tran thi cai bi bo lai la tin cu nhat.
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    if (boQuaMessageId && String(m.id) === String(boQuaMessageId)) continue;
    const noiDung = lamSachNoiDung(m.content, tranMoiTin);
    if (!noiDung) continue;

    const nhan = nhanThoiGian(m.ts, bayGio);
    const ai = m.isSelf ? "Bạn (đã trả lời)" : m.senderName || "Khách";
    const cau = nhan ? `[${nhan}] ${ai}: ${noiDung}` : `${ai}: ${noiDung}`;
    if (tong + cau.length > maxChars) break;
    tong += cau.length;
    chon.push({ ts: m.ts, cau });
    if (chon.length >= soTin) break;
  }

  chon.reverse(); // cu o tren, moi o duoi

  // Danh dau nhung khoang nghi dai. Khong co vach nay thi "chi di ngu day" luc
  // 23h va cau chao luc 9h sang hom sau nam sat nhau, bot tuong chi chua ngu.
  const dong = [];
  for (const [i, muc] of chon.entries()) {
    const nghi = i > 0 ? moTaKhoangNghi(chon[i - 1].ts, muc.ts) : null;
    if (nghi) dong.push(nghi);
    dong.push(muc.cau);
  }

  return dong.join("\n");
}
