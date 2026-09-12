import { createHash } from "node:crypto";
import {
  admitDurableMessageJob,
  assignDurableGeneration,
  claimDurableMessageJob,
  claimNextDurableMessageJobs,
  expireDurableWork,
  getDurableJobMessage,
  getDurableMessageJob,
  markDurableGenerationFailure,
  markDurableJobsBlocked,
  recoverExpiredDurableJobs,
  requeueStaleDurableGeneration,
  settleDurableGeneration,
} from "./db.js";
import { classifyProviderFailure, isFailoverEligible } from "./provider-failure.js";
import { capHinhOutboundOutbox, quetOutboundNgay } from "./outbound-outbox.js";

const DISPATCH_INTERVAL_MS = 30_000;
const INBOUND_LEASE_MS = 90_000;
let timer = null;
let sweeping = null;
let runtime = {
  enqueue: null,
  layAuthority: null,
  gui: null,
  thongBaoAdmin: null,
};

function durableIds(tins) {
  return [...new Set((tins || []).map((tin) => Number(tin?.__durableJobId)).filter(Number.isInteger))];
}

export function capHinhDurableDispatcher(next = {}) {
  runtime = { ...runtime, ...next };
  capHinhOutboundOutbox({
    layAuthority: runtime.layAuthority,
    gui: runtime.gui,
    thongBaoAdmin: runtime.thongBaoAdmin,
  });
}

/** Called only after global + per-thread admission gates have accepted the message. */
export async function ghiNhanDurableAdmission({ accountId, message }) {
  const row = await admitDurableMessageJob({
    accountId,
    conversationId: message?.threadId,
    sourceMessageId: message?.id,
    admittedAt: Date.now(),
  });
  if (!row?.created) return null;
  const claimed = await claimDurableMessageJob(row.id, { leaseMs: INBOUND_LEASE_MS });
  if (!claimed) return null;
  return {
    ...message,
    __durableJobId: claimed.id,
    __durableAdmittedAt: claimed.admittedAt,
  };
}

export async function ganDurableGenerationChoWork(work, generation) {
  const ids = durableIds(work?.tins);
  if (!ids.length) return null;
  const mutableStatuses = new Set(["PENDING", "PROCESSING", "BLOCKED", "RETRY", "WAITING_OUTBOX"]);
  const members = [];
  for (const id of ids) {
    const row = await getDurableMessageJob(id);
    if (row && mutableStatuses.has(row.status)) members.push(row);
  }
  if (!members.length) return null;
  const identity = JSON.stringify([
    String(work.ownerUid),
    String(work.threadId),
    members.map((row) => [row.id, row.attemptCount]),
  ]);
  const generationKey = `g1:${createHash("sha256").update(identity).digest("hex")}`;
  await assignDurableGeneration(members.map((row) => row.id), generationKey);
  generation.durableGenerationKey = generationKey;
  generation.durableJobIds = members.map((row) => row.id);
  return generationKey;
}

export async function requeueDurableStaleGeneration(_work, generation) {
  if (!generation?.durableGenerationKey) return 0;
  const result = await requeueStaleDurableGeneration(generation.durableGenerationKey);
  return result.requeued;
}

export async function hoanTatDurableGeneration(_work, generation, runnerError = null) {
  const generationKey = generation?.durableGenerationKey;
  if (!generationKey || generation.stale) return false;
  if (generation.cancelled && !generation.durableOutboxPrepared) {
    await markDurableJobsBlocked(generation.durableJobIds || [], "AUTHORITY_CANCELLED");
    return false;
  }
  const error = runnerError || generation.durableFailure || null;
  if (error && !generation.durableOutboxPrepared) {
    const code = classifyProviderFailure(error);
    const transient = isFailoverEligible(code);
    await markDurableGenerationFailure(generationKey, {
      status: transient ? "RETRY" : "BLOCKED",
      errorCode: code,
      nextAttemptAt: transient ? Date.now() + 5_000 : Date.now() + 30_000,
    });
    return false;
  }
  return settleDurableGeneration(generationKey, {
    allowNoOutbound: !generation.durableOutboxPrepared && !error,
  });
}

export async function blockDurableCoordinatorWork(work, reason = "AUTHORITY_UNAVAILABLE") {
  if (Array.isArray(work)) return markDurableJobsBlocked(durableIds(work), reason);
  const activeReserved = work?.activeGeneration?.outboundReserved === true;
  const ids = [
    ...durableIds(work?.pendingTins),
    ...(activeReserved ? [] : durableIds(work?.activeTins)),
  ];
  return markDurableJobsBlocked(ids, reason);
}

async function resumeClaimedJobs(jobs) {
  if (!jobs.length) return 0;
  const authority = await runtime.layAuthority?.({
    accountId: jobs[0].accountId,
    conversationId: jobs[0].conversationId,
  });
  if (!authority?.originToken || !authority?.automaticWork) {
    await markDurableJobsBlocked(jobs.map((job) => job.id), "AUTHORITY_UNAVAILABLE");
    return 0;
  }
  let resumed = 0;
  for (const job of jobs) {
    const message = await getDurableJobMessage(job.id);
    if (!message) {
      await markDurableJobsBlocked([job.id], "SOURCE_MESSAGE_MISSING");
      continue;
    }
    await runtime.enqueue?.({
      message: {
        ...message,
        __durableJobId: job.id,
        __durableAdmittedAt: job.admittedAt,
      },
      automaticWork: authority.automaticWork,
    });
    resumed += 1;
  }
  return resumed;
}

async function notifyTerminalEvents(events) {
  for (const event of events || []) {
    await runtime.thongBaoAdmin?.({
      ownerUid: event.accountId,
      threadId: event.conversationId,
      outcome: event.terminalStatus,
      terminalPolicy: true,
      generationKey: event.generationKey,
      errorCode: event.errorCode,
    }).catch(() => {});
  }
}

async function sweepBody(now) {
  const sweepNow = Number(now);
  const expiry = await expireDurableWork({ now: sweepNow, limit: 100 });
  await notifyTerminalEvents(expiry.terminalEvents);
  await recoverExpiredDurableJobs(sweepNow);
  await quetOutboundNgay({ now: sweepNow });
  let resumed = 0;
  for (let batch = 0; batch < 20; batch += 1) {
    const jobs = await claimNextDurableMessageJobs({ now: sweepNow, leaseMs: INBOUND_LEASE_MS });
    if (!jobs.length) break;
    resumed += await resumeClaimedJobs(jobs);
  }
  return resumed;
}

export function quetDurableNgay({ now = Date.now() } = {}) {
  if (!sweeping) sweeping = sweepBody(now).finally(() => { sweeping = null; });
  return sweeping;
}

export function batDauDurableDispatcher() {
  if (timer) return;
  void quetDurableNgay();
  timer = setInterval(() => { void quetDurableNgay(); }, DISPATCH_INTERVAL_MS);
  timer.unref?.();
}

export function dungDurableDispatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}
