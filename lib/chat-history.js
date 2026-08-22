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

export async function storeMessagesBatch(messages, fallbackThreadType = 0) {
  for (const raw of messages || []) {
    const message = normalizeIncomingMessage(raw, fallbackThreadType);
    if (!message.threadId || !message.content) continue;
    await insertMessage(message);
    await upsertThread({
      id: message.threadId,
      threadType: message.threadType,
      lastMessage: message.content,
      lastMessageAt: message.ts,
    });
  }
}

export function attachOldMessagesListener(api, onStored) {
  api.listener.on("old_messages", (messages, threadType) => {
    oldMessageBuffer.push({ messages, threadType });
    if (oldMessageTimer) clearTimeout(oldMessageTimer);
    oldMessageTimer = setTimeout(async () => {
      const batch = oldMessageBuffer;
      oldMessageBuffer = [];
      try {
        for (const item of batch) {
          await storeMessagesBatch(item.messages, item.threadType);
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

export async function syncHistoryForThread(api, threadId, threadType) {
  if (Number(threadType) !== 1 || !api?.getGroupChatHistory) return;
  const last = historySyncAt.get(threadId) || 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  historySyncAt.set(threadId, Date.now());

  try {
    const result = await api.getGroupChatHistory(threadId, 50);
    await storeMessagesBatch(result?.groupMsgs || [], ThreadType.Group);
  } catch (error) {
    console.warn("[history] Khong dong bo duoc lich su nhom:", error.message);
  }
}
