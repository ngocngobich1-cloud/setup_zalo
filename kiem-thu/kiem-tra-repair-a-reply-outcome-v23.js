/**
 * VIZENBOT REPAIR A V2.3 — AI reply outcome + durable failure propagation.
 *
 * Chung minh: mot luot AI dang le phai tra loi nhung that bai KHONG con bien
 * thanh null im lang; no di duoc toi durableFailure + durableFailureCode va
 * khong bao gio settle DONE.
 *
 * Khong LLM that, khong Zalo that, khong provider that, khong dung DB production.
 * Chay: node --import ./kiem-thu/sqlite3-node24-test-register.js kiem-thu/kiem-tra-repair-a-reply-outcome-v23.js
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { splitIntoBubbles } from "../lib/message-utils.js";
import { locRuotGan } from "../lib/loc-ruot-gan.js";
import { FAILURE_CODES, classifyProviderFailure } from "../lib/provider-failure.js";
import { ADMIN_CLARIFICATION_STATUS } from "../lib/admin-clarification.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(THIS_FILE), "..");
const source = (file) => fs.readFileSync(path.join(REPO, file), "utf8");
const AI = source("lib/ai-chat.js");
const ZALO = source("lib/zalo-service.js");
const QUEUE = source("lib/durable-message-queue.js");

// ai-chat.js keo theo ca pdfjs qua doc-tep; tren host khong co native canvas thi
// import module se hong. Contract export duoc doc thang tu source, khong stub.
const { REPLY_OUTCOME_KINDS, REPLY_FAILURE_CODES, TERMINAL_NO_REPLY_REASONS } = (() => {
  const block = AI.slice(
    AI.indexOf("export const REPLY_OUTCOME_KINDS"),
    AI.indexOf("/** Nhan tu dong dan len hoi thoai khi khach gui PDF.")
  );
  assert.ok(block.includes("REPLY_FAILURE_CODES"), "Khong tach duoc khoi contract cua Repair A");
  return Function("FAILURE_CODES", `"use strict";\n${block.replace(/^export /gm, "")}
    return { REPLY_OUTCOME_KINDS, REPLY_FAILURE_CODES, TERMINAL_NO_REPLY_REASONS };`)(FAILURE_CODES);
})();

const results = [];
async function test(id, name, run) {
  try {
    await run();
    results.push({ id, pass: true });
    console.log(`PASS ${id} ${name}`);
  } catch (error) {
    results.push({ id, pass: false });
    console.error(`FAIL ${id} ${name}\n${error.stack || error.message}`);
  }
}

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

function compileFunction(moduleSource, signature, dependencies) {
  const functionSource = extractFunction(moduleSource, signature).replace(/^export\s+/, "");
  const name = functionSource.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1];
  const names = Object.keys(dependencies);
  return Function(...names, `"use strict";\n${functionSource}\nreturn ${name};`)(
    ...names.map((key) => dependencies[key])
  );
}

const chuanHoaDong = (text) => String(text).replace(/\r\n/g, "\n");

/** Ban HEAD da chuan hoa xuong dong (git luu LF, working tree dung CRLF). */
function headSource(file) {
  return chuanHoaDong(execFileSync("git", ["show", `HEAD:${file}`], { cwd: REPO, encoding: "utf8" }));
}

/** So sanh noi dung file voi ban HEAD, khong in ca file khi lech. */
function assertUnchangedVsHead(file) {
  assert.ok(chuanHoaDong(source(file)) === headSource(file), `${file} phai giu nguyen nhu HEAD`);
}

// ---------------------------------------------------------------------------
// generateReply: MOI error-result deu phai kem failureCode khong rong.
// ---------------------------------------------------------------------------

const ROUTE_MODES = { PRIMARY_ONLY: "PRIMARY_ONLY", RUNTIME_FAILOVER: "RUNTIME_FAILOVER" };

function generateReplyHarness({
  catalogError = null,
  sessionError = null,
  primaryError = null,
  secondaryError = null,
  failoverAllowed = false,
  reply = "Chào anh/chị.",
  afterPromptError = null,
  routingEnabled = true,
  decisionMode = false,
  parsed = null,
} = {}) {
  const logs = [];
  const config = {
    opencodeBaseUrl: "http://fixture.invalid",
    opencodeModel: "primary/model",
    opencodeFallbackModel: "secondary/model",
    opencodeFailoverEnabled: true,
    opencodeAgent: "general",
    allowedTopics: "fixture",
    soul: "fixture soul",
    roleTone: "fixture role",
    capabilityRoutingEnabled: routingEnabled,
    adminClarificationDecisionEnabled: decisionMode,
  };
  const sendPromptCalls = [];
  const opencode = {
    loadChatProviders: async () => { if (catalogError) throw catalogError; return []; },
    ensureSession: async () => {
      if (sessionError) throw sessionError;
      return { sessionId: "session-fixture", created: false, turns: 1 };
    },
    sendPrompt: async (cfg) => {
      sendPromptCalls.push(cfg.opencodeModel);
      if (sendPromptCalls.length === 1 && primaryError) throw primaryError;
      if (sendPromptCalls.length === 2 && secondaryError) throw secondaryError;
      return { reply, tokens: null, model: cfg.opencodeModel };
    },
    knowledgeLedger: { has: () => false, add: () => {}, cumulative: () => 0 },
  };
  const generateReply = compileFunction(AI, "export async function generateReply", {
    layChuTaiKhoan: () => "owner-fixture",
    getConfig: () => config,
    isAiChatReady: () => true,
    customerRequiredCapabilities: () => ["TEXT"],
    createCallBudget: () => ({ consume: () => {}, snapshot: () => ({ callsUsed: 1, secondaryUsed: false }) }),
    opencode,
    buildBootstrapContext: async () => ({ soul: "s", recentHistory: "", threadTitle: "T", soTinLichSu: 0 }),
    ThreadType: { User: 0, Group: 1 },
    docTep: { xuLyTep: async () => null, STICKER_VISION_FAILURE_MARKER: "x" },
    ganNhanTuDong: null,
    NHAN_PDF: "pdf",
    customerMemory: { bocPrompt: async (_s, _m, text) => text, quenPhien: () => {} },
    mocHienTai: () => "19/09/2026 10:00",
    addLog: async (entry) => { logs.push(entry); },
    bumpSessionTurns: async () => { if (afterPromptError) throw afterPromptError; },
    // Classifier canonical THAT, khong stub: chinh no quyet dinh failureCode.
    classifyProviderFailure,
    routeModelRequest: ({ phase }) => (phase === "FAILOVER"
      ? {
          routeMode: failoverAllowed ? ROUTE_MODES.RUNTIME_FAILOVER : ROUTE_MODES.PRIMARY_ONLY,
          secondaryModel: "secondary/model",
        }
      : { routeMode: ROUTE_MODES.PRIMARY_ONLY }),
    CAPABILITIES: { TEXT: "TEXT", IMAGE_INPUT: "IMAGE_INPUT", FILE_INPUT: "FILE_INPUT" },
    SURFACES: { CUSTOMER: "CUSTOMER" },
    ROUTE_MODES,
    ownerFacingFailureMessage: (code) => `Owner text cho ${code}`,
    SKIP_TOKEN: "SKIP",
    knowledge: { retrieveForAi: async () => ({ units: [], stats: { selectedCharCount: 0 } }) },
    KNOWLEDGE_MAX_CHARS: 12000,
    formatKnowledge: () => "",
    performance,
    DECISION_INSTRUCTION: "",
    buildCorrectiveRetryInstruction: () => "",
    parseDecisionReply: () => parsed || { valid: true, decision: "ANSWERABLE", body: reply },
    recordDecisionProtocolOutcome: async () => {},
    console: { warn: () => {} },
  });
  const message = { id: "m1", threadId: "T", threadType: 0, senderId: "customer", content: "hoi bot" };
  return {
    logs,
    sendPromptCalls,
    run: () => generateReply("hoi bot", message, "owner-fixture", config),
  };
}

