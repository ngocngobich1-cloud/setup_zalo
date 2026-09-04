/**
 * C1-03 — App capability + configuration context. Provider-free.
 *
 * Chay tren host Node 24 ARM64:
 * node --import ./kiem-thu/node24-arm64-test-polyfills.js \
 *   --import ./kiem-thu/sqlite3-node24-test-register.js \
 *   ./kiem-thu/kiem-tra-c1-app-capability-context.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_SECRET = process.env.APP_SECRET_KEY;
const ORIGINAL_CONTEXT_ROOT = process.env.OPENCODE_CONTEXT_ROOT;
const ORIGINAL_FETCH = globalThis.fetch;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "c1-app-context-"));
const OWNER = "c1-owner";
const OTHER_OWNER = "c1-other-owner";
const results = [];
let providerCalls = 0;

async function test(code, description, run) {
  try {
    await run();
    results.push({ code, description, ok: true });
  } catch (error) {
    results.push({ code, description, ok: false, error });
  }
}

function source(relativePath) {
  return fs.readFileSync(path.join(REPO, relativePath), "utf8");
}

function moduleUrl(relativePath) {
  return pathToFileURL(path.join(REPO, relativePath)).href;
}

function functionSource(fullSource, name) {
  const start = fullSource.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const next = fullSource.indexOf("\nexport ", start + 1);
  return fullSource.slice(start, next === -1 ? undefined : next);
}

function byId(context, id) {
  const item = context.capabilities.find((candidate) => candidate.id === id);
  assert.ok(item, `Missing capability ${id}`);
  return item;
}

process.chdir(TEST_ROOT);
process.env.APP_SECRET_KEY = "c".repeat(64);
process.env.OPENCODE_CONTEXT_ROOT = path.join(TEST_ROOT, "opencode-context");
globalThis.fetch = async () => {
  providerCalls += 1;
  throw new Error("C1 App Context must not call a provider");
};

try {
  const db = await import(moduleUrl("lib/db.js"));
  await db.initDb();
  const appContext = await import(moduleUrl("lib/app-context.js"));
  const {
    AVAILABILITY,
    CONFIGURATION,
    CONFIGURATION_SCOPE,
    EXISTENCE_STATE,
    SETTING_STATE,
    ZALO_CONNECTION_STATE,
    ZALO_LOGIN_STATE,
    buildAppContext,
    buildAppContextWithReaders,
    configureZaloRuntimeReader,
    renderAppContext,
  } = appContext;

  function baseOverrides(patch = {}) {
    return {
      admin: async () => ({ uid: "", label: "" }),
      aiConfig: async () => ({
        opencodeModel: "",
        opencodeFallbackModel: "",
        opencodeFallbackCapabilities: [],
        opencodeFailoverEnabled: false,
        useKnowledge: false,
        knowledgeFileIds: [],
        soul: "",
        roleTone: "",
        allowedTopics: "",
      }),
      aiCredentialStatus: async () => [],
      capabilityRouting: async () => false,
      zaloRuntime: async () => ({ identityGate: "PASS", loggedIn: false, connectionState: "chua" }),
      accountBot: async () => ({ botEnabled: false }),
      knowledgeFiles: async () => [],
      autoReplyCount: async () => 0,
      pdfAutomationCount: async () => 0,
      scheduledMessageCount: async () => 0,
      zoom: async () => ({ readable: true, accountId: false, clientId: false, clientSecret: false, hostEmail: false }),
      website: async () => ({ readable: true, name: false, apiUrl: false, apiToken: false }),
      smtp: async () => ({ readable: true, hasHost: false, hasFromAddress: false }),
      zoho: async () => ({ readable: true, enabled: false, hasClientId: false, hasClientSecret: false, hasRefreshToken: false, hasAccountId: false }),
      ...patch,
    };
  }

  async function build(patch = {}) {
    return buildAppContextWithReaders(OWNER, baseOverrides(patch));
  }

  await test("C1-T01", "schema v3, signature and existing single App Context host stay intact", async () => {
    const context = await build();
    assert.equal(context.schemaVersion, 3);
    assert.equal(buildAppContext.length, 1);
    assert.equal(Array.isArray(context.capabilities), true);
    assert.equal(Array.isArray(context.integrationPaths), true);
  });

  await test("C1-T02", "Primary and Secondary require a credential for their own provider", async () => {
    const context = await build({
      aiConfig: async () => ({
        opencodeModel: "primary/model-a",
        opencodeFallbackModel: "secondary/model-b",
        opencodeFallbackCapabilities: [],
        opencodeFailoverEnabled: false,
        useKnowledge: false,
        knowledgeFileIds: [],
      }),
      aiCredentialStatus: async () => [{ providerId: "primary" }, { providerId: "secondary" }],
    });
    assert.equal(byId(context, "AI.primary").configuration, CONFIGURATION.CONFIGURED);
    assert.equal(byId(context, "AI.secondary").configuration, CONFIGURATION.CONFIGURED);
  });

  await test("C1-T03", "model without its provider credential is only partially configured", async () => {
    const context = await build({
      aiConfig: async () => ({
        opencodeModel: "primary/model-a",
        opencodeFallbackModel: "secondary/model-b",
        opencodeFallbackCapabilities: [],
        opencodeFailoverEnabled: false,
        useKnowledge: false,
        knowledgeFileIds: [],
      }),
      aiCredentialStatus: async () => [{ providerId: "primary" }],
    });
    assert.equal(byId(context, "AI.primary").configuration, CONFIGURATION.CONFIGURED);
    assert.equal(byId(context, "AI.secondary").configuration, CONFIGURATION.PARTIALLY_CONFIGURED);
  });

  await test("C1-T04", "empty models are not configured regardless of arbitrary credentials", async () => {
    for (const credentials of [[{ providerId: "arbitrary" }], []]) {
      const context = await build({ aiCredentialStatus: async () => credentials });
      assert.equal(byId(context, "AI.primary").configuration, CONFIGURATION.NOT_CONFIGURED);
      assert.equal(byId(context, "AI.secondary").configuration, CONFIGURATION.NOT_CONFIGURED);
    }
  });

  await test("C1-T05", "invalid non-empty model identity and AI reader errors are unknown", async () => {
    const invalid = await build({
      aiConfig: async () => ({
        opencodeModel: "invalid-model",
        opencodeFallbackModel: "/invalid",
        opencodeFallbackCapabilities: [],
        opencodeFailoverEnabled: false,
        useKnowledge: false,
        knowledgeFileIds: [],
      }),
    });
    assert.equal(byId(invalid, "AI.primary").configuration, CONFIGURATION.UNKNOWN);
    assert.equal(byId(invalid, "AI.secondary").configuration, CONFIGURATION.UNKNOWN);

    const configError = await build({ aiConfig: async () => { throw new Error("config unreadable"); } });
    assert.equal(byId(configError, "AI.primary").configuration, CONFIGURATION.UNKNOWN);
    assert.equal(byId(configError, "AI.secondary").configuration, CONFIGURATION.UNKNOWN);

    const credentialError = await build({
      aiConfig: async () => ({
        opencodeModel: "primary/model",
        opencodeFallbackModel: "secondary/model",
        opencodeFallbackCapabilities: [],
        opencodeFailoverEnabled: false,
        useKnowledge: false,
        knowledgeFileIds: [],
      }),
      aiCredentialStatus: async () => { throw new Error("credential status unreadable"); },
    });
    assert.equal(byId(credentialError, "AI.primary").configuration, CONFIGURATION.UNKNOWN);
    assert.equal(byId(credentialError, "AI.secondary").configuration, CONFIGURATION.UNKNOWN);
  });

  await test("C1-T06", "Secondary capability intent, global routing and owner failover stay distinct", async () => {
    const context = await build({
      aiConfig: async () => ({
        opencodeModel: "",
        opencodeFallbackModel: "",
        opencodeFallbackCapabilities: ["WEB_SEARCH", "IMAGE_INPUT"],
        opencodeFailoverEnabled: true,
        useKnowledge: false,
        knowledgeFileIds: [],
      }),
      capabilityRouting: async () => true,
    });
    assert.deepEqual(byId(context, "AI.secondaryCapabilities").details.configuredCapabilities, [
      "IMAGE_INPUT",
      "WEB_SEARCH",
    ]);
    assert.match(byId(context, "AI.secondaryCapabilities").details.semantics, /ý định đã cấu hình/);
    assert.equal(byId(context, "AI.capabilityRouting").details.state, SETTING_STATE.ENABLED);
    assert.equal(byId(context, "AI.capabilityRouting").configurationScope, CONFIGURATION_SCOPE.APP_GLOBAL);
    assert.equal(byId(context, "AI.runtimeFailover").details.state, SETTING_STATE.ENABLED);
    assert.equal(byId(context, "AI.runtimeFailover").configurationScope, CONFIGURATION_SCOPE.OWNER);
  });

  await test("C1-T07", "Zalo owner match maps all four connection states independently", async () => {
    const expected = new Map([
      ["song", ZALO_CONNECTION_STATE.CONNECTED],
      ["dang-noi", ZALO_CONNECTION_STATE.CONNECTING],
      ["chet", ZALO_CONNECTION_STATE.DISCONNECTED],
      ["chua", ZALO_CONNECTION_STATE.NOT_CONNECTED],
    ]);
    for (const [connectionState, projected] of expected) {
      configureZaloRuntimeReader({
        currentOwner: () => OWNER,
        loggedIn: () => true,
        connectionState: () => connectionState,
      });
      const overrides = baseOverrides();
      delete overrides.zaloRuntime;
      const context = await buildAppContextWithReaders(OWNER, overrides);
      assert.equal(byId(context, "Zalo.runtime").details.loggedIn, ZALO_LOGIN_STATE.LOGGED_IN);
      assert.equal(byId(context, "Zalo.runtime").details.connectionState, projected);
    }
  });

  await test("C1-T08", "Zalo null owner plus logged-out is provable and keeps real connection mapping", async () => {
    configureZaloRuntimeReader({
      currentOwner: () => null,
      loggedIn: () => false,
      connectionState: () => "chua",
    });
    const overrides = baseOverrides();
    delete overrides.zaloRuntime;
    const context = await buildAppContextWithReaders(OWNER, overrides);
    assert.deepEqual(byId(context, "Zalo.runtime").details, {
      loggedIn: ZALO_LOGIN_STATE.LOGGED_OUT,
      connectionState: ZALO_CONNECTION_STATE.NOT_CONNECTED,
    });
  });

  await test("C1-T09", "different active Zalo owner is gated before other runtime accessors", async () => {
    configureZaloRuntimeReader({
      currentOwner: () => OTHER_OWNER,
      loggedIn: () => { throw new Error("must not read mismatched owner state"); },
      connectionState: () => { throw new Error("must not read mismatched owner state"); },
    });
    const overrides = baseOverrides();
    delete overrides.zaloRuntime;
    const context = await buildAppContextWithReaders(OWNER, overrides);
    assert.deepEqual(byId(context, "Zalo.runtime").details, {
      loggedIn: ZALO_LOGIN_STATE.UNKNOWN,
      connectionState: ZALO_CONNECTION_STATE.UNKNOWN,
    });
  });

  await test("C1-T10", "unknown, errored and uninjected Zalo states fail safe", async () => {
    configureZaloRuntimeReader({
      currentOwner: () => OWNER,
      loggedIn: () => false,
      connectionState: () => "future-state",
    });
    let overrides = baseOverrides();
    delete overrides.zaloRuntime;
    const unknownConnection = await buildAppContextWithReaders(OWNER, overrides);
    assert.equal(byId(unknownConnection, "Zalo.runtime").details.connectionState, ZALO_CONNECTION_STATE.UNKNOWN);

    const readerError = await build({ zaloRuntime: async () => { throw new Error("runtime unreadable"); } });
    assert.equal(byId(readerError, "Zalo.runtime").details.loggedIn, ZALO_LOGIN_STATE.UNKNOWN);

    configureZaloRuntimeReader(null);
    overrides = baseOverrides();
    delete overrides.zaloRuntime;
    const uninjected = await buildAppContextWithReaders(OWNER, overrides);
    assert.deepEqual(byId(uninjected, "Zalo.runtime").details, {
      loggedIn: ZALO_LOGIN_STATE.UNKNOWN,
      connectionState: ZALO_CONNECTION_STATE.UNKNOWN,
    });
  });

  await test("C1-T11", "account-wide Bot state is owner-scoped and independent of per-thread Bot", async () => {
    const enabled = await build({ accountBot: async () => ({ botEnabled: true }) });
    const disabled = await build({ accountBot: async () => ({ botEnabled: false }) });
    const unknown = await build({ accountBot: async () => { throw new Error("bot config unreadable"); } });
    const enabledAccountBot = byId(enabled, "Bot.accountEnabled");
    assert.equal(enabledAccountBot.details.state, SETTING_STATE.ENABLED);
    assert.equal(byId(disabled, "Bot.accountEnabled").details.state, SETTING_STATE.DISABLED);
    assert.equal(byId(unknown, "Bot.accountEnabled").details.state, SETTING_STATE.UNKNOWN);
    assert.equal(enabledAccountBot.configurationScope, CONFIGURATION_SCOPE.OWNER);
    assert.equal(enabledAccountBot.label, "Công tắc Bot cấp tài khoản");
    assert.equal(enabledAccountBot.details.authorityScope, "ACCOUNT_LEVEL_ONLY");
    assert.equal(enabledAccountBot.details.perConversationState, "NOT_IN_C1_CONTEXT");
    assert.match(enabled.semantics.accountBotScope, /chỉ phản ánh công tắc Bot cấp tài khoản/i);
    assert.match(enabled.semantics.accountBotScope, /từng hội thoại có thể khác.*không nằm trong C1 context/i);
    assert.match(enabled.semantics.automationSeparation, /bốn dữ kiện độc lập/i);
    assert.doesNotMatch(JSON.stringify(enabledAccountBot), /"label":"Bot toàn bộ hội thoại"/i);
  });

  await test("C1-T12", "Knowledge reports enabled/existence and intersects selected IDs with existing owner files", async () => {
    const scenarios = [
      { selected: [1, 2], files: [{ id: 1 }, { id: 2 }], count: 2 },
      { selected: [1, 2, 999], files: [{ id: 1 }, { id: 2 }], count: 2 },
      { selected: [999], files: [{ id: 1 }], count: 0 },
    ];
    for (const scenario of scenarios) {
      const context = await build({
        aiConfig: async () => ({
          opencodeModel: "",
          opencodeFallbackModel: "",
          opencodeFallbackCapabilities: [],
          opencodeFailoverEnabled: false,
          useKnowledge: true,
          knowledgeFileIds: scenario.selected,
        }),
        knowledgeFiles: async () => scenario.files,
      });
      const details = byId(context, "Knowledge.configuration").details;
      assert.equal(details.enabled, SETTING_STATE.ENABLED);
      assert.equal(details.filesExist, EXISTENCE_STATE.EXISTS);
      assert.equal(details.selectedCount, scenario.count);
    }
  });

  await test("C1-T13", "Knowledge handles empty, disabled and reader-error states without stale inference", async () => {
    const empty = await build({
      aiConfig: async () => ({
        opencodeModel: "",
        opencodeFallbackModel: "",
        opencodeFallbackCapabilities: [],
        opencodeFailoverEnabled: false,
        useKnowledge: true,
        knowledgeFileIds: [123],
      }),
      knowledgeFiles: async () => [],
    });
    assert.deepEqual(byId(empty, "Knowledge.configuration").details, {
      enabled: SETTING_STATE.ENABLED,
      filesExist: EXISTENCE_STATE.DOES_NOT_EXIST,
      selectedCount: 0,
    });

    const disabled = await build();
    assert.equal(byId(disabled, "Knowledge.configuration").details.enabled, SETTING_STATE.DISABLED);

    const error = await build({ knowledgeFiles: async () => { throw new Error("knowledge unreadable"); } });
    assert.equal(byId(error, "Knowledge.configuration").details.filesExist, EXISTENCE_STATE.UNKNOWN);
    assert.equal(byId(error, "Knowledge.configuration").details.selectedCount, CONFIGURATION.UNKNOWN);
  });

  await test("C1-T14", "automation projections preserve RULE/ENABLED_RULE/PENDING count semantics", async () => {
    const none = await build();
    assert.equal(byId(none, "AutoReply.rules").configuration, CONFIGURATION.NOT_CONFIGURED);
    assert.equal(byId(none, "PdfAutomation.enabledRules").configuration, CONFIGURATION.NOT_CONFIGURED);
    assert.equal(byId(none, "Scheduling.pendingMessages").configuration, CONFIGURATION.NOT_CONFIGURED);

    const configured = await build({
      autoReplyCount: async () => 2,
      pdfAutomationCount: async () => 3,
      scheduledMessageCount: async () => 4,
    });
    assert.equal(byId(configured, "AutoReply.rules").configuration, CONFIGURATION.CONFIGURED);
    assert.equal(byId(configured, "AutoReply.rules").details.ruleCount, 2);
    assert.equal(byId(configured, "PdfAutomation.enabledRules").details.enabledRuleCount, 3);
    assert.equal(byId(configured, "Scheduling.pendingMessages").details.pendingCount, 4);

    const unreadable = async () => { throw new Error("count unreadable"); };
    const unknown = await build({
      autoReplyCount: unreadable,
      pdfAutomationCount: unreadable,
      scheduledMessageCount: unreadable,
    });
    for (const id of ["AutoReply.rules", "PdfAutomation.enabledRules", "Scheduling.pendingMessages"]) {
      assert.equal(byId(unknown, id).configuration, CONFIGURATION.UNKNOWN, id);
    }
  });

  await test("C1-T15", "DB automation readers execute owner-scoped COUNT-only semantics", async () => {
    const raw = new DatabaseSync(path.join(TEST_ROOT, "data", "zalo.db"));
    try {
      raw.prepare(`INSERT INTO auto_reply_rules
        (owner_uid, command, match_anywhere, normalize, reply_text, created_at)
        VALUES (?, ?, 0, 0, ?, ?)`).run(OWNER, "secret-command", "secret-reply", 1);
      raw.prepare(`INSERT INTO auto_reply_rules
        (owner_uid, command, match_anywhere, normalize, reply_text, created_at)
        VALUES (NULL, ?, 0, 0, ?, ?)`).run("legacy-command", "legacy-reply", 2);

      const insertPdf = raw.prepare(`INSERT INTO pdf_automation_rules
        (owner_uid, keyword, keyword_norm, pdf_name, pdf_mime, pdf_size, pdf_data, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'application/pdf', 4, ?, ?, 1, 1)`);
      insertPdf.run(OWNER, "secret-pdf-on", "secret-pdf-on", "secret-on.pdf", Buffer.from("pdf1"), 1);
      insertPdf.run(OWNER, "secret-pdf-off", "secret-pdf-off", "secret-off.pdf", Buffer.from("pdf2"), 0);
      insertPdf.run(OTHER_OWNER, "other-pdf", "other-pdf", "other.pdf", Buffer.from("pdf3"), 1);

      const insertSchedule = raw.prepare(`INSERT INTO lich_hen
        (dich_id, dich_ten, loai, noi_dung, luc_gui, lap_lai, trang_thai, cau_lenh, tao_luc, owner_uid)
        VALUES (?, ?, 'nick', ?, 1, '', ?, ?, 1, ?)`);
      insertSchedule.run("recipient-1", "secret-customer", "secret-message", "cho", "secret-action", OWNER);
      insertSchedule.run("recipient-2", "secret-customer", "secret-message", "da_gui", "secret-action", OWNER);
      insertSchedule.run("recipient-3", "legacy-customer", "legacy-message", "cho", "legacy-action", null);
    } finally {
      raw.close();
    }

    assert.equal(await db.getAutoReplyRuleCount(OWNER), 1);
    assert.equal(await db.getEnabledPdfAutomationRuleCount(OWNER), 1);
    assert.equal(await db.getPendingScheduledMessageCount(OWNER), 1);
    assert.equal(await db.getAutoReplyRuleCount(OTHER_OWNER), 0);
    assert.equal(await db.getPendingScheduledMessageCount(OTHER_OWNER), 0);

    const dbSource = source("lib/db.js");
    for (const name of [
      "getAutoReplyRuleCount",
      "getEnabledPdfAutomationRuleCount",
      "getPendingScheduledMessageCount",
    ]) {
      const readerSource = functionSource(dbSource, name);
      assert.match(readerSource, /SELECT COUNT\(\*\)/, name);
      assert.match(readerSource, /owner_uid\s*=\s*\?/, name);
      assert.doesNotMatch(readerSource, /\ball\s*\(/, name);
    }
    assert.match(functionSource(dbSource, "getEnabledPdfAutomationRuleCount"), /enabled\s*=\s*1/);
    assert.match(functionSource(dbSource, "getPendingScheduledMessageCount"), /trang_thai\s*=\s*'cho'/);
  });

  await test("C1-T16", "serialized context excludes secrets, owner IDs and raw business/runtime fields", async () => {
    const context = await build({
      admin: async () => ({ uid: "SECRET_ADMIN_UID", label: "SECRET_ADMIN_LABEL" }),
      aiConfig: async () => ({
        opencodeModel: "safe/model",
        opencodeFallbackModel: "safe/model-2",
        opencodeFallbackCapabilities: ["FILE_INPUT"],
        opencodeFailoverEnabled: true,
        useKnowledge: true,
        knowledgeFileIds: [7],
        content_md: "SECRET_KNOWLEDGE_BODY",
        clientSecret: "SECRET_CLIENT",
        refreshToken: "SECRET_REFRESH",
      }),
      aiCredentialStatus: async () => [{
        providerId: "safe",
        ownerUid: "SECRET_OWNER_UID",
        apiKey: "SECRET_API_KEY",
        secret_enc: "SECRET_CIPHER",
      }],
      zaloRuntime: async () => ({
        identityGate: "PASS",
        loggedIn: true,
        connectionState: "song",
        displayName: "SECRET_ZALO_NAME",
        cookie: "SECRET_COOKIE",
        qr: "SECRET_QR",
        lyDo: "SECRET_REASON",
      }),
      accountBot: async () => ({ botEnabled: true, password: "SECRET_PASSWORD" }),
      knowledgeFiles: async () => [{ id: 7, originalName: "SECRET_FILE_NAME", contentMd: "SECRET_BODY" }],
    });
    const serialized = JSON.stringify(context);
    for (const forbidden of [
      OWNER,
      "SECRET_ADMIN_UID",
      "SECRET_ADMIN_LABEL",
      "SECRET_OWNER_UID",
      "SECRET_API_KEY",
      "SECRET_CIPHER",
      "SECRET_KNOWLEDGE_BODY",
      "SECRET_CLIENT",
      "SECRET_REFRESH",
      "SECRET_ZALO_NAME",
      "SECRET_COOKIE",
      "SECRET_QR",
      "SECRET_REASON",
      "SECRET_PASSWORD",
      "SECRET_FILE_NAME",
      "SECRET_BODY",
      "secret-command",
      "secret-reply",
      "secret-on.pdf",
      "secret-customer",
      "secret-message",
      "secret-action",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.doesNotMatch(serialized, /"(?:ownerUid|clientSecret|apiToken|password|refreshToken|accessToken|authorization|cookie|imei|userAgent|reply_text|command|keyword|pdf_name|noi_dung|dich_ten|cau_lenh|content_md|lyDo|qr|displayName|myAvatar)"\s*:/i);
  });

  await test("C1-T17", "fresh builds observe changed authority state without cache", async () => {
    const live = { botEnabled: false, autoReplyCount: 0 };
    const overrides = baseOverrides({
      accountBot: async () => ({ botEnabled: live.botEnabled }),
      autoReplyCount: async () => live.autoReplyCount,
    });
    const first = await buildAppContextWithReaders(OWNER, overrides);
    live.botEnabled = true;
    live.autoReplyCount = 2;
    const second = await buildAppContextWithReaders(OWNER, overrides);
    assert.equal(byId(first, "Bot.accountEnabled").details.state, SETTING_STATE.DISABLED);
    assert.equal(byId(first, "AutoReply.rules").configuration, CONFIGURATION.NOT_CONFIGURED);
    assert.equal(byId(second, "Bot.accountEnabled").details.state, SETTING_STATE.ENABLED);
    assert.equal(byId(second, "AutoReply.rules").details.ruleCount, 2);
  });

  await test("C1-T18", "App Context build causes zero business/config mutations", async () => {
    const dbPath = path.join(TEST_ROOT, "data", "zalo.db");
    const snapshot = () => {
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return Object.fromEntries([
          "account_config",
          "ai_chat_config",
          "owner_provider_credentials",
          "knowledge_files",
          "auto_reply_rules",
          "pdf_automation_rules",
          "lich_hen",
        ].map((table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      } finally {
        raw.close();
      }
    };
    const before = snapshot();
    await build();
    const after = snapshot();
    assert.deepEqual(after, before);
  });

  await test("C1-T19", "navigation labels and scope semantics match the real UI", async () => {
    const context = await build();
    const labels = new Set(context.capabilities.flatMap((capability) =>
      capability.navigationPaths.map((navigation) => navigation.screenLabel).filter(Boolean)
    ));
    for (const label of [
      "Trả lời tự động",
      "AI Chat",
      "Tri thức",
      "Lịch hẹn",
      "Tự động gửi tài liệu",
      "Tài khoản",
    ]) {
      assert.equal(labels.has(label), true, label);
    }
    for (const id of [
      "AI.primary",
      "AI.secondary",
      "AI.secondaryCapabilities",
      "AI.runtimeFailover",
      "Bot.accountEnabled",
      "Knowledge.configuration",
      "AutoReply.rules",
      "PdfAutomation.enabledRules",
      "Scheduling.pendingMessages",
    ]) {
      assert.equal(byId(context, id).configurationScope, CONFIGURATION_SCOPE.OWNER, id);
    }
    assert.equal(byId(context, "Zalo.runtime").configurationScope, CONFIGURATION_SCOPE.RUNTIME_SINGLETON_WITH_IDENTITY_GATE);
  });

  await test("C1-T20", "static safety excludes raw readers, provider probes and Zalo static import", () => {
    const appContextSource = source("lib/app-context.js");
    assert.doesNotMatch(
      appContextSource,
      new RegExp([
        "getAutoReplyRules",
        "listPdfAutomationRules",
        "listLichHen",
        "getPublicState",
        "getOwnerProviderCredential\\b",
        "listOwnerProviderCredentialsForProjection",
        "getSmtpConfig",
        "getPdfAutomationRuleWithBlob",
        "getKnowledgeFileById",
        "getKnowledgeFilesByIds",
        "loadChatProviders",
        "webProbeCache",
      ].join("|"))
    );
    assert.doesNotMatch(appContextSource, /from\s+["']\.\/zalo-service\.js["']/);
    assert.doesNotMatch(appContextSource, /userMessage|message\.includes|includes\(["'](?:zoom|email|website)/i);
    for (const reader of [
      "aiConfig",
      "aiCredentialStatus",
      "zaloRuntime",
      "accountBot",
      "knowledgeFiles",
      "autoReplyCount",
      "pdfAutomationCount",
      "scheduledMessageCount",
    ]) {
      assert.match(appContextSource, new RegExp(`${reader}:`), reader);
      assert.match(appContextSource, new RegExp(`readers\\.${reader}`), reader);
    }
    const zaloSource = source("lib/zalo-service.js");
    assert.match(zaloSource, /configureZaloRuntimeReader\(\{[\s\S]*?currentOwner:\s*chuHienTai[\s\S]*?loggedIn:\s*isLoggedIn[\s\S]*?connectionState:\s*getConnectionState/);
    const accessor = zaloSource.slice(
      zaloSource.indexOf("export function getConnectionState"),
      zaloSource.indexOf("\nexport ", zaloSource.indexOf("export function getConnectionState") + 1)
    );
    assert.match(accessor, /ketNoi\?\.trangThai/);
    assert.doesNotMatch(accessor, /lyDo|uid|displayName|myAvatar|qr|cookie|imei|userAgent/);
  });

  await test("C1-T21", "rendered contract explains new factual states without claiming live model availability", async () => {
    const rendered = renderAppContext(await build());
    assert.match(rendered, /BEGIN_APP_CONTEXT_DATA/);
    assert.match(rendered, /END_APP_CONTEXT_DATA/);
    assert.match(rendered, /Danh sách phần việc của AI bổ trợ chỉ là ý định đã cấu hình/);
    assert.match(rendered, /Bot tổng của tài khoản hiện đang bật.*Bot tổng của tài khoản hiện đang tắt/);
    assert.match(rendered, /trạng thái Bot ở từng hội thoại có thể khác và không nằm trong context này/);
    assert.match(rendered, /giữ riêng bốn dữ kiện: công tắc Bot cấp tài khoản/);
    assert.doesNotMatch(rendered, /all conversations enabled|every conversation enabled|automatically replying in conversations/i);
    assert.doesNotMatch(rendered, /Bot toàn bộ hội thoại (?:của chị )?đang (?:bật|tắt)/i);
    assert.doesNotMatch(rendered, /mọi hội thoại đều bật|bot đang tự động phản hồi trong tất cả hội thoại/i);
    assert.match(rendered, /không nói WEB_SEARCH hiện hoạt động/i);
  });

  await test("C1-T22", "App Context performs zero real provider calls", () => {
    assert.equal(providerCalls, 0);
  });
} catch (error) {
  console.error("Khung C1 App Context test hong:", error);
  process.exitCode = 2;
} finally {
  process.chdir(ORIGINAL_CWD);
  configureCleanup();
}

function configureCleanup() {
  if (ORIGINAL_SECRET === undefined) delete process.env.APP_SECRET_KEY;
  else process.env.APP_SECRET_KEY = ORIGINAL_SECRET;
  if (ORIGINAL_CONTEXT_ROOT === undefined) delete process.env.OPENCODE_CONTEXT_ROOT;
  else process.env.OPENCODE_CONTEXT_ROOT = ORIGINAL_CONTEXT_ROOT;
  globalThis.fetch = ORIGINAL_FETCH;
}

for (const item of results) {
  console.log(`${item.ok ? "PASS" : "FAIL"} ${item.code} - ${item.description}`);
  if (!item.ok) console.log(`  -> ${item.error?.stack || item.error}`);
}
const passed = results.filter((item) => item.ok).length;
console.log(`\nC1 APP CAPABILITY CONTEXT = ${passed}/${results.length} PASS`);
console.log(`REAL_PROVIDER_CALLS_DURING_APP_CONTEXT_TEST = ${providerCalls}`);
if (passed !== results.length) process.exitCode = 1;
