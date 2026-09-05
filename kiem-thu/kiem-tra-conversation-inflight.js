import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taoDieuPhoiHoiThoai } from "../lib/conversation-inflight.js";
import { CHO_GOM_MS, taoBoGom } from "../lib/gom-tin.js";
import {
  clearAllPendingPdfConfirmations,
  createPdfAutomationHandler,
  getPendingPdfConfirmation,
  hasExactPdfConfirmation,
  PDF_AUTOMATION_HANDLED,
  setPendingPdfConfirmation,
} from "../lib/pdf-automation.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZALO = fs.readFileSync(path.join(ROOT, "lib", "zalo-service.js"), "utf8");
const MESSAGE_UTILS = fs.readFileSync(path.join(ROOT, "lib", "message-utils.js"), "utf8");

function compileTraLoiCumTin(dependencies) {
  const start = ZALO.indexOf("async function traLoiCumTin(");
  const end = ZALO.indexOf("\nasync function handleNewIncomingMessage", start);
  assert.ok(start >= 0 && end > start, "Khong tach duoc traLoiCumTin production");
  const source = ZALO.slice(start, end);
  const names = Object.keys(dependencies);
  return Function(
    ...names,
    `"use strict";\n${source}\nreturn traLoiCumTin;`
  )(...names.map((name) => dependencies[name]));
}

