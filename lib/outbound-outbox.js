import {
  claimNextOutboundIntent,
  claimOutboundIntent,
  ensureOutboundIntents,
  listOutbox,
  markOutboundFailure,
  markOutboundSent,
  MAX_CREDENTIAL_CONTROL_ATTEMPTS,
  MAX_DEFAULT_DELIVERY_ATTEMPTS,
  recoverExpiredOutboundIntents,
  releaseOutboundIntent,
  settleDurableGeneration,
} from "./db.js";
import {
  classifyProviderFailure,
  FAILURE_CODES,
  isCredentialControlFailure,
  isFailoverEligible,
} from "./provider-failure.js";

const OUTBOX_LEASE_MS = 120_000;
const OUTBOX_RECHECK_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

let runtime = {
  layAuthority: null,
  gui: null,
  thongBaoAdmin: null,
};

export function capHinhOutboundOutbox(next = {}) {
  runtime = { ...runtime, ...next };
}

function retryAt(attemptCount, now = Date.now()) {
  const exponent = Math.max(0, Math.min(Number(attemptCount) || 0, 6));
  return now + Math.min(5_000 * (2 ** exponent), MAX_BACKOFF_MS);
}

async function durableRow(id, generationKey) {
  const rows = await listOutbox({ generationKey });
  return rows.find((row) => row.id === id) || null;
}

function sentStateConflict(outbox, current) {
  const error = new Error("Provider da gui thanh cong nhung durable SENT transition bi conflict.");
  error.code = "OUTBOX_SENT_STATE_CONFLICT";
  error.outboxId = outbox.id;
  error.durableStatus = current?.status || null;
  return error;
}

async function releaseWithoutProvider(claimed, errorCode) {
  await releaseOutboundIntent(claimed.id, {
    errorCode,
    nextAttemptAt: Date.now() + OUTBOX_RECHECK_MS,
  });
}

async function notifyTerminalPolicy(event) {
  if (!event) return;
  await runtime.thongBaoAdmin?.({
    ownerUid: event.accountId,
    threadId: event.conversationId,
    outcome: event.terminalStatus,
    terminalPolicy: true,
    generationKey: event.generationKey,
    errorCode: event.errorCode,
  }).catch(() => {});
}

async function recordPhysicalDelivery(claimed, providerResult, nextAttemptDelayMs) {
  const providerMessageId = providerResult?.id ?? null;
  const marked = await markOutboundSent(claimed.id, providerMessageId, Date.now(), {
    generationKey: claimed.generationKey,
    nextAttemptDelayMs,
  });
  if (!marked) {
    const current = await durableRow(claimed.id, claimed.generationKey);
    if (current?.status !== "SENT") throw sentStateConflict(claimed, current);
  }
}

async function ghiNhanThatBai(outbox, error) {
  const code = classifyProviderFailure(error);
  const transient = isFailoverEligible(code);
  const effectiveCap = isCredentialControlFailure(code)
    ? MAX_CREDENTIAL_CONTROL_ATTEMPTS
    : MAX_DEFAULT_DELIVERY_ATTEMPTS;
  const result = await markOutboundFailure(outbox.id, {
    status: transient ? "RETRY" : "BLOCKED",
    errorCode: code,
    nextAttemptAt: transient ? retryAt(outbox.attemptCount) : Date.now() + 30_000,
    effectiveCap,
  });
  if (!transient && result.enteredBlocked && result.attemptCount === 1) {
    await runtime.thongBaoAdmin?.({
      ownerUid: outbox.accountId,
      threadId: outbox.conversationId,
      failedBubbleIndex: outbox.outboundSlot + 1,
      outcome: isCredentialControlFailure(code) ? code : `OUTBOX_${code}`,
    }).catch(() => {});
  }
  if (result.terminalized) await notifyTerminalPolicy(result.terminalEvent);
  return code;
}

/** Persist every required intent before the first provider call. */
export async function chuanBiDurableOutbox(conversationGeneration, intents) {
  const generationKey = conversationGeneration?.durableGenerationKey;
  if (!generationKey) return [];
  const rows = await ensureOutboundIntents({
    generationKey,
    accountId: conversationGeneration.ownerUid,
    conversationId: conversationGeneration.threadId,
    intents,
  });
  conversationGeneration.durableOutboxPrepared = true;
  return rows;
}

