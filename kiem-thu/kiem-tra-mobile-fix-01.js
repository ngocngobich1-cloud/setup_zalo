/**
 * MOBILE FIX 01 focused contract test.
 * JSDOM has no layout engine, so scrollHeight is controlled below to test only
 * the auto-grow clamp, shrink, overflow and reset logic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const htmlSource = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(REPO, "public", "app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(REPO, "public", "style.css"), "utf8");
const results = [];

async function test(group, name, fn) {
  try {
    await fn();
    results.push({ group, name, pass: true });
    console.log(`PASS ${group} ${name}`);
  } catch (error) {
    results.push({ group, name, pass: false, error });
    console.log(`FAIL ${group} ${name}\n  ${error.stack || error.message}`);
  }
}

function flush(rounds = 8) {
  return Array.from({ length: rounds }).reduce(
    (promise) => promise.then(() => new Promise((resolve) => setImmediate(resolve))),
    Promise.resolve(),
  );
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(data),
  };
}

function deferredResponse() {
  let release;
  const promise = new Promise((resolve) => {
    release = (data, status = 200) => resolve(jsonResponse(data, status));
  });
  return { promise, release };
}

const staticDom = new JSDOM(htmlSource).window.document;
const cssDom = new JSDOM("<!doctype html><style></style>");
cssDom.window.document.querySelector("style").textContent = cssSource;
const topRules = [...cssDom.window.document.styleSheets[0].cssRules];
const desktopRules = topRules.filter((rule) => rule.type === cssDom.window.CSSRule.STYLE_RULE);
const mobileGroups = topRules.filter(
  (rule) => rule.type === cssDom.window.CSSRule.MEDIA_RULE && rule.conditionText === "(max-width: 760px)",
);
const mobileRules = mobileGroups.flatMap((rule) => [...rule.cssRules]);
const rulesFor = (rules, selector) => rules.filter((rule) => rule.selectorText === selector);
const lastRuleFor = (rules, selector) => rulesFor(rules, selector).at(-1);
const ruleWithProperty = (rules, selector, property) => rulesFor(rules, selector)
  .find((rule) => rule.style.getPropertyValue(property));

await test("CSS", "R1/R2 composer canonical box model applies at every width", () => {
  const rule = lastRuleFor(desktopRules, "#message-input");
  assert.ok(rule);
  assert.equal(rule.style.getPropertyValue("width"), "auto");
  assert.equal(rule.style.getPropertyValue("font-size"), "16px");
  assert.equal(rule.style.getPropertyValue("line-height"), "22px");
  assert.equal(rule.style.getPropertyValue("height"), "46px");
  assert.equal(rule.style.getPropertyValue("min-height"), "46px");
  assert.equal(rule.style.getPropertyValue("max-height"), "156px");
  assert.equal(rule.style.getPropertyValue("padding-block"), "11px");
  assert.equal(rule.style.getPropertyValue("overflow-y"), "hidden");
  assert.equal(rule.style.getPropertyValue("resize"), "none");

  for (const mobileRule of rulesFor(mobileRules, ".chat-panel #message-input")) {
    assert.notEqual(mobileRule.style.getPropertyValue("font-size"), "15px");
    assert.equal(mobileRule.style.getPropertyValue("height"), "");
    assert.equal(mobileRule.style.getPropertyValue("min-height"), "");
  }
});

await test("CSS", "R3/R4 mobile 16px allowlist is exact and adds no important", () => {
  const expected = [
    ".thread-search",
    "#training-text",
    "#module-training .canonical-config-section input",
    "#module-training .canonical-config-section select",
    "#module-training .canonical-config-section textarea",
    ".tools-panel input",
    ".tools-panel select",
    ".auth-input",
    ".forward-search",
  ];
  const allowlistRule = mobileRules.find((rule) => {
    const selectors = rule.selectorText?.split(",").map((selector) => selector.trim()) || [];
    return expected.every((selector) => selectors.includes(selector));
  });
  assert.ok(allowlistRule, "Missing focused mobile allowlist rule");
  assert.deepEqual(
    allowlistRule.selectorText.split(",").map((selector) => selector.trim()),
    expected,
  );
  assert.equal(allowlistRule.style.getPropertyValue("font-size"), "16px");
  assert.equal(allowlistRule.style.getPropertyPriority("font-size"), "");
  assert.doesNotMatch(allowlistRule.cssText, /!important/i);
});

await test("CSS", "R5 composer keeps desktop/mobile sticker clearance", () => {
  assert.equal(
    lastRuleFor(desktopRules, ".chat-panel #message-input").style.getPropertyValue("padding-right"),
    "42px",
  );
  assert.equal(
    lastRuleFor(mobileRules, ".chat-panel #message-input").style.getPropertyValue("padding-right"),
    "44px",
  );
});

await test("CSS", "R6 viewport, grid morphology and mobile send size stay canonical", () => {
  assert.equal(lastRuleFor(mobileRules, ".app-shell").style.getPropertyValue("height"), "100dvh");
  assert.equal(lastRuleFor(mobileRules, "body").style.getPropertyValue("min-height"), "100dvh");
  assert.equal(
    ruleWithProperty(desktopRules, ".send-form", "grid-template-columns")
      .style.getPropertyValue("grid-template-columns"),
    "auto auto minmax(0, 1fr) auto",
  );
  assert.equal(
    ruleWithProperty(mobileRules, ".send-form", "grid-template-columns")
      .style.getPropertyValue("grid-template-columns"),
    "44px 44px minmax(0, 1fr) 44px",
  );
  const mobileSend = lastRuleFor(mobileRules, ".chat-panel .send-input-row .send-button");
  assert.equal(mobileSend.style.getPropertyValue("width"), "44px");
  assert.equal(mobileSend.style.getPropertyValue("height"), "44px");
});

await test("CSS", "R7 sticker, send and mobile attachment controls are bottom-aligned", () => {
  assert.equal(
    lastRuleFor(desktopRules, ".chat-panel #btn-chat-sticker").style.getPropertyValue("align-self"),
    "end",
  );
  assert.equal(
    lastRuleFor(desktopRules, ".chat-panel .send-button").style.getPropertyValue("align-self"),
    "end",
  );
  for (const selector of [
    ".chat-panel #btn-chat-image",
    ".chat-panel #btn-chat-attach",
    ".chat-panel .send-input-row .send-button",
  ]) {
    assert.equal(lastRuleFor(mobileRules, selector).style.getPropertyValue("align-self"), "end", selector);
  }
});

await test("DOM", "R8-R10 textarea contract, direct parent and unique IDs", () => {
  const input = staticDom.querySelector("#message-input");
  assert.equal(input.tagName, "TEXTAREA");
  assert.equal(input.rows, 1);
  assert.equal(input.id, "message-input");
  assert.equal(input.getAttribute("placeholder"), "Nhập tin nhắn…");
  assert.equal(input.getAttribute("autocomplete"), "off");
  assert.ok(input.parentElement.matches(".send-input-row"));
  const ids = [...staticDom.querySelectorAll("[id]")].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length);
});

// Execute the real app in JSDOM. scrollHeight is mocked because JSDOM does not
// calculate browser layout; the assertions below are clamp-logic evidence only.
const dom = new JSDOM(htmlSource, { url: "http://zalo-web.test/", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
let mobileInbox = false;
window.matchMedia = (query) => ({
  matches: mobileInbox && query === "(max-width: 760px)",
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
  KeyboardEvent: window.KeyboardEvent,
  PopStateEvent: window.PopStateEvent,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
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
globalThis.io = () => ({ on(event, handler) { socketHandlers.set(event, handler); } });
window.io = globalThis.io;

const fetchCalls = [];
const responseQueues = new Map();
function routeKey(url, method = "GET") {
  return `${String(method).toUpperCase()} ${String(url)}`;
}
function enqueue(url, response, method = "GET") {
  const key = routeKey(url, method);
  const queue = responseQueues.get(key) || [];
  queue.push(response);
  responseQueues.set(key, queue);
}
function defaultPayload(url, method) {
  if (url === "/api/bootstrap") return {
    loggedIn: true,
    uid: "MOBILE-FIX-01",
    displayName: "Fixture",
    threads: [{ id: "thread-mobile-fix", title: "Khách thử", threadType: 0, lastMessage: "" }],
    qr: {},
    ketNoi: { trangThai: "song", lyDo: "" },
    user: { username: "fixture" },
  };
  if (url.startsWith("/api/messages/")) return { messages: [] };
  if (["POST", "PUT", "DELETE"].includes(method)) return { ok: true };
  return {};
}
async function fetchFixture(input, options = {}) {
  const url = String(input);
  const method = String(options.method || "GET").toUpperCase();
  fetchCalls.push({ url, method });
  const queue = responseQueues.get(routeKey(url, method));
  if (queue?.length) return await queue.shift();
  return jsonResponse(defaultPayload(url, method));
}
globalThis.fetch = fetchFixture;
window.fetch = fetchFixture;

const input = document.querySelector("#message-input");
let soDongGia = 1;
Object.defineProperty(input, "scrollHeight", {
  configurable: true,
  get: () => input.value ? soDongGia * 22 + 22 : 44,
});

const form = document.querySelector("#send-form");
form.getBoundingClientRect = () => ({ height: Number.parseInt(input.style.height, 10) + 50 });

await import(`${pathToFileURL(path.join(REPO, "public", "app.js")).href}?mobile-fix-01`);
await flush(12);
document.querySelector(".thread-item").click();
await flush();

let submitCount = 0;
form.addEventListener("submit", () => { submitCount += 1; });
const postsToSend = () => fetchCalls.filter((call) => call.url === "/api/send" && call.method === "POST").length;
const dispatchKey = (options = {}) => {
  const event = new window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    shiftKey: Boolean(options.shiftKey),
    isComposing: Boolean(options.isComposing),
  });
  if (options.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: options.keyCode });
  input.dispatchEvent(event);
  return event;
};

await test("BEHAVIOR", "R11 desktop Enter uses one canonical submit and one POST", async () => {
  mobileInbox = false;
  input.value = "Tin desktop";
  const submitsBefore = submitCount;
  const postsBefore = postsToSend();
  const event = dispatchKey();
  await flush();
  assert.equal(event.defaultPrevented, true);
  assert.equal(submitCount, submitsBefore + 1);
  assert.equal(postsToSend(), postsBefore + 1);
});

await test("BEHAVIOR", "R12 desktop Shift+Enter remains a newline", () => {
  mobileInbox = false;
  const submitsBefore = submitCount;
  const event = dispatchKey({ shiftKey: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(submitCount, submitsBefore);
});

await test("BEHAVIOR", "R13/R14 IME guards never submit or prevent default", () => {
  mobileInbox = false;
  let submitsBefore = submitCount;
  const composing = dispatchKey({ isComposing: true });
  assert.equal(composing.defaultPrevented, false);
  assert.equal(submitCount, submitsBefore);

  submitsBefore = submitCount;
  const legacyIme = dispatchKey({ keyCode: 229 });
  assert.equal(legacyIme.defaultPrevented, false);
  assert.equal(submitCount, submitsBefore);
});

await test("BEHAVIOR", "R15 pending send rejects a second POST", async () => {
  mobileInbox = false;
  const pending = deferredResponse();
  enqueue("/api/send", pending.promise, "POST");
  input.value = "Tin đang bay";
  const postsBefore = postsToSend();
  dispatchKey();
  dispatchKey();
  await flush(2);
  assert.equal(postsToSend(), postsBefore + 1);
  pending.release({ ok: true });
  await flush();
});

await test("BEHAVIOR", "R16 mobile Enter remains a newline", () => {
  mobileInbox = true;
  input.value = "Dòng mobile";
  const submitsBefore = submitCount;
  const event = dispatchKey();
  assert.equal(event.defaultPrevented, false);
  assert.equal(submitCount, submitsBefore);
  mobileInbox = false;
});

await test("AUTO-GROW", "1/2/3/5/6/>6 lines clamp and overflow correctly", () => {
  input.value = "Nội dung";
  const cases = [
    [1, "46px", "hidden"],
    [2, "68px", "hidden"],
    [3, "90px", "hidden"],
    [5, "134px", "hidden"],
    [6, "156px", "hidden"],
    [8, "156px", "auto"],
  ];
  for (const [lines, height, overflow] of cases) {
    soDongGia = lines;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(input.style.height, height, `${lines} lines`);
    assert.equal(input.style.overflowY, overflow, `${lines} lines overflow`);
  }
});

await test("AUTO-GROW", "composer shrinks from 6 to 5 to 3 to 1 lines", () => {
  input.value = "Nội dung";
  const cases = [[6, "156px"], [5, "134px"], [3, "90px"], [1, "46px"]];
  for (const [lines, height] of cases) {
    soDongGia = lines;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(input.style.height, height);
  }
});

await test("AUTO-GROW", "successful send resets programmatically to one line", async () => {
  input.value = "Nội dung dài";
  soDongGia = 8;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(input.style.height, "156px");
  form.requestSubmit();
  await flush();
  assert.equal(input.value, "");
  assert.equal(input.style.height, "46px");
  assert.equal(input.style.overflowY, "hidden");
});

await test("TYPING", "textarea input preserves the existing typing request", () => {
  input.value = "Bắt đầu gõ";
  soDongGia = 1;
  input.dispatchEvent(new window.Event("blur"));
  const callsBefore = fetchCalls.filter((call) => call.url === "/api/messaging/typing").length;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  const callsAfter = fetchCalls.filter((call) => call.url === "/api/messaging/typing").length;
  assert.equal(callsAfter, callsBefore + 1);
});

await test("TYPING", "active bot typing height sync follows composer growth", () => {
  const panel = document.querySelector("#chat-panel");
  const typing = socketHandlers.get("bot_typing_status");
  typing({ ownerUid: "MOBILE-FIX-01", threadId: "thread-mobile-fix", typing: true });
  assert.ok(panel.classList.contains("bot-is-typing"));
  input.value = "Nội dung dài";
  soDongGia = 6;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(input.style.height, "156px");
  assert.equal(panel.style.getPropertyValue("--bot-typing-composer-height"), "206px");
  typing({ ownerUid: "MOBILE-FIX-01", threadId: "thread-mobile-fix", typing: false });
});

const passed = results.filter((result) => result.pass).length;
console.log(`\nMOBILE FIX 01: ${passed}/${results.length} PASS`);
if (passed !== results.length) process.exitCode = 1;
