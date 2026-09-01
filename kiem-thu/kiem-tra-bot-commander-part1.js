/**
 * Focused acceptance suite — Bot Commander UX Part 1.
 *
 * Chay tren Node 24 ARM64 cua may PO:
 * node --import ./kiem-thu/node24-arm64-test-polyfills.js \
 *   --import ./kiem-thu/sqlite3-node24-test-register.js \
 *   ./kiem-thu/kiem-tra-bot-commander-part1.js
 *
 * Suite nay dung DB tam, JSDOM va provider fixtures. Khong goi Zalo/provider that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const HTML_PATH = path.join(REPO, "public", "index.html");
const CSS_PATH = path.join(REPO, "public", "style.css");
const SERVER_PATH = path.join(REPO, "server.js");
const DB_SOURCE_PATH = path.join(REPO, "lib", "db.js");
const ONBOARDING_SOURCE_PATH = path.join(REPO, "lib", "onboarding.js");
const PUBLIC_ONBOARDING_PATH = path.join(REPO, "public", "onboarding.js");
const PUBLIC_CONFIG_PATH = path.join(REPO, "public", "config.js");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-bot-commander-part1-"));
const ORIGINAL_CWD = process.cwd();
const APP_SECRET_KEY_TRUOC = process.env.APP_SECRET_KEY;
const ketQua = [];

process.chdir(TEST_ROOT);
process.env.APP_SECRET_KEY = "11".repeat(32);

const db = await import(pathToFileURL(DB_SOURCE_PATH).href);
await db.initDb();
const onboardingDb = await import(pathToFileURL(ONBOARDING_SOURCE_PATH).href);
const DB_PATH = path.join(TEST_ROOT, "data", "zalo.db");
const sqlDb = new DatabaseSync(DB_PATH);

const html = fs.readFileSync(HTML_PATH, "utf8");
const css = fs.readFileSync(CSS_PATH, "utf8");
const serverSource = fs.readFileSync(SERVER_PATH, "utf8");
const dbSource = fs.readFileSync(DB_SOURCE_PATH, "utf8");
const onboardingSource = fs.readFileSync(ONBOARDING_SOURCE_PATH, "utf8");
const publicOnboardingSource = fs.readFileSync(PUBLIC_ONBOARDING_PATH, "utf8");
const publicConfigSource = fs.readFileSync(PUBLIC_CONFIG_PATH, "utf8");

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(data),
  };
}

function choTick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function choDen(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await choTick(5);
  }
  throw new Error(message);
}

async function bai(ma, moTa, fn) {
  try {
    await fn();
    ketQua.push({ ma, moTa, pass: true });
  } catch (error) {
    ketQua.push({ ma, moTa, pass: false, error: error?.stack || error?.message || String(error) });
  }
}

function xoaBang(table) {
  sqlDb.exec(`DELETE FROM ${table}`);
}

function chenAccount(ownerUid, setupData, setupStep = 0, setupCompleted = 0) {
  sqlDb.prepare(
    `INSERT INTO account_config (owner_uid, setup_data, setup_step, setup_completed)
     VALUES (?, ?, ?, ?)`
  ).run(ownerUid, setupData, setupStep, setupCompleted);
}

function accountRaw(ownerUid) {
  return sqlDb.prepare(
    `SELECT owner_uid, setup_step, setup_completed, setup_data FROM account_config WHERE owner_uid = ?`
  ).get(ownerUid);
}

function setupDataRaw(ownerUid) {
  return JSON.parse(accountRaw(ownerUid).setup_data);
}

function aiColumns() {
  return sqlDb.prepare("PRAGMA table_info(ai_chat_config)").all().map((row) => row.name);
}

function layCssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)[\\t ]*${escaped}[\\t ]*\\{([^}]*)\\}`, "m"));
  assert.ok(match, `CSS block must exist: ${selector}`);
  return match[1];
}

function taoUiFixture() {
  const dom = new JSDOM(html, { url: "http://zalo-web.test/" });
  const { window } = dom;
  const { document } = window;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const raf = (callback) => { callback(); return 1; };
  window.requestAnimationFrame = raf;

  globalThis.window = window;
  globalThis.document = document;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.Event = window.Event;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.MouseEvent = window.MouseEvent;
  globalThis.Option = window.Option;
  globalThis.FormData = window.FormData;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.requestAnimationFrame = raf;
  globalThis.confirm = () => true;
  globalThis.alert = () => {};

  let currentOwner = "historical";
  let mutationCalls = 0;
  const actionCalls = [];
  const routes = [];
  const states = new Map([
    ["historical", {
      step: 5,
      started: true,
      completed: false,
      prompt: "",
      data: { firstSetupInviteSeen: true },
    }],
  ]);
  const stateFor = (owner = currentOwner) => {
    if (!states.has(owner)) {
      states.set(owner, {
        step: 0,
        started: false,
        completed: false,
        prompt: "",
        data: {},
      });
    }
    return states.get(owner);
  };
  const providers = [{
    id: "openai",
    name: "OpenAI",
    connected: true,
    models: [{ id: "openai/gpt-4.1", label: "GPT-4.1", context: 100000, beta: false }],
  }];

  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    const method = String(options.method || "GET").toUpperCase();
    if (/^\/api\/ai-chat\/provider-key/.test(url)) {
      mutationCalls += 1;
      return response(500, { error: "Part 1 fixture must never reach credential mutation." });
    }
    if (url === "/api/zalo/groups") return response(200, { groups: [] });
    if (url === "/api/knowledge") return response(200, { files: [] });
    if (url === "/api/ai-chat/providers") return response(200, { providers });
    if (url === "/api/ai-chat/opencode-test") {
      return response(200, { agents: ["general"], providers, systemDefaultModel: "" });
    }
    if (url === "/api/ai-chat" && method === "GET") {
      return response(200, {
        ready: true,
        config: {
          opencodeBaseUrl: "http://opencode:4096",
          opencodeAgent: "general",
          opencodeModel: "openai/gpt-4.1",
          opencodeFallbackModel: "",
          allowedTopics: "support",
          roleTone: "warm",
          soul: "fixture",
          useKnowledge: false,
          knowledgeFileIds: [],
        },
      });
    }
    if (url === "/api/onboarding" && method === "GET") {
      return response(200, stateFor());
    }
    if (url === "/api/onboarding/action" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      actionCalls.push({ owner: currentOwner, action: body.action });
      const state = stateFor();
      if (body.action === "invite_seen") state.data.firstSetupInviteSeen = true;
      if (body.action === "start" && Number(state.step) === 0) {
        state.step = 1;
        state.started = true;
      }
      return response(200, state);
    }
    if (url === "/api/training" && method === "GET") {
      return response(200, {
        model: "openai/gpt-4.1",
        docDuocAnh: false,
        sessionId: null,
        messages: [],
      });
    }
    return response(404, { error: `Fixture route not found: ${method} ${url}` });
  };
  globalThis.fetch = fetchImpl;
  window.fetch = fetchImpl;

  return {
    actionCalls,
    document,
    dom,
    get currentOwner() { return currentOwner; },
    set currentOwner(value) { currentOwner = value; },
    get mutationCalls() { return mutationCalls; },
    providers,
    routes,
    stateFor,
    states,
    window,
  };
}

const ui = taoUiFixture();
const configModule = await import(pathToFileURL(PUBLIC_CONFIG_PATH).href);
configModule.setSettingsOwnerUid(ui.currentOwner);
const aiPanel = ui.document.createElement("section");
ui.document.querySelector("#modal-body-container").append(aiPanel);
configModule.CONFIG_TABS.find((tab) => tab.id === "ai-chat").mount(aiPanel);
await choDen(() => ui.document.querySelector("#ai-oc-provider")?.options.length > 1, "AI fixture mount failed.");
const publicOnboarding = await import(pathToFileURL(PUBLIC_ONBOARDING_PATH).href);
publicOnboarding.khoiTaoOnboarding({
  selectModule(target, options = {}) {
    ui.routes.push({ target, options });
    if (target === "training") void publicOnboarding.datManHinhHuanLuyen(true, options);
    else void publicOnboarding.datManHinhHuanLuyen(false);
  },
});

async function becomeOwner(ownerUid, { justLoggedIn = false } = {}) {
  ui.currentOwner = ownerUid;
  configModule.setSettingsOwnerUid(ownerUid);
  await publicOnboarding.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn, ownerUid });
  await choTick(20);
}

await bai("T1", "Authenticated startup stays Inbox beyond the removed timer", async () => {
  ui.routes.length = 0;
  await becomeOwner("historical", { justLoggedIn: true });
  await choTick(900);
  assert.deepEqual(ui.routes.map((entry) => entry.target), ["zalo"]);
  assert.equal(publicOnboardingSource.includes("loginTimer"), false);
  assert.equal(publicOnboardingSource.includes("setTimeout(() => callbacks?.selectModule(\"training\")"), false);
});

await bai("T2", "Eligible invitation is owner-scoped, consumed once, and never routes startup", async () => {
  ui.states.set("new-later", { step: 0, started: false, completed: false, prompt: "", data: {} });
  ui.routes.length = 0;
  await becomeOwner("new-later");
  assert.equal(ui.document.querySelector("#first-run-modal").classList.contains("hidden"), false);
  assert.equal(ui.routes.at(0)?.target, "zalo");
  await choDen(() => ui.stateFor("new-later").data.firstSetupInviteSeen === true, "invite_seen was not persisted");
  ui.document.querySelector("#btn-onboarding-later").click();
  await choDen(() => ui.document.querySelector("#first-run-modal").classList.contains("hidden"), "Later did not close modal");

  await becomeOwner("historical");
  await becomeOwner("new-later");
  assert.equal(ui.document.querySelector("#first-run-modal").classList.contains("hidden"), true);

  ui.states.set("new-start", { step: 0, started: false, completed: false, prompt: "", data: {} });
  await becomeOwner("new-start");
  assert.equal(ui.document.querySelector("#first-run-modal").classList.contains("hidden"), false);
  ui.document.querySelector("#btn-onboarding-start").click();
  await choDen(() => ui.routes.some((entry) => entry.target === "training"), "Start did not enter Training");
  assert.equal(ui.stateFor("new-start").data.firstSetupInviteSeen, true);
  assert.equal(ui.stateFor("new-later").data.firstSetupInviteSeen, true);
  assert.equal(ui.stateFor("historical").data.firstSetupInviteSeen, true);
  await becomeOwner("historical");
  await becomeOwner("new-start");
  assert.equal(ui.document.querySelector("#first-run-modal").classList.contains("hidden"), true);
});

await bai("T2b", "One-time backfill is idempotent and preserves unrelated keys", async () => {
  xoaBang("account_config");
  sqlDb.prepare("DELETE FROM app_secrets WHERE key = ?").run("first_invite_backfill_done");
  chenAccount("backfill-a", JSON.stringify({ keep: "A", nested: { x: 1 } }));
  chenAccount("backfill-b", JSON.stringify({ keep: "B", firstSetupInviteSeen: false }));

  const first = await db.backfillFirstInviteSeenOnce();
  assert.deepEqual(first, { applied: true, ownersUpdated: 2 });
  assert.deepEqual(setupDataRaw("backfill-a"), {
    keep: "A",
    nested: { x: 1 },
    firstSetupInviteSeen: true,
  });
  assert.equal(setupDataRaw("backfill-b").keep, "B");
  assert.equal(setupDataRaw("backfill-b").firstSetupInviteSeen, true);
  assert.ok(sqlDb.prepare("SELECT key FROM app_secrets WHERE key = ?").get("first_invite_backfill_done"));

  sqlDb.prepare("UPDATE account_config SET setup_data = ? WHERE owner_uid = ?")
    .run(JSON.stringify({ keep: "changed-after-marker", firstSetupInviteSeen: false }), "backfill-a");
  await db.initDb();
  assert.equal(setupDataRaw("backfill-a").firstSetupInviteSeen, false);
  chenAccount("post-marker", JSON.stringify({ keep: "new" }));
  await db.backfillFirstInviteSeenOnce();
  assert.equal(setupDataRaw("post-marker").firstSetupInviteSeen, undefined);
});

await bai("T2c", "Malformed setup_data rolls back every row and marker, then repairs atomically", async () => {
  xoaBang("account_config");
  sqlDb.prepare("DELETE FROM app_secrets WHERE key = ?").run("first_invite_backfill_done");
  const rawA = JSON.stringify({ keep: "atomic-a" });
  const rawB = JSON.stringify({ keep: "atomic-b", guidanceCompleted: true });
  const malformed = "{not-json";
  chenAccount("atomic-a", rawA);
  chenAccount("atomic-b", rawB);
  chenAccount("atomic-bad", malformed);

  await assert.rejects(
    db.backfillFirstInviteSeenOnce(),
    /BLOCKED_FIRST_INVITE_BACKFILL_DATA_INVALID: owner_uid=atomic-bad/
  );
  assert.equal(accountRaw("atomic-a").setup_data, rawA);
  assert.equal(accountRaw("atomic-b").setup_data, rawB);
  assert.equal(accountRaw("atomic-bad").setup_data, malformed);
  assert.equal(sqlDb.prepare("SELECT key FROM app_secrets WHERE key = ?").get("first_invite_backfill_done"), undefined);

  sqlDb.prepare("UPDATE account_config SET setup_data = ? WHERE owner_uid = ?")
    .run(JSON.stringify({ keep: "repaired" }), "atomic-bad");
  await db.backfillFirstInviteSeenOnce();
  for (const owner of ["atomic-a", "atomic-b", "atomic-bad"]) {
    assert.equal(setupDataRaw(owner).firstSetupInviteSeen, true);
  }
  assert.equal(setupDataRaw("atomic-b").guidanceCompleted, true);
  assert.equal(setupDataRaw("atomic-bad").keep, "repaired");
  assert.ok(sqlDb.prepare("SELECT key FROM app_secrets WHERE key = ?").get("first_invite_backfill_done"));
});

await bai("T3", "Both owner flags survive ordinary onboarding luu writes", async () => {
  await db.saveAccountConfig("flags-owner", {
    setupStep: 1,
    setupCompleted: false,
    setupData: { firstSetupInviteSeen: true },
  });
  await onboardingDb.xuLyHanhDongOnboarding("flags-owner", "key_link_clicked");
  assert.equal((await db.getAccountConfig("flags-owner")).setupData.firstSetupInviteSeen, true);
  await onboardingDb.xuLyHanhDongOnboarding("flags-owner", "guidance_completed");
  await onboardingDb.xuLyHanhDongOnboarding("flags-owner", "key_saved");
  const saved = await db.getAccountConfig("flags-owner");
  assert.equal(saved.setupData.firstSetupInviteSeen, true);
  assert.equal(saved.setupData.guidanceCompleted, true);
});

await bai("T4", "Semantic flag actions bypass completed guard and do not depend on step", async () => {
  await db.saveAccountConfig("completed-owner", {
    setupStep: 9,
    setupCompleted: true,
    setupData: {},
  });
  await onboardingDb.xuLyHanhDongOnboarding("completed-owner", "invite_seen");
  await onboardingDb.xuLyHanhDongOnboarding("completed-owner", "guidance_completed");
  const saved = await db.getAccountConfig("completed-owner");
  assert.equal(saved.setupCompleted, true);
  assert.equal(saved.setupData.firstSetupInviteSeen, true);
  assert.equal(saved.setupData.guidanceCompleted, true);
});

await bai("T5", "Manual Training opens quiet Normal mode", async () => {
  ui.states.set("quiet-owner", {
    step: 6,
    started: true,
    completed: false,
    prompt: "unfinished",
    data: { firstSetupInviteSeen: true },
  });
  await becomeOwner("quiet-owner");
  await publicOnboarding.datManHinhHuanLuyen(true);
  assert.equal(ui.document.querySelector("#module-training").dataset.trainingMode, "normal");
  assert.equal(ui.document.querySelector("#onboarding-progress").classList.contains("hidden"), true);
  assert.equal(ui.document.querySelector("#onboarding-coach").classList.contains("hidden"), true);
});

await bai("T6", "Explicit setup is transient and provides Exit Setup", async () => {
  await publicOnboarding.datManHinhHuanLuyen(false);
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  assert.equal(ui.document.querySelector("#module-training").dataset.trainingMode, "explicit");
  assert.equal(ui.document.querySelector("#training-title").textContent, "Thiết lập trợ lý");
  assert.equal(ui.document.querySelector("#btn-training-exit-setup").classList.contains("hidden"), false);
  ui.document.querySelector("#btn-training-exit-setup").click();
  await choTick(20);
  assert.equal(ui.document.querySelector("#module-training").dataset.trainingMode, "normal");

  await publicOnboarding.datManHinhHuanLuyen(false);
  ui.routes.length = 0;
  await publicOnboarding.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: true, ownerUid: "quiet-owner" });
  await choTick(20);
  assert.equal(ui.routes.at(0)?.target, "zalo");
  await publicOnboarding.datManHinhHuanLuyen(true);
  assert.equal(ui.document.querySelector("#module-training").dataset.trainingMode, "normal");
});

await bai("T7", "Common coach gate covers normal, explicit, rerender, dismissal and completed guidance", async () => {
  await publicOnboarding.datManHinhHuanLuyen(false);
  await publicOnboarding.datManHinhHuanLuyen(true);
  assert.equal(ui.document.querySelector("#onboarding-coach").classList.contains("hidden"), true);

  await publicOnboarding.datManHinhHuanLuyen(false);
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  assert.equal(ui.document.querySelector("#onboarding-coach").classList.contains("hidden"), false);
  ui.document.querySelector("#onboarding-dismiss").click();
  publicOnboarding.sauKhiDongCauHinh();
  await choTick(20);
  assert.equal(ui.document.querySelector("#onboarding-coach").classList.contains("hidden"), true);

  ui.states.set("guided-owner", {
    step: 6,
    started: true,
    completed: false,
    prompt: "",
    data: { firstSetupInviteSeen: true, guidanceCompleted: true },
  });
  await becomeOwner("guided-owner");
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  publicOnboarding.sauKhiDongCauHinh();
  await choTick(20);
  assert.equal(ui.document.querySelector("#onboarding-coach").classList.contains("hidden"), true);
  assert.equal(ui.document.querySelector("#onboarding-progress").classList.contains("hidden"), true);
});

await bai("T8", "Only the successful assistant-config branch completes guidance", async () => {
  const routeStart = serverSource.indexOf('app.post("/api/ai-chat"');
  const aiConnection = serverSource.indexOf('saveScope === "ai-connection"', routeStart);
  const connectionReturn = serverSource.indexOf("return res.json({ ok: true, config", aiConnection);
  const guidance = serverSource.indexOf('"guidance_completed"', connectionReturn);
  const assistantResponse = serverSource.indexOf("res.json({ ok: true, config", guidance);
  assert.ok(routeStart >= 0 && aiConnection > routeStart && connectionReturn > aiConnection);
  assert.ok(guidance > connectionReturn && assistantResponse > guidance);
  assert.equal(serverSource.slice(aiConnection, connectionReturn).includes("guidance_completed"), false);
  const adminRoute = serverSource.indexOf('app.post("/api/admin-zalo"');
  assert.equal(serverSource.slice(adminRoute, adminRoute + 1800).includes("guidance_completed"), false);
});

await bai("T9", "No fake session-history or Soul-history UI exists", async () => {
  for (const forbidden of ["Soul hiện tại", "Đã tổng hợp Soul", "history bottom sheet", "M5"]) {
    assert.equal(html.includes(forbidden), false, forbidden);
  }
  assert.equal(ui.document.querySelector("[data-training-history], #training-history"), null);
});

await bai("T10", "Real desktop Training rule has the approved Config track without a greedy match", async () => {
  assert.ok(ui.document.querySelector(".training-command-panel"));
  assert.ok(ui.document.querySelector("#training-config-panel"));
  const trainingLayoutCss = layCssBlock(css, ".training-layout");
  assert.match(
    trainingLayoutCss,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(460px,\s*0\.9fr\)/
  );
  const mobileStart = css.indexOf("@media (max-width: 980px)");
  const mobileEnd = css.indexOf("@media (max-width: 600px)", mobileStart);
  assert.ok(mobileStart >= 0 && mobileEnd > mobileStart);
  const mobileTrainingCss = css.slice(mobileStart, mobileEnd);
  assert.equal(mobileTrainingCss.includes("460px"), false);
  assert.match(mobileTrainingCss, /\.training-layout,\s*\.training-layout\.training-config-collapsed\s*\{[^}]*display:\s*block/);
  const layout = ui.document.querySelector("#training-layout");
  const toggle = ui.document.querySelector("#btn-training-config-toggle");
  toggle.click();
  assert.equal(layout.classList.contains("training-config-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  assert.equal(layout.classList.contains("training-config-collapsed"), false);
});

await bai("T11", "Mobile drawer and Chat/Config segmented structure replace stacked Training", async () => {
  assert.equal(ui.document.querySelectorAll(".mobile-menu-button").length >= 3, true);
  assert.deepEqual(
    [...ui.document.querySelectorAll("[data-training-segment]")].map((node) => node.textContent.trim()),
    ["Trò chuyện", "Cấu hình"]
  );
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 980px)"), css.indexOf("@media (max-width: 600px)"));
  const drawerBlock = css.slice(css.indexOf("/* Responsive cua khung app"));
  assert.match(layCssBlock(drawerBlock, ".app-sidebar"), /width:\s*306px/);
  assert.match(mobileBlock, /data-mobile-segment="chat"/);
  assert.match(mobileBlock, /data-mobile-segment="config"/);
  assert.equal(/\.training-layout\s*\{[^}]*grid-template-rows/s.test(mobileBlock), false);
});

await bai("T12", "Block 1 preserves verified links and keeps unverified provider names non-interactive", async () => {
  const expected = new Map([
    ["Google Gemini", "aistudio.google.com"],
    ["Groq", "console.groq.com"],
    ["Mistral AI", "console.mistral.ai"],
    ["OpenRouter", "openrouter.ai"],
    ["Cerebras", "cloud.cerebras.ai"],
    ["OpenAI", "platform.openai.com"],
    ["Anthropic", "console.anthropic.com"],
    ["DeepSeek", "platform.deepseek.com"],
    ["xAI", "console.x.ai"],
    ["Together AI", "api.together.ai"],
    ["Fireworks AI", "docs.fireworks.ai"],
  ]);
  const rawDocument = new JSDOM(html).window.document;
  const directory = rawDocument.querySelector("#onboarding-key-links");
  const links = [...directory.querySelectorAll("a")];
  for (const link of links) {
    assert.equal(link.classList.contains("provider-resource-row"), true);
    assert.equal(expected.has(link.textContent.trim()), true, `Unexpected or guessed link: ${link.textContent.trim()}`);
    assert.equal(new URL(link.href).hostname, expected.get(link.textContent.trim()));
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  }
  for (const name of expected.keys()) {
    assert.ok(links.some((link) => link.textContent.trim() === name), `Missing verified link: ${name}`);
  }
  const free = directory.querySelector('[data-provider-group="free-trial"]');
  const paid = directory.querySelector('[data-provider-group="paid"]');
  assert.ok(free.querySelectorAll("a, .provider-resource-name").length >= 8);
  assert.ok(paid.querySelectorAll("a, .provider-resource-name").length >= 30);
  for (const name of directory.querySelectorAll(".provider-resource-name")) {
    assert.equal(name.tagName, "SPAN");
    assert.equal(name.classList.contains("provider-resource-row"), true);
    assert.equal(name.closest("a, button"), null);
    assert.equal(name.hasAttribute("href"), false);
  }
  for (const toggle of directory.querySelectorAll(".provider-other-toggle")) {
    assert.equal(toggle.type, "button");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(rawDocument.getElementById(toggle.getAttribute("aria-controls")).hidden, true);
  }
});

await bai("T13", "Block 2 keeps the canonical customer-facing layout", async () => {
  const block = ui.document.querySelector('[data-canonical-slot="api-key"]');
  assert.ok(block.querySelector("#training-key-provider"));
  assert.ok(block.querySelector("#training-key-value"));
  for (const label of ["Lưu key", "Thử key", "Gỡ toàn bộ key"]) {
    assert.ok([...block.querySelectorAll("button")].some((button) => button.textContent.trim() === label));
  }
  assert.ok(block.querySelector("#training-connected-providers"));
  assert.equal(block.textContent.includes("Mở Cấu hình"), false);
});

await bai("T14", "All Part 1 Training credential controls are disabled", async () => {
  for (const selector of [
    "#training-key-provider",
    "#training-key-value",
    "#btn-training-key-save",
    "#btn-training-key-test",
    "#btn-training-key-clear",
  ]) assert.equal(ui.document.querySelector(selector).disabled, true, selector);
});

await bai("T15", "Training Block 2 produces zero global credential mutations", async () => {
  const before = ui.mutationCalls;
  for (const selector of ["#btn-training-key-save", "#btn-training-key-test", "#btn-training-key-clear"]) {
    const button = ui.document.querySelector(selector);
    button.dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  const input = ui.document.querySelector("#training-key-value");
  input.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await choTick(20);
  assert.equal(ui.mutationCalls - before, 0);
});

await bai("T16", "The live global key form is never portaled into Training", async () => {
  assert.equal(html.includes('id="onboarding-slot-api-key"'), false);
  assert.equal(publicOnboardingSource.includes('"#ai-key-provider", ".key-block"'), false);
  const liveGlobalKey = ui.document.querySelector("#ai-key-provider");
  assert.ok(liveGlobalKey);
  assert.equal(ui.document.querySelector("#module-training").contains(liveGlobalKey), false);
});

await bai("T17", "Block 2 renders neither secrets nor fake connected-provider state", async () => {
  const block = ui.document.querySelector('[data-canonical-slot="api-key"]');
  assert.equal(/(?:sk-|gsk_|AIza)[A-Za-z0-9_-]{8,}/.test(block.textContent), false);
  assert.equal(block.textContent.includes("2 hãng đã kết nối"), false);
  assert.equal(block.textContent.includes("Groq — Đã kết nối"), false);
  assert.equal(block.textContent.includes("Anthropic — Đã kết nối"), false);
  assert.match(block.textContent, /Chưa có kết nối\./);
});

await bai("U1", "Training typography uses the scoped 90% density system", async () => {
  const rootCss = layCssBlock(css, ":root");
  assert.match(rootCss, /--training-title-size:\s*20px/);
  assert.match(rootCss, /--training-title-line:\s*28px/);
  assert.match(rootCss, /--training-section-size:\s*15px/);
  assert.match(rootCss, /--training-section-line:\s*22px/);
  assert.match(rootCss, /--training-subsection-size:\s*13px/);
  assert.match(rootCss, /--training-subsection-line:\s*18px/);
  assert.match(rootCss, /--training-field-size:\s*12px/);
  assert.match(rootCss, /--training-field-line:\s*17px/);
  assert.match(rootCss, /--training-body-size:\s*13px/);
  assert.match(rootCss, /--training-body-line:\s*19px/);
  assert.match(rootCss, /--training-helper-size:\s*11px/);
  assert.match(rootCss, /--training-helper-line:\s*16px/);
  assert.match(layCssBlock(css, ".ai-model-grid"), /grid-template-columns:\s*minmax\(0,\s*0\.8fr\)\s+minmax\(0,\s*1\.2fr\)/);
  assert.equal(css.includes("minmax(180px, .8fr)"), false);
  assert.equal(css.includes("minmax(260px, 1.2fr)"), false);
  assert.match(css, /#module-training \.canonical-config-section label:not\(\.portal-shared-label\)/);
});

await bai("U2", "Sections 1–7 use safe canonical accordion controls with the required defaults", async () => {
  const rawDocument = new JSDOM(html).window.document;
  const sections = [...rawDocument.querySelectorAll(".canonical-config-accordion")];
  assert.equal(sections.length, 7);
  for (const [index, section] of sections.entries()) {
    const heading = section.querySelector(":scope > .canonical-config-section-header > .training-config-section-title");
    const toggle = section.querySelector(":scope > .canonical-config-section-header > .canonical-section-toggle");
    assert.ok(heading.textContent.trim().startsWith(`${index + 1}.`));
    assert.equal(toggle.type, "button");
    assert.ok(toggle.hasAttribute("aria-expanded"));
    assert.ok(toggle.hasAttribute("aria-controls"));
    const content = rawDocument.getElementById(toggle.getAttribute("aria-controls"));
    assert.ok(content);
    assert.equal(toggle.getAttribute("aria-expanded"), index === 0 ? "false" : "true");
    assert.equal(content.hidden, index === 0);
  }
  let submits = 0;
  ui.document.querySelector("#ai-chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submits += 1;
  });
  for (const toggle of ui.document.querySelectorAll(".canonical-section-toggle, .provider-other-toggle")) toggle.click();
  assert.equal(submits, 0);
});

await bai("U3", "Explicit coach expands a collapsed owner section before measuring its target", async () => {
  await publicOnboarding.datManHinhHuanLuyen(false);
  ui.states.set("accordion-coach", {
    step: 1,
    started: true,
    completed: false,
    prompt: "",
    data: { firstSetupInviteSeen: true },
  });
  await becomeOwner("accordion-coach");
  const section = ui.document.querySelector('[data-canonical-slot="resource-links"]');
  const toggle = section.querySelector(".canonical-section-toggle");
  const content = ui.document.getElementById(toggle.getAttribute("aria-controls"));
  if (toggle.getAttribute("aria-expanded") === "true") toggle.click();
  assert.equal(content.hidden, true);
  const target = ui.document.querySelector("#onboarding-key-links");
  const originalRect = target.getBoundingClientRect;
  let measuredExpanded = false;
  target.getBoundingClientRect = () => {
    measuredExpanded = toggle.getAttribute("aria-expanded") === "true" && content.hidden === false;
    return { left: 40, top: 40, right: 300, bottom: 180, width: 260, height: 140 };
  };
  try {
    await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
    assert.equal(measuredExpanded, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(content.hidden, false);
  } finally {
    target.getBoundingClientRect = originalRect;
  }
});

await bai("B1", "Block 1 has exactly two collapsed nested provider accordions and no Các hãng khác group", async () => {
  const rawDocument = new JSDOM(html).window.document;
  const topLevel = rawDocument.querySelector('[data-canonical-slot="resource-links"]');
  const directory = rawDocument.querySelector("#onboarding-key-links");
  assert.equal(topLevel.querySelector(".training-config-section-title").textContent.trim(), "1. Lấy API key");
  assert.equal(topLevel.querySelector(".canonical-section-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(directory.textContent.includes("Các hãng khác"), false);
  const groups = [...directory.querySelectorAll(":scope > .provider-resource-group")];
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.querySelector(".provider-other-toggle span").textContent.trim()), [
    "Có gói miễn phí / dùng thử",
    "Trả phí",
  ]);
  for (const group of groups) {
    const toggle = group.querySelector(":scope > h3 > .provider-other-toggle");
    assert.equal(toggle.type, "button");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.ok(toggle.hasAttribute("aria-controls"));
    assert.equal(rawDocument.getElementById(toggle.getAttribute("aria-controls")).hidden, true);
  }
  const freeNames = groups[0].querySelectorAll(".provider-resource-row");
  const paidNames = groups[1].querySelectorAll(".provider-resource-row");
  assert.ok(freeNames.length >= 8, `free/trial=${freeNames.length}`);
  assert.ok(paidNames.length >= 30, `paid=${paidNames.length}`);
  assert.equal(directory.querySelectorAll(".provider-resource-links > :not(.provider-resource-row)").length, 0);
});

await bai("B2", "Provider directories are full-width vertical rows, never pills, wraps, grids or tag clouds", async () => {
  const listCss = layCssBlock(css, ".provider-resource-links");
  assert.match(listCss, /display:\s*flex/);
  assert.match(listCss, /flex-direction:\s*column/);
  assert.match(listCss, /width:\s*100%/);
  assert.equal(/display:\s*grid/.test(listCss), false);
  assert.equal(/flex-wrap:\s*wrap/.test(listCss), false);
  const rowCss = layCssBlock(css, ".provider-resource-row");
  assert.match(rowCss, /width:\s*100%/);
  assert.match(rowCss, /min-height:\s*36px/);
  assert.match(rowCss, /border-radius:\s*0/);
});

await bai("V1", "Chat and Config share real 90% density while mobile controls remain touch-safe", async () => {
  assert.equal(/zoom:\s*0\.9/.test(css), false);
  assert.equal(/transform:\s*scale\(0\.9\)/.test(css), false);
  assert.match(layCssBlock(css, ".training-header"), /padding:\s*12px\s+16px/);
  assert.match(layCssBlock(css, ".training-log"), /padding:\s*16px/);
  assert.match(layCssBlock(css, ".training-msg"), /font-size:\s*var\(--training-body-size\)/);
  assert.match(layCssBlock(css, ".training-form"), /padding:\s*11px\s+16px/);
  assert.match(layCssBlock(css, ".training-config-panel"), /padding:\s*14px/);
  assert.match(layCssBlock(css, ".canonical-config-stack"), /gap:\s*10px/);
  assert.match(layCssBlock(css, ".canonical-config-section"), /padding:\s*14px/);
  assert.match(layCssBlock(css, "#module-training .canonical-config-section button"), /min-height:\s*36px/);
  assert.match(layCssBlock(css, "#module-training .canonical-config-section button"), /font-size:\s*13px/);
  const mobileStart = css.indexOf("@media (max-width: 980px)");
  const mobileEnd = css.indexOf("@media (max-width: 600px)", mobileStart);
  const mobileTrainingCss = css.slice(mobileStart, mobileEnd);
  assert.match(layCssBlock(mobileTrainingCss, ".training-mobile-segments button"), /min-height:\s*44px/);
  assert.match(mobileTrainingCss, /#module-training \.canonical-config-section button,[^}]*min-height:\s*44px/);
  assert.match(layCssBlock(css, ".training-layout"), /minmax\(460px,\s*0\.9fr\)/);
  assert.match(layCssBlock(css, ".ai-model-grid"), /minmax\(0,\s*0\.8fr\)\s+minmax\(0,\s*1\.2fr\)/);
});

await bai("U5", "Block 2 and rendered Training copy are customer-facing with no dangling ARIA", async () => {
  const rawDocument = new JSDOM(html).window.document;
  const block = rawDocument.querySelector('[data-canonical-slot="api-key"]');
  assert.equal(block.querySelector("[aria-describedby]"), null);
  assert.equal(rawDocument.querySelector("#training-key-part1-note"), null);
  assert.match(block.textContent, /Hãng đã kết nối/);
  assert.match(block.textContent, /Chưa có kết nối\./);
  assert.match(publicConfigSource, /Dùng khi API chính bị lỗi\. Không bắt buộc\./);
  const intendedTrainingCopy = `${rawDocument.querySelector("#module-training").textContent}\n${publicConfigSource.slice(
    publicConfigSource.indexOf('<div class="form-group ai-model-config">'),
    publicConfigSource.indexOf('<details class="form-group ai-opencode-advanced">')
  )}`;
  for (const forbidden of ["Part 1", "runtime", "backend", "owner-scoped", "credential lane", "migration", "deferred", "authority", "chưa kích hoạt", "Danh sách lấy trực tiếp từ OpenCode"]) {
    assert.equal(intendedTrainingCopy.includes(forbidden), false, forbidden);
  }
});

await bai("U6", "Training owns one canonical Block 3 H2 while the shared label is hidden only by scoped CSS", async () => {
  const rawDocument = new JSDOM(html).window.document;
  const canonicalModelHeadings = [...rawDocument.querySelectorAll("#module-training .training-config-section-title")]
    .filter((node) => node.textContent.trim() === "3. Hãng AI và Model");
  assert.equal(canonicalModelHeadings.length, 1);
  const shared = ui.document.querySelector(".ai-model-config > .portal-shared-label");
  assert.ok(shared);
  assert.equal(shared.textContent.trim(), "Hãng AI và Model");
  assert.equal(shared.classList.contains("portal-shared-label"), true);
  assert.match(layCssBlock(css, "#module-training .portal-shared-label"), /display:\s*none/);
});

await bai("U7", "Settings preserves all shared semantic labels and assistant-save wording matches coach copy", async () => {
  await publicOnboarding.datManHinhHuanLuyen(false);
  const labels = [...aiPanel.querySelectorAll(".portal-shared-label")];
  assert.deepEqual(labels.map((label) => label.textContent.trim()), [
    "Hãng AI và Model",
    "Soul",
    "Các chủ đề cho phép",
    "Vai trò và giọng điệu",
  ]);
  for (const label of labels) {
    assert.equal(label.classList.contains("hidden"), false);
    assert.equal(label.hasAttribute("hidden"), false);
    assert.equal(label.style.display, "");
  }
  assert.equal(aiPanel.querySelector("#btn-ai-assistant-save").textContent.trim(), "Lưu cấu hình trợ lý");
  assert.match(publicOnboardingSource, /bấm Lưu cấu hình trợ lý/);
  assert.equal(publicOnboardingSource.includes("bấm Ghi nhớ"), false);
});

await bai("T18", "Primary-only model save accepts an explicit empty fallback", async () => {
  await db.saveAiChatConfig("primary-only", {
    opencodeModel: "openai/gpt-4.1",
    opencodeFallbackModel: "",
  });
  const saved = await db.getAiChatConfig("primary-only");
  assert.equal(saved.opencodeModel, "openai/gpt-4.1");
  assert.equal(saved.opencodeFallbackModel, "");
});

await bai("T19", "Primary and fallback models are isolated by owner_uid", async () => {
  await db.saveAiChatConfig("model-a", {
    opencodeModel: "openai/primary-a",
    opencodeFallbackModel: "anthropic/fallback-a",
  });
  await db.saveAiChatConfig("model-b", {
    opencodeModel: "openai/primary-b",
    opencodeFallbackModel: "mistral/fallback-b",
  });
  assert.deepEqual(
    [
      (await db.getAiChatConfig("model-a")).opencodeModel,
      (await db.getAiChatConfig("model-a")).opencodeFallbackModel,
      (await db.getAiChatConfig("model-b")).opencodeModel,
      (await db.getAiChatConfig("model-b")).opencodeFallbackModel,
      (await db.getAiChatConfig("model-a")).opencodeModel,
    ],
    [
      "openai/primary-a",
      "anthropic/fallback-a",
      "openai/primary-b",
      "mistral/fallback-b",
      "openai/primary-a",
    ]
  );
});

await bai("T20", "Fresh DB migration order is P9, app_secrets, fallback, backfill, encryption", async () => {
  const p9 = dbSource.indexOf("await migrateP9ZaloUidProfile");
  const appSecrets = dbSource.indexOf("CREATE TABLE IF NOT EXISTS app_secrets");
  const fallback = dbSource.indexOf("ALTER TABLE ai_chat_config ADD COLUMN opencode_fallback_model");
  const backfill = dbSource.indexOf("await backfillFirstInviteSeenOnce();", fallback);
  const encrypt = dbSource.indexOf("await machHoaBiMatCu();", backfill);
  assert.ok(p9 >= 0 && appSecrets > p9 && fallback > appSecrets && backfill > fallback && encrypt > backfill);
  assert.ok(aiColumns().includes("opencode_fallback_model"));
  assert.ok(sqlDb.prepare("SELECT key FROM app_secrets WHERE key = ?").get("first_invite_backfill_done"));
});

await bai("T21", "Owner flags and both models persist across process-equivalent DB re-init", async () => {
  await db.saveAccountConfig("restart-owner", {
    setupData: { firstSetupInviteSeen: true, guidanceCompleted: true },
  });
  await db.saveAiChatConfig("restart-owner", {
    opencodeModel: "openai/restart-primary",
    opencodeFallbackModel: "mistral/restart-fallback",
  });
  await db.initDb();
  const account = await db.getAccountConfig("restart-owner");
  const ai = await db.getAiChatConfig("restart-owner");
  assert.equal(account.setupData.firstSetupInviteSeen, true);
  assert.equal(account.setupData.guidanceCompleted, true);
  assert.equal(ai.opencodeModel, "openai/restart-primary");
  assert.equal(ai.opencodeFallbackModel, "mistral/restart-fallback");
  assert.equal(publicOnboardingSource.includes("loginTimer"), false);
});

await bai("T22", "Assistant save with empty provider catalog cannot erase existing models", async () => {
  await db.saveAiChatConfig("model-protection", {
    opencodeModel: "openai/primary-existing",
    opencodeFallbackModel: "anthropic/fallback-existing",
  });
  await db.saveAiChatConfig("model-protection", {
    soul: "new soul",
    roleTone: "new tone",
    allowedTopics: "new topics",
    useKnowledge: false,
    knowledgeFileIds: [],
  });
  const saved = await db.getAiChatConfig("model-protection");
  assert.equal(saved.opencodeModel, "openai/primary-existing");
  assert.equal(saved.opencodeFallbackModel, "anthropic/fallback-existing");
  const assistantSubmit = publicConfigSource.slice(
    publicConfigSource.indexOf('form.addEventListener("submit"'),
    publicConfigSource.indexOf("// Nap lai danh sach nhom", publicConfigSource.indexOf('form.addEventListener("submit"'))
  );
  assert.equal(assistantSubmit.includes("opencodeModel"), false);
  assert.equal(assistantSubmit.includes("opencodeFallbackModel"), false);
});

await bai("T23", "Model and assistant save scopes preserve every unrelated field", async () => {
  await db.saveAccountConfig("scope-owner", { adminZaloUid: "admin-before" });
  await db.saveAiChatConfig("scope-owner", {
    soul: "soul-before",
    roleTone: "tone-before",
    allowedTopics: "topics-before",
    useKnowledge: true,
    knowledgeFileIds: [7, 8],
    opencodeModel: "openai/model-before",
    opencodeFallbackModel: "anthropic/fallback-before",
  });
  await db.saveAiChatConfig("scope-owner", {
    opencodeModel: "openai/model-after",
    opencodeFallbackModel: "",
  });
  let saved = await db.getAiChatConfig("scope-owner");
  assert.equal(saved.soul, "soul-before");
  assert.equal(saved.roleTone, "tone-before");
  assert.equal(saved.allowedTopics, "topics-before");
  assert.deepEqual(saved.knowledgeFileIds, [7, 8]);
  assert.equal((await db.getAccountConfig("scope-owner")).adminZaloUid, "admin-before");

  await db.saveAiChatConfig("scope-owner", {
    soul: "soul-after",
    roleTone: "tone-after",
    allowedTopics: "topics-after",
  });
  saved = await db.getAiChatConfig("scope-owner");
  assert.equal(saved.opencodeModel, "openai/model-after");
  assert.equal(saved.opencodeFallbackModel, "");
});

await bai("T24", "Fallback remains persistence-only with zero runtime failover path", async () => {
  const aiChatRuntime = fs.readFileSync(path.join(REPO, "lib", "ai-chat.js"), "utf8");
  const opencodeRuntime = fs.readFileSync(path.join(REPO, "lib", "opencode.js"), "utf8");
  assert.equal(aiChatRuntime.includes("opencodeFallbackModel"), false);
  assert.equal(opencodeRuntime.includes("opencodeFallbackModel"), false);
  assert.equal(serverSource.includes("primary fails"), false);
  assert.equal(dbSource.includes("opencode_fallback_model"), true);
});

sqlDb.close();
ui.dom.window.close();
process.chdir(ORIGINAL_CWD);
if (APP_SECRET_KEY_TRUOC === undefined) delete process.env.APP_SECRET_KEY;
else process.env.APP_SECRET_KEY = APP_SECRET_KEY_TRUOC;

for (const item of ketQua) {
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.ma} — ${item.moTa}`);
  if (!item.pass) console.log(item.error);
}
const passed = ketQua.filter((item) => item.pass).length;
console.log(`\nFOCUSED BOT COMMANDER PART 1: ${passed}/${ketQua.length} PASS`);
if (passed !== ketQua.length) process.exitCode = 1;
