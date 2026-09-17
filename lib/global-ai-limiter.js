import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_LIMIT = 2;
const context = new AsyncLocalStorage();
const waiters = [];
const waiterByKey = new Map();
const ownerPhases = new Map();
let sequence = 0;
let activeCount = 0;
let logger = null;

function configuredLimit() {
  const raw = process.env.AI_GLOBAL_CONCURRENCY;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.warn(`[ai-limiter] AI_GLOBAL_CONCURRENCY=${JSON.stringify(raw)} không hợp lệ; dùng ${DEFAULT_LIMIT}.`);
  return DEFAULT_LIMIT;
}

const limit = configuredLimit();

export class AiSlotTimeoutError extends Error {
  constructor(message = "AI_SLOT_TIMEOUT") {
    super(message);
    this.name = "AiSlotTimeoutError";
    this.code = "AI_SLOT_TIMEOUT";
  }
}

export function isAiSlotTimeoutError(error) {
  return error?.code === "AI_SLOT_TIMEOUT" || error instanceof AiSlotTimeoutError;
}

export function configureGlobalAiLimiter({ log } = {}) {
  logger = typeof log === "function" ? log : null;
}

function snapshot() {
  return Object.freeze({
    limit,
    activeCount,
    normalWaitingCount: waiters.filter((waiter) => waiter.state === "WAITING").length,
  });
}

export function getGlobalAiLimiterSnapshot() {
  return snapshot();
}

function emit(event, detail = {}) {
  const state = snapshot();
  const payload = {
    event,
    ...detail,
    ...state,
    waitingCount: state.normalWaitingCount,
  };
  try {
    const pending = logger?.(payload);
    Promise.resolve(pending).catch(() => {});
  } catch {
    // Observability must never change admission semantics.
  }
}

function phaseKey(ownerUid, threadId) {
  return `${String(ownerUid)}\u0000${String(threadId)}`;
}

export function updateOwnerAiRuntimePhase({ ownerUid, threadId, phase }) {
  const owner = String(ownerUid || "").trim();
  const thread = String(threadId || "").trim();
  if (!owner || !thread || !["waiting", "generating"].includes(phase)) return null;
  const value = Object.freeze({ ownerUid: owner, threadId: thread, phase, at: Date.now(), ...snapshot() });
  ownerPhases.set(phaseKey(owner, thread), value);
  return value;
}

export function clearOwnerAiRuntimePhase(ownerUid, threadId) {
  return ownerPhases.delete(phaseKey(ownerUid, threadId));
}

export function getOwnerAiRuntimePhases(ownerUid) {
  const owner = String(ownerUid || "").trim();
  if (!owner) return [];
  return [...ownerPhases.values()]
    .filter((entry) => entry.ownerUid === owner)
    .map((entry) => Object.freeze({ ...entry, ...snapshot() }));
}

function compareWaiters(left, right) {
  if (left.orderKey !== right.orderKey) return left.orderKey - right.orderKey;
  return left.sequence - right.sequence;
}

function removeWaiter(waiter) {
  const index = waiters.indexOf(waiter);
  if (index >= 0) waiters.splice(index, 1);
  if (waiter.waiterKey !== null && waiterByKey.get(waiter.waiterKey) === waiter) {
    waiterByKey.delete(waiter.waiterKey);
  }
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.timer = null;
}

function release(waiter) {
  if (waiter.state !== "GRANTED") return false;
  waiter.state = "RELEASED";
  activeCount = Math.max(0, activeCount - 1);
  emit("ai_slot_released", {
    ownerUid: waiter.ownerUid,
    threadId: waiter.threadId,
    slot_wait_ms: waiter.grantedAt - waiter.enqueuedAt,
  });
  drain();
  return true;
}

function grant(waiter) {
  if (waiter.state !== "WAITING") return;
  removeWaiter(waiter);
  waiter.state = "GRANTED";
  waiter.grantedAt = Date.now();
  activeCount += 1;
  emit("ai_slot_acquired", {
    ownerUid: waiter.ownerUid,
    threadId: waiter.threadId,
    slot_wait_ms: waiter.grantedAt - waiter.enqueuedAt,
  });
  try {
    const pending = waiter.onGranted?.({
      waitMs: waiter.grantedAt - waiter.enqueuedAt,
      ...snapshot(),
    });
    Promise.resolve(pending).catch(() => {});
  } catch {
    // Admission remains authoritative even if an observer fails.
  }
  waiter.resolve({
    reentrant: false,
    release: () => release(waiter),
    slotId: waiter.sequence,
  });
}

function drain() {
  waiters.sort(compareWaiters);
  while (activeCount < limit) {
    const next = waiters.find((waiter) => waiter.state === "WAITING");
    if (!next) break;
    grant(next);
  }
}

