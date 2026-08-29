/**
 * BU-STAB-09-F01 focused regression gate.
 *
 * Production function bodies execute with deterministic member data and a fake
 * transport. This file never imports the live Zalo service, opens the DB, or
 * contacts Zalo/provider infrastructure.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locRuotGan } from "../lib/loc-ruot-gan.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ZALO = fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8");

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

function compileFunction(moduleSource, signature, dependencies = {}) {
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

const dungTenGoi = compileFunction(ZALO, "function dungTenGoi");
const taoBanSoSanhUnicode = compileFunction(ZALO, "function taoBanSoSanhUnicode");
const khopTenTrongCau = compileFunction(ZALO, "export function khopTenTrongCau", {
  dungTenGoi,
  taoBanSoSanhUnicode,
});
const chenDauA = compileFunction(ZALO, "export function chenDauA");

function createHarness(members = [{ uid: "mai-anh", ten: "Mai Anh" }]) {
  const filterCalls = [];
  const logs = [];
  const transports = [];
  const baseFilter = compileFunction(ZALO, "async function locTruocKhiGui", {
    locRuotGan,
    addLog: async (entry) => {
      logs.push(entry);
      return entry;
    },
  });
  const observedFilter = async (text, threadId) => {
    const call = { input: text, threadId, output: null };
    filterCalls.push(call);
    call.output = await baseFilter(text, threadId);
    return call.output;
  };

  const prepareGroupMention = compileFunction(ZALO, "async function dungTheNhacTen", {
    chuHienTai: () => "owner-1",
    api: {},
    locTruocKhiGui: observedFilter,
    layThanhVien: async () => members.map((member) => ({ ...member })),
    khopTenTrongCau,
    chenDauA,
  });

  const fakeApi = {
    sendMessage: async (payload, threadId, threadType) => {
      transports.push({ kind: "message", payload, threadId, threadType });
      return { message: null };
    },
    sendLink: async (payload, threadId, threadType) => {
      transports.push({ kind: "link", payload, threadId, threadType });
      return { msgId: null };
    },
  };
  const sendChatMessage = compileFunction(
    ZALO,
    "export async function sendChatMessage({ threadId, text, threadType, quote, mentions, urgency, attachment, originToken })",
    {
    originConHieuLuc: () => true,
    api: fakeApi,
    appState: {
      loggedIn: true,
      uid: "owner-1",
      displayName: "Owner",
      myAvatar: null,
    },
    chuHienTai: () => "owner-1",
    getThread: async (_ownerUid, threadId) => ({ id: threadId }),
    locTruocKhiGui: observedFilter,
    taoNguonDinhKemZalo: () => null,
    ThreadType: { User: 0, Group: 1 },
    timLinkChinh: () => null,
    layMsgIdTuKetQuaGui: () => null,
    addLog: async (entry) => {
      logs.push(entry);
      return entry;
    },
    normalizeTs: (value) => value,
      persistAndBroadcastMessage: async () => {
        throw new Error("Fake transport must not persist");
      },
    }
  );

  const tin = {
    threadId: "group-1",
    threadType: 1,
    senderId: "speaker-1",
    senderName: "Bich Ngoc",
  };
  return {
    filterCalls,
    logs,
    transports,
    observedFilter,
    prepare: (bubble, laBubbleDau = false) =>
      prepareGroupMention(bubble, tin, laBubbleDau, "owner-1", fakeApi),
    send: (payload) => sendChatMessage({
      threadId: "group-1",
      threadType: 1,
      ...payload,
    }),
  };
}

function transportedText(transport) {
  return typeof transport?.payload === "string" ? transport.payload : transport?.payload?.msg;
}

function proveMention(code, rawText, result, mention, expectedSubstring) {
  const selected = result.text.slice(mention.pos, mention.pos + mention.len);
  console.log(`${code} RAW_TEXT=${JSON.stringify(rawText)}`);
  console.log(`${code} FINAL_TEXT=${JSON.stringify(result.text)}`);
  console.log(`${code} MENTION_POS=${mention.pos}`);
  console.log(`${code} MENTION_LEN=${mention.len}`);
  console.log(`${code} SELECTED_SUBSTRING=${JSON.stringify(selected)}`);
  console.log(`${code} EXPECTED_SUBSTRING=${JSON.stringify(expectedSubstring)}`);
  assert.equal(selected, expectedSubstring);
}

const tests = [];
function test(code, description, run) {
  tests.push({ code, description, run });
}

test("F01-T01", "simple mention remains unchanged", async () => {
  const harness = createHarness();
  const result = await harness.prepare("Mai Anh oi");
  assert.equal(result.text, "@Mai Anh oi");
  assert.equal(result.mentions.length, 1);
  proveMention("F01-T01", "@Mai Anh oi", result, result.mentions[0], "@Mai Anh");
});

test("F01-T02", "leading whitespace is finalized before coordinates", async () => {
  const harness = createHarness();
  const result = await harness.prepare("  Mai Anh oi");
  assert.equal(result.text, "@Mai Anh oi");
  proveMention("F01-T02", "  @Mai Anh oi", result, result.mentions[0], "@Mai Anh");
});

test("F01-T03", "trailing whitespace is finalized before coordinates", async () => {
  const harness = createHarness();
  const result = await harness.prepare("Mai Anh oi  ");
  assert.equal(result.text, "@Mai Anh oi");
  proveMention("F01-T03", "@Mai Anh oi  ", result, result.mentions[0], "@Mai Anh");
});

test("F01-T04", "leading and trailing whitespace keep exact mention", async () => {
  const harness = createHarness();
  const result = await harness.prepare("  Mai Anh oi  ");
  assert.equal(result.text, "@Mai Anh oi");
  proveMention("F01-T04", "  @Mai Anh oi  ", result, result.mentions[0], "@Mai Anh");
});

test("F01-T05", "tool line before mention is removed before coordinates", async () => {
  const harness = createHarness();
  const result = await harness.prepare("[tool_call: bash]\nMai Anh oi");
  assert.equal(result.text, "@Mai Anh oi");
  proveMention(
    "F01-T05",
    "[tool_call: bash]\n@Mai Anh oi",
    result,
    result.mentions[0],
    "@Mai Anh"
  );
});

test("F01-T06", "multiple internal lines before mention keep exact coordinates", async () => {
  const harness = createHarness();
  const result = await harness.prepare("[thinking]\n[tool_result: hidden]\nMai Anh oi");
  assert.equal(result.text, "@Mai Anh oi");
  proveMention(
    "F01-T06",
    "[thinking]\n[tool_result: hidden]\n@Mai Anh oi",
    result,
    result.mentions[0],
    "@Mai Anh"
  );
});

test("F01-T07", "internal line after mention is removed without shifting it", async () => {
  const harness = createHarness();
  const result = await harness.prepare("Mai Anh oi\n[system: hidden]");
  assert.equal(result.text, "@Mai Anh oi");
  proveMention(
    "F01-T07",
    "@Mai Anh oi\n[system: hidden]",
    result,
    result.mentions[0],
    "@Mai Anh"
  );
});

test("F01-T08", "ordinary non-mention text keeps the prior trim/filter behavior", async () => {
  const harness = createHarness([]);
  const result = await harness.prepare("  Xin chao ban  ");
  assert.deepEqual(result, { text: "Xin chao ban", mentions: [] });
});

test("F01-T09", "empty canonical text has no mentions and preserves empty-send failure", async () => {
  const harness = createHarness();
  const result = await harness.prepare(" [tool_call: bash]\n[thinking] ");
  assert.deepEqual(result, { text: "", mentions: [] });
  await assert.rejects(
    harness.send({ text: result.text, mentions: result.mentions }),
    /Thieu cuoc chat hoac noi dung/
  );
  assert.equal(harness.transports.length, 0);
});

test("F01-T10", "Vietnamese Unicode name uses exact UTF-16 coordinates", async () => {
  const harness = createHarness([{ uid: "hong", ten: "Nguyễn Thị Hồng" }]);
  const result = await harness.prepare("  Nguyễn Thị Hồng ơi  ");
  assert.equal(result.text, "@Nguyễn Thị Hồng ơi");
  proveMention(
    "F01-T10",
    "  @Nguyễn Thị Hồng ơi  ",
    result,
    result.mentions[0],
    "@Nguyễn Thị Hồng"
  );
});

test("F01-T11", "emoji indexing and existing multi-mention ordering are preserved", async () => {
  const harness = createHarness([
    { uid: "mai-anh", ten: "Mai Anh" },
    { uid: "bao-tran", ten: "Bảo Trân" },
  ]);
  const raw = "🙂 Chào Mai Anh và Bảo Trân";
  const result = await harness.prepare(raw);
  assert.equal(result.text, "🙂 Chào @Mai Anh và @Bảo Trân");
  assert.equal(result.mentions.length, 2);
  assert.deepEqual(result.mentions.map((mention) => mention.uid), ["mai-anh", "bao-tran"]);
  proveMention("F01-T11.1", raw, result, result.mentions[0], "@Mai Anh");
  proveMention("F01-T11.2", raw, result, result.mentions[1], "@Bảo Trân");

  // Giu guard cu: member "Ngoc" khong duoc an nham vao ten nguoi noi
  // "Bich Ngoc", nhung van phai duoc gan the neu xuat hien trong body.
  const prefixHarness = createHarness([{ uid: "ngoc", ten: "Ngoc" }]);
  const prefixResult = await prefixHarness.prepare("Ngoc oi", true);
  assert.equal(prefixResult.text, "@Bich Ngoc @Ngoc oi");
  assert.deepEqual(prefixResult.mentions.map((mention) => mention.uid), ["speaker-1", "ngoc"]);
  proveMention("F01-T11.3", "Bich Ngoc Ngoc oi", prefixResult, prefixResult.mentions[0], "@Bich Ngoc");
  proveMention("F01-T11.4", "Bich Ngoc Ngoc oi", prefixResult, prefixResult.mentions[1], "@Ngoc");
});

test("F01-T12", "canonical preparation is behaviorally idempotent", async () => {
  const harness = createHarness();
  const raw = "  [tool_call: bash]\nMai Anh oi  ";
  const first = await harness.observedFilter(String(raw).trim(), "group-1");
  const second = await harness.observedFilter(String(first).trim(), "group-1");
  assert.equal(first, "Mai Anh oi");
  assert.equal(second, first);
});

test("F01-T13", "sendChatMessage still executes the global filter", async () => {
  const harness = createHarness([]);
  const before = harness.filterCalls.length;
  await harness.send({ text: "  Xin chao an toan  " });
  assert.equal(harness.filterCalls.length, before + 1);
  assert.equal(harness.filterCalls.at(-1).input, "Xin chao an toan");
  assert.equal(transportedText(harness.transports.at(-1)), "Xin chao an toan");
  console.log("F01-T13 GLOBAL_FILTER_CALL=PASS");
});

test("F01-T14", "prepared mention text passes the second filter unchanged", async () => {
  const harness = createHarness();
  const prepared = await harness.prepare("  [tool_result: hidden]\nMai Anh oi  ");
  const before = harness.filterCalls.length;
  await harness.send({ text: prepared.text, mentions: prepared.mentions });
  assert.equal(harness.filterCalls.length, before + 1);
  assert.equal(harness.filterCalls.at(-1).input, prepared.text);
  assert.equal(harness.filterCalls.at(-1).output, prepared.text);
  assert.equal(transportedText(harness.transports.at(-1)), prepared.text);
  proveMention(
    "F01-T14",
    "  [tool_result: hidden]\n@Mai Anh oi  ",
    prepared,
    prepared.mentions[0],
    "@Mai Anh"
  );
  console.log("F01-T14 SECOND_FILTER_PASS=IDENTICAL");
  console.log("F01-T14 MENTION_COORDINATES_VALID_AFTER_SECOND_PASS=YES");
});

test("F01-T15", "send safety gate removes internal tool lines before fake transport", async () => {
  const harness = createHarness([]);
  await harness.send({ text: "[tool_call: bash]\nNoi dung an toan" });
  const finalText = transportedText(harness.transports.at(-1));
  assert.equal(finalText, "Noi dung an toan");
  assert.doesNotMatch(finalText, /\[tool_call\b/i);
  assert.equal(harness.filterCalls.length, 1);
  console.log("F01-T15 INTERNAL_LINE_LEAK=NO");
});

async function runOriginalReproductions() {
  const probes = [
    ["F01-R1", "Mai Anh oi", "@Mai Anh oi"],
    ["F01-R2", "  Mai Anh oi  ", "  @Mai Anh oi  "],
    ["F01-R3", "[tool_call: bash]\nMai Anh oi", "[tool_call: bash]\n@Mai Anh oi"],
  ];
  for (const [code, bubble, rawText] of probes) {
    const harness = createHarness();
    const prepared = await harness.prepare(bubble);
    await harness.send({ text: prepared.text, mentions: prepared.mentions });
    assert.equal(transportedText(harness.transports.at(-1)), "@Mai Anh oi");
    proveMention(code, rawText, prepared, prepared.mentions[0], "@Mai Anh");
    console.log(`${code}=PASS`);
  }
  console.log("F01_REPRODUCED_AFTER_REPAIR=NO");
}

const results = [];
for (const current of tests) {
  try {
    await current.run();
    results.push({ ...current, status: "PASS" });
    console.log(`PASS ${current.code} ${current.description}`);
  } catch (error) {
    results.push({ ...current, status: "FAIL", error });
    console.error(`FAIL ${current.code} ${current.description}:`, error);
  }
}

const passed = results.filter((result) => result.status === "PASS").length;
const failed = results.length - passed;
console.log(`F01_FOCUSED_TOTAL=${results.length}`);
console.log(`F01_FOCUSED_PASS=${passed}`);
console.log(`F01_FOCUSED_FAIL=${failed}`);

if (failed === 0) {
  await runOriginalReproductions();
}
if (failed > 0) process.exitCode = 1;