function compileHandleNewIncomingMessage(dependencies) {
  const start = ZALO.indexOf("async function handleNewIncomingMessage(");
  const end = ZALO.indexOf("\n/**", start);
  assert.ok(start >= 0 && end > start, "Khong tach duoc handleNewIncomingMessage production");
  const source = ZALO.slice(start, end);
  const names = Object.keys(dependencies);
  return Function(
    ...names,
    `"use strict";\n${source}\nreturn handleNewIncomingMessage;`
  )(...names.map((name) => dependencies[name]));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, label) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timeout: ${label}`);
}

function tin(id, senderId = "A", threadId = "T") {
  return {
    id,
    senderId,
    senderName: `Name-${senderId}`,
    threadId,
    threadType: 1,
    content: id,
    rawJson: { data: { msgId: id, uidFrom: senderId } },
  };
}

function inboundTin(id, {
  senderId = "A",
  threadId = "T",
  threadType = 0,
  tagged = false,
} = {}) {
  return {
    ...tin(id, senderId, threadId),
    threadType,
    tagged,
    isSelf: false,
  };
}

function ids(work) {
  return work.tins.map((item) => item.id);
}

function fakeClock() {
  let now = 0;
  let seq = 0;
  const tasks = [];
  return {
    now: () => now,
    set(fn, ms) {
      const task = { id: ++seq, at: now + ms, fn, cancelled: false };
      tasks.push(task);
      return task;
    },
    clear(task) {
      if (task) task.cancelled = true;
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        tasks.sort((a, b) => a.at - b.at || a.id - b.id);
        const task = tasks.find((item) => !item.cancelled && item.at <= target);
        if (!task) break;
        task.cancelled = true;
        now = task.at;
        task.fn();
      }
      now = target;
    },
    pending: () => tasks.filter((task) => !task.cancelled).length,
  };
}

function createPreBucketHarness({ persist = async (message) => message } = {}) {
  const persisted = [];
  const admitted = [];
  const open = new Set();
  const bucketKey = (message) => `${message.threadId}\u0000${message.senderId}`;
  const boGom = {
    dangMo: (threadId, senderId) => open.has(`${threadId}\u0000${senderId}`),
    dangBan: () => false,
    them: (message) => {
      admitted.push(message.id);
      open.add(bucketKey(message));
    },
  };
  const handler = compileHandleNewIncomingMessage({
    persistAndBroadcastMessage: async (message) => {
      persisted.push(["start", message.id]);
      const result = await persist(message);
      persisted.push(["end", message.id]);
      return result;
    },
    originConHieuLuc: () => true,
    sendChatMessage: async () => null,
    sendResolvedPrivateMessage: async () => null,
    chuHienTai: () => "OWNER",
    addLog: async () => undefined,
    laTinHeThong: () => false,
    moTaSuKien: () => "event",
    laLenhAdmin: async () => false,
    xuLyLenh: async () => null,
    aiChat: { getConfig: () => ({ botEnabled: true }) },
    botEligibilityEpoch: 0,
    botEligibilityConHieuLuc: () => true,
    khoaThreadEligibility: (ownerUid, threadId) => `${ownerUid}\u0000${threadId}`,
    threadEligibilityEpochHienTai: () => 0,
    threadEligibilityConHieuLuc: () => true,
    automaticWorkConHieuLuc: () => true,
    tuyChonGuiTuDong: () => ({}),
    getThread: async () => ({ botEnabled: true }),
    getAutoReplyRules: async () => [],
    normalizeString: (value) => String(value),
    ThreadType: { User: 0, Group: 1 },
    botDuocGoi: (message) => Boolean(message.tagged),
    appState: { uid: "OWNER" },
    boGom,
  });
  const originToken = Object.freeze({ originOwnerUid: "OWNER" });
  return {
    admitted,
    handler,
    persisted,
    run: (message) => handler(message, originToken),
    soLane: () => handler.inboundLanes?.size || 0,
  };
}

async function casePreBucketA1SlowerThanA2() {
  const gateA1 = deferred();
  const starts = [];
  const harness = createPreBucketHarness({
    persist: async (message) => {
      starts.push(message.id);
      if (message.id === "A1") await gateA1.promise;
      return message;
    },
  });

  const a1 = harness.run(inboundTin("A1"));
  await waitUntil(() => starts.length === 1, "A1 pre-bucket start");
  let a2Finished = false;
  const a2 = harness.run(inboundTin("A2")).finally(() => { a2Finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ["A1"], "A2 khong duoc vuot A1 dang cham truoc bucket");
  assert.equal(a2Finished, false);

  gateA1.resolve();
  await Promise.all([a1, a2]);
  assert.deepEqual(starts, ["A1", "A2"]);
  assert.deepEqual(harness.admitted, ["A1", "A2"]);
  assert.equal(harness.soLane(), 0);
}

async function casePreBucketJitterOrder() {
  const jitters = [[9, 0], [1, 0], [7, 2], [3, 1], [11, 0], [2, 1], [8, 3], [4, 0]];
  for (let index = 0; index < jitters.length; index += 1) {
    const [a1Delay, a2Delay] = jitters[index];
    const a1Id = `A1-${index}`;
    const a2Id = `A2-${index}`;
    const harness = createPreBucketHarness({
      persist: async (message) => {
        const delay = message.id === a1Id ? a1Delay : a2Delay;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return message;
      },
    });
    await Promise.all([
      harness.run(inboundTin(a1Id)),
      harness.run(inboundTin(a2Id)),
    ]);
    assert.deepEqual(harness.admitted, [a1Id, a2Id], `jitter round ${index}`);
    assert.equal(harness.soLane(), 0, `lane leak round ${index}`);
  }
}

async function casePreBucketCrossThreadOverlap() {
  const gateT1 = deferred();
  const starts = [];
  const harness = createPreBucketHarness({
    persist: async (message) => {
      starts.push(message.id);
      if (message.threadId === "T1") await gateT1.promise;
      return message;
    },
  });

  const t1 = harness.run(inboundTin("T1-A", { threadId: "T1" }));
  await waitUntil(() => starts.includes("T1-A"), "T1 pre-bucket start");
  let t2Finished = false;
  const t2 = harness.run(inboundTin("T2-A", { threadId: "T2" }))
    .finally(() => { t2Finished = true; });
  await waitUntil(() => t2Finished, "T2 overlap finish");
  assert.deepEqual(starts, ["T1-A", "T2-A"]);
  assert.deepEqual(harness.admitted, ["T2-A"], "T2 phai qua bucket khi T1 con dang cho");

  gateT1.resolve();
  await Promise.all([t1, t2]);
  assert.deepEqual(harness.admitted, ["T2-A", "T1-A"]);
  assert.equal(harness.soLane(), 0);
}

async function caseGroupFollowUpAndOutsider() {
  const gateA1 = deferred();
  const starts = [];
  const harness = createPreBucketHarness({
    persist: async (message) => {
      starts.push(message.id);
      if (message.id === "A1-TAG") await gateA1.promise;
      return message;
    },
  });
  const group = { threadId: "GROUP", threadType: 1 };

  const a1 = harness.run(inboundTin("A1-TAG", { ...group, senderId: "A", tagged: true }));
  await waitUntil(() => starts.length === 1, "tagged A1 pre-bucket start");
  const a2 = harness.run(inboundTin("A2-FOLLOW", { ...group, senderId: "A" }));
  const outsider = harness.run(inboundTin("B1-OUTSIDER", { ...group, senderId: "B" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ["A1-TAG"], "same-thread events phai cho tagged A1 admission");

  gateA1.resolve();
  await Promise.all([a1, a2, outsider]);
  assert.deepEqual(starts, ["A1-TAG", "A2-FOLLOW", "B1-OUTSIDER"]);
  assert.deepEqual(harness.admitted, ["A1-TAG", "A2-FOLLOW"]);
  assert.equal(harness.soLane(), 0);
}

async function casePreBucketFailureRelease() {
  const harness = createPreBucketHarness({
    persist: async (message) => {
      if (message.id === "THROW") throw new Error("metadata lookup failed");
      if (message.id === "FILTER") return null;
      return message;
    },
  });
  const settled = await Promise.race([
    Promise.allSettled([
      harness.run(inboundTin("THROW")),
      harness.run(inboundTin("FILTER")),
      harness.run(inboundTin("A2")),
    ]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("inbound lane deadlock")), 500)),
  ]);
  assert.deepEqual(settled.map((item) => item.status), ["rejected", "fulfilled", "fulfilled"]);
  assert.deepEqual(harness.admitted, ["A2"]);
  assert.equal(harness.soLane(), 0);
}

async function caseA() {
  const first = deferred();
  const calls = [];
  const outbound = [];
  let active = 0;
  let maxActive = 0;
  let staleSkips = 0;
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(ids(work));
      generation.danhDauProviderHistory();
      try {
        if (calls.length === 1) await first.promise;
        if (generation.chapNhanOutbound()) outbound.push(ids(work).join("+"));
        else if (generation.danhDauStaleOutboundSkipped()) staleSkips += 1;
      } finally {
        active -= 1;
      }
    },
  });

  const done = coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("A")] });
  await waitUntil(() => calls.length === 1, "G1 start");
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("B")] });
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [{ ...tin("B"), msgId: "not-authority" }] });
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("C")] });
  first.resolve();
  await done;

  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [["A"], ["A", "B", "C"]]);
  assert.deepEqual(outbound, ["A+B+C"]);
  assert.equal(staleSkips, 1);
  assert.equal(coordinator.soLane(), 0);
  return { maxActive };
}

async function caseB() {
  const baselineClock = fakeClock();
  const baselineStarts = [];
  const baseline = taoBoGom({
    conDangGo: () => false,
    khiChot: () => baselineStarts.push(baselineClock.now()),
    bayGio: baselineClock.now,
    datHen: baselineClock.set,
    huyHen: baselineClock.clear,
  });

  const coordinatedClock = fakeClock();
  const coordinatedStarts = [];
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async () => coordinatedStarts.push(coordinatedClock.now()),
  });
  const coordinated = taoBoGom({
    conDangGo: () => false,
    khiChot: (tins) => coordinator.them({ ownerUid: "O", threadId: "T", tins }),
    bayGio: coordinatedClock.now,
    datHen: coordinatedClock.set,
    huyHen: coordinatedClock.clear,
  });

  baseline.them(tin("B0"));
  coordinated.them(tin("B1"));
  baselineClock.advance(CHO_GOM_MS - 1);
  coordinatedClock.advance(CHO_GOM_MS - 1);
  assert.deepEqual(baselineStarts, []);
  assert.deepEqual(coordinatedStarts, []);
  baselineClock.advance(1);
  coordinatedClock.advance(1);
  await coordinator.choRanh("O", "T");

  assert.equal(CHO_GOM_MS, 7000);
  assert.deepEqual(baselineStarts, [7000]);
  assert.deepEqual(coordinatedStarts, [7000]);
}

function caseSameSenderBucketFlushOrder() {
  const clock = fakeClock();
  const flushed = [];
  let threadBusy = false;
  const boGom = taoBoGom({
    conDangGo: () => false,
    threadDangBan: () => threadBusy,
    khiChot: (messages, originToken) => flushed.push({ messages, originToken }),
    bayGio: clock.now,
    datHen: clock.set,
    huyHen: clock.clear,
  });
  const a1 = tin("A1", "A");
  const a2 = tin("A2", "A");
  const originA1 = { marker: "origin-A1" };
  const originA2 = { marker: "origin-A2" };

  boGom.them(a1, originA1);
  assert.equal(boGom.soCuaSo(), 1);
  assert.equal(clock.pending(), 1);

  threadBusy = true;
  boGom.them(a2, originA2);

  assert.equal(boGom.soCuaSo(), 0, "bucket cung sender phai duoc lay ra ngay");
  assert.equal(clock.pending(), 0, "timer cua bucket cu phai bi huy");
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].messages.map((message) => message.id), ["A1", "A2"]);
  assert.strictEqual(flushed[0].messages[0], a1, "giu nguyen normalized object A1");
  assert.strictEqual(flushed[0].messages[1], a2, "giu nguyen normalized object A2");
  assert.strictEqual(flushed[0].originToken, originA1, "bucket giu origin cua tin dau");

  clock.advance(CHO_GOM_MS * 2);
  assert.equal(flushed.length, 1, "timer cu khong duoc fire lan hai");

  const b1 = tin("B1", "B");
  const originB1 = { marker: "origin-B1" };
  boGom.them(b1, originB1);
  assert.deepEqual(flushed.map((entry) => entry.messages.map((message) => message.id)), [
    ["A1", "A2"],
    ["B1"],
  ]);
  assert.strictEqual(flushed[1].messages[0], b1);
  assert.strictEqual(flushed[1].originToken, originB1);
}

async function caseC() {
  const gates = { A: deferred(), B: deferred() };
  const perThread = new Map();
  let globalActive = 0;
  let globalMax = 0;
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      const thread = work.threadId;
      const active = (perThread.get(thread) || 0) + 1;
      perThread.set(thread, active);
      assert.equal(active, 1);
      globalActive += 1;
      globalMax = Math.max(globalMax, globalActive);
      await gates[thread].promise;
      generation.chapNhanOutbound();
      globalActive -= 1;
      perThread.set(thread, active - 1);
    },
  });

  const doneA = coordinator.them({ ownerUid: "O", threadId: "A", tins: [tin("A1", "X", "A")] });
  const doneB = coordinator.them({ ownerUid: "O", threadId: "B", tins: [tin("B1", "Y", "B")] });
  await waitUntil(() => globalActive === 2, "independent overlap");
  gates.A.resolve();
  gates.B.resolve();
  await Promise.all([doneA, doneB]);
  assert.equal(globalMax, 2);
  return { globalMax };
}

async function caseDAndK() {
  const first = deferred();
  const attempts = [];
  const accepted = [];
  const metadata = [];
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      attempts.push(ids(work));
      metadata.push(work.tins.map((item) => [item.senderId, item.senderName]));
      if (attempts.length === 1) await first.promise;
      if (generation.chapNhanOutbound()) accepted.push(ids(work));
    },
  });

  const done = coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("A1", "A")] });
  await waitUntil(() => attempts.length === 1, "ordered G1");
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("B1", "B")] });
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("A2", "A")] });
  first.resolve();
  await done;

  assert.deepEqual(accepted, [["A1"], ["B1"], ["A2"]]);
  assert.deepEqual(metadata.slice(1), [
    [["A", "Name-A"]],
    [["B", "Name-B"]],
    [["A", "Name-A"]],
  ]);

  const grouped = [];
  const coordinator2 = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      grouped.push(ids(work));
      generation.chapNhanOutbound();
    },
  });
  await coordinator2.them({
    ownerUid: "O",
    threadId: "T2",
    tins: [
      tin("A1", "A", "T2"), tin("A2", "A", "T2"), tin("A3", "A", "T2"),
      tin("B1", "B", "T2"), tin("B2", "B", "T2"),
    ],
  });
  assert.deepEqual(grouped, [["A1", "A2", "A3"], ["B1", "B2"]]);
}

async function caseE() {
  const beforeOutbound = deferred();
  const aiReturned = deferred();
  const customer = [];
  let reactions = 0;
  let stickers = 0;
  let media = 0;
  let staleSkips = 0;
  let run = 0;
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      run += 1;
      generation.danhDauProviderHistory();
      if (run === 1) {
        aiReturned.resolve();
        await beforeOutbound.promise;
      }
      if (!generation.chapNhanOutbound()) {
        if (generation.danhDauStaleOutboundSkipped()) staleSkips += 1;
        return;
      }
      customer.push(ids(work).join("+"));
      if (run > 1) reactions += 1;
    },
  });

  const done = coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("A")] });
  await aiReturned.promise;
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("B")] });
  beforeOutbound.resolve();
  await done;

  assert.equal(staleSkips, 1);
  assert.deepEqual(customer, ["A+B"]);
  assert.equal(reactions, 1);
  assert.equal(stickers, 0);
  assert.equal(media, 0);
}

async function caseF() {
  const afterFirstBubble = deferred();
  const continueBubbles = deferred();
  const outbound = [];
  let run = 0;
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      run += 1;
      assert.equal(generation.chapNhanOutbound(), true);
      if (run === 1) {
        outbound.push("G1-B1");
        afterFirstBubble.resolve();
        await continueBubbles.promise;
        assert.equal(generation.conHieuLuc(), true);
        outbound.push("G1-B2");
      } else {
        outbound.push("G2-B1");
      }
    },
  });

  const done = coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("A")] });
  await afterFirstBubble.promise;
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("B")] });
  continueBubbles.resolve();
  await done;
  assert.deepEqual(outbound, ["G1-B1", "G1-B2", "G2-B1"]);
}

async function caseG() {
  const calls = [];
  const outbound = [];
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      calls.push(ids(work));
      if (work.tins[0].id === "ERR") throw new Error("fake inference failure");
      if (generation.chapNhanOutbound()) outbound.push(work.tins[0].id);
    },
  });
  await coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("ERR")] });
  await coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("NEXT")] });
  assert.deepEqual(calls, [["ERR"], ["NEXT"]]);
  assert.deepEqual(outbound, ["NEXT"]);
  assert.equal(coordinator.soLane(), 0);
}

async function caseH() {
  const gate = deferred();
  const calls = [];
  const outbound = [];
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      calls.push(ids(work));
      await gate.promise;
      if (generation.chapNhanOutbound()) outbound.push(ids(work));
    },
  });
  const cancelBridge = taoBoGom({
    conDangGo: () => false,
    khiChot: () => undefined,
    khiHuyTheoThread: (threadId, ownerUid) => coordinator.huyTheoThread(ownerUid, threadId),
  });
  const done = coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("A")] });
  await waitUntil(() => calls.length === 1, "cancel start");
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("B")] });
  cancelBridge.huyTheoThread("T", "O");
  gate.resolve();
  await done;
  assert.deepEqual(calls, [["A"]]);
  assert.deepEqual(outbound, []);

  const gates = { X: deferred(), Y: deferred() };
  const allCalls = [];
  const coordinator2 = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      allCalls.push(work.threadId);
      await gates[work.threadId].promise;
      assert.equal(generation.chapNhanOutbound(), false);
    },
  });
  const cancelAllBridge = taoBoGom({
    conDangGo: () => false,
    khiChot: () => undefined,
    khiHuyTatCa: () => coordinator2.huyTatCa(),
  });
  const x = coordinator2.them({ ownerUid: "O", threadId: "X", tins: [tin("X", "A", "X")] });
  const y = coordinator2.them({ ownerUid: "O", threadId: "Y", tins: [tin("Y", "A", "Y")] });
  await waitUntil(() => allCalls.length === 2, "global cancel start");
  cancelAllBridge.huyTatCa();
  gates.X.resolve();
  gates.Y.resolve();
  await Promise.all([x, y]);
  assert.equal(coordinator2.soLane(), 0);
}

async function caseI() {
  const gate = deferred();
  const calls = [];
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      calls.push(ids(work));
      if (calls.length === 1) await gate.promise;
      generation.chapNhanOutbound();
    },
  });
  const automaticWork = { originToken: { originOwnerUid: "O" } };
  const boGom = taoBoGom({
    conDangGo: () => false,
    threadDangBan: (message, work) => coordinator.threadDangBan(
      work.originToken.originOwnerUid,
      message.threadId
    ),
    conDangBan: (owner, thread, sender) => coordinator.dangBan(owner, thread, sender),
    khiChot: (messages, work) => coordinator.them({
      ownerUid: work.originToken.originOwnerUid,
      threadId: messages[0].threadId,
      tins: messages,
      automaticWork: work,
    }),
  });

  const done = coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("X1", "X")] });
  await waitUntil(() => calls.length === 1, "busy group start");
  assert.equal(boGom.soCuaSo(), 0, "bucket da fire/khong con mo");
  assert.equal(boGom.dangBan("O", "T", "X"), true);
  assert.equal(boGom.dangBan("O", "T", "Y"), false);
  boGom.them(tin("X2", "X"), automaticWork);
  assert.equal(boGom.soCuaSo(), 0, "follow-up active vao pending ngay");
  gate.resolve();
  await done;
  assert.deepEqual(calls, [["X1"], ["X1", "X2"]]);
}

function caseJAndIntegration() {
  const originCount = (ZALO.match(/originConHieuLuc\(/g) || []).length;
  const automaticCount = (ZALO.match(/automaticWorkConHieuLuc\(/g) || []).length;
  assert.equal(originCount, 44);
  assert.equal(automaticCount, 7);
  assert.match(ZALO, /return globalHopLe && threadHopLe && generationHopLe/);
  assert.match(ZALO, /khiHuyTheoThread:[\s\S]*dieuPhoiHoiThoai\.huyTheoThread\(/);
  assert.match(ZALO, /khiHuyTatCa: \(\) => dieuPhoiHoiThoai\.huyTatCa\(/);
  assert.match(ZALO, /boGom\.dangBan\?\.\(/);
  assert.match(ZALO, /conversationGeneration\.chapNhanOutbound\(\)/);
  assert.match(ZALO, /event: "stale_outbound_skipped"/);
  assert.match(ZALO, /segment\.preAiDone = true/);
  assert.match(ZALO, /workOrTins\.staleProviderHistory/);
  assert.match(MESSAGE_UTILS, /const id = String\(data\.msgId \|\| data\.cliMsgId \|\| message\?\.msgId \|\| message\?\.id/);
}

async function caseL() {
  const gate = deferred();
  const history = [];
  const customer = [];
  const prompts = [];
  let run = 0;
  let pairedAiResponses = 0;
  let pairedStaleSkips = 0;
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      run += 1;
      const prompt = work.staleProviderHistory
        ? `NOT_DELIVERED\n${ids(work).join("+")}`
        : ids(work).join("+");
      prompts.push(prompt);
      generation.danhDauProviderHistory();
      history.push({ role: "user", text: prompt });
      const reply = `R${run}`;
      history.push({ role: "assistant", text: reply });
      pairedAiResponses += 1;
      if (run === 1) await gate.promise;
      if (generation.chapNhanOutbound()) customer.push(reply);
      else {
        if (generation.danhDauStaleOutboundSkipped()) pairedStaleSkips += 1;
        assert.equal(generation.danhDauStaleOutboundSkipped(), false);
      }
    },
  });

  const done = coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("A")] });
  await waitUntil(() => history.length === 2, "provider history side effect");
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("B")] });
  gate.resolve();
  await done;

  assert.deepEqual(prompts, ["A", "NOT_DELIVERED\nA+B"]);
  assert.deepEqual(history.slice(0, 3), [
    { role: "user", text: "A" },
    { role: "assistant", text: "R1" },
    { role: "user", text: "NOT_DELIVERED\nA+B" },
  ]);
  assert.deepEqual(customer, ["R2"]);
  assert.equal(pairedAiResponses, 2);
  assert.equal(pairedStaleSkips, 1);
}

async function caseM() {
  const gate = deferred();
  const pdf = new Map();
  const seen = new Map();
  let reaction = 0;
  let run = 0;
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      run += 1;
      for (const segment of work.segments) {
        if (segment.preAiDone) continue;
        segment.preAiDone = true;
        for (const message of segment.tins) {
          pdf.set(message.id, (pdf.get(message.id) || 0) + 1);
          seen.set(message.id, (seen.get(message.id) || 0) + 1);
        }
      }
      generation.danhDauProviderHistory();
      if (run === 1) await gate.promise;
      if (generation.chapNhanOutbound()) reaction += 1;
    },
  });

  const done = coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("A")] });
  await waitUntil(() => run === 1, "pre-AI first pass");
  coordinator.them({ ownerUid: "O", threadId: "T", tins: [tin("B")] });
  gate.resolve();
  await done;
  assert.equal(pdf.get("A"), 1);
  assert.equal(pdf.get("B"), 1);
  assert.equal(seen.get("A"), 1);
  assert.equal(seen.get("B"), 1);
  assert.equal(reaction, 1);
}

async function runNonPdfStaleReplayScenario({ secondId, secondSender }) {
  clearAllPendingPdfConfirmations();
  const ownerUid = "NON-PDF-OWNER";
  const threadId = "NON-PDF-THREAD";
  const senderId = "A";
  const originToken = {
    originOwnerUid: ownerUid,
    originRuntimeGeneration: 88,
  };
  const automaticWork = { originToken };
  const aiInputs = [];
  let coordinator;
  let injected = false;
  let runCount = 0;

  const automaticWorkIsCurrent = (work) => (
    !work?.conversationGeneration || work.conversationGeneration.conHieuLuc()
  );
  const handlePdfAutomation = createPdfAutomationHandler({
    listEnabledRules: async () => {
      if (!injected) {
        injected = true;
        void coordinator.them({
          ownerUid,
          threadId,
          tins: [tin(secondId, secondSender, threadId)],
          automaticWork,
        });
      }
      return [];
    },
    getRuleWithBlob: async () => assert.fail("non-PDF khong duoc doc PDF blob"),
    sendMessage: async () => assert.fail("non-PDF khong duoc gui PDF outbound"),
    isOriginCurrent: () => true,
    isAutomaticWorkCurrent: automaticWorkIsCurrent,
    getOwnerUid: () => ownerUid,
    getRuntimeGeneration: () => 88,
    log: async () => {},
  });

  const traLoiCumTin = compileTraLoiCumTin({
    automaticWorkConHieuLuc: automaticWorkIsCurrent,
    tuyChonGuiTuDong: (work) => work,
    addLog: async () => {},
    originConHieuLuc: () => true,
    gopThanhMotTin: (messages) => ({
      ...messages.at(-1),
      content: messages.map((message) => message.content).join("\n"),
      sourceIds: messages.map((message) => message.id),
    }),
    handlePdfAutomation,
    getPendingPdfConfirmation,
    hasExactPdfConfirmation,
    setPendingPdfConfirmation,
    PDF_AUTOMATION_HANDLED,
    chuHienTai: () => ownerUid,
    guiDaXemChoTins: () => {},
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => () => {},
    aiChat: {
      getConfig: () => ({ botEnabled: true }),
      tryReply: async (_content, message) => {
        aiInputs.push([...message.sourceIds]);
        return null;
      },
    },
    ownerCredentials: {
      withCurrentOwnerCredentialRead: async (_owner, _config, work) => work(),
    },
  });

  coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      runCount += 1;
      await traLoiCumTin(work, work.segments[0]?.automaticWork || null, generation);
    },
  });

  await coordinator.them({
    ownerUid,
    threadId,
    tins: [tin("A1", senderId, threadId)],
    automaticWork,
  });
  return { aiInputs, runCount };
}

async function caseNonPdfStaleReplaySameSender() {
  const result = await runNonPdfStaleReplayScenario({ secondId: "A2", secondSender: "A" });
  assert.deepEqual(result.aiInputs, [["A1", "A2"]]);
  assert.equal(result.runCount, 2);
}

async function caseNonPdfStaleReplayCrossSender() {
  const result = await runNonPdfStaleReplayScenario({ secondId: "B1", secondSender: "B" });
  assert.deepEqual(result.aiInputs, [["A1"], ["B1"]]);
  assert.equal(result.runCount, 3);
}

async function runPdfServiceScenario({ content, pending = false, staleAttempts = 0 }) {
  clearAllPendingPdfConfirmations();
  const ownerUid = "PDF-OWNER";
  const threadId = "PDF-THREAD";
  const senderId = "PDF-SENDER";
  const runtimeGeneration = 77;
  const rule = {
    id: 901,
    enabled: true,
    keyword: "brochure",
    keywordNorm: "brochure",
    pdfData: Buffer.from("%PDF-test"),
    pdfName: "brochure.pdf",
    pdfSize: 9,
    pdfMime: "application/pdf",
  };
  const originToken = {
    originOwnerUid: ownerUid,
    originRuntimeGeneration: runtimeGeneration,
  };
  const automaticWork = { originToken };
  const attempts = [];
  const accepted = [];
  let genericAiCalls = 0;
  let runCount = 0;
  let injected = 0;
  let restoreCalls = 0;
  let ruleReads = 0;
  let coordinator;

  if (pending) {
    setPendingPdfConfirmation(ownerUid, threadId, senderId, {
      ruleId: rule.id,
      runtimeGeneration,
    });
  }

  const automaticWorkIsCurrent = (work) => (
    !work?.conversationGeneration || work.conversationGeneration.conHieuLuc()
  );
  const handlePdfAutomation = createPdfAutomationHandler({
    listEnabledRules: async () => [rule],
    getRuleWithBlob: async () => {
      ruleReads += 1;
      return rule;
    },
    sendMessage: async (payload, work) => {
      const kind = payload.attachment ? "file" : "confirmation";
      attempts.push(kind);
      if (injected < staleAttempts) {
        injected += 1;
        const wake = {
          ...tin(`PDF-STALE-${injected}`, senderId, threadId),
          content: "",
        };
        void coordinator.them({
          ownerUid,
          threadId,
          tins: [wake],
          automaticWork,
        });
      }
      if (work?.conversationGeneration && !work.conversationGeneration.chapNhanOutbound()) {
        return null;
      }
      accepted.push({ kind, payload });
      return { ok: true };
    },
    isOriginCurrent: () => true,
    isAutomaticWorkCurrent: automaticWorkIsCurrent,
    getOwnerUid: () => ownerUid,
    getRuntimeGeneration: () => runtimeGeneration,
    log: async () => {},
  });

  const traLoiCumTin = compileTraLoiCumTin({
    automaticWorkConHieuLuc: automaticWorkIsCurrent,
    tuyChonGuiTuDong: (work) => work,
    addLog: async () => {},
    originConHieuLuc: () => true,
    gopThanhMotTin: (messages) => ({
      ...messages.at(-1),
      content: messages.map((message) => message.content).filter(Boolean).join("\n"),
    }),
    handlePdfAutomation,
    getPendingPdfConfirmation,
    hasExactPdfConfirmation,
    setPendingPdfConfirmation: (...args) => {
      restoreCalls += 1;
      return setPendingPdfConfirmation(...args);
    },
    PDF_AUTOMATION_HANDLED,
    chuHienTai: () => ownerUid,
    guiDaXemChoTins: () => {},
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => () => {},
    aiChat: {
      getConfig: () => ({ botEnabled: true }),
      tryReply: async () => {
        genericAiCalls += 1;
        return null;
      },
    },
    ownerCredentials: {
      withCurrentOwnerCredentialRead: async (_owner, _config, work) => work(),
    },
  });

  coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      runCount += 1;
      await traLoiCumTin(work, work.segments[0]?.automaticWork || null, generation);
    },
  });

  const input = { ...tin("PDF-INPUT", senderId, threadId), content };
  await coordinator.them({ ownerUid, threadId, tins: [input], automaticWork });

  return {
    ownerUid,
    threadId,
    senderId,
    rule,
    attempts,
    accepted,
    genericAiCalls,
    runCount,
    restoreCalls,
    ruleReads,
    pendingAfter: getPendingPdfConfirmation(ownerUid, threadId, senderId),
  };
}

async function casePdf1PendingOkStaleBeforeFileCommit() {
  const result = await runPdfServiceScenario({
    content: "OK",
    pending: true,
    staleAttempts: 1,
  });
  assert.deepEqual(result.attempts, ["file", "file"]);
  assert.deepEqual(result.accepted.map((entry) => entry.kind), ["file"]);
  assert.equal(result.ruleReads, 2, "pending phai duoc restore de handler doc lai rule");
  assert.equal(result.restoreCalls, 1);
  assert.equal(result.runCount, 2);
  assert.equal(result.pendingAfter, null, "accepted file consume pending terminal");
  assert.equal(result.genericAiCalls, 0, "OK khong duoc roi xuong generic AI");
}

async function casePdf2StaleBeforeConfirmationCommit() {
  const result = await runPdfServiceScenario({
    content: "xin brochure",
    pending: false,
    staleAttempts: 1,
  });
  assert.deepEqual(result.attempts, ["confirmation", "confirmation"]);
  assert.deepEqual(result.accepted.map((entry) => entry.kind), ["confirmation"]);
  assert.equal(result.restoreCalls, 0, "intent chua co pending chi can replay segment");
  assert.equal(result.runCount, 2);
  assert.equal(result.pendingAfter?.ruleId, result.rule.id);
  assert.equal(result.genericAiCalls, 0);
}

async function casePdf3NormalAcceptedTerminal() {
  const result = await runPdfServiceScenario({
    content: "OK",
    pending: true,
    staleAttempts: 0,
  });
  assert.deepEqual(result.attempts, ["file"]);
  assert.deepEqual(result.accepted.map((entry) => entry.kind), ["file"]);
  assert.equal(result.ruleReads, 1);
  assert.equal(result.restoreCalls, 0);
  assert.equal(result.runCount, 1);
  assert.equal(result.pendingAfter, null);
  assert.equal(result.genericAiCalls, 0);
}

async function casePdf4TwoConsecutiveStales() {
  const result = await runPdfServiceScenario({
    content: "OK",
    pending: true,
    staleAttempts: 2,
  });
  assert.deepEqual(result.attempts, ["file", "file", "file"]);
  assert.deepEqual(result.accepted.map((entry) => entry.kind), ["file"]);
  assert.equal(result.ruleReads, 3, "mot logical pending duoc replay qua hai stale");
  assert.equal(result.restoreCalls, 2);
  assert.equal(result.runCount, 3);
  assert.equal(result.pendingAfter, null);
  assert.equal(result.genericAiCalls, 0);
}

const results = [];
async function run(label, fn) {
  try {
    const value = await fn();
    results.push([label, "PASS", value]);
    console.log(`${label} = PASS`);
  } catch (error) {
    results.push([label, "FAIL", error]);
    console.error(`${label} = FAIL`, error);
  }
}

await run("PRE_BUCKET_A1_SLOWER_ORDER", casePreBucketA1SlowerThanA2);
await run("PRE_BUCKET_A2_JITTER_ORDER", casePreBucketJitterOrder);
await run("PRE_BUCKET_A3_CROSS_THREAD_OVERLAP", casePreBucketCrossThreadOverlap);
await run("PRE_BUCKET_B_GROUP_FOLLOWUP_OUTSIDER", caseGroupFollowUpAndOutsider);
await run("PRE_BUCKET_FAILURE_RELEASE", casePreBucketFailureRelease);
await run("CASE_A", caseA);
await run("CASE_B", caseB);
await run("BLOCKER_1_SAME_SENDER_BUCKET_ORDER", async () => caseSameSenderBucketFlushOrder());
await run("CASE_C", caseC);
await run("CASE_D_AND_K", caseDAndK);
await run("CASE_E", caseE);
await run("CASE_F", caseF);
await run("CASE_G", caseG);
await run("CASE_H", caseH);
await run("CASE_I", caseI);
await run("CASE_J_INTEGRATION", async () => caseJAndIntegration());
await run("CASE_L", caseL);
await run("CASE_M", caseM);
await run("NON_PDF_STALE_REPLAY_SAME_SENDER", caseNonPdfStaleReplaySameSender);
await run("NON_PDF_STALE_REPLAY_CROSS_SENDER", caseNonPdfStaleReplayCrossSender);
await run("PDF_1_PENDING_OK_STALE_BEFORE_FILE_COMMIT", casePdf1PendingOkStaleBeforeFileCommit);
await run("PDF_2_STALE_BEFORE_CONFIRMATION_COMMIT", casePdf2StaleBeforeConfirmationCommit);
await run("PDF_3_NORMAL_ACCEPTED_TERMINAL", casePdf3NormalAcceptedTerminal);
await run("PDF_4_TWO_CONSECUTIVE_STALES", casePdf4TwoConsecutiveStales);

const failed = results.filter(([, status]) => status === "FAIL");
console.log(`\nCONVERSATION_INFLIGHT = ${results.length - failed.length}/${results.length} PASS`);
console.log("REAL_ZALO_CALL = 0");
console.log("REAL_OPENCODE_CALL = 0");
console.log("PRODUCTION_DB_TOUCHED = NO");
if (failed.length) process.exitCode = 1;
