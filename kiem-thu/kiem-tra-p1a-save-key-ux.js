/**
 * P1a F4 focused regression: chay nguyen callback Save API key trich tu
 * public/config.js bang node:vm. Backend va hai refresh deu la fixture local.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
const match = source.match(
  /btnKeySave\.addEventListener\("click",\s*(async \(\) => \{[\s\S]*?\n\s*\})\);\s*\n\s*btnKeyTest\.addEventListener/
);
assert.ok(match, "Khong trich duoc production btnKeySave handler");
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const response = (status, data) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

function createFixture({
  save = Promise.resolve(response(200, { ok: true, updatedAt: 123 })),
  providerRefresh = () => Promise.resolve(),
  agentModelRefresh = () => Promise.resolve(),
} = {}) {
  const observations = {
    events: [],
    requests: [],
    errors: [],
    status: { text: "", color: "" },
  };
  let context;
  context = vm.createContext({
    keyProvider: { value: "provider-x" },
    keyValue: { value: "fixture-secret" },
    keyBusy: false,
    ownerKeyStatus: new Map(),
    ocProvider: { value: "provider-x" },
    ocModel: { value: "provider-x/chat-model" },
    ocFallbackProvider: { value: "" },
    ocFallbackModel: { value: "" },
    tenHangKey: () => "Provider X",
    baoKey: (text, color) => {
      observations.status = { text, color: color || "" };
      observations.events.push(`status:${text}`);
    },
    updateKeyButtons: () => observations.events.push(`buttons:busy=${context.keyBusy}`),
    napDanhSachHangChoKey: (options) => {
      observations.events.push(`provider-refresh:busy=${context.keyBusy}`);
      observations.providerRefreshOptions = options;
      return providerRefresh(options);
    },
    napAgentVaModel: (...args) => {
      observations.events.push(`agent-model-refresh:busy=${context.keyBusy}`);
      observations.agentModelRefreshArgs = args;
      return agentModelRefresh(...args);
    },
    fetch: async (url, options = {}) => {
      observations.requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });
      return save;
    },
    console: { error: (...args) => observations.errors.push(args) },
    window: {
      dispatchEvent: (event) => observations.events.push(`event:${event.type}`),
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  });
  const handler = vm.runInContext(`(${handlerSource})`, context);
  return { context, handler, observations };
}

await test("P1A-F4-A", "busy duoc nha trong khi post-Save refresh con pending", async () => {
  const pendingProviderRefresh = deferred();
  const fixture = createFixture({
    providerRefresh: () => pendingProviderRefresh.promise,
  });
  const running = fixture.handler();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.context.keyBusy, false);
  assert.equal(fixture.observations.status.text, "Đã lưu API key Provider X thành công");
  assert.ok(fixture.observations.events.includes("provider-refresh:busy=false"));

  pendingProviderRefresh.resolve();
  await running;
  assert.ok(fixture.observations.events.includes("agent-model-refresh:busy=false"));
});

await test("P1A-F4-B", "Save khong kich hoat explicit credential Test", async () => {
  const fixture = createFixture();
  await fixture.handler();
  assert.equal(
    fixture.observations.requests.filter(
      (request) => request.url === "/api/ai-chat/owner-credentials/test"
    ).length,
    0
  );
  assert.equal(fixture.observations.requests[0].url, "/api/ai-chat/owner-credentials");
  assert.equal(fixture.observations.requests[0].method, "POST");
});

await test("P1A-F4-C", "refresh failure khong dao Save success hoac bat lai busy", async () => {
  const fixture = createFixture({
    providerRefresh: () => Promise.reject(new Error("provider refresh fixture failure")),
    agentModelRefresh: () => Promise.reject(new Error("agent refresh fixture failure")),
  });
  await fixture.handler();
  assert.equal(fixture.context.keyBusy, false);
  assert.equal(fixture.observations.status.text, "Đã lưu API key Provider X thành công");
  assert.equal(fixture.observations.errors.length, 2);
});

await test("P1A-F4-D", "ca hai catalog refresh duoc giu sau busy release", async () => {
  const fixture = createFixture();
  await fixture.handler();
  const events = fixture.observations.events;
  const success = events.indexOf("status:Đã lưu API key Provider X thành công");
  const release = events.indexOf("buttons:busy=false");
  const providerRefresh = events.indexOf("provider-refresh:busy=false");
  const agentModelRefresh = events.indexOf("agent-model-refresh:busy=false");
  assert.ok(success >= 0 && success < release);
  assert.ok(release < providerRefresh);
  assert.ok(release < agentModelRefresh);
  assert.equal(fixture.observations.providerRefreshOptions?.preserveStatus, true);
  assert.match(
    source,
    /async function napAgentVaModel[\s\S]*?fetch\("\/api\/ai-chat\/opencode-test"/
  );
});

await test("P1A-F4-E", "Save failure bao loi, nha busy va khong chay success refresh", async () => {
  const fixture = createFixture({
    save: Promise.resolve(response(400, { error: "fixture save rejection" })),
  });
  await fixture.handler();
  assert.equal(fixture.context.keyBusy, false);
  assert.equal(fixture.observations.status.text, "fixture save rejection");
  assert.equal(
    fixture.observations.events.some((event) => event.startsWith("provider-refresh:")),
    false
  );
  assert.equal(
    fixture.observations.events.some((event) => event.startsWith("agent-model-refresh:")),
    false
  );
});

const failed = results.filter((item) => !item.pass);
for (const item of results) {
  console.log(`${item.code} = ${item.pass ? "PASS" : "FAIL"}  ${item.description}${item.error ? `\n      -> ${item.error}` : ""}`);
}
console.log(`\nP1A_F4_VM: ${results.length - failed.length}/${results.length} PASS`);
console.log("REAL_PROVIDER_CALLS = 0");
console.log("REAL_CREDENTIAL_TEST_CALLS = 0");
process.exit(failed.length ? 1 : 0);
