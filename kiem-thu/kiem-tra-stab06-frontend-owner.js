/**
 * STAB-06 Lane 3: frontend owner-generation invalidation and stale completions.
 * Provider/network/account-free: real browser modules run against JSDOM, deferred
 * fetch responses, a stub socket, and controlled timers.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error });
    console.log(`FAIL ${name}\n  ${error.stack || error.message}`);
  }
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(data),
  };
}

function deferredResponse() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return {
    promise,
    release(data, status = 200) { settle(jsonResponse(data, status)); },
  };
}

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const html = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://zalo-web.test/" });
const { window } = dom;
const { document } = window;
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.setPointerCapture = () => {};

Object.assign(globalThis, {
  window,
  document,
  localStorage: window.localStorage,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  FormData: window.FormData,
  File: window.File,
  Option: window.Option,
  Image: window.Image,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: (callback) => { callback(); return 1; },
  cancelAnimationFrame: () => {},
  confirm: () => true,
  alert: () => {},
});
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
window.confirm = globalThis.confirm;
window.alert = globalThis.alert;
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => "blob:fixture";
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};

let timerSequence = 0;
const fakeTimers = new Map();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
function fakeSetTimeout(callback, delay = 0) {
  const id = ++timerSequence;
  fakeTimers.set(id, { callback, delay, active: true });
  return id;
}
function fakeClearTimeout(id) {
  const timer = fakeTimers.get(id);
  if (timer) timer.active = false;
}
function clearFixtureTimers() {
  for (const timer of fakeTimers.values()) timer.active = false;
}
async function fireTimer(id, { evenIfCleared = false } = {}) {
  const timer = fakeTimers.get(id);
  assert.ok(timer, `Timer ${id} does not exist`);
  if (!timer.active && !evenIfCleared) return false;
  timer.active = false;
  timer.callback();
  await flush();
  return true;
}
function newestTimer() {
  return [...fakeTimers.keys()].at(-1);
}
globalThis.setTimeout = fakeSetTimeout;
globalThis.clearTimeout = fakeClearTimeout;
window.setTimeout = fakeSetTimeout;
window.clearTimeout = fakeClearTimeout;

const socketHandlers = new Map();
globalThis.io = () => ({
  on(event, handler) { socketHandlers.set(event, handler); },
});
window.io = globalThis.io;

const queuedFetches = new Map();
const fetchCalls = [];
let browserOwner = "BOOT";

function routeKey(url, method = "GET") {
  return `${String(method).toUpperCase()} ${String(url)}`;
}

function enqueue(url, responseOrPromise, method = "GET") {
  const key = routeKey(url, method);
  const queue = queuedFetches.get(key) || [];
  queue.push(responseOrPromise);
  queuedFetches.set(key, queue);
}

function defaultPayload(url, method) {
  if (url === "/api/bootstrap") return {
    loggedIn: true,
    loggingIn: false,
    uid: browserOwner,
    displayName: browserOwner,
    threads: [],
    qr: {},
    ketNoi: { trangThai: "da", lyDo: "" },
    user: { username: "fixture" },
    admins: [],
  };
  if (url === "/api/onboarding") return { step: 0, started: false, completed: true, data: {} };
  if (url === "/api/bot/status") return { enabled: false, ready: false };
  if (url === "/api/auto-reply") return [];
  if (url === "/api/lich-hen") return { lich: [] };
  if (url === "/api/customer-memory") return { customers: [] };
  if (url.startsWith("/api/logs")) return { logs: [] };
  if (url === "/api/knowledge") return { files: [] };
  if (url === "/api/zalo/groups") return { groups: [] };
  if (url === "/api/ai-chat/providers") return {
    providers: [{ id: "openai", name: "OpenAI", connected: true, models: [{ id: "openai/gpt-4.1", label: "GPT-4.1" }] }],
  };
  if (url === "/api/ai-chat/opencode-test") return {
    agents: ["general"],
    providers: [{ id: "openai", name: "OpenAI", connected: true, models: [{ id: "openai/gpt-4.1", label: "GPT-4.1" }] }],
    systemDefaultModel: "",
  };
  if (url === "/api/ai-chat/provider-key") return { ok: true };
  if (url === "/api/ai-chat" && method === "GET") return {
    config: { opencodeBaseUrl: "http://opencode:4096", opencodeAgent: "general", opencodeModel: "openai/gpt-4.1" },
    ready: true,
  };
  if (url === "/api/auth/me") return { user: { username: "fixture" } };
  if (url === "/api/auth/otp-settings") return { enabled: false, email: "", adminZaloUid: "", smtpConfigured: false };
  if (url === "/api/training") return { model: "openai/gpt-4.1", messages: [], files: [], sessionId: null };
  if (url.startsWith("/api/messages/")) return { messages: [] };
  if (method === "DELETE" || method === "POST" || method === "PUT") return { ok: true };
  return {};
}

async function fetchFixture(input, options = {}) {
  const url = String(input);
  const method = String(options.method || "GET").toUpperCase();
  fetchCalls.push({ url, method, owner: browserOwner });
  const key = routeKey(url, method);
  const queue = queuedFetches.get(key);
  if (queue?.length) {
    const next = queue.shift();
    return await next;
  }
  return jsonResponse(defaultPayload(url, method));
}
globalThis.fetch = fetchFixture;
window.fetch = fetchFixture;

await import(`${pathToFileURL(path.join(REPO, "public", "app.js")).href}?stab06-l3`);
await flush(14);
clearFixtureTimers();

const configModule = await import(pathToFileURL(path.join(REPO, "public", "config.js")).href);
const onboardingModule = await import(pathToFileURL(path.join(REPO, "public", "onboarding.js")).href);

function emitOwner(uid) {
  browserOwner = uid;
  const handler = socketHandlers.get("state");
  assert.equal(typeof handler, "function");
  handler({
    loggedIn: true,
    loggingIn: false,
    uid,
    displayName: uid,
    qr: {},
    ketNoi: { trangThai: "da", lyDo: "" },
  });
}

function emitThreads(ids) {
  socketHandlers.get("threads")(ids.map((id) => ({ id, title: id, threadType: 0 })));
}

function clickThread(id) {
  const item = [...document.querySelectorAll(".thread-item")].find((node) => node.textContent.includes(id));
  assert.ok(item, `Thread ${id} is not rendered`);
  item.click();
}

function message(id, content) {
  return { id, content, timestamp: Date.now(), isSelf: false };
}

function schedule(label) {
  return { id: label, lucGui: 1_800_000_000, trangThai: "cho", loai: "nick", dichTen: label, noiDung: `noi-dung-${label}` };
}

function customer(label) {
  return { uid: label, displayName: label, profile: `profile-${label}`, locked: false, updatedAt: 1_800_000_000, turns: 6 };
}

function logEntry(label) {
  return { id: label, event: label, summary: `summary-${label}`, level: "info", createdAt: 1_800_000_000 };
}

function setZaloPanel() {
  document.querySelectorAll(".module-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== "module-zalo"));
}

await test("T1 - Thread normal load", async () => {
  emitOwner("T1-A");
  await flush();
  emitThreads(["T1-X"]);
  enqueue("/api/messages/T1-X", Promise.resolve(jsonResponse({ messages: [message("m1", "T1-A-normal")] })));
  clickThread("T1-X");
  await flush();
  assert.match(document.querySelector("#messages").textContent, /T1-A-normal/);
});

await test("T2 - Thread A response after B is discarded", async () => {
  const stale = deferredResponse();
  emitOwner("T2-A");
  await flush();
  emitThreads(["T2-X"]);
  enqueue("/api/messages/T2-X", stale.promise);
  clickThread("T2-X");
  emitOwner("T2-B");
  emitThreads(["T2-B-Y"]);
  enqueue("/api/messages/T2-B-Y", Promise.resolve(jsonResponse({ messages: [message("m2b", "T2-B-current")] })));
  clickThread("T2-B-Y");
  await flush();
  stale.release({ messages: [message("m2a", "T2-A-stale")] });
  await flush();
  assert.match(document.querySelector("#messages").textContent, /T2-B-current/);
  assert.doesNotMatch(document.querySelector("#messages").textContent, /T2-A-stale/);
});

await test("T3 - Thread A1 response stays stale after A2", async () => {
  const stale = deferredResponse();
  emitOwner("T3-A");
  await flush();
  emitThreads(["T3-X"]);
  enqueue("/api/messages/T3-X", stale.promise);
  clickThread("T3-X");
  emitOwner("T3-B");
  emitOwner("T3-A");
  emitThreads(["T3-X"]);
  stale.release({ messages: [message("m3a1", "T3-A1-stale")] });
  await flush();
  enqueue("/api/messages/T3-X", Promise.resolve(jsonResponse({ messages: [message("m3a2", "T3-A2-current")] })));
  clickThread("T3-X");
  await flush();
  assert.match(document.querySelector("#messages").textContent, /T3-A2-current/);
  assert.doesNotMatch(document.querySelector("#messages").textContent, /T3-A1-stale/);
});

await test("T4 - Same thread ID collision cannot reuse A messages in B", async () => {
  const stale = deferredResponse();
  emitOwner("T4-A");
  await flush();
  emitThreads(["T4-X"]);
  enqueue("/api/messages/T4-X", stale.promise);
  clickThread("T4-X");
  emitOwner("T4-B");
  emitThreads(["T4-X"]);
  enqueue("/api/messages/T4-X", Promise.resolve(jsonResponse({ messages: [message("m4b", "T4-B-current")] })));
  clickThread("T4-X");
  await flush();
  stale.release({ messages: [message("m4a", "T4-A-stale-collision")] });
  await flush();
  assert.match(document.querySelector("#messages").textContent, /T4-B-current/);
  assert.doesNotMatch(document.querySelector("#messages").textContent, /T4-A-stale-collision/);
});

await test("T5 - Settings owner DOM invalidates immediately without false empty state", async () => {
  emitOwner("T5-A");
  await flush();
  enqueue("/api/lich-hen", Promise.resolve(jsonResponse({ lich: [schedule("T5-A-schedule")] })));
  enqueue("/api/customer-memory", Promise.resolve(jsonResponse({ customers: [customer("T5-A-customer")] })));
  enqueue("/api/logs?limit=150", Promise.resolve(jsonResponse({ logs: [logEntry("T5-A-log")] })));
  document.querySelector("#lh-reload").click();
  document.querySelector("#cm-reload").click();
  document.querySelector("#log-refresh").click();
  await flush();
  assert.match(document.querySelector("#lh-list").textContent, /T5-A-schedule/);
  assert.match(document.querySelector("#cm-list").textContent, /T5-A-customer/);
  assert.match(document.querySelector("#log-list").textContent, /T5-A-log/);

  const bSchedule = deferredResponse();
  const bCustomers = deferredResponse();
  const bLogs = deferredResponse();
  const bBot = deferredResponse();
  enqueue("/api/lich-hen", bSchedule.promise);
  enqueue("/api/customer-memory", bCustomers.promise);
  enqueue("/api/logs?limit=150", bLogs.promise);
  enqueue("/api/bot/status", bBot.promise);
  document.querySelector("#settings-modal").classList.remove("hidden");
  emitOwner("T5-B");
  assert.equal(document.querySelector("#lh-list").textContent, "");
  assert.equal(document.querySelector("#cm-list").textContent, "");
  assert.equal(document.querySelector("#log-list").textContent, "");
  assert.doesNotMatch(document.querySelector("#log-list").textContent, /Chưa có log nào|Không thể tải/);
  assert.match(document.querySelector("#bot-hint").textContent, /chưa cấu hình xong/);
  bSchedule.release({ lich: [] });
  bCustomers.release({ customers: [] });
  bLogs.release({ logs: [] });
  bBot.release({ enabled: false, ready: true });
  await flush();
  document.querySelector("#settings-modal").classList.add("hidden");
});

await test("T6 - Settings stale schedule response cannot overwrite B", async () => {
  const stale = deferredResponse();
  emitOwner("T6-A");
  await flush();
  enqueue("/api/lich-hen", stale.promise);
  document.querySelector("#lh-reload").click();
  emitOwner("T6-B");
  enqueue("/api/lich-hen", Promise.resolve(jsonResponse({ lich: [schedule("T6-B-schedule")] })));
  document.querySelector("#lh-reload").click();
  await flush();
  stale.release({ lich: [schedule("T6-A-stale")] });
  await flush();
  assert.match(document.querySelector("#lh-list").textContent, /T6-B-schedule/);
  assert.doesNotMatch(document.querySelector("#lh-list").textContent, /T6-A-stale/);
});

await test("T7 - Settings stale customer response cannot overwrite B", async () => {
  const stale = deferredResponse();
  emitOwner("T7-A");
  await flush();
  enqueue("/api/customer-memory", stale.promise);
  document.querySelector("#cm-reload").click();
  emitOwner("T7-B");
  enqueue("/api/customer-memory", Promise.resolve(jsonResponse({ customers: [customer("T7-B-customer")] })));
  document.querySelector("#cm-reload").click();
  await flush();
  stale.release({ customers: [customer("T7-A-stale")] });
  await flush();
  assert.match(document.querySelector("#cm-list").textContent, /T7-B-customer/);
  assert.doesNotMatch(document.querySelector("#cm-list").textContent, /T7-A-stale/);
});

await test("T8 - Settings stale log response preserves B and empty/error semantics", async () => {
  const stale = deferredResponse();
  emitOwner("T8-A");
  await flush();
  enqueue("/api/logs?limit=150", stale.promise);
  document.querySelector("#log-refresh").click();
  emitOwner("T8-B");
  enqueue("/api/logs?limit=150", Promise.resolve(jsonResponse({ logs: [logEntry("T8-B-log")] })));
  document.querySelector("#log-refresh").click();
  await flush();
  stale.release({ logs: [logEntry("T8-A-stale")] });
  await flush();
  assert.match(document.querySelector("#log-list").textContent, /T8-B-log/);
  assert.doesNotMatch(document.querySelector("#log-list").textContent, /T8-A-stale/);

  enqueue("/api/logs?limit=150", Promise.resolve(jsonResponse({ logs: [] })));
  document.querySelector("#log-refresh").click();
  await flush();
  assert.match(document.querySelector("#log-list").textContent, /Chưa có log nào/);
  enqueue("/api/logs?limit=150", Promise.resolve(jsonResponse({ error: "fixture" }, 500)));
  document.querySelector("#log-refresh").click();
  await flush();
  assert.match(document.querySelector("#log-list").textContent, /Không thể tải nhật ký hoạt động/);
});

await test("T9 - Settings stale bot-status response cannot overwrite B", async () => {
  const stale = deferredResponse();
  enqueue("/api/bot/status", stale.promise);
  emitOwner("T9-A");
  enqueue("/api/bot/status", Promise.resolve(jsonResponse({ enabled: false, ready: true })));
  emitOwner("T9-B");
  await flush();
  assert.match(document.querySelector("#bot-hint").textContent, /không tự trả lời khách/);
  stale.release({ enabled: true, ready: true });
  await flush();
  assert.equal(document.querySelector("#bot-toggle").getAttribute("aria-checked"), "false");
  assert.match(document.querySelector("#bot-state").textContent, /TẮT/);
});

await test("T10 - Existing guarded AI Settings hydration remains functional", async () => {
  configModule.setSettingsOwnerUid("T10-AI");
  configModule.invalidateSettingsOwnerState();
  enqueue("/api/ai-chat", Promise.resolve(jsonResponse({
    config: {
      opencodeBaseUrl: "http://opencode:4096",
      opencodeAgent: "general",
      opencodeModel: "openai/gpt-4.1",
      soul: "T10-current-owner-soul",
      roleTone: "calm",
      allowedTopics: "support",
    },
    ready: true,
  })));
  assert.equal(await configModule.refreshAiChatConfigForCurrentOwner(), true);
  assert.equal(document.querySelector("#ai-soul").value, "T10-current-owner-soul");
});

await test("T11 - Onboarding stale A GET cannot assign state, render, or navigate B", async () => {
  clearFixtureTimers();
  setZaloPanel();
  const stale = deferredResponse();
  enqueue("/api/onboarding", stale.promise);
  const a = onboardingModule.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "T11-A" });
  enqueue("/api/onboarding", Promise.resolve(jsonResponse({ step: 0, started: false, completed: true, data: {} })));
  await onboardingModule.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "T11-B" });
  stale.release({ step: 5, started: true, completed: false, prompt: "T11-A-stale", data: {} });
  await a;
  const timer = newestTimer();
  if (timer) await fireTimer(timer, { evenIfCleared: true });
  assert.ok(document.querySelector("#module-training").classList.contains("hidden"));
  assert.doesNotMatch(document.querySelector("#training-log").textContent, /T11-A-stale/);
});

await test("T12 - Onboarding current B response preserves first-run behavior", async () => {
  clearFixtureTimers();
  document.querySelector("#first-run-modal").classList.add("hidden");
  enqueue("/api/onboarding", Promise.resolve(jsonResponse({ step: 0, started: false, completed: false, data: {} })));
  await onboardingModule.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "T12-B" });
  await fireTimer(newestTimer());
  assert.ok(!document.querySelector("#first-run-modal").classList.contains("hidden"));
});

await test("T13 - Onboarding A1 GET remains stale after B then A2", async () => {
  clearFixtureTimers();
  setZaloPanel();
  const stale = deferredResponse();
  enqueue("/api/onboarding", stale.promise);
  const a1 = onboardingModule.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "T13-A" });
  enqueue("/api/onboarding", Promise.resolve(jsonResponse({ step: 0, started: false, completed: true, data: {} })));
  await onboardingModule.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "T13-B" });
  enqueue("/api/onboarding", Promise.resolve(jsonResponse({ step: 0, started: false, completed: true, data: {} })));
  await onboardingModule.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "T13-A" });
  stale.release({ step: 6, started: true, completed: false, prompt: "T13-A1-stale", data: {} });
  await a1;
  assert.doesNotMatch(document.querySelector("#training-log").textContent, /T13-A1-stale/);
  assert.ok(document.querySelector("#module-training").classList.contains("hidden"));
});

await test("T14 - Onboarding stale timer cannot navigate B", async () => {
  clearFixtureTimers();
  setZaloPanel();
  enqueue("/api/onboarding", Promise.resolve(jsonResponse({ step: 5, started: true, completed: false, prompt: "", data: {} })));
  await onboardingModule.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "T14-A" });
  const staleTimer = newestTimer();
  enqueue("/api/onboarding", Promise.resolve(jsonResponse({ step: 0, started: false, completed: true, data: {} })));
  await onboardingModule.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "T14-B" });
  await fireTimer(staleTimer, { evenIfCleared: true });
  assert.ok(document.querySelector("#module-training").classList.contains("hidden"));
});

await test("T15 - Onboarding current-generation timer preserves navigation", async () => {
  clearFixtureTimers();
  setZaloPanel();
  enqueue("/api/onboarding", Promise.resolve(jsonResponse({ step: 5, started: true, completed: false, prompt: "", data: {} })));
  await onboardingModule.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "T15-A" });
  await fireTimer(newestTimer());
  assert.ok(!document.querySelector("#module-training").classList.contains("hidden"));
});

let socketOwnerProvenanceAvailable = "NO";
await test("T16 - Socket thread/message provenance is classified, not fabricated", async () => {
  const appSource = fs.readFileSync(path.join(REPO, "public", "app.js"), "utf8");
  const backendSource = fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8");
  const socketSection = appSource.slice(appSource.indexOf('socket.on("threads"'), appSource.indexOf("bootstrap();"));
  assert.ok(socketSection.includes('socket.on("new-message"'));
  assert.ok(!socketSection.includes("ownerGeneration"));
  assert.ok(!socketSection.includes("ownerUid"));
  assert.match(backendSource, /emit\("new-message",\s*broadcast\)/);
  assert.match(backendSource, /emit\("thread-refresh",\s*thread\)/);
  socketOwnerProvenanceAvailable = "NO";
});

await test("T17 - Training production file is untouched by Lane 3", async () => {
  const source = fs.readFileSync(path.join(REPO, "public", "training.js"));
  const hash = crypto.createHash("sha256").update(source).digest("hex").toUpperCase();
  assert.equal(hash, "41810A082DB1CB86AAA23F4892CA528CF1C99AE2C44A3FCEE3E3FF9246241753");
});

await test("T18 - Legitimate global frontend catalog and visual state survive owner change", async () => {
  const provider = document.querySelector("#ai-oc-provider");
  const optionsBefore = [...provider.options].map((option) => `${option.value}:${option.textContent}`);
  assert.ok(optionsBefore.length > 1);
  localStorage.setItem("zalo-web:sidebar-width", "333");
  emitOwner("T18-B");
  const optionsAfter = [...provider.options].map((option) => `${option.value}:${option.textContent}`);
  assert.deepEqual(optionsAfter, optionsBefore);
  assert.equal(localStorage.getItem("zalo-web:sidebar-width"), "333");
});

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;

const failed = results.filter((item) => !item.pass);
console.log(`\nSOCKET_OWNER_PROVENANCE_AVAILABLE = ${socketOwnerProvenanceAvailable}`);
console.log("SOCKET_STALE_EVENT_GUARD_IMPLEMENTED = NOT_APPLICABLE");
console.log("UNRESOLVED_SOCKET_CONDITION = DEFERRED_IF_NO_PROVENANCE");
console.log(`STAB06_L3_RESULT: ${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL`);
if (failed.length) process.exitCode = 1;
