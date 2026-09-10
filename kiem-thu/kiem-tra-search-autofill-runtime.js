/**
 * SEARCH AUTOFILL RUNTIME V2.
 * Runs the real public/app.js module in jsdom; only browser/server I/O is mocked.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const htmlSource = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(REPO, "public", "app.js"), "utf8");
const results = [];

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

registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url.includes("/public/app.js?search-autofill-runtime")) {
      return {
        ...loaded,
        source: loaded.source +
          "\nexport { state, renderThreads, clearThreadSearch, invalidateOwnerFrontendState, moBangChuyenTiep, veDanhSachChuyenTiep, applyState };",
      };
    }
    return loaded;
  },
});

const dom = new JSDOM(htmlSource, { url: "http://zalo-web.test/", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
window.matchMedia = (query) => ({
  matches: query === "(max-width: 760px)",
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.setPointerCapture = () => {};
window.requestAnimationFrame = (callback) => { callback(); return 1; };
window.cancelAnimationFrame = () => {};
window.confirm = () => true;
window.alert = () => {};
Object.assign(globalThis, {
  window,
  document,
  history: window.history,
  localStorage: window.localStorage,
  CustomEvent: window.CustomEvent,
  Event: window.Event,
  InputEvent: window.InputEvent,
  PopStateEvent: window.PopStateEvent,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  FormData: window.FormData,
  File: window.File,
  Option: window.Option,
  Image: window.Image,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame,
  cancelAnimationFrame: window.cancelAnimationFrame,
  confirm: window.confirm,
  alert: window.alert,
});
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => "blob:fixture";
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};

const socketHandlers = new Map();
globalThis.io = () => ({
  on(event, handler) {
    const previous = socketHandlers.get(event);
    socketHandlers.set(event, (...args) => { previous?.(...args); handler(...args); });
  },
});
window.io = globalThis.io;

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) };
}

function defaultPayload(url, method) {
  if (url === "/api/bootstrap") return {
    loggedIn: true,
    uid: "owner-runtime",
    displayName: "Runtime fixture",
    threads: [],
    qr: {},
    ketNoi: { trangThai: "song", lyDo: "" },
    user: { username: "account@example.com" },
    admins: [],
  };
  if (url === "/api/onboarding") return { step: 0, started: false, completed: true, data: {} };
  if (url === "/api/bot/status") return { enabled: false, ready: true };
  if (url === "/api/auto-reply") return [];
  if (url === "/api/lich-hen") return { lich: [] };
  if (url === "/api/customer-memory") return { customers: [] };
  if (url.startsWith("/api/logs")) return { logs: [] };
  if (url === "/api/knowledge") return { files: [] };
  if (url === "/api/zalo/groups") return { groups: [] };
  if (url === "/api/ai-chat/providers") return { providers: [] };
  if (url === "/api/ai-chat/opencode-test") return { agents: [], providers: [], systemDefaultModel: "" };
  if (url === "/api/ai-chat") return { config: {}, ready: false };
  if (url === "/api/auth/me") return { user: { username: "account@example.com" } };
  if (url === "/api/auth/otp-settings") return { enabled: false, email: "", adminZaloUid: "", smtpConfigured: false };
  if (url === "/api/training") return { model: "", messages: [], files: [], sessionId: null };
  if (url.startsWith("/api/messages/")) return { messages: [] };
  if (["POST", "PUT", "DELETE"].includes(method)) return { ok: true };
  return {};
}

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const method = String(options.method || "GET").toUpperCase();
  return jsonResponse(defaultPayload(url, method));
};
window.fetch = globalThis.fetch;

const app = await import(`${pathToFileURL(path.join(REPO, "public", "app.js")).href}?search-autofill-runtime`);
for (let index = 0; index < 14; index += 1) await new Promise((resolve) => setImmediate(resolve));

const threadSearch = document.querySelector("#thread-search");
const forwardSearch = document.querySelector("#forward-search");
const threads = [
  { id: "thread-email", title: "Customer customer@example.com", lastMessage: "Email customer@example.com", lastMessageAt: 2 },
  { id: "thread-normal", title: "Anh Xuan", lastMessage: "Nội dung bình thường", lastMessageAt: 1 },
];

function resetSearchFixture() {
  app.state.threads = structuredClone(threads);
  app.clearThreadSearch();
  threadSearch.blur();
}

function userReplaceSearch(value) {
  threadSearch.dispatchEvent(new window.InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    data: value,
    inputType: "insertText",
  }));
  threadSearch.value = value;
  threadSearch.dispatchEvent(new window.InputEvent("input", {
    bubbles: true,
    data: value,
    inputType: "insertText",
  }));
}

function visibleThreadTitles() {
  return [...document.querySelectorAll("#threads .thread-title")].map((element) => element.textContent);
}

await test("S1", "app code does not copy account/login email into thread search", () => {
  assert.equal(app.state.threadSearchQuery, "");
  assert.equal(threadSearch.value, "");
  assert.doesNotMatch(appSource, /els\.search\.value\s*=\s*(?:username|data\.user|state\.displayName)/);
});

await test("S2", "both search inputs have dedicated form owners", () => {
  assert.equal(threadSearch.form?.id, "thread-search-form");
  assert.equal(forwardSearch.form?.id, "forward-search-form");
  assert.notEqual(threadSearch.form, forwardSearch.form);
});

await test("S3", "training password input shares neither search form", () => {
  const trainingKey = document.querySelector("#training-key-value");
  assert.notEqual(trainingKey.form, threadSearch.form);
  assert.notEqual(trainingKey.form, forwardSearch.form);
});

await test("S4", "silent DOM autofill does not change canonical query", () => {
  resetSearchFixture();
  threadSearch.value = "account@example.com";
  threadSearch.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
  threadSearch.dispatchEvent(new window.Event("change", { bubbles: true }));
  app.renderThreads();
  assert.equal(app.state.threadSearchQuery, "");
  assert.equal(threadSearch.value, "");
  assert.equal(document.querySelectorAll("#threads .thread-item").length, threads.length);
});

await test("S5", "silent autofill followed by render keeps the full thread list", () => {
  resetSearchFixture();
  threadSearch.value = "account@example.com";
  app.renderThreads();
  assert.deepEqual(visibleThreadTitles(), ["Customer customer@example.com", "Anh Xuan"]);
});

await test("S6", "normal user text search works", () => {
  resetSearchFixture();
  threadSearch.focus();
  userReplaceSearch("Xuan");
  assert.equal(app.state.threadSearchQuery, "Xuan");
  assert.deepEqual(visibleThreadTitles(), ["Anh Xuan"]);
});

await test("S7", "user email-shaped search finds the exact fixture", () => {
  resetSearchFixture();
  threadSearch.focus();
  userReplaceSearch("customer@example.com");
  assert.equal(app.state.threadSearchQuery, "customer@example.com");
  assert.deepEqual(visibleThreadTitles(), ["Customer customer@example.com"]);
});

await test("S8", "explicit clear restores the full list", () => {
  resetSearchFixture();
  threadSearch.focus();
  userReplaceSearch("Xuan");
  app.clearThreadSearch();
  assert.equal(app.state.threadSearchQuery, "");
  assert.equal(threadSearch.value, "");
  assert.equal(document.querySelectorAll("#threads .thread-item").length, threads.length);
});

await test("S9", "socket reconnect preserves canonical query", () => {
  resetSearchFixture();
  threadSearch.focus();
  userReplaceSearch("Xuan");
  socketHandlers.get("connect")?.();
  assert.equal(app.state.threadSearchQuery, "Xuan");
});

await test("S10", "thread/history refreshes preserve canonical query", () => {
  resetSearchFixture();
  threadSearch.focus();
  userReplaceSearch("customer@example.com");
  socketHandlers.get("thread-refresh")?.({ ...threads[0], lastMessage: "updated" });
  app.state.historyByThread.set(threads[0].id, {
    status: "loading",
    syncPending: true,
    refreshRequested: false,
    inflight: null,
    syncRetryTimer: null,
    refreshTimer: null,
  });
  socketHandlers.get("thread-history-updated")?.({
    ownerUid: app.state.uid,
    threadId: threads[0].id,
    reason: "enrichment_updated",
  });
  assert.equal(app.state.threadSearchQuery, "customer@example.com");
  assert.equal(app.state.historyByThread.get(threads[0].id).refreshRequested, true);
});

await test("S11", "first user character after silent autofill has no poisoned prefix", () => {
  resetSearchFixture();
  threadSearch.value = "account@example.com";
  threadSearch.focus();
  assert.equal(threadSearch.value, "");
  userReplaceSearch("x");
  assert.equal(app.state.threadSearchQuery, "x");
  assert.equal(threadSearch.value, "x");
});

await test("S12", "owner invalidation clears canonical and visible search", () => {
  resetSearchFixture();
  threadSearch.focus();
  userReplaceSearch("customer@example.com");
  app.invalidateOwnerFrontendState("next-owner");
  assert.equal(app.state.threadSearchQuery, "");
  assert.equal(threadSearch.value, "");
});

await test("S13", "forward search filtering and reset remain functional", () => {
  app.state.threads = structuredClone(threads);
  app.moBangChuyenTiep({ id: "message-to-forward" });
  assert.equal(forwardSearch.value, "");
  forwardSearch.value = "Xuan";
  forwardSearch.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  const choices = [...document.querySelectorAll("#forward-list .forward-item")]
    .map((element) => element.textContent);
  assert.deepEqual(choices, ["Anh Xuan"]);
});

await test("S14", "search forms prevent submit without a reload workaround", () => {
  for (const form of [threadSearch.form, forwardSearch.form]) {
    const event = new window.Event("submit", { bubbles: true, cancelable: true });
    assert.equal(form.dispatchEvent(event), false);
    assert.equal(event.defaultPrevented, true);
  }
  assert.doesNotMatch(appSource, /(?:window\.)?location\.reload\s*\(|history\.go\s*\(\s*0\s*\)|location\.href\s*=\s*location\.href/);
});

await test("S15", "native clear works when input fires before search", () => {
  resetSearchFixture();
  threadSearch.focus();
  userReplaceSearch("Xuan");
  threadSearch.value = "";
  threadSearch.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  threadSearch.dispatchEvent(new window.Event("search", { bubbles: true }));
  assert.equal(app.state.threadSearchQuery, "");
  assert.equal(threadSearch.value, "");
  assert.equal(document.querySelectorAll("#threads .thread-item").length, threads.length);
});

await test("S16", "native clear works when search fires before input", () => {
  resetSearchFixture();
  threadSearch.focus();
  userReplaceSearch("customer@example.com");
  threadSearch.value = "";
  threadSearch.dispatchEvent(new window.Event("search", { bubbles: true }));
  threadSearch.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  assert.equal(app.state.threadSearchQuery, "");
  assert.equal(threadSearch.value, "");
  assert.equal(document.querySelectorAll("#threads .thread-item").length, threads.length);
});

const failed = results.filter((result) => !result.pass);
console.log(`\nSEARCH AUTOFILL RUNTIME: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) process.exitCode = 1;
