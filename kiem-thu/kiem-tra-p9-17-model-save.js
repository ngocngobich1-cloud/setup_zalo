/**
 * P9.17 focused regression: chay nguyen van callback Save Model lay tu
 * public/config.js voi response fixture local. Khong goi backend/provider that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
const match = source.match(
  /panel\.querySelector\("#btn-ai-model-save"\)\.addEventListener\("click",\s*(async \(\) => \{[\s\S]*?\n\s*\})\);\s*\n\s*useKnowledge\.addEventListener/
);
assert.ok(match, "Khong trich duoc production model-save handler");
const handlerSource = match[1];
const results = [];

async function test(code, description, run) {
  try {
    await run();
    results.push({ code, description, pass: true });
  } catch (error) {
    results.push({ code, description, pass: false, error: error.message });
  }
}

const response = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

function createFixture(fetchImpl, {
  provider = "opencode",
  model = "opencode/nemotron-3-ultra-free",
  baseUrl = "http://opencode:4096",
  agent = "general",
} = {}) {
  const events = [];
  const requests = [];
  const context = vm.createContext({
    settingsOwnerGeneration: 1,
    ocProvider: { value: provider },
    ocModel: { value: model },
    ocUrl: { value: baseUrl },
    ocAgent: { value: agent },
    statusText: { textContent: "" },
    fetch: async (url, options = {}) => {
      const request = {
        url,
        method: options.method || "GET",
        body: typeof options.body === "string" ? JSON.parse(options.body) : null,
      };
      requests.push(request);
      return fetchImpl(url, options, request);
    },
    console: { error() {} },
    window: { dispatchEvent: (event) => events.push(event) },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  });
  const handler = vm.runInContext(`(${handlerSource})`, context);
  return { context, events, requests, handler };
}

await test("P9.17-T1", "normal save hoan tat khong ReferenceError", async () => {
  const fixture = createFixture(async () => response(200, {
    ok: true,
    config: { opencodeModel: "opencode/nemotron-3-ultra-free" },
    ready: true,
  }));
  await fixture.handler();
  assert.equal(fixture.context.statusText.textContent, "Đã lưu Hãng AI và Model.");
  assert.equal(fixture.events.length, 1);
});

await test("P9.17-T2", "backend error di qua existing error handling", async () => {
  const fixture = createFixture(async () => response(400, { error: "fixture backend rejection" }));
  await fixture.handler();
  assert.equal(fixture.context.statusText.textContent, "fixture backend rejection");
  assert.equal(fixture.events.length, 0);
});

await test("P9.17-T3", "UID switch bo stale response UI continuation", async () => {
  let release;
  const fixture = createFixture(() => new Promise((resolve) => { release = resolve; }));
  const pending = fixture.handler();
  assert.equal(typeof release, "function");
  fixture.context.settingsOwnerGeneration = 2;
  fixture.context.statusText.textContent = "owner B status";
  release(response(200, {
    ok: true,
    config: { opencodeModel: "opencode/nemotron-3-ultra-free" },
    ready: true,
  }));
  await pending;
  assert.equal(fixture.context.statusText.textContent, "owner B status");
  assert.equal(fixture.events.length, 0);
});

await test("P9.17-T4", "khong con undeclared generation reference", async () => {
  assert.equal((handlerSource.match(/\bgeneration\b/g) || []).length, 0);
});

await test("P9.17-T5", "capture một snapshot và guard sau save POST", async () => {
  const captures = handlerSource.match(
    /const\s+[A-Za-z_$][\w$]*\s*=\s*settingsOwnerGeneration\s*;/g
  ) || [];
  const guards = handlerSource.match(
    /if\s*\(\s*[A-Za-z_$][\w$]*\s*!==\s*settingsOwnerGeneration\s*\)/g
  ) || [];
  assert.equal(captures.length, 1);
  assert.equal(guards.length, 1);
});

const failed = results.filter((item) => !item.pass);
for (const item of results) {
  console.log(`${item.code} = ${item.pass ? "PASS" : "FAIL"}  ${item.description}${item.error ? `\n      -> ${item.error}` : ""}`);
}
console.log(`\nTONG: ${results.length - failed.length}/${results.length} PASS`);
console.log("REAL_PROVIDER_CALL = 0");
process.exit(failed.length ? 1 : 0);
