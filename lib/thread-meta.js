import { getThread, listThreads, upsertThread } from "./db.js";
import { enrichMessageSticker } from "./sticker.js";

const metaCache = new Map();
const senderAvatarCache = new Map();
const aliasCache = new Map();
// 1 tieng la qua lau cho mot thu nguoi dung nhin thay: doi ten nhom xong phai
// cho het gio moi thay. 15 phut van du de khong goi API lien tuc.
const META_TTL = 15 * 60 * 1000;

/**
 * @param {object} tuyChon boQuaCache = true khi nguoi dung chu dong bam lam moi;
 *   luc do phai hoi Zalo that chu khong duoc tra lai ban cu trong bo nho.
 */
export async function resolveThreadMeta(api, threadId, threadType, tuyChon = {}) {
  const key = `${threadType}:${threadId}`;
  const cached = metaCache.get(key);
  if (!tuyChon.boQuaCache && cached && Date.now() - cached.at < META_TTL) return cached.value;

  // Tra cuu that bai thi title phai la null: upsertThread dung COALESCE nen null se
  // GIU lai ten cu, con tra ve threadId se ghi de mat ten that cua nhom.
  let value = { title: null, avatar: null };
  try {
    if (Number(threadType) === 1 && api.getGroupInfo) {
      const info = await api.getGroupInfo(threadId);
      const map = info?.gridInfoMap || info?.data?.gridInfoMap || {};
      const group = map[threadId] || info?.groupInfo || info;
      value = {
        title: group?.name || group?.title || null,
        avatar: group?.fullAvt || group?.avt || group?.avatar || null,
      };
    } else if (api.getUserInfo) {
      const info = await api.getUserInfo(threadId);
      const user = Array.isArray(info) ? info[0] : info?.changed_profiles?.[threadId] || info?.[threadId] || info;
      value = {
        title: aliasCache.get(threadId) || user?.displayName || user?.zaloName || user?.name || null,
        avatar: user?.avatar || user?.avatarUrl || null,
      };
    }
  } catch (error) {
    console.warn("[thread-meta] Khong lay duoc metadata:", threadId, error.message);
  }

  // Khong cache that bai, de lan sau con thu lai duoc thay vi ket 1 tieng.
  if (value.title !== null) metaCache.set(key, { at: Date.now(), value });
  return value;
}

export async function resolveSenderAvatar(api, message, thread) {
  try {
    if (message.isSelf) return message.senderAvatar || null;
    if (Number(thread?.threadType) !== 1) return message.senderAvatar || thread?.avatar || null;
    if (!message.senderId) return message.senderAvatar || null;
    if (senderAvatarCache.has(message.senderId)) return senderAvatarCache.get(message.senderId);

    const info = await api.getUserInfo(message.senderId);
    const user = Array.isArray(info) ? info[0] : info?.changed_profiles?.[message.senderId] || info?.[message.senderId] || info;
    const avatar = user?.avatar || user?.avatarUrl || null;
    senderAvatarCache.set(message.senderId, avatar);
    return avatar;
  } catch (error) {
    console.warn("[thread-meta] Khong lay duoc avatar nguoi gui:", error.message);
    return message.senderAvatar || null;
  }
}

export async function enrichMessagesForDisplay(api, messages, thread, myAvatar) {
  const enriched = [];
  for (const message of messages) {
    const senderAvatar = message.isSelf
      ? message.senderAvatar || myAvatar
      : await resolveSenderAvatar(api, message, thread);
    enriched.push(await enrichMessageSticker(api, { ...message, senderAvatar }));
  }
  return enriched;
}

/** @param {boolean} boQuaCache dat true khi nguoi dung bam "Lam moi" */
export async function syncThreadCatalog(api, ownerUid, boQuaCache = false) {
  // Danh muc cuoc tro chuyen thuoc ve MOT tai khoan. Khong co chu thi khong dong bo.
  if (!ownerUid) return;
  try {
    if (api.getAliasList) {
      const aliases = await api.getAliasList();
      const items = Array.isArray(aliases) ? aliases : Object.values(aliases || {});
      for (const item of items) {
        const id = String(item.uid || item.userId || item.id || "");
        if (id && item.alias) aliasCache.set(id, item.alias);
      }
    }
  } catch (error) {
    console.warn("[thread-meta] Khong lay duoc alias:", error.message);
  }

  const existing = await listThreads(ownerUid, { recentOnly: true });
  for (const thread of existing) {
    const meta = await resolveThreadMeta(api, thread.id, thread.threadType, { boQuaCache });
    await upsertThread(ownerUid, { id: thread.id, threadType: thread.threadType, ...meta });
  }
}

export async function enrichExistingThread(api, ownerUid, threadId, threadType, patch = {}) {
  if (!ownerUid) return null;
  const current = await getThread(ownerUid, threadId);
  const meta = await resolveThreadMeta(api, threadId, threadType);
  return upsertThread(ownerUid, {
    id: threadId,
    threadType,
    // Uu tien ten VUA LAY VE. Uu tien ten cu thi doi ten nhom xong app khong bao
    // gio cap nhat nua, vi ten cu luon ton tai.
    title: meta.title || current?.title,
    avatar: meta.avatar || current?.avatar,
    ...patch,
  });
}
