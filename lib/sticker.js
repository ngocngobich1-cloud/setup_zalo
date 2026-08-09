const stickerUrlCache = new Map();

/**
 * Tin sticker cua Zalo co content la object {id, catId, type} nen sau khi qua
 * extractMessageText no bi bien thanh chuoi JSON. Ham nay lay lai sticker id tu chuoi do.
 */
export function stickerIdFromMessage(message) {
  if (!String(message?.msgType || "").includes("sticker")) return null;
  const raw = message?.content;
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return null;
  try {
    const id = Number(JSON.parse(raw)?.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function resolveStickerUrl(api, stickerId) {
  if (stickerUrlCache.has(stickerId)) return stickerUrlCache.get(stickerId);
  if (!api?.getStickersDetail) return null;

  try {
    const details = await api.getStickersDetail(stickerId);
    const detail = Array.isArray(details) ? details[0] : details;
    const url = detail?.stickerWebpUrl || detail?.stickerUrl || null;
    if (url) stickerUrlCache.set(stickerId, url);
    return url;
  } catch (error) {
    // Khong cache that bai de lan sau con thu lai duoc.
    console.warn("[sticker] Khong lay duoc sticker:", stickerId, error.message);
    return null;
  }
}

/** Gan them stickerUrl cho tin sticker; tin thuong duoc tra ve nguyen ven. */
export async function enrichMessageSticker(api, message) {
  const stickerId = stickerIdFromMessage(message);
  if (stickerId === null) return message;
  return {
    ...message,
    isSticker: true,
    stickerUrl: await resolveStickerUrl(api, stickerId),
  };
}
