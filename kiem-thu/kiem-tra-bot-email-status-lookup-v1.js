/**
 * BOT EMAIL STATUS LOOKUP V1 — focused mock/local acceptance T1-T37.
 * No live Website, Zoho, Zalo or AI calls.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import * as website from "../lib/website.js";

const aiSource = fs.readFileSync(new URL("../lib/ai-chat.js", import.meta.url), "utf8");
const emailCheckSource = fs.readFileSync(new URL("../lib/email-check.js", import.meta.url), "utf8");
const knowledgeSource = fs.readFileSync(new URL("../lib/knowledge-retrieval.js", import.meta.url), "utf8");
const websiteEmailStatusSource = fs.readFileSync(new URL("../lib/website-email-status.js", import.meta.url), "utf8");
const results = [];
const websiteCalls = [];
const rateLogs = [];

const emailCheck = {
  timEmailTrongTin: compileFunction(emailCheckSource, "export function timEmailTrongTin", { MAU_EMAIL: /[\w.+-]+@[\w-]+\.[\w.-]+[\w]/g }),
  capHinhTimThuZohoChoKiemThu: () => undefined,
};
const normalizeFixture = compileFunction(knowledgeSource, "export function normalize", {});
const websiteEmailStatus = compileWebsiteEmailStatusModule();

const secrets = new Map([
  ["website_connection_name", "Website fixture"],
  ["website_api_url", "https://fixture.example/base/path?preview=1"],
  ["website_api_token", "fixture-bearer-token"],
  ["website_connection_verified", "1"],
]);

let transport = { status: 200, payload: null, error: null };

website.capHinhKhoBiMat({
  get: async (key) => secrets.get(key) || "",
  set: async (key, value) => secrets.set(key, value),
});
website.capHinhTraDiaChi(async () => [{ address: "93.184.216.34", family: 4 }]);
website.capHinhGoiMang(async (url, options) => {
  websiteCalls.push({ url: String(url), options });
  if (transport.error) throw transport.error;
  return {
    ok: transport.status >= 200 && transport.status < 300,
    status: transport.status,
    text: async () => typeof transport.payload === "string"
      ? transport.payload
      : JSON.stringify(transport.payload),
  };
});
websiteEmailStatus.capHinhLogChoKiemThu(async (entry) => {
  rateLogs.push(entry);
  return entry;
});

function compileWebsiteEmailStatusModule() {
  const body = websiteEmailStatusSource
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/\bexport\s+/g, "");
  return Function(
    "addLog",
    "emailCheck",
    "normalize",
    "fetchWebsiteCustomerStatus",
    "getSafeWebsiteConfig",
    `"use strict";\n${body}\nreturn { TRA_EMAIL_STATUS_MOI_GIO, capHinhLogChoKiemThu, laYKiemTraEmail, phanLoaiCustomerStatus, lookupCustomerEmailStatus };`
  )(
    async (entry) => entry,
    emailCheck,
    normalizeFixture,
    website.fetchWebsiteCustomerStatus,
    website.getSafeWebsiteConfig
  );
}

function sentPayload({
  sentAt = "2026-09-11 09:15:30",
  status = "sent",
  emailType = "confirmation",
  templateKey = "confirm-v1",
} = {}) {
  return {
    found: true,
    customer: { id: 42, email: "must-not-leak@example.com" },
    orders: [{ id: 99, total: 123456 }],
    email_status: {
      status,
      sent_at: sentAt,
      delivered_at: "2026-09-11T02:16:00Z",
      email_type: emailType,
      template_key: templateKey,
      provider: "brevo",
      brevo_message_id: "secret-provider-id",
      message_id: "secret-message-id",
      failure_reason_code: "secret-failure-code",
      tracking_started_at: "2026-09-11T02:15:00Z",
    },
  };
}

function notTrackedPayload() {
  return sentPayload({ sentAt: null, status: "not_tracked", emailType: null, templateKey: null });
}

function foundFalsePayload() {
  return { found: false, customer: null, orders: [], email_status: null };
}

function unresolvedPayload() {
  return sentPayload({ sentAt: null, status: "pending_unknown", emailType: null, templateKey: null });
}

function useResponse(payload, status = 200) {
  transport = { payload, status, error: null };
  secrets.set("website_connection_verified", "1");
}

function useError(error) {
  transport = { payload: null, status: 0, error };
  secrets.set("website_connection_verified", "1");
}

function privateMessage(senderId, content = "abc@gmail.com kiểm tra giúp mình") {
  return {
    id: `message-${senderId}`,
    threadId: `thread-${senderId}`,
    threadType: 0,
    senderId,
    senderName: `Khách ${senderId}`,
    content,
  };
}

function lookup(userMessage, senderId, extra = {}) {
  return websiteEmailStatus.lookupCustomerEmailStatus({
    userMessage,
    messageObj: privateMessage(senderId, userMessage),
    ownerUid: "owner-focused",
    privateOneToOne: true,
    ...extra,
  });
}

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `Missing ${signature}`);
  const bodyStart = source.indexOf("{", start + signature.length);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
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
    if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`Unclosed ${signature}`);
}

function compileFunction(source, signature, dependencies) {
  const functionSource = extractFunction(source, signature).replace(/^export\s+/, "");
  const name = functionSource.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1];
  const names = Object.keys(dependencies);
  return Function(...names, `"use strict";\n${functionSource}\nreturn ${name};`)(
    ...names.map((key) => dependencies[key])
  );
}

function validReply(reply = "Website đã có dữ kiện gửi email.") {
  return {
    reply,
    raw: reply,
    decision: null,
    malformedDecision: false,
    needAdmin: false,
    skipped: false,
    error: null,
    sessionId: "session-focused",
    model: "fixture/model",
    tokens: null,
  };
}

function needAdminReply() {
  return {
    ...validReply(null),
    reply: null,
    raw: "[[VIZEN_DECISION:NEED_ADMIN]]",
    decision: "NEED_ADMIN",
    needAdmin: true,
  };
}

function tryReplyHarness({
  senderId,
  lookupModule = websiteEmailStatus,
  openedResult = null,
  generatedResult = validReply(),
} = {}) {
  const message = privateMessage(senderId || `try-${results.length}`);
  const generationCalls = [];
  const clarificationCalls = [];
  const logs = [];
  const config = {
    opencodeBaseUrl: "http://fixture.invalid",
    opencodeModel: "fixture/model",
    allowedTopics: "fixture",
    soul: "fixture soul",
  };
  const tryReply = compileFunction(aiSource, "export async function tryReply", {
    layChuTaiKhoan: () => "owner-focused",
    getConfig: () => config,
    shouldProcessMessage: () => true,
    addLog: async (entry) => { logs.push(entry); return entry; },
    filterSkipReason: () => "fixture",
    describeMessage: () => ({}),
    isAiChatReady: () => true,
    websiteEmailStatus: lookupModule,
    generateReply: async (...args) => {
      generationCalls.push(args);
      return structuredClone(generatedResult);
    },
    recordDecisionProtocolOutcome: async () => undefined,
    canonicalDecisionResultLog: (result, context) => result?.needAdmin && context?.clarificationAccepted
      ? { event: "ai_need_admin", level: "info", summary: "clarification accepted", detail: {} }
      : null,
    MAX_AI_RETRY: 1,
    MALFORMED_DECISION_FALLBACK: "fallback",
    openAdminClarification: async (input) => {
      clarificationCalls.push(input);
      return typeof openedResult === "function" ? openedResult(input) : openedResult;
    },
    customerMemory: { ducKetNeuDenLuot: async () => undefined },
  });
  return {
    message,
    generationCalls,
    clarificationCalls,
    logs,
    run: (text = message.content) => tryReply(text, message),
  };
}

function generateReplyHarness() {
  let prompt = null;
  const generateReply = compileFunction(aiSource, "export async function generateReply", {
    layChuTaiKhoan: () => "owner-focused",
    getConfig: () => null,
    isAiChatReady: () => true,
    customerRequiredCapabilities: () => ["TEXT"],
    createCallBudget: () => ({ consume: () => undefined, snapshot: () => ({}) }),
    buildBootstrapContext: async () => ({ recentHistory: "", soTinLichSu: 0, threadTitle: "Fixture" }),
    opencode: {
      ensureSession: async () => ({ sessionId: "session-focused", created: true, turns: 0 }),
      sendPrompt: async (_config, _sessionId, value) => {
        prompt = value;
        return { reply: "AI fixture", tokens: null, model: "fixture/model" };
      },
    },
    customerMemory: {
      bocPrompt: async (_sessionId, _messageObj, text) => text,
      quenPhien: () => undefined,
    },
    ThreadType: { User: 0, Group: 1 },
    docTep: { xuLyTep: async () => null },
    ganNhanTuDong: null,
    mocHienTai: () => "2026-09-11 09:00",
    addLog: async () => undefined,
    bumpSessionTurns: async () => undefined,
    SKIP_TOKEN: "SKIP",
  });
  const config = {
    opencodeBaseUrl: "http://fixture.invalid",
    opencodeModel: "fixture/model",
    allowedTopics: "fixture",
    soul: "fixture soul",
    docTep: false,
    useKnowledge: false,
    capabilityRoutingEnabled: false,
    adminClarificationDecisionEnabled: false,
  };
  return { generateReply, config, prompt: () => prompt };
}

async function test(id, description, operation) {
  try {
    await operation();
    results.push({ id, pass: true });
    console.log(`PASS ${id} ${description}`);
  } catch (error) {
    results.push({ id, pass: false });
    console.error(`FAIL ${id} ${description}\n${error.stack || error.message}`);
  }
}

await test("T1", "email present with unrelated text does not call Website", async () => {
  useResponse(sentPayload());
  const before = websiteCalls.length;
  const result = await lookup("abc@gmail.com xin chào", "t1");
  assert.equal(result.outcome, "NO_MATCH");
  assert.equal(websiteCalls.length, before);
});

await test("T2", "intent without email does not call Website", async () => {
  const before = websiteCalls.length;
  const result = await lookup("kiểm tra email giúp mình", "t2");
  assert.equal(result.outcome, "NO_MATCH");
  assert.equal(websiteCalls.length, before);
});

await test("T3", "valid email plus intent calls customer-status", async () => {
  useResponse(sentPayload());
  const before = websiteCalls.length;
  const result = await lookup("kiểm tra mail AbC+tag@gmail.com", "t3");
  assert.equal(result.outcome, "SENT");
  assert.equal(websiteCalls.length, before + 1);
});

await test("T4", "query contains the exact extracted email", async () => {
  useResponse(sentPayload());
  await lookup("kiểm tra mail AbC+tag@gmail.com", "t4");
  const url = new URL(websiteCalls.at(-1).url);
  assert.equal(url.searchParams.get("email"), emailCheck.timEmailTrongTin("AbC+tag@gmail.com"));
});

await test("T5", "canonical endpoint path is /api/vizen/customer-status", async () => {
  useResponse(sentPayload());
  await lookup("abc@gmail.com kiểm tra giúp mình", "t5");
  assert.equal(new URL(websiteCalls.at(-1).url).pathname, "/api/vizen/customer-status");
});

await test("T6", "customer-status uses GET", async () => {
  useResponse(sentPayload());
  await lookup("check email abc@gmail.com", "t6");
  assert.equal(websiteCalls.at(-1).options.method, "GET");
});

await test("T7", "existing Website Bearer credential is reused", async () => {
  useResponse(sentPayload());
  await lookup("check mail abc@gmail.com", "t7");
  assert.equal(websiteCalls.at(-1).options.headers.Authorization, "Bearer fixture-bearer-token");
});

await test("T8", "unverified Website config maps to safe source error", async () => {
  secrets.set("website_connection_verified", "");
  const before = websiteCalls.length;
  await assert.rejects(
    website.fetchWebsiteCustomerStatus("abc@gmail.com"),
    (error) => error?.ma === "WEBSITE_NOT_CONNECTED"
  );
  const result = await lookup("kiểm tra email abc@gmail.com", "t8");
  assert.equal(result.classification, "SOURCE_ERROR");
  assert.equal(result.outcome, "NEEDS_ADMIN");
  assert.equal(websiteCalls.length, before);
});

await test("T9", "found with factual sent_at classifies SENT", () => {
  const result = websiteEmailStatus.phanLoaiCustomerStatus(sentPayload(), "abc@gmail.com");
  assert.equal(result.classification, "SENT");
  assert.equal(result.outcome, "SENT");
});

await test("T10", "SENT creates messageObj.__emailStatusContext", async () => {
  useResponse(sentPayload());
  const harness = tryReplyHarness({ senderId: "t10" });
  await harness.run();
  assert.match(harness.message.__emailStatusContext, /sent_at:/);
});

await test("T11", "SENT continues canonical generation and generateReply consumes context", async () => {
  useResponse(sentPayload());
  const harness = tryReplyHarness({ senderId: "t11" });
  const reply = await harness.run();
  assert.equal(reply, "Website đã có dữ kiện gửi email.");
  assert.equal(harness.generationCalls.length, 1);
  const generated = generateReplyHarness();
  const message = privateMessage("t11-generate");
  message.__emailStatusContext = "FACTUAL_SENT_AT_PASSTHROUGH\n\n";
  await generated.generateReply(message.content, message, "owner-focused", generated.config);
  assert.ok(generated.prompt().includes("FACTUAL_SENT_AT_PASSTHROUGH"));
});

await test("T12", "SENT context contains only minimum factual status fields", () => {
  const context = websiteEmailStatus.phanLoaiCustomerStatus(sentPayload(), "abc@gmail.com").aiContext;
  for (const field of ["sent_at:", "status:", "email_type:", "template_key:"]) assert.ok(context.includes(field));
  for (const forbidden of ["customer", "orders", "provider", "brevo_message_id", "message_id", "failure_reason_code", "delivered_at", "tracking_started_at", "secret-provider-id"]) {
    assert.equal(context.includes(forbidden), false, forbidden);
  }
});

await test("T13", "naive sent_at remains unchanged with no timezone transform", () => {
  const sentAt = "2026-09-11 09:15:30";
  const context = websiteEmailStatus.phanLoaiCustomerStatus(sentPayload({ sentAt }), "abc@gmail.com").aiContext;
  assert.ok(context.includes(`sent_at: ${sentAt}`));
  assert.equal(context.includes("+07:00"), false);
  assert.equal(context.includes(`${sentAt}Z`), false);
});

await test("T14", "sent_at with Z or offset remains unchanged", () => {
  for (const sentAt of ["2026-09-11T02:15:30Z", "2026-09-11T09:15:30+07:00"]) {
    const context = websiteEmailStatus.phanLoaiCustomerStatus(sentPayload({ sentAt }), "abc@gmail.com").aiContext;
    assert.ok(context.includes(`sent_at: ${sentAt}`));
  }
});

await test("T15", "not_tracked bypasses generation and opens clarification", async () => {
  useResponse(notTrackedPayload());
  const harness = tryReplyHarness({ senderId: "t15", openedResult: { opened: true, row: { id: 15 }, acknowledgement: "ACK" } });
  assert.equal(await harness.run(), "ACK");
  assert.equal(harness.generationCalls.length, 0);
  assert.equal(harness.clarificationCalls.length, 1);
});

await test("T16", "not_tracked Admin text says tracking unavailable, never unsent", async () => {
  useResponse(notTrackedPayload());
  const harness = tryReplyHarness({ senderId: "t16", openedResult: { opened: true, row: { id: 16 }, acknowledgement: "ACK" } });
  await harness.run();
  const content = harness.clarificationCalls[0].message.content;
  assert.match(content, /chưa có dữ liệu tracking email/);
  assert.equal(content.includes("email chưa gửi"), false);
});

await test("T17", "found=false opens clarification", async () => {
  useResponse(foundFalsePayload());
  const harness = tryReplyHarness({ senderId: "t17", openedResult: { opened: true, row: { id: 17 }, acknowledgement: "ACK" } });
  await harness.run();
  assert.equal(harness.clarificationCalls.length, 1);
  assert.match(harness.clarificationCalls[0].message.content, /không tìm thấy customer/);
});

await test("T18", "null sent_at with unknown status is unresolved without invented status", async () => {
  useResponse(unresolvedPayload());
  const harness = tryReplyHarness({ senderId: "t18", openedResult: { opened: true, row: { id: 18 }, acknowledgement: "ACK" } });
  await harness.run();
  assert.equal(harness.generationCalls.length, 0);
  assert.match(harness.clarificationCalls[0].message.content, /chưa có dữ liệu đủ để xác nhận thời điểm gửi email/);
});

await test("T19", "HTTP/network/timeout failures open source-error clarification", async () => {
  const cases = [
    { kind: "http", status: 401 },
    { kind: "http", status: 403 },
    { kind: "http", status: 400 },
    { kind: "http", status: 500 },
    { kind: "error", error: new Error("network fixture") },
    { kind: "error", error: Object.assign(new Error("timeout fixture"), { name: "AbortError" }) },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    if (item.kind === "http") useResponse({ error: "fixture" }, item.status);
    else useError(item.error);
    const harness = tryReplyHarness({
      senderId: `t19-${index}`,
      openedResult: { opened: true, row: { id: 190 + index }, acknowledgement: "ACK" },
    });
    await harness.run();
    assert.equal(harness.clarificationCalls.length, 1);
    assert.equal(harness.generationCalls.length, 0);
    assert.match(harness.clarificationCalls[0].message.content, /không tra được trạng thái email từ Website/);
  }
});

await test("T20", "malformed Website response opens source-error clarification", async () => {
  useResponse({ unexpected: true });
  const harness = tryReplyHarness({ senderId: "t20", openedResult: { opened: true, row: { id: 20 }, acknowledgement: "ACK" } });
  await harness.run();
  assert.equal(harness.clarificationCalls.length, 1);
  assert.equal(harness.generationCalls.length, 0);
  assert.match(harness.clarificationCalls[0].message.content, /không tra được trạng thái email từ Website/);
});

await test("T21", "lookup uses current batch only and ignores previous-history email", async () => {
  useResponse(sentPayload());
  const before = websiteCalls.length;
  const messageObj = privateMessage("t21", "kiểm tra giúp mình");
  messageObj.previousHistory = "old-address@gmail.com";
  const result = await websiteEmailStatus.lookupCustomerEmailStatus({
    userMessage: "kiểm tra giúp mình",
    messageObj,
    ownerUid: "owner-focused",
    privateOneToOne: true,
  });
  assert.equal(result.reason, "EMAIL_MISSING");
  assert.equal(websiteCalls.length, before);
});

await test("T22", "group chat never performs Website lookup", async () => {
  useResponse(sentPayload());
  const before = websiteCalls.length;
  const result = await websiteEmailStatus.lookupCustomerEmailStatus({
    userMessage: "abc@gmail.com kiểm tra giúp mình",
    messageObj: { ...privateMessage("t22"), threadType: 1 },
    ownerUid: "owner-focused",
    privateOneToOne: false,
  });
  assert.equal(result.reason, "PRIVATE_ONLY");
  assert.equal(websiteCalls.length, before);
});

await test("T23", "customer path never calls Zoho lookup", async () => {
  useResponse(sentPayload());
  await lookup("kiểm tra email abc@gmail.com", "t23");
  const generateBody = extractFunction(aiSource, "export async function generateReply");
  assert.equal(generateBody.includes("emailCheck.traCuu"), false);
  assert.equal(websiteEmailStatusSource.includes("timThuDaGui"), false);
  assert.equal(websiteEmailStatusSource.includes("timThuTraVe"), false);
});

await test("T24", "rate limit allows 8 and blocks 9th without Website or Admin alert", async () => {
  useResponse(foundFalsePayload());
  const beforeWebsite = websiteCalls.length;
  const beforeLogs = rateLogs.length;
  const harness = tryReplyHarness({
    senderId: "t24-rate",
    openedResult: { opened: true, row: { id: 24 }, acknowledgement: "ACK" },
    generatedResult: needAdminReply(),
  });
  const replies = [];
  for (let index = 0; index < 9; index += 1) replies.push(await harness.run(`kiểm tra mail rate-${index}@gmail.com`));
  assert.equal(websiteCalls.length - beforeWebsite, 8);
  assert.equal(harness.clarificationCalls.length, 8);
  assert.equal(harness.generationCalls.length, 0);
  assert.equal(replies.at(-1), "Hiện mình chưa thể kiểm tra thêm trạng thái email này. Bạn thử lại sau một lúc nhé.");
  assert.equal(rateLogs.length - beforeLogs, 1);
  assert.equal(rateLogs.at(-1).level, "warn");
});

await test("T25", "WAITING clarification dedupe keeps null acknowledgement", async () => {
  useResponse(foundFalsePayload());
  const harness = tryReplyHarness({
    senderId: "t25",
    openedResult: { opened: false, existing: true, row: { id: 25 }, acknowledgement: null },
  });
  assert.equal(await harness.run(), null);
  assert.equal(harness.clarificationCalls.length, 1);
  assert.equal(harness.generationCalls.length, 0);
  assert.equal(harness.message.__adminClarificationAckId, undefined);
});

await test("T26", "incomplete Website config is inert NOT_CONFIGURED and normal AI continues", async () => {
  const previousToken = secrets.get("website_api_token");
  secrets.set("website_api_token", "");
  secrets.set("website_connection_verified", "1");
  try {
    await assert.rejects(
      website.fetchWebsiteCustomerStatus("abc@gmail.com"),
      (error) => error?.ma === "WEBSITE_CONFIG_INCOMPLETE"
    );
    const direct = await lookup("kiểm tra email abc@gmail.com", "t26-direct");
    assert.deepEqual(direct, { outcome: "NOT_CONFIGURED" });
    const beforeRateLogs = rateLogs.length;
    for (let index = 0; index < 9; index += 1) {
      assert.deepEqual(
        await lookup(`kiểm tra email inert-${index}@gmail.com`, "t26-inert-repeat"),
        { outcome: "NOT_CONFIGURED" }
      );
    }
    assert.equal(rateLogs.length, beforeRateLogs);
    const beforeWebsite = websiteCalls.length;
    const harness = tryReplyHarness({ senderId: "t26" });
    assert.equal(await harness.run(), "Website đã có dữ kiện gửi email.");
    assert.equal(websiteCalls.length, beforeWebsite);
    assert.equal(harness.clarificationCalls.length, 0);
    assert.equal(harness.generationCalls.length, 1);
    assert.equal(harness.message.__emailStatusContext, undefined);
  } finally {
    secrets.set("website_api_token", previousToken);
  }
});

await test("T27", "found=true with email_status=null is UNRESOLVED and opens Admin", async () => {
  useResponse({ found: true, customer: { id: 27 }, orders: [], email_status: null });
  const direct = websiteEmailStatus.phanLoaiCustomerStatus(transport.payload, "abc@gmail.com");
  assert.equal(direct.classification, "UNRESOLVED");
  assert.equal(direct.reason, "email_status_unresolved");
  const harness = tryReplyHarness({ senderId: "t27", openedResult: { opened: true, row: { id: 27 }, acknowledgement: "ACK" } });
  assert.equal(await harness.run(), "ACK");
  assert.equal(harness.clarificationCalls.length, 1);
  assert.equal(harness.generationCalls.length, 0);
});

await test("T28", "found=false with omitted keys is FOUND_FALSE and opens Admin", async () => {
  useResponse({ found: false });
  const direct = websiteEmailStatus.phanLoaiCustomerStatus(transport.payload, "abc@gmail.com");
  assert.equal(direct.classification, "FOUND_FALSE");
  const harness = tryReplyHarness({ senderId: "t28", openedResult: { opened: true, row: { id: 28 }, acknowledgement: "ACK" } });
  await harness.run();
  assert.equal(harness.clarificationCalls.length, 1);
  assert.match(harness.clarificationCalls[0].message.content, /không tìm thấy customer/);
});

await test("T29", "non-object email_status is UNRESOLVED and opens Admin", async () => {
  useResponse({ found: true, email_status: "bad" });
  const direct = websiteEmailStatus.phanLoaiCustomerStatus(transport.payload, "abc@gmail.com");
  assert.equal(direct.classification, "UNRESOLVED");
  assert.equal(direct.reason, "email_status_unresolved");
  const harness = tryReplyHarness({ senderId: "t29", openedResult: { opened: true, row: { id: 29 }, acknowledgement: "ACK" } });
  await harness.run();
  assert.equal(harness.clarificationCalls.length, 1);
  assert.equal(harness.generationCalls.length, 0);
});

await test("T30", "9th lookup returns deterministic reply before Website, Admin and AI", async () => {
  useResponse(foundFalsePayload());
  const beforeWebsite = websiteCalls.length;
  const harness = tryReplyHarness({ senderId: "t30-rate", openedResult: { opened: true, row: { id: 30 }, acknowledgement: "ACK" } });
  const replies = [];
  for (let index = 0; index < 9; index += 1) replies.push(await harness.run(`kiểm tra email t30-${index}@gmail.com`));
  assert.equal(websiteCalls.length - beforeWebsite, 8);
  assert.equal(harness.clarificationCalls.length, 8);
  assert.equal(harness.generationCalls.length, 0);
  assert.equal(replies.at(-1), "Hiện mình chưa thể kiểm tra thêm trạng thái email này. Bạn thử lại sau một lúc nhé.");
  assert.equal(harness.logs.some((entry) => entry?.event === "ai_start"), false);
});

await test("T31", "email clarification emits one canonical ai_need_admin and no ai_start", async () => {
  useResponse(notTrackedPayload());
  const harness = tryReplyHarness({ senderId: "t31", openedResult: { opened: true, row: { id: 31 }, acknowledgement: "ACK" } });
  await harness.run();
  assert.equal(harness.logs.filter((entry) => entry?.event === "ai_need_admin").length, 1);
  assert.equal(harness.logs.filter((entry) => entry?.event === "ai_start").length, 0);
});

await test("T32", "sent_at newline injection becomes SOURCE_ERROR and never reaches AI", async () => {
  useResponse(sentPayload({ sentAt: "2026-09-11T02:15:30Z\n# INJECTED_SECTION" }));
  const harness = tryReplyHarness({ senderId: "t32", openedResult: { opened: true, row: { id: 32 }, acknowledgement: "ACK" } });
  await harness.run();
  assert.equal(harness.clarificationCalls.length, 1);
  assert.equal(harness.generationCalls.length, 0);
  assert.equal(harness.message.__emailStatusContext, undefined);
  assert.equal(harness.clarificationCalls[0].message.content.includes("INJECTED_SECTION"), false);
});

await test("T33", "sent_at longer than 128 becomes SOURCE_ERROR", async () => {
  useResponse(sentPayload({ sentAt: "x".repeat(129) }));
  const result = await lookup("kiểm tra email abc@gmail.com", "t33");
  assert.equal(result.classification, "SOURCE_ERROR");
  assert.equal(result.outcome, "NEEDS_ADMIN");
});

await test("T34", "unsafe status string becomes SOURCE_ERROR", async () => {
  const values = ["bad\nstatus", `bad${String.fromCharCode(0)}status`, "x".repeat(65)];
  for (let index = 0; index < values.length; index += 1) {
    const payload = sentPayload();
    payload.email_status.status = values[index];
    useResponse(payload);
    const result = await lookup("kiểm tra email abc@gmail.com", `t34-${index}`);
    assert.equal(result.classification, "SOURCE_ERROR");
  }
});

await test("T35", "unsafe email_type string becomes SOURCE_ERROR", async () => {
  const values = ["bad\remail-type", "x".repeat(129)];
  for (let index = 0; index < values.length; index += 1) {
    const payload = sentPayload();
    payload.email_status.email_type = values[index];
    useResponse(payload);
    const result = await lookup("kiểm tra email abc@gmail.com", `t35-${index}`);
    assert.equal(result.classification, "SOURCE_ERROR");
  }
});

await test("T36", "unsafe template_key string becomes SOURCE_ERROR", async () => {
  const values = ["bad\ntemplate", "x".repeat(129)];
  for (let index = 0; index < values.length; index += 1) {
    const payload = sentPayload();
    payload.email_status.template_key = values[index];
    useResponse(payload);
    const result = await lookup("kiểm tra email abc@gmail.com", `t36-${index}`);
    assert.equal(result.classification, "SOURCE_ERROR");
  }
});

await test("T37", "contradictory not_tracked plus sent_at fails safe as SOURCE_ERROR", async () => {
  useResponse(sentPayload({ status: "not_tracked", sentAt: "2026-09-11T02:15:30Z" }));
  const result = await lookup("kiểm tra email abc@gmail.com", "t37");
  assert.equal(result.classification, "SOURCE_ERROR");
  assert.equal(result.outcome, "NEEDS_ADMIN");
  const harness = tryReplyHarness({ senderId: "t37-admin", openedResult: { opened: true, row: { id: 37 }, acknowledgement: "ACK" } });
  await harness.run();
  assert.equal(harness.clarificationCalls.length, 1);
  assert.equal(harness.generationCalls.length, 0);
  assert.equal(harness.message.__emailStatusContext, undefined);
});

const passed = results.filter((result) => result.pass).length;
console.log(`\nBOT EMAIL STATUS LOOKUP V1: ${passed}/${results.length} PASS`);
if (passed !== results.length) process.exitCode = 1;
