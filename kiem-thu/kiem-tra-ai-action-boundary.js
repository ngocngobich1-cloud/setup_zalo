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

test("T1", "Lưu key là owner-scoped action độc lập", () => {
  assert.ok(config.includes('<button type="button" id="btn-key-save"'));
  const handler = handlerBetween(
    'btnKeySave.addEventListener("click"',
    'btnKeyTest.addEventListener("click"'
  );
  assert.ok(handler.includes('fetch("/api/ai-chat/owner-credentials", {'));
  assert.ok(handler.includes("providerId"));
  assert.ok(handler.includes("apiKey:"));
  assert.ok(!handler.includes("opencodeModel"));
  assert.ok(!handler.includes("soulInput"));
  assert.ok(!handler.includes("requestSubmit"));
});

test("T2", "Thử key chỉ dùng credential đã lưu", () => {
  assert.ok(config.includes('<button type="button" id="btn-key-test"'));
  const handler = handlerBetween(
    'btnKeyTest.addEventListener("click"',
    'btnKeyDelete.addEventListener("click"'
  );
  assert.ok(handler.includes('fetch("/api/ai-chat/owner-credentials/test", {'));
  assert.ok(handler.includes("ownerKeyStatus.has"));
  assert.ok(!handler.includes("apiKey:"));
  assert.ok(!handler.includes("requestSubmit"));
});

test("T3", "Delete selected và delete-all tách owner-scoped", () => {
  assert.ok(config.includes('<button type="button" id="btn-key-delete"'));
  assert.ok(config.includes('<button type="button" id="btn-key-clear"'));
  const selected = handlerBetween(
    'btnKeyDelete.addEventListener("click"',
    'btnKeyClear.addEventListener("click"'
  );
  const all = handlerBetween(
    'btnKeyClear.addEventListener("click"',
    "const refreshAfterCredentialChange"
  );
  assert.ok(selected.includes("/api/ai-chat/owner-credentials/${encodeURIComponent(providerId)}"));
  assert.ok(selected.includes('method: "DELETE"'));
  assert.ok(all.includes('fetch("/api/ai-chat/owner-credentials", { method: "DELETE" })'));
  assert.ok(!selected.includes("requestSubmit"));
  assert.ok(!all.includes("requestSubmit"));
  const credentialStart = server.indexOf('app.get("/api/ai-chat/owner-credentials"');
  const credentialEnd = server.indexOf("/* --- ZOHO MAIL --- */", credentialStart);
  const serverCredentialRoutes = server.slice(credentialStart, credentialEnd);
  assert.ok(server.includes('app.delete("/api/ai-chat/owner-credentials/:providerId"'));
  assert.ok(server.includes('app.delete("/api/ai-chat/owner-credentials"'));
  assert.ok(!serverCredentialRoutes.includes("saveAiChatConfig"));
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
  assert.ok(branch.includes("saveAiChatConfig"));
  assert.ok(branch.includes("opencodeModel"));
  assert.ok(branch.includes("opencodeFallbackModel"));
  assert.ok(!branch.includes("saveCurrentOwnerCredential"));
  assert.ok(!branch.includes("deleteCurrentOwnerCredential"));
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
