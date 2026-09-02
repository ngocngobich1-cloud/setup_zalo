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
const PUBLIC_TRAINING_PATH = path.join(REPO, "public", "training.js");
const PUBLIC_APP_PATH = path.join(REPO, "public", "app.js");
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
const publicTrainingSource = fs.readFileSync(PUBLIC_TRAINING_PATH, "utf8");
const publicAppSource = fs.readFileSync(PUBLIC_APP_PATH, "utf8");
const cssDom = new JSDOM("<!doctype html><style></style>");
cssDom.window.document.querySelector("style").textContent = css;
const cssRules = [...cssDom.window.document.styleSheets[0].cssRules];

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

function styleRulesInMedia(conditionText) {
  return cssRules
    .filter((rule) => rule.type === cssDom.window.CSSRule.MEDIA_RULE && rule.conditionText === conditionText)
    .flatMap((rule) => [...rule.cssRules]);
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
  let onboardingGetCalls = 0;
  let onboardingAnswerCalls = 0;
  let trainingMessageCalls = 0;
  let pendingOnboardingGate = null;
  const ownerCredentialIds = new Set();
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
    connected: false,
    models: [{ id: "openai/gpt-4.1", label: "GPT-4.1", context: 100000, beta: false }],
  }];

  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    const method = String(options.method || "GET").toUpperCase();
    if (url === "/api/ai-chat/owner-credentials" && method === "GET") {
      return response(200, {
        providers: [...ownerCredentialIds].map((providerId) => ({
          providerId,
          providerName: providers.find((provider) => provider.id === providerId)?.name || providerId,
          connected: true,
          updatedAt: Date.now(),
        })),
      });
    }
    if (url === "/api/ai-chat/owner-credentials" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      ownerCredentialIds.add(body.providerId);
      mutationCalls += 1;
      return response(200, { ok: true, providerId: body.providerId, updatedAt: Date.now() });
    }
    if (url === "/api/ai-chat/owner-credentials/test" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      if (!ownerCredentialIds.has(body.providerId)) return response(400, { error: "CREDENTIAL_NOT_SAVED" });
      return response(200, { ok: true, model: `${body.providerId}/gpt-4.1`, reply: "OK" });
    }
    if (/^\/api\/ai-chat\/owner-credentials\//.test(url) && method === "DELETE") {
      ownerCredentialIds.delete(decodeURIComponent(url.split("/").pop()));
      mutationCalls += 1;
      return response(200, { ok: true });
    }
    if (url === "/api/ai-chat/owner-credentials" && method === "DELETE") {
      ownerCredentialIds.clear();
      mutationCalls += 1;
      return response(200, { ok: true });
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
      onboardingGetCalls += 1;
      const gate = pendingOnboardingGate;
      pendingOnboardingGate = null;
      if (gate) await gate.promise;
      return response(200, stateFor());
    }
    if (url === "/api/onboarding/action" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      actionCalls.push({ owner: currentOwner, action: body.action });
      const state = stateFor();
      if (body.action === "invite_seen") state.data.firstSetupInviteSeen = true;
      if (body.action === "start" && (state.completed || Number(state.step) === 0)) {
        const flags = {
          firstSetupInviteSeen: state.data?.firstSetupInviteSeen === true,
          guidanceCompleted: state.data?.guidanceCompleted === true,
        };
        state.step = 4;
        state.started = true;
        state.completed = false;
        state.prompt = "Bot Chỉ huy đã sẵn sàng.";
        state.data = flags;
      }
      return response(200, state);
    }
    if (url === "/api/onboarding/answer" && method === "POST") {
      onboardingAnswerCalls += 1;
      const body = JSON.parse(options.body || "{}");
      const state = stateFor();
      if (!state.data || typeof state.data !== "object") state.data = {};
      if (!Array.isArray(state.data.transcript)) state.data.transcript = [];
      state.data.transcript.push({ role: "user", content: body.text });
      state.data.transcript.push({ role: "assistant", content: `Bot explicit: ${body.text}` });
      state.step = Math.max(5, Number(state.step) || 0);
      state.started = true;
      state.prompt = `Bot explicit: ${body.text}`;
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
    if (url === "/api/training/message" && method === "POST") {
      trainingMessageCalls += 1;
      return response(200, { ok: true, reply: "Bot normal" });
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
    get onboardingAnswerCalls() { return onboardingAnswerCalls; },
    get onboardingGetCalls() { return onboardingGetCalls; },
    get trainingMessageCalls() { return trainingMessageCalls; },
    deferNextOnboardingGet() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      pendingOnboardingGate = { promise, release };
      return release;
    },
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
const publicTraining = await import(pathToFileURL(PUBLIC_TRAINING_PATH).href);
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

await bai("T7", "Common coach gate covers normal, explicit, rerender, dismissal and historical guidance", async () => {
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
  assert.equal(ui.document.querySelector("#onboarding-coach").classList.contains("hidden"), false);
  assert.equal(ui.document.querySelector("#onboarding-progress").classList.contains("hidden"), false);
});

await bai("T8", "Only the successful assistant-config branch completes guidance", async () => {
  const routeStart = serverSource.indexOf('app.post("/api/ai-chat"');
  const aiConnection = serverSource.indexOf('saveScope === "ai-connection"', routeStart);
  const connectionReturn = serverSource.indexOf("return res.json({", aiConnection);
  const guidance = serverSource.indexOf('"guidance_completed"', connectionReturn);
  const assistantResponse = serverSource.indexOf("res.json({", guidance);
  assert.ok(routeStart >= 0 && aiConnection > routeStart && connectionReturn > aiConnection);
  assert.ok(guidance > connectionReturn && assistantResponse > guidance);
  assert.equal(serverSource.slice(aiConnection, connectionReturn).includes("guidance_completed"), false);
  const adminRoute = serverSource.indexOf('app.post("/api/admin-zalo"');
  assert.equal(serverSource.slice(adminRoute, adminRoute + 1800).includes("guidance_completed"), false);
});

await bai("A1", "Completed setup can enter a clean explicit pass exactly once", async () => {
  ui.states.set("lane-a-completed", {
    step: "completed",
    started: true,
    completed: true,
    prompt: "old prompt",
    data: {
      firstSetupInviteSeen: true,
      guidanceCompleted: true,
      transcript: [{ role: "user", content: "old" }],
      draft: { soul: "old draft" },
    },
  });
  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("lane-a-completed");
  await publicOnboarding.datManHinhHuanLuyen(true);
  const before = ui.actionCalls.filter((entry) => entry.owner === "lane-a-completed" && entry.action === "start").length;
  ui.document.querySelector("#btn-training-setup").click();
  ui.document.querySelector("#btn-training-setup").click();
  await choDen(() => ui.document.querySelector("#module-training").dataset.trainingMode === "explicit", "manual setup did not enter explicit mode");
  const starts = ui.actionCalls.filter((entry) => entry.owner === "lane-a-completed" && entry.action === "start").length;
  assert.equal(starts - before, 1);
  assert.equal(ui.stateFor("lane-a-completed").completed, false);
  assert.equal(ui.stateFor("lane-a-completed").step, 4);
  assert.deepEqual(ui.stateFor("lane-a-completed").data, {
    firstSetupInviteSeen: true,
    guidanceCompleted: true,
  });
});

await bai("T2-LA", "Auto-entry baseline stays unchanged for completed and first-run owners", async () => {
  ui.states.set("lane-a-auto-completed", {
    step: "completed", started: true, completed: true, prompt: "", data: {
      firstSetupInviteSeen: true, guidanceCompleted: true,
    },
  });
  ui.routes.length = 0;
  const completedStarts = ui.actionCalls.filter((entry) => entry.owner === "lane-a-auto-completed" && entry.action === "start").length;
  await becomeOwner("lane-a-auto-completed", { justLoggedIn: true });
  assert.deepEqual(ui.routes.map((entry) => entry.target), ["zalo"]);
  assert.equal(ui.document.querySelector("#first-run-modal").classList.contains("hidden"), true);
  assert.equal(
    ui.actionCalls.filter((entry) => entry.owner === "lane-a-auto-completed" && entry.action === "start").length,
    completedStarts
  );

  ui.states.set("lane-a-auto-first", { step: 0, started: false, completed: false, prompt: "", data: {} });
  ui.routes.length = 0;
  await becomeOwner("lane-a-auto-first", { justLoggedIn: true });
  assert.deepEqual(ui.routes.map((entry) => entry.target), ["zalo"]);
  assert.equal(ui.document.querySelector("#first-run-modal").classList.contains("hidden"), false);
  assert.equal(ui.actionCalls.some((entry) => entry.owner === "lane-a-auto-first" && entry.action === "start"), false);
  ui.document.querySelector("#btn-onboarding-later").click();
  await choDen(() => ui.document.querySelector("#first-run-modal").classList.contains("hidden"), "first-run cleanup failed");
});

await bai("A2", "Pre-hydration double-click is queued and replayed once", async () => {
  ui.states.set("lane-a-deferred", {
    step: "completed", started: true, completed: true, prompt: "", data: {
      firstSetupInviteSeen: true, guidanceCompleted: true,
    },
  });
  publicTraining.invalidateTrainingOwnerState();
  ui.currentOwner = "lane-a-deferred";
  configModule.setSettingsOwnerUid("lane-a-deferred");
  const release = ui.deferNextOnboardingGet();
  const getBefore = ui.onboardingGetCalls;
  const sync = publicOnboarding.dongBoTrangThaiZalo({ loggedIn: true, justLoggedIn: false, ownerUid: "lane-a-deferred" });
  await choDen(() => ui.onboardingGetCalls === getBefore + 1, "deferred hydration did not start");
  ui.document.querySelector("#btn-training-setup").click();
  ui.document.querySelector("#btn-training-setup").click();
  release();
  await sync;
  await choDen(() => ui.document.querySelector("#module-training").dataset.trainingMode === "explicit", "queued setup intent was not replayed");
  assert.equal(
    ui.actionCalls.filter((entry) => entry.owner === "lane-a-deferred" && entry.action === "start").length,
    1
  );
  assert.equal(ui.onboardingGetCalls, getBefore + 1);
});

await bai("A3", "Normal and explicit composers remain route-isolated with chronological transcript", async () => {
  ui.states.set("lane-a-routes", {
    step: 4, started: true, completed: false, prompt: "Bot explicit đầu", data: { firstSetupInviteSeen: true },
  });
  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("lane-a-routes");
  await publicOnboarding.datManHinhHuanLuyen(true);
  const normalBefore = ui.trainingMessageCalls;
  const explicitBefore = ui.onboardingAnswerCalls;
  const setupBeforeNormal = structuredClone(ui.stateFor("lane-a-routes"));
  const form = ui.document.querySelector("#training-form");
  const input = ui.document.querySelector("#training-text");
  input.value = "Lời dặn thường";
  form.dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
  await choDen(() => ui.trainingMessageCalls === normalBefore + 1, "normal route was not called");
  await choDen(() => [...ui.document.querySelectorAll(".training-msg-body")].some((node) => node.textContent === "Bot normal"), "normal reply missing");
  assert.deepEqual(ui.stateFor("lane-a-routes"), setupBeforeNormal);

  ui.document.querySelector("#btn-training-setup").click();
  await choDen(() => ui.document.querySelector("#module-training").dataset.trainingMode === "explicit", "explicit route did not activate");
  input.value = "Câu trả lời explicit";
  form.dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
  await choDen(() => ui.onboardingAnswerCalls === explicitBefore + 1, "onboarding route was not called");
  await choDen(
    () => [...ui.document.querySelectorAll(".training-msg-body")].some((node) => node.textContent === "Bot explicit: Câu trả lời explicit"),
    "explicit reply missing"
  );
  assert.equal(ui.trainingMessageCalls, normalBefore + 1);
  const transcript = [...ui.document.querySelectorAll(".training-msg-body")].map((node) => node.textContent);
  const ordered = ["Lời dặn thường", "Bot normal", "Câu trả lời explicit", "Bot explicit: Câu trả lời explicit"];
  for (const text of ordered) assert.ok(transcript.includes(text), `Missing ${text}: ${JSON.stringify(transcript)}`);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(
      transcript.indexOf(ordered[index - 1]) < transcript.indexOf(ordered[index]),
      `Transcript order mismatch: ${JSON.stringify(transcript)}`
    );
  }
});

