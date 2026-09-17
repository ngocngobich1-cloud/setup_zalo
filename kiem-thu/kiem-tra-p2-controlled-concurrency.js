import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  AI_GLOBAL_CONCURRENCY_LIMIT,
  __resetGlobalAiLimiterForTests,
  cancelGlobalAiWaiter,
  clearOwnerAiRuntimePhase,
  configureGlobalAiLimiter,
  getGlobalAiLimiterSnapshot,
  getOwnerAiRuntimePhases,
  isAiSlotTimeoutError,
  runBackgroundAiTask,
  scheduleDetachedBackgroundTask,
  updateOwnerAiRuntimePhase,
  withGlobalAiSlot,
} from "../lib/global-ai-limiter.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => fs.readFileSync(path.join(REPO, file), "utf8");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const cases = [];
async function test(name, operation) {
  try {
    await operation();
    cases.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, pass: false, error });
    console.log(`FAIL ${name}`);
    console.log(error?.stack || error);
  }
}

await test("P2-01 default global limit is 2", async () => {
  assert.equal(AI_GLOBAL_CONCURRENCY_LIMIT, 2);
});

await test("P2-02 two foreground turns run concurrently", async () => {
  const gate = deferred();
  const a = withGlobalAiSlot({}, () => gate.promise);
  const b = withGlobalAiSlot({}, () => gate.promise);
  await tick();
  assert.equal(getGlobalAiLimiterSnapshot().activeCount, 2);
  gate.resolve();
  await Promise.all([a, b]);
});

await test("P2-03 third foreground turn waits and cap never exceeds two", async () => {
  const gate = deferred();
  const a = withGlobalAiSlot({}, () => gate.promise);
  const b = withGlobalAiSlot({}, () => gate.promise);
  let thirdRan = false;
  const c = withGlobalAiSlot({}, async () => { thirdRan = true; });
  await tick();
  assert.equal(thirdRan, false);
  assert.deepEqual(getGlobalAiLimiterSnapshot(), { limit: 2, activeCount: 2, normalWaitingCount: 1 });
  gate.resolve();
  await Promise.all([a, b, c]);
  assert.equal(getGlobalAiLimiterSnapshot().activeCount, 0);
});

await test("P2-04 older orderKey wins normal queue fairness", async () => {
  const gate = deferred();
  const blockers = [
    withGlobalAiSlot({}, () => gate.promise),
    withGlobalAiSlot({}, () => gate.promise),
  ];
  const order = [];
  const newer = withGlobalAiSlot({ orderKey: 20 }, async () => { order.push("newer"); });
  const older = withGlobalAiSlot({ orderKey: 10 }, async () => { order.push("older"); });
  await tick();
  gate.resolve();
  await Promise.all([...blockers, newer, older]);
  assert.deepEqual(order, ["older", "newer"]);
});

await test("P2-05 equal orderKey uses monotonic sequence", async () => {
  const gate = deferred();
  const blockers = [withGlobalAiSlot({}, () => gate.promise), withGlobalAiSlot({}, () => gate.promise)];
  const order = [];
  const first = withGlobalAiSlot({ orderKey: 30 }, async () => { order.push(1); });
  const second = withGlobalAiSlot({ orderKey: 30 }, async () => { order.push(2); });
  await tick();
  gate.resolve();
  await Promise.all([...blockers, first, second]);
  assert.deepEqual(order, [1, 2]);
});

await test("P2-06 waiting cancellation is idempotent and never decrements active", async () => {
  const gate = deferred();
  const blockers = [withGlobalAiSlot({}, () => gate.promise), withGlobalAiSlot({}, () => gate.promise)];
  const key = {};
  const waiting = withGlobalAiSlot({ waiterKey: key }, async () => assert.fail("cancelled waiter ran"));
  await tick();
  assert.equal(cancelGlobalAiWaiter(key, "fixture"), true);
  assert.equal(cancelGlobalAiWaiter(key, "fixture-again"), false);
  await assert.rejects(waiting, /AI_SLOT_CANCELLED/);
  assert.equal(getGlobalAiLimiterSnapshot().activeCount, 2);
  gate.resolve();
  await Promise.all(blockers);
});

