import crypto from "node:crypto";

export const ADMIN_CLARIFICATION_STATUS = Object.freeze({
  ADMIN_NOTIFY_PENDING: "ADMIN_NOTIFY_PENDING",
  ADMIN_NOTIFY_SENDING: "ADMIN_NOTIFY_SENDING",
  WAITING_ADMIN: "WAITING_ADMIN",
  ADMIN_REPLIED: "ADMIN_REPLIED",
  BLOCKED_BY_AUTHORITY: "BLOCKED_BY_AUTHORITY",
  CUSTOMER_REPLY_GENERATING: "CUSTOMER_REPLY_GENERATING",
  CUSTOMER_REPLY_GENERATION_FAILED: "CUSTOMER_REPLY_GENERATION_FAILED",
  CUSTOMER_REPLY_GENERATION_TERMINAL: "CUSTOMER_REPLY_GENERATION_TERMINAL",
  CUSTOMER_REPLY_READY: "CUSTOMER_REPLY_READY",
  CUSTOMER_REPLY_SENDING: "CUSTOMER_REPLY_SENDING",
  SEND_UNKNOWN: "SEND_UNKNOWN",
  CLOSED: "CLOSED",
  EXPIRED: "EXPIRED",
  ADMIN_NOTIFY_FAILED: "ADMIN_NOTIFY_FAILED",
  ADMIN_NOTIFY_UNKNOWN: "ADMIN_NOTIFY_UNKNOWN",
  CANCELLED_BY_AUTHORITY: "CANCELLED_BY_AUTHORITY",
});