await bai("F1", "Explicit Setup preserves three complete interleaved user/assistant turns", async () => {
  ui.states.set("final-chronology", {
    step: 4, started: true, completed: false, prompt: "Bot mở đầu", data: { firstSetupInviteSeen: true, transcript: [] },
  });
  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("final-chronology");
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  const form = ui.document.querySelector("#training-form");
  const input = ui.document.querySelector("#training-text");
  const before = ui.onboardingAnswerCalls;
  for (let turn = 1; turn <= 3; turn += 1) {
    input.value = `USER-${turn}`;
    form.dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
    await choDen(() => ui.onboardingAnswerCalls === before + turn, `explicit turn ${turn} did not reach onboarding`);
    await choDen(
      () => [...ui.document.querySelectorAll(".training-msg-body")]
        .some((node) => node.textContent === `Bot explicit: USER-${turn}`),
      `explicit assistant turn ${turn} missing`
    );
  }
  const rendered = [...ui.document.querySelectorAll(".training-msg-body")].map((node) => node.textContent);
  const expected = [
    "USER-1", "Bot explicit: USER-1",
    "USER-2", "Bot explicit: USER-2",
    "USER-3", "Bot explicit: USER-3",
  ];
  const positions = expected.map((text) => rendered.indexOf(text));
  assert.ok(positions.every((position) => position >= 0), JSON.stringify(rendered));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  for (const text of expected.filter((_, index) => index % 2 === 1)) {
    assert.equal(rendered.filter((entry) => entry === text).length, 1, text);
  }
});

