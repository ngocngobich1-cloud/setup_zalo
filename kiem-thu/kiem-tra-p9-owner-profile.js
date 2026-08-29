/** P9 focused test: chi SQLite tam + metadata fixture in-memory, zero provider call. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const OWNER_A = "1483263118759934515";
const OWNER_B = "712702392760555950";
const DEFAULT_MODEL = "opencode/nemotron-3-ultra-free";
const results = [];

async function test(code, description, fn) {
  try {
    await fn();
    results.push({ code, description, pass: true });
  } catch (error) {
    results.push({ code, description, pass: false, error: error.message });
  }
}

function moDb(file) {
  const conn = new sqlite3.Database(file);
  return {
    run: (sql, params = []) => new Promise((resolve, reject) => conn.run(sql, params, function done(error) {
      if (error) reject(error); else resolve(this);
    })),
    all: (sql, params = []) => new Promise((resolve, reject) => conn.all(sql, params, (error, rows) => {
      if (error) reject(error); else resolve(rows);
    })),
    get: (sql, params = []) => new Promise((resolve, reject) => conn.get(sql, params, (error, row) => {
      if (error) reject(error); else resolve(row);
    })),
    close: () => new Promise((resolve, reject) => conn.close((error) => error ? reject(error) : resolve())),
  };
}

async function taoLegacyDb(file, { trainingSession = "", trainingMessages = 0 } = {}) {
  const db = moDb(file);
  await db.run(`CREATE TABLE ai_chat_config (
    id INTEGER PRIMARY KEY CHECK(id=1), groq_api_key TEXT NOT NULL DEFAULT '',
    allowed_topics TEXT NOT NULL DEFAULT '', role_tone TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0, allowed_group_id TEXT NOT NULL DEFAULT '',
    allowed_sender_ids TEXT NOT NULL DEFAULT '[]', use_knowledge INTEGER NOT NULL DEFAULT 0,
    knowledge_file_ids TEXT NOT NULL DEFAULT '[]', soul TEXT NOT NULL DEFAULT '',
    opencode_base_url TEXT NOT NULL DEFAULT 'http://opencode:4096',
    opencode_agent TEXT NOT NULL DEFAULT 'general', opencode_model TEXT NOT NULL DEFAULT '',
    bot_enabled INTEGER NOT NULL DEFAULT 0, doc_tep INTEGER NOT NULL DEFAULT 0)`);
  await db.run(`INSERT INTO ai_chat_config
    (id, allowed_topics, role_tone, use_knowledge, knowledge_file_ids, soul,
     opencode_base_url, opencode_agent, opencode_model, doc_tep, updated_at)
    VALUES (1, 'topic-a', 'tone-a', 1, '[7]', 'Soul A',
            'http://runtime:4096', 'general', 'openai/gpt-4.1', 1, 12345)`);
  await db.run(`CREATE TABLE training_session (
    id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0)`);
  await db.run("INSERT INTO training_session (id, session_id) VALUES (1, ?)", [trainingSession]);
  await db.run(`CREATE TABLE training_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL,
    files TEXT, created_at INTEGER NOT NULL)`);
  for (let index = 0; index < trainingMessages; index += 1) {
    await db.run("INSERT INTO training_messages (role, content, created_at) VALUES ('user', 'legacy', 1)");
  }
  return db;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p9-owner-profile-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  process.chdir(tmp);

  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  const opencode = await import(pathToFileURL(path.join(REPO, "lib", "opencode.js")).href);
  const aiChat = await import(pathToFileURL(path.join(REPO, "lib", "ai-chat.js")).href);
  const migration = await import(pathToFileURL(path.join(REPO, "lib", "migrations", "p9-zalo-uid-profile.js")).href);
  await db.initDb();

  const save = (ownerUid, model, soul) => db.saveAiChatConfig(ownerUid, {
    allowedTopics: soul ? `topics-${ownerUid}` : "",
    roleTone: soul ? `tone-${ownerUid}` : "",
    useKnowledge: false,
    knowledgeFileIds: [],
    soul,
    opencodeBaseUrl: "http://runtime:4096",
    opencodeAgent: "general",
    opencodeModel: model,
  });
  const providers = [{
    id: "opencode",
    models: [{ id: DEFAULT_MODEL, label: "Nemotron 3 Ultra Free" }],
  }];

  await test("P9-01", "AI A/B cach ly va fresh B dung effective default", async () => {
    await save(OWNER_A, "openai/gpt-4.1", "Soul A");
    const a = await db.getAiChatConfig(OWNER_A);
    const bFresh = await db.getAiChatConfig(OWNER_B);
    assert.equal(a.opencodeModel, "openai/gpt-4.1");
    assert.equal(a.soul, "Soul A");
    assert.equal(bFresh.opencodeModel, "");
    assert.equal(bFresh.soul, "");
    assert.equal((await opencode.resolveEffectiveModelConfig(bFresh, providers)).opencodeModel, DEFAULT_MODEL);

    await save(OWNER_B, "google/gemini-b", "Soul B");
    assert.deepEqual(
      [(await db.getAiChatConfig(OWNER_A)).soul, (await db.getAiChatConfig(OWNER_B)).soul],
      ["Soul A", "Soul B"]
    );
  });

  await test("P9-02", "cache co owner guard va reload dung owner", async () => {
    let currentOwner = OWNER_A;
    aiChat.capHinhChuTaiKhoan(() => currentOwner);
    await aiChat.loadConfig();
    assert.equal(aiChat.getConfig().soul, "Soul A");
    currentOwner = OWNER_B;
    assert.equal(aiChat.getConfig(), null, "cache A khong duoc lo sang B truoc refresh");
    await aiChat.refreshConfig();
    assert.equal(aiChat.getConfig().soul, "Soul B");
  });

  await test("P9-03", "Training session/transcript/reset cach ly theo owner", async () => {
    await db.saveTrainingSessionId(OWNER_A, "session-a");
    await db.saveTrainingSessionId(OWNER_B, "session-b");
    await db.addTrainingMessage(OWNER_A, { role: "user", content: "A", files: [] });
    await db.addTrainingMessage(OWNER_B, { role: "user", content: "B", files: [] });
    assert.notEqual(await db.getTrainingSessionId(OWNER_A), await db.getTrainingSessionId(OWNER_B));
    assert.deepEqual((await db.getTrainingMessages(OWNER_A)).map((item) => item.content), ["A"]);
    assert.deepEqual((await db.getTrainingMessages(OWNER_B)).map((item) => item.content), ["B"]);
    await db.clearTrainingMessages(OWNER_A);
    assert.equal(await db.getTrainingSessionId(OWNER_A), null);
    assert.equal((await db.getTrainingMessages(OWNER_A)).length, 0);
    assert.equal(await db.getTrainingSessionId(OWNER_B), "session-b");
    assert.deepEqual((await db.getTrainingMessages(OWNER_B)).map((item) => item.content), ["B"]);
  });

  await test("P9-04", "khong owner thi khong doc/ghi profile", async () => {
    const truoc = (await db.getAiChatConfig(OWNER_A)).soul;
    assert.equal(await db.getAiChatConfig(null), null);
    await assert.rejects(() => save(null, "google/forbidden", "anonymous"), /thieu ownerUid/);
    await assert.rejects(() => db.saveTrainingSessionId(null, "anonymous"), /thieu ownerUid/);
    assert.equal((await db.getAiChatConfig(OWNER_A)).soul, truoc);
  });

  await test("P9-05", "legacy AI chi gan explicit owner; runtime global duoc bao toan", async () => {
    const file = path.join(tmp, "legacy-ok.db");
    const legacy = await taoLegacyDb(file);
    const report = await migration.migrateP9ZaloUidProfile(legacy, { legacyOwnerUid: OWNER_A });
    assert.equal(report.legacyAiOwnerUid, OWNER_A);
    assert.deepEqual(await legacy.all("SELECT owner_uid, soul, opencode_model FROM ai_chat_config"), [{
      owner_uid: OWNER_A,
      soul: "Soul A",
      opencode_model: "openai/gpt-4.1",
    }]);
    assert.equal(await legacy.get("SELECT COUNT(*) AS n FROM ai_chat_config WHERE owner_uid = ?", [OWNER_B]).then((r) => r.n), 0);
    const runtime = await legacy.get("SELECT opencode_base_url, opencode_agent, doc_tep FROM ai_runtime_config WHERE id = 1");
    assert.deepEqual(runtime, { opencode_base_url: "http://runtime:4096", opencode_agent: "general", doc_tep: 1 });
    assert.ok((await legacy.all("PRAGMA table_info(training_session)")).some((column) => column.name === "owner_uid"));
    assert.ok((await legacy.all("PRAGMA table_info(training_messages)")).some((column) => column.name === "owner_uid"));
    await legacy.close();
  });

  await test("P9-06", "legacy Training khong rong thi STOP truoc khi migrate AI", async () => {
    const file = path.join(tmp, "legacy-stop.db");
    const legacy = await taoLegacyDb(file, { trainingSession: "unowned-session", trainingMessages: 1 });
    await assert.rejects(() => migration.migrateP9ZaloUidProfile(legacy), /P9_STOP: legacy Training khong rong/);
    const aiColumns = await legacy.all("PRAGMA table_info(ai_chat_config)");
    assert.ok(aiColumns.some((column) => column.name === "id"));
    assert.ok(!aiColumns.some((column) => column.name === "owner_uid"));
    assert.equal(await legacy.get("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_runtime_config'"), undefined);
    await legacy.close();
  });

  await test("P9-07", "frontend UID switch invalidate settings/training/chat state", async () => {
    const app = fs.readFileSync(path.join(REPO, "public", "app.js"), "utf8");
    const config = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
    const training = fs.readFileSync(path.join(REPO, "public", "training.js"), "utf8");
    assert.ok(app.includes("uidCu !== uidMoi"));
    assert.ok(app.includes("state.messagesByThread.clear()"));
    assert.ok(app.includes("state.selectedThread = null"));
    assert.ok(app.includes("invalidateSettingsOwnerState()"));
    assert.ok(app.includes("invalidateTrainingOwnerState()"));
    assert.ok(config.includes("settingsOwnerGeneration += 1"));
    assert.ok(config.includes('dangKyLamMoi("AI Chat", loadConfig)'));
    assert.ok(training.includes("ownerGeneration += 1"));
    assert.ok(training.includes("daNap = false"));
  });

  const failed = results.filter((item) => !item.pass);
  for (const item of results) {
    console.log(`${item.code} = ${item.pass ? "PASS" : "FAIL"}  ${item.description}${item.error ? `\n      -> ${item.error}` : ""}`);
  }
  console.log(`\nTONG: ${results.length - failed.length}/${results.length} PASS`);
  console.log("REAL_PROVIDER_CALL = 0");
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Khung P9 owner profile test hong:", error);
  process.exit(2);
});