const timeoutError = () => Object.assign(new Error("request timed out"), { code: "OPENCODE_TIMEOUT" });
const unavailableError = () => Object.assign(new Error("upstream down"), { status: 503 });
const invalidKeyError = () => Object.assign(new Error("invalid api key"), { status: 401 });
const quotaError = () => Object.assign(new Error("insufficient quota"), { status: 402 });
const badRequestError = () => Object.assign(new Error("model not found"), { status: 400 });
const rateLimitedError = () => Object.assign(new Error("too many requests"), { status: 429 });
const opaqueError = () => new Error("một lỗi nội bộ không xác định được");

/** Invariant chung cho MOI error-result cua generateReply. */
function assertErrorResultInvariant(result, label) {
  assert.notEqual(result.error, null, `${label}: phai co error`);
  assert.equal(typeof result.failureCode, "string", `${label}: failureCode phai la chuoi`);
  assert.ok(result.failureCode.trim().length > 0, `${label}: failureCode khong duoc rong`);
}

await test("A38", "capability catalog / session creation giu canonical code cua ORIGINAL error", async () => {
  const catalog503 = await generateReplyHarness({ catalogError: unavailableError() }).run();
  assertErrorResultInvariant(catalog503, "catalog 503");
  assert.equal(catalog503.failureCode, FAILURE_CODES.PROVIDER_UNAVAILABLE);
  // Chung minh KHONG classify lai tu owner-facing text: chinh cau text do neu
  // dem classify lai se ra unknown, khac hoan toan code dang duoc giu.
  assert.equal(classifyProviderFailure(new Error(catalog503.error)), FAILURE_CODES.UNKNOWN_PROVIDER_ERROR);

  const catalogTimeout = await generateReplyHarness({ catalogError: timeoutError() }).run();
  assertErrorResultInvariant(catalogTimeout, "catalog timeout");
  assert.equal(catalogTimeout.failureCode, FAILURE_CODES.TIMEOUT);

  const session503 = await generateReplyHarness({ sessionError: unavailableError() }).run();
  assertErrorResultInvariant(session503, "session 503");
  assert.equal(session503.failureCode, FAILURE_CODES.PROVIDER_UNAVAILABLE);

  const sessionTimeout = await generateReplyHarness({ sessionError: timeoutError() }).run();
  assertErrorResultInvariant(sessionTimeout, "session timeout");
  assert.equal(sessionTimeout.failureCode, FAILURE_CODES.TIMEOUT);
});

await test("A39", "loi noi bo khong nhan dien duoc van co canonical UNKNOWN_PROVIDER_ERROR", async () => {
  const session = await generateReplyHarness({ sessionError: opaqueError() }).run();
  assertErrorResultInvariant(session, "session opaque");
  assert.equal(session.failureCode, FAILURE_CODES.UNKNOWN_PROVIDER_ERROR);

  const outer = await generateReplyHarness({ afterPromptError: opaqueError() }).run();
  assertErrorResultInvariant(outer, "outer catch opaque");
  assert.equal(outer.failureCode, FAILURE_CODES.UNKNOWN_PROVIDER_ERROR);
  assert.equal(outer.failureCode, REPLY_FAILURE_CODES.UNKNOWN);
});

await test("A1", "primary TIMEOUT + failover cung that bai -> durable code giu TIMEOUT", async () => {
  const fixture = generateReplyHarness({
    primaryError: timeoutError(),
    secondaryError: invalidKeyError(),
    failoverAllowed: true,
  });
  const result = await fixture.run();
  assertErrorResultInvariant(result, "double failure");
  assert.equal(result.failureCode, FAILURE_CODES.TIMEOUT);
  assert.deepEqual(fixture.sendPromptCalls, ["primary/model", "secondary/model"]);
  // Secondary chi duoc dung cho diagnostic/log, khong thay durable code.
  const secondaryLog = fixture.logs.find((entry) => entry.event === "ai_secondary_route");
  assert.equal(secondaryLog.detail.classifiedReason, FAILURE_CODES.TIMEOUT);
  assert.equal(secondaryLog.detail.secondaryClassifiedReason, FAILURE_CODES.INVALID_KEY);
});

await test("A2", "primary that bai nhung secondary thanh cong -> khong error, co reply", async () => {
  const fixture = generateReplyHarness({
    primaryError: timeoutError(),
    failoverAllowed: true,
    reply: "Secondary da tra loi.",
  });
  const result = await fixture.run();
  assert.equal(result.error, null);
  assert.equal(result.failureCode, null);
  assert.equal(result.reply, "Secondary da tra loi.");
  assert.deepEqual(fixture.sendPromptCalls, ["primary/model", "secondary/model"]);
});

await test("A3", "RATE_LIMITED / PROVIDER_UNAVAILABLE primary duoc giu qua double failure", async () => {
  for (const [error, expected] of [
    [rateLimitedError(), FAILURE_CODES.RATE_LIMITED],
    [unavailableError(), FAILURE_CODES.PROVIDER_UNAVAILABLE],
  ]) {
    const result = await generateReplyHarness({
      primaryError: error,
      secondaryError: badRequestError(),
      failoverAllowed: true,
    }).run();
    assertErrorResultInvariant(result, `primary ${expected}`);
    assert.equal(result.failureCode, expected);
  }
});

await test("A4", "INVALID_KEY / QUOTA_EXHAUSTED / BAD_REQUEST cua primary duoc giu nguyen", async () => {
  for (const [error, expected] of [
    [invalidKeyError(), FAILURE_CODES.INVALID_KEY],
    [quotaError(), FAILURE_CODES.QUOTA_EXHAUSTED],
    [badRequestError(), FAILURE_CODES.BAD_REQUEST],
  ]) {
    const result = await generateReplyHarness({ primaryError: error, failoverAllowed: false }).run();
    assertErrorResultInvariant(result, `primary ${expected}`);
    assert.equal(result.failureCode, expected);
    assert.equal(result.error, `Owner text cho ${expected}`);
  }
});

