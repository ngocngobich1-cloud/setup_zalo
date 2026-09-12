/** VIZENBOT P1 durable queue + outbox V2.3 — disposable DB, zero network. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./sqlite3-arm64-test-shim.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(THIS_FILE), "..");
const source = (file) => fs.readFileSync(path.join(REPO, file), "utf8");

function extractFunction(moduleSource, signature) {
  const start = moduleSource.indexOf(signature);
  assert.ok(start >= 0, `Khong tim thay ${signature}`);
  const bodyStart = moduleSource.indexOf("{", start + signature.length);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < moduleSource.length; index += 1) {
    const char = moduleSource[index];
    const next = moduleSource[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return moduleSource.slice(start, index + 1);
  }
  assert.fail(`Function khong dong: ${signature}`);
}

function handlerHarness({ globalEnabled = true, threadEnabled = true } = {}) {
  const zalo = source("lib/zalo-service.js");
  const events = [];
  const helpers = [
    "function botEligibilityConHieuLuc",
    "function khoaThreadEligibility",
    "function threadEligibilityEpochHienTai",
    "function threadEligibilityConHieuLuc",
    "function automaticWorkConHieuLuc",
    "function tuyChonGuiTuDong",
  ].map((signature) => extractFunction(zalo, signature)).join("\n");
  const incoming = extractFunction(zalo, "async function handleNewIncomingMessage");
  const dependencies = {
    boGom: {
      dangMo: () => false,
      dangBan: () => false,
      them: (message) => events.push(["gom", message]),
    },
    persistAndBroadcastMessage: async (message) => { events.push(["persist", message]); return message; },
    ghiNhanDurableAdmission: async ({ message }) => {
      events.push(["durable", message]);
      return { ...message, __durableJobId: 1, __durableAdmittedAt: Date.now() };
    },
    originConHieuLuc: () => true,
    sendChatMessage: async () => ({ id: "sent" }),
    sendResolvedPrivateMessage: async () => null,
    chuHienTai: () => "owner",
    addLog: async () => {},
    laTinHeThong: () => false,
    moTaSuKien: () => "event",
    laLenhAdmin: async () => false,
    xuLyLenh: async () => null,
    aiChat: { getConfig: () => ({ botEnabled: globalEnabled }) },
    getThread: async () => ({ id: "T", botEnabled: threadEnabled }),
    getAutoReplyRules: async () => [],
    normalizeString: String,
    ThreadType: { User: 0, Group: 1 },
    botDuocGoi: () => true,
    appState: { uid: "owner" },
  };
  const names = Object.keys(dependencies);
  const factory = Function(...names, `
    "use strict";
    let botEligibilityEpoch = 0;
    const threadEligibilityEpochs = new Map();
    ${helpers}
    ${incoming}
    return handleNewIncomingMessage;
  `);
  return { handle: factory(...names.map((name) => dependencies[name])), events };
}

function inbound(id = "m1", senderId = "customer", threadId = "T") {
  return {
    id, senderId, senderName: senderId, threadId, threadType: 0,
    content: "hoi bot", isSelf: false, msgType: "chat.text", ts: Date.now(),
  };
}

function generation(ownerUid = "owner", threadId = "T") {
  return {
    ownerUid, threadId, stale: false, cancelled: false, accepted: false,
    xacNhanOutbound() { this.accepted = true; },
    daChapNhanOutbound() { return this.accepted; },
  };
}

async function realDurableGeneration({ db, queue, taoDieuPhoiHoiThoai, accountId, conversationId, sourceMessageId }) {
  const row = await db.admitDurableMessageJob({ accountId, conversationId, sourceMessageId });
  await db.claimDurableMessageJob(row.id);
  let captured = null;
  const coordinator = taoDieuPhoiHoiThoai({
    truocGeneration: (work, activeGeneration) => queue.ganDurableGenerationChoWork(work, activeGeneration),
    chay: async (_work, activeGeneration) => { captured = activeGeneration; },
  });
  await coordinator.them({
    ownerUid: accountId,
    threadId: conversationId,
    tins: [{ ...inbound(sourceMessageId, "customer", conversationId), __durableJobId: row.id }],
  });
  assert.ok(captured?.durableGenerationKey);
  return captured;
}

async function worker(tempRoot) {
  process.chdir(tempRoot);
  const nonce = Date.now();
  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  const queue = await import(`${pathToFileURL(path.join(REPO, "lib", "durable-message-queue.js")).href}?p1q=${nonce}`);
  const outbox = await import(`${pathToFileURL(path.join(REPO, "lib", "outbound-outbox.js")).href}?p1o=${nonce}`);
  const { taoDieuPhoiHoiThoai } = await import(`${pathToFileURL(path.join(REPO, "lib", "conversation-inflight.js")).href}?p1c=${nonce}`);
  const { taoBoGom, CHO_GOM_MS, TRAN_CHO_MS } = await import(`${pathToFileURL(path.join(REPO, "lib", "gom-tin.js")).href}?p1g=${nonce}`);
  await db.initDb();

  const passed = [];
  const pass = (number, label) => { passed.push(number); console.log(`${String(number).padStart(2, "0")} ${label} = PASS`); };
  const rawGet = db.websiteDataGet;
  const rawRun = db.websiteDataRun;

  const tables = await Promise.all([
    rawGet("SELECT name FROM sqlite_master WHERE type='table' AND name='durable_message_jobs'"),
    rawGet("SELECT name FROM sqlite_master WHERE type='table' AND name='outbound_outbox'"),
  ]);
  assert.ok(tables.every(Boolean));
  pass(1, "SCHEMA_AUTO_CREATED");

  const duplicateA = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "T", sourceMessageId: "dup" });
  const duplicateB = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "T", sourceMessageId: "dup" });
  assert.equal(duplicateA.created, true); assert.equal(duplicateB.created, false);
  assert.equal((await db.listDurableMessageJobs({ accountId: "owner", conversationId: "T" })).length, 1);
  pass(2, "DUPLICATE_RECEIPT_ONE_ROW");

  const globalOff = handlerHarness({ globalEnabled: false });
  await globalOff.handle(inbound("off-global"));
  assert.deepEqual(globalOff.events.map(([event]) => event), ["persist"]);
  pass(3, "GLOBAL_BOT_OFF_ZERO_JOB");

  const threadOff = handlerHarness({ threadEnabled: false });
  await threadOff.handle(inbound("off-thread"));
  assert.deepEqual(threadOff.events.map(([event]) => event), ["persist"]);
  pass(4, "THREAD_BOT_OFF_ZERO_JOB");

  const enabled = handlerHarness();
  await enabled.handle(inbound("on"));
  assert.deepEqual(enabled.events.map(([event]) => event), ["persist", "durable", "gom"]);
  pass(5, "ADMISSION_BEFORE_GOM");

  let now = 100_000;
  const timers = [];
  const flushed = [];
  const gom = taoBoGom({
    conDangGo: () => false,
    khiChot: (tins) => flushed.push(tins),
    bayGio: () => now,
    datHen: (fn, ms) => { const task = { fn, ms, cancelled: false }; timers.push(task); return task; },
    huyHen: (task) => { task.cancelled = true; },
  });
  gom.them({ ...inbound("restart-A"), __durableAdmittedAt: now - CHO_GOM_MS - 1 });
  gom.them({ ...inbound("restart-B"), __durableAdmittedAt: now - 5_000 });
  const liveTimer = timers.findLast((task) => !task.cancelled);
  assert.equal(liveTimer.ms, 2_000); liveTimer.fn();
  assert.equal(flushed.length, 1); assert.deepEqual(flushed[0].map((message) => message.id), ["restart-A", "restart-B"]);
  assert.equal(CHO_GOM_MS, 7000); assert.equal(TRAN_CHO_MS, 60000);
  pass(6, "RESTART_DURING_GOM_RECOVERS_WAIT");

  const claimJob = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "T", sourceMessageId: "claim" });
  const claims = await Promise.all([
    db.claimDurableMessageJob(claimJob.id, { now: 1_000, leaseMs: 100 }),
    db.claimDurableMessageJob(claimJob.id, { now: 1_000, leaseMs: 100 }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  pass(7, "ATOMIC_INBOUND_CLAIM");
  assert.equal(await db.claimDurableMessageJob(claimJob.id, { now: 1_050, leaseMs: 100 }), null);
  pass(8, "ACTIVE_INBOUND_LEASE_GUARD");
  await db.recoverExpiredDurableJobs(1_101);
  assert.ok(await db.claimDurableMessageJob(claimJob.id, { now: 1_101, leaseMs: 100 }));
  pass(9, "EXPIRED_INBOUND_LEASE_RECOVERABLE");

  const members = [];
  for (const id of ["n1", "n2", "n3"]) {
    const row = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "N", sourceMessageId: id });
    await db.claimDurableMessageJob(row.id); members.push(row);
  }
  const genN = generation("owner", "N");
  await queue.ganDurableGenerationChoWork({ ownerUid: "owner", threadId: "N", tins: members.map((row) => ({ id: row.sourceMessageId, __durableJobId: row.id })) }, genN);
  const grouped = await db.listDurableMessageJobs({ accountId: "owner", conversationId: "N" });
  assert.equal(new Set(grouped.map((row) => row.generationKey)).size, 1);
  pass(10, "GENERATION_GROUPS_N_JOBS");

  const splitSeen = [];
  const splitCoordinator = taoDieuPhoiHoiThoai({
    truocGeneration: async (work, gen) => {
      await queue.ganDurableGenerationChoWork(work, gen);
      splitSeen.push({ key: gen.durableGenerationKey, sender: work.senderId, segments: work.segments.length });
    },
    chay: async (_work, gen) => gen.chapNhanOutbound(),
  });
  const splitRows = [];
  for (const [id, sender] of [["sA", "A"], ["sB", "B"]]) {
    const row = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "S", sourceMessageId: id });
    await db.claimDurableMessageJob(row.id); splitRows.push({ ...inbound(id, sender, "S"), __durableJobId: row.id });
  }
  await splitCoordinator.them({ ownerUid: "owner", threadId: "S", tins: splitRows });
  assert.equal(splitSeen.length, 2); assert.notEqual(splitSeen[0].key, splitSeen[1].key);
  pass(11, "SENDER_SPLIT_SEQUENTIAL_WORK_KEYS");

  const deterministicAgain = generation("owner", "N");
  await queue.ganDurableGenerationChoWork({ ownerUid: "owner", threadId: "N", tins: grouped.map((row) => ({ __durableJobId: row.id })) }, deterministicAgain);
  assert.equal(deterministicAgain.durableGenerationKey, genN.durableGenerationKey);
  pass(12, "DETERMINISTIC_KEY_SAME_MEMBERS_ATTEMPT");

  const prepared = await outbox.chuanBiDurableOutbox(genN, [{
    outboundKind: "TEXT", payload: { threadId: "N", threadType: 0, text: "reply" },
  }]);
  let providerCalls = 0;
  assert.equal((await db.listOutbox({ generationKey: genN.durableGenerationKey })).length, 1);
  pass(13, "OUTBOX_COMMITTED_BEFORE_SEND");
  assert.equal(grouped.length, 3);
  pass(14, "GENERATION_OWNS_N_INBOUND");

  const sameIntent = await db.ensureOutboundIntent({
    generationKey: genN.durableGenerationKey, accountId: "owner", conversationId: "N",
    outboundKind: "TEXT", outboundSlot: 0, requiredOutboundCount: 1, payload: { text: "ignored duplicate" },
  });
  assert.equal(sameIntent.id, prepared[0].id);
  pass(15, "OUTBOX_IDEMPOTENCY_UNIQUE");
  const initialOutboxClaim = await db.claimOutboundIntent(prepared[0].id);
  assert.ok(initialOutboxClaim);
  assert.equal(await db.claimOutboundIntent(prepared[0].id), null);
  pass(16, "ACTIVE_OUTBOX_LEASE_GUARD");
  await db.recoverExpiredOutboundIntents(Date.now() + 200_000);
  const reclaimedOutbox = await db.claimOutboundIntent(prepared[0].id, { now: Date.now() + 200_001 });
  assert.ok(reclaimedOutbox);
  pass(17, "EXPIRED_SENDING_LEASE_RECOVERABLE");

  const explicit = Object.assign(new Error("service unavailable"), { status: 503 });
  await assert.rejects(() => outbox.guiDurableOutbound({
    outbox: { ...reclaimedOutbox, __claimedHere: true }, conversationGeneration: genN,
    send: async () => { providerCalls += 1; throw explicit; },
  }));
  const failedOutbox = (await db.listOutbox({ generationKey: genN.durableGenerationKey }))[0];
  assert.notEqual(failedOutbox.status, "SENT");
  pass(18, "EXPLICIT_FAILURE_NOT_SENT");
  assert.ok((await db.listDurableMessageJobs({ accountId: "owner", conversationId: "N" })).every((row) => row.status !== "DONE"));
  pass(19, "FAILED_OUTBOX_MEMBERS_NON_DONE");
  assert.equal(failedOutbox.status, "RETRY"); assert.ok(failedOutbox.nextAttemptAt > Date.now());
  pass(20, "PERSISTED_RETRY_BACKOFF");

  await rawRun("UPDATE outbound_outbox SET next_attempt_at = 0 WHERE id = ?", [failedOutbox.id]);
  const successClaim = await db.claimOutboundIntent(failedOutbox.id);
  await outbox.guiDurableOutbound({
    outbox: { ...successClaim, __claimedHere: true }, conversationGeneration: genN,
    send: async (hooks = {}) => {
      providerCalls += 1;
      const providerResult = { id: "provider-1" };
      hooks.onProviderSuccess?.(providerResult);
      genN.xacNhanOutbound();
      return providerResult;
    },
  });
  assert.equal((await db.listOutbox({ generationKey: genN.durableGenerationKey }))[0].status, "SENT");
  pass(21, "PHYSICAL_SUCCESS_MARKS_SENT");
  await db.settleDurableGeneration(genN.durableGenerationKey);
  assert.ok((await db.listDurableMessageJobs({ accountId: "owner", conversationId: "N" })).every((row) => row.status === "DONE"));
  pass(22, "ALL_GENERATION_MEMBERS_DONE");
  const sentRow = (await db.listOutbox({ generationKey: genN.durableGenerationKey }))[0];
  const callsBefore = providerCalls;
  await outbox.guiDurableOutbound({ outbox: sentRow, conversationGeneration: genN, send: async () => { providerCalls += 1; } });
  assert.equal(providerCalls, callsBefore);
  pass(23, "SENT_OUTBOX_NOT_RESENT");

  const restartJob = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "R", sourceMessageId: "restart-in" });
  const dbFresh = await import(`${pathToFileURL(path.join(REPO, "lib", "db.js")).href}?restart=${nonce + 1}`);
  await dbFresh.initDb();
  assert.equal((await dbFresh.getDurableMessageJob(restartJob.id)).status, "PENDING");
  pass(24, "FRESH_DB_INSTANCE_RESUMES_INBOUND");

  const restartIntent = await db.ensureOutboundIntent({
    generationKey: "restart-key", accountId: "owner", conversationId: "R", outboundKind: "TEXT",
    outboundSlot: 0, requiredOutboundCount: 1, payload: { threadId: "R", threadType: 0, text: "restart" },
  });
  assert.equal((await dbFresh.listOutbox({ generationKey: "restart-key" }))[0].id, restartIntent.id);
  pass(25, "FRESH_DB_INSTANCE_RESUMES_OUTBOX");

  await rawRun("UPDATE durable_message_jobs SET status='PENDING', lease_until=NULL, next_attempt_at=0 WHERE id = ?", [restartJob.id]);
  let enqueued = [];
  queue.capHinhDurableDispatcher({
    layAuthority: async () => null,
    enqueue: async (item) => enqueued.push(item),
    gui: async () => null,
  });
  await queue.quetDurableNgay();
  assert.equal(enqueued.length, 0);
  pass(26, "NO_NULL_ORIGIN_BYPASS_ON_RESTART");

  const freshToken = Object.freeze({ originOwnerUid: "owner", marker: "fresh-runtime" });
  await rawRun("UPDATE durable_message_jobs SET status='PENDING', lease_until=NULL, next_attempt_at=0 WHERE id = ?", [restartJob.id]);
  await db.insertMessage("owner", inbound("restart-in", "customer", "R"));
  queue.capHinhDurableDispatcher({
    layAuthority: async () => ({ originToken: freshToken, automaticWork: { originToken: freshToken, currentEpoch: 9 } }),
    enqueue: async (item) => enqueued.push(item),
    gui: async () => null,
  });
  await queue.quetDurableNgay();
  assert.equal(enqueued.at(-1).automaticWork.originToken, freshToken);
  pass(27, "FRESH_RUNTIME_AUTHORITY_REHYDRATED");
  const columns = await db.websiteDataAll("PRAGMA table_info(durable_message_jobs)");
  assert.ok(!columns.some((column) => /origin|epoch/i.test(column.name)));
  pass(28, "NO_PERSISTED_EPOCH_ZERO_AUTHORITY");

  const offJob = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "OFF", sourceMessageId: "off-pending" });
  queue.capHinhDurableDispatcher({ layAuthority: async () => null, enqueue: async (item) => enqueued.push(item) });
  await queue.quetDurableNgay();
  assert.equal((await db.getDurableMessageJob(offJob.id)).status, "BLOCKED");
  pass(29, "CURRENT_BOT_OFF_BLOCKS_ADMITTED_WORK");
  await db.insertMessage("owner", inbound("off-pending", "customer", "OFF"));
  await rawRun("UPDATE durable_message_jobs SET next_attempt_at=0 WHERE id = ?", [offJob.id]);
  const beforeRecovery = enqueued.length;
  queue.capHinhDurableDispatcher({
    layAuthority: async () => ({ originToken: freshToken, automaticWork: { originToken: freshToken } }),
    enqueue: async (item) => enqueued.push(item),
  });
  await queue.quetDurableNgay();
  assert.equal(enqueued.length, beforeRecovery + 1);
  pass(30, "ELIGIBILITY_RECOVERY_CONTINUES_JOB");

  const outboxSource = source("lib/outbound-outbox.js");
  assert.match(outboxSource, /classifyProviderFailure/); assert.match(outboxSource, /isFailoverEligible/);
  pass(31, "CANONICAL_PROVIDER_CLASSIFIER_REUSED");
  let adminNotifications = 0;
  outbox.capHinhOutboundOutbox({ thongBaoAdmin: async () => { adminNotifications += 1; } });
  const blockedIntent = await db.ensureOutboundIntent({
    generationKey: "blocked-key", accountId: "owner", conversationId: "B", outboundKind: "TEXT",
    outboundSlot: 0, requiredOutboundCount: 1, payload: { text: "x" },
  });
  const blockedClaim = await db.claimOutboundIntent(blockedIntent.id);
  await assert.rejects(() => outbox.guiDurableOutbound({
    outbox: { ...blockedClaim, __claimedHere: true }, conversationGeneration: generation("owner", "B"),
    send: async () => { throw Object.assign(new Error("invalid api key"), { status: 401 }); },
  }));
  assert.equal(adminNotifications, 1);
  pass(32, "BLOCKED_USES_CANONICAL_ADMIN_PATH");
  assert.equal((await db.listOutbox({ generationKey: "blocked-key" }))[0].status, "BLOCKED");
  pass(33, "NO_SILENT_OUTBOUND_LOSS");
  const zaloSource = source("lib/zalo-service.js");
  assert.ok(zaloSource.indexOf("conversationGeneration?.xacNhanOutbound();") < zaloSource.indexOf("const runtimeConHieuLucSauSend"));
  assert.match(outboxSource, /const sent = await send\(\{ onProviderSuccess \}\);[\s\S]*await recordPhysicalDelivery/);
  pass(34, "P0_PHYSICAL_SUCCESS_BOUNDARY_PRESERVED");

  assert.match(source("lib/conversation-inflight.js"), /await truocGeneration\(work, generation\);[\s\S]*await chay\(work, generation\)/);
  pass(35, "KEY_ASSIGNED_AT_WORK_GENERATION_BOUNDARY");

  let releaseFirst;
  let runCount = 0;
  const multiSeen = [];
  const staleSnapshots = [];
  const multiRows = [];
  for (const id of ["ma", "mb"]) {
    const row = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "M", sourceMessageId: id });
    await db.claimDurableMessageJob(row.id); multiRows.push({ ...inbound(id, "A", "M"), __durableJobId: row.id });
  }
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const multi = taoDieuPhoiHoiThoai({
    truocGeneration: async (work, gen) => { await queue.ganDurableGenerationChoWork(work, gen); multiSeen.push({ key: gen.durableGenerationKey, segments: work.segments.length }); },
    khiStale: async (work, gen) => {
      await queue.requeueDurableStaleGeneration(work, gen);
      staleSnapshots.push(await db.listDurableMessageJobs({ accountId: "owner", conversationId: "M" }));
    },
    chay: async (_work, gen) => {
      runCount += 1;
      if (runCount === 1) {
        await db.ensureOutboundIntent({
          generationKey: gen.durableGenerationKey,
          accountId: "owner",
          conversationId: "M",
          outboundKind: "TEXT",
          outboundSlot: 0,
          requiredOutboundCount: 1,
          payload: { text: "stale reply must never send" },
        });
        await firstGate;
      } else gen.chapNhanOutbound();
    },
  });
  const firstRun = multi.them({ ownerUid: "owner", threadId: "M", tins: [multiRows[0]] });
  await new Promise((resolve) => setImmediate(resolve));
  const secondRun = multi.them({ ownerUid: "owner", threadId: "M", tins: [multiRows[1]] });
  releaseFirst(); await Promise.all([firstRun, secondRun]);
  assert.ok(multiSeen.some((item) => item.segments === 2));
  assert.equal(multiSeen.filter((item) => item.segments === 2).length, 1);
  pass(36, "MULTI_SEGMENT_SAME_SENDER_ONE_KEY");

  const owner1 = await db.admitDurableMessageJob({ accountId: "owner-1", conversationId: "GROUP", sourceMessageId: "same-msg" });
  const owner2 = await db.admitDurableMessageJob({ accountId: "owner-2", conversationId: "GROUP", sourceMessageId: "same-msg" });
  assert.notEqual(owner1.id, owner2.id); assert.notEqual(owner1.receiptKey, owner2.receiptKey);
  pass(37, "COMPOSITE_RECEIPT_OWNER_ISOLATION");

  const staleRows = await db.listDurableMessageJobs({ accountId: "owner", conversationId: "M" });
  assert.ok(staleSnapshots[0].some((row) => row.status === "PENDING" && row.generationKey === null));
  const abandonedOutbox = (await db.listOutbox({ generationKey: multiSeen[0].key }))[0];
  assert.equal(abandonedOutbox.status, "BLOCKED"); assert.equal(abandonedOutbox.lastErrorCode, "GENERATION_STALE");
  assert.equal(staleRows[0].attemptCount, 1);
  assert.ok(staleRows.every((row) => row.generationKey === multiSeen.at(-1).key));
  const finalGen = generation("owner", "M"); finalGen.durableGenerationKey = multiSeen.at(-1).key;
  await queue.hoanTatDurableGeneration({}, finalGen);
  assert.ok((await db.listDurableMessageJobs({ accountId: "owner", conversationId: "M" })).every((row) => row.status === "DONE"));
  pass(38, "STALE_REQUEUE_REASSIGNABLE_EVENTUALLY_DONE");

  const orphan = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "O", sourceMessageId: "orphan" });
  await db.claimDurableMessageJob(orphan.id, { now: 10, leaseMs: 5 });
  await db.assignDurableGeneration([orphan.id], "abandoned-generation", { now: 10, leaseMs: 5 });
  await db.recoverExpiredDurableJobs(16);
  const recoveredOrphan = await db.getDurableMessageJob(orphan.id);
  assert.equal(recoveredOrphan.status, "PENDING"); assert.equal(recoveredOrphan.generationKey, null);
  pass(39, "ORPHAN_GENERATION_SWEEP_TO_PENDING");

  // The split proof above enters directly through coordinator (the same seam
  // used by admin clarification), not ordinary gom-tin sender buckets.
  assert.deepEqual(splitSeen.map((item) => item.sender), ["A", "B"]);
  assert.equal(new Set(splitSeen.map((item) => item.key)).size, 2);
  pass(40, "REAL_COORDINATOR_SENDER_SPLIT_MEMBERSHIP");

  const regressionFailures = [];
  const regression = async (number, label, test) => {
    try {
      await test();
      pass(number, label);
    } catch (error) {
      regressionFailures.push({ number, error });
      console.error(`CASE_${number}_RESULT = FAIL: ${error?.message || error}`);
    }
  };

  await regression(41, "MULTI_BUBBLE_HARD_FAILURE_IS_CURRENT_ATTEMPT_ONLY", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C41", sourceMessageId: "c41-in",
    });
    const rows = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "bubble 0" } },
      { outboundKind: "TEXT", payload: { text: "bubble 1" } },
    ]);
    await outbox.guiDurableOutbound({
      outbox: rows[0], conversationGeneration: activeGeneration,
      send: async (hooks = {}) => {
        const providerResult = { id: "c41-provider-0" };
        hooks.onProviderSuccess?.(providerResult);
        activeGeneration.xacNhanOutbound();
        return providerResult;
      },
    });
    let propagated = null;
    try {
      await outbox.guiDurableOutbound({
        outbox: rows[1], conversationGeneration: activeGeneration,
        send: async () => { throw Object.assign(new Error("c41 provider 401"), { status: 401 }); },
      });
    } catch (error) { propagated = error; }
    const durable = await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey });
    const settled = await db.settleDurableGeneration(activeGeneration.durableGenerationKey);
    console.log(`CASE_41_OBSERVED=${JSON.stringify({ accepted: activeGeneration.accepted, propagated: propagated?.message || null, statuses: durable.map((row) => row.status), settled })}`);
    assert.equal(activeGeneration.accepted, true);
    assert.equal(propagated?.message, "c41 provider 401");
    assert.deepEqual(durable.map((row) => row.status), ["SENT", "BLOCKED"]);
    assert.equal(settled, false);
  });

  await regression(42, "PREPARE_RETURNS_FULL_ORDERED_ARRAY_WITH_ZERO_PRECLAIM", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C42", sourceMessageId: "c42-in",
    });
    const prepared = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "slot 0" } },
      { outboundKind: "TEXT", payload: { text: "slot 1" } },
      { outboundKind: "TEXT", payload: { text: "slot 2" } },
    ]);
    const durable = await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey });
    assert.equal(prepared.length, 3);
    assert.deepEqual(prepared.map((row) => row.outboundSlot), [0, 1, 2]);
    assert.deepEqual(durable.map((row) => row.status), ["PENDING", "PENDING", "PENDING"]);
    assert.equal(prepared.filter((row) => row.__claimedHere === true).length, 0);
  });

  await regression(43, "PREVIOUS_SUCCESS_CANNOT_AUTHORIZE_CURRENT_FAILURE", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C43", sourceMessageId: "c43-in",
    });
    const rows = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "first" } },
      { outboundKind: "TEXT", payload: { text: "current" } },
    ]);
    await outbox.guiDurableOutbound({
      outbox: rows[0], conversationGeneration: activeGeneration,
      send: async (hooks = {}) => {
        const providerResult = { id: "c43-provider-0" };
        hooks.onProviderSuccess?.(providerResult);
        activeGeneration.xacNhanOutbound();
        return providerResult;
      },
    });
    let propagated = null;
    try {
      await outbox.guiDurableOutbound({
        outbox: rows[1], conversationGeneration: activeGeneration,
        send: async () => { throw Object.assign(new Error("c43 current failed"), { status: 503 }); },
      });
    } catch (error) { propagated = error; }
    const current = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[1];
    console.log(`CASE_43_OBSERVED=${JSON.stringify({ acceptedFromPrevious: activeGeneration.accepted, propagated: propagated?.message || null, currentStatus: current.status })}`);
    assert.equal(propagated?.message, "c43 current failed");
    assert.equal(current.status, "RETRY");
  });

  await regression(44, "SWEEPER_CANNOT_LEAPFROG_FUTURE_RETRY", async () => {
    const generationKey = "case-44-generation";
    const rows = await db.ensureOutboundIntents({
      generationKey, accountId: "owner", conversationId: "C44",
      intents: [0, 1, 2].map((slot) => ({ outboundKind: "TEXT", payload: { text: `slot ${slot}` } })),
      now: 44_000,
    });
    await rawRun("UPDATE outbound_outbox SET status='SENT', sent_at=44000 WHERE id = ?", [rows[0].id]);
    await rawRun("UPDATE outbound_outbox SET status='RETRY', next_attempt_at=999999 WHERE id = ?", [rows[1].id]);
    await rawRun(
      "UPDATE outbound_outbox SET next_attempt_at=9007199254740991, lease_until=NULL WHERE generation_key <> ? AND status <> 'SENT'",
      [generationKey]
    );
    const claimed = await db.claimNextOutboundIntent({ now: 44_001, leaseMs: 100 });
    console.log(`CASE_44_OBSERVED=${JSON.stringify({ claimedSlot: claimed?.outboundSlot ?? null, claimedStatus: claimed?.status ?? null })}`);
    assert.equal(claimed, null);
  });

  await regression(45, "SWEEPER_CANNOT_BYPASS_BLOCKED_EARLIER_SLOT", async () => {
    const generationKey = "case-45-generation";
    const rows = await db.ensureOutboundIntents({
      generationKey, accountId: "owner", conversationId: "C45",
      intents: [0, 1, 2].map((slot) => ({ outboundKind: "TEXT", payload: { text: `slot ${slot}` } })),
      now: 45_000,
    });
    await rawRun("UPDATE outbound_outbox SET status='SENT', sent_at=45000 WHERE id = ?", [rows[0].id]);
    await rawRun("UPDATE outbound_outbox SET status='BLOCKED', next_attempt_at=999999 WHERE id = ?", [rows[1].id]);
    await rawRun(
      "UPDATE outbound_outbox SET next_attempt_at=9007199254740991, lease_until=NULL WHERE generation_key <> ? AND status <> 'SENT'",
      [generationKey]
    );
    const claimed = await db.claimNextOutboundIntent({ now: 45_001, leaseMs: 100 });
    assert.equal(claimed, null);
  });

  await regression(46, "PHYSICAL_SUCCESS_RECONCILES_SENT_WRITE_CONFLICT", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C46", sourceMessageId: "c46-in",
    });
    const [prepared] = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "physical success" } },
    ]);
    let providerCalls = 0;
    let conflict = null;
    try {
      await outbox.guiDurableOutbound({
        outbox: prepared,
        conversationGeneration: activeGeneration,
        send: async (hooks = {}) => {
          providerCalls += 1;
          hooks.onProviderSuccess?.({ id: "c46-physical-provider-id" });
          activeGeneration.xacNhanOutbound();
          await rawRun("UPDATE outbound_outbox SET status='RETRY', lease_until=NULL WHERE id = ?", [prepared.id]);
          return { id: "c46-physical-provider-id" };
        },
      });
    } catch (error) { conflict = error; }
    const current = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0];
    console.log(`CASE_46_OBSERVED=${JSON.stringify({ providerCalls, conflictCode: conflict?.code || null, status: current.status, providerMessageId: current.providerMessageId })}`);
    assert.equal(providerCalls, 1);
    assert.equal(conflict?.code, "OUTBOX_SENT_STATE_CONFLICT");
    assert.equal(current.status, "RETRY");
  });

  await regression(47, "STALE_ABANDON_AND_REQUEUE_ROLL_BACK_TOGETHER", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C47", sourceMessageId: "c47-in",
    });
    await db.ensureOutboundIntents({
      generationKey: activeGeneration.durableGenerationKey,
      accountId: "owner", conversationId: "C47",
      intents: [{ outboundKind: "TEXT", payload: { text: "unsent" } }],
    });
    await rawRun(`CREATE TEMP TRIGGER case47_abort_requeue
      BEFORE UPDATE ON durable_message_jobs
      WHEN OLD.generation_key = '${activeGeneration.durableGenerationKey}'
      BEGIN SELECT RAISE(ABORT, 'case47 forced rollback'); END`);
    let staleError = null;
    try {
      await queue.requeueDurableStaleGeneration({}, activeGeneration);
    } catch (error) { staleError = error; }
    await rawRun("DROP TRIGGER case47_abort_requeue");
    const intent = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0];
    const job = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    assert.match(staleError?.message || "", /case47 forced rollback/);
    assert.equal(intent.status, "PENDING");
    assert.equal(job.status, "PROCESSING");
    assert.equal(job.generationKey, activeGeneration.durableGenerationKey);
  });

  await regression(48, "SAFE_STALE_BEFORE_DELIVERY_ABANDONS_AND_REQUEUES", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C48", sourceMessageId: "c48-in",
    });
    const rows = await db.ensureOutboundIntents({
      generationKey: activeGeneration.durableGenerationKey,
      accountId: "owner", conversationId: "C48",
      intents: [
        { outboundKind: "TEXT", payload: { text: "pending" } },
        { outboundKind: "TEXT", payload: { text: "retry" } },
      ],
    });
    await rawRun("UPDATE outbound_outbox SET status='RETRY', next_attempt_at=48000 WHERE id = ?", [rows[1].id]);
    const requeued = await queue.requeueDurableStaleGeneration({}, activeGeneration);
    const durable = await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey });
    const job = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    assert.equal(requeued, 1);
    assert.deepEqual(durable.map((row) => row.status), ["BLOCKED", "BLOCKED"]);
    assert.ok(durable.every((row) => row.lastErrorCode === "GENERATION_STALE"));
    assert.equal(job.status, "PENDING");
    assert.equal(job.generationKey, null);
    assert.equal(job.attemptCount, 1);
  });

  await regression(49, "STALE_SENDING_GENERATION_IS_NOT_REQUEUED", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C49", sourceMessageId: "c49-in",
    });
    const [intent] = await db.ensureOutboundIntents({
      generationKey: activeGeneration.durableGenerationKey,
      accountId: "owner", conversationId: "C49",
      intents: [{ outboundKind: "TEXT", payload: { text: "sending" } }],
    });
    await db.claimOutboundIntent(intent.id);
    activeGeneration.stale = true;
    assert.equal(await queue.requeueDurableStaleGeneration({}, activeGeneration), 0);
    const durable = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0];
    const job = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    assert.equal(durable.status, "SENDING");
    assert.equal(job.status, "PROCESSING");
    assert.equal(job.generationKey, activeGeneration.durableGenerationKey);
  });

  await regression(50, "STALE_SENDING_SUCCESS_FINISHES_ORIGINAL_GENERATION", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C50", sourceMessageId: "c50-in",
    });
    const [intent] = await db.ensureOutboundIntents({
      generationKey: activeGeneration.durableGenerationKey,
      accountId: "owner", conversationId: "C50",
      intents: [{ outboundKind: "TEXT", payload: { text: "sending succeeds" } }],
    });
    const claimed = await db.claimOutboundIntent(intent.id);
    activeGeneration.stale = true;
    assert.equal(await queue.requeueDurableStaleGeneration({}, activeGeneration), 0);
    await outbox.guiDurableOutbound({
      outbox: { ...claimed, __claimedHere: true }, conversationGeneration: activeGeneration,
      send: async (hooks = {}) => {
        const providerResult = { id: "c50-provider" };
        hooks.onProviderSuccess?.(providerResult);
        activeGeneration.xacNhanOutbound();
        return providerResult;
      },
    });
    assert.equal(await db.settleDurableGeneration(activeGeneration.durableGenerationKey), true);
    const job = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    assert.equal((await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0].status, "SENT");
    assert.equal(job.status, "DONE");
    assert.equal(job.generationKey, activeGeneration.durableGenerationKey);
  });

  await regression(51, "STALE_SENDING_FAILURE_STAYS_IN_DURABLE_DELIVERY", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C51", sourceMessageId: "c51-in",
    });
    const [intent] = await db.ensureOutboundIntents({
      generationKey: activeGeneration.durableGenerationKey,
      accountId: "owner", conversationId: "C51",
      intents: [{ outboundKind: "TEXT", payload: { text: "sending fails" } }],
    });
    const claimed = await db.claimOutboundIntent(intent.id);
    activeGeneration.stale = true;
    assert.equal(await queue.requeueDurableStaleGeneration({}, activeGeneration), 0);
    await assert.rejects(() => outbox.guiDurableOutbound({
      outbox: { ...claimed, __claimedHere: true }, conversationGeneration: activeGeneration,
      send: async () => { throw Object.assign(new Error("c51 transient"), { status: 503 }); },
    }), /c51 transient/);
    assert.equal(await db.settleDurableGeneration(activeGeneration.durableGenerationKey), false);
    const durable = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0];
    const job = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    assert.equal(durable.status, "RETRY");
    assert.equal(job.status, "WAITING_OUTBOX");
    assert.equal(job.generationKey, activeGeneration.durableGenerationKey);
  });

  await regression(52, "SENT_GENERATION_IS_NEVER_REQUEUED_AS_FRESH_WORK", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C52", sourceMessageId: "c52-in",
    });
    const [intent] = await db.ensureOutboundIntents({
      generationKey: activeGeneration.durableGenerationKey,
      accountId: "owner", conversationId: "C52",
      intents: [{ outboundKind: "TEXT", payload: { text: "already sent" } }],
    });
    const claimed = await db.claimOutboundIntent(intent.id);
    assert.equal(await db.markOutboundSent(claimed.id, "c52-provider"), true);
    activeGeneration.stale = true;
    assert.equal(await queue.requeueDurableStaleGeneration({}, activeGeneration), 0);
    const jobBeforeSettle = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    assert.equal(jobBeforeSettle.status, "PROCESSING");
    assert.equal(jobBeforeSettle.generationKey, activeGeneration.durableGenerationKey);
    assert.equal(await db.settleDurableGeneration(activeGeneration.durableGenerationKey), true);
    assert.equal((await db.getDurableMessageJob(activeGeneration.durableJobIds[0])).status, "DONE");
  });

  await regression(53, "SHARED_CONNECTION_TRANSACTIONS_SERIALIZE", async () => {
    const job = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "C53", sourceMessageId: "c53-in" });
    let releaseOwner;
    let ownerEntered;
    const ownerReady = new Promise((resolve) => { ownerEntered = resolve; });
    const ownerBarrier = new Promise((resolve) => { releaseOwner = resolve; });
    const transactionA = db.withWebsiteDataTransaction(async ({ run: txRun }) => {
      await txRun("INSERT OR REPLACE INTO app_secrets (key, value) VALUES ('case53-owner', 'A')");
      ownerEntered();
      await ownerBarrier;
    });
    await ownerReady;
    let transactionBSettled = false;
    let transactionBError = null;
    const transactionB = db.claimDurableMessageJob(job.id).catch((error) => {
      transactionBError = error;
      return null;
    }).finally(() => { transactionBSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    const settledWhileAOwned = transactionBSettled;
    releaseOwner();
    await Promise.all([transactionA, transactionB]);
    const claimed = await db.getDurableMessageJob(job.id);
    console.log(`CASE_53_OBSERVED=${JSON.stringify({ settledWhileAOwned, transactionBError: transactionBError?.message || null, finalStatus: claimed.status })}`);
    assert.equal(settledWhileAOwned, false);
    assert.equal(transactionBError, null);
    assert.equal(claimed.status, "PROCESSING");
  });

  await regression(54, "ROLLBACK_ISOLATION_ON_SHARED_CONNECTION", async () => {
    const job = await db.admitDurableMessageJob({ accountId: "owner", conversationId: "C54", sourceMessageId: "c54-in" });
    let releaseOwner;
    let ownerEntered;
    const ownerReady = new Promise((resolve) => { ownerEntered = resolve; });
    const ownerBarrier = new Promise((resolve) => { releaseOwner = resolve; });
    const transactionA = db.withWebsiteDataTransaction(async ({ run: txRun }) => {
      await txRun("INSERT OR REPLACE INTO app_secrets (key, value) VALUES ('case54-owner', 'must-rollback')");
      ownerEntered();
      await ownerBarrier;
      throw new Error("case54 owner failure");
    });
    await ownerReady;
    let transactionBSettled = false;
    let transactionBError = null;
    const transactionB = db.claimDurableMessageJob(job.id).catch((error) => {
      transactionBError = error;
      return null;
    }).finally(() => { transactionBSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    const settledWhileAOwned = transactionBSettled;
    releaseOwner();
    const [ownerResult] = await Promise.allSettled([transactionA, transactionB]);
    const marker = await rawGet("SELECT value FROM app_secrets WHERE key='case54-owner'");
    const claimed = await db.getDurableMessageJob(job.id);
    console.log(`CASE_54_OBSERVED=${JSON.stringify({ settledWhileAOwned, ownerRejected: ownerResult.status === "rejected", transactionBError: transactionBError?.message || null, marker: marker?.value || null, finalStatus: claimed.status })}`);
    assert.equal(settledWhileAOwned, false);
    assert.equal(ownerResult.status, "rejected");
    assert.equal(transactionBError, null);
    assert.equal(marker, undefined);
    assert.equal(claimed.status, "PROCESSING");
  });

  await regression(55, "V23_SCHEMA_AND_CAS_CONTRACT_UNCHANGED", async () => {
    const columns = await db.websiteDataAll("PRAGMA table_info(outbound_outbox)");
    const names = columns.map((column) => column.name);
    assert.equal(names.includes("send_started_at"), false);
    assert.equal(names.includes("delivery_started"), false);
    assert.equal(names.length, 18);
    const dbSource = source("lib/db.js");
    const claimSource = dbSource.slice(
      dbSource.indexOf("export async function claimNextOutboundIntent"),
      dbSource.indexOf("export async function markOutboundSent")
    );
    assert.match(claimSource, /NOT EXISTS[\s\S]*previous\.status <> 'SENT'/);
    assert.match(claimSource, /UPDATE outbound_outbox SET status = 'SENDING'[\s\S]*WHERE id = \? AND status IN \('PENDING','RETRY','BLOCKED'\)[\s\S]*next_attempt_at <= \? AND \(lease_until IS NULL OR lease_until <= \?\)/);
  });

  await regression(56, "DELAY_SCHEDULE_CLOSES_INTER_BUBBLE_SWEEPER_GAP", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C56", sourceMessageId: "c56-in",
    });
    const rows = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "slot 0" } },
      { outboundKind: "TEXT", payload: { text: "slot 1" } },
    ]);
    await rawRun(
      "UPDATE outbound_outbox SET next_attempt_at=9007199254740991, lease_until=NULL WHERE generation_key <> ? AND status <> 'SENT'",
      [activeGeneration.durableGenerationKey]
    );
    let sweeperCalls = 0;
    let inProcessSlot1Calls = 0;
    outbox.capHinhOutboundOutbox({
      layAuthority: async () => ({ originToken: { ownerUid: "owner" } }),
      gui: async (_row, _authority, hooks = {}) => {
        sweeperCalls += 1;
        const providerResult = { id: "c56-sweeper" };
        hooks.onProviderSuccess?.(providerResult);
        return providerResult;
      },
    });
    await outbox.guiDurableOutbound({
      outbox: rows[0], conversationGeneration: activeGeneration, nextAttemptDelayMs: 40,
      send: async (hooks = {}) => {
        const providerResult = { id: "c56-provider-0" };
        hooks.onProviderSuccess?.(providerResult);
        activeGeneration.xacNhanOutbound();
        return providerResult;
      },
    });
    const sweeperHandled = await outbox.quetOutboundNgay({ max: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    let inProcessError = null;
    try {
      await outbox.guiDurableOutbound({
        outbox: rows[1], conversationGeneration: activeGeneration,
        send: async (hooks = {}) => {
          inProcessSlot1Calls += 1;
          const providerResult = { id: "c56-provider-1" };
          hooks.onProviderSuccess?.(providerResult);
          return providerResult;
        },
      });
    } catch (error) { inProcessError = error; }
    const durable = await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey });
    console.log(`CASE_56_OBSERVED=${JSON.stringify({ sweeperHandled, sweeperCalls, inProcessSlot1Calls, inProcessError: inProcessError?.code || null, statuses: durable.map((row) => row.status) })}`);
    assert.equal(sweeperHandled, 0);
    assert.equal(sweeperCalls, 0);
    assert.equal(inProcessError, null);
    assert.equal(inProcessSlot1Calls, 1);
    assert.deepEqual(durable.map((row) => row.status), ["SENT", "SENT"]);
  });

  await regression(57, "LIVE_AUTHORITY_REJECTION_SENTINEL_IS_NOT_DELIVERY", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C57", sourceMessageId: "c57-in",
    });
    const [prepared] = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "sentinel" } },
    ]);
    let providerCalls = 0;
    const result = await outbox.guiDurableOutbound({
      outbox: prepared,
      conversationGeneration: activeGeneration,
      send: async () => ({ authorityRejectedBeforeProvider: true }),
    });
    const current = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0];
    const settled = await db.settleDurableGeneration(activeGeneration.durableGenerationKey);
    const job = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    console.log(`CASE_57_OBSERVED=${JSON.stringify({ providerCalls, result, status: current.status, attemptCount: current.attemptCount, settled, jobStatus: job.status })}`);
    assert.equal(result?.authorityRejectedBeforeProvider, true);
    assert.equal(providerCalls, 0);
    assert.equal(current.status, "PENDING");
    assert.equal(current.attemptCount, 0);
    assert.ok(current.nextAttemptAt > 0);
    assert.equal(settled, false);
    assert.notEqual(job.status, "DONE");
  });

  await regression(58, "FINAL_SLOT_SENTINEL_CANNOT_SETTLE_GENERATION", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C58", sourceMessageId: "c58-in",
    });
    const rows = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "delivered" } },
      { outboundKind: "TEXT", payload: { text: "rejected" } },
    ]);
    let providerCalls = 0;
    await outbox.guiDurableOutbound({
      outbox: rows[0], conversationGeneration: activeGeneration,
      send: async (hooks = {}) => {
        providerCalls += 1;
        const providerResult = { id: "c58-provider-0" };
        hooks.onProviderSuccess?.(providerResult);
        activeGeneration.xacNhanOutbound();
        return providerResult;
      },
    });
    await outbox.guiDurableOutbound({
      outbox: rows[1], conversationGeneration: activeGeneration,
      send: async () => ({ authorityRejectedBeforeProvider: true }),
    });
    const durable = await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey });
    const settled = await db.settleDurableGeneration(activeGeneration.durableGenerationKey);
    const job = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    console.log(`CASE_58_OBSERVED=${JSON.stringify({ providerCalls, statuses: durable.map((row) => row.status), settled, jobStatus: job.status })}`);
    assert.equal(providerCalls, 1);
    assert.deepEqual(durable.map((row) => row.status), ["SENT", "PENDING"]);
    assert.equal(settled, false);
    assert.notEqual(job.status, "DONE");
  });

  await regression(59, "SWEEPER_SENTINEL_IS_NOT_SENT_OR_DONE", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C59", sourceMessageId: "c59-in",
    });
    await db.ensureOutboundIntents({
      generationKey: activeGeneration.durableGenerationKey,
      accountId: "owner", conversationId: "C59",
      intents: [{ outboundKind: "TEXT", payload: { text: "sweeper sentinel" } }],
    });
    await rawRun(
      "UPDATE outbound_outbox SET next_attempt_at=9007199254740991, lease_until=NULL WHERE generation_key <> ? AND status <> 'SENT'",
      [activeGeneration.durableGenerationKey]
    );
    let providerCalls = 0;
    outbox.capHinhOutboundOutbox({
      layAuthority: async () => ({ originToken: { ownerUid: "owner" } }),
      gui: async () => ({ authorityRejectedBeforeProvider: true }),
    });
    const handled = await outbox.quetOutboundNgay({ max: 1 });
    const current = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0];
    const job = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    console.log(`CASE_59_OBSERVED=${JSON.stringify({ handled, providerCalls, status: current.status, jobStatus: job.status })}`);
    assert.equal(handled, 1);
    assert.equal(providerCalls, 0);
    assert.equal(current.status, "PENDING");
    assert.notEqual(job.status, "DONE");
  });

  await regression(60, "TEXT_PROVIDER_SUCCESS_SURVIVES_LOCAL_POST_FAILURE", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C60", sourceMessageId: "c60-in",
    });
    const [prepared] = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "provider success then local fail" } },
    ]);
    let providerCalls = 0;
    let providerBoundaryFired = false;
    let localError = null;
    try {
      await outbox.guiDurableOutbound({
        outbox: prepared,
        conversationGeneration: activeGeneration,
        send: async (hooks = {}) => {
          providerCalls += 1;
          const providerResult = { id: "c60-provider" };
          providerBoundaryFired = true;
          hooks.onProviderSuccess?.(providerResult);
          activeGeneration.xacNhanOutbound();
          throw new Error("c60 local persistence failed");
        },
      });
    } catch (error) { localError = error; }
    const current = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0];
    console.log(`CASE_60_OBSERVED=${JSON.stringify({ providerCalls, providerBoundaryFired, status: current.status, error: localError?.message || null, providerSucceeded: localError?.providerSucceeded || false, recorded: localError?.outboxDeliveryRecorded || false })}`);
    assert.equal(providerBoundaryFired, true);
    assert.equal(providerCalls, 1);
    assert.equal(current.status, "SENT");
    assert.equal(current.providerMessageId, "c60-provider");
    assert.equal(localError?.message, "c60 local persistence failed");
    assert.equal(localError?.providerSucceeded, true);
    assert.equal(localError?.outboxDeliveryRecorded, true);
  });

  await regression(61, "REACTION_PROVIDER_SUCCESS_SURVIVES_LOCAL_POST_FAILURE", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C61", sourceMessageId: "c61-in",
    });
    const [prepared] = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "REACTION", payload: { icon: "HEART" } },
    ]);
    let providerCalls = 0;
    let providerBoundaryFired = false;
    let localError = null;
    try {
      await outbox.guiDurableOutbound({
        outbox: prepared,
        conversationGeneration: activeGeneration,
        send: async (hooks = {}) => {
          providerCalls += 1;
          const providerResult = { id: "c61-reaction" };
          providerBoundaryFired = true;
          hooks.onProviderSuccess?.(providerResult);
          activeGeneration.xacNhanOutbound();
          throw new Error("c61 reaction post-step failed");
        },
      });
    } catch (error) { localError = error; }
    const current = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0];
    console.log(`CASE_61_OBSERVED=${JSON.stringify({ providerCalls, providerBoundaryFired, status: current.status, error: localError?.message || null, recorded: localError?.outboxDeliveryRecorded || false })}`);
    assert.equal(providerBoundaryFired, true);
    assert.equal(providerCalls, 1);
    assert.equal(current.status, "SENT");
    assert.equal(current.providerMessageId, "c61-reaction");
    assert.equal(localError?.message, "c61 reaction post-step failed");
    assert.equal(localError?.outboxDeliveryRecorded, true);
  });

  await regression(62, "MARK_SENT_WAITS_OUTER_ROLLBACK_AND_PERSISTS", async () => {
    const intent = await db.ensureOutboundIntent({
      generationKey: "case-62-generation", accountId: "owner", conversationId: "C62",
      outboundKind: "TEXT", outboundSlot: 0, requiredOutboundCount: 1, payload: { text: "cross rollback" },
    });
    await db.claimOutboundIntent(intent.id);
    let releaseOwner;
    let ownerEntered;
    const ownerReady = new Promise((resolve) => { ownerEntered = resolve; });
    const ownerBarrier = new Promise((resolve) => { releaseOwner = resolve; });
    const transactionA = db.withWebsiteDataTransaction(async ({ run: txRun }) => {
      await txRun("INSERT OR REPLACE INTO app_secrets (key, value) VALUES ('case62-owner', 'must-rollback')");
      ownerEntered();
      await ownerBarrier;
      throw new Error("case62 outer rollback");
    });
    await ownerReady;
    let markSettled = false;
    let markResult = null;
    let markError = null;
    const markPromise = db.markOutboundSent(intent.id, "c62-provider").then((value) => {
      markResult = value;
      return value;
    }).catch((error) => {
      markError = error;
      return null;
    }).finally(() => { markSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    const settledWhileAOwned = markSettled;
    const visibleWhileAOwned = (await db.listOutbox({ generationKey: "case-62-generation" }))[0].status;
    releaseOwner();
    const [ownerResult] = await Promise.allSettled([transactionA, markPromise]);
    const final = (await db.listOutbox({ generationKey: "case-62-generation" }))[0];
    console.log(`CASE_62_OBSERVED=${JSON.stringify({ settledWhileAOwned, visibleWhileAOwned, ownerRejected: ownerResult.status === "rejected", markResult, markError: markError?.message || null, finalStatus: final.status })}`);
    assert.equal(settledWhileAOwned, false);
    assert.equal(ownerResult.status, "rejected");
    assert.equal(markError, null);
    assert.equal(markResult, true);
    assert.equal(final.status, "SENT");
    assert.equal(final.providerMessageId, "c62-provider");
  });

  await regression(63, "PREPARE_DURABLES_ALL_INTENTS_WITH_ZERO_PRECLAIM", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C63", sourceMessageId: "c63-in",
    });
    let providerCalls = 0;
    const prepared = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "slot 0" } },
      { outboundKind: "TEXT", payload: { text: "slot 1" } },
    ]);
    const durable = await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey });
    console.log(`CASE_63_OBSERVED=${JSON.stringify({ providerCalls, returned: prepared.length, statuses: durable.map((row) => row.status) })}`);
    assert.equal(providerCalls, 0);
    assert.equal(prepared.length, 2);
    assert.deepEqual(prepared.map((row) => row.outboundSlot), [0, 1]);
    assert.deepEqual(durable.map((row) => row.status), ["PENDING", "PENDING"]);
  });

  await regression(64, "NEXT_SLOT_STAYS_PENDING_DURING_TYPING_DELAY", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C64", sourceMessageId: "c64-in",
    });
    const rows = await outbox.chuanBiDurableOutbox(activeGeneration, [
      { outboundKind: "TEXT", payload: { text: "slot 0" } },
      { outboundKind: "TEXT", payload: { text: "slot 1" } },
    ]);
    await rawRun(
      "UPDATE outbound_outbox SET next_attempt_at=9007199254740991, lease_until=NULL WHERE generation_key <> ? AND status <> 'SENT'",
      [activeGeneration.durableGenerationKey]
    );
    let slot1ProviderCalls = 0;
    outbox.capHinhOutboundOutbox({
      layAuthority: async () => ({ originToken: { ownerUid: "owner" } }),
      gui: async () => { slot1ProviderCalls += 1; return { id: "c64-early" }; },
    });
    await outbox.guiDurableOutbound({
      outbox: rows[0], conversationGeneration: activeGeneration, nextAttemptDelayMs: 40,
      send: async (hooks = {}) => {
        const providerResult = { id: "c64-provider-0" };
        hooks.onProviderSuccess?.(providerResult);
        activeGeneration.xacNhanOutbound();
        return providerResult;
      },
    });
    const beforeDelay = await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey });
    const sweptBeforeDelay = await outbox.quetOutboundNgay({ max: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await outbox.guiDurableOutbound({
      outbox: rows[1], conversationGeneration: activeGeneration,
      send: async (hooks = {}) => {
        slot1ProviderCalls += 1;
        const providerResult = { id: "c64-provider-1" };
        hooks.onProviderSuccess?.(providerResult);
        return providerResult;
      },
    });
    const afterDelay = await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey });
    console.log(`CASE_64_OBSERVED=${JSON.stringify({ beforeStatuses: beforeDelay.map((row) => row.status), nextAttemptAt: beforeDelay[1].nextAttemptAt, sweptBeforeDelay, slot1ProviderCalls, afterStatuses: afterDelay.map((row) => row.status) })}`);
    assert.deepEqual(beforeDelay.map((row) => row.status), ["SENT", "PENDING"]);
    assert.ok(beforeDelay[1].nextAttemptAt > Date.now() - 50);
    assert.equal(sweptBeforeDelay, 0);
    assert.equal(slot1ProviderCalls, 1);
    assert.deepEqual(afterDelay.map((row) => row.status), ["SENT", "SENT"]);
  });

  await regression(65, "MISSING_SWEEPER_GUI_FAILS_CLOSED", async () => {
    const activeGeneration = await realDurableGeneration({
      db, queue, taoDieuPhoiHoiThoai,
      accountId: "owner", conversationId: "C65", sourceMessageId: "c65-in",
    });
    await db.ensureOutboundIntents({
      generationKey: activeGeneration.durableGenerationKey,
      accountId: "owner", conversationId: "C65",
      intents: [{ outboundKind: "TEXT", payload: { text: "missing gui" } }],
    });
    await rawRun(
      "UPDATE outbound_outbox SET next_attempt_at=9007199254740991, lease_until=NULL WHERE generation_key <> ? AND status <> 'SENT'",
      [activeGeneration.durableGenerationKey]
    );
    let runtimeFailures = 0;
    outbox.capHinhOutboundOutbox({
      layAuthority: async () => ({ originToken: { ownerUid: "owner" } }),
      gui: null,
      thongBaoAdmin: async () => { runtimeFailures += 1; },
    });
    const handled = await outbox.quetOutboundNgay({ max: 1 });
    const current = (await db.listOutbox({ generationKey: activeGeneration.durableGenerationKey }))[0];
    const job = await db.getDurableMessageJob(activeGeneration.durableJobIds[0]);
    console.log(`CASE_65_OBSERVED=${JSON.stringify({ handled, runtimeFailures, status: current.status, jobStatus: job.status })}`);
    assert.equal(handled, 1);
    assert.equal(runtimeFailures, 1);
    assert.equal(current.status, "PENDING");
    assert.notEqual(job.status, "DONE");
  });

  await regression(66, "ALL_DURABLE_MUTATIONS_PARTICIPATE_IN_SHARED_ARBITER", async () => {
    const dbSource = source("lib/db.js");
    const mutationFunctions = [
      "admitDurableMessageJob", "claimDurableMessageJob", "claimNextDurableMessageJobs",
      "assignDurableGeneration", "requeueDurableGeneration", "requeueStaleDurableGeneration",
      "markDurableJobsBlocked", "markDurableGenerationFailure", "settleDurableGeneration",
      "recoverExpiredDurableJobs", "expireDurableWork", "ensureOutboundIntent", "ensureOutboundIntents",
      "claimOutboundIntent", "claimNextOutboundIntent", "markOutboundSent", "markOutboundFailure",
      "releaseOutboundIntent", "recoverExpiredOutboundIntents",
      "abandonOutboundGeneration",
    ];
    const unprotected = [];
    for (const [index, name] of mutationFunctions.entries()) {
      const start = dbSource.indexOf(`export async function ${name}`);
      assert.ok(start >= 0, `missing durable mutation function ${name}`);
      const nextStarts = mutationFunctions
        .slice(index + 1)
        .map((nextName) => dbSource.indexOf(`export async function ${nextName}`, start + 1))
        .filter((position) => position > start);
      const genericNext = dbSource.indexOf("export async function ", start + 1);
      const end = Math.min(...[genericNext, ...nextStarts].filter((position) => position > start));
      const body = dbSource.slice(start, Number.isFinite(end) ? end : dbSource.length);
      if (!/withDurableWrite\(/.test(body)) unprotected.push(name);
    }
    console.log(`CASE_66_OBSERVED=${JSON.stringify({ mutationFunctions, unprotected })}`);
    assert.deepEqual(unprotected, []);
  });

  const policyFixture = async (caseNumber, { slots = 1, admittedAt = Date.now() } = {}) => {
    const accountId = `owner-${caseNumber}`;
    const conversationId = `C${caseNumber}`;
    const generationKey = `case-${caseNumber}-generation`;
    const job = await db.admitDurableMessageJob({
      accountId,
      conversationId,
      sourceMessageId: `c${caseNumber}-in`,
      admittedAt,
    });
    const fixtureNow = Math.max(1, Number(admittedAt) + 1);
    await db.claimDurableMessageJob(job.id, { now: fixtureNow, leaseMs: 3_600_000 });
    await db.assignDurableGeneration([job.id], generationKey, { now: fixtureNow, leaseMs: 3_600_000 });
    const rows = await db.ensureOutboundIntents({
      generationKey,
      accountId,
      conversationId,
      intents: Array.from({ length: slots }, (_, outboundSlot) => ({
        outboundKind: "TEXT",
        payload: { text: `case ${caseNumber} slot ${outboundSlot}` },
      })),
      now: fixtureNow,
    });
    const activeGeneration = generation(accountId, conversationId);
    activeGeneration.durableGenerationKey = generationKey;
    activeGeneration.durableJobIds = [job.id];
    activeGeneration.durableOutboxPrepared = true;
    return { accountId, conversationId, generationKey, job, rows, activeGeneration };
  };

  const failPolicyAttempt = async (fixture, row, error) => {
    let surfaced = null;
    try {
      await outbox.guiDurableOutbound({
        outbox: row,
        conversationGeneration: fixture.activeGeneration,
        send: async () => { throw error; },
      });
    } catch (caught) {
      surfaced = caught;
    }
    return surfaced;
  };

  await regression(67, "DEFAULT_FAILURE_BELOW_CAP_STAYS_RETRYABLE", async () => {
    const fixture = await policyFixture(67);
    await rawRun("UPDATE outbound_outbox SET attempt_count=4 WHERE id=?", [fixture.rows[0].id]);
    await failPolicyAttempt(fixture, { ...fixture.rows[0], attemptCount: 4 }, Object.assign(new Error("c67 unavailable"), { status: 503 }));
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    console.log(`CASE_67_OBSERVED=${JSON.stringify({ status: row.status, attemptCount: row.attemptCount })}`);
    assert.equal(row.attemptCount, 5);
    assert.equal(row.status, "RETRY");
  });

  await regression(68, "DEFAULT_FAILURE_TERMINAL_AT_EXACTLY_SIX", async () => {
    const fixture = await policyFixture(68);
    await rawRun("UPDATE outbound_outbox SET attempt_count=5 WHERE id=?", [fixture.rows[0].id]);
    await failPolicyAttempt(fixture, { ...fixture.rows[0], attemptCount: 5 }, Object.assign(new Error("c68 unavailable"), { status: 503 }));
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    const job = await db.getDurableMessageJob(fixture.job.id);
    console.log(`CASE_68_OBSERVED=${JSON.stringify({ status: row.status, attemptCount: row.attemptCount, jobStatus: job.status })}`);
    assert.equal(row.attemptCount, 6);
    assert.equal(row.status, "FAILED_TERMINAL");
    assert.equal(job.status, "FAILED_TERMINAL");
  });

  await regression(69, "FAILED_TERMINAL_PREVENTS_SEVENTH_PROVIDER_CALL", async () => {
    const fixture = await policyFixture(69);
    await rawRun("UPDATE outbound_outbox SET attempt_count=5 WHERE id=?", [fixture.rows[0].id]);
    let providerCalls = 5;
    await failPolicyAttempt(fixture, { ...fixture.rows[0], attemptCount: 5 }, Object.assign(new Error("c69 sixth failed"), { status: 503 }));
    providerCalls += 1;
    await rawRun(
      "UPDATE outbound_outbox SET next_attempt_at=9007199254740991 WHERE generation_key<>? AND status IN ('PENDING','RETRY','BLOCKED')",
      [fixture.generationKey]
    );
    await rawRun("UPDATE outbound_outbox SET next_attempt_at=0 WHERE generation_key=? AND status IN ('PENDING','RETRY','BLOCKED')", [fixture.generationKey]);
    outbox.capHinhOutboundOutbox({
      layAuthority: async () => ({ originToken: { ownerUid: fixture.accountId } }),
      gui: async (_row, _authority, hooks = {}) => {
        providerCalls += 1;
        const result = { id: "c69-seventh" };
        hooks.onProviderSuccess?.(result);
        return result;
      },
    });
    await outbox.quetOutboundNgay({ max: 1 });
    console.log(`CASE_69_OBSERVED=${JSON.stringify({ providerCalls, status: (await db.listOutbox({ generationKey: fixture.generationKey }))[0].status })}`);
    assert.equal(providerCalls, 6);
  });

  await regression(70, "CREDENTIAL_CONTROL_FIRST_FAILURE_ALLOWS_SECOND_ATTEMPT", async () => {
    const fixture = await policyFixture(70);
    await failPolicyAttempt(fixture, fixture.rows[0], Object.assign(new Error("owner context changed"), { code: "OWNER_CONTEXT_CHANGED" }));
    let row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    await rawRun("UPDATE outbound_outbox SET next_attempt_at=0 WHERE id=?", [row.id]);
    const secondClaim = await db.claimOutboundIntent(row.id);
    console.log(`CASE_70_OBSERVED=${JSON.stringify({ status: row.status, attemptCount: row.attemptCount, secondClaimed: Boolean(secondClaim) })}`);
    assert.equal(row.attemptCount, 1);
    assert.notEqual(row.status, "FAILED_TERMINAL");
    assert.ok(secondClaim);
    await rawRun("UPDATE outbound_outbox SET status='BLOCKED', lease_until=NULL, next_attempt_at=9007199254740991 WHERE id=?", [row.id]);
  });

  await regression(71, "CREDENTIAL_CONTROL_TERMINAL_AT_EXACTLY_TWO", async () => {
    const fixture = await policyFixture(71);
    await rawRun("UPDATE outbound_outbox SET attempt_count=1 WHERE id=?", [fixture.rows[0].id]);
    await failPolicyAttempt(fixture, { ...fixture.rows[0], attemptCount: 1 }, Object.assign(new Error("owner context changed"), { code: "OWNER_CONTEXT_CHANGED" }));
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    console.log(`CASE_71_OBSERVED=${JSON.stringify({ status: row.status, attemptCount: row.attemptCount })}`);
    assert.equal(row.attemptCount, 2);
    assert.equal(row.status, "FAILED_TERMINAL");
  });

  await regression(72, "MIXED_FAILURE_USES_CURRENT_CREDENTIAL_CAP", async () => {
    const fixture = await policyFixture(72);
    await failPolicyAttempt(fixture, fixture.rows[0], Object.assign(new Error("first unavailable"), { status: 503 }));
    let row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    await rawRun("UPDATE outbound_outbox SET next_attempt_at=0 WHERE id=?", [row.id]);
    row = await db.claimOutboundIntent(row.id);
    await failPolicyAttempt(fixture, { ...row, __claimedHere: true }, Object.assign(new Error("owner context changed"), { code: "OWNER_CONTEXT_CHANGED" }));
    row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    console.log(`CASE_72_OBSERVED=${JSON.stringify({ status: row.status, attemptCount: row.attemptCount })}`);
    assert.equal(row.attemptCount, 2);
    assert.equal(row.status, "FAILED_TERMINAL");
  });

  await regression(73, "PRE_PROVIDER_SENTINELS_DO_NOT_CONSUME_ATTEMPT_CAP", async () => {
    const fixture = await policyFixture(73);
    let providerCalls = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await rawRun("UPDATE outbound_outbox SET next_attempt_at=0 WHERE id=?", [fixture.rows[0].id]);
      const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
      await outbox.guiDurableOutbound({
        outbox: row,
        conversationGeneration: fixture.activeGeneration,
        send: async () => ({ authorityRejectedBeforeProvider: true }),
      });
    }
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    console.log(`CASE_73_OBSERVED=${JSON.stringify({ providerCalls, status: row.status, attemptCount: row.attemptCount })}`);
    assert.equal(providerCalls, 0);
    assert.equal(row.attemptCount, 0);
    assert.notEqual(row.status, "FAILED_TERMINAL");
  });

  await regression(74, "SIXTH_DEFAULT_ATTEMPT_MAY_SUCCEED", async () => {
    const fixture = await policyFixture(74);
    await rawRun("UPDATE outbound_outbox SET attempt_count=5 WHERE id=?", [fixture.rows[0].id]);
    let providerCalls = 5;
    await outbox.guiDurableOutbound({
      outbox: { ...fixture.rows[0], attemptCount: 5 },
      conversationGeneration: fixture.activeGeneration,
      send: async (hooks = {}) => {
        providerCalls += 1;
        const result = { id: "c74-sixth-success" };
        hooks.onProviderSuccess?.(result);
        return result;
      },
    });
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    console.log(`CASE_74_OBSERVED=${JSON.stringify({ providerCalls, status: row.status, attemptCount: row.attemptCount })}`);
    assert.equal(providerCalls, 6);
    assert.equal(row.status, "SENT");
  });

  await regression(75, "MULTI_BUBBLE_CAP_TERMINALIZATION_SURVIVES_SETTLE", async () => {
    const fixture = await policyFixture(75, { slots: 3 });
    await rawRun("UPDATE outbound_outbox SET status='SENT', sent_at=75000 WHERE id=?", [fixture.rows[0].id]);
    await rawRun("UPDATE outbound_outbox SET attempt_count=5 WHERE id=?", [fixture.rows[1].id]);
    await failPolicyAttempt(fixture, { ...fixture.rows[1], attemptCount: 5 }, Object.assign(new Error("c75 unavailable"), { status: 503 }));
    const beforeSettle = await db.listOutbox({ generationKey: fixture.generationKey });
    await db.settleDurableGeneration(fixture.generationKey);
    const job = await db.getDurableMessageJob(fixture.job.id);
    console.log(`CASE_75_OBSERVED=${JSON.stringify({ statuses: beforeSettle.map((row) => row.status), jobStatus: job.status })}`);
    assert.deepEqual(beforeSettle.map((row) => row.status), ["SENT", "FAILED_TERMINAL", "FAILED_TERMINAL"]);
    assert.equal(job.status, "FAILED_TERMINAL");
  });

  await regression(76, "TERMINAL_POLICY_NOTIFICATION_AT_MOST_ONCE", async () => {
    const fixture = await policyFixture(76);
    await rawRun("UPDATE outbound_outbox SET attempt_count=5 WHERE id=?", [fixture.rows[0].id]);
    let terminalPolicyNotifications = 0;
    outbox.capHinhOutboundOutbox({
      thongBaoAdmin: async (notice) => { if (notice?.terminalPolicy === true) terminalPolicyNotifications += 1; },
      layAuthority: async () => null,
      gui: null,
    });
    await failPolicyAttempt(fixture, { ...fixture.rows[0], attemptCount: 5 }, Object.assign(new Error("c76 unavailable"), { status: 503 }));
    await outbox.quetOutboundNgay({ max: 1 });
    await outbox.quetOutboundNgay({ max: 1 });
    console.log(`CASE_76_OBSERVED=${JSON.stringify({ terminalPolicyNotifications })}`);
    assert.equal(terminalPolicyNotifications, 1);
  });

  await regression(77, "REPLAY_AGE_1799999_REMAINS_ELIGIBLE", async () => {
    const now = 20_000_000;
    const job = await db.admitDurableMessageJob({ accountId: "owner-77", conversationId: "C77", sourceMessageId: "c77-in", admittedAt: now - 1_799_999 });
    assert.equal(typeof db.expireDurableWork, "function");
    const result = await db.expireDurableWork({ now, limit: 100 });
    const current = await db.getDurableMessageJob(job.id);
    console.log(`CASE_77_OBSERVED=${JSON.stringify({ status: current.status, expiredJobs: result.expiredJobs })}`);
    assert.equal(current.status, "PENDING");
  });

  await regression(78, "REPLAY_AGE_EXACT_1800000_EXPIRES", async () => {
    const now = 21_000_000;
    const job = await db.admitDurableMessageJob({ accountId: "owner-78", conversationId: "C78", sourceMessageId: "c78-in", admittedAt: now - 1_800_000 });
    assert.equal(typeof db.expireDurableWork, "function");
    await db.expireDurableWork({ now, limit: 100 });
    const current = await db.getDurableMessageJob(job.id);
    console.log(`CASE_78_OBSERVED=${JSON.stringify({ status: current.status })}`);
    assert.equal(current.status, "EXPIRED");
  });

  await regression(79, "BOT_OFF_31_MIN_JOB_EXPIRES_AND_NEVER_REPLAYS", async () => {
    const now = 22_000_000;
    const job = await db.admitDurableMessageJob({ accountId: "owner-79", conversationId: "C79", sourceMessageId: "c79-in", admittedAt: now - 31 * 60_000 });
    let providerCalls = 0;
    queue.capHinhDurableDispatcher({ layAuthority: async () => null, enqueue: async () => { providerCalls += 1; }, gui: null });
    await queue.quetDurableNgay({ now });
    queue.capHinhDurableDispatcher({
      layAuthority: async () => ({ originToken: { ownerUid: "owner-79" }, automaticWork: {} }),
      enqueue: async () => { providerCalls += 1; },
      gui: null,
    });
    await queue.quetDurableNgay({ now: now + 1 });
    const current = await db.getDurableMessageJob(job.id);
    console.log(`CASE_79_OBSERVED=${JSON.stringify({ status: current.status, providerCalls })}`);
    assert.equal(current.status, "EXPIRED");
    assert.equal(providerCalls, 0);
  });

  await regression(80, "PREPARED_UNDELIVERED_GENERATION_EXPIRES_ATOMICALLY", async () => {
    const now = 23_000_000;
    const fixture = await policyFixture(80, { slots: 2, admittedAt: now - 1_800_000 });
    assert.equal(typeof db.expireDurableWork, "function");
    await db.expireDurableWork({ now, limit: 100 });
    const rows = await db.listOutbox({ generationKey: fixture.generationKey });
    const job = await db.getDurableMessageJob(fixture.job.id);
    console.log(`CASE_80_OBSERVED=${JSON.stringify({ outbox: rows.map((row) => row.status), job: job.status })}`);
    assert.deepEqual(rows.map((row) => row.status), ["EXPIRED", "EXPIRED"]);
    assert.equal(job.status, "EXPIRED");
  });

  await regression(81, "DELIVERY_STARTED_GENERATION_DOES_NOT_AGE_EXPIRE", async () => {
    const now = 24_000_000;
    const sending = await policyFixture("81-sending", { admittedAt: now - 1_800_000 });
    const sent = await policyFixture("81-sent", { admittedAt: now - 1_800_000 });
    await rawRun("UPDATE outbound_outbox SET status='SENDING', lease_until=? WHERE id=?", [now + 60_000, sending.rows[0].id]);
    await rawRun("UPDATE outbound_outbox SET status='SENT', sent_at=? WHERE id=?", [now - 1, sent.rows[0].id]);
    assert.equal(typeof db.expireDurableWork, "function");
    await db.expireDurableWork({ now, limit: 100 });
    const sendingJob = await db.getDurableMessageJob(sending.job.id);
    const sentJob = await db.getDurableMessageJob(sent.job.id);
    console.log(`CASE_81_OBSERVED=${JSON.stringify({ sendingJob: sendingJob.status, sentJob: sentJob.status })}`);
    assert.notEqual(sendingJob.status, "EXPIRED");
    assert.notEqual(sentJob.status, "EXPIRED");
  });

  await regression(82, "TERMINAL_STATES_SURVIVE_CLAIM_RECOVERY_AND_SWEEP", async () => {
    const failedJob = await db.admitDurableMessageJob({ accountId: "owner-82", conversationId: "C82", sourceMessageId: "c82-failed" });
    const expiredJob = await db.admitDurableMessageJob({ accountId: "owner-82", conversationId: "C82", sourceMessageId: "c82-expired" });
    await rawRun("UPDATE durable_message_jobs SET status='FAILED_TERMINAL', lease_until=NULL WHERE id=?", [failedJob.id]);
    await rawRun("UPDATE durable_message_jobs SET status='EXPIRED', lease_until=NULL WHERE id=?", [expiredJob.id]);
    const rows = await db.ensureOutboundIntents({
      generationKey: "case-82-generation", accountId: "owner-82", conversationId: "C82",
      intents: [0, 1].map((slot) => ({ outboundKind: "TEXT", payload: { text: `c82-${slot}` } })),
    });
    await rawRun("UPDATE outbound_outbox SET status='FAILED_TERMINAL', lease_until=NULL WHERE id=?", [rows[0].id]);
    await rawRun("UPDATE outbound_outbox SET status='EXPIRED', lease_until=NULL WHERE id=?", [rows[1].id]);
    assert.equal(await db.claimDurableMessageJob(failedJob.id), null);
    assert.equal(await db.claimDurableMessageJob(expiredJob.id), null);
    assert.equal(await db.claimOutboundIntent(rows[0].id), null);
    assert.equal(await db.claimOutboundIntent(rows[1].id), null);
    await db.recoverExpiredDurableJobs(Date.now() + 1_000_000);
    await db.recoverExpiredOutboundIntents(Date.now() + 1_000_000);
    const jobsAfter = await db.listDurableMessageJobs({ accountId: "owner-82", conversationId: "C82" });
    const outboxAfter = await db.listOutbox({ generationKey: "case-82-generation" });
    console.log(`CASE_82_OBSERVED=${JSON.stringify({ jobs: jobsAfter.map((row) => row.status), outbox: outboxAfter.map((row) => row.status) })}`);
    assert.deepEqual(jobsAfter.map((row) => row.status), ["FAILED_TERMINAL", "EXPIRED"]);
    assert.deepEqual(outboxAfter.map((row) => row.status), ["FAILED_TERMINAL", "EXPIRED"]);
  });

  await regression(83, "ASSIGN_CANNOT_RESURRECT_TERMINAL_JOBS", async () => {
    const failed = await db.admitDurableMessageJob({ accountId: "owner-83", conversationId: "C83", sourceMessageId: "c83-failed" });
    const expired = await db.admitDurableMessageJob({ accountId: "owner-83", conversationId: "C83", sourceMessageId: "c83-expired" });
    await rawRun("UPDATE durable_message_jobs SET status='FAILED_TERMINAL' WHERE id=?", [failed.id]);
    await rawRun("UPDATE durable_message_jobs SET status='EXPIRED' WHERE id=?", [expired.id]);
    await db.assignDurableGeneration([failed.id, expired.id], "case-83-generation");
    const rows = await db.listDurableMessageJobs({ accountId: "owner-83", conversationId: "C83" });
    console.log(`CASE_83_OBSERVED=${JSON.stringify(rows.map((row) => ({ status: row.status, generationKey: row.generationKey })))}`);
    assert.deepEqual(rows.map((row) => row.status), ["FAILED_TERMINAL", "EXPIRED"]);
    assert.ok(rows.every((row) => row.generationKey === null));
  });

  await regression(84, "REQUEUE_FUNCTIONS_CANNOT_RESURRECT_TERMINAL_JOBS", async () => {
    const failed = await db.admitDurableMessageJob({ accountId: "owner-84", conversationId: "C84", sourceMessageId: "c84-failed" });
    const expired = await db.admitDurableMessageJob({ accountId: "owner-84", conversationId: "C84", sourceMessageId: "c84-expired" });
    await rawRun("UPDATE durable_message_jobs SET status='FAILED_TERMINAL', generation_key='case-84-failed' WHERE id=?", [failed.id]);
    await rawRun("UPDATE durable_message_jobs SET status='EXPIRED', generation_key='case-84-expired' WHERE id=?", [expired.id]);
    await db.requeueDurableGeneration("case-84-failed");
    await db.requeueStaleDurableGeneration("case-84-expired");
    const rows = await db.listDurableMessageJobs({ accountId: "owner-84", conversationId: "C84" });
    console.log(`CASE_84_OBSERVED=${JSON.stringify(rows.map((row) => row.status))}`);
    assert.deepEqual(rows.map((row) => row.status), ["FAILED_TERMINAL", "EXPIRED"]);
  });

  await regression(85, "BLOCK_AND_FAILURE_CANNOT_RESURRECT_TERMINAL_JOBS", async () => {
    const failed = await db.admitDurableMessageJob({ accountId: "owner-85", conversationId: "C85", sourceMessageId: "c85-failed" });
    const expired = await db.admitDurableMessageJob({ accountId: "owner-85", conversationId: "C85", sourceMessageId: "c85-expired" });
    await rawRun("UPDATE durable_message_jobs SET status='FAILED_TERMINAL', generation_key='case-85-generation' WHERE id=?", [failed.id]);
    await rawRun("UPDATE durable_message_jobs SET status='EXPIRED', generation_key='case-85-generation' WHERE id=?", [expired.id]);
    await db.markDurableJobsBlocked([failed.id, expired.id], "c85-block");
    await db.markDurableGenerationFailure("case-85-generation", { status: "RETRY", errorCode: "c85-fail" });
    const rows = await db.listDurableMessageJobs({ accountId: "owner-85", conversationId: "C85" });
    console.log(`CASE_85_OBSERVED=${JSON.stringify(rows.map((row) => row.status))}`);
    assert.deepEqual(rows.map((row) => row.status), ["FAILED_TERMINAL", "EXPIRED"]);
  });

  await regression(86, "SETTLE_CANNOT_RESURRECT_TERMINAL_JOBS", async () => {
    const failed = await db.admitDurableMessageJob({ accountId: "owner-86", conversationId: "C86", sourceMessageId: "c86-failed" });
    const expired = await db.admitDurableMessageJob({ accountId: "owner-86", conversationId: "C86", sourceMessageId: "c86-expired" });
    await rawRun("UPDATE durable_message_jobs SET status='FAILED_TERMINAL', generation_key='case-86-generation' WHERE id=?", [failed.id]);
    await rawRun("UPDATE durable_message_jobs SET status='EXPIRED', generation_key='case-86-generation' WHERE id=?", [expired.id]);
    const settled = await db.settleDurableGeneration("case-86-generation", { allowNoOutbound: true });
    const rows = await db.listDurableMessageJobs({ accountId: "owner-86", conversationId: "C86" });
    console.log(`CASE_86_OBSERVED=${JSON.stringify({ settled, statuses: rows.map((row) => row.status) })}`);
    assert.equal(settled, false);
    assert.deepEqual(rows.map((row) => row.status), ["FAILED_TERMINAL", "EXPIRED"]);
  });

  await regression(87, "LEASE_EXPIRED_AT_FIVE_TERMINALIZES_AT_SIX", async () => {
    const now = 87_000_000;
    const fixture = await policyFixture(87);
    await rawRun("UPDATE outbound_outbox SET status='SENDING', attempt_count=5, lease_until=? WHERE id=?", [now - 1, fixture.rows[0].id]);
    await db.recoverExpiredOutboundIntents(now);
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    const job = await db.getDurableMessageJob(fixture.job.id);
    console.log(`CASE_87_OBSERVED=${JSON.stringify({ status: row.status, attemptCount: row.attemptCount, jobStatus: job.status })}`);
    assert.equal(row.attemptCount, 6);
    assert.equal(row.status, "FAILED_TERMINAL");
    assert.equal(job.status, "FAILED_TERMINAL");
  });

  await regression(88, "ATOMIC_POLICY_OPERATIONS_DO_NOT_NEST_ARBITER", async () => {
    const dbSource = source("lib/db.js");
    assert.equal(typeof db.expireDurableWork, "function");
    const exportedRegion = (name) => {
      const start = dbSource.indexOf(`export async function ${name}`);
      assert.ok(start >= 0, `missing exported function ${name}`);
      const next = dbSource.indexOf("export async function ", start + 1);
      return dbSource.slice(start, next > start ? next : dbSource.length);
    };
    const failureBody = exportedRegion("markOutboundFailure");
    const expiryBody = exportedRegion("expireDurableWork");
    assert.equal((failureBody.match(/withDurableWrite\(/g) || []).length, 1);
    assert.equal((expiryBody.match(/withDurableWrite\(/g) || []).length, 1);
    assert.doesNotMatch(failureBody, /await\s+(markOutboundFailure|recoverExpiredOutboundIntents|expireDurableWork)\s*\(/);
    assert.doesNotMatch(expiryBody, /await\s+(markOutboundFailure|recoverExpiredDurableJobs|recoverExpiredOutboundIntents)\s*\(/);
    const fixture = await policyFixture(88);
    const claimed = await db.claimOutboundIntent(fixture.rows[0].id);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("case88 arbiter timeout")), 1_000));
    await Promise.race([
      Promise.all([
        db.markOutboundFailure(claimed.id, { status: "RETRY", errorCode: "c88", effectiveCap: 6 }),
        db.expireDurableWork({ now: 88_000_000, limit: 10 }),
      ]),
      timeout,
    ]);
    console.log(`CASE_88_OBSERVED=${JSON.stringify({ failureAcquisitions: 1, expiryAcquisitions: 1, completed: true })}`);
  });

  await regression(89, "STALE_REQUEUE_CANNOT_RESURRECT_TERMINAL_OUTBOX", async () => {
    const fixture = await policyFixture(89, { slots: 2 });
    await rawRun("UPDATE outbound_outbox SET status='FAILED_TERMINAL', lease_until=NULL WHERE id=?", [fixture.rows[0].id]);
    await rawRun("UPDATE outbound_outbox SET status='EXPIRED', lease_until=NULL WHERE id=?", [fixture.rows[1].id]);
    await rawRun("UPDATE durable_message_jobs SET status='FAILED_TERMINAL' WHERE id=?", [fixture.job.id]);
    await db.requeueStaleDurableGeneration(fixture.generationKey);
    const rows = await db.listOutbox({ generationKey: fixture.generationKey });
    console.log(`CASE_89_OBSERVED=${JSON.stringify(rows.map((row) => ({ status: row.status, generationKey: row.generationKey })))}`);
    assert.deepEqual(rows.map((row) => row.status), ["FAILED_TERMINAL", "EXPIRED"]);
    assert.ok(rows.every((row) => row.generationKey === fixture.generationKey));
  });

  await regression(90, "ABANDON_CANNOT_RESURRECT_TERMINAL_OUTBOX", async () => {
    const fixture = await policyFixture(90, { slots: 2 });
    await rawRun("UPDATE outbound_outbox SET status='FAILED_TERMINAL', lease_until=NULL WHERE id=?", [fixture.rows[0].id]);
    await rawRun("UPDATE outbound_outbox SET status='EXPIRED', lease_until=NULL WHERE id=?", [fixture.rows[1].id]);
    await db.abandonOutboundGeneration(fixture.generationKey, "c90-abandon");
    const rows = await db.listOutbox({ generationKey: fixture.generationKey });
    console.log(`CASE_90_OBSERVED=${JSON.stringify(rows.map((row) => ({ status: row.status, generationKey: row.generationKey })))}`);
    assert.deepEqual(rows.map((row) => row.status), ["FAILED_TERMINAL", "EXPIRED"]);
    assert.ok(rows.every((row) => row.generationKey === fixture.generationKey));
  });

  await regression(91, "MARK_SENT_DELAY_SELECTION_SKIPS_TERMINAL_SIBLINGS", async () => {
    const now = 91_000_000;
    const fixture = await policyFixture(91, { slots: 3 });
    await rawRun("UPDATE outbound_outbox SET status='SENDING', lease_until=? WHERE id=?", [now + 1_000, fixture.rows[0].id]);
    await rawRun("UPDATE outbound_outbox SET status='FAILED_TERMINAL' WHERE id=?", [fixture.rows[1].id]);
    await db.markOutboundSent(fixture.rows[0].id, "c91-provider", now, { generationKey: fixture.generationKey, nextAttemptDelayMs: 500 });
    const rows = await db.listOutbox({ generationKey: fixture.generationKey });
    console.log(`CASE_91_OBSERVED=${JSON.stringify(rows.map((row) => ({ status: row.status, nextAttemptAt: row.nextAttemptAt })))}`);
    assert.equal(rows[1].status, "FAILED_TERMINAL");
    assert.equal(rows[2].nextAttemptAt, now + 500);
  });

  await regression(92, "LEASE_EXPIRED_MARKER_BLOCKS_GENERATION_AGE_EXPIRY", async () => {
    const now = 92_000_000;
    const fixture = await policyFixture(92, { admittedAt: now - 1_800_000 });
    await rawRun("UPDATE outbound_outbox SET status='RETRY', last_error_code='LEASE_EXPIRED', lease_until=NULL WHERE id=?", [fixture.rows[0].id]);
    assert.equal(typeof db.expireDurableWork, "function");
    await db.expireDurableWork({ now, limit: 100 });
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    const job = await db.getDurableMessageJob(fixture.job.id);
    console.log(`CASE_92_OBSERVED=${JSON.stringify({ outboxStatus: row.status, marker: row.lastErrorCode, jobStatus: job.status })}`);
    assert.equal(row.status, "RETRY");
    assert.equal(row.lastErrorCode, "LEASE_EXPIRED");
    assert.notEqual(job.status, "EXPIRED");
  });

  await regression(93, "AGE_EXPIRY_RUNS_BEFORE_LEASE_RECOVERY_IN_ONE_SWEEP", async () => {
    const queueSource = source("lib/durable-message-queue.js");
    const body = extractFunction(queueSource, "async function sweepBody");
    const expiryIndex = body.indexOf("expireDurableWork");
    const jobRecoveryIndex = body.indexOf("recoverExpiredDurableJobs");
    const outboundSweepIndex = body.indexOf("quetOutboundNgay");
    const claimIndex = body.indexOf("claimNextDurableMessageJobs");
    console.log(`CASE_93_OBSERVED=${JSON.stringify({ expiryIndex, jobRecoveryIndex, outboundSweepIndex, claimIndex })}`);
    assert.ok(expiryIndex >= 0);
    assert.ok(expiryIndex < jobRecoveryIndex);
    assert.ok(jobRecoveryIndex < outboundSweepIndex);
    assert.ok(outboundSweepIndex < claimIndex);
  });

  await regression(94, "LEASE_CAP_EMITS_ONE_TERMINAL_POLICY_NOTIFICATION", async () => {
    const now = 94_000_000;
    const fixture = await policyFixture(94);
    await rawRun("UPDATE outbound_outbox SET status='SENDING', attempt_count=5, lease_until=? WHERE id=?", [now - 1, fixture.rows[0].id]);
    await rawRun(
      "UPDATE outbound_outbox SET next_attempt_at=9007199254740991 WHERE generation_key<>? AND status IN ('PENDING','RETRY','BLOCKED')",
      [fixture.generationKey]
    );
    let terminalPolicyNotifications = 0;
    outbox.capHinhOutboundOutbox({
      layAuthority: async () => null,
      gui: null,
      thongBaoAdmin: async (notice) => { if (notice?.terminalPolicy === true) terminalPolicyNotifications += 1; },
    });
    await outbox.quetOutboundNgay({ max: 1, now });
    await outbox.quetOutboundNgay({ max: 1, now: now + 1 });
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    console.log(`CASE_94_OBSERVED=${JSON.stringify({ status: row.status, terminalPolicyNotifications })}`);
    assert.equal(row.status, "FAILED_TERMINAL");
    assert.equal(terminalPolicyNotifications, 1);
  });

  await regression(95, "CAP_WINS_AGE_CONFLICT_AFTER_ORDERED_SWEEP", async () => {
    const now = 95_000_000;
    const fixture = await policyFixture(95, { admittedAt: now - 1_800_000 });
    await rawRun("UPDATE outbound_outbox SET status='SENDING', attempt_count=5, lease_until=? WHERE id=?", [now - 1, fixture.rows[0].id]);
    queue.capHinhDurableDispatcher({ layAuthority: async () => null, enqueue: async () => {}, gui: null, thongBaoAdmin: async () => {} });
    await queue.quetDurableNgay({ now });
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    const job = await db.getDurableMessageJob(fixture.job.id);
    console.log(`CASE_95_OBSERVED=${JSON.stringify({ outboxStatus: row.status, attemptCount: row.attemptCount, jobStatus: job.status })}`);
    assert.equal(row.status, "FAILED_TERMINAL");
    assert.equal(job.status, "FAILED_TERMINAL");
  });

  await regression(96, "DYNAMIC_SQL_TERMINAL_RESURRECTION_AUDIT", async () => {
    const dbSource = source("lib/db.js");
    const statements = [...dbSource.matchAll(/`(UPDATE\s+(durable_message_jobs|outbound_outbox)[\s\S]*?)`/gi)]
      .map((match) => ({ table: match[2], sql: match[1] }))
      .filter(({ sql }) => /SET[\s\S]*?\bstatus\s*=/.test(sql));
    const unsafe = statements.filter(({ sql }) => {
      const predicate = sql.slice(sql.search(/\bWHERE\b/i));
      return /status\s*<>/i.test(predicate)
        || !/(status\s+IN\s*\(|status\s*=\s*'SENDING'|status\s*=\s*'PROCESSING')/i.test(predicate)
        || /status\s+(?:IN\s*\([^)]*|=\s*)'(?:FAILED_TERMINAL|EXPIRED|DONE|SENT)'/i.test(predicate);
    });
    const unsafeJobs = unsafe.filter(({ table }) => table === "durable_message_jobs");
    const unsafeOutbox = unsafe.filter(({ table }) => table === "outbound_outbox");
    console.log(`CASE_96_OBSERVED=${JSON.stringify({
      auditedStatements: statements.length,
      jobTerminalResurrectionPaths: unsafeJobs.length,
      outboxTerminalResurrectionPaths: unsafeOutbox.length,
      unsafe: unsafe.map(({ table, sql }) => ({ table, sql: sql.replace(/\s+/g, " ") })),
    })}`);
    assert.ok(statements.length > 0);
    assert.deepEqual(unsafeJobs, []);
    assert.deepEqual(unsafeOutbox, []);
  });

  await regression(97, "EXPIRY_QUERY_PLAN_EVIDENCE", async () => {
    const jobPlan = await db.websiteDataAll(
      `EXPLAIN QUERY PLAN
       SELECT id, account_id, conversation_id
         FROM durable_message_jobs
        WHERE generation_key IS NULL
          AND status IN ('PENDING','PROCESSING','BLOCKED','RETRY','WAITING_OUTBOX')
          AND admitted_at <= ?
        ORDER BY admitted_at, id
        LIMIT ?`,
      [1_000_000, 100]
    );
    const generationPlan = await db.websiteDataAll(
      `EXPLAIN QUERY PLAN
       SELECT generation_key,
              MIN(admitted_at) AS first_admitted_at,
              MIN(account_id) AS account_id,
              MIN(conversation_id) AS conversation_id
         FROM durable_message_jobs
        WHERE generation_key IS NOT NULL
          AND status IN ('PENDING','PROCESSING','BLOCKED','RETRY','WAITING_OUTBOX')
        GROUP BY generation_key
       HAVING MIN(admitted_at) <= ?
        ORDER BY MIN(admitted_at), generation_key
        LIMIT ?`,
      [1_000_000, 100]
    );
    console.log(`CASE_97_JOB_EXPLAIN_QUERY_PLAN=${JSON.stringify(jobPlan)}`);
    console.log(`CASE_97_GENERATION_EXPLAIN_QUERY_PLAN=${JSON.stringify(generationPlan)}`);
    assert.ok(jobPlan.length > 0);
    assert.ok(generationPlan.length > 0);
  });

  await regression(98, "SENTINEL_ONLY_PATH_EVENTUALLY_AGE_EXPIRES", async () => {
    const now = 98_000_000;
    const fixture = await policyFixture(98, { admittedAt: now - 1_800_000 });
    await outbox.guiDurableOutbound({
      outbox: fixture.rows[0],
      conversationGeneration: fixture.activeGeneration,
      send: async () => ({ authorityRejectedBeforeProvider: true }),
    });
    await db.expireDurableWork({ now, limit: 100 });
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    const job = await db.getDurableMessageJob(fixture.job.id);
    console.log(`CASE_98_OBSERVED=${JSON.stringify({ outboxStatus: row.status, attemptCount: row.attemptCount, jobStatus: job.status })}`);
    assert.equal(row.status, "EXPIRED");
    assert.equal(row.attemptCount, 0);
    assert.equal(job.status, "EXPIRED");
  });

  await regression(99, "CLASSIFIED_FAILURE_PATH_EVENTUALLY_AGE_EXPIRES", async () => {
    const now = 99_000_000;
    const fixture = await policyFixture(99, { admittedAt: now - 1_800_000 });
    await failPolicyAttempt(fixture, fixture.rows[0], Object.assign(new Error("c99 unavailable"), { status: 503 }));
    await db.expireDurableWork({ now, limit: 100 });
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    const job = await db.getDurableMessageJob(fixture.job.id);
    console.log(`CASE_99_OBSERVED=${JSON.stringify({ outboxStatus: row.status, attemptCount: row.attemptCount, marker: row.lastErrorCode, jobStatus: job.status })}`);
    assert.equal(row.status, "EXPIRED");
    assert.equal(row.attemptCount, 1);
    assert.equal(job.status, "EXPIRED");
  });

  await regression(100, "EXPIRY_TERMINAL_POLICY_NOTIFICATION_AT_MOST_ONCE", async () => {
    const now = 100_000_000;
    const job = await db.admitDurableMessageJob({
      accountId: "owner-100", conversationId: "C100", sourceMessageId: "c100-in",
      admittedAt: now - 1_800_000,
    });
    let terminalPolicyNotifications = 0;
    queue.capHinhDurableDispatcher({
      layAuthority: async () => null,
      enqueue: async () => {},
      gui: null,
      thongBaoAdmin: async (notice) => {
        if (notice?.terminalPolicy === true && notice?.threadId === "C100") terminalPolicyNotifications += 1;
      },
    });
    await queue.quetDurableNgay({ now });
    await queue.quetDurableNgay({ now: now + 1 });
    const current = await db.getDurableMessageJob(job.id);
    console.log(`CASE_100_OBSERVED=${JSON.stringify({ status: current.status, terminalPolicyNotifications })}`);
    assert.equal(current.status, "EXPIRED");
    assert.equal(terminalPolicyNotifications, 1);
  });

  await regression(101, "LEASE_EXPIRED_BELOW_CAP_STAYS_BOUNDED_RETRY", async () => {
    const now = 101_000_000;
    const fixture = await policyFixture(101);
    await rawRun("UPDATE outbound_outbox SET status='SENDING', attempt_count=4, lease_until=? WHERE id=?", [now - 1, fixture.rows[0].id]);
    await db.recoverExpiredOutboundIntents(now);
    const row = (await db.listOutbox({ generationKey: fixture.generationKey }))[0];
    console.log(`CASE_101_OBSERVED=${JSON.stringify({ status: row.status, attemptCount: row.attemptCount, marker: row.lastErrorCode })}`);
    assert.equal(row.status, "RETRY");
    assert.equal(row.attemptCount, 5);
    assert.equal(row.lastErrorCode, "LEASE_EXPIRED");
  });

  await regression(102, "GENERATION_AGE_USES_MIN_MEMBER_ADMITTED_AT", async () => {
    const now = 102_000_000;
    const fixture = await policyFixture(102, { admittedAt: now - 1_800_000 });
    const newer = await db.admitDurableMessageJob({
      accountId: fixture.accountId,
      conversationId: fixture.conversationId,
      sourceMessageId: "c102-newer",
      admittedAt: now - 1_000,
    });
    await db.claimDurableMessageJob(newer.id, { now: now - 999, leaseMs: 3_600_000 });
    await db.assignDurableGeneration([newer.id], fixture.generationKey, { now: now - 999, leaseMs: 3_600_000 });
    await db.expireDurableWork({ now, limit: 100 });
    const jobs = await db.listDurableMessageJobs({ accountId: fixture.accountId, conversationId: fixture.conversationId });
    console.log(`CASE_102_OBSERVED=${JSON.stringify({ admittedAt: jobs.map((row) => row.admittedAt), statuses: jobs.map((row) => row.status) })}`);
    assert.deepEqual(jobs.map((row) => row.status), ["EXPIRED", "EXPIRED"]);
  });

  assert.equal(regressionFailures.length, 0, `Regression failures: ${regressionFailures.map(({ number }) => number).join(",")}`);
  assert.equal(passed.length, 102);
  assert.ok(Array.from({ length: 55 }, (_, index) => index + 41).every((number) => passed.includes(number)));
  console.log("DURABLE_QUEUE_OUTBOX_P1 = 102/102 PASS");
  console.log("REAL_ZALO_CALL = 0");
  console.log("REAL_LLM_CALL = 0");
  console.log("PRODUCTION_DB_TOUCHED = NO");
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3]);
} else {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vizenbot-p1-durable-"));
  const child = spawnSync(process.execPath, [...process.execArgv, THIS_FILE, "--worker", tempRoot], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 30_000,
  });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status || 1;
}