await bai("F2", "Assistant turns separated by a user remain distinct DOM rows", async () => {
  const rows = [...ui.document.querySelectorAll("#training-log .training-msg")];
  const bot1 = rows.find((row) => row.querySelector(".training-msg-body")?.textContent === "Bot explicit: USER-1");
  const bot2 = rows.find((row) => row.querySelector(".training-msg-body")?.textContent === "Bot explicit: USER-2");
  const user2 = rows.find((row) => row.querySelector(".training-msg-body")?.textContent === "USER-2");
  assert.ok(bot1 && user2 && bot2);
  assert.notEqual(bot1, bot2);
  assert.ok(rows.indexOf(bot1) < rows.indexOf(user2));
  assert.ok(rows.indexOf(user2) < rows.indexOf(bot2));
});

await bai("F4", "Completed Explicit composer cannot silently start a new pass", async () => {
  const completedData = {
    firstSetupInviteSeen: true,
    guidanceCompleted: true,
    transcript: [{ role: "assistant", content: "Đã hoàn tất" }],
    draft: { soul: "draft cũ", roleTone: "tone cũ", allowedTopics: "topics cũ" },
  };
  ui.states.set("final-completed-send", {
    step: "completed", started: true, completed: true, prompt: "", data: structuredClone(completedData),
  });
  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("final-completed-send");
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  const starts = ui.actionCalls.filter((entry) => entry.owner === "final-completed-send" && entry.action === "start").length;
  const answers = ui.onboardingAnswerCalls;
  const normal = ui.trainingMessageCalls;
  ui.document.querySelector("#training-text").value = "Không được tự restart";
  ui.document.querySelector("#training-form").dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
  await choDen(
    () => [...ui.document.querySelectorAll(".training-msg-body")]
      .some((node) => node.textContent.includes("Hãy bấm Thiết lập trợ lý")),
    "completed-state send did not show the canonical re-entry instruction"
  );
  assert.equal(ui.actionCalls.filter((entry) => entry.owner === "final-completed-send" && entry.action === "start").length, starts);
  assert.equal(ui.onboardingAnswerCalls, answers);
  assert.equal(ui.trainingMessageCalls, normal);
  assert.equal(ui.stateFor("final-completed-send").completed, true);
  assert.deepEqual(ui.stateFor("final-completed-send").data, completedData);
});

await bai("F5", "Completed owner manual re-entry still starts exactly one clean pass", async () => {
  ui.states.set("final-manual-reentry", {
    step: "completed", started: true, completed: true, prompt: "", data: {
      firstSetupInviteSeen: true, guidanceCompleted: true,
    },
  });
  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("final-manual-reentry");
  await publicOnboarding.datManHinhHuanLuyen(true);
  ui.document.querySelector("#btn-training-setup").click();
  ui.document.querySelector("#btn-training-setup").click();
  await choDen(() => ui.stateFor("final-manual-reentry").completed === false, "manual re-entry did not start");
  assert.equal(
    ui.actionCalls.filter((entry) => entry.owner === "final-manual-reentry" && entry.action === "start").length,
    1
  );
});