await test("P2-07 timeout cancels only a WAITING admin-style waiter", async () => {
  const gate = deferred();
  const blockers = [withGlobalAiSlot({}, () => gate.promise), withGlobalAiSlot({}, () => gate.promise)];
  const timed = withGlobalAiSlot({ timeoutMs: 10 }, async () => assert.fail("timed waiter ran"));
  await assert.rejects(timed, (error) => isAiSlotTimeoutError(error));
  assert.equal(getGlobalAiLimiterSnapshot().activeCount, 2);
  gate.resolve();
  await Promise.all(blockers);
});

await test("P2-08 nested inference is reentrant and does not increment activeCount", async () => {
  await withGlobalAiSlot({}, async () => {
    assert.equal(getGlobalAiLimiterSnapshot().activeCount, 1);
    await withGlobalAiSlot({}, async () => {
      assert.equal(getGlobalAiLimiterSnapshot().activeCount, 1);
    });
    assert.equal(getGlobalAiLimiterSnapshot().activeCount, 1);
  });
  assert.equal(getGlobalAiLimiterSnapshot().activeCount, 0);
});

await test("P2-09 nested background uses the held slot", async () => {
  await withGlobalAiSlot({}, async () => {
    const result = await runBackgroundAiTask(async () => getGlobalAiLimiterSnapshot().activeCount);
    assert.deepEqual(result, { ran: true, reentrant: true, value: 1 });
  });
});

await test("P2-10 standalone background runs only while fully idle", async () => {
  const result = await runBackgroundAiTask(async () => "ran");
  assert.deepEqual(result, { ran: true, reentrant: false, value: "ran" });
});

await test("P2-11 standalone background skips while foreground is active", async () => {
  const gate = deferred();
  const foreground = withGlobalAiSlot({}, () => gate.promise);
  await tick();
  const result = await runBackgroundAiTask(async () => assert.fail("background ran"));
  assert.equal(result.ran, false);
  gate.resolve();
  await foreground;
});

await test("P2-12 standalone background skips while a normal waiter exists", async () => {
  const gate = deferred();
  const blockers = [withGlobalAiSlot({}, () => gate.promise), withGlobalAiSlot({}, () => gate.promise)];
  const waiting = withGlobalAiSlot({}, async () => undefined);
  await tick();
  const result = await runBackgroundAiTask(async () => assert.fail("background ran"));
  assert.equal(result.ran, false);
  gate.resolve();
  await Promise.all([...blockers, waiting]);
});

await test("P2-12A detached customer background releases parent slot and reacquires standalone", async () => {
  const completed = deferred();
  let observed = null;
  const reply = await withGlobalAiSlot({}, async () => {
    scheduleDetachedBackgroundTask(async () => {
      observed = await runBackgroundAiTask(async () => getGlobalAiLimiterSnapshot().activeCount);
      completed.resolve();
    });
    return "reply-ready";
  });
  assert.equal(reply, "reply-ready");
  assert.equal(getGlobalAiLimiterSnapshot().activeCount, 0);
  await completed.promise;
  assert.deepEqual(observed, { ran: true, reentrant: false, value: 1 });
});

await test("P2-12B detached customer background skips instead of queueing while busy", async () => {
  const gate = deferred();
  const completed = deferred();
  const foreground = withGlobalAiSlot({}, () => gate.promise);
  await tick();
  let observed = null;
  scheduleDetachedBackgroundTask(async () => {
    observed = await runBackgroundAiTask(async () => assert.fail("busy background ran"));
    completed.resolve();
  });
  await completed.promise;
  assert.deepEqual(observed, { ran: false, reentrant: false, value: null });
  assert.equal(getGlobalAiLimiterSnapshot().normalWaitingCount, 0);
  gate.resolve();
  await foreground;
});

await test("P2-13 owner runtime phase snapshot is isolated", async () => {
  updateOwnerAiRuntimePhase({ ownerUid: "A", threadId: "same", phase: "waiting" });
  updateOwnerAiRuntimePhase({ ownerUid: "B", threadId: "same", phase: "generating" });
  assert.equal(getOwnerAiRuntimePhases("A").length, 1);
  assert.equal(getOwnerAiRuntimePhases("A")[0].phase, "waiting");
  assert.equal(getOwnerAiRuntimePhases("B")[0].phase, "generating");
  clearOwnerAiRuntimePhase("A", "same");
  assert.equal(getOwnerAiRuntimePhases("A").length, 0);
  assert.equal(getOwnerAiRuntimePhases("B").length, 1);
  clearOwnerAiRuntimePhase("B", "same");
});

