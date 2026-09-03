/**
 * Focused regression proof for STAB-05 Lane 2.
 *
 * Production function bodies are executed with deterministic in-memory fakes.
 * server.js is never imported: T9 is the explicitly approved, implementation-
 * coupled source-ordering assertion and does not start a listener/live app.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = {
  activity: fs.readFileSync(path.join(REPO, "lib", "activity-log.js"), "utf8"),
  zalo: fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8"),
  ai: fs.readFileSync(path.join(REPO, "lib", "ai-chat.js"), "utf8"),
  opencode: fs.readFileSync(path.join(REPO, "lib", "opencode.js"), "utf8"),
  server: fs.readFileSync(path.join(REPO, "server.js"), "utf8"),
  config: fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8"),
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

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

const activityDbKey = `__stab05_lane2_activity_db_${process.pid}`;
let activityDbBehavior = {
  get: async () => [],
  insert: async (entry) => entry,
};
globalThis[activityDbKey] = {
  getActivityLogs: (...args) => activityDbBehavior.get(...args),
  insertActivityLog: (...args) => activityDbBehavior.insert(...args),
};
const activityImport = 'import { getActivityLogs, insertActivityLog } from "./db.js";';
assert.equal(source.activity.includes(activityImport), true, "Khong tim thay activity DB import can stub");
const activityTestSource = source.activity.replace(
  activityImport,
  `const { getActivityLogs, insertActivityLog } = globalThis[${JSON.stringify(activityDbKey)}];`
);
const activityModuleUrl = `data:text/javascript;base64,${Buffer.from(activityTestSource).toString("base64")}`;
const activity = await import(activityModuleUrl);
activity.capHinhChuTaiKhoan(() => "STAB05_OWNER");

const autoReplyMessage = {
  id: "incoming-1",
  isSelf: false,
  threadId: "thread-1",
  threadType: 0,
  senderId: "customer-1",
  senderName: "Khach",
  msgType: "chat.text",
  content: "/hello",
};

function buildAutoReplyHarness({ sendChatMessage, addLog }) {
  return compileFunction(source.zalo, "async function handleNewIncomingMessage", {
    persistAndBroadcastMessage: async (message) => message,
    addLog,
    laTinHeThong: () => false,
    moTaSuKien: () => "su kien",
    laLenhAdmin: async () => false,
    xuLyLenh: async () => null,
    sendChatMessage,
    sendResolvedPrivateMessage: async () => undefined,
    aiChat: { getConfig: () => ({ botEnabled: true }) },
    botEligibilityEpoch: 0,
    botEligibilityConHieuLuc: (epoch) => epoch === 0,
    khoaThreadEligibility: (ownerUid, threadId) => `${ownerUid}\u0000${threadId}`,
    threadEligibilityEpochHienTai: () => 0,
    threadEligibilityConHieuLuc: (_key, epoch) => epoch === 0,
    automaticWorkConHieuLuc: (work) => work.capturedBotEligibilityEpoch === 0
      && work.capturedThreadEligibilityEpoch === 0,
    tuyChonGuiTuDong: (work) => ({
      botEligibilityEpoch: work.capturedBotEligibilityEpoch,
      threadEligibilityKey: work.threadEligibilityKey,
      threadEligibilityEpoch: work.capturedThreadEligibilityEpoch,
    }),
    getThread: async () => ({ botEnabled: true }),
    getAutoReplyRules: async () => [{
      command: "hello",
      reply_text: "Xin chao",
      normalize: false,
      match_anywhere: false,
    }],
    normalizeString: (value) => String(value).toLowerCase(),
    ThreadType: { User: 0, Group: 1 },
    botDuocGoi: () => false,
    appState: { uid: "bot-1" },
    boGom: { dangMo: () => false, them: () => undefined },
    console: { error: () => undefined },
  });
}

function buildBubbleHarness({ bubbles, sendAt }) {
  const logs = [];
  const sends = [];
  let seenCalls = 0;
  const run = compileFunction(source.zalo, "async function traLoiCumTin", {
    gopThanhMotTin: (messages) => messages[0],
    api: { sendSeenEvent: async () => undefined },
    automaticWorkConHieuLuc: () => true,
    tuyChonGuiTuDong: () => undefined,
    guiDaXemChoTins: () => { seenCalls += 1; },
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => () => undefined,
    aiChat: {
      getConfig: () => ({}),
      tryReply: async () => "AI reply",
    },
    ownerCredentials: { withCurrentOwnerCredentialRead: async (_owner, _config, work) => work() },
    chuHienTai: () => "STAB05_OWNER",
    ThreadType: { User: 0, Group: 1 },
    dungTrichDan: () => null,
    splitIntoBubbles: () => [...bubbles],
    doi: async () => undefined,
    nghiTruocBubble: () => 0,
    dungTheNhacTen: async (bubble) => ({ text: bubble, mentions: [] }),
    sendChatMessage: async (payload) => {
      sends.push(payload);
      return sendAt(sends.length, payload);
    },
    addLog: async (entry) => {
      logs.push(entry);
      return entry;
    },
    thuGuiSticker: async () => undefined,
    console: { error: () => undefined },
  });
  const message = {
    content: "Cau hoi",
    threadId: "thread-bubbles",
    threadType: 0,
    senderId: "customer-bubbles",
  };
  return {
    logs,
    sends,
    get seenCalls() { return seenCalls; },
    execute: () => run([message]),
  };
}

function buildFetchLogs(fetchImpl) {
  const list = {
    innerHTML: "",
    appended: [],
    append(entry) {
      this.appended.push(entry);
    },
  };
  const fetchLogs = compileFunction(source.config, "async function fetchLogs", {
    fetch: fetchImpl,
    list,
    renderEntry: (entry) => entry,
    console: { error: () => undefined },
  });
  return { list, fetchLogs };
}

function buildEnsureSession({ call, onEvent }) {
  return compileFunction(source.opencode, "export async function ensureSession", {
    getOpencodeSessionInfo: async () => null,
    PHIEN_MAX_LUOT: 30,
    deleteSessions: async () => undefined,
    deleteOpencodeSession: async () => undefined,
    call,
    saveOpencodeSession: async (...args) => onEvent?.("save", args),
    buildBootstrapMessage: () => "BOOTSTRAP",
    modelForSession: () => ({}),
    modelForMessage: () => ({}),
    KHONG_TOOL: {},
  });
}

const tests = [];
function test(code, description, run) {
  tests.push({ code, description, run });
}

test("T1", "fixed auto-reply logs success only after send resolves", async () => {
  const logs = [];
  let resolveSend;
  const sendPending = new Promise((resolve) => {
    resolveSend = resolve;
  });
  const handler = buildAutoReplyHarness({
    sendChatMessage: () => sendPending,
    addLog: async (entry) => {
      logs.push(entry);
      return entry;
    },
  });

  const running = handler(autoReplyMessage);
  await settle();
  assert.equal(logs.filter((entry) => entry.event === "auto_reply" && entry.level === "ok").length, 0);
  resolveSend({ ok: true });
  await running;
  assert.equal(logs.filter((entry) => entry.event === "auto_reply" && entry.level === "ok").length, 1);
});

test("T2", "fixed auto-reply failure has no false success and has truthful error", async () => {
  const logs = [];
  const handler = buildAutoReplyHarness({
    sendChatMessage: async () => { throw new Error("provider send failed"); },
    addLog: async (entry) => {
      logs.push(entry);
      return entry;
    },
  });
  await handler(autoReplyMessage);
  assert.equal(logs.some((entry) => entry.event === "auto_reply" && entry.level === "ok"), false);
  const failure = logs.find((entry) => entry.event === "auto_reply" && entry.level === "error");
  assert.ok(failure, "Thieu auto_reply error activity");
  assert.match(failure.summary, /KHÔNG gửi được câu trả lời cố định/);
  assert.equal(failure.detail.error, "provider send failed");
});

test("T3", "multi-bubble full success preserves success behavior", async () => {
  const harness = buildBubbleHarness({ bubbles: ["mot", "hai"], sendAt: async () => undefined });
  await harness.execute();
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.logs.length, 1);
  assert.equal(harness.logs[0].event, "send_ok");
  assert.equal(harness.logs[0].detail.sentBubbleCount, 2);
  assert.equal(harness.logs.some((entry) => entry.level === "error"), false);
  assert.equal(harness.seenCalls, 1, "duong guiDaXemChoTins phai duoc exercise");
});

test("T4", "first bubble failure reports complete failure with 0/N sent", async () => {
  const harness = buildBubbleHarness({
    bubbles: ["mot", "hai"],
    sendAt: async () => { throw new Error("bubble one failed"); },
  });
  await harness.execute();
  const failure = harness.logs.find((entry) => entry.event === "ai_error");
  assert.ok(failure);
  assert.equal(failure.detail.totalBubbleCount, 2);
  assert.equal(failure.detail.sentBubbleCount, 0);
  assert.equal(failure.detail.failedBubbleIndex, 1);
  assert.match(failure.summary, /KHÔNG gửi được qua Zalo/);
  assert.doesNotMatch(failure.summary, /Đã gửi \d+\/\d+ phần trả lời/);
  assert.equal(harness.seenCalls, 1, "duong guiDaXemChoTins phai duoc exercise");
});

test("T5", "later bubble failure reports canonical partial count", async () => {
  const harness = buildBubbleHarness({
    bubbles: ["mot", "hai", "ba"],
    sendAt: async (index) => {
      if (index === 2) throw new Error("bubble two failed");
    },
  });
  await harness.execute();
  const failure = harness.logs.find((entry) => entry.event === "ai_error");
  assert.ok(failure);
  assert.equal(failure.detail.totalBubbleCount, 3);
  assert.equal(failure.detail.sentBubbleCount, 1);
  assert.equal(failure.detail.failedBubbleIndex, 2);
  assert.equal(failure.summary, "Đã gửi 1/3 phần trả lời; lỗi khi gửi phần 2/3.");
  assert.doesNotMatch(failure.summary, /KHÔNG gửi được/);
  assert.equal(harness.sends.length, 2, "Khong duoc resend bubble da thanh cong");
  assert.equal(harness.seenCalls, 1, "duong guiDaXemChoTins phai duoc exercise");
});

test("T6", "activity DB read failure propagates instead of becoming []", async () => {
  const dbError = new Error("activity read failed");
  activityDbBehavior = {
    ...activityDbBehavior,
    get: async () => { throw dbError; },
  };
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await assert.rejects(activity.getRecentLogs(25), (error) => error === dbError);
  } finally {
    console.warn = originalWarn;
  }
});

test("T7", "genuine empty activity result remains the UI empty state", async () => {
  activityDbBehavior = { ...activityDbBehavior, get: async () => [] };
  assert.deepEqual(await activity.getRecentLogs(25), []);

  const ui = buildFetchLogs(async () => ({ ok: true, json: async () => ({ logs: [] }) }));
  await ui.fetchLogs();
  assert.match(ui.list.innerHTML, /Chưa có log nào\./);
  assert.doesNotMatch(ui.list.innerHTML, /Không thể tải nhật ký hoạt động\./);
});

test("T8", "failed /api/logs request renders the exact error state, not empty", async () => {
  const ui = buildFetchLogs(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: "activity read failed" }),
  }));
  await ui.fetchLogs();
  assert.match(ui.list.innerHTML, /Không thể tải nhật ký hoạt động\./);
  assert.doesNotMatch(ui.list.innerHTML, /Chưa có log nào\./);
});

test("T9", "login_ok is source-ordered after the session-save success boundary", () => {
  assert.equal(
    (source.server.match(/event:\s*"login_ok"/g) || []).length,
    1,
    "login_ok phai co dung mot write site trong login flow"
  );

  const completeLogin = extractFunction(source.server, "function completeLogin");
  const saveAt = completeLogin.indexOf("req.session.save(async (saveError) => {");
  const saveFailureAt = completeLogin.indexOf("if (saveError)", saveAt);
  const loginOkAt = completeLogin.indexOf('event: "login_ok"');
  const responseAt = completeLogin.indexOf("res.json({", loginOkAt);
  assert.ok(saveAt >= 0, "Khong tim thay session save success boundary");
  assert.ok(saveFailureAt > saveAt, "Khong tim thay fail-closed session save guard");
  assert.ok(loginOkAt > saveFailureAt, "login_ok phai sau save success guard");
  assert.ok(responseAt > loginOkAt, "login_ok phai nam trong completed-login success flow");

  const loginRouteStart = source.server.indexOf('app.post("/api/auth/login"');
  const loginRouteEnd = source.server.indexOf("// Hai route duoi day PHAI nam truoc cong chan", loginRouteStart);
  assert.ok(loginRouteStart >= 0 && loginRouteEnd > loginRouteStart, "Khong khoa duoc login route");
  const loginRoute = source.server.slice(loginRouteStart, loginRouteEnd);
  assert.equal(loginRoute.includes('event: "login_ok"'), false, "Password/OTP setup flow con false login_ok");
  assert.match(loginRoute, /if \(!user\.otpEnabled\) return completeLogin\(req, res, user\);/);

  const otpVerifyStart = source.server.indexOf('app.post("/api/auth/otp/verify"');
  const otpVerifyEnd = source.server.indexOf("// Chi nhung thu can de HIEN trang login", otpVerifyStart);
  assert.ok(otpVerifyStart >= 0 && otpVerifyEnd > otpVerifyStart, "Khong khoa duoc OTP verify route");
  const otpVerifyRoute = source.server.slice(otpVerifyStart, otpVerifyEnd);
  const verifiedAt = otpVerifyRoute.indexOf("if (!result.ok) return");
  const completesAt = otpVerifyRoute.indexOf("completeLogin(req, res, user)");
  assert.ok(verifiedAt >= 0 && completesAt > verifiedAt, "OTP failure van co the cham completed login");
});

test("T10", "bootstrap success activity occurs only after bootstrap completes", async () => {
  const failedEvents = [];
  const ensureFailure = buildEnsureSession({
    call: async (_config, requestPath) => {
      if (requestPath === "/session") return { id: "session-fail" };
      throw new Error("bootstrap failed");
    },
    onEvent: (kind) => failedEvents.push(kind),
  });
  const failureCallbackEvents = [];
  await assert.rejects(
    ensureFailure(
      { opencodeAgent: "general" },
      "owner-1",
      "thread-1",
      { threadTitle: "Thread" },
      async (event) => failureCallbackEvents.push(event)
    ),
    /bootstrap failed/
  );
  assert.deepEqual(failureCallbackEvents, [], "Bootstrap failure khong duoc co success-like event");

  const order = [];
  let resolveBootstrap;
  const bootstrapPending = new Promise((resolve) => {
    resolveBootstrap = resolve;
  });
  const ensureSuccess = buildEnsureSession({
    call: async (_config, requestPath) => {
      if (requestPath === "/session") {
        order.push("session-created");
        return { id: "session-ok" };
      }
      order.push("bootstrap-started");
      return bootstrapPending;
    },
    onEvent: (kind) => order.push(kind),
  });
  const successEvents = [];
  const running = ensureSuccess(
    { opencodeAgent: "general" },
    "owner-1",
    "thread-1",
    { threadTitle: "Thread" },
    async (event) => {
      order.push("success-activity");
      successEvents.push(event);
    }
  );
  await settle();
  assert.deepEqual(successEvents, [], "Bootstrap dang pending ma success activity da xuat hien");
  resolveBootstrap({ ok: true });
  await running;
  assert.equal(successEvents.length, 1);
  assert.ok(order.indexOf("bootstrap-started") < order.indexOf("success-activity"));
});

test("T11", "sendPrompt failure has no ai_prompt success and preserves ai_error path", async () => {
  const promptLogs = [];
  const generateReply = compileFunction(source.ai, "export async function generateReply", {
    layChuTaiKhoan: () => "owner-1",
    getConfig: () => null,
    isAiChatReady: () => true,
    buildBootstrapContext: async () => ({
      hasKnowledge: false,
      soTinLichSu: 0,
      threadTitle: "Thread",
    }),
    opencode: {
      ensureSession: async () => ({ sessionId: "session-1", created: false, turns: 4 }),
      sendPrompt: async () => { throw new Error("prompt failed"); },
    },
    customerMemory: {
      bocPrompt: async (_sessionId, _message, text) => text,
      quenPhien: () => undefined,
    },
    ThreadType: { User: 0, Group: 1 },
    docTep: { xuLyTep: async () => null },
    ganNhanTuDong: null,
    mocHienTai: () => "2026-08-28 12:00",
    emailCheck: { timEmailTrongTin: () => null, traCuu: async () => null, moTaChoAgent: () => "" },
    addLog: async (entry) => {
      promptLogs.push(entry);
      return entry;
    },
    bumpSessionTurns: async () => undefined,
    SKIP_TOKEN: "SKIP",
  });
  const config = {
    opencodeBaseUrl: "http://fake",
    opencodeAgent: "general",
    opencodeModel: "fake/model",
    allowedTopics: "topic",
    soul: "soul",
    docTep: false,
  };
  const message = { threadId: "thread-1", threadType: 1, content: "hello" };
  const result = await generateReply("hello", message, "owner-1", config);
  assert.equal(result.error, "prompt failed");
  assert.equal(promptLogs.some((entry) => entry.event === "ai_prompt"), false);

  const errorPathLogs = [];
  const tryReply = compileFunction(source.ai, "export async function tryReply", {
    layChuTaiKhoan: () => "owner-1",
    getConfig: () => config,
    shouldProcessMessage: () => true,
    addLog: async (entry) => {
      errorPathLogs.push(entry);
      return entry;
    },
    filterSkipReason: () => "",
    describeMessage: () => ({}),
    isAiChatReady: () => true,
    generateReply: async () => result,
    customerMemory: { ducKetNeuDenLuot: async () => undefined },
    console: { warn: () => undefined },
  });
  assert.equal(await tryReply("hello", message), null);
  assert.equal(errorPathLogs.some((entry) => entry.event === "ai_error" && entry.level === "error"), true);
});

test("T12", "activity INSERT failure stays diagnostic and non-fatal after send success", async () => {
  const writeError = new Error("activity insert failed");
  activityDbBehavior = {
    ...activityDbBehavior,
    insert: async () => { throw writeError; },
  };
  let sent = 0;
  const handler = buildAutoReplyHarness({
    sendChatMessage: async () => {
      sent += 1;
      return { ok: true };
    },
    addLog: activity.addLog,
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await handler(autoReplyMessage);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(sent, 1, "Business side effect phai van thanh cong");
  assert.ok(warnings.some((line) => line.includes("Khong ghi duoc log")));
  assert.equal(count(source.activity, "return null;"), 1, "addLog van la best-effort, khong co health infra");
});

let passed = 0;
let failed = 0;
for (const { code, description, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`${code} = PASS  ${description}`);
  } catch (error) {
    failed += 1;
    console.error(`${code} = FAIL  ${description}`);
    console.error(error);
  }
}

delete globalThis[activityDbKey];
console.log("T9_PROOF_MODE = SOURCE_ORDERING_ASSERTION");
console.log("T9_IS_IMPLEMENTATION_COUPLED = YES");
console.log("T9_BEHAVIORAL_PROOF = NO");
console.log("T9_REASON = server.js import starts listener/live app; behavioral harness would require out-of-scope server refactor");
console.log(`LANE2_PASS_COUNT = ${passed}`);
console.log(`LANE2_FAIL_COUNT = ${failed}`);
if (failed > 0) process.exitCode = 1;