await bai("F6", "Queued pre-hydration Setup consumes first-run invite exactly once", async () => {
  ui.states.set("final-queued-invite", {
    step: 0, started: false, completed: false, prompt: "", data: { firstSetupInviteSeen: false },
  });
  publicTraining.invalidateTrainingOwnerState();
  ui.currentOwner = "final-queued-invite";
  configModule.setSettingsOwnerUid("final-queued-invite");
  const release = ui.deferNextOnboardingGet();
  const gets = ui.onboardingGetCalls;
  const sync = publicOnboarding.dongBoTrangThaiZalo({
    loggedIn: true, justLoggedIn: false, ownerUid: "final-queued-invite",
  });
  await choDen(() => ui.onboardingGetCalls === gets + 1, "queued owner hydration did not start");
  ui.document.querySelector("#btn-training-setup").click();
  ui.document.querySelector("#btn-training-setup").click();
  release();
  await sync;
  await choDen(() => ui.stateFor("final-queued-invite").data.firstSetupInviteSeen === true, "invite_seen was not persisted");
  const ownerActions = ui.actionCalls.filter((entry) => entry.owner === "final-queued-invite").map((entry) => entry.action);
  assert.equal(ownerActions.filter((action) => action === "start").length, 1);
  assert.equal(ownerActions.filter((action) => action === "invite_seen").length, 1);

  await publicOnboarding.dongBoTrangThaiZalo({
    loggedIn: true, justLoggedIn: true, ownerUid: "final-queued-invite",
  });
  await choTick(20);
  assert.equal(ui.document.querySelector("#first-run-modal").classList.contains("hidden"), true);
  assert.equal(
    ui.actionCalls.filter((entry) => entry.owner === "final-queued-invite" && entry.action === "invite_seen").length,
    1
  );
});

await bai("A4", "Invalid explicit state rehydrates once, errors visibly, and never falls through", async () => {
  ui.states.set("lane-a-invalid", {
    step: 8, started: true, completed: false, prompt: "", data: { firstSetupInviteSeen: true },
  });
  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("lane-a-invalid");
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  const gets = ui.onboardingGetCalls;
  const normal = ui.trainingMessageCalls;
  const explicit = ui.onboardingAnswerCalls;
  ui.document.querySelector("#training-text").value = "Không được rơi route";
  ui.document.querySelector("#training-form").dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
  await choDen(
    () => [...ui.document.querySelectorAll(".training-msg-body")].some((node) => node.textContent.startsWith("Lỗi: Tiến trình thiết lập")),
    "explicit recovery error was not visible"
  );
  assert.equal(ui.onboardingGetCalls, gets + 1);
  assert.equal(ui.trainingMessageCalls, normal);
  assert.equal(ui.onboardingAnswerCalls, explicit);
});

await bai("A5", "Step 7 discloses exactly which non-empty editor fields will be replaced", async () => {
  ui.states.set("lane-a-disclosure", {
    step: 7, started: true, completed: false, prompt: "Duyệt bản nháp", data: { firstSetupInviteSeen: true },
  });
  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("lane-a-disclosure");
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  ui.document.querySelector("#ai-soul").value = "Soul đang lưu";
  ui.document.querySelector("#ai-role").value = "Giọng đang lưu";
  ui.document.querySelector("#ai-topics").value = "";
  publicOnboarding.sauKhiDongCauHinh();
  await choTick(30);
  const disclosure = ui.document.querySelector("[data-onboarding-message]")?.textContent || "";
  assert.match(disclosure, /Bản thiết lập mới sẽ thay nội dung hiện đang có trong editor ở:/);
  assert.match(disclosure, /- Soul/);
  assert.match(disclosure, /- Giọng điệu và vai trò/);
  assert.equal(disclosure.includes("- Chủ đề được phép trả lời"), false);
});

await bai("A5B", "Step 8 stages draft only in the editor and canonical hydration restores saved config", async () => {
  ui.states.set("lane-a-autofill", {
    step: 8,
    started: true,
    completed: false,
    prompt: "",
    data: {
      firstSetupInviteSeen: true,
      draft: { soul: "Draft Soul", roleTone: "Draft role", allowedTopics: "Draft topics" },
    },
  });
  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("lane-a-autofill");
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  assert.equal(ui.document.querySelector("#ai-soul").value, "Draft Soul");
  assert.equal(ui.document.querySelector("#ai-role").value, "Draft role");
  assert.equal(ui.document.querySelector("#ai-topics").value, "Draft topics");

  await publicOnboarding.datManHinhHuanLuyen(false);
  assert.equal(await configModule.refreshAiChatConfigForCurrentOwner(), true);
  assert.equal(ui.document.querySelector("#ai-soul").value, "fixture");
  assert.equal(ui.document.querySelector("#ai-role").value, "warm");
  assert.equal(ui.document.querySelector("#ai-topics").value, "support");
});

await bai("A6", "Canonical owner invalidation resets transient starter consumption", async () => {
  ui.states.set("lane-a-owner-a", {
    step: 4, started: true, completed: false, prompt: "A", data: { firstSetupInviteSeen: true },
  });
  ui.states.set("lane-a-owner-b", {
    step: 4, started: true, completed: false, prompt: "B", data: { firstSetupInviteSeen: true },
  });
  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("lane-a-owner-a");
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  const starter = ui.document.querySelector("#onboarding-starters");
  assert.equal(starter.classList.contains("hidden"), false);
  const answers = ui.onboardingAnswerCalls;
  ui.document.querySelector("#btn-onboarding-starter").click();
  await choDen(() => ui.onboardingAnswerCalls === answers + 1, "owner A did not consume starter");
  assert.equal(starter.classList.contains("hidden"), true);

  publicTraining.invalidateTrainingOwnerState();
  await becomeOwner("lane-a-owner-b");
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  assert.equal(starter.classList.contains("hidden"), false);
  const invalidator = publicAppSource.slice(
    publicAppSource.indexOf("function invalidateOwnerFrontendState"),
    publicAppSource.indexOf("function renderShell")
  );
  assert.match(invalidator, /invalidateTrainingOwnerState\(\)/);
});

