/**
 * BOT CONTRACT FALLBACK V2.
 * Executes the real tryReply production branch with injected generation/I/O seams.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const aiSource = fs.readFileSync(new URL("../lib/ai-chat.js", import.meta.url), "utf8");
const adminSource = fs.readFileSync(new URL("../lib/admin-clarification.js", import.meta.url), "utf8");
const zaloSource = fs.readFileSync(new URL("../lib/zalo-service.js", import.meta.url), "utf8");
const results = [];
const FALLBACK = "Em chưa thể xử lý chính xác yêu cầu này lúc này. Em đã ghi nhận tin nhắn của anh/chị.";

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

const valid = (reply = "Trả lời bình thường") => ({
  reply,
  raw: `[[VIZEN_DECISION:ANSWERABLE]]\n${reply}`,
  decision: "ANSWERABLE",
  malformedDecision: false,
  needAdmin: false,
  skipped: false,
  error: null,
  sessionId: "session-fixture",
  model: "fixture/model",
  tokens: null,
});
const malformed = (suffix = "one") => ({
  reply: null,
  raw: `malformed-${suffix}`,
  decision: null,
  malformedDecision: true,
  needAdmin: false,
  skipped: false,
  error: "AI decision protocol malformed: MISSING_OR_INVALID_TOKEN",
  sessionId: "session-fixture",
  model: "fixture/model",
  tokens: null,
});
const outOfScope = () => ({
  reply: null,
  raw: "[[VIZEN_DECISION:OUT_OF_SCOPE]]",
  decision: "OUT_OF_SCOPE",
  malformedDecision: false,
  needAdmin: false,
  skipped: true,
  error: null,
  sessionId: "session-fixture",
  model: "fixture/model",
  tokens: null,
});

function harness(sequence, options = {}) {
  const outcomes = [...sequence];
  const calls = [];
  const logs = [];
  const protocolOutcomes = [];
  const memory = [];
  const validSourceConfig = {
    opencodeBaseUrl: "http://fixture.invalid",
    opencodeAgent: "general",
    allowedTopics: "fixture",
    soul: "fixture soul",
    roleTone: "fixture role",
  };
  const sourceConfig = Object.hasOwn(options, "config") ? options.config : validSourceConfig;
  const message = {
    id: "message-fixture",
    threadId: "thread-fixture",
    threadType: 0,
    senderId: "customer-fixture",
    senderName: "Khách fixture",
    content: "Nội dung fixture",
  };
  const recordDecisionProtocolOutcome = async (entry) => { protocolOutcomes.push(entry); };
  const productionShouldProcessMessage = compileFunction(aiSource, "export function shouldProcessMessage", {
    getConfig: () => sourceConfig,
    ThreadType: { Group: 1 },
  });
  let shouldProcessCalls = 0;
  const shouldProcessMessage = (...args) => {
    shouldProcessCalls += 1;
    return productionShouldProcessMessage(...args);
  };
  const generateReply = async (userMessage, messageObj, ownerUid, config) => {
    calls.push({ userMessage, messageObj, ownerUid, config });
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("Unexpected extra generation attempt");
    if (config.__deferDecisionProtocolOutcome !== true && (next.decision || next.malformedDecision)) {
      await recordDecisionProtocolOutcome({ ownerUid, malformed: next.malformedDecision === true });
    }
    return structuredClone(next);
  };
  const tryReply = compileFunction(aiSource, "export async function tryReply", {
    layChuTaiKhoan: () => "owner-fixture",
    getConfig: () => sourceConfig,
    shouldProcessMessage,
    addLog: async (entry) => { logs.push(entry); },
    filterSkipReason: () => "fixture",
    describeMessage: (value) => ({
      threadId: value?.threadId || null,
      messageId: value?.id || null,
      senderId: value?.senderId || null,
    }),
    isAiChatReady: () => true,
    websiteEmailStatus: { lookupCustomerEmailStatus: async () => ({ outcome: "NO_MATCH" }) },
    generateReply,
    recordDecisionProtocolOutcome,
    canonicalDecisionResultLog: (result, context) => ({
      event: "ai_output_contract_failure",
      level: "error",
      summary: "malformed detected; retry path selected",
      detail: { ownerUid: context.ownerUid, reason: result.error },
    }),
    MAX_AI_RETRY: 1,
    MALFORMED_DECISION_FALLBACK: FALLBACK,
    openAdminClarification: async () => null,
    customerMemory: {
      ducKetNeuDenLuot: async (...args) => { memory.push(args); },
    },
  });
  return {
    calls,
    logs,
    protocolOutcomes,
    memory,
    message,
    sourceConfig,
    shouldProcessCalls: () => shouldProcessCalls,
    run: (userMessage = "Tin nhắn khách") => tryReply(userMessage, message),
  };
}

await test("B1", "valid first attempt has zero retry and one normal reply", async () => {
  const fixture = harness([valid("Bình thường")]);
  assert.equal(await fixture.run(), "Bình thường");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.logs.filter((entry) => entry.event === "ai_response").length, 1);
});

await test("B2", "malformed then valid retries exactly once with no fallback", async () => {
  const fixture = harness([malformed(), valid("Sau retry")]);
  assert.equal(await fixture.run(), "Sau retry");
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.logs.filter((entry) => entry.event === "ai_output_contract_fallback").length, 0);
});

await test("B3", "double malformed returns the exact fallback once", async () => {
  const fixture = harness([malformed("one"), malformed("two")]);
  assert.equal(await fixture.run(), FALLBACK);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.logs.filter((entry) => entry.event === "ai_output_contract_fallback").length, 1);
});

await test("B4", "retry exception returns the exact fallback once", async () => {
  const fixture = harness([malformed(), new Error("retry exploded")]);
  assert.equal(await fixture.run(), FALLBACK);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.logs.filter((entry) => entry.event === "ai_output_contract_fallback").length, 1);
});

await test("B5", "one customer turn records one final protocol outcome", async () => {
  for (const sequence of [[valid()], [malformed(), valid()], [malformed(), malformed("two")], [malformed(), new Error("retry")]]) {
    const fixture = harness(sequence);
    await fixture.run();
    assert.equal(fixture.protocolOutcomes.length, 1);
  }
});

await test("B6", "malformed then valid records final valid without double malformed count", async () => {
  const fixture = harness([malformed(), valid()]);
  await fixture.run();
  assert.deepEqual(fixture.protocolOutcomes.map((entry) => entry.malformed), [false]);
});

await test("B7", "double malformed records one final malformed outcome", async () => {
  const fixture = harness([malformed(), malformed("two")]);
  await fixture.run();
  assert.deepEqual(fixture.protocolOutcomes.map((entry) => entry.malformed), [true]);
});

await test("B8", "every path returns at most one outbound value", async () => {
  for (const sequence of [[valid("one")], [malformed(), valid("two")], [malformed(), malformed("three")]]) {
    const fixture = harness(sequence);
    const returned = [await fixture.run()].filter((value) => value !== null && value !== undefined);
    assert.equal(returned.length, 1);
  }
});

await test("B9", "OUT_OF_SCOPE remains silent and is not converted to fallback", async () => {
  const fixture = harness([outOfScope()]);
  assert.equal(await fixture.run(), null);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.logs.filter((entry) => entry.event === "ai_skip").length, 1);
  assert.equal(fixture.logs.filter((entry) => entry.event === "ai_output_contract_fallback").length, 0);
});

await test("B10", "retry cap and source-shape invariants I1-I6 are preserved", () => {
  assert.match(aiSource, /export const MAX_AI_RETRY = 1;/);
  const tryBody = extractFunction(aiSource, "export async function tryReply");
  assert.equal((tryBody.match(/layChuTaiKhoan\(\)/g) || []).length, 1);
  assert.match(tryBody, /const result = await generateReply\(userMessage, messageObj, ownerUid, config\);/);
  assert.match(tryBody, /if \(result\.malformedDecision\)/);
  assert.ok(tryBody.indexOf("if (result.malformedDecision)") < tryBody.indexOf("if (result.error)"));
  assert.match(tryBody, /canonicalDecisionResultLog\(result, \{ ownerUid, message: messageObj \}\)/);
  assert.ok(aiSource.includes("  if (result.needAdmin) {"));
  assert.ok(aiSource.includes("\n  if (result.skipped)"));
});

await test("B11", "retry preserves user, owner, thread, message and config context", async () => {
  const fixture = harness([malformed(), valid()]);
  const userMessage = "Nguyên văn customer turn";
  await fixture.run(userMessage);
  assert.equal(fixture.calls.length, 2);
  for (const call of fixture.calls) {
    assert.equal(call.userMessage, userMessage);
    assert.equal(call.ownerUid, "owner-fixture");
    assert.equal(call.messageObj, fixture.message);
    assert.equal(call.messageObj.threadId, "thread-fixture");
  }
  assert.equal(fixture.calls[0].config, fixture.calls[1].config);
  assert.equal(fixture.calls[0].config.opencodeBaseUrl, fixture.sourceConfig.opencodeBaseUrl);
});

await test("B12", "fallback makes no fabricated Admin handoff claim", () => {
  assert.equal(FALLBACK, "Em chưa thể xử lý chính xác yêu cầu này lúc này. Em đã ghi nhận tin nhắn của anh/chị.");
  assert.doesNotMatch(FALLBACK, /admin|quản trị|chuyển|liên hệ|sẽ trả lời|đã gửi/i);
});

await test("B13", "new fallback logging contains no raw customer content or unsafe PII field", async () => {
  const fixture = harness([malformed(), malformed("two")]);
  await fixture.run("SECRET_CUSTOMER_BODY");
  const fallbackLog = fixture.logs.find((entry) => entry.event === "ai_output_contract_fallback");
  assert.ok(fallbackLog);
  assert.equal("raw" in fallbackLog.detail, false);
  assert.equal("userMessage" in fallbackLog.detail, false);
  assert.doesNotMatch(JSON.stringify(fallbackLog), /SECRET_CUSTOMER_BODY/);
});

await test("B14", "Admin copy no longer claims malformed turns intentionally stayed silent", () => {
  const malformedBranch = adminSource.slice(
    adminSource.indexOf("if (result?.malformedDecision)"),
    adminSource.indexOf("if (result?.needAdmin)")
  );
  assert.doesNotMatch(malformedBranch, /bot đã im lặng/i);
  assert.doesNotMatch(adminSource, /Bot đã im lặng với các lượt lỗi/i);
  assert.match(adminSource, /fallback an toàn/);
});

await test("B15", "outbound send_ok remains after successful provider send and failure cannot reach it", () => {
  const outboundBody = extractFunction(zaloSource, "async function traLoiCumTin");
  const providerCall = outboundBody.indexOf("await sendChatMessage({");
  const sendOk = outboundBody.indexOf('event: "send_ok"');
  const catchBlock = outboundBody.indexOf("} catch (error) {", providerCall);
  assert.ok(providerCall >= 0 && sendOk > providerCall);
  assert.ok(catchBlock > sendOk);
});

await test("B16", "null config preserves production fail-closed behavior", async () => {
  const fixture = harness([valid("must not run")], { config: null });
  assert.equal(await fixture.run(), null);
  assert.equal(fixture.shouldProcessCalls(), 1);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.logs.filter((entry) => entry.event === "filter_skip").length, 1);
  assert.equal(fixture.logs.filter((entry) => entry.event === "filter_pass").length, 0);
  assert.equal(fixture.logs.filter((entry) => entry.event === "ai_start").length, 0);
  assert.equal(fixture.protocolOutcomes.length, 0);
});

await test("B17", "valid config preserves normal path and deferred accounting", async () => {
  const fixture = harness([valid("valid config reply")]);
  assert.equal(await fixture.run(), "valid config reply");
  assert.equal(fixture.shouldProcessCalls(), 1);
  assert.equal(fixture.calls.length, 1);
  assert.notEqual(fixture.calls[0].config, fixture.sourceConfig);
  assert.equal(fixture.calls[0].config.__deferDecisionProtocolOutcome, true);
  assert.equal(fixture.sourceConfig.__deferDecisionProtocolOutcome, undefined);
  assert.deepEqual(fixture.protocolOutcomes.map((entry) => entry.malformed), [false]);
});

const failed = results.filter((result) => !result.pass);
console.log(`\nBOT CONTRACT FALLBACK: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) process.exitCode = 1;
