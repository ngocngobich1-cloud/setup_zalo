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

const canonicalizeLeadingSpeakerMention = compileFunction(
  ZALO,
  "function canonicalizeLeadingSpeakerMention"
);

/**
 * `tuyChon` cho phep doi nguoi noi / bubble dau ma khong dung toi cac case cu:
 * mac dinh giu nguyen "Bich Ngoc" + speaker-1 + laBubbleDau=false.
 */
function createHarness(members = [{ uid: "mai-anh", ten: "Mai Anh" }], tuyChon = {}) {
  const filterCalls = [];
  const logs = [];
  const transports = [];
  // Moi lan goi layThanhVien tra ve mot the `__snapshot` rieng. Nho vay co the
  // chung minh ca hai ben (chan nhap nhang + khop ten) dung CHUNG mot ban chup,
  // chu khong chi dem duoc so lan goi.
  const memberLookups = [];
  const snapshotSeenBy = { canonicalizer: [], matcher: [] };
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

  const observedLayThanhVien = async (...args) => {
    const snapshotId = memberLookups.length + 1;
    const snapshot = members.map((member) => ({ ...member, __snapshot: snapshotId }));
    memberLookups.push({ args, snapshotId, snapshot });
    return snapshot;
  };
  const observedCanonicalizer = (body, tenNguoiNoi, uidNguoiNoi, thanhVien) => {
    snapshotSeenBy.canonicalizer.push(...(thanhVien || []).map((tv) => tv.__snapshot));
    return canonicalizeLeadingSpeakerMention(body, tenNguoiNoi, uidNguoiNoi, thanhVien);
  };
  const observedKhopTenTrongCau = (text, ds, mentionsCoSan) => {
    snapshotSeenBy.matcher.push(...(ds || []).map((tv) => tv.__snapshot));
    return khopTenTrongCau(text, ds, mentionsCoSan);
  };

  const prepareGroupMention = compileFunction(ZALO, "async function dungTheNhacTen", {
    chuHienTai: () => "owner-1",
    api: {},
    locTruocKhiGui: observedFilter,
    layThanhVien: observedLayThanhVien,
    canonicalizeLeadingSpeakerMention: observedCanonicalizer,
    khopTenTrongCau: observedKhopTenTrongCau,
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
    senderId: tuyChon.senderId ?? "speaker-1",
    senderName: tuyChon.senderName ?? "Bich Ngoc",
  };
  return {
    filterCalls,
    logs,
    transports,
    observedFilter,
    tin,
    memberLookups,
    snapshotSeenBy,
    prepare: (bubble, laBubbleDau = tuyChon.laBubbleDau ?? false) =>
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
  // Return som phai xay ra TRUOC khi hoi danh sach thanh vien.
  assert.equal(harness.memberLookups.length, 0);
  console.log(`F01-T09 LAY_THANH_VIEN_CALL_COUNT=${harness.memberLookups.length}`);
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

/* --- BU DUPLICATE @MENTION --- */

const NGUOI_KHAC = [{ uid: "khac-1", ten: "Nguyen Van B" }];
const NOI_NGUOI_NOI = { senderId: "speaker-5", senderName: "Tran Mai Anh" };
const NHOM_TACH_AN_TOAN = [
  { uid: "speaker-5", ten: "Tran Mai Anh" },
  { uid: "khac-1", ten: "Nguyen Van B" },
];
// Cung mot nhom, nhung cho cac case goi THANG helper voi uid nguoi noi UID-A.
// Nguoi noi VAN nam trong danh sach de chung minh ho khong tu chan chinh minh.
const NHOM_HELPER = [
  { uid: "UID-A", ten: "Tran Mai Anh" },
  { uid: "khac-1", ten: "Nguyen Van B" },
];

function goiTrucTiep(body, ten, uid, members) {
  return canonicalizeLeadingSpeakerMention(body, ten, uid, members);
}

function proveHelper(code, body, ketQua, mongDoi) {
  console.log(`${code} HELPER_BODY=${JSON.stringify(body)}`);
  console.log(`${code} HELPER_RESULT=${JSON.stringify(ketQua)}`);
  console.log(`${code} HELPER_EXPECTED=${JSON.stringify(mongDoi)}`);
  assert.equal(ketQua, mongDoi);
}

test("DUP-P1", "baseline auto-mention is unchanged when AI writes no @", async () => {
  const harness = createHarness(NGUOI_KHAC, { senderId: "speaker-5", senderName: "Sender" });
  const result = await harness.prepare("Xin chào", true);
  assert.equal(result.text, "@Sender Xin chào");
  assert.equal(result.mentions.length, 1);
  assert.equal(result.mentions[0].uid, "speaker-5");
  proveMention("DUP-P1", "Xin chào", result, result.mentions[0], "@Sender");
});

test("DUP-P2", "exact AI speaker mention is not duplicated", async () => {
  const harness = createHarness(NGUOI_KHAC, { senderId: "speaker-5", senderName: "Sender" });
  const result = await harness.prepare("@Sender", true);
  assert.equal(result.text, "@Sender");
  assert.notEqual(result.text, "@Sender @Sender");
  assert.equal(result.mentions.length, 1);
  assert.equal(result.mentions[0].uid, "speaker-5");
  proveMention("DUP-P2", "@Sender", result, result.mentions[0], "@Sender");
});

test("DUP-P3", "repeated exact speaker run collapses to one mention", async () => {
  const harness = createHarness(NGUOI_KHAC, { senderId: "speaker-5", senderName: "Sender" });
  const result = await harness.prepare("@Sender @Sender", true);
  assert.equal(result.text, "@Sender");
  assert.equal(result.mentions.length, 1);
  proveMention("DUP-P3", "@Sender @Sender", result, result.mentions[0], "@Sender");
});

test("DUP-P4", "repeated speaker run keeps the remaining body intact", async () => {
  const harness = createHarness(NGUOI_KHAC, { senderId: "speaker-5", senderName: "Sender" });
  const result = await harness.prepare("@Sender @Sender Nội dung", true);
  assert.equal(result.text, "@Sender Nội dung");
  assert.equal(result.mentions.length, 1);
  proveMention("DUP-P4", "@Sender @Sender Nội dung", result, result.mentions[0], "@Sender");
});

test("DUP-P5", "safe split representation collapses to one full canonical mention", async () => {
  const harness = createHarness(NHOM_TACH_AN_TOAN, NOI_NGUOI_NOI);
  const result = await harness.prepare("@Tran @Mai Anh", true);
  assert.equal(result.text, "@Tran Mai Anh");
  assert.equal(result.mentions.length, 1);
  assert.equal(result.mentions[0].uid, "speaker-5");
  proveMention("DUP-P5", "@Tran @Mai Anh", result, result.mentions[0], "@Tran Mai Anh");
});

test("DUP-P6", "split representation plus body keeps the body intact", async () => {
  const harness = createHarness(NHOM_TACH_AN_TOAN, NOI_NGUOI_NOI);
  const result = await harness.prepare("@Tran @Mai Anh Nội dung", true);
  assert.equal(result.text, "@Tran Mai Anh Nội dung");
  assert.equal(result.mentions.length, 1);
  assert.equal(result.mentions[0].uid, "speaker-5");
  proveMention("DUP-P6", "@Tran @Mai Anh Nội dung", result, result.mentions[0], "@Tran Mai Anh");
});

test("DUP-A1", "duplicate full display name fails narrow", () => {
  const body = "@Tran Mai Anh Nội dung";
  const nhapNhang = [
    { uid: "UID-A", ten: "Tran Mai Anh" },
    { uid: "UID-B", ten: "Tran Mai Anh" },
  ];
  proveHelper("DUP-A1", body, goiTrucTiep(body, "Tran Mai Anh", "UID-A", nhapNhang), body);

  // Khong nhap nhang thi VAN phai don - neu khong, A1 se xanh vi ly do sai.
  const roRang = [
    { uid: "UID-A", ten: "Tran Mai Anh" },
    { uid: "UID-B", ten: "Nguyen Van B" },
  ];
  proveHelper("DUP-A1.CTRL", body, goiTrucTiep(body, "Tran Mai Anh", "UID-A", roRang), "Nội dung");
});

test("DUP-A2", "split chunk matching another member fails narrow", () => {
  const body = "@Tran @Mai Anh Nội dung";
  const trungManhDau = [
    { uid: "UID-A", ten: "Tran Mai Anh" },
    { uid: "UID-C", ten: "Tran" },
  ];
  proveHelper("DUP-A2.1", body, goiTrucTiep(body, "Tran Mai Anh", "UID-A", trungManhDau), body);

  const trungManhSau = [
    { uid: "UID-A", ten: "Tran Mai Anh" },
    { uid: "UID-D", ten: "Mai Anh" },
  ];
  proveHelper("DUP-A2.2", body, goiTrucTiep(body, "Tran Mai Anh", "UID-A", trungManhSau), body);

  const trungTenDayDu = [
    { uid: "UID-A", ten: "Tran Mai Anh" },
    { uid: "UID-B", ten: "Tran Mai Anh" },
  ];
  proveHelper("DUP-A2.3", body, goiTrucTiep(body, "Tran Mai Anh", "UID-A", trungTenDayDu), body);

  proveHelper(
    "DUP-A2.CTRL",
    body,
    goiTrucTiep(body, "Tran Mai Anh", "UID-A", NHOM_HELPER),
    "Nội dung"
  );
});

test("DUP-N1", "leading mention of another person is never consumed", () => {
  const body = "@Nguyen Van B Nội dung";
  const nhom = [
    { uid: "UID-A", ten: "Tran Mai Anh" },
    { uid: "UID-B", ten: "Nguyen Van B" },
  ];
  proveHelper("DUP-N1", body, goiTrucTiep(body, "Tran Mai Anh", "UID-A", nhom), body);
});

test("DUP-N2", "mid-body speaker text is untouched", () => {
  const body = "Nội dung @Tran Mai Anh";
  proveHelper("DUP-N2", body, goiTrucTiep(body, "Tran Mai Anh", "UID-A", NHOM_HELPER), body);
});

test("DUP-N3", "partial split does not reconstruct the full name", () => {
  const body = "@Tran @Mai";
  proveHelper("DUP-N3", body, goiTrucTiep(body, "Tran Mai Anh", "UID-A", NHOM_HELPER), body);
  proveHelper(
    "DUP-N3.CTRL",
    "@Tran @Mai Anh",
    goiTrucTiep("@Tran @Mai Anh", "Tran Mai Anh", "UID-A", NHOM_HELPER),
    ""
  );
});

test("DUP-N4", "wrong split chunk does not reconstruct the full name", () => {
  const body = "@Tran @Other";
  proveHelper("DUP-N4", body, goiTrucTiep(body, "Tran Mai Anh", "UID-A", NHOM_HELPER), body);
});

test("DUP-N5", "punctuation variant is not consumed in V1", () => {
  const body = "@Sender,";
  const nhom = [{ uid: "UID-A", ten: "Sender" }, { uid: "UID-B", ten: "Nguyen Van B" }];
  proveHelper("DUP-N5", body, goiTrucTiep(body, "Sender", "UID-A", nhom), body);
  proveHelper("DUP-N5.CTRL", "@Sender", goiTrucTiep("@Sender", "Sender", "UID-A", nhom), "");
});

test("DUP-NFC", "NFD leading text matches the NFC sender name and emits the original name", async () => {
  const tenNFC = "Nguyễn Thị Hồng";
  const body = `${"@Nguyễn Thị Hồng".normalize("NFD")} Noi dung`;
  assert.notEqual(body, body.normalize("NFC")); // chung minh dau vao THUC SU la NFD
  const harness = createHarness(NGUOI_KHAC, { senderId: "speaker-nfc", senderName: tenNFC });
  const result = await harness.prepare(body, true);
  assert.equal(result.text, `@${tenNFC} Noi dung`);
  assert.equal(result.text.slice(1, 1 + tenNFC.length), tenNFC); // ten goc, khong phai byte cua AI
  assert.equal(result.mentions.length, 1);
  assert.equal(result.mentions[0].uid, "speaker-nfc");
  proveMention("DUP-NFC", body, result, result.mentions[0], `@${tenNFC}`);
});

test("DUP-M1", "non-empty path looks members up exactly once and reuses that snapshot", async () => {
  const harness = createHarness(NHOM_TACH_AN_TOAN, NOI_NGUOI_NOI);
  const result = await harness.prepare("@Tran @Mai Anh Nguyen Van B oi", true);
  assert.equal(harness.memberLookups.length, 1);
  console.log(`DUP-M1 LAY_THANH_VIEN_CALL_COUNT=${harness.memberLookups.length}`);

  // Ca hai ben phai NHIN THAY thanh vien, va phai la CUNG mot ban chup.
  assert.ok(harness.snapshotSeenBy.canonicalizer.length > 0);
  assert.ok(harness.snapshotSeenBy.matcher.length > 0);
  const banChup = new Set([
    ...harness.snapshotSeenBy.canonicalizer,
    ...harness.snapshotSeenBy.matcher,
  ]);
  console.log(`DUP-M1 SNAPSHOT_IDS=${JSON.stringify([...banChup])}`);
  assert.deepEqual([...banChup], [1]);

  assert.equal(result.text, "@Tran Mai Anh @Nguyen Van B oi");
  assert.deepEqual(result.mentions.map((m) => m.uid), ["speaker-5", "khac-1"]);
  proveMention("DUP-M1.1", "@Tran @Mai Anh Nguyen Van B oi", result, result.mentions[0], "@Tran Mai Anh");
  proveMention("DUP-M1.2", "@Tran @Mai Anh Nguyen Van B oi", result, result.mentions[1], "@Nguyen Van B");
});

test("DUP-M2", "empty body returns before any member lookup", async () => {
  const harness = createHarness(NHOM_TACH_AN_TOAN, NOI_NGUOI_NOI);
  const result = await harness.prepare(" [tool_call: bash]\n[thinking] ", true);
  assert.deepEqual(result, { text: "", mentions: [] });
  assert.equal(harness.memberLookups.length, 0);
  console.log(`DUP-M2 LAY_THANH_VIEN_CALL_COUNT=${harness.memberLookups.length}`);
});

test("DUP-N678", "trim, emoji UTF-16 and multi-target ordering survive on the bubble-dau path", async () => {
  const harness = createHarness([
    { uid: "mai-anh", ten: "Mai Anh" },
    { uid: "bao-tran", ten: "Bảo Trân" },
  ]);
  const raw = "  🙂 Chào Mai Anh và Bảo Trân  ";
  const result = await harness.prepare(raw, true);
  assert.equal(result.text, "@Bich Ngoc 🙂 Chào @Mai Anh và @Bảo Trân");
  assert.deepEqual(result.mentions.map((m) => m.uid), ["speaker-1", "mai-anh", "bao-tran"]);
  proveMention("DUP-N678.1", raw, result, result.mentions[0], "@Bich Ngoc");
  proveMention("DUP-N678.2", raw, result, result.mentions[1], "@Mai Anh");
  proveMention("DUP-N678.3", raw, result, result.mentions[2], "@Bảo Trân");
});

test("DUP-X1", "fake provider receives the canonical collapsed text and one speaker mention", async () => {
  const harness = createHarness(NHOM_TACH_AN_TOAN, NOI_NGUOI_NOI);
  const prepared = await harness.prepare("@Tran @Mai Anh Nội dung", true);
  await harness.send({ text: prepared.text, mentions: prepared.mentions });

  const transport = harness.transports.at(-1);
  const msg = transport.payload.msg;
  console.log(`DUP-X1 TRANSPORT_MSG=${JSON.stringify(msg)}`);
  console.log(`DUP-X1 TRANSPORT_MENTIONS=${JSON.stringify(transport.payload.mentions)}`);
  assert.equal(msg, "@Tran Mai Anh Nội dung");
  assert.equal(transport.payload.mentions.length, 1);
  assert.equal(transport.payload.mentions[0].uid, "speaker-5");
  const span = msg.slice(
    transport.payload.mentions[0].pos,
    transport.payload.mentions[0].pos + transport.payload.mentions[0].len
  );
  console.log(`DUP-X1 TRANSPORT_SPAN=${JSON.stringify(span)}`);
  assert.equal(span, "@Tran Mai Anh");
});

/* --- CHO NOI: DUNG MOT U+0020 --- */

// Viet bang   de so luong dau cach khong the bi mat khi format lai file.
const SP = " ";
const SP3 = SP + SP + SP;
const NHOM_SENDER = [
  { uid: "UID-A", ten: "Sender" },
  { uid: "khac-1", ten: "Nguyen Van B" },
];

test("DUP-W1", "only the first U+0020 is consumed; extra spaces stay in the body", async () => {
  const body = `@Sender${SP3}Nội dung`;

  // Goi thang helper: chung minh DUNG MOT code unit bi an di.
  const conLai = goiTrucTiep(body, "Sender", "UID-A", NHOM_SENDER);
  proveHelper("DUP-W1.HELPER", body, conLai, `${SP}${SP}Nội dung`);
  assert.equal(body.length - conLai.length, "@Sender".length + 1);
  console.log(`DUP-W1 CONNECTOR_CODE_UNITS_CONSUMED=${body.length - conLai.length - "@Sender".length}`);

  const harness = createHarness(NGUOI_KHAC, { senderId: "speaker-5", senderName: "Sender" });
  const result = await harness.prepare(body, true);
  assert.equal(result.text, `@Sender${SP3}Nội dung`);
  assert.equal(result.mentions.length, 1);
  proveMention("DUP-W1", body, result, result.mentions[0], "@Sender");
});

test("DUP-W2", "repeated run keeps the extra spaces after the final representation", async () => {
  const body = `@Sender${SP}@Sender${SP3}Nội dung`;
  const harness = createHarness(NGUOI_KHAC, { senderId: "speaker-5", senderName: "Sender" });
  const result = await harness.prepare(body, true);
  assert.equal(result.text, `@Sender${SP3}Nội dung`);
  assert.equal(result.mentions.length, 1);
  proveMention("DUP-W2", body, result, result.mentions[0], "@Sender");
});

test("DUP-W3", "split form keeps the extra spaces after the final chunk", async () => {
  const body = `@Tran${SP}@Mai Anh${SP3}Nội dung`;
  const harness = createHarness(NHOM_TACH_AN_TOAN, NOI_NGUOI_NOI);
  const result = await harness.prepare(body, true);
  assert.equal(result.text, `@Tran Mai Anh${SP3}Nội dung`);
  assert.equal(result.mentions.length, 1);
  proveMention("DUP-W3", body, result, result.mentions[0], "@Tran Mai Anh");
});

test("DUP-W4", "tab is not a connector - representation is not consumed", () => {
  const body = "@Sender\tNội dung";
  proveHelper("DUP-W4", body, goiTrucTiep(body, "Sender", "UID-A", NHOM_SENDER), body);
});

test("DUP-W5", "newline is not a connector - representation is not consumed", () => {
  const body = "@Sender\nNội dung";
  proveHelper("DUP-W5", body, goiTrucTiep(body, "Sender", "UID-A", NHOM_SENDER), body);
});

test("DUP-W6", "carriage return is not a connector - representation is not consumed", () => {
  const body = "@Sender\rNội dung";
  proveHelper("DUP-W6", body, goiTrucTiep(body, "Sender", "UID-A", NHOM_SENDER), body);
});

test("DUP-W7", "double space between repeated representations fails narrow", async () => {
  const body = `@Sender${SP}${SP}@Sender${SP}Nội dung`;

  // Bieu dien DAU van hop le nen van duoc nuot; cho noi la mot dau cach. Den
  // dau cach thu hai thi hop dong khong con thoa -> dung lai NGAY tai do.
  const conLai = goiTrucTiep(body, "Sender", "UID-A", NHOM_SENDER);
  proveHelper("DUP-W7.HELPER", body, conLai, `${SP}@Sender${SP}Nội dung`);
  assert.equal(conLai.includes(`${SP}${SP}`), false); // khong con dau cach doi bi nuot nham

  // Toan tuyen: ung dung dat lai tien to cua minh, ket qua TRUNG KHIT dau vao.
  // Khong nhan doi, khong gop hai dau cach thanh mot.
  const harness = createHarness(NGUOI_KHAC, { senderId: "speaker-5", senderName: "Sender" });
  const result = await harness.prepare(body, true);
  console.log(`DUP-W7 FULL_PATH_FINAL=${JSON.stringify(result.text)}`);
  assert.equal(result.text, body);
  assert.equal(result.mentions.length, 1);
  proveMention("DUP-W7", body, result, result.mentions[0], "@Sender");
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