const durable = source("lib/durable-message-queue.js");
const db = source("lib/db.js");
const zalo = source("lib/zalo-service.js");
const admin = source("lib/admin-command.js");
const aiChat = source("lib/ai-chat.js");
const memory = source("lib/customer-memory.js");
const server = source("server.js");
const app = source("public/app.js");

await test("P2-14 durableIds is exported and reused for durable-origin", async () => {
  assert.match(durable, /export function durableIds/);
  assert.match(zalo, /const durableOrigin = durableIds\(/);
});

await test("P2-15 actual assigned rows are filtered by generation key", async () => {
  assert.match(durable, /assignedRows = rows\.filter\(\(row\) => row\.generationKey === generationKey\)/);
  assert.match(durable, /generation\.durableJobIds = assignedRows\.map/);
});

await test("P2-16 zero assigned members create no generation authority", async () => {
  assert.match(durable, /if \(!assignedRows\.length\) return null/);
  assert.match(zalo, /expectedMemberCount[^\n]+<= 0/);
});

await test("P2-17 lease renewal is additive and checks exact member count", async () => {
  assert.match(db, /export async function giaHanDurableGeneration[\s\S]*return withDurableWrite/);
  assert.match(db, /admitted_at > \?/);
  assert.match(db, /now - MAX_REPLAY_AGE_MS/);
  assert.match(durable, /return affectedRows === expected/);
  assert.match(zalo, /setInterval\(\(\) => \{ void renewLease\(\); \}, 30_000\)/);
});

await test("P2-18 authority loss cannot settle as success", async () => {
  assert.match(durable, /if \(generation\.durableAuthorityLost\) return false/);
  assert.match(zalo, /conversationGeneration\.durableAuthorityLost = true/);
  assert.match(zalo, /botWorkConHieuLuc = \(\) => automaticWorkConHieuLuc\(automaticContext\)[\s\S]*durableAuthorityLost !== true/);
});

await test("P2-19 customer slot precedes credential READ and releases before outbox", async () => {
  const acquire = zalo.indexOf("aiReply = await withGlobalAiSlot");
  const credential = zalo.indexOf("return ownerCredentials.withCurrentOwnerCredentialRead", acquire);
  const summary = zalo.indexOf("aiChat.scheduleCustomerSummary", credential);
  const outbox = zalo.indexOf("const durableTextOutboxes", credential);
  assert.ok(acquire >= 0 && credential > acquire && summary > credential && outbox > summary);
  assert.match(
    zalo.slice(credential, summary),
    /return ownerCredentials\.withCurrentOwnerCredentialRead\([\s\S]*\n    \}\);\r?\n    if \(aiReply/
  );
  assert.doesNotMatch(zalo.slice(credential, outbox), /await aiChat\.scheduleCustomerSummary/);
});

await test("P2-19A customer reply does not await summary and detached scheduler owns it", async () => {
  const tryReplyStart = aiChat.indexOf("export async function tryReply");
  const scheduleStart = aiChat.indexOf("export function scheduleCustomerSummary", tryReplyStart);
  const adminStart = aiChat.indexOf("export async function generateAdminClarificationFinalReply", scheduleStart);
  assert.ok(tryReplyStart >= 0 && scheduleStart > tryReplyStart && adminStart > scheduleStart);
  assert.doesNotMatch(aiChat.slice(tryReplyStart, scheduleStart), /ducKetNeuDenLuot/);
  assert.match(aiChat.slice(scheduleStart, adminStart), /scheduleDetachedBackgroundTask/);
  assert.match(aiChat.slice(scheduleStart, adminStart), /customerMemory[\s\S]*ducKetNeuDenLuot/);
  assert.match(aiChat.slice(scheduleStart, adminStart), /withCredentialRead:[\s\S]*withCurrentOwnerCredentialRead/);
  assert.match(memory, /runBackgroundAiTask\(async \(\) => \{[\s\S]*withCredentialRead\(summarize\)/);
});

await test("P2-19B Admin Clarification summary remains awaited and reentrant", async () => {
  const adminStart = aiChat.indexOf("export async function generateAdminClarificationFinalReply");
  assert.match(aiChat.slice(adminStart), /await customerMemory\.ducKetNeuDenLuot/);
  assert.match(zalo, /generate: async \(row\) => withGlobalAiSlot\([\s\S]*generateAdminClarificationFinalReply/);
});

await test("P2-20 admin slot covers injected and production parser outside credential READ", async () => {
  const slot = admin.indexOf("ketQua = await withGlobalAiSlot");
  const injected = admin.indexOf("phanTichLenhAdminGia", slot);
  const credential = admin.indexOf("return withOwnerCredentialReadSet", slot);
  assert.ok(slot >= 0 && injected > slot && credential > injected);
});

await test("P2-21 admin timeout performs canonical cleanup and busy response", async () => {
  assert.match(admin, /isAiSlotTimeoutError\(error\)[\s\S]*cho\.delete\(khoa\)[\s\S]*ADMIN_AI_BUSY_RESPONSE/);
  assert.match(admin, /ADMIN_AI_SLOT_WAIT_MS = 60_000/);
});

await test("P2-22 cancellation integration is the existing khiHuy hook", async () => {
  assert.match(zalo, /khiHuy: async \(cancelledWork, reason\)[\s\S]*cancelGlobalAiWaiter\(generation, reason\)/);
});

await test("P2-23 typing reuses canonical 3s controller with a 5m waiting cap", async () => {
  assert.match(zalo, /const NHAC_GO_PHIM_MS = 3000/);
  assert.match(zalo, /waitingTypingCap = setTimeout\([\s\S]*300_000\)/);
  assert.equal((zalo.match(/function batDauGoPhim\(/g) || []).length, 1);
  assert.equal((zalo.match(/function batDauWebTyping\(/g) || []).length, 1);
});

await test("P2-24 app renders waiting and generating copy", async () => {
  assert.match(app, /Đang chờ Vizen xử lý…/);
  assert.match(app, /Vizen đang soạn câu trả lời…/);
  assert.match(app, /event\?\.phase/);
});

await test("P2-25 reconnect clears stale UI then server restores owner phases", async () => {
  assert.match(app, /socket\.on\("connect", \(\) => \{[\s\S]*anBotDangSoan\(\)/);
  assert.doesNotMatch(app, /socket\.on\("connect", anBotDangSoan\)/);
  assert.match(server, /getOwnerAiRuntimePhases\(ownerUid\)[\s\S]*socket\.emit\("bot_typing_status"/);
});

await test("P2-26 standalone summary uses idle gate and 10-skip warning", async () => {
  assert.match(memory, /runBackgroundAiTask/);
  assert.match(memory, /if \(!background\.ran\)[\s\S]*consecutiveSummarySkips \+= 1/);
  assert.match(memory, /consecutiveSummarySkips === 10/);
  assert.match(memory, /background_summary_skip_warning/);
  assert.doesNotMatch(memory, /runBackgroundAiTask[\s\S]*withGlobalAiSlot/);
});

await test("P2-27 conversation-inflight remains unchanged", async () => {
  const digest = createHash("sha256").update(source("lib/conversation-inflight.js").replace(/\r\n/g, "\n")).digest("hex");
  assert.equal(digest, "c2192ec484fe92b212d35967b50aa1af212711e0422c72d782f168ff8f347420");
});

await test("P2-28 limiter observability exposes canonical events and counters", async () => {
  const events = [];
  configureGlobalAiLimiter({ log: (event) => events.push(event) });
  await withGlobalAiSlot({ ownerUid: "A", threadId: "T" }, async () => undefined);
  assert.deepEqual(events.map((event) => event.event), [
    "ai_slot_wait",
    "ai_slot_acquired",
    "ai_slot_released",
  ]);
  for (const event of events) {
    assert.equal(event.limit, 2);
    assert.equal(Number.isInteger(event.activeCount), true);
    assert.equal(Number.isInteger(event.waitingCount), true);
  }
  assert.equal(Number.isFinite(events[1].slot_wait_ms), true);
  assert.equal(Number.isFinite(events[2].slot_wait_ms), true);
  configureGlobalAiLimiter();
});

__resetGlobalAiLimiterForTests();
const passed = cases.filter((entry) => entry.pass).length;
console.log(`\nP2 CONTROLLED CONCURRENCY: ${passed}/${cases.length} PASS`);
console.log("REAL_ZALO_CALL = 0");
console.log("REAL_PROVIDER_CALL = 0");
console.log("PRODUCTION_DB_TOUCHED = NO");
if (passed !== cases.length) process.exitCode = 1;
