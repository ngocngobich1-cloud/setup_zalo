/**
 * STAB-07B: Unicode-aware urgency keywords and group mention coordinates.
 *
 * Pure deterministic checks only: no database initialization, network, provider,
 * or live Zalo calls.
 */
import assert from "node:assert/strict";
import { docMucKhan } from "../lib/admin-command.js";
import { chenDauA, khopTenTrongCau } from "../lib/zalo-service.js";

const tests = [];
const test = (code, description, run) => tests.push({ code, description, run });
const member = (uid, ten) => [{ uid, ten }];

test("U01", "khẩn remains priority 2", () => {
  assert.equal(docMucKhan("khẩn"), 2);
});

test("U02", "GẤP remains priority 2 case-insensitively", () => {
  assert.equal(docMucKhan("GẤP"), 2);
});

test("U03", "quan trọng remains priority 1", () => {
  assert.equal(docMucKhan("quan trọng"), 1);
});

test("U04", "nhớ ... nhé works with Vietnamese boundaries", () => {
  assert.equal(docMucKhan("nhớ gửi nhé"), 1);
});

test("U05", "NHỚ ... NHÉ remains case-insensitive", () => {
  assert.equal(docMucKhan("NHỚ gửi NHÉ"), 1);
});

test("U06", "punctuation after nhé is accepted", () => {
  assert.equal(docMucKhan("nhớ gửi nhé!"), 1);
});

test("U07", "urgency keywords do not match inside Unicode words", () => {
  assert.equal(docMucKhan("xgấpy"), 0);
  assert.equal(docMucKhan("abcnhớ gửi nhéxyz"), 0);
});

test("U08", "priority 2 still wins over priority 1", () => {
  assert.equal(docMucKhan("quan trọng nhưng việc này gấp"), 2);
});

test("U09", "ASCII khan cap alias remains priority 2", () => {
  assert.equal(docMucKhan("khan cap"), 2);
});

test("U10", "ASCII gap alias remains priority 2", () => {
  assert.equal(docMucKhan("gap"), 2);
});

test("U11", "ASCII quan trong alias remains priority 1", () => {
  assert.equal(docMucKhan("quan trong"), 1);
});

test("U12", "ordinary text remains priority 0", () => {
  assert.equal(docMucKhan("gửi giúp chị"), 0);
});

test("G01", "normal member name matches at original coordinates", () => {
  assert.deepEqual(khopTenTrongCau("Hoa đang chờ", member("hoa", "Hoa")), [
    { pos: 0, uid: "hoa", len: 3 },
  ]);
});

test("G02", "member name does not match inside a longer ASCII word", () => {
  assert.deepEqual(khopTenTrongCau("Hoang đang chờ", member("hoa", "Hoa")), []);
});

test("G03", "Hoa does not match decomposed Hoá", () => {
  assert.deepEqual(khopTenTrongCau("Hoa\u0301 đang chờ", member("hoa", "Hoa")), []);
});

test("G04", "NFC member matches NFC text", () => {
  assert.deepEqual(khopTenTrongCau("Hoá đang chờ", member("hoa-accent", "Hoá")), [
    { pos: 0, uid: "hoa-accent", len: 3 },
  ]);
});

test("G05", "NFC member matches NFD text with original span length", () => {
  assert.deepEqual(khopTenTrongCau("Hoa\u0301 đang chờ", member("hoa-accent", "Hoá")), [
    { pos: 0, uid: "hoa-accent", len: 4 },
  ]);
});

test("G06", "NFD text before a later target preserves original offset", () => {
  assert.deepEqual(khopTenTrongCau("Hoa\u0301 học cùng Hoa", member("hoa", "Hoa")), [
    { pos: 14, uid: "hoa", len: 3 },
  ]);
});

test("G07", "@ is inserted immediately before the later original target", () => {
  const original = "Hoa\u0301 học cùng Hoa";
  const built = chenDauA(original, khopTenTrongCau(original, member("hoa", "Hoa")));
  assert.equal(built.text, "Hoa\u0301 học cùng @Hoa");
  assert.deepEqual(built.mentions, [{ pos: 14, uid: "hoa", len: 4 }]);
  assert.equal(
    built.text.slice(built.mentions[0].pos, built.mentions[0].pos + built.mentions[0].len),
    "@Hoa"
  );
});

test("G08", "decomposed target keeps its combining mark inside the mention", () => {
  const original = "Hoa\u0301";
  const built = chenDauA(
    original,
    khopTenTrongCau(original, member("hoa-accent", "Hoá"))
  );
  assert.equal(built.text, "@Hoa\u0301");
  assert.deepEqual(built.mentions, [{ pos: 0, uid: "hoa-accent", len: 5 }]);
  assert.equal(
    built.text.slice(built.mentions[0].pos, built.mentions[0].pos + built.mentions[0].len),
    "@Hoa\u0301"
  );
});

let passed = 0;
for (const { code, description, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${code} — ${description}`);
  } catch (error) {
    console.error(`FAIL ${code} — ${description}`);
    console.error(error.stack || error);
  }
}

const failed = tests.length - passed;
console.log(`STAB-07B focused: ${passed}/${tests.length} PASS; ${failed} FAIL`);
if (failed) process.exitCode = 1;