export function cancelGlobalAiWaiter(waiterKey, reason = "cancelled") {
  if (waiterKey === null || waiterKey === undefined) return false;
  const waiter = waiterByKey.get(waiterKey);
  if (!waiter || waiter.state !== "WAITING") return false;
  waiter.state = "CANCELLED";
  removeWaiter(waiter);
  emit("waiter_cancelled", {
    ownerUid: waiter.ownerUid,
    threadId: waiter.threadId,
    reason,
    slot_wait_ms: Date.now() - waiter.enqueuedAt,
  });
  waiter.reject(Object.assign(new Error("AI_SLOT_CANCELLED"), { code: "AI_SLOT_CANCELLED", reason }));
  drain();
  return true;
}

async function acquireNormalSlot({
  ownerUid = null,
  threadId = null,
  orderKey = Date.now(),
  timeoutMs = null,
  waiterKey = null,
  onWaiting = null,
  onGranted = null,
} = {}) {
  if (context.getStore()?.holdsGlobalAiSlot) {
    return { reentrant: true, release: () => false, slotId: context.getStore().slotId };
  }
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const numericOrder = Number(orderKey);
    const waiter = {
      sequence: ++sequence,
      orderKey: Number.isFinite(numericOrder) ? numericOrder : now,
      enqueuedAt: now,
      grantedAt: null,
      ownerUid: ownerUid == null ? null : String(ownerUid),
      threadId: threadId == null ? null : String(threadId),
      waiterKey,
      onGranted,
      state: "WAITING",
      timer: null,
      resolve,
      reject,
    };
    waiters.push(waiter);
    if (waiterKey !== null && waiterKey !== undefined) waiterByKey.set(waiterKey, waiter);
    emit("ai_slot_wait", { ownerUid: waiter.ownerUid, threadId: waiter.threadId });
    try {
      const pending = onWaiting?.(snapshot());
      Promise.resolve(pending).catch(() => {});
    } catch {
      // UX/diagnostic observers cannot change queue admission.
    }
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      waiter.timer = setTimeout(() => {
        if (waiter.state !== "WAITING") return;
        waiter.state = "CANCELLED";
        removeWaiter(waiter);
        emit("waiter_timeout", {
          ownerUid: waiter.ownerUid,
          threadId: waiter.threadId,
          slot_wait_ms: Date.now() - waiter.enqueuedAt,
        });
        reject(new AiSlotTimeoutError());
        drain();
      }, timeoutMs);
    }
    drain();
  });
}

export async function withGlobalAiSlot(options, operation) {
  if (typeof operation !== "function") throw new TypeError("withGlobalAiSlot requires an operation.");
  const parent = context.getStore();
  if (parent?.holdsGlobalAiSlot) return operation();
  const lease = await acquireNormalSlot(options);
  try {
    return await context.run(
      Object.freeze({ holdsGlobalAiSlot: true, slotId: lease.slotId }),
      operation
    );
  } finally {
    lease.release();
  }
}

export async function runBackgroundAiTask(operation) {
  if (typeof operation !== "function") throw new TypeError("runBackgroundAiTask requires an operation.");
  if (context.getStore()?.holdsGlobalAiSlot) {
    return { ran: true, reentrant: true, value: await operation() };
  }
  const state = snapshot();
  if (state.activeCount !== 0 || state.normalWaitingCount !== 0) {
    return { ran: false, reentrant: false, value: null };
  }
  return withGlobalAiSlot({}, async () => ({ ran: true, reentrant: false, value: await operation() }));
}

export function scheduleDetachedBackgroundTask(operation) {
  if (typeof operation !== "function") {
    throw new TypeError("scheduleDetachedBackgroundTask requires an operation.");
  }

  context.exit(() => {
    setImmediate(() => {
      Promise.resolve()
        .then(operation)
        .catch((error) => {
          console.warn(
            "[ai-limiter] Detached background task failed:",
            error?.message || error
          );
        });
    });
  });
}

// Focused local tests only; production never mutates the process-wide singleton.
export function __resetGlobalAiLimiterForTests() {
  for (const waiter of [...waiters]) {
    if (waiter.state !== "WAITING") continue;
    waiter.state = "CANCELLED";
    removeWaiter(waiter);
    waiter.reject(Object.assign(new Error("AI_SLOT_CANCELLED"), {
      code: "AI_SLOT_CANCELLED",
      reason: "test_reset",
    }));
  }
  waiters.length = 0;
  waiterByKey.clear();
  ownerPhases.clear();
  activeCount = 0;
  sequence = 0;
  logger = null;
}

export const AI_GLOBAL_CONCURRENCY_LIMIT = limit;