await test("A40", "moi error-result path cua generateReply deu co failureCode khong rong", async () => {
  const generateBody = extractFunction(AI, "export async function generateReply");
  // Kiem ke tinh: MOI object ket qua co `error:` deu phai kem `failureCode`.
  // `error: null` la khai bao cua `base`, khong phai mot error-result path.
  const errorSites = [...generateBody.matchAll(/error: (?!null)/g)].map((match) => match.index);
  assert.equal(errorSites.length, 7, "So error-result path thay doi — phai audit lai");
  for (const index of errorSites) {
    const openAt = generateBody.lastIndexOf("return {", index);
    const closeAt = generateBody.indexOf("};", index);
    assert.ok(openAt >= 0 && closeAt > index, "error: phai nam trong mot return object");
    const objectText = generateBody.slice(openAt, closeAt);
    assert.ok(
      objectText.includes("failureCode"),
      `error-result path thieu failureCode: ${objectText.slice(0, 90)}`
    );
  }

  const notConfigured = await (async () => {
    const harness = compileFunction(AI, "export async function generateReply", {
      layChuTaiKhoan: () => null, getConfig: () => null, isAiChatReady: () => false,
    });
    return harness("x", {}, null, null);
  })();
  assertErrorResultInvariant(notConfigured, "AI_NOT_CONFIGURED");
  assert.equal(notConfigured.failureCode, REPLY_FAILURE_CODES.AI_NOT_CONFIGURED);

  const malformed = await generateReplyHarness({
    decisionMode: true,
    parsed: { valid: false, decision: null, body: "", reason: "MISSING_OR_INVALID_TOKEN" },
  }).run();
  assertErrorResultInvariant(malformed, "malformed decision");
  assert.equal(malformed.failureCode, REPLY_FAILURE_CODES.MALFORMED_DECISION_OUTPUT);

  // Dai dien runtime cho ca 5 nhom path bat buoc cua V2.3.
  const daiDien = [
    ["capability catalog", await generateReplyHarness({ catalogError: unavailableError() }).run()],
    ["session creation", await generateReplyHarness({ sessionError: timeoutError() }).run()],
    ["primary provider", await generateReplyHarness({ primaryError: invalidKeyError() }).run()],
    ["failover double", await generateReplyHarness({
      primaryError: timeoutError(), secondaryError: unavailableError(), failoverAllowed: true,
    }).run()],
    ["outer catch", await generateReplyHarness({ afterPromptError: opaqueError() }).run()],
  ];
  for (const [label, result] of daiDien) assertErrorResultInvariant(result, label);
});

// ---------------------------------------------------------------------------
// tryReply: kenh outcome bo sung, legacy contract giu nguyen.
// ---------------------------------------------------------------------------

const EMAIL_RATE_LIMITED_REPLY = "Hiện mình chưa thể kiểm tra thêm trạng thái email này. Bạn thử lại sau một lúc nhé.";
const MALFORMED_FALLBACK = "Em chưa thể xử lý chính xác yêu cầu này lúc này. Em đã ghi nhận tin nhắn của anh/chị.";

function tryReplyHarness({
  aiReady = true,
  filterPass = true,
  emailOutcome = { outcome: "NO_MATCH" },
  generateResults = [{ reply: "Trả lời bình thường", error: null, failureCode: null }],
  openAdminResult = null,
  openAdminThrows = null,
} = {}) {
  const logs = [];
  const outcomes = [];
  const queue = [...generateResults];
  let openAdminCalls = 0;
  const tryReply = compileFunction(AI, "export async function tryReply", {
    layChuTaiKhoan: () => "owner-fixture",
    getConfig: () => ({ opencodeAgent: "general", opencodeBaseUrl: "http://fixture.invalid" }),
    shouldProcessMessage: () => filterPass,
    addLog: async (entry) => { logs.push(entry); },
    filterSkipReason: () => "fixture",
    describeMessage: (value) => ({ threadId: value?.threadId || null }),
    isAiChatReady: () => aiReady,
    websiteEmailStatus: { lookupCustomerEmailStatus: async () => emailOutcome },
    generateReply: async () => {
      const next = queue.shift();
      assert.ok(next, "generateReply duoc goi nhieu hon du lieu fixture");
      return structuredClone(next);
    },
    recordDecisionProtocolOutcome: async () => {},
    canonicalDecisionResultLog: () => ({ event: "ai_need_admin", level: "info", summary: "x", detail: {} }),
    MAX_AI_RETRY: 1,
    MALFORMED_DECISION_FALLBACK: MALFORMED_FALLBACK,
    openAdminClarification: async () => {
      openAdminCalls += 1;
      if (openAdminThrows) throw openAdminThrows;
      return openAdminResult;
    },
    customerMemory: { ducKetNeuDenLuot: async () => {} },
    console: { warn: () => {} },
  });
  const message = { id: "m1", threadId: "T", threadType: 0, senderId: "customer", content: "hoi bot" };
  return {
    logs,
    outcomes,
    openAdminCalls: () => openAdminCalls,
    message,
    run: (options = { recordOutcome: (outcome) => outcomes.push(outcome) }) =>
      tryReply("hoi bot", message, options),
    runLegacy: () => tryReply("hoi bot", message),
  };
}

const aiError = (error, failureCode) => ({ reply: null, error, failureCode, skipped: false, needAdmin: false });
const emptyReply = () => ({ reply: null, error: null, failureCode: null, skipped: false, needAdmin: false });
const outOfScope = (body) => ({
  reply: body || null, error: null, failureCode: null, skipped: !body, needAdmin: false, decision: "OUT_OF_SCOPE",
});
const needAdminResult = () => ({
  reply: null, error: null, failureCode: null, skipped: false, needAdmin: true, decision: "NEED_ADMIN",
});
const malformedResult = () => ({
  reply: null, error: "AI decision protocol malformed: MISSING_OR_INVALID_TOKEN",
  failureCode: REPLY_FAILURE_CODES.MALFORMED_DECISION_OUTPUT,
  malformedDecision: true, decisionReason: "MISSING_OR_INVALID_TOKEN", skipped: false, needAdmin: false,
});

const onlyOutcome = (fixture) => {
  assert.equal(fixture.outcomes.length, 1, "phai ghi dung MOT outcome");
  return fixture.outcomes[0];
};

await test("A5", "tin QUA loc ma AI chua cau hinh -> FAILED/AI_NOT_CONFIGURED", async () => {
  const fixture = tryReplyHarness({ aiReady: false, filterPass: true });
  assert.equal(await fixture.run(), null);
  assert.deepEqual(onlyOutcome(fixture), {
    kind: REPLY_OUTCOME_KINDS.FAILED,
    failureCode: REPLY_FAILURE_CODES.AI_NOT_CONFIGURED,
    ownerText: null,
  });
});