await bai("P0-STATIC", "Training and onboarding pre-save routes have zero assistant-config write authority", async () => {
  const onboardingRouteStart = serverSource.indexOf('app.post("/api/onboarding/answer"');
  const onboardingRouteEnd = serverSource.indexOf("/* --- XUONG HUAN LUYEN", onboardingRouteStart);
  const trainingRouteStart = serverSource.indexOf('app.post("/api/training/message"');
  const trainingRouteEnd = serverSource.indexOf('app.post("/api/training/synthesize"', trainingRouteStart);
  assert.equal(serverSource.slice(onboardingRouteStart, onboardingRouteEnd).includes("saveAiChatConfig"), false);
  assert.equal(serverSource.slice(trainingRouteStart, trainingRouteEnd).includes("saveAiChatConfig"), false);
  assert.equal(onboardingSource.includes("saveAiChatConfig"), false);
  assert.equal(fs.readFileSync(path.join(REPO, "lib", "training.js"), "utf8").includes("saveAiChatConfig"), false);
  assert.equal((serverSource.match(/saveAiChatConfig\(ownerUid/g) || []).length, 2);
  const connectionWrite = serverSource.slice(serverSource.indexOf("await saveAiChatConfig(ownerUid", serverSource.indexOf('saveScope === "ai-connection"')), serverSource.indexOf("await aiChat.refreshConfig()", serverSource.indexOf('saveScope === "ai-connection"')));
  assert.equal(/allowedTopics|roleTone|soul/.test(connectionWrite), false);
  const assistantSubmit = publicConfigSource.slice(publicConfigSource.indexOf('form.addEventListener("submit"'), publicConfigSource.indexOf("// Nap lai danh sach nhom", publicConfigSource.indexOf('form.addEventListener("submit"')));
  assert.match(assistantSubmit, /fetch\("\/api\/ai-chat"/);
  assert.match(assistantSubmit, /soul:\s*soulInput/);
  assert.match(assistantSubmit, /allowedTopics:\s*topicsInput/);
  assert.match(assistantSubmit, /roleTone:\s*roleInput/);
  assert.equal(publicOnboardingSource.includes('fetch("/api/ai-chat"'), false);
});

await bai("P0-BEHAVIOR", "Step 8 draft causes zero config write; reload stays original until explicit Save", async () => {
  const owner = "lane-a-write-authority";
  await db.saveAiChatConfig(owner, {
    soul: "Soul nguyên bản",
    roleTone: "Giọng nguyên bản",
    allowedTopics: "Chủ đề nguyên bản",
    opencodeModel: "openai/gpt-4.1",
  });
  await db.saveAccountConfig(owner, {
    setupStep: 9,
    setupCompleted: true,
    setupData: {
      firstSetupInviteSeen: true,
      guidanceCompleted: true,
      transcript: [{ role: "user", content: "stale" }],
      draft: { soul: "stale" },
    },
  });
  const restarted = await onboardingDb.xuLyHanhDongOnboarding(owner, "start");
  assert.equal(restarted.completed, false);
  assert.equal(Number(restarted.step), 4);
  assert.equal(restarted.data.firstSetupInviteSeen, true);
  assert.equal(restarted.data.guidanceCompleted, true);
  assert.deepEqual(restarted.data.transcript, []);
  assert.deepEqual(restarted.data.draft, { soul: "", roleTone: "", allowedTopics: "" });

  await db.saveAccountConfig(owner, {
    setupStep: 7,
    setupCompleted: false,
    setupData: {
      firstSetupInviteSeen: true,
      guidanceCompleted: true,
      phase: "final_review",
      draft: { soul: "Soul mới", roleTone: "Giọng mới", allowedTopics: "Chủ đề mới" },
    },
  });
  const selectConfigRow = () => sqlDb.prepare(
    "SELECT allowed_topics, role_tone, soul, updated_at FROM ai_chat_config WHERE owner_uid = ?"
  ).get(owner);
  const before = selectConfigRow();
  const step8 = await onboardingDb.traLoiOnboarding(owner, "OK");
  const afterDraft = selectConfigRow();
  assert.equal(Number(step8.step), 8);
  assert.deepEqual(afterDraft, before);
  const reloaded = await db.getAiChatConfig(owner);
  assert.equal(reloaded.soul, "Soul nguyên bản");
  assert.equal(reloaded.roleTone, "Giọng nguyên bản");
  assert.equal(reloaded.allowedTopics, "Chủ đề nguyên bản");

  await db.saveAiChatConfig(owner, {
    soul: step8.data.draft.soul,
    roleTone: step8.data.draft.roleTone,
    allowedTopics: step8.data.draft.allowedTopics,
  });
  const afterSave = await db.getAiChatConfig(owner);
  assert.equal(afterSave.soul, "Soul mới");
  assert.equal(afterSave.roleTone, "Giọng mới");
  assert.equal(afterSave.allowedTopics, "Chủ đề mới");
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
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+clamp\(480px,\s*36vw,\s*520px\)/
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
  await publicTraining.napHuanLuyen();
  await choDen(
    () => ui.document.querySelector("#training-key-provider")?.options.length > 1,
    "Training owner credential catalog did not load"
  );
  const block = ui.document.querySelector('[data-canonical-slot="api-key"]');
  assert.ok(block.querySelector("#training-key-provider"));
  assert.ok(block.querySelector("#training-key-value"));
  for (const label of ["Lưu key", "Thử key", "Gỡ key hãng này", "Gỡ tất cả key của tôi"]) {
    assert.ok([...block.querySelectorAll("button")].some((button) => button.textContent.trim() === label));
  }
  assert.ok(block.querySelector("#training-connected-providers"));
  assert.equal(block.textContent.includes("Mở Cấu hình"), false);
});

await bai("T14", "Block 2 controls follow saved-owner state", async () => {
  const provider = ui.document.querySelector("#training-key-provider");
  const input = ui.document.querySelector("#training-key-value");
  assert.equal(provider.disabled, false);
  assert.equal(input.disabled, false);
  assert.equal(ui.document.querySelector("#btn-training-key-save").disabled, true);
  assert.equal(ui.document.querySelector("#btn-training-key-test").disabled, true);
  assert.equal(ui.document.querySelector("#btn-training-key-delete").disabled, true);
  assert.equal(ui.document.querySelector("#btn-training-key-clear").disabled, true);
  provider.value = "openai";
  provider.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  input.value = "fixture-owner-key";
  input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  assert.equal(ui.document.querySelector("#btn-training-key-save").disabled, false);
});

await bai("T15", "Training Block 2 performs only owner-scoped credential actions", async () => {
  const before = ui.mutationCalls;
  ui.document.querySelector("#btn-training-key-save")
    .dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true }));
  await choDen(() => ui.mutationCalls === before + 1, "Training save did not use owner route");
  await choDen(() => !ui.document.querySelector("#btn-training-key-test").disabled, "Saved-key controls not enabled");

  ui.document.querySelector("#btn-training-key-test")
    .dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true }));
  await choTick(20);
  assert.equal(ui.mutationCalls, before + 1, "Test must not mutate credential sidecar");

  ui.document.querySelector("#btn-training-key-delete")
    .dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true }));
  await choDen(() => ui.mutationCalls === before + 2, "Selected delete did not use owner route");
  await choDen(
    () => !ui.document.querySelector("#training-key-provider").disabled,
    "Selected delete did not release credential controls"
  );

  const provider = ui.document.querySelector("#training-key-provider");
  const input = ui.document.querySelector("#training-key-value");
  provider.value = "openai";
  provider.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  input.value = "fixture-owner-key-again";
  input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  await choDen(() => !ui.document.querySelector("#btn-training-key-save").disabled, "Second save was not enabled");
  ui.document.querySelector("#btn-training-key-save")
    .dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true }));
  await choDen(() => ui.mutationCalls === before + 3, "Second owner save did not complete");
  await choDen(() => !ui.document.querySelector("#btn-training-key-clear").disabled, "Owner delete-all not enabled");
  ui.document.querySelector("#btn-training-key-clear")
    .dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true }));
  await choDen(() => ui.mutationCalls === before + 4, "Owner delete-all did not complete");
  await choDen(
    () => ui.document.querySelector("#training-connected-providers")?.textContent.includes("Chưa có kết nối."),
    "Owner empty status did not render"
  );
  assert.equal(publicConfigSource.includes("/api/ai-chat/provider-key"), false);
});