export const CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const ADMIN_FAILURE_FALLBACK = "Em chưa có đủ thông tin để trả lời chính xác lúc này. Em đã ghi nhận câu hỏi của anh/chị.";
export const MALFORMED_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_GENERATION_ATTEMPTS = 3;
export const ADMIN_TOKEN_RE = /^(#AC-[A-Z0-9]{6})(?:\s+([\s\S]+))?$/i;

let productionStore = null;

export function configureAdminClarificationStore(store) {
  productionStore = store;
}

let runtime = {
  notifyAdmin: null,
  scheduleResume: null,
  log: null,
};

export function configureAdminClarificationRuntime(next = {}) {
  runtime = { ...runtime, ...next };
}

export function parseAdminClarificationToken(text) {
  const match = String(text || "").trim().match(ADMIN_TOKEN_RE);
  if (!match) return null;
  const answer = String(match[2] || "").trim();
  return { token: match[1].toUpperCase(), answer };
}

function safeMessageMetadata(message) {
  return {
    threadId: message?.threadId == null ? null : String(message.threadId),
    threadType: message?.threadType == null ? null : Number(message.threadType),
    senderId: message?.senderId == null ? null : String(message.senderId),
    messageId: message?.id == null ? null : String(message.id),
  };
}

export function canonicalDecisionResultLog(
  result,
  { clarificationAccepted = false, ownerUid = null, message = null } = {}
) {
  if (result?.malformedDecision) {
    return {
      event: "ai_output_contract_failure",
      level: "error",
      summary: "AI trả về định dạng quyết định không hợp lệ — đã kích hoạt retry an toàn",
      detail: {
        ownerUid,
        sessionId: result.sessionId || null,
        model: result.model || null,
        reason: result.error || "MALFORMED_DECISION_OUTPUT",
        ...safeMessageMetadata(message),
      },
    };
  }
  if (result?.needAdmin && clarificationAccepted) {
    return {
      event: "ai_need_admin",
      level: "info",
      summary: "AI cần Admin xác nhận — clarification đã được tiếp nhận",
      detail: {
        ownerUid,
        sessionId: result.sessionId || null,
        model: result.model || null,
        decision: "NEED_ADMIN",
        ...safeMessageMetadata(message),
      },
    };
  }
  return null;
}

function newToken() {
  return `#AC-${crypto.randomBytes(5).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6).padEnd(6, "0")}`;
}

function messageBoundary(message) {
  const sourceIds = Array.isArray(message?.sourceIds) ? message.sourceIds : [];
  return String(sourceIds[sourceIds.length - 1] ?? message?.id ?? message?.ts ?? "").trim() || null;
}

function adminRequestText(row, message) {
  return [
    `Cần Admin xác nhận cho khách ${row.requesterName || row.requesterUid || row.customerThreadId}.`,
    `Câu hỏi: ${String(message?.content || "").trim() || "(xem hội thoại canonical)"}`,
    `Mã: ${row.correlationToken}`,
    "Trả lời đúng cú pháp:",
    `${row.correlationToken} <câu trả lời dành riêng cho tình huống này>`,
  ].join("\n");
}

export function createAdminClarificationEngine({ store = productionStore, now = () => Date.now() } = {}) {
  if (!store) throw new Error("Admin clarification persistence is not configured.");
  async function open({ ownerUid, message, automaticWork = null }) {
    if (!ownerUid || Number(message?.threadType) !== 0) return { opened: false, reason: "PRIVATE_ONLY" };
    await store.expireWaiting(now(), ownerUid, message.threadId);
    const existing = await store.getWaiting(ownerUid, message.threadId);
    if (existing) return { opened: false, existing: true, row: existing, acknowledgement: null };

    let created;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        created = await store.create({
          ownerUid,
          customerThreadId: message.threadId,
          requesterUid: message.senderId,
          requesterName: message.senderName,
          correlationToken: newToken(),
          openedContextBoundary: messageBoundary(message),
          expiresAt: now() + CLARIFICATION_TTL_MS,
          now: now(),
        });
        break;
      } catch (error) {
        if (!String(error?.message || "").includes("UNIQUE constraint failed")) throw error;
      }
    }
    if (!created?.row) throw new Error("Không tạo được mã Admin Clarification duy nhất.");
    if (!created.created) return { opened: false, existing: true, row: created.row, acknowledgement: null };

    let row = await store.transition(
      created.row.id,
      ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_PENDING,
      ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_SENDING,
      { adminNotificationState: "SENDING" },
      { now: now() }
    );
    if (!row) return { opened: false, reason: "NOTIFY_CAS_LOST", row: created.row };

    try {
      const notification = await runtime.notifyAdmin?.({
        ownerUid,
        text: adminRequestText(row, message),
        automaticWork,
      });
      if (!notification?.sent) throw new Error(notification?.reason || "ADMIN_NOTIFY_NOT_CONFIRMED");
      row = await store.transition(
        row.id,
        ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_SENDING,
        ADMIN_CLARIFICATION_STATUS.WAITING_ADMIN,
        {
          adminNotificationState: "SENT",
          adminNotificationId: notification.message?.id == null ? null : String(notification.message.id),
          customerAckState: "SENDING",
        },
        { now: now() }
      );
      if (!row) return { opened: false, reason: "NOTIFY_CONFIRM_CAS_LOST" };
      return {
        opened: true,
        row,
        acknowledgement: "Em đã chuyển câu hỏi này cho người phụ trách và sẽ chủ động trả lời ngay khi có xác nhận ạ.",
      };
    } catch (error) {
      const failedRow = await store.transition(
        row.id,
        ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_SENDING,
        ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_FAILED,
        { adminNotificationState: "FAILED", errorStage: "ADMIN_NOTIFY", errorDetail: error.message },
        { now: now(), releaseWaitingSlot: true }
      );
      await runtime.log?.("warn", "admin_clarification_notify_failed", { ownerUid, id: row.id, error: error.message });
      if (!failedRow) return { opened: false, reason: "NOTIFY_FAILURE_CAS_LOST", row, acknowledgement: null };
      row = failedRow;
      const previous = await store.getRecentFailedAck(
        ownerUid, row.customerThreadId, row.id, now() - CLARIFICATION_TTL_MS
      );
      if (previous) return { opened: false, reason: "ADMIN_NOTIFY_FAILED", row, acknowledgement: null };
      const sending = await store.transition(
        row.id,
        ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_FAILED,
        ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_FAILED,
        { customerAckState: "SENDING" },
        { now: now() }
      );
      return {
        opened: false,
        reason: "ADMIN_NOTIFY_FAILED",
        row: sending || row,
        acknowledgement: sending ? ADMIN_FAILURE_FALLBACK : null,
        adminClarificationFallback: Boolean(sending),
      };
    }
  }

  async function touch({ ownerUid, message }) {
    if (!ownerUid || Number(message?.threadType) !== 0 || !messageBoundary(message)) return false;
    await store.expireWaiting(now(), ownerUid, message.threadId);
    return store.touchWaiting(ownerUid, message.threadId, messageBoundary(message), now());
  }

  async function handleAdminMessage({ ownerUid, message }) {
    const parsed = parseAdminClarificationToken(message?.content);
    if (!parsed) return { handled: false };
    if (!parsed.answer) return { handled: true, claimed: false, reason: "ANSWER_REQUIRED" };
    await store.expireWaiting(now(), ownerUid, null);
    const claimed = await store.claimAnswer({
      ownerUid,
      correlationToken: parsed.token,
      adminMessageId: message.id,
      adminSenderUid: message.senderId,
      adminAnswer: parsed.answer,
      now: now(),
    });
    if (!claimed) {
      const known = await store.getByToken(ownerUid, parsed.token);
      return { handled: true, claimed: false, reason: known ? "ALREADY_CLAIMED" : "TOKEN_NOT_FOUND" };
    }
    await runtime.scheduleResume?.(claimed.id);
    return { handled: true, claimed: true, row: claimed };
  }

  async function recover({ ownerUid = null, customerThreadId = null } = {}) {
    await store.expireWaiting(now(), ownerUid, customerThreadId);
    const rows = await store.listRecoverable(ownerUid, customerThreadId);
    for (const row of rows) {
      if (row.status === ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_PENDING
        || row.status === ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_SENDING) {
        const wasSending = row.status === ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_SENDING;
        await store.transition(
          row.id,
          row.status,
          wasSending
            ? ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_UNKNOWN
            : ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_FAILED,
          {
            adminNotificationState: wasSending ? "SEND_UNKNOWN" : "FAILED",
            errorStage: "ADMIN_NOTIFY",
            errorDetail: wasSending ? "Recovered after uncertain Admin send boundary" : "Recovered before Admin send",
            closedAt: now(),
          },
          { now: now(), releaseWaitingSlot: true }
        );
        continue;
      }
      if (row.status === ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_SENDING) {
        await store.transition(
          row.id,
          ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_SENDING,
          ADMIN_CLARIFICATION_STATUS.SEND_UNKNOWN,
          { errorStage: "CUSTOMER_SEND", errorDetail: "Recovered after uncertain send boundary" },
          { now: now(), releaseWaitingSlot: true }
        );
        continue;
      }
      await runtime.scheduleResume?.(row.id);
    }
    return rows.length;
  }

  async function resume(id, callbacks) {
    let row = await store.getById(id);
    if (!row) return { resumed: false, reason: "NOT_FOUND" };
    if (row.status === ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_SENDING) {
      await store.transition(
        row.id,
        ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_SENDING,
        ADMIN_CLARIFICATION_STATUS.SEND_UNKNOWN,
        { errorStage: "CUSTOMER_SEND", errorDetail: "Recovered after uncertain send boundary" },
        { now: now() }
      );
      return { resumed: false, reason: "SEND_UNKNOWN" };
    }
    // A READY reply may have been blocked only by a Bot/runtime epoch change.
    // Preserve it and consume no new AI attempt when authority becomes fresh.
    if (row.status === ADMIN_CLARIFICATION_STATUS.BLOCKED_BY_AUTHORITY
      && String(row.customerFinalReplyText || "").trim()) {
      row = await store.transition(
        row.id,
        ADMIN_CLARIFICATION_STATUS.BLOCKED_BY_AUTHORITY,
        ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_READY,
        { errorStage: null, errorDetail: null },
        { now: now() }
      );
      if (!row) return { resumed: false, reason: "READY_RESTORE_CAS_LOST" };
    }
    if (![ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_READY].includes(row.status)) {
      if (!await callbacks.isAuthorityCurrent()) {
        const blocked = await store.transition(
          row.id,
          [
            ADMIN_CLARIFICATION_STATUS.ADMIN_REPLIED,
            ADMIN_CLARIFICATION_STATUS.BLOCKED_BY_AUTHORITY,
            ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_GENERATING,
            ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_GENERATION_FAILED,
          ],
          ADMIN_CLARIFICATION_STATUS.BLOCKED_BY_AUTHORITY,
          { errorStage: "AUTHORITY", errorDetail: "Bot, thread, runtime or coordinator authority is not current" },
          { now: now() }
        );
        return { resumed: false, reason: blocked ? "BLOCKED_BY_AUTHORITY" : "CAS_LOST" };
      }
      row = await store.transition(
        row.id,
        [
          ADMIN_CLARIFICATION_STATUS.ADMIN_REPLIED,
          ADMIN_CLARIFICATION_STATUS.BLOCKED_BY_AUTHORITY,
          ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_GENERATING,
          ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_GENERATION_FAILED,
        ],
        ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_GENERATING,
        { errorStage: null, errorDetail: null },
        { now: now(), incrementGenerationAttempts: true, maxGenerationAttempts: MAX_GENERATION_ATTEMPTS }
      );
      if (!row) return { resumed: false, reason: "GENERATION_CAS_OR_CAP" };
      try {
        const text = String(await callbacks.generate(row) || "").trim();
        if (!text) throw new Error("Final clarification reply is empty");
        row = await store.transition(
          row.id,
          ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_GENERATING,
          ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_READY,
          { customerFinalReplyText: text },
          { now: now() }
        );
        if (!row) return { resumed: false, reason: "READY_CAS_LOST" };
      } catch (error) {
        const latest = await store.getById(row.id);
        const terminal = Number(latest?.generationAttempts || 0) >= MAX_GENERATION_ATTEMPTS;
        await store.transition(
          row.id,
          ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_GENERATING,
          terminal
            ? ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_GENERATION_TERMINAL
            : ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_GENERATION_FAILED,
          { errorStage: "CUSTOMER_GENERATION", errorDetail: error.message, ...(terminal ? { closedAt: now() } : {}) },
          { now: now() }
        );
        return { resumed: false, reason: terminal ? "GENERATION_TERMINAL" : "GENERATION_FAILED" };
      }
    }

    if (!await callbacks.isAuthorityCurrent()) {
      await store.transition(
        row.id,
        ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_READY,
        ADMIN_CLARIFICATION_STATUS.BLOCKED_BY_AUTHORITY,
        { errorStage: "AUTHORITY", errorDetail: "Authority changed before customer send" },
        { now: now() }
      );
      return { resumed: false, reason: "BLOCKED_BY_AUTHORITY" };
    }
    row = await store.transition(
      row.id,
      ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_READY,
      ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_SENDING,
      {},
      { now: now() }
    );
    if (!row) return { resumed: false, reason: "SEND_CAS_LOST" };
    try {
      const sent = await callbacks.send(row);
      if (sent?.authorityRejectedBeforeProvider === true) {
        const blocked = await store.transition(
          row.id,
          ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_SENDING,
          ADMIN_CLARIFICATION_STATUS.BLOCKED_BY_AUTHORITY,
          {
            errorStage: "AUTHORITY",
            errorDetail: "Canonical send authority rejected before provider call",
          },
          { now: now() }
        );
        return {
          resumed: false,
          reason: blocked ? "BLOCKED_BY_AUTHORITY" : "CAS_LOST",
        };
      }
      if (!sent?.id) throw new Error("Customer send outcome is not confirmed");
      const closed = await store.transition(
        row.id,
        ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_SENDING,
        ADMIN_CLARIFICATION_STATUS.CLOSED,
        { customerFinalReplyId: String(sent.id), closedAt: now(), errorStage: null, errorDetail: null },
        { now: now() }
      );
      return { resumed: Boolean(closed), sent: Boolean(closed), row: closed };
    } catch (error) {
      await store.transition(
        row.id,
        ADMIN_CLARIFICATION_STATUS.CUSTOMER_REPLY_SENDING,
        ADMIN_CLARIFICATION_STATUS.SEND_UNKNOWN,
        { errorStage: "CUSTOMER_SEND", errorDetail: error.message },
        { now: now() }
      );
      return { resumed: false, reason: "SEND_UNKNOWN" };
    }
  }

  return { open, touch, handleAdminMessage, recover, resume };
}

