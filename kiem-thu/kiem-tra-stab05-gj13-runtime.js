/**
 * Focused regression proof for STAB-05 Lane 3 / GJ-13.
 *
 * Production function bodies run with deterministic in-memory fakes. This file
 * does not import the live app, open the production DB, or contact Zalo/OpenCode.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = {
  ai: fs.readFileSync(path.join(REPO, "lib", "ai-chat.js"), "utf8"),
  zalo: fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8"),
};

function extractFunction(moduleSource, signature) {
  const start = moduleSource.indexOf(signature);
  assert.ok(start >= 0, `Khong tim thay function: ${signature}`);
  const bodyStart = moduleSource.indexOf("{", start + signature.length);
  assert.ok(bodyStart >= 0, `Khong tim thay function body: ${signature}`);

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
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return moduleSource.slice(start, index + 1);
    }
  }
  assert.fail(`Function body khong dong: ${signature}`);
}

function compileFunction(moduleSource, signature, dependencies) {
  const functionSource = extractFunction(moduleSource, signature).replace(/^export\s+/, "");
  const name = functionSource.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1];
  assert.ok(name, `Khong doc duoc ten function: ${signature}`);
  const dependencyNames = Object.keys(dependencies);
  const factory = Function(
    ...dependencyNames,
    `"use strict";\n${functionSource}\nreturn ${name};`
  );
  return factory(...dependencyNames.map((key) => dependencies[key]));
}

function warningCollector() {
  const warnings = [];
  return {
    warnings,
    console: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
  };
}

const config = {
  opencodeBaseUrl: "http://fake.invalid",
  opencodeAgent: "general",
  opencodeModel: "fake/model",
  allowedTopics: "topic",
  soul: "soul",
  roleTone: "helpful",
  useKnowledge: false,
  knowledgeFileIds: [],
  docTep: false,
};

function buildContextHarness({ getThread, console }) {
  return compileFunction(source.ai, "export async function buildBootstrapContext", {
    getConfig: () => config,
    layChuTaiKhoan: () => "owner-1",
    knowledge: { getContentsForAi: async () => "" },
    console,
    addLog: async () => undefined,
    getThread,
    buildRecentHistory: async () => "customer: prior message",
    KNOWLEDGE_MAX_CHARS: 12000,
  });
}

function buildGenerateHarness({ buildBootstrapContext, bocPrompt, console }) {
  const observed = { context: null, prompt: null, logs: [] };
  const generateReply = compileFunction(source.ai, "export async function generateReply", {
    layChuTaiKhoan: () => "owner-1",
    getConfig: () => config,
    isAiChatReady: () => true,
    buildBootstrapContext,
    opencode: {
      ensureSession: async (_config, _ownerUid, _threadId, context) => {
        observed.context = context;
        return { sessionId: "session-1", created: false, turns: 2 };
      },
      sendPrompt: async (_config, _sessionId, prompt) => {
        observed.prompt = prompt;
        return { reply: "AI reply", tokens: null, model: "fake/model" };
      },
    },
    customerMemory: { bocPrompt, quenPhien: () => undefined },
    ThreadType: { User: 0, Group: 1 },
    docTep: { xuLyTep: async () => null },
    ganNhanTuDong: null,
    mocHienTai: () => "2026-08-28 12:00",
    emailCheck: {
      timEmailTrongTin: () => null,
      traCuu: async () => null,
      moTaChoAgent: () => "",
    },
    addLog: async (entry) => {
      observed.logs.push(entry);
      return entry;
    },
    bumpSessionTurns: async () => undefined,
    SKIP_TOKEN: "SKIP",
    console,
  });
  return { generateReply, observed };
}

async function runRealtimeFailure(ownerUid) {
  const handlers = new Map();
  const activity = [];
  const consoleErrors = [];
  let processingCount = 0;
  let startCount = 0;
  const normalized = {
    id: "incoming-1",
    threadId: "thread-1",
    threadType: 0,
    senderId: "customer-1",
    msgType: "chat.text",
    content: "hello",
  };
  const setupListener = compileFunction(source.zalo, "function setupListener", {
    listenerAttached: false,
    api: {
      listener: {
        on: (event, handler) => handlers.set(event, handler),
        start: () => { startCount += 1; },
      },
    },
    attachOldMessagesListener: () => undefined,
    chuHienTai: () => ownerUid,
    rebuildThreadsFromMessages: async () => undefined,
    emitThreads: async () => undefined,
    normalizeIncomingMessage: () => normalized,
    handleNewIncomingMessage: async () => {
      processingCount += 1;
      throw new Error("incoming processing failed");
    },
    console: { error: (...args) => consoleErrors.push(args) },
    addLog: async (entry) => {
      activity.push(entry);
      return entry;
    },
    datTrangThaiKetNoi: () => undefined,
  });

  setupListener();
  assert.equal(startCount, 1);
  assert.equal(typeof handlers.get("message"), "function");
  await handlers.get("message")({ raw: "not inspected" });
  return { activity, consoleErrors, processingCount };
}

function buildSendFailureHarness() {
  const logs = [];
  let sendCount = 0;
  const run = compileFunction(source.zalo, "async function traLoiCumTin", {
    gopThanhMotTin: (messages) => messages[0],
    api: { sendSeenEvent: async () => undefined },
    automaticWorkConHieuLuc: () => true,
    tuyChonGuiTuDong: () => undefined,
    guiDaXemChoTins: () => undefined,
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => () => undefined,
    aiChat: {
      getConfig: () => ({}),
      tryReply: async () => "AI reply",
    },
    ownerCredentials: { withCurrentOwnerCredentialRead: async (_owner, _config, work) => work() },
    chuHienTai: () => "GJ13_OWNER",
    ThreadType: { User: 0, Group: 1 },
    dungTrichDan: () => null,
    splitIntoBubbles: () => ["AI reply"],
    doi: async () => undefined,
    nghiTruocBubble: () => 0,
    dungTheNhacTen: async (text) => ({ text, mentions: [] }),
    sendChatMessage: async () => {
      sendCount += 1;
      throw new Error("send failed");
    },
    addLog: async (entry) => {
      logs.push(entry);
      return entry;
    },
    thuGuiSticker: async () => undefined,
    console: { error: () => undefined },
  });
  const message = {
    id: "incoming-send",
    content: "question",
    threadId: "thread-send",
    threadType: 0,
    senderId: "customer-send",
  };
  return { execute: () => run([message]), logs, get sendCount() { return sendCount; } };
}

const tests = [];
function test(code, description, run) {
  tests.push({ code, description, run });
}

test("T1", "thread lookup rejection is diagnostic and does not abort AI", async () => {
  const captured = warningCollector();
  const buildBootstrapContext = buildContextHarness({
    getThread: async () => { throw new Error("thread DB unavailable"); },
    console: captured.console,
  });
  const harness = buildGenerateHarness({
    buildBootstrapContext,
    bocPrompt: async (_sessionId, _message, text) => text,
    console: captured.console,
  });
  const result = await harness.generateReply(
    "original message",
    { id: "message-1", threadId: "thread-fail", threadType: 1 },
    "owner-1",
    config
  );
  assert.equal(result.reply, "AI reply");
  assert.equal(harness.observed.context.threadTitle, "thread-fail");
  assert.ok(captured.warnings.some((line) => line.includes("Thread lookup failed")));
});

test("T2", "successful thread lookup keeps context and emits no false diagnostic", async () => {
  const captured = warningCollector();
  const buildBootstrapContext = buildContextHarness({
    getThread: async () => ({ title: "Known thread" }),
    console: captured.console,
  });
  const harness = buildGenerateHarness({
    buildBootstrapContext,
    bocPrompt: async (_sessionId, _message, text) => text,
    console: captured.console,
  });
  const result = await harness.generateReply(
    "original message",
    { id: "message-2", threadId: "thread-ok", threadType: 1 },
    "owner-1",
    config
  );
  assert.equal(result.reply, "AI reply");
  assert.equal(harness.observed.context.threadTitle, "Known thread");
  assert.equal(captured.warnings.some((line) => line.includes("Thread lookup failed")), false);
});

test("T3", "customer enrichment rejection is diagnostic and uses the raw message", async () => {
  const captured = warningCollector();
  const rawMessage = "raw customer message";
  const harness = buildGenerateHarness({
    buildBootstrapContext: async () => ({
      hasKnowledge: false,
      soTinLichSu: 0,
      threadTitle: "Thread",
    }),
    bocPrompt: async () => { throw new Error("customer memory unavailable"); },
    console: captured.console,
  });
  const result = await harness.generateReply(
    rawMessage,
    { id: "message-3", threadId: "thread-memory-fail", threadType: 1 },
    "owner-1",
    config
  );
  assert.equal(result.reply, "AI reply");
  assert.ok(harness.observed.prompt.endsWith(rawMessage));
  assert.ok(captured.warnings.some((line) => line.includes("Customer-context enrichment failed")));
});

test("T4", "successful customer enrichment keeps the enriched prompt unchanged", async () => {
  const captured = warningCollector();
  const enriched = "# HỒ SƠ KHÁCH\nEnriched prompt";
  const harness = buildGenerateHarness({
    buildBootstrapContext: async () => ({
      hasKnowledge: false,
      soTinLichSu: 0,
      threadTitle: "Thread",
    }),
    bocPrompt: async () => enriched,
    console: captured.console,
  });
  const result = await harness.generateReply(
    "raw customer message",
    { id: "message-4", threadId: "thread-memory-ok", threadType: 1 },
    "owner-1",
    config
  );
  assert.equal(result.reply, "AI reply");
  assert.ok(harness.observed.prompt.endsWith(enriched));
  assert.equal(captured.warnings.some((line) => line.includes("Customer-context enrichment failed")), false);
});

test("T5", "unexpected realtime processing failure has console and owned activity evidence", async () => {
  const result = await runRealtimeFailure("owner-1");
  assert.equal(result.consoleErrors.length, 1);
  const failure = result.activity.find((entry) => entry.event === "zalo_xu_ly_realtime_loi");
  assert.ok(failure, "Thieu activity error cho realtime failure co owner");
  assert.equal(failure.level, "error");
  assert.equal(failure.detail.stage, "incoming_processing");
  assert.equal(failure.detail.threadId, "thread-1");
  assert.equal(result.activity.some((entry) => entry.level === "ok"), false);
});

test("T6", "one failed realtime event is processed exactly once", async () => {
  const result = await runRealtimeFailure("owner-1");
  assert.equal(result.processingCount, 1);
  assert.equal(result.activity.filter((entry) => entry.event === "zalo_xu_ly_realtime_loi").length, 1);
});

test("T7", "missing owner keeps console evidence without any activity write", async () => {
  const result = await runRealtimeFailure(null);
  assert.equal(result.processingCount, 1);
  assert.equal(result.consoleErrors.length, 1);
  assert.deepEqual(result.activity, []);
});

test("T8", "send failure preserves Lane 2 no-false-success semantics", async () => {
  const harness = buildSendFailureHarness();
  await harness.execute();
  assert.equal(harness.sendCount, 1);
  assert.equal(harness.logs.some((entry) => entry.event === "send_ok" && entry.level === "ok"), false);
  assert.equal(harness.logs.some((entry) => entry.event === "ai_error" && entry.level === "error"), true);
});

let passed = 0;
let failed = 0;
for (const { code, description, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS - ${code}: ${description}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${code}: ${description}`);
    console.error(error);
  }
}

console.log(`LANE3_PASS_COUNT = ${passed}`);
console.log(`LANE3_FAIL_COUNT = ${failed}`);
if (failed > 0) process.exitCode = 1;
