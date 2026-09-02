/**
 * Lane B — App-Aware Guide. Provider-free: OpenCode la HTTP fixture noi bo,
 * khong goi Zoom/Website/SMTP/Zoho hoac model that.
 *
 * Chay tren host Node 24 ARM64:
 * node --import ./kiem-thu/node24-arm64-test-polyfills.js \
 *   --import ./kiem-thu/sqlite3-node24-test-register.js \
 *   ./kiem-thu/kiem-tra-bot-commander-lane-b-app-aware.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_SECRET = process.env.APP_SECRET_KEY;
const ORIGINAL_CONTEXT_ROOT = process.env.OPENCODE_CONTEXT_ROOT;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bot-commander-lane-b-"));
const OWNER = "lane-b-owner";
const results = [];

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

function byId(context, id) {
  const found = context.capabilities.find((item) => item.id === id);
  assert.ok(found, `Missing capability ${id}`);
  return found;
}

function navigationByKind(capability, kind) {
  const found = capability.navigationPaths.find((item) => item.kind === kind);
  assert.ok(found, `Missing ${kind} navigation for ${capability.id}`);
  return found;
}

function parseContextPart(body) {
  const text = String(body?.parts?.[0]?.text || "");
  const match = text.match(/BEGIN_APP_CONTEXT_DATA\n([^\n]+)\nEND_APP_CONTEXT_DATA/);
  assert.ok(match, "Khong tim thay safe App Context delimiter trong part 1");
  return JSON.parse(match[1]);
}

const BUSINESS_TABLES = [
  "account_config",
  "ai_chat_config",
  "ai_runtime_config",
  "app_secrets",
  "smtp_config",
  "zoho_config",
  "lich_hen",
  "knowledge_files",
  "auto_reply_rules",
  "pdf_automation_rules",
  "owner_provider_credentials",
];

function businessSnapshot() {
  const db = new DatabaseSync(path.join(TEST_ROOT, "data", "zalo.db"), { readOnly: true });
  try {
    const existing = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    );
    return Object.fromEntries(
      BUSINESS_TABLES.filter((table) => existing.has(table)).map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ])
    );
  } finally {
    db.close();
  }
}

function allToolsDisabled(tools) {
  return tools && Object.keys(tools).length > 0 && Object.values(tools).every((value) => value === false);
}

process.chdir(TEST_ROOT);
process.env.APP_SECRET_KEY = "a".repeat(64);
process.env.OPENCODE_CONTEXT_ROOT = path.join(TEST_ROOT, "opencode-context");
fs.mkdirSync(process.env.OPENCODE_CONTEXT_ROOT, { recursive: true });

let fixtureServer;
try {
  const db = await import(moduleUrl("lib/db.js"));
  await db.initDb();

  await db.saveAiChatConfig(OWNER, {
    allowedTopics: "LANE_B_ALLOWED_TOPICS_BODY_MUST_NOT_LEAK",
    roleTone: "LANE_B_ROLE_TONE_BODY_MUST_NOT_LEAK",
    soul: "LANE_B_SOUL_BODY_MUST_NOT_LEAK",
    opencodeModel: "fake/model",
  });
  await db.setAdminZalo(OWNER, "admin-zalo-lane-b", "Admin fixture");
  await db.saveSmtpConfig({
    host: "smtp.fixture.test",
    port: 587,
    secure: false,
    username: "otp-user",
    password: "SMTP_SECRET_MUST_NOT_LEAK",
    fromAddress: "otp@fixture.test",
  });
  await db.saveZohoConfig({
    vung: "com",
    clientId: "ZOHO_CLIENT_ID_MUST_NOT_LEAK",
    clientSecret: "ZOHO_CLIENT_SECRET_MUST_NOT_LEAK",
    refreshToken: "ZOHO_REFRESH_TOKEN_MUST_NOT_LEAK",
    accountId: "zoho-account-fixture",
    diaChi: "mail@fixture.test",
    bat: true,
  });
  for (const [key, value] of Object.entries({
    zoom_account_id: "ZOOM_ACCOUNT_ID_MUST_NOT_LEAK",
    zoom_client_id: "ZOOM_CLIENT_ID_MUST_NOT_LEAK",
    zoom_client_secret: "ZOOM_CLIENT_SECRET_MUST_NOT_LEAK",
    zoom_host_email: "zoom@fixture.test",
    website_connection_name: "Fixture Website",
    website_api_url: "https://website.fixture.test/api/customers",
    website_api_token: "WEBSITE_TOKEN_MUST_NOT_LEAK",
  })) {
    await db.setAppSecret(key, value);
  }

  const appContextModule = await import(moduleUrl("lib/app-context.js"));
  const {
    AVAILABILITY,
    CONFIGURATION,
    CONFIGURATION_SCOPE,
    NAVIGATION_KIND,
    buildAppContext,
    buildAppContextWithReaders,
    renderAppContext,
  } = appContextModule;

  let configuredContext;
  await test("B1-T1", "worktree authority remains the requested branch/head", () => {
    const worktreePointer = fs.readFileSync(path.join(REPO, ".git"), "utf8").trim();
    const gitdirMatch = worktreePointer.match(/^gitdir:\s*(.+)$/i);
    assert.ok(gitdirMatch, "Expected this checkout to be a linked worktree");
    const gitdir = path.resolve(gitdirMatch[1]);
    const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    assert.equal(head, "ref: refs/heads/feature/bot-commander-part1");
    const commonDir = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim());
    const commit = fs.readFileSync(path.join(commonDir, "refs", "heads", "feature", "bot-commander-part1"), "utf8").trim();
    assert.equal(commit, "2a0202fed71ea97e637c98d3f8c1d4559f4b2402");
    assert.equal(path.basename(REPO), "zalo-web-bot-commander-part1");
  });

  await test("B1-T2", "capability truth table is granular and complete", async () => {
    configuredContext = await buildAppContext(OWNER);
    const expected = {
      "Zoom.createOneTimeMeeting": AVAILABILITY.AVAILABLE,
      "Zoom.createRecurringMeeting": AVAILABILITY.NOT_AVAILABLE,
      "Zoom.listMeetings": AVAILABILITY.AVAILABLE,
      "Zoom.editOrDeleteOneTimeMeeting": AVAILABILITY.AVAILABLE,
      "Zoom.editOrDeleteRecurringMeeting": AVAILABILITY.NOT_AVAILABLE,
      "Scheduling.recurringFixedText": AVAILABILITY.AVAILABLE,
      "Scheduling.zaloNativeReminderRecurring": AVAILABILITY.AVAILABLE,
      "Scheduling.executeDynamicCommandAtRuntime": AVAILABILITY.NOT_AVAILABLE,
      "AdminCommand.enabled": AVAILABILITY.AVAILABLE,
      "Website.pullCustomers": AVAILABILITY.AVAILABLE,
      "Website.realtimeRegistrationTrigger": AVAILABILITY.NOT_AVAILABLE,
      "Email.internalOtpTransport": AVAILABILITY.AVAILABLE,
      "Email.sendToCustomer": AVAILABILITY.NOT_AVAILABLE,
      "Zoho.lookupMail": AVAILABILITY.AVAILABLE,
      "Assistant.soul": AVAILABILITY.AVAILABLE,
      "Assistant.roleTone": AVAILABILITY.AVAILABLE,
      "Assistant.allowedTopics": AVAILABILITY.AVAILABLE,
    };
    assert.deepEqual(
      Object.fromEntries(configuredContext.capabilities.map((item) => [item.id, item.availability])),
      expected
    );
  });

  await test("B1-T3", "global and owner configuration scopes match production authorities", () => {
    for (const id of [
      "Zoom.createOneTimeMeeting",
      "Zoom.listMeetings",
      "Zoom.editOrDeleteOneTimeMeeting",
      "Website.pullCustomers",
      "Email.internalOtpTransport",
      "Zoho.lookupMail",
    ]) {
      assert.equal(byId(configuredContext, id).configurationScope, CONFIGURATION_SCOPE.APP_GLOBAL, id);
    }
    for (const id of ["AdminCommand.enabled", "Assistant.soul", "Assistant.roleTone", "Assistant.allowedTopics"]) {
      assert.equal(byId(configuredContext, id).configurationScope, CONFIGURATION_SCOPE.OWNER, id);
    }
    for (const id of [
      "AdminCommand.enabled",
      "Zoom.createOneTimeMeeting",
      "Website.pullCustomers",
      "Email.internalOtpTransport",
      "Zoho.lookupMail",
      "Assistant.soul",
      "Assistant.roleTone",
      "Assistant.allowedTopics",
    ]) {
      assert.equal(byId(configuredContext, id).configuration, CONFIGURATION.CONFIGURED, id);
    }
  });

  await test("B1-T4", "resolver failures preserve UNKNOWN instead of false absence", async () => {
    const unreadable = async () => { throw new Error("fixture unreadable"); };
    const unknown = await buildAppContextWithReaders(OWNER, {
      admin: unreadable,
      assistant: unreadable,
      zoom: unreadable,
      website: unreadable,
      smtp: unreadable,
      zoho: unreadable,
    });
    for (const id of [
      "AdminCommand.enabled",
      "Zoom.createOneTimeMeeting",
      "Website.pullCustomers",
      "Email.internalOtpTransport",
      "Zoho.lookupMail",
      "Assistant.soul",
    ]) {
      assert.equal(byId(unknown, id).configuration, CONFIGURATION.UNKNOWN, id);
    }

    const partial = await buildAppContextWithReaders(OWNER, {
      zoom: async () => ({ readable: true, accountId: true, clientId: false, clientSecret: false, hostEmail: false }),
    });
    assert.equal(byId(partial, "Zoom.createOneTimeMeeting").configuration, CONFIGURATION.PARTIALLY_CONFIGURED);

    const raw = new DatabaseSync(path.join(TEST_ROOT, "data", "zalo.db"));
    try {
      raw.prepare("UPDATE app_secrets SET value = ? WHERE key IN (?, ?)")
        .run("v1:broken", "zoom_client_secret", "website_api_token");
      raw.prepare("UPDATE smtp_config SET password = ? WHERE id = 1").run("v1:broken");
      raw.prepare("UPDATE zoho_config SET refresh_token = ? WHERE id = 1").run("v1:broken");
    } finally {
      raw.close();
    }
    try {
      const decryptFailure = await buildAppContext(OWNER);
      for (const id of [
        "Zoom.createOneTimeMeeting",
        "Website.pullCustomers",
        "Email.internalOtpTransport",
        "Zoho.lookupMail",
      ]) {
        assert.equal(byId(decryptFailure, id).configuration, CONFIGURATION.UNKNOWN, id);
      }
    } finally {
      await db.setAppSecret("zoom_client_secret", "ZOOM_CLIENT_SECRET_MUST_NOT_LEAK");
      await db.setAppSecret("website_api_token", "WEBSITE_TOKEN_MUST_NOT_LEAK");
      await db.saveSmtpConfig({
        host: "smtp.fixture.test",
        port: 587,
        secure: false,
        username: "otp-user",
        password: "SMTP_SECRET_MUST_NOT_LEAK",
        fromAddress: "otp@fixture.test",
      });
      await db.saveZohoConfig({ refreshToken: "ZOHO_REFRESH_TOKEN_MUST_NOT_LEAK" });
    }
  });

  await test("B1-T5", "navigation distinguishes screen, fixed syntax and natural language", () => {
    assert.equal(byId(configuredContext, "AdminCommand.enabled").navigationPaths[0].kind, NAVIGATION_KIND.SCREEN);
    assert.ok(navigationByKind(byId(configuredContext, "Zoom.createOneTimeMeeting"), NAVIGATION_KIND.CHAT_COMMAND_FIXED_SYNTAX));
    assert.equal(byId(configuredContext, "Scheduling.recurringFixedText").navigationPaths[0].kind, NAVIGATION_KIND.CHAT_COMMAND_NATURAL_LANGUAGE);
    assert.equal(byId(configuredContext, "Scheduling.zaloNativeReminderRecurring").navigationPaths[0].kind, NAVIGATION_KIND.CHAT_COMMAND_NATURAL_LANGUAGE);
  });

  await test("B1-T6", "Admin gate has configured/not-configured owner states and private-chat constraint", async () => {
    assert.equal(byId(configuredContext, "AdminCommand.enabled").configuration, CONFIGURATION.CONFIGURED);
    const noAdmin = await buildAppContextWithReaders(OWNER, {
      admin: async () => ({ uid: "", label: "" }),
    });
    assert.equal(byId(noAdmin, "AdminCommand.enabled").configuration, CONFIGURATION.NOT_CONFIGURED);
    assert.match(byId(noAdmin, "AdminCommand.enabled").constraints.join(" "), /chat riêng.*đúng nick Zalo Admin/i);
    const rendered = renderAppContext(noAdmin);
    assert.match(rendered, /Nếu nick Admin chưa được khai báo và người dùng muốn nhắn lệnh/);
    assert.match(rendered, /Điều khiển bot qua Zalo/);
  });

  await test("B1-T7", "dat_lich and dat_nhac keep distinct recurrence contracts", () => {
    assert.deepEqual(byId(configuredContext, "Scheduling.recurringFixedText").details.recurrence, ["", "hang_ngay", "hang_tuan"]);
    assert.deepEqual(byId(configuredContext, "Scheduling.zaloNativeReminderRecurring").details.recurrence, ["", "hang_ngay", "hang_tuan", "hang_thang"]);
  });

  await test("B1-T8", "building context performs zero business/config writes", async () => {
    const before = businessSnapshot();
    await buildAppContext(OWNER);
    const after = businessSnapshot();
    assert.deepEqual(after, before);
  });

  await test("B1-T9", "safe projection redacts secrets and owner content bodies", () => {
    const serialized = JSON.stringify(configuredContext);
    for (const forbidden of [
      "ZOOM_ACCOUNT_ID_MUST_NOT_LEAK",
      "ZOOM_CLIENT_ID_MUST_NOT_LEAK",
      "ZOOM_CLIENT_SECRET_MUST_NOT_LEAK",
      "WEBSITE_TOKEN_MUST_NOT_LEAK",
      "SMTP_SECRET_MUST_NOT_LEAK",
      "ZOHO_CLIENT_ID_MUST_NOT_LEAK",
      "ZOHO_CLIENT_SECRET_MUST_NOT_LEAK",
      "ZOHO_REFRESH_TOKEN_MUST_NOT_LEAK",
      "LANE_B_SOUL_BODY_MUST_NOT_LEAK",
      "LANE_B_ROLE_TONE_BODY_MUST_NOT_LEAK",
      "LANE_B_ALLOWED_TOPICS_BODY_MUST_NOT_LEAK",
      OWNER,
      "admin-zalo-lane-b",
      "Admin fixture",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.doesNotMatch(serialized, /"(?:clientSecret|apiToken|password|refreshToken|accessToken|authorization|cookie)"\s*:/i);
  });

  await test("B1-T10", "negative capabilities are tied to production source behavior", () => {
    const zoomSource = source("lib/zoom.js");
    assert.match(zoomSource, /body:\s*JSON\.stringify\(\{[\s\S]*?type:\s*2,/);
    assert.doesNotMatch(zoomSource, /type:\s*8\b/);

    const schedulerSource = source("lib/scheduler.js");
    assert.match(schedulerSource, /text:\s*lich\.noiDung/);
    assert.doesNotMatch(schedulerSource, /cau_?lenh|from\s+["']\.\/zoom\.js["']|taoZoomMeeting/);

    const serverSource = source("server.js");
    const websiteRoutes = [...serverSource.matchAll(/app\.(get|post|put|patch|delete)\(\s*"(\/api\/website[^"]*)"/g)]
      .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
      .sort();
    assert.deepEqual(websiteRoutes, [
      "GET /api/website",
      "GET /api/website/customers",
      "POST /api/website/kiem-tra",
      "POST /api/website/luu",
      "POST /api/website/ngat",
    ]);

    const sendCallers = fs.readdirSync(path.join(REPO, "lib"))
      .filter((name) => name.endsWith(".js") && name !== "email-sender.js")
      .filter((name) => /\bsendEmail\s*\(/.test(source(path.join("lib", name))));
    assert.deepEqual(sendCallers, ["otp.js"]);
  });

  await test("B1-T11", "provider API has no user-message keyword router", () => {
    const appContextSource = source("lib/app-context.js");
    assert.match(appContextSource, /buildAppContext\(ownerAuthority\)/);
    assert.doesNotMatch(appContextSource, /userMessage|message\.includes|includes\(["'](?:zoom|email|website)/i);
    assert.equal(buildAppContext.length, 1);
  });

  await test("B1-T12", "verified natural-language examples and destination semantics come from source", () => {
    const adminSource = source("lib/admin-command.js");
    for (const example of [
      "nhắc cả lớp 15h mai vào zoom",
      "đặt lời nhắc 8h thứ 2 hằng tuần họp lớp",
      "8h sáng 10/8 gửi nhóm: mn cho em xin cảm nhận",
      "14h nhắn chị Tú Anh link zoom",
    ]) {
      assert.ok(adminSource.includes(example), example);
    }
    assert.match(byId(configuredContext, "Scheduling.recurringFixedText").constraints.join(" "), /Một bản ghi lịch có đúng một đích/);
  });

  await test("P1-T1", "Zoom one-time capabilities expose truthful multi-path navigation", () => {
    assert.equal(configuredContext.schemaVersion, 2);
    const create = byId(configuredContext, "Zoom.createOneTimeMeeting");
    const manage = byId(configuredContext, "Zoom.editOrDeleteOneTimeMeeting");
    const list = byId(configuredContext, "Zoom.listMeetings");
    assert.deepEqual(create.navigationPaths.map((item) => item.kind), [
      NAVIGATION_KIND.SCREEN,
      NAVIGATION_KIND.CHAT_COMMAND_FIXED_SYNTAX,
    ]);
    assert.deepEqual(manage.navigationPaths.map((item) => item.kind), [
      NAVIGATION_KIND.SCREEN,
      NAVIGATION_KIND.CHAT_COMMAND_FIXED_SYNTAX,
    ]);
    assert.deepEqual(list.navigationPaths.map((item) => item.kind), [NAVIGATION_KIND.SCREEN]);

    const createScreen = navigationByKind(create, NAVIGATION_KIND.SCREEN);
    const manageScreen = navigationByKind(manage, NAVIGATION_KIND.SCREEN);
    assert.deepEqual(
      [createScreen.screenLabel, createScreen.sectionLabel, createScreen.actionLabel],
      ["Zoom", "Lịch Zoom", "Tạo cuộc họp"]
    );
    assert.deepEqual(manageScreen.actionLabels, ["Sửa lịch", "Xóa lịch"]);

    const zoomUi = source("public/zoom.js");
    for (const label of ["Lịch Zoom", "Tạo cuộc họp", "Sửa lịch", "Xóa lịch"]) {
      assert.ok(zoomUi.includes(label), label);
    }
    const serverSource = source("server.js");
    for (const route of [
      'app.get("/api/zoom/cuoc-hop"',
      'app.post("/api/zoom/tao-cuoc-hop"',
      'app.patch("/api/zoom/cuoc-hop/:meetingId"',
      'app.delete("/api/zoom/cuoc-hop/:meetingId"',
    ]) {
      assert.ok(serverSource.includes(route), route);
    }
  });

  await test("P1-T2", "rendered guide policy prefers direct Zoom screen navigation", () => {
    const rendered = renderAppContext(configuredContext);
    assert.match(rendered, /Nếu một việc có đường làm trực tiếp trên màn hình, hướng dẫn đường đó trước/);
    assert.match(rendered, /Chị vào Zoom → Lịch Zoom → Tạo cuộc họp/);
    for (const id of ["Zoom.createOneTimeMeeting", "Zoom.listMeetings", "Zoom.editOrDeleteOneTimeMeeting"]) {
      assert.equal(navigationByKind(byId(configuredContext, id), NAVIGATION_KIND.SCREEN).preferred, true, id);
    }
  });

  await test("P1-T3", "missing Admin configuration does not block direct Zoom screen paths", async () => {
    const noAdmin = await buildAppContextWithReaders(OWNER, {
      admin: async () => ({ uid: "", label: "" }),
    });
    assert.equal(byId(noAdmin, "AdminCommand.enabled").configuration, CONFIGURATION.NOT_CONFIGURED);
    for (const id of ["Zoom.createOneTimeMeeting", "Zoom.editOrDeleteOneTimeMeeting"]) {
      const capability = byId(noAdmin, id);
      const screen = navigationByKind(capability, NAVIGATION_KIND.SCREEN);
      const command = navigationByKind(capability, NAVIGATION_KIND.CHAT_COMMAND_FIXED_SYNTAX);
      assert.equal(screen.preferred, true, id);
      assert.equal(screen.prerequisites, undefined, id);
      assert.deepEqual(command.prerequisites, [
        { capabilityId: "AdminCommand.enabled", configuration: CONFIGURATION.CONFIGURED },
      ], id);
      assert.doesNotMatch((capability.constraints || []).join(" "), /Zalo Admin|chat riêng/i, id);
      assert.match(command.constraints.join(" "), /chat riêng.*đúng nick Zalo Admin/i, id);
    }
    assert.match(renderAppContext(noAdmin), /Chỉ yêu cầu khai báo nick Admin cho cách nhắn lệnh; không dùng điều kiện này để chặn đường thao tác trên màn hình/);
  });

  await test("P1-T4", "fixed Zoom command syntax remains exact and source-backed", () => {
    const create = navigationByKind(
      byId(configuredContext, "Zoom.createOneTimeMeeting"),
      NAVIGATION_KIND.CHAT_COMMAND_FIXED_SYNTAX
    );
    const manage = navigationByKind(
      byId(configuredContext, "Zoom.editOrDeleteOneTimeMeeting"),
      NAVIGATION_KIND.CHAT_COMMAND_FIXED_SYNTAX
    );
    assert.equal(
      create.syntax,
      "tạo zoom <tên> lúc <giờ> <hôm nay|ngày mai|mai|dd/mm|dd/mm/yyyy> trong <thời lượng>"
    );
    assert.deepEqual(manage.syntax, [
      "sửa lịch zoom <tên> <ngày> lúc <giờ cũ> sang <giờ mới> [thời lượng <thời lượng>]",
      "xóa lịch zoom <tên> <ngày> [lúc <giờ>]",
    ]);
    const adminSource = source("lib/admin-command.js");
    assert.match(adminSource, /\^tao zoom\(\?:\\s\|\$\)/);
    assert.match(adminSource, /RE_SUA_LICH_ZOOM/);
    assert.match(adminSource, /RE_XOA_LICH_ZOOM/);
  });

  await test("P1-T5", "recurring and dynamic-execution negatives still prevent false composition", () => {
    for (const id of [
      "Zoom.createRecurringMeeting",
      "Zoom.editOrDeleteRecurringMeeting",
      "Scheduling.executeDynamicCommandAtRuntime",
    ]) {
      const capability = byId(configuredContext, id);
      assert.equal(capability.availability, AVAILABILITY.NOT_AVAILABLE, id);
      assert.deepEqual(capability.navigationPaths, [], id);
    }
    assert.equal(
      configuredContext.integrationPaths.find((item) => item.id === "Zoom.autoCreateNewLinkPerScheduledSend").availability,
      AVAILABILITY.NOT_AVAILABLE
    );
    assert.match(renderAppContext(configuredContext), /Không ghép các chức năng riêng lẻ thành một luồng tự động nếu dữ liệu không xác nhận đường nối đó đang có/);
  });

  await test("H1", "ordinary guidance explicitly bans internal identifiers unless technical detail is requested", () => {
    const rendered = renderAppContext(configuredContext);
    assert.match(rendered, /Trừ khi người dùng chủ động hỏi chi tiết triển khai kỹ thuật, KHÔNG đưa ra câu trả lời/);
    for (const forbiddenExample of [
      "Website.realtimeRegistrationTrigger",
      "Email.sendToCustomer",
      "APP_GLOBAL",
      "NOT_AVAILABLE",
      "type: 8",
    ]) {
      assert.match(rendered, new RegExp(forbiddenExample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(rendered, /Không in enum trong câu trả lời/);
    assert.match(rendered, /không nói tên loại navigation hay route API/);
  });

  await test("H2", "Website connector is acknowledged before both missing downstream links", () => {
    const rendered = renderAppContext(configuredContext);
    const connector = rendered.indexOf("app có cổng Website và có thể đọc danh sách khách từ Website");
    const missingSignal = rendered.indexOf("chưa nhận tín hiệu ngay khi khách vừa đăng ký thành công");
    const missingEmail = rendered.indexOf("chưa có chức năng gửi email xác nhận trực tiếp cho khách");
    assert.ok(connector >= 0, "Missing Website connector acknowledgement policy");
    assert.ok(missingSignal > connector, "Realtime signal must be explained after acknowledging the connector");
    assert.ok(missingEmail > missingSignal, "Customer email action must remain the second missing link");
    assert.equal(byId(configuredContext, "Website.pullCustomers").availability, AVAILABILITY.AVAILABLE);
    assert.equal(byId(configuredContext, "Website.realtimeRegistrationTrigger").availability, AVAILABILITY.NOT_AVAILABLE);
    assert.equal(byId(configuredContext, "Email.sendToCustomer").availability, AVAILABILITY.NOT_AVAILABLE);
    assert.match(rendered, /App có cổng Website, nhưng phần kết nối Website hiện chưa được cấu hình/);
  });

  await test("H3", "Zoom limitations are translated into human product language", () => {
    const rendered = renderAppContext(configuredContext);
    assert.match(rendered, /App hiện tạo được phòng Zoom cho từng buổi, nhưng chưa tự tạo được một phòng Zoom mới mỗi tuần theo lịch/);
    assert.match(rendered, /Không nói type 2\/type 8 hay lý do bằng tên scheduler/);
    assert.match(rendered, /đến giờ lịch chưa tự gọi Zoom để tạo link mới/);
  });

  await test("H4", "guide instructions preserve the canonical human answer order", () => {
    const rendered = renderAppContext(configuredContext);
    const ordered = [
      "1. Nói app hiện có gì liên quan đến việc chị muốn làm.",
      "2. Nói phần cần dùng đã được cấu hình hay chưa",
      "3. Nói với app hiện tại chị làm được đến đâu.",
      "4. Nếu làm được, chỉ đúng màn hình cần vào hoặc cách nhắn Bot Zalo.",
      "5. Nếu chưa làm trọn luồng, nói đơn giản và chính xác phần nào còn thiếu.",
      "6. Nếu có cách làm gần nhất, hướng dẫn cách đó.",
    ];
    let previous = -1;
    for (const sentence of ordered) {
      const current = rendered.indexOf(sentence);
      assert.ok(current > previous, `Wrong or missing guide order: ${sentence}`);
      previous = current;
    }
  });

  await test("H5", "Admin command guidance uses private-chat and confirmation wording", () => {
    const rendered = renderAppContext(configuredContext);
    assert.match(rendered, /Chị nhắn riêng cho Bot Zalo bằng đúng nick Admin đã khai báo/);
    assert.match(rendered, /Bot sẽ đọc lại nội dung dự kiến; chị gõ OK để chốt hoặc HUỶ để bỏ/);
    assert.match(rendered, /Hiện app chưa khai báo nick Zalo được quyền ra lệnh cho bot/);
    assert.match(rendered, /Điều khiển bot qua Zalo.*Nick Zalo được ra lệnh cho bot trước/);
  });

  await test("H6", "Soul requests receive direct human guidance to the real assistant controls", () => {
    const rendered = renderAppContext(configuredContext);
    assert.match(rendered, /Phần này chị chỉnh ngay trong Thiết lập trợ lý/);
    assert.match(rendered, /phong cách mong muốn ở phần Giọng điệu và vai trò/);
    assert.match(rendered, /Có thể giúp soạn\/sửa Soul/);
    const trainingUi = source("public/index.html");
    assert.match(trainingUi, />Thiết lập trợ lý<\/button>/);
    assert.match(trainingUi, />5\. Giọng điệu và vai trò<\/h2>/);
  });

  await test("H7", "human-language policy changes no capability truth", () => {
    const expectedNegatives = [
      "Zoom.createRecurringMeeting",
      "Scheduling.executeDynamicCommandAtRuntime",
      "Website.realtimeRegistrationTrigger",
      "Email.sendToCustomer",
    ];
    for (const id of expectedNegatives) {
      assert.equal(byId(configuredContext, id).availability, AVAILABILITY.NOT_AVAILABLE, id);
    }
    assert.equal(byId(configuredContext, "Website.pullCustomers").availability, AVAILABILITY.AVAILABLE);
    assert.equal(byId(configuredContext, "Zoom.createOneTimeMeeting").availability, AVAILABILITY.AVAILABLE);
  });

  const captured = [];
  let createSessionCalls = 0;
  let actualInferenceCalls = 0;
  fixtureServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://fixture.local");
      const body = raw ? JSON.parse(raw) : null;
      res.setHeader("Content-Type", "application/json");

      if (req.method === "POST" && url.pathname === "/session") {
        createSessionCalls += 1;
        res.end(JSON.stringify({ id: "lane-b-training-session" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/session/lane-b-training-session") {
        res.end(JSON.stringify({ id: "lane-b-training-session" }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/session/lane-b-training-session/message") {
        captured.push(body);
        const isActual = String(body?.parts?.[0]?.text || "").includes("CURRENT APP STATE — READ-ONLY UNTRUSTED DATA");
        if (isActual) actualInferenceCalls += 1;
        res.end(JSON.stringify({
          parts: [{ type: "text", text: isActual ? `LANE_B_MODEL_REPLY_${actualInferenceCalls}` : "READY" }],
          info: { tokens: { input: 1, output: 1 }, providerID: "fake", modelID: "model" },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `${req.method} ${url.pathname}` }));
    });
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address();
  await db.saveAiChatConfig(OWNER, { opencodeBaseUrl: `http://127.0.0.1:${address.port}` });

  const opencode = await import(moduleUrl("lib/opencode.js"));
  const projectionDirectory = path.join(process.env.OPENCODE_CONTEXT_ROOT, "lane-b-owner-context");
  fs.mkdirSync(projectionDirectory, { recursive: true });
  opencode.markCredentialPlaneReady(OWNER, ["fake"], projectionDirectory);
  const training = await import(moduleUrl("lib/training.js"));

  let firstActual;
  let secondActual;
  await test("B2-T1", "same training session receives fresh context on every Normal turn", async () => {
    const beforeFirst = businessSnapshot();
    assert.equal(await training.guiTinHuanLuyen(OWNER, "Mục tiêu lượt A", []), "LANE_B_MODEL_REPLY_1");
    assert.deepEqual(businessSnapshot(), beforeFirst, "Turn A mutated business/config state");
    firstActual = captured.filter((body) => String(body?.parts?.[0]?.text || "").includes("CURRENT APP STATE"))[0];
    assert.equal(byId(parseContextPart(firstActual), "AdminCommand.enabled").configuration, CONFIGURATION.CONFIGURED);

    await db.setAdminZalo(OWNER, "", "");
    const beforeSecond = businessSnapshot();
    assert.equal(await training.guiTinHuanLuyen(OWNER, "Mục tiêu lượt B", []), "LANE_B_MODEL_REPLY_2");
    assert.deepEqual(businessSnapshot(), beforeSecond, "Turn B mutated business/config state");
    secondActual = captured.filter((body) => String(body?.parts?.[0]?.text || "").includes("CURRENT APP STATE"))[1];
    assert.equal(byId(parseContextPart(secondActual), "AdminCommand.enabled").configuration, CONFIGURATION.NOT_CONFIGURED);
    assert.equal(createSessionCalls, 1);
    assert.equal(await db.getTrainingSessionId(OWNER), "lane-b-training-session");
  });

  await test("B2-T2", "OpenCode request orders App Context before the real user message", () => {
    assert.match(firstActual.parts[0].text, /CURRENT APP STATE — READ-ONLY UNTRUSTED DATA/);
    assert.deepEqual(firstActual.parts[1], { type: "text", text: "Mục tiêu lượt A" });
    assert.match(secondActual.parts[0].text, /CURRENT APP STATE — READ-ONLY UNTRUSTED DATA/);
    assert.deepEqual(secondActual.parts[1], { type: "text", text: "Mục tiêu lượt B" });
  });

  await test("B2-T3", "App Context is not persisted into the visible training transcript", async () => {
    const messages = await db.getTrainingMessages(OWNER);
    assert.deepEqual(messages.map((item) => item.content), [
      "Mục tiêu lượt A",
      "LANE_B_MODEL_REPLY_1",
      "Mục tiêu lượt B",
      "LANE_B_MODEL_REPLY_2",
    ]);
    assert.equal(messages.some((item) => /APP_CONTEXT|CURRENT APP STATE/.test(item.content)), false);
  });

  await test("B2-T4", "Normal persona is App Guide first and retains Soul as a secondary capability", () => {
    const bootstrap = captured.find((body) => !String(body?.parts?.[0]?.text || "").includes("CURRENT APP STATE"));
    const text = String(bootstrap?.parts?.[0]?.text || "");
    assert.match(text, /NGƯỜI HƯỚNG DẪN SỬ DỤNG APP/);
    assert.match(text, /Vai trò chính: hiểu mục tiêu/);
    assert.match(text, /tiếng Việt đời thường/);
    assert.match(text, /không nói như debugger, bảng trạng thái kỹ thuật hay người review source code/);
    assert.match(text, /Chỉ nói kỹ thuật khi người dùng chủ động hỏi về triển khai kỹ thuật/);
    assert.match(text, /Bắt đầu bằng phần app hiện có liên quan đến mục tiêu/);
    assert.match(text, /soạn\/sửa Soul như trước/);
    assert.match(text, /SOUL HIỆN TẠI CỦA BOT/);
  });

  await test("B2-T5", "tongHopSoul remains functional and uses the fresh-context request contract", async () => {
    assert.equal(await training.tongHopSoul(OWNER), "LANE_B_MODEL_REPLY_3");
    const actual = captured.filter((body) => String(body?.parts?.[0]?.text || "").includes("CURRENT APP STATE"))[2];
    assert.match(actual.parts[1].text, /hãy viết ra một đoạn Soul hoàn chỉnh/);
    assert.equal(createSessionCalls, 1);
  });

  await test("B2-T6", "all Normal Bot Commander inference requests remain guide-only with KHONG_TOOL", () => {
    assert.ok(captured.length >= 4);
    for (const body of captured) assert.equal(allToolsDisabled(body.tools), true);
  });

  await test("B2-T7", "Normal advisory writes only canonical training session/transcript state", async () => {
    const messages = await db.getTrainingMessages(OWNER);
    assert.equal(messages.length, 6);
    assert.equal(messages.at(-2).content.includes("Soul hoàn chỉnh"), true);
    assert.equal(messages.at(-1).content, "LANE_B_MODEL_REPLY_3");
  });

  await test("B2-T8", "context facts support truthful Zoom recurring reasoning", () => {
    const context = parseContextPart(secondActual);
    assert.equal(byId(context, "Zoom.createOneTimeMeeting").availability, AVAILABILITY.AVAILABLE);
    assert.equal(byId(context, "Zoom.createRecurringMeeting").availability, AVAILABILITY.NOT_AVAILABLE);
    assert.equal(byId(context, "Scheduling.recurringFixedText").availability, AVAILABILITY.AVAILABLE);
    assert.equal(byId(context, "Scheduling.zaloNativeReminderRecurring").availability, AVAILABILITY.AVAILABLE);
    assert.equal(byId(context, "Scheduling.executeDynamicCommandAtRuntime").availability, AVAILABILITY.NOT_AVAILABLE);
    assert.equal(context.integrationPaths.find((item) => item.id === "Zoom.autoCreateNewLinkPerScheduledSend").availability, AVAILABILITY.NOT_AVAILABLE);
    assert.match(firstActual.parts[0].text, /dùng link cố định hay link mới mỗi kỳ/);
  });

  await test("B2-T9", "context facts expose both missing Website-to-customer-email links", () => {
    const context = parseContextPart(secondActual);
    assert.equal(byId(context, "Website.pullCustomers").availability, AVAILABILITY.AVAILABLE);
    assert.equal(byId(context, "Website.realtimeRegistrationTrigger").availability, AVAILABILITY.NOT_AVAILABLE);
    assert.equal(byId(context, "Email.sendToCustomer").availability, AVAILABILITY.NOT_AVAILABLE);
    assert.equal(byId(context, "Zoho.lookupMail").availability, AVAILABILITY.AVAILABLE);
    assert.match(context.integrationPaths.find((item) => item.id === "Website.registrationToCustomerEmail").description, /Thiếu cả.*trigger.*Email\.sendToCustomer/i);
  });

  await test("B2-T10", "Lane B wiring is Normal-only and leaves Explicit Setup route separate", () => {
    const serverSource = source("server.js");
    const trainingSource = source("lib/training.js");
    const onboardingSource = source("lib/onboarding.js");
    assert.match(serverSource, /app\.post\("\/api\/training\/message"[\s\S]*?training\.guiTinHuanLuyen/);
    assert.match(serverSource, /app\.post\("\/api\/onboarding\/answer"[\s\S]*?onboarding\.traLoiOnboarding/);
    assert.match(trainingSource, /buildAppContext\(ownerUid\)/);
    assert.doesNotMatch(onboardingSource, /buildAppContext|renderAppContext/);
  });
} catch (error) {
  console.error("Khung Lane B test hong:", error);
  process.exitCode = 2;
} finally {
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_SECRET === undefined) delete process.env.APP_SECRET_KEY;
  else process.env.APP_SECRET_KEY = ORIGINAL_SECRET;
  if (ORIGINAL_CONTEXT_ROOT === undefined) delete process.env.OPENCODE_CONTEXT_ROOT;
  else process.env.OPENCODE_CONTEXT_ROOT = ORIGINAL_CONTEXT_ROOT;
}

for (const item of results) {
  console.log(`${item.ok ? "PASS" : "FAIL"} ${item.code} - ${item.description}`);
  if (!item.ok) console.log(`  -> ${item.error?.stack || item.error}`);
}
const passed = results.filter((item) => item.ok).length;
console.log(`\nBOT COMMANDER LANE B APP-AWARE: ${passed}/${results.length} PASS`);
console.log("REAL_PROVIDER_CALLS_IN_AUTOMATED_TEST = 0");
if (passed !== results.length) process.exitCode = 1;
