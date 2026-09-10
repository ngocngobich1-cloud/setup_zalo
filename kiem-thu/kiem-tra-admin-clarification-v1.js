import assert from "node:assert/strict";
import fs from "node:fs";
import "./node24-arm64-test-polyfills.js";
import { splitIntoBubbles } from "../lib/message-utils.js";
import { taoDieuPhoiHoiThoai } from "../lib/conversation-inflight.js";
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
  async getRecentFailedAck(ownerUid, threadId, excludeId, createdSince) {
    return this.copy(this.rows.find((row) => row.ownerUid === String(ownerUid)
      && row.customerThreadId === String(threadId) && row.id !== Number(excludeId)
      && row.status === S.ADMIN_NOTIFY_FAILED
      && ["SENDING", "SENT"].includes(row.customerAckState) && row.createdAt >= createdSince));
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
const fallbackCopy = "Em chưa có đủ thông tin để trả lời chính xác lúc này. Em đã ghi nhận câu hỏi của anh/chị.";

test("P0 UI explicit clear is user intent; loading, invalidation and transient empty preserve", () => {
  const source = fs.readFileSync(new URL("../public/config.js", import.meta.url), "utf8");
  const stateStart = source.indexOf('      const adminZalo = panel.querySelector("#admin-zalo");');
  const stateEnd = source.indexOf('      const otpEmail =', stateStart);
  const loadStart = source.indexOf('      async function napCaiDatOtp()');
  const loadEnd = source.indexOf('        try {', loadStart);
  const loadedStart = source.indexOf('          adminZalo.value = data.adminZaloUid || "";', loadStart);
  const loadedEnd = source.indexOf('          otpEnabled.checked', loadedStart);
  const invalidateStart = source.indexOf('      invalidateAdminOwnerSink = () => {');
  const invalidateEnd = source.indexOf('        otpEnabled.checked', invalidateStart);
  const payloadStart = source.indexOf('              adminZaloUid: adminZaloReady');
  const payloadEnd = source.indexOf('              smtp:', payloadStart);
  for (const index of [stateStart, stateEnd, loadStart, loadEnd, loadedStart, loadedEnd, invalidateStart, invalidateEnd, payloadStart, payloadEnd]) assert.ok(index >= 0);
  let change;
  const select = { value: "", selectedOptions: [{ textContent: "Admin name" }], addEventListener: (_event, listener) => { change = listener; } };
  const control = Function("panel", `
    const settingsOwnerGeneration = 1;
    ${source.slice(stateStart, stateEnd)}
    return {
      loading: () => { ${source.slice(source.indexOf('        const generation', loadStart), loadEnd)} },
      loaded: (data) => { ${source.slice(loadedStart, loadedEnd)} },
      invalidate: () => { ${source.slice(source.indexOf('        adminZaloReady', invalidateStart), invalidateEnd)} },
      payload: () => ({ ${source.slice(payloadStart, payloadEnd)} })
    };` )({ querySelector: () => select });
  change(); assert.equal(control.payload().adminZaloClear, false);
  control.loaded({ adminZaloUid: "saved-admin" });
  select.value = ""; // Programmatic transient reset must not request clear.
  assert.equal(control.payload().adminZaloClear, false);
  select.value = "chosen-admin"; change();
  assert.equal(control.payload().adminZaloUid, "chosen-admin");
  assert.equal(control.payload().adminZaloClear, false);
  select.value = ""; change();
  assert.equal(control.payload().adminZaloClear, true);
  control.loading();
  assert.equal(control.payload().adminZaloUid, undefined);
  assert.equal(control.payload().adminZaloClear, false);
  control.loaded({ adminZaloUid: "saved-admin" }); select.value = ""; change();
  control.invalidate(); change();
  assert.equal(control.payload().adminZaloClear, false);
  assert.equal(control.payload().adminZaloUid, undefined);
  control.loaded({ adminZaloUid: "" });
  assert.equal(control.payload().adminZaloClear, false);
});

// Execute the production NEED_ADMIN branch and outbound function with fake I/O.
async function hotfixOutbound(opened, mode = "confirmed", complete = async () => {}) {
  const logs = []; const sends = []; const completions = []; let stickers = 0;
  let originCurrent = true; let generationCurrent = true; let typingStops = 0;
  const message = { ...customer("hotfix-outbound"), content: "Câu hỏi", isSelf: false };
  const branchStart = aiChatSource.indexOf("  if (result.needAdmin) {");
  const branchEnd = aiChatSource.indexOf("\n  if (result.skipped)", branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart);
  const replyBranch = Function("openAdminClarification", "addLog", "canonicalDecisionResultLog",
    `return async (messageObj) => { const ownerUid = "owner"; const result = { needAdmin: true };
      ${aiChatSource.slice(branchStart, branchEnd)} };`
  )(async () => opened, async (entry) => logs.push(entry), canonicalDecisionResultLog);
  const zalo = fs.readFileSync(new URL("../lib/zalo-service.js", import.meta.url), "utf8");
  const start = zalo.indexOf("async function traLoiCumTin(");
  const end = zalo.indexOf("\nasync function handleNewIncomingMessage", start);
  assert.ok(start >= 0 && end > start);
  const dependencies = {
    automaticWorkConHieuLuc: () => generationCurrent,
    tuyChonGuiTuDong: (work) => work,
    originConHieuLuc: () => originCurrent,
    gopThanhMotTin: (messages) => ({ ...messages.at(-1) }),
    chuHienTai: () => "owner",
    guiDaXemChoTins: () => {},
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => () => { typingStops += 1; },
    aiChat: {
      getConfig: () => ({}),
      tryReply: async (_text, metadata) => {
        const reply = mode === "normal" ? "Trả lời thông thường" : mode === "skip" ? null : await replyBranch(metadata);
        if (mode === "origin-after-ai") originCurrent = false;
        if (mode === "generation-after-ai") generationCurrent = false;
        if (mode === "throw-after-metadata") throw new Error("after metadata");
        return reply;
      },
    },
    ownerCredentials: { withCurrentOwnerCredentialRead: async (_owner, _config, work) => work() },
    ThreadType: { Group: 1, User: 0 },
    splitIntoBubbles,
    doi: async () => {
      if (mode === "origin-before-bubble") originCurrent = false;
      if (mode === "generation-before-bubble") generationCurrent = false;
    },
    nghiTruocBubble: () => 0,
    sendChatMessage: async (input) => {
      sends.push(input);
      if (mode === "send-throw") throw new Error("provider failure");
      return mode === "unconfirmed" ? null : { id: "confirmed-customer-message" };
    },
    completeAdminClarificationAck: async (...args) => { completions.push(args); return complete(...args); },
    addLog: async (entry) => logs.push(entry),
    thuGuiSticker: async () => { stickers += 1; },
    console: { error: () => {} },
  };
  const outbound = Function(...Object.keys(dependencies), `${zalo.slice(start, end)}; return traLoiCumTin;`)(...Object.values(dependencies));
  const coordinator = taoDieuPhoiHoiThoai({ chay: async (work, generation) => {
    await outbound(work, { originToken: { originOwnerUid: "owner" } }, generation);
  } });
  await coordinator.them({ ownerUid: "owner", threadId: message.threadId, tins: [message] });
  // A second work item must run even after failed/early-exit outbound.
  originCurrent = true; generationCurrent = true;
  let released = false;
  dependencies.aiChat.tryReply = async () => { released = true; return null; };
  await coordinator.them({ ownerUid: "owner", threadId: message.threadId, tins: [{ ...message, id: "next" }] });
  assert.equal(released, true, "conversation queue released");
  assert.equal(message.__adminClarificationFallback, undefined, "original inbound must not carry metadata");
  assert.ok(typingStops > 0);
  return { logs, sends, completions, stickers };
}

test("P0 B2/B3 F1/F2 failed notification returns row, truthful bubble, no success log or sticker", async () => {
  for (const reason of ["ADMIN_NOT_CONFIGURED", "ADMIN_NOTIFY_NOT_CONFIRMED"]) {
    const store = new MemoryStore();
    configureAdminClarificationRuntime({ notifyAdmin: async () => ({ sent: false, reason }), log: async () => {} });
    const originalQuery = store.getRecentFailedAck.bind(store);
    store.getRecentFailedAck = async (...args) => {
      const current = await store.getById(args[2]);
      assert.equal(current.status, S.ADMIN_NOTIFY_FAILED);
      assert.equal(current.customerAckState, "PENDING", "query precedes SENDING");
      return originalQuery(...args);
    };
    const opened = await createAdminClarificationEngine({ store, now: () => 100_000 }).open({ ownerUid: "owner", message: customer("failure") });
    assert.equal(opened.row.status, S.ADMIN_NOTIFY_FAILED);
    assert.equal(opened.row.errorDetail, reason);
    assert.equal(opened.row.customerAckState, "SENDING");
    assert.equal(opened.acknowledgement, fallbackCopy);
    assert.deepEqual(splitIntoBubbles(opened.acknowledgement), [fallbackCopy]);
    const result = await hotfixOutbound(opened);
    assert.deepEqual(result.sends.map((item) => item.text), [fallbackCopy]);
    assert.deepEqual(result.completions, [[opened.row.id, "confirmed-customer-message", true]]);
    assert.equal(result.stickers, 0);
    assert.equal(result.logs.some((entry) => entry.event === "ai_need_admin"), false);
  }
});

test("P0 B2b confirmed first fallback suppresses messages 2 and 3 with PENDING rows", async () => {
  const store = new MemoryStore(); let clock = 100_000;
  configureAdminClarificationRuntime({ notifyAdmin: async () => ({ sent: false, reason: "ADMIN_NOT_CONFIGURED" }) });
  const engine = createAdminClarificationEngine({ store, now: () => clock });
  const first = await engine.open({ ownerUid: "owner", message: customer("repeat") });
  const result = await hotfixOutbound(first, "confirmed", async (id, messageId, confirmed) => {
    assert.equal(confirmed, true);
    await store.transition(id, S.ADMIN_NOTIFY_FAILED, S.ADMIN_NOTIFY_FAILED, { customerAckState: "SENT", customerAckId: messageId });
  });
  assert.equal(result.sends.length, 1);
  for (const id of ["m2", "m3"]) {
    clock += 100;
    const next = await engine.open({ ownerUid: "owner", message: customer("repeat", id) });
    assert.equal(next.acknowledgement, null);
    assert.equal(next.row.customerAckState, "PENDING");
    const suppressed = await hotfixOutbound(next);
    assert.equal(suppressed.sends.length, 0); assert.equal(suppressed.completions.length, 0);
  }
});

test("P0 suppression SENDING/SENT only, created_at TTL, owner/thread isolation and current exclusion", async () => {
  const now = CLARIFICATION_TTL_MS * 3;
  for (const state of ["SENDING", "SENT", "SEND_UNKNOWN", "PENDING"]) {
    for (const age of [1, CLARIFICATION_TTL_MS, CLARIFICATION_TTL_MS + 1]) {
      const store = new MemoryStore();
      const previous = store.seed({ status: S.ADMIN_NOTIFY_FAILED, customerThreadId: "ttl", customerAckState: state, createdAt: now - age, updatedAt: now });
      assert.equal(await store.getRecentFailedAck("owner", "ttl", previous.id, 0), null);
      assert.equal(await store.getRecentFailedAck("other", "ttl", 0, 0), null);
      assert.equal(await store.getRecentFailedAck("owner", "other", 0, 0), null);
      const opened = await createAdminClarificationEngine({ store, now: () => now }).open({ ownerUid: "owner", message: customer("ttl") });
      const suppress = ["SENDING", "SENT"].includes(state) && age <= CLARIFICATION_TTL_MS;
      assert.equal(opened.acknowledgement, suppress ? null : fallbackCopy);
      assert.equal(opened.row.customerAckState, suppress ? "PENDING" : "SENDING");
    }
  }
});

test("P0 B4/B4b every failed or early outbound exit completes SEND_UNKNOWN and releases queue", async () => {
  for (const mode of ["send-throw", "unconfirmed", "origin-after-ai", "generation-after-ai", "origin-before-bubble", "generation-before-bubble", "throw-after-metadata"]) {
    const opened = { opened: false, row: { id: 999 }, acknowledgement: fallbackCopy, adminClarificationFallback: true };
    const result = await hotfixOutbound(opened, mode);
    assert.deepEqual(result.completions, [[999, null, false]], mode);
    assert.equal(result.stickers, 0, mode);
  }
});

test("P0 B5/B6/B9 normal answer and SKIP preserve outbound and sticker behavior", async () => {
  const normal = await hotfixOutbound(null, "normal");
  assert.deepEqual(normal.sends.map((item) => item.text), ["Trả lời thông thường"]);
  assert.equal(normal.stickers, 1); assert.equal(normal.completions.length, 0);
  const skip = await hotfixOutbound(null, "skip");
  assert.equal(skip.sends.length, 0); assert.equal(skip.stickers, 0); assert.equal(skip.completions.length, 0);
});

test("P0 B1/B7/B8 WAITING_ADMIN survives restart, claims and resumes; failed row cannot resume", async () => {
  const store = new MemoryStore();
  configureAdminClarificationRuntime({ notifyAdmin: async () => ({ sent: true, message: { id: "admin-notification" } }), scheduleResume: async () => {} });
  const opened = await createAdminClarificationEngine({ store, now: () => 100_000 }).open({ ownerUid: "owner", message: customer("restart") });
  const ack = await hotfixOutbound(opened);
  assert.equal(ack.logs.filter((entry) => entry.event === "ai_need_admin").length, 1);
  assert.deepEqual(ack.sends.map((item) => item.text), [opened.acknowledgement]);
  assert.deepEqual(ack.completions, [[opened.row.id, "confirmed-customer-message", true]]);
  assert.equal(ack.stickers, 1);
  const restarted = createAdminClarificationEngine({ store, now: () => 101_000 });
  await restarted.recover({ ownerUid: "owner" });
  assert.equal((await store.getById(opened.row.id)).status, S.WAITING_ADMIN);
  const claimed = await restarted.handleAdminMessage({ ownerUid: "owner", message: {
    id: "reply-after-restart", senderId: "admin", content: `${opened.row.correlationToken} Đã xác nhận`,
  } });
  assert.equal(claimed.claimed, true);
  assert.equal((await restarted.resume(opened.row.id, successfulCallbacks())).sent, true);
  const failed = store.seed({ status: S.ADMIN_NOTIFY_FAILED, customerAckState: "SENT" });
  const result = await restarted.resume(failed.id, successfulCallbacks({
    generate: async () => assert.fail("failure must never generate final answer"),
    send: async () => assert.fail("failure must never resume send"),
  }));
  assert.equal(result.resumed, false);
  assert.equal((await store.getById(failed.id)).status, S.ADMIN_NOTIFY_FAILED);
});

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
    const serverSource = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    const adminDecisionSource = serverSource.match(/function adminZaloUpdateFromRequest\(body = \{\}\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(adminDecisionSource);
    const adminDecision = Function(`${adminDecisionSource}; return adminZaloUpdateFromRequest;`)();
    const updateAdmin = async (body) => {
      const update = adminDecision(body);
      if (update) await db.setAdminZalo("config-owner", update.uid, update.label);
    };
    await db.setAdminZalo("config-owner", "original-admin", "Original Admin");
    for (const body of [{ adminZaloUid: "" }, {}, { adminZaloUid: undefined }, { adminZaloUid: null }, { adminZaloUid: "  " }, { adminZaloClear: "true" }]) {
      await updateAdmin(body);
      assert.deepEqual(await db.getAdminZalo("config-owner"), { uid: "original-admin", label: "Original Admin" });
    }
    for (const uid of [undefined, null]) await db.setAdminZalo("config-owner", uid, "Ignored");
    assert.deepEqual(await db.getAdminZalo("config-owner"), { uid: "original-admin", label: "Original Admin" });
    await updateAdmin({ adminZaloClear: true, adminZaloUid: "ignored", adminZaloLabel: "Stale label" });
    assert.deepEqual(await db.getAdminZalo("config-owner"), { uid: "", label: "" });
    await updateAdmin({ adminZaloUid: "new-admin", adminZaloLabel: "New Admin" });
    assert.deepEqual(await db.getAdminZalo("config-owner"), { uid: "new-admin", label: "New Admin" });
    console.log("PASS A1-A4 canonical config persistence, positional null guards and label clear");
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
    const schemaBefore = await db.websiteDataAll("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name");
    const columns = await db.websiteDataAll("PRAGMA table_info(admin_clarifications)");
    assert.deepEqual(columns.map((column) => column.name), [
      "id", "owner_uid", "customer_thread_id", "customer_thread_type", "requester_uid", "requester_name",
      "correlation_token", "status", "waiting_slot", "opened_context_boundary", "latest_context_boundary",
      "frozen_context_boundary", "admin_message_id", "admin_sender_uid", "admin_answer", "admin_replied_at",
      "expires_at", "admin_notification_state", "admin_notification_id", "customer_ack_state", "customer_ack_id",
      "customer_final_reply_text", "customer_final_reply_id", "generation_attempts", "error_stage", "error_detail",
      "created_at", "updated_at", "closed_at",
    ]);
    const store = {
      create: db.createAdminClarification, expireWaiting: db.expireWaitingAdminClarifications,
      getWaiting: db.getWaitingAdminClarification, transition: db.transitionAdminClarification,
      getRecentFailedAck: db.getRecentFailedAdminClarificationAck,
    };
    let clock = CLARIFICATION_TTL_MS * 4;
    configureAdminClarificationRuntime({ notifyAdmin: async () => ({ sent: false, reason: "ADMIN_NOT_CONFIGURED" }), log: async () => {} });
    const engine = createAdminClarificationEngine({ store, now: () => clock });
    for (const mode of ["confirmed", "send-throw", "unconfirmed", "origin-after-ai", "generation-before-bubble"]) {
      const input = { ownerUid: "owner", message: customer(`db-${mode}`) };
      const opened = await engine.open(input);
      assert.equal(opened.row.status, S.ADMIN_NOTIFY_FAILED);
      assert.equal(opened.row.customerAckState, "SENDING", "existing DB self-transition succeeds");
      assert.equal(await db.getRecentFailedAdminClarificationAck("owner", input.message.threadId, opened.row.id, 0), null);
      assert.equal(await db.getRecentFailedAdminClarificationAck("other", input.message.threadId, 0, 0), null);
      assert.equal(await db.getRecentFailedAdminClarificationAck("owner", "other", 0, 0), null);
      const whileSending = await engine.open(input);
      assert.equal(whileSending.acknowledgement, null); assert.equal(whileSending.row.customerAckState, "PENDING");
      await hotfixOutbound(opened, mode, (id, messageId, confirmed) => db.completeAdminClarificationAck(id, messageId, confirmed, clock));
      const completed = await db.getAdminClarificationById(opened.row.id);
      assert.equal(completed.customerAckState, mode === "confirmed" ? "SENT" : "SEND_UNKNOWN");
      assert.equal(completed.status, S.ADMIN_NOTIFY_FAILED);
      const next = await engine.open(input);
      assert.equal(next.acknowledgement, mode === "confirmed" ? null : fallbackCopy, "SEND_UNKNOWN allows another fallback");
      if (mode !== "confirmed") {
        await hotfixOutbound(next, "confirmed", (id, messageId, confirmed) => db.completeAdminClarificationAck(id, messageId, confirmed, clock));
        assert.equal((await db.getAdminClarificationById(next.row.id)).customerAckState, "SENT");
      }
      // A fresh updated_at must not extend an old created_at window.
      clock += CLARIFICATION_TTL_MS + 1;
      await db.transitionAdminClarification(opened.row.id, S.ADMIN_NOTIFY_FAILED, S.ADMIN_NOTIFY_FAILED, {}, { now: clock });
      const afterTtl = await engine.open(input);
      assert.equal(afterTtl.acknowledgement, fallbackCopy);
      await db.completeAdminClarificationAck(afterTtl.row.id, null, false, clock);
    }
    assert.deepEqual(await db.websiteDataAll("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name"), schemaBefore);
    console.log("PASS DB-E2E P0 suppression, self-transition, SENT/SEND_UNKNOWN, B2d resend and NO_SCHEMA_CHANGE");
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