await test("A5-negative", "tin TRUOT loc + AI chua cau hinh -> TERMINAL/FILTER_SKIP", async () => {
  const fixture = tryReplyHarness({ aiReady: false, filterPass: false });
  assert.equal(await fixture.run(), null);
  assert.deepEqual(onlyOutcome(fixture), {
    kind: REPLY_OUTCOME_KINDS.TERMINAL_NO_REPLY,
    reason: TERMINAL_NO_REPLY_REASONS.FILTER_SKIP,
  });
  // Thu tu trong source: business filter van dung TRUOC AI readiness.
  const body = extractFunction(AI, "export async function tryReply");
  assert.ok(body.indexOf("shouldProcessMessage(") < body.indexOf("isAiChatReady(config)"));
});

await test("A6", "AI tra noi dung rong -> FAILED/EMPTY_AI_REPLY", async () => {
  const fixture = tryReplyHarness({ generateResults: [emptyReply()] });
  assert.equal(await fixture.run(), null);
  assert.equal(onlyOutcome(fixture).kind, REPLY_OUTCOME_KINDS.FAILED);
  assert.equal(onlyOutcome(fixture).failureCode, REPLY_FAILURE_CODES.EMPTY_AI_REPLY);
});

await test("A8", "FILTER_SKIP la terminal hop le", async () => {
  const fixture = tryReplyHarness({ filterPass: false });
  assert.equal(await fixture.run(), null);
  assert.equal(onlyOutcome(fixture).kind, REPLY_OUTCOME_KINDS.TERMINAL_NO_REPLY);
});

await test("A9", "OUT_OF_SCOPE khong co body -> terminal", async () => {
  const fixture = tryReplyHarness({ generateResults: [outOfScope(null)] });
  assert.equal(await fixture.run(), null);
  assert.deepEqual(onlyOutcome(fixture), {
    kind: REPLY_OUTCOME_KINDS.TERMINAL_NO_REPLY,
    reason: TERMINAL_NO_REPLY_REASONS.OUT_OF_SCOPE,
  });
});

await test("A10", "OUT_OF_SCOPE co body cho khach -> deliverable", async () => {
  const fixture = tryReplyHarness({ generateResults: [outOfScope("Chỗ này ngoài phạm vi nhé.")] });
  assert.equal(await fixture.run(), "Chỗ này ngoài phạm vi nhé.");
  assert.deepEqual(onlyOutcome(fixture), { kind: REPLY_OUTCOME_KINDS.DELIVERABLE });
});

const openedWithAck = (acknowledgement, row = { id: 1, status: ADMIN_CLARIFICATION_STATUS.WAITING_ADMIN }) =>
  ({ opened: true, row, acknowledgement });

await test("A11", "NEED_ADMIN + acknowledgement -> deliverable", async () => {
  const ack = "Em đã chuyển câu hỏi này cho người phụ trách và sẽ chủ động trả lời ngay khi có xác nhận ạ.";
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: openedWithAck(ack),
  });
  assert.equal(await fixture.run(), ack);
  assert.deepEqual(onlyOutcome(fixture), { kind: REPLY_OUTCOME_KINDS.DELIVERABLE });
});

await test("A12/A33", "handoff da persisted (WAITING_ADMIN) khong acknowledgement -> terminal", async () => {
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: {
      opened: false,
      existing: true,
      row: { id: 7, status: ADMIN_CLARIFICATION_STATUS.WAITING_ADMIN },
      acknowledgement: null,
    },
  });
  assert.equal(await fixture.run(), null);
  assert.deepEqual(onlyOutcome(fixture), {
    kind: REPLY_OUTCOME_KINDS.TERMINAL_NO_REPLY,
    reason: ADMIN_CLARIFICATION_STATUS.WAITING_ADMIN,
  });
});

await test("A13", "NOTIFY_CAS_LOST truoc provider -> FAILED", async () => {
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: {
      opened: false,
      reason: "NOTIFY_CAS_LOST",
      row: { id: 8, status: ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_PENDING },
    },
  });
  assert.equal(await fixture.run(), null);
  assert.equal(onlyOutcome(fixture).kind, REPLY_OUTCOME_KINDS.FAILED);
  assert.equal(onlyOutcome(fixture).failureCode, "NOTIFY_CAS_LOST");
});

await test("A14", "NOTIFY_CONFIRM_CAS_LOST -> terminal", async () => {
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: { opened: false, reason: "NOTIFY_CONFIRM_CAS_LOST" },
  });
  assert.equal(await fixture.run(), null);
  assert.deepEqual(onlyOutcome(fixture), {
    kind: REPLY_OUTCOME_KINDS.TERMINAL_NO_REPLY,
    reason: "NOTIFY_CONFIRM_CAS_LOST",
  });
});

await test("A15", "NOTIFY_FAILURE_CAS_LOST -> terminal (reason thang ca row.status)", async () => {
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: {
      opened: false,
      reason: "NOTIFY_FAILURE_CAS_LOST",
      row: { id: 9, status: ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_SENDING },
      acknowledgement: null,
    },
  });
  assert.equal(await fixture.run(), null);
  assert.deepEqual(onlyOutcome(fixture), {
    kind: REPLY_OUTCOME_KINDS.TERMINAL_NO_REPLY,
    reason: "NOTIFY_FAILURE_CAS_LOST",
  });
});

await test("A16/A34", "existing ADMIN_NOTIFY_SENDING -> terminal", async () => {
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: {
      opened: false,
      existing: true,
      row: { id: 10, status: ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_SENDING },
      acknowledgement: null,
    },
  });
  assert.equal(await fixture.run(), null);
  assert.deepEqual(onlyOutcome(fixture), {
    kind: REPLY_OUTCOME_KINDS.TERMINAL_NO_REPLY,
    reason: ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_SENDING,
  });
});

await test("A32", "existing ADMIN_NOTIFY_PENDING -> FAILED", async () => {
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: {
      opened: false,
      existing: true,
      row: { id: 11, status: ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_PENDING },
      acknowledgement: null,
    },
  });
  assert.equal(await fixture.run(), null);
  assert.equal(onlyOutcome(fixture).kind, REPLY_OUTCOME_KINDS.FAILED);
  assert.equal(onlyOutcome(fixture).failureCode, ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_PENDING);
  // existing === true MOT MINH khong bao gio du de ket luan terminal.
  const body = extractFunction(AI, "export async function tryReply");
  assert.doesNotMatch(body, /opened\.existing\s*===\s*true/);
  assert.match(body, /opened\.row\?\.status/);
});