await bai("T16", "The Settings credential form is never portaled into Training", async () => {
  assert.equal(html.includes('id="onboarding-slot-api-key"'), false);
  assert.equal(publicOnboardingSource.includes('"#ai-key-provider", ".key-block"'), false);
  const liveGlobalKey = ui.document.querySelector("#ai-key-provider");
  assert.ok(liveGlobalKey);
  assert.equal(ui.document.querySelector("#module-training").contains(liveGlobalKey), false);
});

await bai("T17", "Block 2 renders neither secrets nor fake connected-provider state", async () => {
  const block = ui.document.querySelector('[data-canonical-slot="api-key"]');
  assert.equal(/(?:sk-|gsk_|AIza)[A-Za-z0-9_-]{8,}/.test(block.textContent), false);
  assert.equal(block.textContent.includes("fixture-owner-key"), false);
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
  assert.match(layCssBlock(css, ".training-layout"), /clamp\(480px,\s*36vw,\s*520px\)/);
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

await bai("UI01", "Desktop composer exposes Image, File, compact input and Send with one canonical file input", async () => {
  const rawDocument = new JSDOM(html).window.document;
  const form = rawDocument.querySelector("#training-form");
  assert.ok(form.querySelector(".training-tool-row #btn-training-attach"));
  assert.equal(form.querySelector("#btn-training-attach").textContent.trim(), "Ảnh");
  assert.equal(form.querySelector("#btn-training-attach-file").textContent.trim(), "Tệp");
  assert.equal(form.querySelectorAll('input[type="file"]').length, 1);
  assert.equal(rawDocument.querySelectorAll("#training-file-input").length, 1);
  assert.equal(form.querySelector("#training-text").getAttribute("rows"), "1");
  assert.equal(form.querySelector('button[type="submit"]').textContent.trim(), "Gửi");
  assert.equal(form.querySelector('button[type="submit"]').getAttribute("aria-label"), "Gửi tin nhắn");
});

await bai("UI02", "Normal header keeps Setup primary and renders the remaining actions as secondary", async () => {
  await publicOnboarding.datManHinhHuanLuyen(false);
  ui.states.set("ui-normal-header", {
    step: 0, started: false, completed: false, prompt: "", data: { firstSetupInviteSeen: true },
  });
  await becomeOwner("ui-normal-header");
  await publicOnboarding.datManHinhHuanLuyen(true);
  const setup = ui.document.querySelector("#btn-training-setup");
  assert.equal(ui.document.querySelector("#module-training").dataset.trainingMode, "normal");
  assert.equal(setup.classList.contains("primary-button"), true);
  assert.equal(setup.classList.contains("hidden"), false);
  for (const id of ["btn-training-synth", "btn-training-reset", "btn-training-config-toggle"]) {
    const button = ui.document.getElementById(id);
    assert.equal(button.classList.contains("secondary-button"), true, id);
    assert.equal(button.classList.contains("hidden"), false, id);
  }
  assert.match(layCssBlock(css, ".training-actions .secondary-button"), /background:\s*transparent/);
});

await bai("UI03", "Explicit setup header follows real state, shows progress, and hides normal actions", async () => {
  await publicOnboarding.datManHinhHuanLuyen(false);
  ui.states.set("ui-explicit-header", {
    step: 6,
    started: true,
    completed: false,
    prompt: "Đang duyệt nguyên tắc",
    data: { firstSetupInviteSeen: true, guidanceCompleted: false },
  });
  await becomeOwner("ui-explicit-header");
  await publicOnboarding.datManHinhHuanLuyen(true, { explicitSetup: true });
  const progress = ui.document.querySelector("#onboarding-progress");
  assert.equal(ui.document.querySelector("#module-training").dataset.trainingMode, "explicit");
  assert.equal(ui.document.querySelector("#training-title").textContent, "Thiết lập trợ lý");
  assert.equal(progress.classList.contains("hidden"), false);
  assert.equal(ui.document.querySelector("#onboarding-progress-text").textContent, "Bước 6 trên 9");
  assert.equal(progress.getAttribute("aria-valuenow"), "6");
  assert.equal(ui.document.querySelector("#btn-training-exit-setup").classList.contains("hidden"), false);
  for (const id of ["btn-training-setup", "btn-training-synth", "btn-training-reset"]) {
    assert.equal(ui.document.getElementById(id).classList.contains("hidden"), true, id);
  }
});

await bai("UI04", "Config header is quiet and contains no noncanonical generic copy", async () => {
  const rawDocument = new JSDOM(html).window.document;
  const header = rawDocument.querySelector(".training-config-header");
  assert.equal(header.querySelector(".training-config-kicker").textContent.trim(), "Cấu hình bot");
  assert.equal(header.textContent.includes("Dùng đúng cấu hình đang có"), false);
  assert.equal(header.querySelector("h3"), null);
});

await bai("UI05", "Eligible first invite renders the approved modal copy and actions", async () => {
  ui.states.set("ui-invite-eligible", { step: 0, started: false, completed: false, prompt: "", data: {} });
  await becomeOwner("ui-invite-eligible");
  const modal = ui.document.querySelector("#first-run-modal");
  assert.equal(modal.classList.contains("hidden"), false);
  assert.equal(modal.getAttribute("role"), "dialog");
  assert.equal(modal.getAttribute("aria-modal"), "true");
  assert.equal(modal.querySelector("#first-run-title").textContent.trim(), "Bắt đầu cài đặt trợ lý AI hỗ trợ bạn");
  assert.equal(modal.querySelector(".onboarding-first-run-copy").textContent.trim(), "Em sẽ hướng dẫn từng bước ngay trên những ô cấu hình sẵn có. Chị có thể dừng và tiếp tục vào lần sau.");
  assert.deepEqual(
    [...modal.querySelectorAll(".onboarding-first-run-actions button")].map((button) => button.textContent.trim()),
    ["Để sau", "Bắt đầu"]
  );
  assert.match(modal.querySelector(".onboarding-first-run-note").textContent, /chỉ hiện đúng một lần/);
  assert.equal(ui.document.activeElement, modal.querySelector("#btn-onboarding-start"));
  assert.match(css, /\.modal-content\.onboarding-first-run-card\s*\{[^}]*width:\s*min\(400px,[^}]*max-width:\s*400px/s);
});

await bai("UI06", "Already-seen invite remains hidden for its owner", async () => {
  ui.states.set("ui-invite-seen", {
    step: 0, started: false, completed: false, prompt: "", data: { firstSetupInviteSeen: true },
  });
  await becomeOwner("ui-invite-seen");
  assert.equal(ui.document.querySelector("#first-run-modal").classList.contains("hidden"), true);
});

await bai("UI07", "Popup actions reuse invite_seen, start and existing navigation handlers only", async () => {
  const beforeLater = ui.actionCalls.length;
  ui.states.set("ui-invite-later", { step: 0, started: false, completed: false, prompt: "", data: {} });
  await becomeOwner("ui-invite-later");
  await choDen(() => ui.stateFor("ui-invite-later").data.firstSetupInviteSeen === true, "invite_seen missing");
  ui.document.querySelector("#btn-onboarding-later").click();
  await choDen(() => ui.document.querySelector("#first-run-modal").classList.contains("hidden"), "Later did not close");
  assert.deepEqual(ui.actionCalls.slice(beforeLater).map((entry) => entry.action), ["invite_seen"]);

  const beforeStart = ui.actionCalls.length;
  ui.routes.length = 0;
  ui.states.set("ui-invite-start", { step: 0, started: false, completed: false, prompt: "", data: {} });
  await becomeOwner("ui-invite-start");
  await choDen(() => ui.stateFor("ui-invite-start").data.firstSetupInviteSeen === true, "start invite_seen missing");
  ui.document.querySelector("#btn-onboarding-start").click();
  await choDen(() => ui.routes.some((entry) => entry.target === "training"), "Start did not use Training route");
  assert.deepEqual(ui.actionCalls.slice(beforeStart).map((entry) => entry.action), ["invite_seen", "start"]);
  assert.equal(ui.routes.find((entry) => entry.target === "training")?.options.explicitSetup, true);
});

await bai("UI08", "Desktop config width is bounded to 480–520px and mobile removes the desktop grid", async () => {
  assert.match(
    layCssBlock(css, ".training-layout"),
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+clamp\(480px,\s*36vw,\s*520px\)/
  );
  const mobileStart = css.indexOf("@media (max-width: 980px)");
  const mobileEnd = css.indexOf("@media (max-width: 600px)", mobileStart);
  const mobileCss = css.slice(mobileStart, mobileEnd);
  assert.match(mobileCss, /\.training-layout,\s*\.training-layout\.training-config-collapsed\s*\{[^}]*display:\s*block/);
  assert.equal(mobileCss.includes("clamp(480px"), false);
});

await bai("UI09", "Mobile composer keeps 44px touch targets and safe-area padding", async () => {
  const mobileStart = css.indexOf("@media (max-width: 600px)");
  const mobileEnd = css.indexOf(".module-placeholder", mobileStart);
  const mobileCss = css.slice(mobileStart, mobileEnd);
  assert.match(mobileCss, /\.training-form\s*\{[^}]*env\(safe-area-inset-bottom\)/s);
  assert.match(mobileCss, /\.training-tool-action,\s*\.training-send-button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.training-mobile-segments button\s*\{[^}]*min-height:\s*44px/s);
});

await bai("UI09B", "Mobile Bot Commander has one scoped dynamic owner and four locked-shell rows", async () => {
  const mobile980Rules = styleRulesInMedia("(max-width: 980px)");
  const mobile600Rules = styleRulesInMedia("(max-width: 600px)");
  const mobile980Rule = (selector) => mobile980Rules.find((rule) => rule.selectorText === selector);
  const mobile600Rule = (selector) => mobile600Rules.find((rule) => rule.selectorText === selector);
  const botHeightScopes = cssRules
    .filter((rule) => rule.type === cssDom.window.CSSRule.MEDIA_RULE)
    .filter((rule) => [...rule.cssRules].some((child) => (
      child.selectorText === "#module-training:not(.hidden)" && child.style.height === "100dvh"
    )))
    .map((rule) => rule.conditionText);
  const botLockScopes = cssRules
    .filter((rule) => rule.type === cssDom.window.CSSRule.MEDIA_RULE)
    .filter((rule) => [...rule.cssRules].some((child) => (
      child.selectorText === "body:has(#module-training:not(.hidden))" && child.style.overflow === "hidden"
    )))
    .map((rule) => rule.conditionText);
  const desktopBodyRule = cssRules.find((rule) => rule.selectorText === "body");
  const root = ui.document.querySelector("#module-training");
  const panel = root?.querySelector(":scope > .training-layout > .training-command-panel");
  const header = panel?.querySelector(":scope > .training-header");
  const log = panel?.querySelector(":scope > #training-log");
  const starters = panel?.querySelector(":scope > #onboarding-starters");
  const form = panel?.querySelector(":scope > #training-form");

  assert.ok(root && panel && header && log && starters && form);
  assert.equal(panel.children.length, 4);
  assert.deepEqual([...panel.children], [header, log, starters, form]);
  assert.equal(log.contains(header), false);
  assert.equal(log.contains(starters), false);
  assert.equal(log.contains(form), false);

  assert.equal(desktopBodyRule?.style.getPropertyValue("min-height"), "100vh");
  assert.equal(
    mobile980Rule("body"),
    undefined,
    "body must keep its desktop base min-height throughout the 761-980px Inbox range",
  );
  assert.equal(mobile980Rule("#module-training:not(.hidden)")?.style.height, "100dvh");
  assert.equal(mobile980Rule("body:has(#module-training:not(.hidden))")?.style.overflow, "hidden");
  assert.deepEqual(botHeightScopes, ["(max-width: 980px)"]);
  assert.deepEqual(botLockScopes, ["(max-width: 980px)"]);
  assert.equal(mobile980Rule(".app-shell"), undefined, "Inbox shell must not change at the 980px breakpoint");
  assert.equal(
    cssRules.find((rule) => rule.selectorText === "#module-training:not(.hidden)"),
    undefined,
    "Bot Commander dynamic height must not escape its mobile media scope",
  );
  assert.match(
    mobile980Rule(".training-command-panel")?.style.getPropertyValue("grid-template-rows") || "",
    /^auto minmax\(0, 1fr\) auto auto$/,
  );
  assert.equal(
    mobile980Rule(".training-command-panel > #training-log")?.style.getPropertyValue("min-height"),
    "0",
  );
  assert.equal(
    cssRules.find((rule) => rule.selectorText === ".training-log")?.style.getPropertyValue("overflow-y"),
    "auto",
  );
  assert.match(
    mobile600Rule(".training-form")?.style.getPropertyValue("padding") || "",
    /env\(safe-area-inset-bottom\)/,
  );
});

await bai("UI10", "Both attachment actions reuse the canonical input without changing paste or send behavior", async () => {
  await publicOnboarding.datManHinhHuanLuyen(false);
  const fileInput = ui.document.querySelector("#training-file-input");
  const accepts = [];
  fileInput.addEventListener("click", () => accepts.push(fileInput.getAttribute("accept")));
  ui.document.querySelector("#btn-training-attach").click();
  ui.document.querySelector("#btn-training-attach-file").click();
  assert.equal(fileInput === ui.document.querySelector("#training-file-input"), true);
  assert.deepEqual(accepts, [
    "image/png,image/jpeg,image/webp,image/gif",
    "application/pdf,text/plain,text/markdown,text/csv",
  ]);
  assert.match(publicTrainingSource, /els\.text\.addEventListener\("paste"/);
  assert.match(publicTrainingSource, /event\.key !== "Enter" \|\| event\.shiftKey \|\| dangSoanIme/);
  assert.match(publicTrainingSource, /els\.form\.querySelector\("button\[type=submit\]"\)\.disabled = khoaLai/);
  assert.match(publicTrainingSource, /body\.append\("files", entry\.file \|\| entry\)/);
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
