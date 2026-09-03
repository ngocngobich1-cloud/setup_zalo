/**
 * PER-CONVERSATION BOT TOGGLE V2 — focused acceptance PT01..PT24.
 * Zero provider call, zero production DB, zero network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taoBoGom } from "../lib/gom-tin.js";
import {
  clearAllPendingPdfConfirmations,
  clearPendingPdfConfirmationsForThread,
  createPdfAutomationHandler,
  getPendingPdfConfirmation,
  setPendingPdfConfirmation,
} from "../lib/pdf-automation.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = (file) => fs.readFileSync(path.join(REPO, file), "utf8");
const ZALO = source("lib/zalo-service.js");
const DB = source("lib/db.js");
const SERVER = source("server.js");
const APP = source("public/app.js");
const HTML = source("public/index.html");

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
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
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

function compileFunction(moduleSource, signature, dependencies) {
  const functionSource = extractFunction(moduleSource, signature).replace(/^export\s+/, "");
  const name = functionSource.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1];
  const names = Object.keys(dependencies);
  return Function(...names, `"use strict";\n${functionSource}\nreturn ${name};`)(
    ...names.map((key) => dependencies[key])
  );
}

function createRuntime({ ownerUid = "owner-A", globalEnabled = true, persisted = null } = {}) {
  const threadStates = persisted || new Map();
  const aggregations = [];
  const sends = [];
  const logs = [];
  const cancellations = { all: 0, threads: [], pdf: [] };
  const boGom = {
    dangMo: () => false,
    them: (message, work) => aggregations.push({ message, work }),
    huyTatCa: () => { cancellations.all += 1; aggregations.length = 0; },
    huyTheoThread: (threadId) => {
      cancellations.threads.push(String(threadId));
      for (let index = aggregations.length - 1; index >= 0; index -= 1) {
        if (String(aggregations[index].message.threadId) === String(threadId)) aggregations.splice(index, 1);
      }
    },
  };
  const config = { botEnabled: globalEnabled };

  const helpers = [
    "function botEligibilityConHieuLuc",
    "function khoaThreadEligibility",
    "function threadEligibilityEpochHienTai",
    "function threadEligibilityConHieuLuc",
    "function automaticWorkConHieuLuc",
    "function tuyChonGuiTuDong",
    "export function applyBotEligibilityTransition",
    "export function applyThreadBotEligibilityTransition",
  ].map((signature) => extractFunction(ZALO, signature).replace(/^export\s+/, "")).join("\n");
  const incoming = extractFunction(ZALO, "async function handleNewIncomingMessage");
  const dependencies = {
    boGom,
    clearPendingPdfConfirmationsForThread: (owner, thread) => {
      cancellations.pdf.push(`${owner}:${thread}`);
      return clearPendingPdfConfirmationsForThread(owner, thread);
    },
    persistAndBroadcastMessage: async (message) => message,
    originConHieuLuc: () => true,
    sendChatMessage: async (payload, options) => { sends.push({ payload, options }); return { id: "auto" }; },
    sendResolvedPrivateMessage: async () => null,
    chuHienTai: () => ownerUid,
    addLog: async (entry) => { logs.push(entry); },
    laTinHeThong: () => false,
    moTaSuKien: () => "event",
    laLenhAdmin: async () => false,
    xuLyLenh: async () => null,
    aiChat: { getConfig: () => config },
    getThread: async (owner, thread) => {
      const key = `${owner}\u0000${thread}`;
      return threadStates.has(key) ? { id: String(thread), botEnabled: threadStates.get(key) } : null;
    },
    getAutoReplyRules: async () => [{
      command: "go", match_anywhere: false, normalize: false, reply_text: "AUTO",
    }],
    normalizeString: (value) => String(value),
    ThreadType: { User: 0, Group: 1 },
    botDuocGoi: () => true,
    appState: { uid: ownerUid },
  };
  const names = Object.keys(dependencies);
  const factory = Function(...names, `
    "use strict";
    let botEligibilityEpoch = 0;
    const threadEligibilityEpochs = new Map();
    ${helpers}
    ${incoming}
    return {
      handleNewIncomingMessage,
      applyBotEligibilityTransition,
      applyThreadBotEligibilityTransition,
      capture(owner, thread) {
        const threadEligibilityKey = khoaThreadEligibility(owner, thread);
        return Object.freeze({
          originToken: null,
          capturedBotEligibilityEpoch: botEligibilityEpoch,
          threadEligibilityKey,
          capturedThreadEligibilityEpoch: threadEligibilityEpochHienTai(threadEligibilityKey),
        });
      },
      workCurrent: automaticWorkConHieuLuc,
      threadEpoch(owner, thread) { return threadEligibilityEpochHienTai(khoaThreadEligibility(owner, thread)); },
      clearEpochs() { threadEligibilityEpochs.clear(); },
    };
  `);
  const production = factory(...names.map((name) => dependencies[name]));
  return {
    ...production,
    ownerUid,
    threadStates,
    aggregations,
    sends,
    logs,
    cancellations,
    config,
    setThread(thread, enabled, owner = ownerUid) { threadStates.set(`${owner}\u0000${thread}`, Boolean(enabled)); },
    transitionThread(thread, previous, next, owner = ownerUid) {
      threadStates.set(`${owner}\u0000${thread}`, Boolean(next));
      return production.applyThreadBotEligibilityTransition(owner, thread, previous, next);
    },
    transitionGlobal(previous, next) {
      config.botEnabled = Boolean(next);
      return production.applyBotEligibilityTransition(previous, next);
    },
  };
}

function inbound(threadId, threadType = 0, senderId = "customer") {
  return {
    id: `in-${threadId}-${Date.now()}`,
    threadId,
    threadType,
    content: "/go",
    isSelf: false,
    senderId,
    senderName: "Khach",
    msgType: "chat.text",
    ts: Date.now(),
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
}

function compileToggleRoute(dependencies) {
  const marker = 'app.post("/api/threads/:threadId/bot/toggle"';
  const routeStart = SERVER.indexOf(marker);
  const arrowStart = SERVER.indexOf("async (req, res) =>", routeStart);
  const routeSource = extractFunction(SERVER.slice(arrowStart), "async (req, res) =>");
  const names = Object.keys(dependencies);
  return Function(...names, `"use strict"; return (${routeSource});`)(...names.map((name) => dependencies[name]));
}

const results = [];
async function test(code, description, fn) {
  try {
    await fn();
    results.push({ code, ok: true });
    console.log(`${code} = PASS  ${description}`);
  } catch (error) {
    results.push({ code, ok: false });
    console.error(`${code} = FAIL  ${description}\n${error.stack || error.message}`);
  }
}

await test("PT01", "Global ON + thread ON co automatic reply", async () => {
  const runtime = createRuntime();
  runtime.setThread("A", true);
  await runtime.handleNewIncomingMessage(inbound("A"));
  assert.equal(runtime.sends.length, 1);
  assert.equal(runtime.sends[0].options.threadEligibilityEpoch, 0);
});

await test("PT02", "Global ON + thread OFF khong automatic reply", async () => {
  const runtime = createRuntime();
  runtime.setThread("A", false);
  await runtime.handleNewIncomingMessage(inbound("A"));
  assert.equal(runtime.sends.length, 0);
  assert.equal(runtime.logs.at(-1)?.event, "thread_bot_off");
});

await test("PT03", "A OFF khong anh huong B ON", async () => {
  const runtime = createRuntime();
  runtime.setThread("A", false);
  runtime.setThread("B", true);
  await runtime.handleNewIncomingMessage(inbound("A"));
  await runtime.handleNewIncomingMessage(inbound("B"));
  assert.equal(runtime.sends.length, 1);
  assert.equal(runtime.sends[0].payload.threadId, "B");
});

await test("PT04", "Thread OFF van persist/display inbound", async () => {
  const runtime = createRuntime();
  runtime.setThread("A", false);
  await runtime.handleNewIncomingMessage(inbound("A"));
  assert.match(ZALO, /const processedMsg = await persistAndBroadcastMessage[\s\S]*?if \(!processedMsg\) return/);
  assert.equal(runtime.logs.some((entry) => entry.event === "message_in"), true);
});

await test("PT05", "Thread OFF khong chan manual text/image/file/sticker", () => {
  const manual = SERVER.slice(SERVER.indexOf('app.post("/api/send"'), SERVER.indexOf('app.post("/api/threads/refresh"'));
  assert.doesNotMatch(manual, /botEnabled|threadEligibility/);
  assert.match(manual, /attachment/);
  assert.match(SERVER, /app\.post\("\/api\/messaging\/sticker"/);
});

await test("PT06", "Reload-shaped thread payload giu OFF", () => {
  assert.match(DB, /SELECT local_id, owner_uid, remote_thread_id, thread_type, title, avatar, bot_enabled/);
  assert.match(DB, /botEnabled: Number\(row\.bot_enabled\) !== 0/);
  assert.match(APP, /state\.selectedThread = current/);
  assert.match(APP, /thread\?\.botEnabled !== false/);
});

await test("PT07", "Restart-shaped DB state giu OFF", async () => {
  assert.match(DB, /bot_enabled INTEGER NOT NULL DEFAULT 1/);
  assert.match(DB, /ALTER TABLE threads ADD COLUMN bot_enabled INTEGER NOT NULL DEFAULT 1/);
  const persisted = new Map([["owner-A\u0000A", false]]);
  const restarted = createRuntime({ persisted });
  await restarted.handleNewIncomingMessage(inbound("A"));
  assert.equal(restarted.sends.length, 0);
});

await test("PT08", "Pending aggregation cua A bi OFF huy rieng", async () => {
  const fired = [];
  const aggregate = taoBoGom({ choMs: 15, tranMs: 50, nhipKiemMs: 5, conDangGo: () => false, khiChot: (tins) => fired.push(tins) });
  aggregate.them({ id: "a", threadId: "A", senderId: "x" });
  assert.equal(aggregate.huyTheoThread("A"), 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fired.length, 0);
});

await test("PT09", "OFF -> ON khong lam authority cu song lai", () => {
  const runtime = createRuntime();
  const oldWork = runtime.capture("owner-A", "A");
  runtime.transitionThread("A", true, false);
  runtime.transitionThread("A", false, true);
  assert.equal(runtime.workCurrent(oldWork), false);
  assert.equal(runtime.threadEpoch("owner-A", "A"), 2);
});

await test("PT10", "OFF A khong cancel pending B/C", async () => {
  const fired = [];
  const aggregate = taoBoGom({ choMs: 15, tranMs: 50, nhipKiemMs: 5, conDangGo: () => false, khiChot: (tins) => fired.push(tins[0].threadId) });
  for (const id of ["A", "B", "C"]) aggregate.them({ id, threadId: id, senderId: "x" });
  aggregate.huyTheoThread("A");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(fired.sort(), ["B", "C"]);
});

await test("PT11", "PDF pending cu bi xoa qua OFF -> ON", () => {
  clearAllPendingPdfConfirmations();
  setPendingPdfConfirmation("owner-A", "A", "customer", { ruleId: 1, runtimeGeneration: 1 });
  const runtime = createRuntime();
  runtime.transitionThread("A", true, false);
  runtime.transitionThread("A", false, true);
  assert.equal(getPendingPdfConfirmation("owner-A", "A", "customer"), null);
});

await test("PT12", "PDF dang async xu ly bi OFF thi khong send", async () => {
  clearAllPendingPdfConfirmations();
  const runtime = createRuntime();
  const work = runtime.capture("owner-A", "A");
  setPendingPdfConfirmation("owner-A", "A", "customer", { ruleId: 7, runtimeGeneration: 1 });
  let release;
  const rule = new Promise((resolve) => { release = resolve; });
  const sends = [];
  const handler = createPdfAutomationHandler({
    listEnabledRules: async () => [],
    getRuleWithBlob: async () => rule,
    sendMessage: async (payload) => sends.push(payload),
    isOriginCurrent: () => true,
    isAutomaticWorkCurrent: runtime.workCurrent,
    getOwnerUid: () => "owner-A",
    getRuntimeGeneration: () => 1,
    log: async () => undefined,
  });
  const message = { content: "OK", threadId: "A", threadType: 0, senderId: "customer" };
  const running = handler({ tins: [message], tin: message, automaticWork: work });
  await Promise.resolve();
  runtime.transitionThread("A", true, false);
  release({ id: 7, enabled: true, pdfData: Buffer.from("%PDF"), pdfName: "a.pdf", pdfSize: 4, pdfMime: "application/pdf" });
  await running;
  assert.equal(sends.length, 0);
});

await test("PT13", "Automatic sticker delay revalidate thread epoch", async () => {
  const runtime = createRuntime();
  const work = runtime.capture("owner-A", "A");
  let sent = 0;
  const runSticker = compileFunction(ZALO, "async function thuGuiSticker", {
    originConHieuLuc: () => true,
    automaticWorkConHieuLuc: runtime.workCurrent,
    ThreadType: { User: 0 },
    api: { sendSticker: async () => undefined },
    chuHienTai: () => "owner-A",
    lanStickerCuoi: new Map(),
    GIAN_STICKER_MS: 0,
    chonTinhHuong: () => "thanks",
    layStickerHopLe: () => ({ moTa: "ok" }),
    doi: async () => { runtime.transitionThread("A", true, false); },
    sendStickerMessage: async () => { sent += 1; },
    addLog: async () => undefined,
    console: { warn: () => undefined },
  });
  await runSticker({ threadId: "A", threadType: 0, content: "cam on" }, null, work);
  assert.equal(sent, 0);
});

await test("PT14", "Automatic reaction stale authority khong react", async () => {
  const runtime = createRuntime();
  const work = runtime.capture("owner-A", "A");
  runtime.transitionThread("A", true, false);
  let reacted = 0;
  const runReaction = compileFunction(ZALO, "async function thuThaCamXuc", {
    originConHieuLuc: () => true,
    automaticWorkConHieuLuc: runtime.workCurrent,
    chonCamXuc: () => "HEART",
    layBieuTuong: () => "HEART",
    addLog: async () => undefined,
    danhSachChoPhep: () => ["HEART", "LIKE"],
    layMaTin: () => ({ msgId: "m" }),
    api: { addReaction: async () => undefined },
    reactToMessage: async () => { reacted += 1; },
    console: { warn: () => undefined },
  });
  await runReaction({ threadId: "A", threadType: 0, content: "cam on" }, null, work);
  assert.equal(reacted, 0);
});

await test("PT15", "Global OFF lam moi thread effective OFF", async () => {
  const runtime = createRuntime({ globalEnabled: false });
  runtime.setThread("A", true);
  runtime.setThread("B", true);
  await runtime.handleNewIncomingMessage(inbound("A"));
  await runtime.handleNewIncomingMessage(inbound("B"));
  assert.equal(runtime.sends.length, 0);
});

await test("PT16", "Global OFF van luu A/B, Global ON khoi phuc rieng", async () => {
  const runtime = createRuntime({ globalEnabled: false });
  runtime.setThread("A", true);
  runtime.setThread("B", false);
  runtime.transitionGlobal(false, true);
  await runtime.handleNewIncomingMessage(inbound("A"));
  await runtime.handleNewIncomingMessage(inbound("B"));
  assert.deepEqual(runtime.sends.map((entry) => entry.payload.threadId), ["A"]);
});

await test("PT17", "Owner isolation cung remote thread id", () => {
  const runtime = createRuntime();
  const owner2Work = runtime.capture("owner-B", "X");
  runtime.transitionThread("X", true, false, "owner-A");
  assert.equal(runtime.workCurrent(owner2Work), true);
  assert.equal(runtime.threadEpoch("owner-B", "X"), 0);
  assert.match(DB, /WHERE owner_uid = \? AND remote_thread_id = \? AND bot_enabled <> \?/);
});

await test("PT18", "Group OFF chan auto, manual contract van giu", async () => {
  const runtime = createRuntime();
  runtime.setThread("G", false);
  await runtime.handleNewIncomingMessage(inbound("G", 1, "member"));
  assert.equal(runtime.sends.length, 0);
  assert.doesNotMatch(SERVER.slice(SERVER.indexOf('app.post("/api/send"'), SERVER.indexOf('app.post("/api/threads/refresh"')), /threadEligibility|botEnabled/);
});

await test("PT19", "Switch A/B render dung state, khong stale", async () => {
  const buttonLabels = { desktop: { textContent: "" }, mobile: { textContent: "" } };
  const classes = new Set();
  const makeClassList = () => ({ toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } });
  const hintClasses = new Set(["hidden"]);
  const button = {
    disabled: false,
    attrs: new Map(),
    setAttribute(name, value) { this.attrs.set(name, value); },
    querySelector(selector) { return selector.includes("desktop") ? buttonLabels.desktop : buttonLabels.mobile; },
  };
  const status = {
    classList: makeClassList(),
    querySelector: () => ({ classList: { toggle(name, on) { if (on) hintClasses.add(name); else hintClasses.delete(name); } } }),
  };
  const state = { selectedThread: { id: "A", botEnabled: false }, globalBotEnabled: true };
  const ve = compileFunction(APP, "function veCongTacThread", { state, els: { btnThreadBotToggle: button, threadBotStatus: status } });
  ve();
  assert.equal(button.attrs.get("aria-pressed"), "false");
  assert.equal(buttonLabels.mobile.textContent, "Bật");
  state.selectedThread = { id: "B", botEnabled: true };
  ve();
  assert.equal(button.attrs.get("aria-pressed"), "true");
  assert.equal(buttonLabels.mobile.textContent, "Tắt");
  assert.match(HTML, /Bot tổng đang tắt\./);

  let transitioned = 0;
  let refreshed = null;
  const thread = { id: "B", botEnabled: false };
  const route = compileToggleRoute({
    chuHienTai: () => "owner-A",
    setThreadBotEnabled: async () => ({ changed: true, previousEnabled: true, enabled: false }),
    applyThreadBotEligibilityTransition: () => { transitioned += 1; },
    getThread: async () => thread,
    io: { emit: (event, payload) => { refreshed = { event, payload }; } },
  });
  const res = responseRecorder();
  await route({ body: { enabled: false }, params: { threadId: "B" } }, res);
  assert.equal(transitioned, 1);
  assert.deepEqual(refreshed, { event: "thread-refresh", payload: thread });
  assert.equal(res.body.thread.botEnabled, false);
});

await test("PT20", "Invalid enabled chi tra 400", async () => {
  const route = compileToggleRoute({
    chuHienTai: () => "owner-A",
    setThreadBotEnabled: async () => assert.fail("DB khong duoc goi"),
    applyThreadBotEligibilityTransition: () => assert.fail("transition khong duoc goi"),
    getThread: async () => null,
    io: { emit: () => undefined },
  });
  for (const enabled of ["false", "true", 1, 0, null, undefined]) {
    const res = responseRecorder();
    await route({ body: { enabled }, params: { threadId: "A" } }, res);
    assert.equal(res.statusCode, 400);
  }
});

await test("PT21", "Khong co current Zalo owner tra 400", async () => {
  const route = compileToggleRoute({
    chuHienTai: () => null,
    setThreadBotEnabled: async () => assert.fail("DB khong duoc goi"),
    applyThreadBotEligibilityTransition: () => undefined,
    getThread: async () => null,
    io: { emit: () => undefined },
  });
  const res = responseRecorder();
  await route({ body: { enabled: false }, params: { threadId: "A" } }, res);
  assert.equal(res.statusCode, 400);
});

await test("PT22", "Thread khong thuoc owner tra 404", async () => {
  const route = compileToggleRoute({
    chuHienTai: () => "owner-A",
    setThreadBotEnabled: async () => null,
    applyThreadBotEligibilityTransition: () => assert.fail("transition khong duoc goi"),
    getThread: async () => null,
    io: { emit: () => undefined },
  });
  const res = responseRecorder();
  await route({ body: { enabled: false }, params: { threadId: "owner-B-thread" } }, res);
  assert.equal(res.statusCode, 404);
});

await test("PT23", "No-op khong epoch/cancel/clear pending", async () => {
  clearAllPendingPdfConfirmations();
  setPendingPdfConfirmation("owner-A", "A", "customer", { ruleId: 1, runtimeGeneration: 1 });
  const runtime = createRuntime();
  const before = runtime.threadEpoch("owner-A", "A");
  runtime.transitionThread("A", true, true);
  assert.equal(runtime.threadEpoch("owner-A", "A"), before);
  assert.deepEqual(runtime.cancellations.threads, []);
  assert.deepEqual(runtime.cancellations.pdf, []);
  assert.ok(getPendingPdfConfirmation("owner-A", "A", "customer"));
  let transitions = 0;
  let emits = 0;
  const route = compileToggleRoute({
    chuHienTai: () => "owner-A",
    setThreadBotEnabled: async () => ({
      changed: false,
      previousEnabled: true,
      enabled: true,
      thread: { id: "A", botEnabled: true },
    }),
    applyThreadBotEligibilityTransition: () => { transitions += 1; },
    getThread: async () => assert.fail("no-op da co current thread"),
    io: { emit: () => { emits += 1; } },
  });
  const res = responseRecorder();
  await route({ body: { enabled: true }, params: { threadId: "A" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(transitions, 0);
  assert.equal(emits, 0);
  clearAllPendingPdfConfirmations();
});

await test("PT24", "Runtime invalidation reset thread epoch map", () => {
  const invalidator = extractFunction(ZALO, "function voHieuHoaViecRuntimeCu");
  const factory = Function("clearAllPendingPdfConfirmations", "boGom", `
    "use strict";
    let runtimeGeneration = 1;
    const threadEligibilityEpochs = new Map([["owner-A\\u0000A", 3]]);
    let dongHoNoiLai = null;
    let dongHoDongBoCatalog = null;
    let dangNoiLai = false;
    ${invalidator}
    return { run: voHieuHoaViecRuntimeCu, size: () => threadEligibilityEpochs.size };
  `)(() => undefined, { huyTatCa: () => undefined });
  assert.equal(factory.size(), 1);
  factory.run();
  assert.equal(factory.size(), 0);
  assert.doesNotMatch(invalidator, /getThread|await/);
  const aggregate = ZALO.slice(ZALO.indexOf("async function traLoiCumTin"), ZALO.indexOf("async function handleNewIncomingMessage"));
  assert.doesNotMatch(aggregate, /getThread|await getThread/);
});

const passed = results.filter((result) => result.ok).length;
console.log(`\nPER-THREAD BOT TOGGLE: ${passed}/${results.length} PASS`);
console.log("REAL_ZALO_CALL = 0");
console.log("PRODUCTION_DB_TOUCHED = NO");
if (passed !== results.length) process.exitCode = 1;