await test("A17", "ADMIN_NOTIFY_UNKNOWN khong co nhanh rieng va khong sinh lookup moi", async () => {
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: {
      opened: false,
      existing: true,
      row: { id: 12, status: ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_UNKNOWN },
      acknowledgement: null,
    },
  });
  assert.equal(await fixture.run(), null);
  assert.equal(fixture.outcomes.length, 0, "khong duoc ghi outcome rieng cho UNKNOWN");
  assert.equal(fixture.openAdminCalls(), 1, "khong duoc them lan goi/lookup nao");
  assert.ok(!/"ADMIN_NOTIFY_UNKNOWN"/.test(AI), "ai-chat khong duoc co nhanh ADMIN_NOTIFY_UNKNOWN");
  assert.ok(!/ADMIN_NOTIFY_UNKNOWN/.test(ZALO), "zalo-service khong duoc dung toi ADMIN_NOTIFY_UNKNOWN");
  // Recovery cua Admin Clarification khong doi.
  assertUnchangedVsHead("lib/admin-clarification.js");
});

await test("A18/A37", "ADMIN_NOTIFY_FAILED kem fallback acknowledgement -> deliverable", async () => {
  const fallback = "Em chưa có đủ thông tin để trả lời chính xác lúc này. Em đã ghi nhận câu hỏi của anh/chị.";
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: {
      opened: false,
      reason: "ADMIN_NOTIFY_FAILED",
      row: { id: 13, status: ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_FAILED },
      acknowledgement: fallback,
      adminClarificationFallback: true,
    },
  });
  assert.equal(await fixture.run(), fallback);
  assert.deepEqual(onlyOutcome(fixture), { kind: REPLY_OUTCOME_KINDS.DELIVERABLE });
});

await test("A19", "ADMIN_NOTIFY_FAILED khong acknowledgement, khong bang chung handoff -> FAILED", async () => {
  const fixture = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminResult: {
      opened: false,
      reason: "ADMIN_NOTIFY_FAILED",
      row: { id: 14, status: ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_FAILED },
      acknowledgement: null,
    },
  });
  assert.equal(await fixture.run(), null);
  assert.equal(onlyOutcome(fixture).kind, REPLY_OUTCOME_KINDS.FAILED);
  assert.equal(onlyOutcome(fixture).failureCode, ADMIN_CLARIFICATION_STATUS.ADMIN_NOTIFY_FAILED);

  // openAdminClarification nem loi -> van fail closed bang canonical unknown.
  const threw = tryReplyHarness({
    generateResults: [needAdminResult()],
    openAdminThrows: new Error("store down"),
  });
  assert.equal(await threw.run(), null);
  assert.equal(onlyOutcome(threw).failureCode, FAILURE_CODES.UNKNOWN_PROVIDER_ERROR);
});

await test("A21", "caller legacy khong truyen recorder giu nguyen contract string|null", async () => {
  assert.equal(await tryReplyHarness({ filterPass: false }).runLegacy(), null);
  assert.equal(await tryReplyHarness({ generateResults: [emptyReply()] }).runLegacy(), null);
  assert.equal(await tryReplyHarness().runLegacy(), "Trả lời bình thường");
  assert.equal(await tryReplyHarness({ generateResults: [outOfScope("Body")] }).runLegacy(), "Body");
  // Recorder hong cung khong duoc lam hong duong tra loi.
  const fixture = tryReplyHarness();
  assert.equal(
    await fixture.run({ recordOutcome: () => { throw new Error("recorder boom"); } }),
    "Trả lời bình thường"
  );
});

await test("A35", "email RATE_LIMITED tra cau cho khach -> deliverable, text khong doi", async () => {
  const fixture = tryReplyHarness({ emailOutcome: { outcome: "RATE_LIMITED", email: "a@b.c" } });
  assert.equal(await fixture.run(), EMAIL_RATE_LIMITED_REPLY);
  assert.deepEqual(onlyOutcome(fixture), { kind: REPLY_OUTCOME_KINDS.DELIVERABLE });
  assert.ok(AI.includes(EMAIL_RATE_LIMITED_REPLY));
});

await test("A36", "MALFORMED_DECISION_FALLBACK -> deliverable", async () => {
  const fixture = tryReplyHarness({ generateResults: [malformedResult(), malformedResult()] });
  assert.equal(await fixture.run(), MALFORMED_FALLBACK);
  assert.deepEqual(onlyOutcome(fixture), { kind: REPLY_OUTCOME_KINDS.DELIVERABLE });
});

await test("R1", "result.error -> FAILED giu dung failureCode cua generateReply", async () => {
  const fixture = tryReplyHarness({
    generateResults: [aiError("Owner text cho TIMEOUT", FAILURE_CODES.TIMEOUT)],
  });
  assert.equal(await fixture.run(), null);
  assert.deepEqual(onlyOutcome(fixture), {
    kind: REPLY_OUTCOME_KINDS.FAILED,
    failureCode: FAILURE_CODES.TIMEOUT,
    ownerText: "Owner text cho TIMEOUT",
  });
});

await test("R2", "invariant bi vi pham bat ngo -> fail closed, khong bao gio FAILED rong ma", async () => {
  for (const missing of [null, "", "   ", undefined]) {
    const fixture = tryReplyHarness({ generateResults: [aiError("Loi khong ro", missing)] });
    assert.equal(await fixture.run(), null);
    const outcome = onlyOutcome(fixture);
    assert.equal(outcome.kind, REPLY_OUTCOME_KINDS.FAILED);
    assert.equal(outcome.failureCode, FAILURE_CODES.UNKNOWN_PROVIDER_ERROR);
  }
});