const productionEngine = () => createAdminClarificationEngine({ store: productionStore });
export const openAdminClarification = (input) => productionEngine().open(input);
export const touchAdminClarificationContext = (input) => productionEngine().touch(input);
export const handleAdminClarificationMessage = (input) => {
  // Legacy isolated admin-command harnesses do not configure the production
  // store. Non-token commands must retain the old path without touching it.
  if (!parseAdminClarificationToken(input?.message?.content)) return { handled: false };
  return productionEngine().handleAdminMessage(input);
};
export const recoverAdminClarifications = (input) => productionEngine().recover(input);
export const resumeAdminClarification = (id, callbacks) => productionEngine().resume(id, callbacks);

const malformedHealth = new Map();

export function resetMalformedHealthForTests() {
  malformedHealth.clear();
}

export function getMalformedHealth(ownerUid) {
  const state = malformedHealth.get(String(ownerUid));
  return state ? { ...state, outcomes: [...state.outcomes] } : null;
}

export async function recordDecisionProtocolOutcome({ ownerUid, malformed, automaticWork = null, at = Date.now() }) {
  const key = String(ownerUid || "");
  if (!key) return { alerted: false };
  const state = malformedHealth.get(key) || { consecutiveMalformed: 0, outcomes: [], cooldownUntil: 0 };
  state.consecutiveMalformed = malformed ? state.consecutiveMalformed + 1 : 0;
  state.outcomes.push(Boolean(malformed));
  if (state.outcomes.length > 20) state.outcomes.splice(0, state.outcomes.length - 20);
  const rollingMalformed = state.outcomes.filter(Boolean).length;
  const threshold = state.consecutiveMalformed >= 5 || rollingMalformed >= 5;
  let alerted = false;
  if (threshold && at >= state.cooldownUntil) {
    const result = await runtime.notifyAdmin?.({
      ownerUid: key,
      text: "Cảnh báo kỹ thuật: định dạng quyết định AI đang lỗi lặp lại. Bot đã chuyển các lượt lỗi sang fallback an toàn thay vì chủ động trả về im lặng.",
      automaticWork,
      technical: true,
    });
    if (result?.sent) {
      state.cooldownUntil = at + MALFORMED_ALERT_COOLDOWN_MS;
      alerted = true;
    }
  }
  malformedHealth.set(key, state);
  return { alerted, consecutiveMalformed: state.consecutiveMalformed, rollingMalformed, cooldownUntil: state.cooldownUntil };
}
