/**
 * P2 source-boundary regression. Provider calls are intentionally not made;
 * browser QA covers actual clicks against deterministic fetch stubs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const config = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const results = [];

function test(code, description, run) {
  try {
    run();
    results.push({ code, description, pass: true });
  } catch (error) {
    results.push({ code, description, pass: false, error: error.message });
  }
}

function handlerBetween(start, end) {
  const from = config.indexOf(start);
  const to = config.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Không tìm thấy handler ${start}`);
  return config.slice(from, to);
}

test("T1", "Lưu key là button độc lập và giữ canonical credential route", () => {
  assert.ok(config.includes('<button type="button" id="btn-key-save"'));
  const handler = handlerBetween(
    'panel.querySelector("#btn-key-save").addEventListener("click"',
    'panel.querySelector("#btn-key-test").addEventListener("click"'
  );
  assert.ok(handler.includes('fetch("/api/ai-chat/provider-key", {'));
  assert.ok(!handler.includes("requestSubmit"));
});

test("T2", "Thử key là button độc lập và giữ canonical test route", () => {
  assert.ok(config.includes('<button type="button" id="btn-key-test"'));
  const handler = handlerBetween(
    'panel.querySelector("#btn-key-test").addEventListener("click"',
    'panel.querySelector("#btn-key-clear").addEventListener("click"'
  );
  assert.ok(handler.includes('fetch("/api/ai-chat/provider-key/test", {'));
  assert.ok(!handler.includes("requestSubmit"));
});

test("T3", "Gỡ key là button độc lập và giữ canonical delete route", () => {
  assert.ok(config.includes('<button type="button" id="btn-key-clear"'));
  const handler = handlerBetween(
    'panel.querySelector("#btn-key-clear").addEventListener("click"',
    'panel.querySelector("#btn-oc-test").addEventListener("click"'
  );
  assert.ok(handler.includes('fetch("/api/ai-chat/provider-key", { method: "DELETE" })'));
  assert.ok(!handler.includes("requestSubmit"));
});

test("T4", "Lưu provider/model có handler riêng trên canonical POST", () => {
  assert.ok(config.includes('<button type="button" id="btn-ai-model-save"'));
  const handler = handlerBetween(
    'panel.querySelector("#btn-ai-model-save").addEventListener("click"',
    'useKnowledge.addEventListener("change"'
  );
  assert.ok(handler.includes('fetch("/api/ai-chat", {'));
  assert.ok(handler.includes('saveScope: "ai-connection"'));
  assert.ok(!handler.includes("soulInput"));
  assert.ok(!handler.includes("topicsInput"));
  assert.ok(!handler.includes("roleInput"));

  const scopedBranch = server.indexOf('req.body?.saveScope === "ai-connection"');
  const soulValidation = server.indexOf('if (!soul) return res.status(400)', scopedBranch);
  assert.ok(scopedBranch >= 0 && soulValidation > scopedBranch);
  const branch = server.slice(scopedBranch, soulValidation);
  assert.ok(branch.includes("getAiChatConfig"));
  assert.ok(branch.includes("saveAiChatConfig"));
  assert.ok(branch.includes("...(current || {})"));
});

test("T5", "Assistant validation và submit riêng vẫn còn", () => {
  assert.ok(config.includes('<textarea id="ai-topics" rows="5"'));
  assert.match(config, /<textarea id="ai-topics"[^>]*required/);
  assert.match(config, /<textarea id="ai-role"[^>]*required/);
  assert.ok(config.includes('<button type="submit" id="btn-ai-assistant-save"'));
  const assistantHandler = handlerBetween(
    'form.addEventListener("submit"',
    "// Nap lai danh sach nhom + nick moi khi mo Cau hinh"
  );
  assert.ok(assistantHandler.includes("soulInput.value.trim()"));
  assert.ok(assistantHandler.includes("topicsInput.value.trim()"));
  assert.ok(assistantHandler.includes("roleInput.value.trim()"));
  assert.ok(!assistantHandler.includes("opencodeBaseUrl"));
  assert.ok(!assistantHandler.includes("opencodeAgent"));
  assert.ok(server.includes('if (!soul) return res.status(400)'));
  assert.ok(server.includes('if (!allowedTopics) return res.status(400)'));
});

const failed = results.filter((item) => !item.pass);
for (const item of results) {
  console.log(`${item.code} = ${item.pass ? "PASS" : "FAIL"}  ${item.description}${item.error ? `\n      -> ${item.error}` : ""}`);
}
console.log(`\nTONG: ${results.length - failed.length}/${results.length} PASS`);
console.log("REAL_PROVIDER_CALL = 0");
process.exit(failed.length ? 1 : 0);
