export function normalizeTs(ts, { allowProcessingTimeFallback = true } = {}) {
  const value = Number(ts || (allowProcessingTimeFallback ? Date.now() : 0));
  if (!allowProcessingTimeFallback && (!Number.isFinite(value) || value <= 0)) return 0;
  return value < 1e12 ? value * 1000 : value;
}

/**
 * Tin he thong cua nhom (binh chon, tao poll, them/roi nhom...) den duoi dang
 * { action, params } trong do params la CHUOI JSON chua san mau cau da dich:
 *   msg.vi = "%1$s tham gia cuộc bình chọn: %2$s"
 * Tra ve cau da dien, hoac null neu khong phai dang nay.
 */
export function formatSystemMessage(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.action !== "string" || typeof value.params !== "string") return null;

  let params;
  try {
    params = JSON.parse(value.params);
  } catch {
    return null;
  }

  const template = params?.msg?.vi || params?.msg?.en;
  if (typeof template !== "string" || template.trim() === "") return null;

  // Cac placeholder %1$s, %2$s... lan luot la: nguoi thuc hien, noi dung.
  const slots = [params.dName, params.question ?? params.title];
  const filled = template.replace(/%(\d+)\$s/g, (_match, index) => {
    const slot = slots[Number(index) - 1];
    return typeof slot === "string" && slot.trim() !== "" ? slot.trim() : "";
  });

  const text = filled.replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

export const MAX_BUBBLES = 5;
/**
 * Nhan "Bubble 1:", "Tin nhắn 2 -", "Đoạn 3:" ma LLM hay bat chuoc tu vi du trong Soul.
 * Phai liet ke ca bien the dau tieng Viet: "nhắn" va "nhăn" la hai ky tu khac nhau.
 */
const NHAN_BUBBLE = /^\s*(?:bubble|tin\s*nh[ắăa]n|tin|đo[ạaă]n|doan)\s*\d+\s*[:.\-–)]\s*/i;

/**
 * Tach cau tra loi cua AI thanh nhieu bubble de gui thanh nhieu tin Zalo rieng.
 * Uu tien tach theo dong trong; neu khong co thi tach theo tung dong.
 * Luon tra ve it nhat mot phan tu khi co noi dung.
 */
export function splitIntoBubbles(text) {
  const raw = String(text || "").trim();
  if (raw === "") return [];

  let phan = raw.split(/\n\s*\n+/);
  if (phan.length === 1) phan = raw.split(/\n+/);

  const bubbles = [];
  for (const item of phan) {
    // LLM hay chep lai nhan "Bubble 1:" tu vi du trong Soul; khach khong duoc thay cai do.
    const noiDung = item.replace(NHAN_BUBBLE, "").trim();
    if (noiDung === "") continue;

    // Manh qua ngan (dau cau lac, mot ky tu) thi nhap vao bubble truoc cho khoi lo cho.
    if (noiDung.length < 3 && bubbles.length > 0) {
      bubbles[bubbles.length - 1] += " " + noiDung;
      continue;
    }
    bubbles.push(noiDung);
  }

  if (bubbles.length === 0) return [raw];
  // Vuot qua han thi don phan du vao bubble cuoi, khong cat mat noi dung.
  if (bubbles.length > MAX_BUBBLES) {
    const du = bubbles.splice(MAX_BUBBLES - 1);
    bubbles.push(du.join("\n"));
  }
  return bubbles;
}

export function extractMessageText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const systemText = formatSystemMessage(value);
  if (systemText) return systemText;

  return (
    value.title ||
    value.description ||
    value.content ||
    value.href ||
    value.text ||
    JSON.stringify(value)
  );
}

export function normalizeIncomingMessage(message, fallbackThreadType = 0, timestampOptions) {
  const data = message?.data || {};
  const threadId = String(message?.threadId || data.idTo || data.uidFrom || "");
  const content = extractMessageText(message?.data?.content ?? message?.content ?? data.msg);
  const id = String(data.msgId || data.cliMsgId || message?.msgId || message?.id || `${threadId}-${Date.now()}`);
  return {
    id,
    threadId,
    threadType: Number(message?.type ?? message?.threadType ?? fallbackThreadType ?? 0),
    content,
    isSelf: Boolean(message?.isSelf),
    senderId: data.uidFrom ? String(data.uidFrom) : null,
    senderName: data.dName || message?.senderName || null,
    senderAvatar: null,
    msgType: data.msgType || message?.type || null,
    ts: normalizeTs(data.ts || message?.ts, timestampOptions),
    rawJson: message,
  };
}