await test("R3", "literal trong than ham khop voi contract export va taxonomy canonical", async () => {
  const body = extractFunction(AI, "export async function tryReply");
  assert.match(body, /"UNKNOWN_PROVIDER_ERROR"/);
  assert.equal(REPLY_FAILURE_CODES.UNKNOWN, FAILURE_CODES.UNKNOWN_PROVIDER_ERROR);
  for (const code of ["AI_NOT_CONFIGURED", "EMPTY_AI_REPLY"]) {
    assert.ok(body.includes(`"${code}"`), `tryReply thieu literal ${code}`);
    assert.equal(REPLY_FAILURE_CODES[code], code);
  }
  for (const status of ["WAITING_ADMIN", "ADMIN_NOTIFY_SENDING", "ADMIN_NOTIFY_PENDING", "ADMIN_NOTIFY_FAILED"]) {
    assert.ok(body.includes(`"${status}"`), `tryReply thieu literal ${status}`);
    assert.equal(ADMIN_CLARIFICATION_STATUS[status], status);
  }
  const generateBody = extractFunction(AI, "export async function generateReply");
  assert.ok(generateBody.includes(`"${REPLY_FAILURE_CODES.AI_NOT_CONFIGURED}"`));
  assert.ok(generateBody.includes(`"${REPLY_FAILURE_CODES.MALFORMED_DECISION_OUTPUT}"`));
  // Tuyet doi khong classify lai Vietnamese owner-facing text.
  assert.doesNotMatch(generateBody, /classifyProviderFailure\(\s*(?:new Error\()?\s*`?["']?Không/);
});

// ---------------------------------------------------------------------------
// zalo-service: tieu thu outcome SAU authority check, ghi durable failure.
// ---------------------------------------------------------------------------

function outboundHarness({
  reply = "Trả lời bình thường",
  outcome = null,
  bubbles = null,
  originAfterAi = true,
  generationAfterAi = true,
  tryReplyThrows = null,
  botEnabledAtInference = true,
} = {}) {
  let tryReplyCalls = 0;
  const sends = [];
  const logs = [];
  const generation = {
    ownerUid: "owner",
    threadId: "T",
    stale: false,
    cancelled: false,
    accepted: false,
    durableGenerationKey: null,
    conHieuLuc: () => generationAfterAi,
    danhDauProviderHistory: () => {},
    danhDauStaleOutboundSkipped: () => true,
    daChapNhanOutbound: () => generation.accepted,
    xacNhanOutbound: () => { generation.accepted = true; },
    outboundContextDaTienLen: () => false,
  };
  let originCurrent = true;
  let generationCurrent = true;
  const dependencies = {
    automaticWorkConHieuLuc: () => generationCurrent,
    tuyChonGuiTuDong: (work) => work,
    originConHieuLuc: () => originCurrent,
    gopThanhMotTin: (messages) => ({ ...messages.at(-1) }),
    chuHienTai: () => "owner",
    guiDaXemChoTins: () => {},
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => () => {},
    batDauWebTyping: () => Object.assign(() => {}, { setPhase: () => {} }),
    durableIds: () => [],
    giaHanLeaseDurableGeneration: async () => true,
    cancelGlobalAiWaiter: () => false,
    withGlobalAiSlot: async (_options, operation) => operation(),
    aiChat: {
      getConfig: () => ({ botEnabled: botEnabledAtInference }),
      tryReply: async (_text, _metadata, options) => {
        tryReplyCalls += 1;
        if (outcome) options?.recordOutcome?.(outcome);
        originCurrent = originAfterAi;
        generationCurrent = generationAfterAi;
        if (tryReplyThrows) throw tryReplyThrows;
        return reply;
      },
    },
    ownerCredentials: {
      withCurrentOwnerCredentialRead: async (_owner, _config, work) => work(),
    },
    ThreadType: { Group: 1, User: 0 },
    splitIntoBubbles: bubbles ? () => bubbles : splitIntoBubbles,
    locRuotGan,
    doi: async () => {},
    nghiTruocBubble: () => 0,
    sendChatMessage: async (input) => { sends.push(input); return { id: `sent-${sends.length}` }; },
    chuanBiDurableOutbox: async () => [],
    guiDurableOutbound: async ({ send }) => send(),
    completeAdminClarificationAck: async () => {},
    addLog: async (entry) => { logs.push(entry); },
    thuGuiSticker: async () => {},
    thongBaoAdminLoiOutbound: async () => {},
    console: { error: () => {} },
  };
  const start = ZALO.indexOf("async function traLoiCumTin(");
  const end = ZALO.indexOf("\nasync function handleNewIncomingMessage", start);
  assert.ok(start >= 0 && end > start);
  const traLoiCumTin = Function(
    ...Object.keys(dependencies),
    `"use strict";\n${ZALO.slice(start, end)}\nreturn traLoiCumTin;`
  )(...Object.values(dependencies));
  const message = { id: "m1", senderId: "customer", threadId: "T", threadType: 0, content: "hoi bot" };
  return {
    sends,
    logs,
    generation,
    tryReplyCalls: () => tryReplyCalls,
    run: () => traLoiCumTin([message], { originToken: { originOwnerUid: "owner" } }, generation),
  };
}

await test("A20", "durable tryReply null ma khong co outcome -> FAILED/UNCLASSIFIED_REPLY_OUTCOME", async () => {
  const fixture = outboundHarness({ reply: null, outcome: null });
  await fixture.run();
  assert.equal(fixture.generation.durableFailureCode, REPLY_FAILURE_CODES.UNCLASSIFIED_REPLY_OUTCOME);
  assert.ok(fixture.generation.durableFailure instanceof Error);
  assert.equal(fixture.sends.length, 0);
});

await test("A20b", "FAILED tuong minh dat CA durableFailure va durableFailureCode", async () => {
  const fixture = outboundHarness({
    reply: null,
    outcome: { kind: "FAILED", failureCode: FAILURE_CODES.TIMEOUT, ownerText: "AI chính phản hồi quá thời gian." },
  });
  await fixture.run();
  assert.equal(fixture.generation.durableFailureCode, FAILURE_CODES.TIMEOUT);
  assert.equal(fixture.generation.durableFailure.message, "AI chính phản hồi quá thời gian.");
  assert.equal(fixture.generation.durableFailure.code, FAILURE_CODES.TIMEOUT);
});

await test("A20c", "TERMINAL_NO_REPLY khong tao durable failure nao", async () => {
  const fixture = outboundHarness({
    reply: null,
    outcome: { kind: "TERMINAL_NO_REPLY", reason: TERMINAL_NO_REPLY_REASONS.FILTER_SKIP },
  });
  await fixture.run();
  assert.equal(fixture.generation.durableFailure, undefined);
  assert.equal(fixture.generation.durableFailureCode, undefined);
});

await test("A31", "mat authority sau tryReply -> TUYET DOI khong ghi durable failure", async () => {
  for (const lost of ["origin", "generation"]) {
    const fixture = outboundHarness({
      reply: null,
      outcome: { kind: "FAILED", failureCode: FAILURE_CODES.TIMEOUT },
      originAfterAi: lost !== "origin",
      generationAfterAi: lost !== "generation",
    });
    await fixture.run();
    assert.equal(fixture.generation.durableFailure, undefined, `${lost}: khong duoc stale-write`);
    assert.equal(fixture.generation.durableFailureCode, undefined, `${lost}: khong duoc stale-write`);
  }
  // Bot OFF ngay truoc AI call: tryReply KHONG duoc goi -> khong co attempt ->
  // khong fail-closed, va recovery hien huu van xu ly job nhu truoc.
  const chuaGoi = outboundHarness({ reply: null, botEnabledAtInference: false });
  await chuaGoi.run();
  assert.equal(chuaGoi.tryReplyCalls(), 0, "guard truoc AI phai chan tryReply");
  assert.equal(chuaGoi.generation.durableFailure, undefined);
  assert.equal(chuaGoi.generation.durableFailureCode, undefined);
});

await test("R4", "tryReply nem exception van vao durable failure machinery nhu truoc", async () => {
  const fixture = outboundHarness({ tryReplyThrows: new Error("provider exploded") });
  await fixture.run();
  assert.equal(fixture.generation.durableFailure.message, "provider exploded");
  // Path nay la exception chu khong phai error-result: classifier legacy giu nguyen.
  assert.equal(fixture.generation.durableFailureCode, undefined);
  assert.equal(fixture.sends.length, 0);
});

await test("A7", "AI co noi dung nhung khong con bubble -> FAILED/EMPTY_BUBBLES_AFTER_FILTER", async () => {
  const fixture = outboundHarness({ reply: "Có nội dung", bubbles: [] });
  await fixture.run();
  assert.equal(fixture.generation.durableFailureCode, REPLY_FAILURE_CODES.EMPTY_BUBBLES_AFTER_FILTER);
  assert.equal(fixture.sends.length, 0);
  assert.equal(fixture.logs.filter((entry) => entry.event === "ai_skip").length, 1);
});

await test("A27", "duong deliverable binh thuong khong sinh durable failure", async () => {
  const fixture = outboundHarness({ reply: "Trả lời bình thường", outcome: { kind: "DELIVERABLE" } });
  await fixture.run();
  assert.deepEqual(fixture.sends.map((item) => item.text), ["Trả lời bình thường"]);
  assert.equal(fixture.generation.durableFailure, undefined);
  assert.equal(fixture.generation.durableFailureCode, undefined);
  assert.equal(fixture.logs.filter((entry) => entry.event === "send_ok").length, 1);
});

await test("A28", "multi-bubble gui dung mot lan moi bubble, khong trung, khong failure", async () => {
  const fixture = outboundHarness({
    reply: "b0\n\nb1\n\nb2",
    outcome: { kind: "DELIVERABLE" },
    bubbles: ["b0", "b1", "b2"],
  });
  await fixture.run();
  assert.deepEqual(fixture.sends.map((item) => item.text), ["b0", "b1", "b2"]);
  assert.equal(fixture.generation.durableFailureCode, undefined);
});

await test("A30-order", "outcome chi duoc tieu thu SAU cac authority check hien huu", async () => {
  const start = ZALO.indexOf("async function traLoiCumTin(");
  const end = ZALO.indexOf("\nasync function handleNewIncomingMessage", start);
  const body = ZALO.slice(start, end);
  const goiTryReply = body.indexOf("aiChat.tryReply(");
  const kiemTraOrigin = body.indexOf('ghiStaleOutboundSkipped(tin, "runtime_origin_invalid")');
  const kiemTraBotWork = body.indexOf('ghiStaleOutboundSkipped(tin, "generation_or_automatic_work_invalid")');
  const tieuThu = body.indexOf("tieuThuKetQuaAi();");
  assert.ok(goiTryReply > 0 && kiemTraOrigin > goiTryReply);
  assert.ok(kiemTraBotWork > kiemTraOrigin, "thu tu authority check khong duoc doi");
  assert.ok(tieuThu > kiemTraBotWork, "outcome phai duoc tieu thu sau moi authority check");
  assert.ok(body.indexOf("if (!aiReply) return;") > tieuThu);
  // Recorder chi ghi vao bien local, khong ghi thang durable state.
  assert.match(body, /recordOutcome: \(outcome\) => \{ aiOutcome = outcome; \}/);
});

// ---------------------------------------------------------------------------
// durable-message-queue: machine code tuong minh thang text classifier.
// ---------------------------------------------------------------------------

// DB dung mot lan, trong thu muc tam: KHONG bao gio cham data/ canonical.
// lib/db.js la singleton nen chi duoc khoi tao dung mot lan cho ca file nay.
let tempDbPromise = null;
function withTempDb(run) {
  tempDbPromise ||= (async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repair-a-v23-"));
    fs.mkdirSync(path.join(tempRoot, "data"), { recursive: true });
    process.chdir(tempRoot);
    const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
    const queue = await import(
      `${pathToFileURL(path.join(REPO, "lib", "durable-message-queue.js")).href}?repairA=${Date.now()}`
    );
    await db.initDb();
    assert.ok(process.cwd() !== REPO, "DB kiem thu phai nam ngoai repo");
    return { db, queue, tempRoot };
  })();
  return tempDbPromise.then(run);
}

async function durableGeneration(db, conversationId, generationKey) {
  const row = await db.admitDurableMessageJob({
    accountId: "owner",
    conversationId,
    sourceMessageId: `${conversationId}-src`,
  });
  await db.claimDurableMessageJob(row.id);
  await db.assignDurableGeneration([row.id], generationKey);
  return row;
}

await test("A22", "durableFailureCode tuong minh thang viec classify lai human text", async () => {
  await withTempDb(async ({ db, queue }) => {
    // Error text nay neu dem classify lai se ra TIMEOUT (transient -> RETRY).
    const humanText = Object.assign(new Error("AI chính phản hồi quá thời gian cho phép."), {});
    assert.equal(classifyProviderFailure(humanText), FAILURE_CODES.TIMEOUT);

    const explicitRow = await durableGeneration(db, "EXPLICIT", "g-explicit");
    const explicit = {
      durableGenerationKey: "g-explicit",
      durableJobIds: [explicitRow.id],
      durableFailure: humanText,
      durableFailureCode: FAILURE_CODES.INVALID_KEY,
    };
    assert.equal(await queue.hoanTatDurableGeneration({}, explicit), false);
    const explicitAfter = await db.getDurableMessageJob(explicitRow.id);
    assert.equal(explicitAfter.lastErrorCode, FAILURE_CODES.INVALID_KEY);
    assert.equal(explicitAfter.status, "BLOCKED");

    // Khong co code tuong minh -> legacy classifier duoc giu nguyen.
    const legacyRow = await durableGeneration(db, "LEGACY", "g-legacy");
    const legacy = {
      durableGenerationKey: "g-legacy",
      durableJobIds: [legacyRow.id],
      durableFailure: humanText,
    };
    assert.equal(await queue.hoanTatDurableGeneration({}, legacy), false);
    const legacyAfter = await db.getDurableMessageJob(legacyRow.id);
    assert.equal(legacyAfter.lastErrorCode, FAILURE_CODES.TIMEOUT);
    assert.equal(legacyAfter.status, "RETRY");
  });
});

await test("A20d", "FAILED cua Repair A khong bao gio settle DONE", async () => {
  await withTempDb(async ({ db, queue }) => {
    const row = await durableGeneration(db, "REPAIRA", "g-repair-a");
    const failure = Object.assign(new Error(REPLY_FAILURE_CODES.EMPTY_AI_REPLY), {
      code: REPLY_FAILURE_CODES.EMPTY_AI_REPLY,
    });
    const generation = {
      durableGenerationKey: "g-repair-a",
      durableJobIds: [row.id],
      durableFailure: failure,
      durableFailureCode: REPLY_FAILURE_CODES.EMPTY_AI_REPLY,
    };
    assert.equal(await queue.hoanTatDurableGeneration({}, generation), false);
    const after = await db.getDurableMessageJob(row.id);
    assert.notEqual(after.status, "DONE");
    assert.equal(after.lastErrorCode, REPLY_FAILURE_CODES.EMPTY_AI_REPLY);
  });
});

await test("A30", "P1 case 38: generation khong loi van settle DONE nhu cu", async () => {
  await withTempDb(async ({ db, queue }) => {
    // A. Completion generic: khong failure, khong outbox -> van DONE y nhu truoc Repair A.
    const row = await durableGeneration(db, "DONE", "g-done");
    const generation = { durableGenerationKey: "g-done", durableJobIds: [row.id] };
    assert.equal(await queue.hoanTatDurableGeneration({}, generation), true);
    const done = await db.getDurableMessageJob(row.id);
    assert.equal(done.status, "DONE");
    assert.equal(done.lastErrorCode, null, "completion sach khong duoc ghi lai error code nao");
    assert.ok(Number(done.completedAt) > 0, "phai di dung nhanh settle DONE, khong phai nhanh khac");

    // B. Field moi cua Repair A KHONG tu no bien completion hop le thanh FAILED:
    //    co durableFailureCode nhung khong co error that -> van phai DONE.
    //    Gate cua nhanh failure phai la error, khong phai su hien dien cua code.
    const codeOnlyRow = await durableGeneration(db, "DONE_CODE_ONLY", "g-done-code-only");
    const codeOnly = {
      durableGenerationKey: "g-done-code-only",
      durableJobIds: [codeOnlyRow.id],
      durableFailureCode: FAILURE_CODES.INVALID_KEY,
    };
    assert.equal(await queue.hoanTatDurableGeneration({}, codeOnly), true);
    const codeOnlyAfter = await db.getDurableMessageJob(codeOnlyRow.id);
    assert.equal(codeOnlyAfter.status, "DONE", "durableFailureCode tran khong duoc chan completion hop le");
    assert.equal(codeOnlyAfter.lastErrorCode, null, "khong co error that thi khong duoc ghi failure");

    // C. allowNoOutbound VAN gate that, khong phai hang so: cung mot DB state
    //    (khong co outbox row nao), durableOutboxPrepared = true -> KHONG duoc DONE.
    const pendingRow = await durableGeneration(db, "OUTBOX_PENDING", "g-outbox-pending");
    const pending = {
      durableGenerationKey: "g-outbox-pending",
      durableJobIds: [pendingRow.id],
      durableOutboxPrepared: true,
    };
    assert.equal(await queue.hoanTatDurableGeneration({}, pending), false);
    assert.equal(
      (await db.getDurableMessageJob(pendingRow.id)).status,
      "WAITING_OUTBOX",
      "settle khong duoc bo qua bang chung outbound khi outbox da duoc chuan bi"
    );
  });
  // Supplement tren SOURCE HIEN TAI (khong so voi HEAD/parent commit): flag settle
  // van duoc tinh tu durableOutboxPrepared + error chu khong bi hard-code.
  assert.match(QUEUE, /allowNoOutbound: !generation\.durableOutboxPrepared && !error,/);
});

// ---------------------------------------------------------------------------
// Locked files + locked behaviour.
// ---------------------------------------------------------------------------

// Repair A DA commit tu truoc. Hai guard duoi do SCOPE LICH SU cua chinh Repair
// A, khong phai working tree hien tai: doc working tree thi moi repair duoc
// duyet VE SAU (vi du Repair B sua lib/tin-he-thong.js) deu bi bao nham la
// Repair A pham scope. Range co dinh nen ket qua khong doi theo branch tip hay
// theo file dang do trong may.
const REPAIR_A_COMMIT = "c85e5d721f996f1a06dde141a594c4baac83fbf8";
// Git tu xac dinh parent; commit nay chi co mot parent nen `^` la xac dinh.
const REPAIR_A_PARENT = `${REPAIR_A_COMMIT}^`;

await test("L1", "khong mot locked production file nao bi sua", () => {
  const locked = [
    "lib/db.js",
    "lib/outbound-outbox.js",
    "lib/conversation-inflight.js",
    "lib/global-ai-limiter.js",
    "lib/tin-he-thong.js",
    "lib/provider-failure.js",
    "lib/pdf-automation.js",
    "lib/gom-tin.js",
    "lib/admin-clarification.js",
  ];
  const changed = execFileSync("git", ["diff", "--name-only", REPAIR_A_PARENT, REPAIR_A_COMMIT, "--", ...locked], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
  assert.equal(changed, "", `Locked file bi sua: ${changed}`);
});

await test("L2", "production diff chi nam trong 3 file duoc phep", () => {
  const changed = execFileSync("git", ["diff", "--name-only", REPAIR_A_PARENT, REPAIR_A_COMMIT, "--", "lib", "server.js", "public"], {
    cwd: REPO,
    encoding: "utf8",
  }).split("\n").map((line) => line.trim()).filter(Boolean);
  const allowed = new Set(["lib/ai-chat.js", "lib/zalo-service.js", "lib/durable-message-queue.js"]);
  for (const file of changed) assert.ok(allowed.has(file), `File ngoai allowlist: ${file}`);
});

await test("A23/A24/A25/A26/A29", "reaction, BOT OFF, lease va PDF giu nguyen", () => {
  // PDF: module rieng, khong dung toi.
  assertUnchangedVsHead("lib/pdf-automation.js");
  assert.doesNotMatch(ZALO.slice(ZALO.indexOf("async function traLoiCumTin(")), /PDF_AUTOMATION_HANDLED[\s\S]{0,400}durableFailureCode/);

  const headZalo = headSource("lib/zalo-service.js").replace(/\r\n/g, "\n");
  const nowZalo = ZALO.replace(/\r\n/g, "\n");
  const unchangedBlocks = [
    // Reaction outbound + durable reaction outbox.
    "async function thuThaCamXuc(",
    // Lease heartbeat / authority recovery.
    "  const renewLease = async () => {",
    // BOT OFF pre-admission + post-admission eligibility.
    "function automaticWorkConHieuLuc(",
    "export function applyBotEligibilityTransition(",
  ];
  for (const signature of unchangedBlocks) {
    assert.equal(
      extractFunction(nowZalo, signature),
      extractFunction(headZalo, signature),
      `${signature} khong duoc thay doi`
    );
  }
});

await test("L3", "khong them schema, migration hay taxonomy provider moi", () => {
  assertUnchangedVsHead("lib/provider-failure.js");
  const diff = execFileSync("git", ["diff", "HEAD", "--", "lib"], { cwd: REPO, encoding: "utf8" });
  assert.doesNotMatch(diff, /^\+.*(CREATE TABLE|ALTER TABLE|PRAGMA user_version)/m);
});

// sqlite giu handle mo den luc thoat tien trinh; don dep la best-effort.
if (tempDbPromise) {
  const { tempRoot } = await tempDbPromise;
  process.chdir(REPO);
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* handle con mo */ }
}

const failed = results.filter((result) => !result.pass);
console.log(`\nREPAIR_A_V2_3 = ${results.length - failed.length}/${results.length} PASS`);
console.log("REAL_LLM_CALL = 0");
console.log("REAL_ZALO_CALL = 0");
console.log("REAL_PROVIDER_CALL = 0");
console.log("PRODUCTION_DB_TOUCHED = NO");
if (failed.length) process.exitCode = 1;
