/**
 * STAB-06 Lane 1: deterministic proof for session-work cancellation and the
 * immutable runtime-origin guard. No live DB, Zalo login, provider, or network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taoBoGom, khoaGom } from "../lib/gom-tin.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const zaloSource = fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8");

class FakeClock {
  constructor() {
    this.nextId = 1;
    this.tasks = new Map();
    this.originals = null;
  }

  install() {
    assert.equal(this.originals, null, "Fake clock da duoc cai");
    this.originals = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    globalThis.setTimeout = (fn, delay = 0, ...args) => this.schedule(fn, delay, 0, args);
    globalThis.clearTimeout = (id) => this.cancel(id);
    globalThis.setInterval = (fn, delay = 0, ...args) => this.schedule(fn, delay, Number(delay) || 1, args);
    globalThis.clearInterval = (id) => this.cancel(id);
  }

  restore() {
    if (!this.originals) return;
    Object.assign(globalThis, this.originals);
    this.originals = null;
  }

  schedule(fn, delay, interval, args) {
    const id = this.nextId++;
    this.tasks.set(id, {
      id,
      fn,
      args,
      delay: Number(delay) || 0,
      interval,
      cancelled: false,
      ran: false,
    });
    return id;
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (task) task.cancelled = true;
  }

  idsWithDelay(delay, { includeCancelled = false } = {}) {
    return [...this.tasks.values()]
      .filter((task) => task.delay === delay && !task.ran && (includeCancelled || !task.cancelled))
      .map((task) => task.id);
  }

  pendingCount() {
    return [...this.tasks.values()].filter((task) => !task.ran && !task.cancelled).length;
  }

  run(id, { force = false } = {}) {
    const task = this.tasks.get(id);
    assert.ok(task, `Khong co timer ${id}`);
    assert.equal(task.ran, false, `Timer ${id} da chay`);
    if (task.cancelled && !force) return false;
    task.ran = true;
    task.fn(...task.args);
    if (task.interval && !task.cancelled) {
      this.schedule(task.fn, task.interval, task.interval, task.args);
    }
    return true;
  }
}

async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
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

let harnessSerial = 0;

async function createHarness() {
  const control = {
    aiCalls: 0,
    aiReply: async () => "Tra loi mot lan",
    catalogCalls: [],
    loginCalls: 0,
    nextLoginApi: null,
    ownerWrites: new Map(),
    logs: [],
    currentOwner: () => null,
  };

  function countOwnerWrite(ownerUid) {
    const key = ownerUid == null ? "null" : String(ownerUid);
    control.ownerWrites.set(key, (control.ownerWrites.get(key) || 0) + 1);
  }

  class FakeZalo {
    async login() {
      control.loginCalls += 1;
      return control.nextLoginApi;
    }
    async loginQR() {
      throw new Error("QR khong duoc goi trong test");
    }
  }

  const deps = {
    Zalo: FakeZalo,
    LoginQRCallbackEventType: {},
    ThreadType: { User: 0, Group: 1 },
    AvatarSize: { Large: "large" },
    chonCamXuc: () => null,
    danhSachChoPhep: () => [],
    layBieuTuong: () => null,
    layMaTin: () => null,
    laTinHeThong: () => false,
    moTaSuKien: () => "su kien",
    botDuocGoi: () => true,
    taoBoGom,
    khoaGom,
    locRuotGan: (text) => ({ sach: String(text), daCat: false, soDongCat: 0 }),
    chonTinhHuong: () => null,
    layStickerHopLe: () => null,
    loadCredentials: async () => ({ fake: true }),
    saveCredentials: async () => undefined,
    xoaCredentials: async () => undefined,
    getThread: async (ownerUid, threadId) => ({ id: String(threadId), ownerUid: String(ownerUid), threadType: 0 }),
    getThreadMessages: async () => [],
    insertMessage: async (ownerUid) => {
      countOwnerWrite(ownerUid);
      return { changes: 1 };
    },
    listThreads: async () => [],
    rebuildThreadsFromMessages: async () => undefined,
    upsertThread: async (ownerUid, thread) => {
      countOwnerWrite(ownerUid);
      return { ...thread, ownerUid: String(ownerUid) };
    },
    getAutoReplyRules: async () => [],
    getPdfAutomationRuleWithBlob: async () => null,
    listEnabledPdfAutomationRules: async () => [],
    // Messaging Power Pack V1 them cac import nay vao zalo-service. Bang stub o
    // day duoc giu bang tay nen phai di theo; thieu mot ten la module da bien
    // doi nem ReferenceError truoc khi bat cu khang dinh nao chay.
    deleteLocalMessage: async () => true,
    markMessageRecalled: async () => true,
    recomputeThreadPreview: async () => null,
    resolveOwnedActionMessage: async () => ({ ok: false, code: "NOT_FOUND" }),
    rutDanhTinhProvider: () => null,
    layBieuTuongApp: () => null,
    tenBieuTuongApp: () => "KHAC",
    danhSachSticker: () => [],
    normalizeIncomingMessage: (message) => message,
    normalizeTs: (value) => Number(value),
    splitIntoBubbles: (text) => [String(text)],
    taoNguonDinhKemZalo: () => null,
    enrichExistingThread: async () => null,
    enrichMessagesForDisplay: async (_api, messages) => messages,
    resolveSenderAvatar: async () => null,
    resolveThreadMeta: async () => ({ title: "Hoi thoai", avatar: null }),
    syncThreadCatalog: async (_api, ownerUid) => {
      control.catalogCalls.push(String(ownerUid));
      countOwnerWrite(ownerUid);
    },
    attachOldMessagesListener: () => undefined,
    requestInitialHistorySync: () => undefined,
    resetHistorySyncState: () => undefined,
    syncHistoryForThread: async () => undefined,
    enrichMessageSticker: async (_api, message) => message,
    addLog: async (entry) => {
      control.logs.push(entry);
      countOwnerWrite(control.currentOwner());
      return entry;
    },
    capHinhChuTaiKhoanLog: () => undefined,
    capHinhChuTaiKhoanAdmin: () => undefined,
    laLenhAdmin: async () => false,
    xuLyLenh: async () => null,
    clearAllPendingPdfConfirmations: () => 0,
    createPdfAutomationHandler: ({
      listEnabledRules,
      getRuleWithBlob,
      sendMessage,
      isOriginCurrent,
      getOwnerUid,
      getRuntimeGeneration,
      log,
    }) => {
      assert.equal(typeof listEnabledRules, "function");
      assert.equal(typeof getRuleWithBlob, "function");
      assert.equal(typeof sendMessage, "function");
      assert.equal(typeof isOriginCurrent, "function");
      assert.equal(typeof getOwnerUid, "function");
      assert.equal(typeof getRuntimeGeneration, "function");
      assert.equal(typeof log, "function");
      return async () => "CONTINUE";
    },
    PDF_AUTOMATION_HANDLED: "HANDLED",
    aiChat: {
      capHinhChuTaiKhoan: () => undefined,
      refreshConfig: async () => undefined,
      getConfig: () => ({ botEnabled: true }),
      tryReply: async (...args) => {
        control.aiCalls += 1;
        return control.aiReply(...args);
      },
    },
    ownerCredentials: {
      configureCurrentOwnerResolver: () => undefined,
      projectOwnerCredentials: async () => undefined,
      withCurrentOwnerCredentialRead: async (_ownerUid, _config, operation) => operation(),
    },
  };

  const dependencyNames = Object.keys(deps);
  const importsEnd = zaloSource.indexOf("const USER_AGENT");
  assert.ok(importsEnd > 0, "Khong tim thay diem ket thuc imports zalo-service");
  const key = `__stab06_lane1_${process.pid}_${++harnessSerial}`;
  globalThis[key] = deps;
  const injected = `const { ${dependencyNames.join(", ")} } = globalThis[${JSON.stringify(key)}];\n`;
  const testSeams = `
export {
  finalizeLogin as __finalizeLogin,
  ghiNhanDut as __ghiNhanDut,
  henNoiLai as __henNoiLai,
  traLoiCumTin as __traLoiCumTin,
  taoOriginRuntime as __taoOriginRuntime,
  originConHieuLuc as __originConHieuLuc,
  voHieuHoaViecRuntimeCu as __voHieuHoaViecRuntimeCu,
  boGom as __boGom
};
export function __setDirectRuntime(testApi, uid) {
  api = testApi;
  appState.loggedIn = true;
  appState.uid = String(uid);
  appState.displayName = String(uid);
}
export function __getRuntimeGeneration() { return runtimeGeneration; }
`;
  const transformed = injected + zaloSource.slice(importsEnd) + testSeams;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${harnessSerial}`;
  try {
    const service = await import(moduleUrl);
    control.currentOwner = () => service.chuHienTai();
    return { service, control };
  } finally {
    delete globalThis[key];
  }
}

function makeApi(uid, label = uid) {
  const calls = {
    send: 0,
    seen: 0,
    typing: 0,
    stop: 0,
    start: 0,
  };
  const handlers = new Map();
  const api = {
    label,
    calls,
    getOwnId: () => String(uid),
    getUserInfo: async () => ({ [String(uid)]: { displayName: label, avatar: null } }),
    sendSeenEvent: async () => { calls.seen += 1; },
    sendTypingEvent: async () => { calls.typing += 1; },
    sendMessage: async () => {
      calls.send += 1;
      return { message: { msgId: `${label}-${calls.send}` } };
    },
    sendLink: async () => {
      calls.send += 1;
      return { msgId: `${label}-${calls.send}` };
    },
    listener: {
      on: (event, handler) => handlers.set(event, handler),
      start: () => { calls.start += 1; },
      stop: () => { calls.stop += 1; },
      ws: { readyState: 1 },
    },
  };
  return api;
}

function incoming(id = "incoming-1") {
  return {
    id,
    threadId: "thread-1",
    threadType: 0,
    senderId: "customer-1",
    senderName: "Khach",
    content: "Cho toi hoi mot cau",
    msgType: "chat.text",
    isSelf: false,
    ts: 1,
  };
}

async function startRuntime(service, api) {
  await service.__finalizeLogin(api);
  return service.__taoOriginRuntime();
}

async function finishOneReply(clock, aggregationTimerId) {
  clock.run(aggregationTimerId);
  await settle();
  const replyDelay = clock.idsWithDelay(1000)[0];
  assert.ok(replyDelay, "Khong thay nhip nghi truoc bubble");
  clock.run(replyDelay);
  await settle(60);
}

const tests = [];
function test(code, description, run) {
  tests.push({ code, description, run });
}

test("T1", "normal same-session aggregation completes exactly once", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    const originA = await startRuntime(service, apiA);
    service.__boGom.them(incoming(), originA);
    const aggregationTimer = clock.idsWithDelay(7000)[0];
    await finishOneReply(clock, aggregationTimer);
    assert.equal(control.aiCalls, 1);
    assert.equal(apiA.calls.send, 1);
  } finally {
    clock.restore();
  }
});

test("T2", "pending A aggregation is cancelled before B can act", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    const apiB = makeApi("B");
    const originA = await startRuntime(service, apiA);
    service.__boGom.them(incoming(), originA);
    const oldTimer = clock.idsWithDelay(7000)[0];
    await service.__finalizeLogin(apiB);
    const writesBefore = control.ownerWrites.get("B") || 0;
    clock.run(oldTimer, { force: true });
    await settle();
    assert.equal(apiB.calls.send, 0);
    assert.equal(control.ownerWrites.get("B") || 0, writesBefore);
    assert.equal(control.aiCalls, 0);
  } finally {
    clock.restore();
  }
});

test("T3", "A1 origin stays invalid after A to B to A2", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA1 = makeApi("A", "A1");
    const apiB = makeApi("B");
    const apiA2 = makeApi("A", "A2");
    const originA1 = await startRuntime(service, apiA1);
    service.__boGom.them(incoming(), originA1);
    const oldTimer = clock.idsWithDelay(7000)[0];
    await service.__finalizeLogin(apiB);
    await service.__finalizeLogin(apiA2);
    assert.equal(service.chuHienTai(), "A");
    assert.equal(service.__originConHieuLuc(originA1), false);
    clock.run(oldTimer, { force: true });
    await settle();
    assert.equal(apiA1.calls.send + apiB.calls.send + apiA2.calls.send, 0);
    assert.equal(control.aiCalls, 0);
  } finally {
    clock.restore();
  }
});

test("T4", "in-flight A reply cannot use B API or stale A API", async () => {
  const { service, control } = await createHarness();
  const pause = deferred();
  control.aiReply = () => pause.promise;
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    const apiB = makeApi("B");
    const originA = await startRuntime(service, apiA);
    service.__boGom.them(incoming(), originA);
    clock.run(clock.idsWithDelay(7000)[0]);
    await settle();
    assert.equal(control.aiCalls, 1);
    await service.__finalizeLogin(apiB);
    pause.resolve("Tra loi den tre");
    await settle(60);
    assert.equal(apiA.calls.send, 0);
    assert.equal(apiB.calls.send, 0);
  } finally {
    clock.restore();
  }
});

test("T5", "same-session in-flight reply remains valid", async () => {
  const { service, control } = await createHarness();
  const pause = deferred();
  control.aiReply = () => pause.promise;
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    const originA = await startRuntime(service, apiA);
    service.__boGom.them(incoming(), originA);
    clock.run(clock.idsWithDelay(7000)[0]);
    await settle();
    pause.resolve("Tra loi hop le");
    await settle();
    const replyDelay = clock.idsWithDelay(1000)[0];
    assert.ok(replyDelay);
    clock.run(replyDelay);
    await settle(60);
    assert.equal(apiA.calls.send, 1);
  } finally {
    clock.restore();
  }
});

test("T6", "stale reconnect timer cannot reconnect or stop B", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    const apiB = makeApi("B");
    await startRuntime(service, apiA);
    service.__ghiNhanDut("disconnected", 1006, "fake");
    const oldReconnect = clock.idsWithDelay(5000)[0];
    assert.ok(oldReconnect);
    await service.__finalizeLogin(apiB);
    clock.run(oldReconnect, { force: true });
    await settle(60);
    assert.equal(control.loginCalls, 0);
    assert.equal(apiB.calls.stop, 0);
  } finally {
    clock.restore();
  }
});

test("T7", "same-generation reconnect timer preserves normal reconnect", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A", "A-old");
    const apiANew = makeApi("A", "A-new");
    control.nextLoginApi = apiANew;
    await startRuntime(service, apiA);
    service.__ghiNhanDut("disconnected", 1006, "fake");
    const reconnectTimer = clock.idsWithDelay(5000)[0];
    clock.run(reconnectTimer);
    await settle(100);
    assert.equal(control.loginCalls, 1);
    assert.equal(apiA.calls.stop, 1);
    assert.equal(service.chuHienTai(), "A");
  } finally {
    clock.restore();
  }
});

test("T8", "stale delayed catalog timer cannot sync B", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    const apiB = makeApi("B");
    await startRuntime(service, apiA);
    const oldCatalog = clock.idsWithDelay(8000)[0];
    await service.__finalizeLogin(apiB);
    clock.run(oldCatalog, { force: true });
    await settle(60);
    assert.deepEqual(control.catalogCalls, []);
  } finally {
    clock.restore();
  }
});

test("T9", "same-generation delayed catalog sync still runs", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    await startRuntime(service, apiA);
    clock.run(clock.idsWithDelay(8000)[0]);
    await settle(60);
    assert.deepEqual(control.catalogCalls, ["A"]);
  } finally {
    clock.restore();
  }
});

test("T10", "runtime boundary clears aggregation state and disables old callback", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    const originA = await startRuntime(service, apiA);
    service.__boGom.them(incoming(), originA);
    const oldTimer = clock.idsWithDelay(7000)[0];
    assert.equal(service.__boGom.soCuaSo(), 1);
    await service.dangXuatZalo();
    assert.equal(service.__boGom.soCuaSo(), 0);
    clock.run(oldTimer, { force: true });
    await settle();
    assert.equal(control.aiCalls, 0);
    assert.equal(apiA.calls.send, 0);
  } finally {
    clock.restore();
  }
});

test("T11", "stale aggregation is neither retried nor rebound to B", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    const apiB = makeApi("B");
    const originA = await startRuntime(service, apiA);
    service.__boGom.them(incoming(), originA);
    const staleJob = clock.idsWithDelay(7000)[0];
    await service.__finalizeLogin(apiB);
    clock.run(staleJob, { force: true });
    await settle(60);
    assert.equal(control.aiCalls, 0);
    assert.equal(control.loginCalls, 0);
    assert.equal(apiA.calls.send + apiB.calls.send, 0);
  } finally {
    clock.restore();
  }
});

test("T12", "one valid event produces no duplicate current-session action", async () => {
  const { service, control } = await createHarness();
  const clock = new FakeClock();
  clock.install();
  try {
    const apiA = makeApi("A");
    const originA = await startRuntime(service, apiA);
    service.__boGom.them(incoming("only-event"), originA);
    const aggregationTimer = clock.idsWithDelay(7000)[0];
    await finishOneReply(clock, aggregationTimer);
    assert.equal(control.aiCalls, 1);
    assert.equal(apiA.calls.send, 1);
    assert.equal(service.__boGom.soCuaSo(), 0);
  } finally {
    clock.restore();
  }
});

test("T13", "tokenless direct send preserves existing behavior without generation setup", async () => {
  const { service } = await createHarness();
  const apiA = makeApi("A");
  assert.equal(service.__getRuntimeGeneration(), 0);
  service.__setDirectRuntime(apiA, "A");
  const result = await service.sendChatMessage({
    threadId: "direct-thread",
    threadType: 0,
    text: "Tin gui truc tiep",
  });
  assert.equal(apiA.calls.send, 1);
  assert.ok(result);
  assert.equal(service.__getRuntimeGeneration(), 0);
});

let passed = 0;
let failed = 0;
for (const { code, description, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${code} - ${description}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${code} - ${description}`);
    console.error(error?.stack || error);
  }
}

console.log(`\nSTAB06_L1_RESULT: ${passed}/${tests.length} PASS, ${failed} FAIL`);
if (failed) process.exitCode = 1;