/** The callback must be the existing P0 send/reaction path, never a provider clone. */
export async function guiDurableOutbound({ outbox, conversationGeneration, send, nextAttemptDelayMs = 0 }) {
  if (!outbox) return send?.();
  if (typeof send !== "function") {
    const error = new Error("Durable outbox khong co send implementation.");
    error.code = "OUTBOX_SENDER_UNAVAILABLE";
    throw error;
  }
  if (outbox.status === "SENT") {
    conversationGeneration?.xacNhanOutbound?.();
    return outbox.providerMessageId ? { id: outbox.providerMessageId, durableReplay: true } : null;
  }
  let claimed = outbox;
  if (claimed.status === "SENDING" && claimed.__claimedHere !== true) {
    const error = new Error("Durable outbox intent dang co active lease.");
    error.code = "OUTBOX_LEASE_BUSY";
    throw error;
  }
  if (claimed.status !== "SENDING") {
    claimed = await claimOutboundIntent(outbox.id, { leaseMs: OUTBOX_LEASE_MS });
    if (!claimed) {
      const error = new Error("Durable outbox intent dang co active lease.");
      error.code = "OUTBOX_LEASE_BUSY";
      throw error;
    }
    claimed.__claimedHere = true;
  }
  let providerSucceededThisAttempt = false;
  let providerResultThisAttempt = null;
  const onProviderSuccess = (providerResult) => {
    providerSucceededThisAttempt = true;
    providerResultThisAttempt = providerResult || null;
  };
  try {
    const sent = await send({ onProviderSuccess });
    if (sent?.authorityRejectedBeforeProvider === true) {
      providerSucceededThisAttempt = false;
      providerResultThisAttempt = null;
      await releaseWithoutProvider(claimed, "AUTHORITY_REJECTED_BEFORE_PROVIDER");
      return sent;
    }
    if (!providerSucceededThisAttempt) {
      await releaseWithoutProvider(claimed, "PROVIDER_SUCCESS_SIGNAL_MISSING");
      const error = new Error("Send ket thuc ma khong co physical provider-success signal.");
      error.code = "OUTBOX_PROVIDER_SUCCESS_UNCONFIRMED";
      error.outboxClaimReleased = true;
      throw error;
    }
    await recordPhysicalDelivery(claimed, providerResultThisAttempt, nextAttemptDelayMs);
    return sent;
  } catch (error) {
    if (providerSucceededThisAttempt) {
      try {
        await recordPhysicalDelivery(claimed, providerResultThisAttempt, nextAttemptDelayMs);
        error.providerSucceeded = true;
        error.outboxDeliveryRecorded = true;
      } catch (recordError) {
        const current = await durableRow(claimed.id, claimed.generationKey).catch(() => null);
        recordError.providerSucceeded = true;
        recordError.outboxDeliveryRecorded = current?.status === "SENT";
        throw recordError;
      }
      throw error;
    }
    if (error?.outboxClaimReleased) throw error;
    await ghiNhanThatBai(claimed, error);
    throw error;
  }
}

export async function quetOutboundNgay({ max = 100, now = Date.now() } = {}) {
  const sweepNow = Number(now);
  const recovered = await recoverExpiredOutboundIntents(sweepNow);
  for (const event of recovered?.terminalEvents || []) await notifyTerminalPolicy(event);
  let handled = 0;
  while (handled < max) {
    const outbox = await claimNextOutboundIntent({ now: sweepNow, leaseMs: OUTBOX_LEASE_MS });
    if (!outbox) break;
    handled += 1;
    const authority = await runtime.layAuthority?.({
      accountId: outbox.accountId,
      conversationId: outbox.conversationId,
    });
    if (!authority?.originToken) {
      await releaseWithoutProvider(outbox, FAILURE_CODES.OWNER_CONTEXT_CHANGED);
      continue;
    }
    if (typeof runtime.gui !== "function") {
      await releaseWithoutProvider(outbox, "OUTBOX_SENDER_UNAVAILABLE");
      await runtime.thongBaoAdmin?.({
        ownerUid: outbox.accountId,
        threadId: outbox.conversationId,
        failedBubbleIndex: outbox.outboundSlot + 1,
        outcome: "OUTBOX_SENDER_UNAVAILABLE",
      }).catch(() => {});
      continue;
    }
    try {
      const sent = await guiDurableOutbound({
        outbox: { ...outbox, __claimedHere: true },
        conversationGeneration: null,
        send: (hooks) => runtime.gui(outbox, authority, hooks),
      });
      if (sent?.authorityRejectedBeforeProvider === true) continue;
      await settleDurableGeneration(outbox.generationKey);
    } catch (error) {
      if (error?.outboxDeliveryRecorded) {
        await settleDurableGeneration(outbox.generationKey);
        console.warn("[outbox] Provider thanh cong nhung local post-step loi:", error.message);
        continue;
      }
      if (error?.providerSucceeded) break;
    }
  }
  return handled;
}
