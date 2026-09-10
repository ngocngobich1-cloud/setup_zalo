import { ThreadType } from "zca-js";
import { insertMessage, upsertThread } from "./db.js";
import { normalizeIncomingMessage } from "./message-utils.js";

const historySyncAt = new Map();
export const HISTORY_SYNC_TTL_MS = 5 * 60 * 1000;
export const HISTORY_SYNC_FAILURE_BACKOFF_MS = 30 * 1000;
const historySyncInFlight = new Map();
const historySyncRetryAt = new Map();
let historyGeneration = 0;
const historyKey = (ownerUid, threadId) => JSON.stringify([String(ownerUid), String(threadId)]);
const HISTORICAL_TIMESTAMP_OPTIONS = { allowProcessingTimeFallback: false };
let initialSyncDone = false;
let oldMessageBuffer = [];
let oldMessageTimer = null;

export function resetHistorySyncState() {
  historySyncAt.clear();
  historySyncInFlight.clear();
  historySyncRetryAt.clear();
  historyGeneration += 1;
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
export async function storeMessagesBatch(ownerUid, messages, fallbackThreadType = 0, isCurrent = () => true) {
  if (!ownerUid) return;
  let changedCount = 0;
  for (const raw of messages || []) {
    const message = normalizeIncomingMessage(
      raw,
      fallbackThreadType,
      HISTORICAL_TIMESTAMP_OPTIONS
    );
    if (!message.threadId || !message.content) continue;
    if (!isCurrent()) return changedCount;
    const result = await insertMessage(ownerUid, message);
    changedCount += Number(result?.changes || 0);
    if (!isCurrent()) return changedCount;
    await upsertThread(ownerUid, {
      id: message.threadId,
      threadType: message.threadType,
      lastMessage: message.content,
      lastMessageAt: message.ts,
    });
  }
  return changedCount;
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

function supportsGroupHistory(api, ownerUid, threadType) {
  return Boolean(ownerUid) && Number(threadType) === 1 && typeof api?.getGroupChatHistory === "function";
}

export function getGroupHistorySyncStatus(api, ownerUid, threadId, threadType) {
  if (!supportsGroupHistory(api, ownerUid, threadType)) {
    return { inFlight: false, retryAfterMs: 0 };
  }
  const key = historyKey(ownerUid, threadId);
  return {
    inFlight: historySyncInFlight.has(key),
    retryAfterMs: Math.max(0, (historySyncRetryAt.get(key) || 0) - Date.now()),
  };
}

export function shouldSyncGroupHistory(api, ownerUid, threadId, threadType) {
  if (!supportsGroupHistory(api, ownerUid, threadType)) return false;
  const status = getGroupHistorySyncStatus(api, ownerUid, threadId, threadType);
  const last = historySyncAt.get(historyKey(ownerUid, threadId));
  return !status.inFlight && status.retryAfterMs === 0
    && (last === undefined || Date.now() - last >= HISTORY_SYNC_TTL_MS);
}

export async function syncHistoryForThread(api, ownerUid, threadId, threadType, options = {}) {
  if (!shouldSyncGroupHistory(api, ownerUid, threadId, threadType)) return;
  const key = historyKey(ownerUid, threadId);
  const generation = historyGeneration;
  const attempt = {};
  const isCurrent = () => generation === historyGeneration && (options.isCurrent?.() ?? true);
  if (!isCurrent()) return;
  historySyncAt.set(key, Date.now());
  historySyncInFlight.set(key, attempt);
  let terminal;
  try {
    // Reserve the attempt synchronously; provider work starts after the local response yields.
    await new Promise((resolve) => setImmediate(resolve));
    if (!isCurrent()) return;
    const result = await api.getGroupChatHistory(threadId, 50);
    if (!isCurrent()) return;
    const changedCount = await storeMessagesBatch(ownerUid, result?.groupMsgs || [], ThreadType.Group, isCurrent);
    if (!isCurrent()) return;
    historySyncAt.set(key, Date.now());
    historySyncRetryAt.delete(key);
    terminal = { ownerUid, threadId, reason: "sync_complete", changedCount };
  } catch {
    if (!isCurrent()) return;
    const now = Date.now();
    historySyncAt.set(key, now - HISTORY_SYNC_TTL_MS + HISTORY_SYNC_FAILURE_BACKOFF_MS);
    historySyncRetryAt.set(key, now + HISTORY_SYNC_FAILURE_BACKOFF_MS);
    terminal = { ownerUid, threadId, reason: "sync_failed", retryAfterMs: HISTORY_SYNC_FAILURE_BACKOFF_MS };
  } finally {
    if (historySyncInFlight.get(key) === attempt) historySyncInFlight.delete(key);
  }
  if (terminal && isCurrent()) options.onTerminal?.(terminal);
}
