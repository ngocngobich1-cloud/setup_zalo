import { ThreadType } from "zca-js";
import { insertMessage, upsertThread } from "./db.js";
import { normalizeIncomingMessage } from "./message-utils.js";

const historySyncAt = new Map();
let initialSyncDone = false;
let oldMessageBuffer = [];
let oldMessageTimer = null;

export function resetHistorySyncState() {
  historySyncAt.clear();
  initialSyncDone = false;
  oldMessageBuffer = [];
  if (oldMessageTimer) clearTimeout(oldMessageTimer);
  oldMessageTimer = null;
}

/**
 * Dong bo lich su cung phai biet minh dang lam viec cho tai khoan Zalo nao.
 * Khong co chu -> khong ghi gi ca; neu khong lich su cua tai khoan nay se do
 * vao kho chung roi hien ra duoi tai khoan khac.
 */
export async function storeMessagesBatch(ownerUid, messages, fallbackThreadType = 0) {
  if (!ownerUid) return;
  for (const raw of messages || []) {
    const message = normalizeIncomingMessage(raw, fallbackThreadType);
    if (!message.threadId || !message.content) continue;
    await insertMessage(ownerUid, message);
    await upsertThread(ownerUid, {
      id: message.threadId,
      threadType: message.threadType,
      lastMessage: message.content,
      lastMessageAt: message.ts,
    });
  }
}

export function attachOldMessagesListener(api, layChu, onStored) {
  api.listener.on("old_messages", (messages, threadType) => {
    oldMessageBuffer.push({ messages, threadType });
    if (oldMessageTimer) clearTimeout(oldMessageTimer);
    oldMessageTimer = setTimeout(async () => {
      const batch = oldMessageBuffer;
      oldMessageBuffer = [];
      try {
        for (const item of batch) {
          await storeMessagesBatch(layChu(), item.messages, item.threadType);
        }
        await onStored?.();
      } catch (error) {
        console.error("[history] Loi luu old_messages:", error);
      }
    }, 800);
  });
}

export function requestInitialHistorySync(api) {
  if (initialSyncDone) return;
  initialSyncDone = true;
  try {
    api.listener.requestOldMessages(ThreadType.User);
    api.listener.requestOldMessages(ThreadType.Group);
  } catch (error) {
    console.warn("[history] Khong request duoc old messages:", error.message);
  }
}

export async function syncHistoryForThread(api, ownerUid, threadId, threadType) {
  if (!ownerUid) return;
  if (Number(threadType) !== 1 || !api?.getGroupChatHistory) return;
  const last = historySyncAt.get(threadId) || 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  historySyncAt.set(threadId, Date.now());

  try {
    const result = await api.getGroupChatHistory(threadId, 50);
    await storeMessagesBatch(ownerUid, result?.groupMsgs || [], ThreadType.Group);
  } catch (error) {
    console.warn("[history] Khong dong bo duoc lich su nhom:", error.message);
  }
}
