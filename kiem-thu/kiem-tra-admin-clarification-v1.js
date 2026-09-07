import assert from "node:assert/strict";
import fs from "node:fs";
import "./node24-arm64-test-polyfills.js";
import {
  ADMIN_CLARIFICATION_STATUS as S,
  CLARIFICATION_TTL_MS,
  MAX_GENERATION_ATTEMPTS,
  canonicalDecisionResultLog,
  configureAdminClarificationRuntime,
  createAdminClarificationEngine,
  getMalformedHealth,
  parseAdminClarificationToken,
  recordDecisionProtocolOutcome,
  resetMalformedHealthForTests,
} from "../lib/admin-clarification.js";

const aiChatSource = fs.readFileSync(new URL("../lib/ai-chat.js", import.meta.url), "utf8");
const parserSource = aiChatSource.match(/export function parseDecisionReply\(raw\) \{[\s\S]*?\n\}/)?.[0];
if (!parserSource) throw new Error("Không tìm thấy parser trong lib/ai-chat.js");
const parseDecisionReply = Function(
  "SKIP_TOKEN",
  `${parserSource.replace("export function", "function")}; return parseDecisionReply;`
)("SKIP");

class MemoryStore {
  constructor() { this.rows = []; this.nextId = 1; }
  copy(row) { return row ? structuredClone(row) : null; }
  seed(patch = {}) {
    const now = patch.now || 1_000;
    const row = {
      id: this.nextId++, ownerUid: "owner", customerThreadId: `c-${this.nextId}`,
      customerThreadType: 0, requesterUid: "customer", requesterName: "Khách",
      correlationToken: `#AC-${String(this.nextId).padStart(6, "0")}`,
      status: S.ADMIN_REPLIED, waitingSlot: null,
      openedContextBoundary: "m1", latestContextBoundary: "m1", frozenContextBoundary: "m1",
      adminMessageId: "a1", adminSenderUid: "admin", adminAnswer: "đã xác nhận",
      expiresAt: now + CLARIFICATION_TTL_MS, adminNotificationState: "SENT",
      adminNotificationId: "n1", customerAckState: "READY", customerAckId: null,
      customerFinalReplyText: null, customerFinalReplyId: null, generationAttempts: 0,
      errorStage: null, errorDetail: null, createdAt: now, updatedAt: now, closedAt: null,
      ...patch,
    };
    this.rows.push(row); return this.copy(row);
  }
  async create(input) {
    const duplicate = this.rows.find((row) => row.ownerUid === String(input.ownerUid)
      && row.customerThreadId === String(input.customerThreadId) && row.waitingSlot === 1);
    if (duplicate) return { created: false, row: this.copy(duplicate) };
    if (this.rows.some((row) => row.ownerUid === String(input.ownerUid)
      && row.correlationToken === input.correlationToken)) throw new Error("UNIQUE constraint failed");
    const row = this.seed({
      ownerUid: String(input.ownerUid), customerThreadId: String(input.customerThreadId),
      requesterUid: input.requesterUid, requesterName: input.requesterName,
      correlationToken: input.correlationToken, status: S.ADMIN_NOTIFY_PENDING, waitingSlot: 1,
      openedContextBoundary: input.openedContextBoundary,
      latestContextBoundary: input.openedContextBoundary, frozenContextBoundary: null,
      adminMessageId: null, adminSenderUid: null, adminAnswer: null,
      expiresAt: input.expiresAt, adminNotificationState: "PENDING",
      adminNotificationId: null, customerAckState: "PENDING", now: input.now,
    });
    return { created: true, row };
  }
  async getById(id) { return this.copy(this.rows.find((row) => row.id === Number(id))); }
  async getByToken(ownerUid, token) {
    return this.copy(this.rows.find((row) => row.ownerUid === String(ownerUid)
      && row.correlationToken === String(token)));
  }
  async getWaiting(ownerUid, threadId) {
    return this.copy(this.rows.find((row) => row.ownerUid === String(ownerUid)
      && row.customerThreadId === String(threadId) && row.waitingSlot === 1));
  }
  async touchWaiting(ownerUid, threadId, boundary, now) {
    const row = this.rows.find((item) => item.ownerUid === String(ownerUid)
      && item.customerThreadId === String(threadId) && item.status === S.WAITING_ADMIN
      && item.waitingSlot === 1 && item.expiresAt > now);
    if (!row) return false;
    row.latestContextBoundary = String(boundary); row.updatedAt = now; return true;
  }
  async claimAnswer(input) {
    const row = this.rows.find((item) => item.ownerUid === String(input.ownerUid)
      && item.correlationToken === input.correlationToken && item.status === S.WAITING_ADMIN
      && item.waitingSlot === 1 && item.expiresAt > input.now);
    if (!row) return null;
    row.status = S.ADMIN_REPLIED; row.waitingSlot = null;
    row.frozenContextBoundary = row.latestContextBoundary;
    row.adminMessageId = String(input.adminMessageId); row.adminSenderUid = String(input.adminSenderUid);
    row.adminAnswer = input.adminAnswer; row.adminRepliedAt = input.now; row.updatedAt = input.now;
    return this.copy(row);
  }
  async transition(id, expectedStatuses, nextStatus, patch = {}, options = {}) {
    const expected = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
    const row = this.rows.find((item) => item.id === Number(id));
    if (!row || !expected.includes(row.status)) return null;
    if (Number.isInteger(options.maxGenerationAttempts)
      && row.generationAttempts >= options.maxGenerationAttempts) return null;
    row.status = nextStatus; row.updatedAt = options.now || row.updatedAt;
    Object.assign(row, patch);
    if (options.releaseWaitingSlot) row.waitingSlot = null;
    if (options.incrementGenerationAttempts) row.generationAttempts += 1;
    return this.copy(row);
  }
  async expireWaiting(now, ownerUid = null, threadId = null) {
    let count = 0;
    for (const row of this.rows) {
      if (row.status !== S.WAITING_ADMIN || row.waitingSlot !== 1 || row.expiresAt > now) continue;
      if (ownerUid && row.ownerUid !== String(ownerUid)) continue;
      if (threadId && row.customerThreadId !== String(threadId)) continue;
      row.status = S.EXPIRED; row.waitingSlot = null; row.closedAt = now; row.updatedAt = now; count += 1;
    }
    return count;
  }
  async listRecoverable(ownerUid = null, threadId = null) {
    const statuses = new Set([
      S.ADMIN_NOTIFY_PENDING, S.ADMIN_NOTIFY_SENDING,
      S.ADMIN_REPLIED, S.BLOCKED_BY_AUTHORITY, S.CUSTOMER_REPLY_GENERATING,
      S.CUSTOMER_REPLY_GENERATION_FAILED, S.CUSTOMER_REPLY_READY, S.CUSTOMER_REPLY_SENDING,
    ]);
    return this.rows.filter((row) => statuses.has(row.status)
      && (!ownerUid || row.ownerUid === String(ownerUid))
      && (!threadId || row.customerThreadId === String(threadId))).map((row) => this.copy(row));
  }
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function customer(threadId, id = "m1", threadType = 0) {
  return { id, threadId, threadType, senderId: `u-${threadId}`, senderName: threadId };
}
function successfulCallbacks(overrides = {}) {
  return {
    isAuthorityCurrent: async () => true,
    generate: async () => "Câu trả lời cuối",
    send: async () => ({ id: "customer-final-1" }),
    ...overrides,
  };
}

test("T1 ANSWERABLE returns stripped normal body", () => {
  assert.deepEqual(parseDecisionReply("[[VIZEN_DECISION:ANSWERABLE]]\nXin chào"), {
    valid: true, decision: "ANSWERABLE", body: "Xin chào", legacySkip: false,
  });
});

test("T2 NEED_ADMIN persists, notifies with token, then exposes acknowledgement", async () => {
  const store = new MemoryStore(); const notifications = [];
  configureAdminClarificationRuntime({ notifyAdmin: async (item) => {
    notifications.push(item); return { sent: true, message: { id: "admin-notify-1" } };
  } });
  const engine = createAdminClarificationEngine({ store, now: () => 10_000 });
  const opened = await engine.open({ ownerUid: "owner", message: customer("A") });
  assert.equal(opened.opened, true); assert.equal(opened.row.status, S.WAITING_ADMIN);
  assert.match(notifications[0].text, new RegExp(opened.row.correlationToken));
  assert.ok(opened.acknowledgement); assert.equal(opened.row.adminNotificationId, "admin-notify-1");
});

test("T3 OUT_OF_SCOPE does not imply clarification", () => {
  const result = parseDecisionReply("[[VIZEN_DECISION:OUT_OF_SCOPE]]\nMình không hỗ trợ việc này.");
  assert.equal(result.decision, "OUT_OF_SCOPE"); assert.equal(result.body, "Mình không hỗ trợ việc này.");
});

test("T4 Admin correlation claims only matching owner+token among A/B/C", async () => {
  const store = new MemoryStore(); let resumes = 0;
  configureAdminClarificationRuntime({
    notifyAdmin: async () => ({ sent: true, message: { id: "n" } }),
    scheduleResume: async () => { resumes += 1; },
  });
  const engine = createAdminClarificationEngine({ store, now: () => 20_000 });
  const opened = [];
  for (const id of ["A", "B", "C"]) opened.push(await engine.open({ ownerUid: "owner", message: customer(id) }));
  const tokenB = opened[1].row.correlationToken;
  const wrongOwner = await engine.handleAdminMessage({ ownerUid: "other", message: { id: "x", senderId: "admin", content: `${tokenB} sai` } });
  assert.equal(wrongOwner.claimed, false);
  const claimed = await engine.handleAdminMessage({ ownerUid: "owner", message: { id: "a", senderId: "admin", content: `${tokenB} đúng B` } });
  assert.equal(claimed.row.customerThreadId, "B"); assert.equal(resumes, 1);
  assert.equal((await store.getById(opened[0].row.id)).status, S.WAITING_ADMIN);
  assert.equal((await store.getById(opened[2].row.id)).status, S.WAITING_ADMIN);
});

test("T5 duplicate Admin provider message produces one claim/schedule", async () => {
  const store = new MemoryStore(); let schedules = 0;
  configureAdminClarificationRuntime({ notifyAdmin: async () => ({ sent: true, message: { id: "n" } }), scheduleResume: async () => { schedules += 1; } });
  const engine = createAdminClarificationEngine({ store, now: () => 30_000 });
  const opened = await engine.open({ ownerUid: "owner", message: customer("D") });
  const msg = { id: "same-provider-id", senderId: "admin", content: `${opened.row.correlationToken} OK` };
  await engine.handleAdminMessage({ ownerUid: "owner", message: msg });
  await engine.handleAdminMessage({ ownerUid: "owner", message: msg });
  assert.equal(schedules, 1);
});

test("T6 repeated same token after claim cannot create second final send", async () => {
  const store = new MemoryStore(); let schedules = 0;
  configureAdminClarificationRuntime({ notifyAdmin: async () => ({ sent: true, message: { id: "n" } }), scheduleResume: async () => { schedules += 1; } });
  const engine = createAdminClarificationEngine({ store, now: () => 40_000 });
  const opened = await engine.open({ ownerUid: "owner", message: customer("E") });
  await engine.handleAdminMessage({ ownerUid: "owner", message: { id: "a1", senderId: "admin", content: `${opened.row.correlationToken} one` } });
  const repeat = await engine.handleAdminMessage({ ownerUid: "owner", message: { id: "a2", senderId: "admin", content: `${opened.row.correlationToken} two` } });
  assert.equal(repeat.reason, "ALREADY_CLAIMED"); assert.equal(schedules, 1);
});

test("T7 customer additional message coalesces into same pending boundary", async () => {
  const store = new MemoryStore(); configureAdminClarificationRuntime({ notifyAdmin: async () => ({ sent: true, message: { id: "n" } }) });
  const engine = createAdminClarificationEngine({ store, now: () => 50_000 });
  const opened = await engine.open({ ownerUid: "owner", message: customer("F", "m1") });
  assert.equal(await engine.touch({ ownerUid: "owner", message: customer("F", "m2") }), true);
  const again = await engine.open({ ownerUid: "owner", message: customer("F", "m2") });
  assert.equal(again.existing, true); assert.equal(again.row.id, opened.row.id);
  assert.equal((await store.getById(opened.row.id)).latestContextBoundary, "m2");
});

test("T8 claim freezes old boundary and releases slot for new NEED_ADMIN", async () => {
  const store = new MemoryStore(); configureAdminClarificationRuntime({ notifyAdmin: async () => ({ sent: true, message: { id: "n" } }), scheduleResume: async () => {} });
  const engine = createAdminClarificationEngine({ store, now: () => 60_000 });
  const old = await engine.open({ ownerUid: "owner", message: customer("G", "m1") });
  await engine.touch({ ownerUid: "owner", message: customer("G", "m2") });
  await engine.handleAdminMessage({ ownerUid: "owner", message: { id: "a", senderId: "admin", content: `${old.row.correlationToken} answer` } });
  const fresh = await engine.open({ ownerUid: "owner", message: customer("G", "m3") });
  assert.equal(fresh.opened, true); assert.notEqual(fresh.row.id, old.row.id);
  assert.equal((await store.getById(old.row.id)).frozenContextBoundary, "m2");
});

test("T9 global Bot OFF blocks proactive customer send", async () => {
  const store = new MemoryStore(); const row = store.seed(); let sends = 0;
  const engine = createAdminClarificationEngine({ store, now: () => 70_000 });
  const result = await engine.resume(row.id, successfulCallbacks({ isAuthorityCurrent: async () => false, send: async () => { sends += 1; } }));
  assert.equal(result.reason, "BLOCKED_BY_AUTHORITY"); assert.equal(sends, 0);
});

test("T10 thread Bot OFF blocks proactive customer send", async () => {
  const store = new MemoryStore(); const row = store.seed(); let generations = 0;
  const engine = createAdminClarificationEngine({ store, now: () => 80_000 });
  await engine.resume(row.id, successfulCallbacks({ isAuthorityCurrent: async () => false, generate: async () => { generations += 1; } }));
  assert.equal(generations, 0); assert.equal((await store.getById(row.id)).status, S.BLOCKED_BY_AUTHORITY);
});

test("T11 Bot ON recovery resumes without new customer inbound", async () => {
  const store = new MemoryStore(); const row = store.seed(); let on = false; let sends = 0;
  const engine = createAdminClarificationEngine({ store, now: () => 90_000 });
  await engine.resume(row.id, successfulCallbacks({ isAuthorityCurrent: async () => on }));
  on = true;
  const result = await engine.resume(row.id, successfulCallbacks({ isAuthorityCurrent: async () => on, send: async () => ({ id: `sent-${++sends}` }) }));
  assert.equal(result.sent, true); assert.equal(sends, 1);
});

test("T12 runtime replacement uses persisted recovery row", async () => {
  const store = new MemoryStore(); const row = store.seed(); const scheduled = [];
  configureAdminClarificationRuntime({ scheduleResume: async (id) => scheduled.push(id) });
  const replacementEngine = createAdminClarificationEngine({ store, now: () => 100_000 });
  await replacementEngine.recover({ ownerUid: "owner" });
  assert.deepEqual(scheduled, [row.id]);
});

test("T13 crash recovery from GENERATING is not stuck", async () => {
  const store = new MemoryStore(); const row = store.seed({ status: S.CUSTOMER_REPLY_GENERATING, generationAttempts: 1 });
  const engine = createAdminClarificationEngine({ store, now: () => 110_000 });
  const result = await engine.resume(row.id, successfulCallbacks());
  assert.equal(result.sent, true); assert.equal((await store.getById(row.id)).generationAttempts, 2);
});

test("T14 stale/concurrent replay has one READY-to-SENDING winner", async () => {
  const store = new MemoryStore(); const row = store.seed({ status: S.CUSTOMER_REPLY_READY, customerFinalReplyText: "ready" }); let sends = 0;
  const engine = createAdminClarificationEngine({ store, now: () => 120_000 });
  await Promise.all([1, 2].map(() =>
    engine.resume(row.id, successfulCallbacks({ send: async () => ({ id: `s-${++sends}` }) }))
  ));
  assert.equal(sends, 1); assert.equal((await store.getById(row.id)).status, S.CLOSED);
});

test("T15 recovered SENDING becomes SEND_UNKNOWN without resend", async () => {
  const store = new MemoryStore(); const row = store.seed({ status: S.CUSTOMER_REPLY_SENDING, customerFinalReplyText: "x" }); let sends = 0;
  configureAdminClarificationRuntime({ scheduleResume: async () => { sends += 1; } });
  const engine = createAdminClarificationEngine({ store, now: () => 130_000 });
  await engine.recover({ ownerUid: "owner" });
  assert.equal(sends, 0); assert.equal((await store.getById(row.id)).status, S.SEND_UNKNOWN);
});

test("T16 TTL atomically expires and releases waiting slot", async () => {
  const store = new MemoryStore(); const row = store.seed({ status: S.WAITING_ADMIN, waitingSlot: 1, expiresAt: 10 });
  const engine = createAdminClarificationEngine({ store, now: () => 20 });
  await engine.recover({ ownerUid: "owner" });
  const expired = await store.getById(row.id); assert.equal(expired.status, S.EXPIRED); assert.equal(expired.waitingSlot, null);
});

test("T17 generation attempts cap at three real failures", async () => {
  const store = new MemoryStore(); const row = store.seed(); const engine = createAdminClarificationEngine({ store, now: () => 140_000 });
  const callbacks = successfulCallbacks({ generate: async () => { throw new Error("AI fail"); } });
  await engine.resume(row.id, callbacks); await engine.resume(row.id, callbacks); await engine.resume(row.id, callbacks); await engine.resume(row.id, callbacks);
  const ended = await store.getById(row.id); assert.equal(ended.generationAttempts, MAX_GENERATION_ATTEMPTS); assert.equal(ended.status, S.CUSTOMER_REPLY_GENERATION_TERMINAL);
});

test("T18 malformed AI output is strict failure", () => {
  assert.equal(parseDecisionReply("Câu trả lời không token").valid, false);
  assert.equal(parseDecisionReply("x\n[[VIZEN_DECISION:ANSWERABLE]]\ny").valid, false);
  assert.equal(parseDecisionReply("[[VIZEN_DECISION:ANSWERABLE]]").valid, false);
});

test("T19 malformed health alerts by consecutive OR rolling and observes cooldown", async () => {
  resetMalformedHealthForTests(); let alerts = 0;
  configureAdminClarificationRuntime({ notifyAdmin: async () => { alerts += 1; return { sent: true, message: { id: "tech" } }; } });
  for (let i = 0; i < 5; i += 1) await recordDecisionProtocolOutcome({ ownerUid: "health", malformed: true, at: 200_000 + i });
  await recordDecisionProtocolOutcome({ ownerUid: "health", malformed: true, at: 200_100 });
  assert.equal(alerts, 1); assert.equal(getMalformedHealth("health").consecutiveMalformed, 6);
  resetMalformedHealthForTests(); alerts = 0;
  for (let i = 0; i < 9; i += 1) {
    await recordDecisionProtocolOutcome({ ownerUid: "rolling", malformed: i % 2 === 0, at: 300_000 + i });
  }
  assert.equal(alerts, 1); assert.equal(getMalformedHealth("rolling").outcomes.filter(Boolean).length, 5);
});

test("T20 NEED_ADMIN body is parsed for discard and implementation logs WARN", () => {
  const parsed = parseDecisionReply("[[VIZEN_DECISION:NEED_ADMIN]]\nThông tin bịa");
  assert.equal(parsed.body, "Thông tin bịa");
  const source = fs.readFileSync(new URL("../lib/ai-chat.js", import.meta.url), "utf8");
  assert.match(source, /NEED_ADMIN body discarded/); assert.match(source, /ai_decision_body_discarded/);
});

test("T21 OUT_OF_SCOPE empty is valid silent", () => {
  const parsed = parseDecisionReply("[[VIZEN_DECISION:OUT_OF_SCOPE]]"); assert.equal(parsed.valid, true); assert.equal(parsed.body, "");
});

test("T22 legacy SKIP remains silent OUT_OF_SCOPE", () => {
  assert.deepEqual(parseDecisionReply("SKIP anything"), { valid: true, decision: "OUT_OF_SCOPE", body: "", legacySkip: true });
});

test("T23 old session gets per-message decision instruction without rotation", () => {
  const source = fs.readFileSync(new URL("../lib/ai-chat.js", import.meta.url), "utf8");
  assert.match(source, /if \(decisionMode\) \{\s*promptDayDu = `\$\{DECISION_INSTRUCTION\}/);
  assert.doesNotMatch(source.slice(source.indexOf("buildBootstrapContext"), source.indexOf("export function shouldProcessMessage")), /VIZEN_DECISION/);
});

test("T24 primary+secondary+final sendPrompt timeout is 30000 and forwarded", () => {
  const ai = fs.readFileSync(new URL("../lib/ai-chat.js", import.meta.url), "utf8");
  const oc = fs.readFileSync(new URL("../lib/opencode.js", import.meta.url), "utf8");
  assert.equal((ai.match(/timeoutMs: 30000/g) || []).length, 3);
  assert.match(ai, /const DECISION_TIMEOUT_MS = 30000/);
  assert.match(oc, /\.\.\.\(options\.timeoutMs \? \{ timeoutMs: options\.timeoutMs \} : \{\}\)/);
});

test("T25 failover is TEXT-only and malformed HTTP success cannot call failover", () => {
  const ai = fs.readFileSync(new URL("../lib/ai-chat.js", import.meta.url), "utf8");
  assert.ok(ai.indexOf("catch (primaryError)") < ai.indexOf("const parsed = parseDecisionReply(raw)"));
  assert.ok(ai.indexOf("const parsed = parseDecisionReply(raw)") > ai.lastIndexOf("opencode.sendPrompt(secondaryConfig"));
});

test("T26 customer memory is initial NEED_ADMIN zero plus final exactly once", () => {
  const ai = fs.readFileSync(new URL("../lib/ai-chat.js", import.meta.url), "utf8");
  assert.equal((ai.match(/customerMemory\s*\.ducKetNeuDenLuot/g) || []).length, 2);
  const needBlock = ai.slice(ai.indexOf("if (result.needAdmin)"), ai.indexOf("if (result.skipped)"));
  assert.doesNotMatch(needBlock, /ducKetNeuDenLuot/);
  assert.match(ai, /generateAdminClarificationFinalReply[\s\S]*await customerMemory\.ducKetNeuDenLuot/);
});

test("T27 Admin answer is one-time context, never permanent learning", () => {
  const zalo = fs.readFileSync(new URL("../lib/zalo-service.js", import.meta.url), "utf8");
  const clarification = fs.readFileSync(new URL("../lib/admin-clarification.js", import.meta.url), "utf8");
  assert.match(zalo, /BEGIN_ONE_TIME_ADMIN_ANSWER/);
  assert.doesNotMatch(clarification, /setOwnerInstruction|customer_memory|training|\bknowledge\b/);
});

test("T28 private-only: group cannot open clarification", async () => {
  const store = new MemoryStore(); const engine = createAdminClarificationEngine({ store, now: () => 400_000 });
  const result = await engine.open({ ownerUid: "owner", message: customer("group", "m", 1) });
  assert.equal(result.reason, "PRIVATE_ONLY"); assert.equal(store.rows.length, 0);
});

test("T29 production coordinator seam preserves synthetic-only, real-only and mixed work", async () => {
  const { runAdminClarificationCoordinatorHarnessForTests } = await import("../lib/zalo-service.js");
  let sequence = 0;
  const real = (threadId, id) => ({
    id,
    threadId,
    threadType: 0,
    senderId: `customer-${threadId}`,
    senderName: "Khách fixture",
    content: `real-${id}`,
    isSelf: false,
    msgType: "chat.text",
    ts: ++sequence,
  });
  async function runCase(name, { resumeId = null, before = [], after = [] }) {
    const resumed = [];
    const canonical = [];
    const threadId = `coord-${name}`;
    await runAdminClarificationCoordinatorHarnessForTests({
      ownerUid: `owner-${name}`,
      customerThreadId: threadId,
      resumeId,
      requesterUid: `customer-${threadId}`,
      messagesBefore: before.map((id) => real(threadId, id)),
      messagesAfter: after.map((id) => real(threadId, id)),
    }, {
      runResume: async ({ id }) => { resumed.push(id); },
      runCanonicalCustomer: async ({ messages }) => {
        canonical.push(messages.map((message) => message.id));
      },
    });
    return { resumed, canonical };
  }

  const syntheticOnly = await runCase("synthetic-only", { resumeId: 2901 });
  assert.deepEqual(syntheticOnly.resumed, [2901]);
  assert.deepEqual(syntheticOnly.canonical, []);

  const realOnly = await runCase("real-only", { after: ["real-only-1"] });
  assert.deepEqual(realOnly.resumed, []);
  assert.deepEqual(realOnly.canonical, [["real-only-1"]]);

  const mixed = await runCase("mixed", { resumeId: 2902, after: ["mixed-real-1"] });
  assert.deepEqual(mixed.resumed, [2902]);
  assert.deepEqual(mixed.canonical, [["mixed-real-1"]]);

  const interleaved = await runCase("interleaved", {
    resumeId: 2903,
    before: ["interleaved-real-1"],
    after: ["interleaved-real-2"],
  });
  assert.deepEqual(interleaved.resumed, [2903]);
  assert.deepEqual(interleaved.canonical, [["interleaved-real-1", "interleaved-real-2"]]);
});

test("T30 replayed mixed work keeps real path and clarification CAS sends final once", async () => {
  const { runAdminClarificationCoordinatorHarnessForTests } = await import("../lib/zalo-service.js");
  const store = new MemoryStore();
  const row = store.seed({
    status: S.CUSTOMER_REPLY_READY,
    customerThreadId: "coord-replay",
    customerFinalReplyText: "ready",
  });
  const engine = createAdminClarificationEngine({ store, now: () => 410_000 });
  let finalSends = 0;
  const realPasses = [];
  const work = {
    ownerUid: "owner-replay",
    customerThreadId: "coord-replay",
    resumeId: row.id,
    messagesAfter: [{
      id: "replayed-real-1",
      threadId: "coord-replay",
      threadType: 0,
      senderId: "customer-replay",
      senderName: "Khách replay",
      content: "real replay payload",
      isSelf: false,
      msgType: "chat.text",
      ts: 1,
    }],
  };
  const hooks = {
    runResume: ({ id }) => engine.resume(id, successfulCallbacks({
      send: async () => ({ id: `final-${++finalSends}` }),
    })),
    runCanonicalCustomer: async ({ messages }) => {
      realPasses.push(messages.map((message) => message.id));
    },
  };
  await runAdminClarificationCoordinatorHarnessForTests(work, hooks);
  await runAdminClarificationCoordinatorHarnessForTests(work, hooks);
  assert.equal(finalSends, 1);
  assert.deepEqual(realPasses, [["replayed-real-1"], ["replayed-real-1"]]);
  assert.equal((await store.getById(row.id)).status, S.CLOSED);
});

test("T31 canonical decision-result logging separates NEED_ADMIN, malformed and ai_error", () => {
  const needAdminLogs = [canonicalDecisionResultLog(
    { needAdmin: true, sessionId: "s-need", model: "fixture/model" },
    { clarificationAccepted: true, ownerUid: "owner", message: customer("log-need") }
  )].filter(Boolean);
  assert.equal(needAdminLogs.filter((entry) => entry.event === "ai_need_admin").length, 1);
  assert.equal(needAdminLogs.filter((entry) => entry.event === "ai_skip").length, 0);
  assert.equal(needAdminLogs.filter((entry) => entry.event === "ai_error").length, 0);

  const malformedLogs = [canonicalDecisionResultLog(
    {
      malformedDecision: true,
      error: "AI decision protocol malformed: MISSING_OR_INVALID_TOKEN",
      sessionId: "s-malformed",
      model: "fixture/model",
    },
    { ownerUid: "owner", message: customer("log-malformed") }
  )].filter(Boolean);
  assert.equal(malformedLogs.filter((entry) => entry.event === "ai_output_contract_failure").length, 1);
  assert.equal(malformedLogs.filter((entry) => entry.event === "ai_error").length, 0);

  const source = fs.readFileSync(new URL("../lib/ai-chat.js", import.meta.url), "utf8");
  assert.ok(source.indexOf("if (result.malformedDecision)")
    < source.indexOf("if (result.error)"));
  assert.match(source, /canonicalDecisionResultLog\(result, \{ ownerUid, message: messageObj \}\)/);
  assert.match(source, /if \(opened\?\.row\?\.id && \(opened\.opened \|\| opened\.existing\)\)/);
});

test("T32 pre-provider authority rejection is recoverable; actual uncertain send is SEND_UNKNOWN", async () => {
  const { sendChatMessage } = await import("../lib/zalo-service.js");
  const canonicalAuthorityRejection = await sendChatMessage({
    threadId: "authority-blocked-before-provider",
    threadType: 0,
    text: "must not reach provider",
  }, {
    reportAuthorityRejectionBeforeProvider: true,
    conversationGeneration: { conHieuLuc: () => false },
  });
  assert.equal(canonicalAuthorityRejection?.authorityRejectedBeforeProvider, true);

  const recoverableStore = new MemoryStore();
  const recoverableRow = recoverableStore.seed({
    status: S.CUSTOMER_REPLY_READY,
    customerFinalReplyText: "ready",
  });
  const recoverableEngine = createAdminClarificationEngine({
    store: recoverableStore,
    now: () => 420_000,
  });
  let providerSendCalls = 0;
  const blocked = await recoverableEngine.resume(recoverableRow.id, successfulCallbacks({
    send: async () => canonicalAuthorityRejection,
  }));
  assert.equal(blocked.reason, "BLOCKED_BY_AUTHORITY");
  assert.equal(providerSendCalls, 0);
  assert.equal((await recoverableStore.getById(recoverableRow.id)).status, S.BLOCKED_BY_AUTHORITY);

  const recovered = await recoverableEngine.resume(recoverableRow.id, successfulCallbacks({
    send: async () => ({ id: `confirmed-${++providerSendCalls}` }),
  }));
  assert.equal(recovered.sent, true);
  assert.equal(providerSendCalls, 1);
  assert.equal((await recoverableStore.getById(recoverableRow.id)).status, S.CLOSED);

  const uncertainStore = new MemoryStore();
  const uncertainRow = uncertainStore.seed({
    status: S.CUSTOMER_REPLY_READY,
    customerFinalReplyText: "ready",
  });
  const uncertainEngine = createAdminClarificationEngine({ store: uncertainStore, now: () => 430_000 });
  let uncertainProviderAttempts = 0;
  const uncertain = await uncertainEngine.resume(uncertainRow.id, successfulCallbacks({
    send: async () => { uncertainProviderAttempts += 1; return null; },
  }));
  assert.equal(uncertain.reason, "SEND_UNKNOWN");
  assert.equal(uncertainProviderAttempts, 1);
  assert.equal((await uncertainStore.getById(uncertainRow.id)).status, S.SEND_UNKNOWN);
});

test("T33 mixed multi-segment partition preserves every original segment identity", async () => {
  const { runAdminClarificationCoordinatorHarnessForTests } = await import("../lib/zalo-service.js");
  const threadId = "identity-multi-segment";
  const real = (id) => ({
    id,
    threadId,
    threadType: 0,
    senderId: "identity-customer",
    senderName: "Khách identity",
    content: id,
    isSelf: false,
    msgType: "chat.text",
    ts: id.endsWith("1") ? 1 : 2,
  });
  let mixedWork = null;
  let originalSegments = null;
  let processedSegments = null;
  const processedRealIds = [];
  const resumed = [];

  await runAdminClarificationCoordinatorHarnessForTests({
    ownerUid: "identity-owner",
    customerThreadId: threadId,
    requesterUid: "identity-customer",
    segmentBatches: [
      { messages: [real("identity-real-1")] },
      { resumeId: 3301 },
      { messages: [real("identity-real-2")] },
    ],
  }, {
    captureOriginalSegments: ({ work, segments }) => {
      if (segments.some((segment) => segment.tins.some((message) =>
        message.__adminClarificationResumeId === 3301
      ))) {
        mixedWork = work;
        originalSegments = segments;
      }
    },
    runResume: async ({ id }) => { resumed.push(id); },
    runCanonicalCustomer: async ({ segments, messages, conversationGeneration }) => {
      if (messages.length === 1 && messages[0].id === "identity-real-1") {
        await Promise.resolve();
        if (conversationGeneration.stale) return;
      }
      processedSegments = segments;
      processedRealIds.push(...messages.map((message) => message.id));
    },
  });

  assert.deepEqual(resumed, [3301]);
  assert.equal(originalSegments.length, 3);
  assert.equal(mixedWork.segments[0], originalSegments[0]);
  assert.equal(mixedWork.segments[1], originalSegments[1]);
  assert.equal(mixedWork.segments[2], originalSegments[2]);
  assert.equal(processedSegments[0], originalSegments[0]);
  assert.equal(processedSegments[1], originalSegments[2]);
  assert.equal(originalSegments[1].tins.length, 0);
  assert.equal(mixedWork.tins.some((message) => message.__adminClarificationResumeId), false);
  assert.deepEqual(processedRealIds, ["identity-real-1", "identity-real-2"]);
});

test("T34 consumed pre-AI/PDF state survives synthetic partition and stale replay", async () => {
  const { runAdminClarificationCoordinatorHarnessForTests } = await import("../lib/zalo-service.js");
  const threadId = "identity-pdf-replay";
  const realMessage = {
    id: "pdf-consumed-real",
    threadId,
    threadType: 0,
    senderId: "pdf-customer",
    senderName: "Khách PDF",
    content: "PDF fixture",
    isSelf: false,
    msgType: "share.file",
    ts: 1,
  };
  let pdfEffects = 0;
  let seenEffects = 0;
  let aiCallsForConsumedSegment = 0;
  let mixedOriginalSegment = null;
  let mixedProcessedSegment = null;
  let resumeCalls = 0;

  await runAdminClarificationCoordinatorHarnessForTests({
    ownerUid: "pdf-owner",
    customerThreadId: threadId,
    requesterUid: "pdf-customer",
    segmentBatches: [
      { messages: [realMessage] },
      { resumeId: 3401 },
    ],
  }, {
    captureOriginalSegments: ({ segments }) => {
      if (segments.some((segment) => segment.tins.some((message) =>
        message.__adminClarificationResumeId === 3401
      ))) {
        mixedOriginalSegment = segments.find((segment) =>
          segment.tins.some((message) => message.id === realMessage.id)
        );
      }
    },
    runResume: async () => { resumeCalls += 1; },
    runCanonicalCustomer: async ({ segments, conversationGeneration }) => {
      const segment = segments.find((item) =>
        item.tins.some((message) => message.id === realMessage.id)
      );
      if (!segment) return;
      if (!segment.preAiDone) {
        pdfEffects += 1;
        seenEffects += 1;
        segment.preAiDone = true;
        segment.aiEligible = false;
        await Promise.resolve();
        if (conversationGeneration.stale) return;
      }
      mixedProcessedSegment = segment;
      if (segment.aiEligible !== false) aiCallsForConsumedSegment += 1;
    },
  });

  assert.equal(resumeCalls, 1);
  assert.equal(mixedProcessedSegment, mixedOriginalSegment);
  assert.equal(mixedProcessedSegment.preAiDone, true);
  assert.equal(mixedProcessedSegment.aiEligible, false);
  assert.equal(pdfEffects, 1);
  assert.equal(seenEffects, 1);
  assert.equal(aiCallsForConsumedSegment, 0);
});

test("DB-E2E additive SQLite schema, waiting uniqueness and status CAS are real", async () => {
  const repo = new URL("..", import.meta.url);
  const repoPath = decodeURIComponent(repo.pathname).replace(/^\/(?:([A-Za-z]:))/, "$1").replace(/\//g, "\\");
  const tempRoot = fs.mkdtempSync(`${repoPath}\\.tmp-admin-clarification-db-`);
  const previousCwd = process.cwd();
  const previousSecret = process.env.APP_SECRET_KEY;
  try {
    process.chdir(tempRoot);
    process.env.APP_SECRET_KEY = "11".repeat(32);
    await import("./sqlite3-node24-test-register.js");
    const db = await import(`../lib/db.js?admin-clarification-e2e=${Date.now()}`);
    await db.initDb();
    const first = await db.createAdminClarification({
      ownerUid: "db-owner", customerThreadId: "db-thread", requesterUid: "db-customer",
      requesterName: "DB Customer", correlationToken: "#AC-DB0001",
      openedContextBoundary: "db-m1", expiresAt: 50_000, now: 10_000,
    });
    const duplicate = await db.createAdminClarification({
      ownerUid: "db-owner", customerThreadId: "db-thread", requesterUid: "db-customer",
      requesterName: "DB Customer", correlationToken: "#AC-DB0002",
      openedContextBoundary: "db-m2", expiresAt: 50_000, now: 10_001,
    });
    assert.equal(first.created, true); assert.equal(duplicate.created, false); assert.equal(duplicate.row.id, first.row.id);
    const sending = await db.transitionAdminClarification(first.row.id, S.ADMIN_NOTIFY_PENDING, S.ADMIN_NOTIFY_SENDING, { adminNotificationState: "SENDING" }, { now: 10_002 });
    assert.equal(sending.status, S.ADMIN_NOTIFY_SENDING);
    const lost = await db.transitionAdminClarification(first.row.id, S.ADMIN_NOTIFY_PENDING, S.WAITING_ADMIN, {}, { now: 10_003 });
    assert.equal(lost, null);
    const waiting = await db.transitionAdminClarification(first.row.id, S.ADMIN_NOTIFY_SENDING, S.WAITING_ADMIN, { adminNotificationState: "SENT" }, { now: 10_004 });
    assert.equal(waiting.status, S.WAITING_ADMIN);
    assert.equal(await db.touchWaitingAdminClarification("db-owner", "db-thread", "db-m3", 10_005), true);
    const claimed = await db.claimAdminClarificationAnswer({ ownerUid: "db-owner", correlationToken: "#AC-DB0001", adminMessageId: "db-a1", adminSenderUid: "db-admin", adminAnswer: "DB answer", now: 10_006 });
    assert.equal(claimed.frozenContextBoundary, "db-m3"); assert.equal(claimed.waitingSlot, null);
  } finally {
    const adapter = await import("./sqlite3-node24-test-adapter.js");
    adapter.closeAllTestDatabases();
    process.chdir(previousCwd);
    if (previousSecret === undefined) delete process.env.APP_SECRET_KEY;
    else process.env.APP_SECRET_KEY = previousSecret;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

assert.deepEqual(parseAdminClarificationToken("#ac-abc123 câu trả lời"), { token: "#AC-ABC123", answer: "câu trả lời" });

let passed = 0;
for (const item of tests) {
  try {
    await item.fn(); passed += 1; console.log(`PASS ${item.name}`);
  } catch (error) {
    console.error(`FAIL ${item.name}`); console.error(error); process.exitCode = 1;
  }
}
console.log(`\nAdmin Clarification V1: ${passed}/${tests.length} tests passed`);
if (passed !== tests.length) process.exitCode = 1;
