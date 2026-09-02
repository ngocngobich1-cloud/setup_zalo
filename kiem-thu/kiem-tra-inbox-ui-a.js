/**
 * BU-INBOX-UI-A focused contract test.
 * Static source gates are separated from behavioral JSDOM gates below.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
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

function gitIndexEntries() {
  const dotGit = fs.readFileSync(path.join(REPO, ".git"), "utf8").trim();
  assert.match(dotGit, /^gitdir:\s+/);
  const gitDir = path.resolve(REPO, dotGit.replace(/^gitdir:\s+/, ""));
  const index = fs.readFileSync(path.join(gitDir, "index"));
  assert.equal(index.subarray(0, 4).toString("ascii"), "DIRC");
  const version = index.readUInt32BE(4);
  assert.ok(version === 2 || version === 3, `Unsupported Git index version ${version}`);
  const count = index.readUInt32BE(8);
  const entries = new Map();
  let offset = 12;
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    const entryStart = offset;
    const oid = index.subarray(entryStart + 40, entryStart + 60).toString("hex");
    const flags = index.readUInt16BE(entryStart + 60);
    offset = entryStart + 62;
    const pathEnd = index.indexOf(0, offset);
    assert.ok(pathEnd > offset, "Invalid Git index pathname");
    const file = index.subarray(offset, pathEnd).toString("utf8");
    entries.set(file, { oid, stage: (flags >> 12) & 3 });
    offset = entryStart + Math.ceil((pathEnd - entryStart + 1) / 8) * 8;
  }
  return entries;
}

function blobOid(content) {
  return crypto.createHash("sha1")
    .update(Buffer.from(`blob ${content.length}\0`))
    .update(content)
    .digest("hex");
}

function workingTreeChanges() {
  const entries = gitIndexEntries();
  const changed = [];
  for (const [file, entry] of entries) {
    if (entry.stage !== 0) continue;
    const absolute = path.join(REPO, ...file.split("/"));
    if (!fs.existsSync(absolute)) {
      changed.push(file);
      continue;
    }
    const content = fs.readFileSync(absolute);
    const normalized = Buffer.from(content.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
    if (blobOid(content) !== entry.oid && blobOid(normalized) !== entry.oid) changed.push(file);
  }

  const tracked = new Set(entries.keys());
  function scan(directory, relative = "") {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!relative && (item.name === ".git" || item.name === "node_modules")) continue;
      const nextRelative = relative ? `${relative}/${item.name}` : item.name;
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) scan(absolute, nextRelative);
      else if (!tracked.has(nextRelative)) changed.push(nextRelative);
    }
  }
  scan(REPO);
  return [...new Set(changed)].sort();
}

function publicSources() {
  return fs.readdirSync(path.join(REPO, "public"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:js|html|css)$/.test(entry.name))
    .map((entry) => fs.readFileSync(path.join(REPO, "public", entry.name), "utf8"))
    .join("\n");
}

const staticDom = new JSDOM(htmlSource).window.document;
const cssDom = new JSDOM("<!doctype html><style></style>");
cssDom.window.document.querySelector("style").textContent = cssSource;
const cssRules = [...cssDom.window.document.styleSheets[0].cssRules];

function styleRulesInMedia(conditionText) {
  return cssRules
    .filter((rule) => rule.type === cssDom.window.CSSRule.MEDIA_RULE && rule.conditionText === conditionText)
    .flatMap((rule) => [...rule.cssRules]);
}

await test("STATIC", "T1 required app.js IDs remain in index.html", () => {
  const ids = [...appSource.matchAll(/document\.querySelector\("#([A-Za-z][\w-]*)"\)/g)].map((match) => match[1]);
  assert.ok(ids.length > 20, "Expected the real app.js ID catalog");
  for (const id of ids) assert.ok(staticDom.getElementById(id), `Missing #${id}`);
});

await test("STATIC", "T2/T3 thread-item and messages contracts remain", () => {
  assert.match(appSource, /className = `thread-item/);
  assert.ok(staticDom.querySelector("#messages"));
});

await test("STATIC", "T4/T5 attachment contracts and localized action remain", () => {
  for (const token of ["chat-image", "chat-file-card", "bubble-media", "chat-selected-file"]) {
    assert.match(`${htmlSource}\n${appSource}\n${cssSource}`, new RegExp(token));
  }
  assert.match(appSource, /Mở \/ tải/);
});

await test("STATIC", "T12 attachment controls are icon-only and retain accessible names", () => {
  const imageButton = staticDom.querySelector("#btn-chat-image");
  const fileButton = staticDom.querySelector("#btn-chat-attach");
  assert.ok(imageButton?.querySelector("svg.chat-tool-icon"));
  assert.ok(fileButton?.querySelector("svg.chat-tool-icon"));
  assert.equal(imageButton.textContent.trim(), "");
  assert.equal(fileButton.textContent.trim(), "");
  assert.equal(imageButton.getAttribute("aria-label"), "Ảnh");
  assert.equal(imageButton.getAttribute("title"), "Ảnh");
  assert.equal(fileButton.getAttribute("aria-label"), "Tệp");
  assert.equal(fileButton.getAttribute("title"), "Tệp");
  assert.equal(staticDom.querySelectorAll("#chat-file-input").length, 1);
});

await test("STATIC", "T6 desktop rail and conversation width remain canonical", () => {
  assert.match(cssSource, /\.app-shell\s*\{[\s\S]*?grid-template-columns:\s*64px minmax\(0, 1fr\)/);
  assert.match(cssSource, /\.chat-app\s*\{[\s\S]*?grid-template-columns:\s*320px minmax\(0, 1fr\)/);
  assert.match(cssSource, /\.app-resizer\s*\{\s*display:\s*none/);
});

await test("STATIC", "T6b three locked CSS anchors remain", () => {
  assert.match(cssSource, /\.send-input-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto auto/);
  assert.match(cssSource, /@media \(max-width: 760px\)[\s\S]*?\.send-button\s*\{[\s\S]*?min-width:\s*64px/);
  assert.match(cssSource, /\.chat-image\s*\{[\s\S]*?max-width:[\s\S]*?max-height:[\s\S]*?object-fit:\s*contain/);
});

await test("STATIC", "T6c Inbox mobile has one dynamic owner, fixed rows and safe-area bottom stack", () => {
  const mobileRules = styleRulesInMedia("(max-width: 760px)");
  const mobileRule = (selector) => mobileRules.find((rule) => rule.selectorText === selector);
  const viewportHeight = "var(--mobile-vv-height, 100dvh)";
  const desktopShellRule = cssRules.find((rule) => rule.selectorText === ".app-shell");
  const desktopBodyRule = cssRules.find((rule) => rule.selectorText === "body");
  const chatApp = staticDom.querySelector("#chat-app");
  const panel = staticDom.querySelector("#chat-panel");
  const header = panel?.querySelector(":scope > .chat-header");
  const messages = panel?.querySelector(":scope > #messages.messages");
  const bottomStack = panel?.querySelector(":scope > #send-form.send-form");

  assert.equal(desktopShellRule?.style.height, "100vh", "desktop shell height must remain unchanged");
  assert.equal(desktopBodyRule?.style.getPropertyValue("min-height"), "100vh");
  assert.equal(mobileRule(".app-shell")?.style.height, viewportHeight);
  assert.equal(mobileRule("body")?.style.getPropertyValue("min-height"), viewportHeight);
  assert.notEqual(mobileRule("body")?.style.getPropertyValue("min-height"), "100vh");
  assert.equal(mobileRule("body:has(.chat-app.mobile-chat-open)")?.style.overflow, "hidden");
  for (const selector of [".chat-app", ".chat-app.mobile-chat-open", ".chat-main", ".chat-panel"]) {
    assert.doesNotMatch(
      mobileRule(selector)?.style.height || "",
      /(?:--mobile-vv-height|\bdvh\b)/,
      `${selector} must not become another visual viewport owner`,
    );
  }
  assert.match(
    mobileRule(".chat-panel")?.style.getPropertyValue("grid-template-rows") || "",
    /^56px minmax\(0, 1fr\) auto$/,
  );
  assert.equal(
    cssRules.find((rule) => rule.selectorText === ".messages")?.style.getPropertyValue("overflow-y"),
    "auto",
  );
  assert.equal(mobileRule(".messages")?.style.getPropertyValue("min-height"), "0");
  assert.match(
    mobileRule(".send-form")?.style.getPropertyValue("padding") || "",
    /env\(safe-area-inset-bottom\)/,
  );
  assert.equal(chatApp?.querySelector(":scope > .chat-main > #chat-panel"), panel);
  assert.ok(header && messages && bottomStack);
  assert.equal(header.parentElement, panel);
  assert.equal(messages.parentElement, panel);
  assert.equal(bottomStack.parentElement, panel);
  assert.equal(messages.contains(header), false);
  assert.equal(messages.contains(bottomStack), false);
});

await test("STATIC", "T6d one idempotent VisualViewport synchronizer owns geometry only", () => {
  const start = appSource.indexOf("const MOBILE_VISUAL_VIEWPORT_HEIGHT_PROPERTY");
  const end = appSource.indexOf("function chupFrontendOwner", start);
  const viewportSource = appSource.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.equal([...appSource.matchAll(/function syncMobileVisualViewport\s*\(/g)].length, 1);
  assert.match(viewportSource, /window\.visualViewport\?\.height/);
  assert.match(viewportSource, /fallbackHeight = Number\(window\.innerHeight\)/);
  assert.match(viewportSource, /style\.setProperty\(MOBILE_VISUAL_VIEWPORT_HEIGHT_PROPERTY, `\$\{height\}px`\)/);
  assert.match(viewportSource, /window\.visualViewport\?\.addEventListener\("resize", syncMobileVisualViewport/);
  assert.match(viewportSource, /window\.addEventListener\("resize", syncMobileVisualViewport/);
  assert.match(viewportSource, /if \(mobileVisualViewportSyncInitialized\) return/);
  assert.match(viewportSource, /MOBILE_VISUAL_VIEWPORT_SETTLE_MS = 120/);
  assert.doesNotMatch(viewportSource, /offsetTop|addEventListener\("scroll"|setInterval|scrollTo|fetch\(|\.value\s*=|\.submit\(/);
});

await test("STATIC", "T16 per-thread Bot scaffold is present and inert by source", () => {
  const status = staticDom.querySelector("#thread-bot-status");
  const button = staticDom.querySelector("#btn-thread-bot-toggle");
  assert.equal(status?.dataset.uiOnly, "true");
  assert.equal(button?.dataset.uiOnly, "true");
  assert.equal(button?.disabled, true);
  assert.equal(button?.getAttribute("aria-disabled"), "true");
  assert.doesNotMatch(appSource, /btn-thread-bot-toggle|thread-bot-status|botPerThread/);
});

await test("STATIC", "T16b mobile more scaffold is present and inert by source", () => {
  const button = staticDom.querySelector("#btn-chat-more");
  assert.equal(button?.dataset.uiOnly, "true");
  assert.equal(button?.disabled, true);
  assert.equal(button?.getAttribute("aria-disabled"), "true");
  assert.doesNotMatch(appSource, /btn-chat-more|chat-more-button/);
  assert.equal(staticDom.querySelector(".chat-more-menu"), null);
});

await test("STATIC", "T17 no unread tracking or persistence was added", () => {
  assert.doesNotMatch(publicSources(), /unreadCount|markAsRead|lastReadAt/);
});

await test("STATIC", "T18 V3.2 viewport fix stays inside the authorized file allowlist", () => {
  const allowed = new Set([
    "public/index.html",
    "public/app.js",
    "public/style.css",
    "kiem-thu/kiem-tra-inbox-ui-a.js",
    "kiem-thu/kiem-tra-bot-commander-part1.js",
  ]);
  const runtimeOnly = (file) => file === "data/.gitkeep"
    || file.startsWith("data.ui-a-fresh-backup-")
    || file.startsWith("caddy-config/")
    || file.startsWith("caddy-data/")
    || file.startsWith("opencode-data/")
    || file.startsWith("kiem-thu/evidence/")
    || /^data\/(?:credentials\.json|\.secret-key|.+\.db(?:-.+)?)$/.test(file);
  const changed = workingTreeChanges().filter((file) => !runtimeOnly(file));
  assert.ok(changed.includes("public/style.css"));
  assert.ok(changed.includes("public/app.js"));
  assert.ok(changed.includes("kiem-thu/kiem-tra-inbox-ui-a.js"));
  assert.ok(changed.includes("kiem-thu/kiem-tra-bot-commander-part1.js"));
  for (const file of changed) assert.ok(allowed.has(file), `Out-of-scope source file: ${file}`);

  const ids = [...htmlSource.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "DOM IDs must remain unique");
  for (const id of ["btn-chat-image", "btn-chat-more", "btn-thread-bot-toggle", "thread-bot-status"]) {
    assert.ok(staticDom.getElementById(id), `Missing allowlisted new ID #${id}`);
  }
});

// --- Behavioral assertions: the real public/app.js runs in JSDOM. ---

function jsonResponse(data, status = 200, { clone = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => clone ? structuredClone(data) : data,
  };
}

function deferredResponse() {
  let release;
  const promise = new Promise((resolve) => { release = (data, status = 200) => resolve(jsonResponse(data, status)); });
  return { promise, release };
}

async function flush(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const dom = new JSDOM(htmlSource, { url: "http://zalo-web.test/", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
Object.defineProperty(window, "innerWidth", { configurable: true, value: 393 });
Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 700 });
const mobileVisualViewport = new window.EventTarget();
Object.defineProperty(mobileVisualViewport, "height", { configurable: true, writable: true, value: 640 });
let mobileVisualViewportResizeListeners = 0;
const addMobileVisualViewportListener = mobileVisualViewport.addEventListener.bind(mobileVisualViewport);
mobileVisualViewport.addEventListener = (type, listener, options) => {
  if (type === "resize") mobileVisualViewportResizeListeners += 1;
  return addMobileVisualViewportListener(type, listener, options);
};
Object.defineProperty(window, "visualViewport", { configurable: true, value: mobileVisualViewport });
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
globalThis.io = () => ({ on(event, handler) { socketHandlers.set(event, handler); } });
window.io = globalThis.io;

const queues = new Map();
const fetchCalls = [];
function routeKey(url, method = "GET") { return `${String(method).toUpperCase()} ${String(url)}`; }
function enqueue(url, response, method = "GET") {
  const key = routeKey(url, method);
  const queue = queues.get(key) || [];
  queue.push(response);
  queues.set(key, queue);
}
function defaultPayload(url, method) {
  if (url === "/api/bootstrap") return {
    loggedIn: true, uid: "UI-A", displayName: "Tài khoản thử", threads: [], qr: {},
    ketNoi: { trangThai: "song", lyDo: "" }, user: { username: "fixture" }, admins: [],
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
  if (url === "/api/auth/me") return { user: { username: "fixture" } };
  if (url === "/api/auth/otp-settings") return { enabled: false, email: "", adminZaloUid: "", smtpConfigured: false };
  if (url === "/api/training") return { model: "", messages: [], files: [], sessionId: null };
  if (url.startsWith("/api/messages/")) return { messages: [] };
  if (["POST", "PUT", "DELETE"].includes(method)) return { ok: true };
  return {};
}
async function fetchFixture(input, options = {}) {
  const url = String(input);
  const method = String(options.method || "GET").toUpperCase();
  fetchCalls.push({ url, method });
  const queue = queues.get(routeKey(url, method));
  if (queue?.length) return await queue.shift();
  return jsonResponse(defaultPayload(url, method));
}
globalThis.fetch = fetchFixture;
window.fetch = fetchFixture;

const appModule = await import(`${pathToFileURL(path.join(REPO, "public", "app.js")).href}?inbox-ui-a`);
await flush(14);

await test("BEHAVIOR", "K1-K7 viewport resize, fallback and bounded settle preserve the composer draft", async () => {
  assert.equal(document.documentElement.style.getPropertyValue("--mobile-vv-height"), "640px");
  assert.equal(mobileVisualViewportResizeListeners, 1);
  appModule.initMobileVisualViewportSync();
  appModule.initMobileVisualViewportSync();
  assert.equal(mobileVisualViewportResizeListeners, 1, "idempotent init must not duplicate listeners");

  const draft = "TEST MOBILE KEYBOARD V3.4";
  const callsBefore = fetchCalls.length;
  document.querySelector("#message-input").value = draft;
  mobileVisualViewport.height = 420;
  mobileVisualViewport.dispatchEvent(new window.Event("resize"));
  assert.equal(document.documentElement.style.getPropertyValue("--mobile-vv-height"), "420px");
  assert.equal(document.querySelector("#message-input").value, draft);
  assert.equal(fetchCalls.length, callsBefore);

  mobileVisualViewport.height = Number.NaN;
  window.innerHeight = 612;
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(document.documentElement.style.getPropertyValue("--mobile-vv-height"), "612px");

  mobileVisualViewport.height = 500;
  mobileVisualViewport.dispatchEvent(new window.Event("resize"));
  assert.equal(document.documentElement.style.getPropertyValue("--mobile-vv-height"), "500px");
  mobileVisualViewport.height = 700;
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(document.documentElement.style.getPropertyValue("--mobile-vv-height"), "700px");
  assert.equal(document.querySelector("#message-input").value, draft);
  assert.equal(fetchCalls.length, callsBefore);
});

const threadWithTime = {
  id: "thread-alpha", title: "Khách Alpha", threadType: 0, lastMessage: "Tin mới nhất",
  lastMessageAt: 1_800_000_000_000, avatar: "",
};
const threadWithoutTime = {
  id: "thread-empty-time", title: "Khách Không Giờ", threadType: 0, lastMessage: null,
  lastMessageAt: null, avatar: "",
};
const rawStickerPreview = '{"id":27452,"catId":10739,"type":7}';
const threadWithSticker = {
  id: "thread-sticker", title: "Khách Sticker", threadType: 0, lastMessage: rawStickerPreview,
  lastMessageAt: 1_800_000_001_000, avatar: "",
};
const ordinaryJsonPreview = '{"hello":"world"}';
const threadWithOrdinaryJson = {
  id: "thread-json", title: "Khách JSON", threadType: 0, lastMessage: ordinaryJsonPreview,
  lastMessageAt: 1_800_000_002_000, avatar: "",
};
const groupThread = {
  id: "thread-group", title: "Nhóm kiểm thử", threadType: 1, lastMessage: "Tin nhóm",
  lastMessageAt: 1_800_086_400_000, avatar: "https://fixture.test/group.webp",
};
socketHandlers.get("threads")([
  threadWithTime,
  threadWithoutTime,
  threadWithSticker,
  threadWithOrdinaryJson,
  groupThread,
]);

const messages = [
  { id: "m1", content: "Khách một", ts: 1_800_000_000_000, isSelf: false, senderName: "Alpha" },
  { id: "m2", content: "Khách hai", ts: 1_800_000_060_000, isSelf: false, senderName: "Alpha" },
  { id: "m3", content: "Mình một", ts: 1_800_000_120_000, isSelf: true },
  { id: "m4", content: "Mình hai", ts: 1_800_000_180_000, isSelf: true },
  { id: "m5", content: "Ngày sau", ts: 1_800_086_400_000, isSelf: false, senderName: "Alpha" },
];
const messageSnapshot = structuredClone(messages);
enqueue("/api/messages/thread-alpha", Promise.resolve(jsonResponse({ messages }, 200, { clone: false })));

const groupMessages = [
  {
    id: "g1", content: "Tin A đầu", ts: 1_800_000_000_000, isSelf: false,
    senderId: "A", senderName: "Thành viên A", senderAvatar: "https://fixture.test/a.webp",
  },
  {
    id: "g2", content: "Tin B đầu", ts: 1_800_000_060_000, isSelf: false,
    senderId: "B", senderName: "Thành viên B", senderAvatar: "https://fixture.test/b.webp",
  },
  {
    id: "g3", content: "Tin B tiếp", ts: 1_800_000_120_000, isSelf: false,
    senderId: "B", senderName: "Thành viên B", senderAvatar: "https://fixture.test/b.webp",
  },
  {
    id: "g4", content: "Tin A trở lại", ts: 1_800_000_180_000, isSelf: false,
    senderId: "A", senderName: "Thành viên A", senderAvatar: "https://fixture.test/a.webp",
  },
  { id: "g5", content: "Mình một", ts: 1_800_000_240_000, isSelf: true },
  { id: "g6", content: "Mình hai", ts: 1_800_000_300_000, isSelf: true },
  {
    id: "g7", content: "Tin C trước ID thiếu", ts: 1_800_000_360_000, isSelf: false,
    senderId: "C", senderName: "Thành viên C", senderAvatar: "https://fixture.test/c.webp",
  },
  {
    id: "g8", content: "Tin thiếu ID", ts: 1_800_000_420_000, isSelf: false,
    senderName: "Không rõ", senderAvatar: "https://fixture.test/unknown.webp",
  },
  {
    id: "g9", content: "Tin C sau ID thiếu", ts: 1_800_000_480_000, isSelf: false,
    senderId: "C", senderName: "Thành viên C", senderAvatar: "https://fixture.test/c.webp",
  },
  {
    id: "g10", content: "Tin C ngày sau", ts: 1_800_086_400_000, isSelf: false,
    senderId: "C", senderName: "Thành viên C", senderAvatar: "https://fixture.test/c.webp",
  },
];
const groupMessageSnapshot = structuredClone(groupMessages);
enqueue("/api/messages/thread-group", Promise.resolve(jsonResponse({ messages: groupMessages }, 200, { clone: false })));

await test("BEHAVIOR", "T7-T10 grouping is immutable with clustered avatars and time in final bubbles", async () => {
  const list = document.querySelector("#threads");
  list.scrollTop = 137;
  [...document.querySelectorAll(".thread-item")].find((node) => node.textContent.includes("Khách Alpha")).click();
  await flush();

  assert.deepEqual(messages, messageSnapshot);
  const rows = [...document.querySelectorAll("#messages .bubble-row")];
  assert.equal(rows.length, 5);
  assert.equal(rows[0].querySelector(".bubble-avatar"), null);
  assert.ok(rows[0].querySelector(".bubble-avatar-spacer"));
  assert.ok(rows[1].querySelector(".bubble-avatar"));
  assert.equal(rows[2].querySelector(".bubble-avatar"), null);
  assert.equal(rows[3].querySelector(".bubble-avatar"), null);
  assert.equal(rows[0].querySelector(".bubble-time"), null);
  assert.ok(rows[1].querySelector(".bubble > .bubble-time"));
  assert.ok(rows[3].querySelector(".bubble > .bubble-time"));
  assert.ok(rows[4].querySelector(".bubble > .bubble-time"));
  assert.equal(document.querySelectorAll(".bubble-wrap > .bubble-time").length, 0);
  assert.equal(document.querySelectorAll("#messages .date-divider").length, 2);
});

await test("BEHAVIOR", "T11 thread time and sticker preview use render-only presentation", () => {
  const items = [...document.querySelectorAll(".thread-item")];
  const alphaItem = items.find((node) => node.textContent.includes("Khách Alpha"));
  const emptyItem = items.find((node) => node.textContent.includes("Khách Không Giờ"));
  const stickerItem = items.find((node) => node.textContent.includes("Khách Sticker"));
  const timed = alphaItem.querySelector(".thread-time");
  const empty = emptyItem.querySelector(".thread-time");
  const sticker = stickerItem.querySelector(".thread-preview");
  const stickerTime = stickerItem.querySelector(".thread-time");
  const ordinaryJson = items.find((node) => node.textContent.includes("Khách JSON")).querySelector(".thread-preview");

  // S1/S2: canonical copy, with no raw provider payload left in the preview.
  assert.equal(sticker.textContent, "Sticker");
  assert.doesNotMatch(sticker.textContent, /[\[\]{}]|catId|27452/);
  // S3: ordinary text preview remains byte-for-byte unchanged.
  assert.equal(alphaItem.querySelector(".thread-preview").textContent, threadWithTime.lastMessage);
  // S4: presentation formatting does not replace or clear the sticker timestamp.
  assert.equal(
    stickerTime.textContent,
    new Date(threadWithSticker.lastMessageAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }),
  );
  // S5: canonical null preview/time behavior remains empty.
  assert.equal(emptyItem.querySelector(".thread-preview").textContent, "");
  assert.match(timed.textContent, /\d{2}:\d{2}/);
  assert.equal(empty.textContent, "");
  // S6: the real chat renderer still uses stickerUrl to render the image path.
  socketHandlers.get("new-message")({
    id: "chat-sticker", threadId: "thread-alpha", content: rawStickerPreview,
    ts: 1_800_000_240_000, isSelf: false, isSticker: true,
    stickerUrl: "https://fixture.test/sticker.webp",
  });
  const chatSticker = document.querySelector("#messages img.sticker");
  assert.ok(chatSticker);
  assert.equal(chatSticker.getAttribute("src"), "https://fixture.test/sticker.webp");
  // S7: generic JSON is text, never a sticker preview.
  assert.equal(ordinaryJson.textContent, ordinaryJsonPreview);
});

await test("GROUP", "G1 different inbound senders split clusters", async () => {
  [...document.querySelectorAll(".thread-item")].find((node) => node.textContent.includes("Nhóm kiểm thử")).click();
  await flush();
  const rows = [...document.querySelectorAll("#messages .bubble-row")];
  assert.ok(rows[0].classList.contains("cluster-end"));
  assert.ok(rows[1].classList.contains("cluster-start"));
});

await test("GROUP", "G2 split clusters preserve sender attribution", () => {
  const rows = [...document.querySelectorAll("#messages .bubble-row")];
  assert.equal(rows[0].querySelector(".sender")?.textContent, "Thành viên A");
  assert.equal(rows[0].querySelector(".bubble-avatar img")?.alt, "Thành viên A");
  assert.equal(rows[0].querySelector(".bubble-avatar img")?.getAttribute("src"), "https://fixture.test/a.webp");
  assert.ok(rows[0].querySelector(".bubble > .bubble-time"));
  assert.equal(rows[1].querySelector(".sender")?.textContent, "Thành viên B");
  assert.ok(rows[1].querySelector(".bubble-avatar-spacer"));
  assert.equal(rows[2].querySelector(".bubble-avatar img")?.alt, "Thành viên B");
  assert.equal(rows[2].querySelector(".bubble-avatar img")?.getAttribute("src"), "https://fixture.test/b.webp");
  assert.ok(rows[2].querySelector(".bubble > .bubble-time"));
});

await test("GROUP", "G3 consecutive inbound messages from one sender merge", () => {
  const rows = [...document.querySelectorAll("#messages .bubble-row")];
  assert.ok(rows[1].classList.contains("cluster-start"));
  assert.equal(rows[1].classList.contains("cluster-end"), false);
  assert.equal(rows[2].classList.contains("cluster-start"), false);
  assert.ok(rows[2].classList.contains("cluster-end"));
  assert.equal(rows[1].querySelector(".bubble-time"), null);
  assert.ok(rows[2].querySelector(".bubble-time"));
});

await test("GROUP", "G4 A-B-A remains three ordered clusters", () => {
  const rows = [...document.querySelectorAll("#messages .bubble-row")];
  assert.deepEqual(
    [rows[0], rows[1], rows[3]].map((row) => row.querySelector(".sender")?.textContent),
    ["Thành viên A", "Thành viên B", "Thành viên A"],
  );
  assert.ok(rows[0].classList.contains("cluster-end"));
  assert.ok(rows[1].classList.contains("cluster-start"));
  assert.ok(rows[2].classList.contains("cluster-end"));
  assert.ok(rows[3].classList.contains("cluster-start"));
});

await test("GROUP", "G5 consecutive self messages remain one cluster without avatars", () => {
  const rows = [...document.querySelectorAll("#messages .bubble-row")];
  assert.ok(rows[4].classList.contains("cluster-start"));
  assert.equal(rows[4].classList.contains("cluster-end"), false);
  assert.equal(rows[5].classList.contains("cluster-start"), false);
  assert.ok(rows[5].classList.contains("cluster-end"));
  assert.equal(rows[4].querySelector(".bubble-avatar, .bubble-avatar-spacer"), null);
  assert.equal(rows[5].querySelector(".bubble-avatar, .bubble-avatar-spacer"), null);
});

await test("GROUP", "G6 missing senderId never merges across its boundaries", () => {
  const rows = [...document.querySelectorAll("#messages .bubble-row")];
  for (const row of rows.slice(6, 9)) {
    assert.ok(row.classList.contains("cluster-start"));
    assert.ok(row.classList.contains("cluster-end"));
  }
});

await test("GROUP", "G7 direct inbound grouping remains unchanged", async () => {
  [...document.querySelectorAll(".thread-item")].find((node) => node.textContent.includes("Khách Alpha")).click();
  await flush();
  const rows = [...document.querySelectorAll("#messages .bubble-row")];
  assert.ok(rows[0].classList.contains("cluster-start"));
  assert.equal(rows[0].classList.contains("cluster-end"), false);
  assert.equal(rows[1].classList.contains("cluster-start"), false);
  assert.ok(rows[1].classList.contains("cluster-end"));
  assert.equal(rows[0].querySelector(".bubble-time"), null);
  assert.ok(rows[1].querySelector(".bubble-time"));
});

await test("GROUP", "G8 day boundary and canonical message immutability remain", async () => {
  [...document.querySelectorAll(".thread-item")].find((node) => node.textContent.includes("Nhóm kiểm thử")).click();
  await flush();
  const rows = [...document.querySelectorAll("#messages .bubble-row")];
  assert.ok(rows[8].classList.contains("cluster-end"));
  assert.ok(rows[9].classList.contains("cluster-start"));
  assert.equal(document.querySelectorAll("#messages .date-divider").length, 2);
  assert.deepEqual(groupMessages, groupMessageSnapshot);
});

await test("GROUP", "G9 group thread renders through the same locked Inbox shell as direct", () => {
  const chatApp = document.querySelector("#chat-app");
  const panel = chatApp?.querySelector(":scope > .chat-main > #chat-panel");
  const messages = panel?.querySelector(":scope > #messages");

  assert.ok(chatApp.classList.contains("mobile-chat-open"));
  assert.equal(document.querySelector("#chat-title-text")?.textContent, "Nhóm kiểm thử");
  assert.equal(messages, document.querySelector("#messages"));
  assert.ok(messages.querySelector(".sender"), "group sender data must render in the shared message region");
  assert.equal(panel.querySelector(":scope > .chat-header")?.parentElement, panel);
  assert.equal(panel.querySelector(":scope > #send-form")?.parentElement, panel);
  assert.equal(document.querySelector(".group-chat, #group-chat, [data-group-chat-root]"), null);
  assert.doesNotMatch(cssSource, /(?:group[-_]?chat|chat[-_]?group)/i);
});

await test("BEHAVIOR", "T12 image and file controls share the canonical picker with exact accept", () => {
  const input = document.querySelector("#chat-file-input");
  let clicks = 0;
  input.click = () => { clicks += 1; };
  document.querySelector("#btn-chat-image").click();
  assert.equal(input.accept, "image/*");
  assert.equal(clicks, 1);
  document.querySelector("#btn-chat-attach").click();
  assert.equal(input.accept, "");
  assert.equal(clicks, 2);
});

await test("BEHAVIOR", "T12b both attachment controls disable during send", async () => {
  const pending = deferredResponse();
  enqueue("/api/send", pending.promise, "POST");
  document.querySelector("#message-input").value = "Đang gửi";
  document.querySelector("#send-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await flush(1);
  assert.equal(document.querySelector("#btn-chat-image").disabled, true);
  assert.equal(document.querySelector("#btn-chat-attach").disabled, true);
  pending.release({ ok: true });
  await flush();
  assert.equal(document.querySelector("#btn-chat-image").disabled, false);
  assert.equal(document.querySelector("#btn-chat-attach").disabled, false);
});

await test("BEHAVIOR", "T13/T14 mobile CHAT returns to LIST and restores list scroll", async () => {
  assert.ok(document.querySelector("#chat-app").classList.contains("mobile-chat-open"));
  assert.equal(window.history.state?.inbox, "chat");
  window.history.back();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flush();
  assert.equal(document.querySelector("#chat-app").classList.contains("mobile-chat-open"), false);
  assert.equal(document.querySelector("#threads").scrollTop, 137);
});

await test("BEHAVIOR", "T15/T15b drawer overlays LIST and browser Back closes it", async () => {
  const list = document.querySelector(".thread-list");
  document.querySelector(".mobile-menu-button").click();
  assert.ok(document.querySelector("#app-shell").classList.contains("mobile-drawer-open"));
  assert.ok(document.body.contains(list));
  assert.equal(document.querySelector(".mobile-drawer-backdrop").classList.contains("hidden"), false);
  assert.equal(window.history.state?.inbox, "drawer");
  window.history.back();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flush();
  assert.equal(document.querySelector("#app-shell").classList.contains("mobile-drawer-open"), false);
  assert.ok(document.body.contains(list));
});

await test("BEHAVIOR", "T16/T16b UI-only buttons have no network or runtime effect", () => {
  const beforeCalls = fetchCalls.length;
  const globalBotBefore = document.querySelector("#bot-toggle").getAttribute("aria-checked");
  document.querySelector("#btn-thread-bot-toggle").dispatchEvent(new window.Event("click", { bubbles: true }));
  document.querySelector("#btn-chat-more").dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(fetchCalls.length, beforeCalls);
  assert.equal(document.querySelector("#bot-toggle").getAttribute("aria-checked"), globalBotBefore);
  assert.equal(document.querySelector(".chat-more-menu"), null);
});

const passed = results.filter((result) => result.pass).length;
const staticPassed = results.filter((result) => result.group === "STATIC" && result.pass).length;
const behaviorPassed = results.filter((result) => result.group === "BEHAVIOR" && result.pass).length;
console.log(`\nFOCUSED INBOX UI-A: ${passed}/${results.length} PASS (static ${staticPassed}, behavioral ${behaviorPassed})`);
if (passed !== results.length) process.exitCode = 1;
