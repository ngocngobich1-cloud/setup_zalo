/**
 * BU-STAB-09-B05 focused proof: owner-scoped fixed auto-reply rules.
 *
 * Tat ca DB nam trong OS temp. Runtime/frontend dung fake in-memory/JSDOM;
 * khong mo canonical data/zalo.db, khong goi Zalo/provider/network that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = {
  db: fs.readFileSync(path.join(REPO, "lib", "db.js"), "utf8"),
  server: fs.readFileSync(path.join(REPO, "server.js"), "utf8"),
  zalo: fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8"),
};

// Host Node 24 ARM64 khong co native sqlite3 binding. Hook test-only nay phai
// duoc nap truoc moi dynamic import lib/db.js.
await import("./sqlite3-node24-test-register.js");

const results = [];
async function test(code, description, run) {
  try {
    await run();
    results.push({ code, description, pass: true });
    console.log(`PASS ${code} - ${description}`);
  } catch (error) {
    results.push({ code, description, pass: false, error });
    console.error(`FAIL ${code} - ${description}\n${error.stack || error.message}`);
  }
}

function makeTempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `b05-${label}-`));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  return root;
}

async function importDbFor(root, label) {
  const previous = process.cwd();
  process.chdir(root);
  try {
    const url = `${pathToFileURL(path.join(REPO, "lib", "db.js")).href}?b05=${label}-${Date.now()}-${Math.random()}`;
    const module = await import(url);
    await module.initDb();
    return module;
  } finally {
    process.chdir(previous);
  }
}

function inspect(file, readOnly = true) {
  return new DatabaseSync(file, { readOnly });
}

function extractFunction(moduleSource, signature) {
  const start = moduleSource.indexOf(signature);
  assert.ok(start >= 0, `Khong tim thay function: ${signature}`);
  const bodyStart = moduleSource.indexOf("{", start + signature.length);
  assert.ok(bodyStart >= 0, `Khong tim thay body: ${signature}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < moduleSource.length; index += 1) {
    const char = moduleSource[index];
    const next = moduleSource[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return moduleSource.slice(start, index + 1);
    }
  }
  assert.fail(`Function khong dong: ${signature}`);
}

function compileFunction(moduleSource, signature, dependencies) {
  const functionSource = extractFunction(moduleSource, signature).replace(/^export\s+/, "");
  const name = functionSource.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1];
  assert.ok(name, `Khong doc duoc ten function: ${signature}`);
  const dependencyNames = Object.keys(dependencies);
  const factory = Function(
    ...dependencyNames,
    `"use strict";\n${functionSource}\nreturn ${name};`
  );
  return factory(...dependencyNames.map((key) => dependencies[key]));
}

function normalizeString(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

async function runRuntime({ ownerUid, content, rulesByOwner, sendError = null }) {
  const observed = { queriedOwners: [], sends: [], logs: [], aggregates: 0 };
  const handler = compileFunction(source.zalo, "async function handleNewIncomingMessage", {
    persistAndBroadcastMessage: async (message) => message,
    addLog: async (entry) => { observed.logs.push(entry); return entry; },
    laTinHeThong: () => false,
    moTaSuKien: () => "su kien",
    laLenhAdmin: async () => false,
    xuLyLenh: async () => null,
    sendChatMessage: async (payload) => {
      observed.sends.push(payload);
      if (sendError) throw sendError;
      return { ok: true };
    },
    sendResolvedPrivateMessage: async () => undefined,
    aiChat: { getConfig: () => ({ botEnabled: true }) },
    getAutoReplyRules: async (owner) => {
      observed.queriedOwners.push(owner);
      return structuredClone(rulesByOwner[owner] || []);
    },
    chuHienTai: () => "fallback-owner",
    originConHieuLuc: () => true,
    normalizeString,
    ThreadType: { User: 0, Group: 1 },
    botDuocGoi: () => false,
    appState: { uid: ownerUid },
    boGom: {
      dangMo: () => false,
      them: () => { observed.aggregates += 1; },
    },
    console: { error: () => undefined },
  });
  const message = {
    id: `msg-${ownerUid}-${content}`,
    isSelf: false,
    threadId: `thread-${ownerUid}`,
    threadType: 0,
    senderId: "customer",
    senderName: "Khach",
    msgType: "chat.text",
    content,
  };
  const originToken = Object.freeze({
    originOwnerUid: ownerUid,
    originRuntimeGeneration: 1,
    originApiIdentity: {},
  });
  await handler(message, originToken);
  return observed;
}

const mainRoot = makeTempRoot("main");
const mainDbPath = path.join(mainRoot, "data", "zalo.db");
const db = await importDbFor(mainRoot, "main");
let ownerARuleId = null;
let ownerBRuleId = null;

await test("B05-T01", "Owner A create/list chi thay rule A", async () => {
  const inserted = await db.insertAutoReplyRule("  OWNER-A  ", {
    command: "hello",
    match_anywhere: 0,
    normalize: 0,
    reply_text: "Xin chao A",
  });
  ownerARuleId = Number(inserted.lastID);
  const rows = await db.getAutoReplyRules("OWNER-A");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, ownerARuleId);
  assert.equal(rows[0].reply_text, "Xin chao A");
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "command", "created_at", "id", "match_anywhere", "normalize", "reply_text",
  ]);
  const physical = inspect(mainDbPath);
  const row = physical.prepare("SELECT owner_uid FROM auto_reply_rules WHERE id = ?").get(ownerARuleId);
  physical.close();
  assert.equal(row.owner_uid, "OWNER-A");
  assert.match(source.server, /getAutoReplyRules\(ownerUid\)/);
  assert.match(source.server, /insertAutoReplyRule\(ownerUid, req\.body\)/);
});

await test("B05-T02", "A sang B thi B khong thay rule A", async () => {
  assert.deepEqual(await db.getAutoReplyRules("OWNER-B"), []);
});

await test("B05-T03", "A/B isolated va B khong mutate ID cua A", async () => {
  const inserted = await db.insertAutoReplyRule("OWNER-B", {
    command: "hello",
    match_anywhere: 0,
    normalize: 0,
    reply_text: "Xin chao B",
  });
  ownerBRuleId = Number(inserted.lastID);
  await db.updateAutoReplyRule("OWNER-B", ownerARuleId, {
    command: "hijack",
    match_anywhere: 1,
    normalize: 1,
    reply_text: "B sua A",
  });
  await db.deleteAutoReplyRule("OWNER-B", ownerARuleId);
  const aRows = await db.getAutoReplyRules("OWNER-A");
  const bRows = await db.getAutoReplyRules("OWNER-B");
  assert.equal(aRows.length, 1);
  assert.equal(aRows[0].command, "hello");
  assert.equal(aRows[0].reply_text, "Xin chao A");
  assert.deepEqual(bRows.map((row) => row.id), [ownerBRuleId]);
  await assert.rejects(() => db.getAutoReplyRules("  "), /Thieu ownerUid/);
});

await test("B05-T04", "Runtime A chi doc A, gui mot lan va khong aggregation", async () => {
  const observed = await runRuntime({
    ownerUid: "OWNER-A",
    content: "/hello",
    rulesByOwner: {
      "OWNER-A": [{ command: "hello", match_anywhere: 0, normalize: 0, reply_text: "A reply" }],
      "OWNER-B": [{ command: "hello", match_anywhere: 0, normalize: 0, reply_text: "B reply" }],
    },
  });
  assert.deepEqual(observed.queriedOwners, ["OWNER-A"]);
  assert.equal(observed.sends.length, 1);
  assert.equal(observed.sends[0].text, "A reply");
  assert.equal(observed.aggregates, 0);
});

await test("B05-T05", "Runtime B khong dung rule A va unmatched van aggregation", async () => {
  const observed = await runRuntime({
    ownerUid: "OWNER-B",
    content: "/hello",
    rulesByOwner: {
      "OWNER-A": [{ command: "hello", match_anywhere: 0, normalize: 0, reply_text: "A reply" }],
    },
  });
  assert.deepEqual(observed.queriedOwners, ["OWNER-B"]);
  assert.equal(observed.sends.length, 0);
  assert.equal(observed.aggregates, 1);
});

await test("B05-T06", "A sang B roi ve A restore dung rules", async () => {
  const a1 = await db.getAutoReplyRules("OWNER-A");
  const b = await db.getAutoReplyRules("OWNER-B");
  const a2 = await db.getAutoReplyRules("OWNER-A");
  assert.deepEqual(a2, a1);
  assert.notDeepEqual(b, a1);
  assert.equal(a2[0].id, ownerARuleId);
});

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(data),
  };
}

function deferredResponse() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, release: (data, status = 200) => resolve(jsonResponse(data, status)) };
}

async function flush(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const dom = new JSDOM("<!doctype html><html><body><div id='panel'></div></body></html>", {
  url: "http://b05.test/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  HTMLElement: dom.window.HTMLElement,
  confirm: () => true,
  alert: () => undefined,
});
dom.window.confirm = globalThis.confirm;
dom.window.alert = globalThis.alert;

let frontendOwner = "OWNER-A";
let deferredAList = null;
const frontendRules = {
  "OWNER-A": [{ id: 101, command: "alpha", match_anywhere: 0, normalize: 0, reply_text: "A frontend", created_at: 1 }],
  "OWNER-B": [{ id: 202, command: "beta", match_anywhere: 0, normalize: 0, reply_text: "B frontend", created_at: 2 }],
};
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const method = String(options.method || "GET").toUpperCase();
  if (url === "/api/auto-reply" && method === "GET") {
    if (frontendOwner === "OWNER-A" && deferredAList) {
      const pending = deferredAList;
      deferredAList = null;
      return pending.promise;
    }
    return jsonResponse(frontendRules[frontendOwner] || []);
  }
  return jsonResponse({ ok: true });
};
dom.window.fetch = globalThis.fetch;

const config = await import(`${pathToFileURL(path.join(REPO, "public", "config.js")).href}?b05-frontend`);
const panel = document.querySelector("#panel");
config.setSettingsOwnerUid("OWNER-A");
config.CONFIG_TABS.find((tab) => tab.id === "auto-reply").mount(panel);
await flush();

await test("B05-T07", "Pending A frontend response khong overwrite B", async () => {
  assert.match(panel.querySelector("#auto-reply-rules").textContent, /A frontend/);
  panel.querySelector(".rule-actions button").click();
  assert.equal(panel.querySelector("#auto-reply-form").classList.contains("hidden"), false);

  const staleAList = deferredResponse();
  deferredAList = staleAList;
  config.refreshSettingsDynamicData();
  await flush(2);

  frontendOwner = "OWNER-B";
  config.setSettingsOwnerUid("OWNER-B");
  config.invalidateSettingsOwnerState();
  assert.equal(panel.querySelector("#rule-id").value, "");
  assert.equal(panel.querySelector("#auto-reply-form").classList.contains("hidden"), true);
  config.refreshSettingsDynamicData();
  await flush();
  assert.match(panel.querySelector("#auto-reply-rules").textContent, /B frontend/);

  staleAList.release(frontendRules["OWNER-A"]);
  await flush();
  assert.match(panel.querySelector("#auto-reply-rules").textContent, /B frontend/);
  assert.doesNotMatch(panel.querySelector("#auto-reply-rules").textContent, /A frontend/);
});

await test("B05-T08", "Migration/restart giu owner column, index va owner rows", async () => {
  const restarted = await importDbFor(mainRoot, "main-restart");
  assert.equal((await restarted.getAutoReplyRules("OWNER-A"))[0].id, ownerARuleId);
  assert.equal((await restarted.getAutoReplyRules("OWNER-B"))[0].id, ownerBRuleId);
  const physical = inspect(mainDbPath);
  const columns = physical.prepare("PRAGMA table_info(auto_reply_rules)").all();
  const indexes = physical.prepare("PRAGMA index_list(auto_reply_rules)").all();
  physical.close();
  assert.ok(columns.some((column) => column.name === "owner_uid"));
  assert.equal(indexes.filter((index) => index.name === "idx_auto_reply_rules_owner_created").length, 1);
});

const legacyRoot = makeTempRoot("legacy");
const legacyDbPath = path.join(legacyRoot, "data", "zalo.db");
{
  const legacy = inspect(legacyDbPath, false);
  legacy.exec(`
    CREATE TABLE auto_reply_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      match_anywhere INTEGER NOT NULL DEFAULT 0,
      normalize INTEGER NOT NULL DEFAULT 0,
      reply_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO auto_reply_rules
      (id, command, match_anywhere, normalize, reply_text, created_at)
    VALUES (77, 'legacy', 0, 0, 'legacy reply', 77);
  `);
  legacy.close();
}
const legacyDb = await importDbFor(legacyRoot, "legacy");

await test("B05-T09", "Legacy NULL quarantine invisible, unmatched va nonmutable", async () => {
  assert.deepEqual(await legacyDb.getAutoReplyRules("OWNER-A"), []);
  assert.deepEqual(await legacyDb.getAutoReplyRules("OWNER-B"), []);
  await legacyDb.updateAutoReplyRule("OWNER-A", 77, {
    command: "changed",
    match_anywhere: 1,
    normalize: 1,
    reply_text: "changed",
  });
  await legacyDb.deleteAutoReplyRule("OWNER-A", 77);
  const physical = inspect(legacyDbPath);
  const row = physical.prepare("SELECT * FROM auto_reply_rules WHERE id = 77").get();
  physical.close();
  assert.equal(row.owner_uid, null);
  assert.equal(row.command, "legacy");
  assert.equal(row.reply_text, "legacy reply");

  for (const ownerUid of ["OWNER-A", "OWNER-B"]) {
    const observed = await runRuntime({ ownerUid, content: "/legacy", rulesByOwner: {} });
    assert.equal(observed.sends.length, 0);
    assert.equal(observed.aggregates, 1);
  }
});

await test("B05-T10", "Old matching/logging/AI boundary semantics duoc giu", async () => {
  const longest = await runRuntime({
    ownerUid: "OWNER-A",
    content: "/go now",
    rulesByOwner: {
      "OWNER-A": [
        { command: "go", match_anywhere: 1, normalize: 0, reply_text: "short" },
        { command: "go now", match_anywhere: 0, normalize: 0, reply_text: "long" },
      ],
    },
  });
  assert.equal(longest.sends.length, 1);
  assert.equal(longest.sends[0].text, "long");
  assert.equal(longest.aggregates, 0);
  assert.equal(longest.logs.filter((entry) => entry.event === "auto_reply" && entry.level === "ok").length, 1);

  const normalized = await runRuntime({
    ownerUid: "OWNER-A",
    content: "/hen",
    rulesByOwner: {
      "OWNER-A": [{ command: "HẸN", match_anywhere: 0, normalize: 1, reply_text: "normalized" }],
    },
  });
  assert.equal(normalized.sends[0].text, "normalized");

  const exactMiss = await runRuntime({
    ownerUid: "OWNER-A",
    content: "noi /x trong cau",
    rulesByOwner: {
      "OWNER-A": [{ command: "x", match_anywhere: 0, normalize: 0, reply_text: "exact" }],
    },
  });
  assert.equal(exactMiss.sends.length, 0);
  assert.equal(exactMiss.aggregates, 1);

  const contains = await runRuntime({
    ownerUid: "OWNER-A",
    content: "noi /x trong cau",
    rulesByOwner: {
      "OWNER-A": [{ command: "x", match_anywhere: 1, normalize: 0, reply_text: "contains" }],
    },
  });
  assert.equal(contains.sends.length, 1);
  assert.equal(contains.aggregates, 0);

  const failedSend = await runRuntime({
    ownerUid: "OWNER-A",
    content: "/x",
    rulesByOwner: {
      "OWNER-A": [{ command: "x", match_anywhere: 0, normalize: 0, reply_text: "fail" }],
    },
    sendError: new Error("provider failed"),
  });
  assert.equal(failedSend.aggregates, 0);
  assert.equal(failedSend.logs.some((entry) => entry.event === "auto_reply" && entry.level === "ok"), false);
  assert.equal(failedSend.logs.filter((entry) => entry.event === "auto_reply" && entry.level === "error").length, 1);
});

await test("B05-T11", "Migration chay hai lan idempotent, IDs/count khong doi", async () => {
  const before = inspect(legacyDbPath);
  const beforeRows = before.prepare("SELECT id, command, owner_uid FROM auto_reply_rules ORDER BY id").all();
  before.close();

  await importDbFor(legacyRoot, "legacy-second-start");

  const after = inspect(legacyDbPath);
  const afterRows = after.prepare("SELECT id, command, owner_uid FROM auto_reply_rules ORDER BY id").all();
  const columns = after.prepare("PRAGMA table_info(auto_reply_rules)").all();
  const indexes = after.prepare("PRAGMA index_list(auto_reply_rules)").all();
  after.close();
  assert.deepEqual(afterRows, beforeRows);
  assert.equal(columns.filter((column) => column.name === "owner_uid").length, 1);
  assert.equal(indexes.filter((index) => index.name === "idx_auto_reply_rules_owner_created").length, 1);
});

await test("B05-T12", "Fresh DB co owner_uid ngay tu CREATE path", async () => {
  const physical = inspect(mainDbPath);
  const createSql = physical.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auto_reply_rules'"
  ).get().sql;
  const columns = physical.prepare("PRAGMA table_info(auto_reply_rules)").all();
  physical.close();
  assert.match(createSql, /owner_uid\s+TEXT/i);
  assert.ok(columns.some((column) => column.name === "owner_uid"));
  assert.match(source.db, /CREATE TABLE IF NOT EXISTS auto_reply_rules[\s\S]*owner_uid TEXT/);
});

// UI A -> B -> A restore sau khi stale-response proof da ket thuc.
frontendOwner = "OWNER-A";
config.setSettingsOwnerUid("OWNER-A");
config.invalidateSettingsOwnerState();
config.refreshSettingsDynamicData();
await flush();
assert.match(panel.querySelector("#auto-reply-rules").textContent, /A frontend/);

const passed = results.filter((result) => result.pass).length;
const failed = results.length - passed;
console.log(`B05_TOTAL = ${results.length}`);
console.log(`B05_PASS = ${passed}`);
console.log(`B05_FAIL = ${failed}`);
if (failed) process.exitCode = 1;
