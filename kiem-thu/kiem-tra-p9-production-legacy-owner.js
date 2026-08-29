/**
 * Production-shaped P9 legacy-owner regression.
 * Synthetic SQLite fixtures only; no production DB, provider or network use.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrateP9ZaloUidProfile } from "../lib/migrations/p9-zalo-uid-profile.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const THIS_FILE = fileURLToPath(import.meta.url);
const CLI = path.join(REPO, "lib", "migrations", "chuyen-doi-p9-legacy-owner.js");
const SYNTHETIC_OWNER = "900000000000000123";
const EXPECTED_STOP = "P9_STOP: legacy Training khong rong; khong duoc tu suy owner.";
const results = [];

function moDb(file, mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE) {
  const connection = new sqlite3.Database(file, mode);
  return {
    run: (sql, params = []) => new Promise((resolve, reject) => {
      connection.run(sql, params, function onRun(error) {
        if (error) reject(error);
        else resolve(this);
      });
    }),
    all: (sql, params = []) => new Promise((resolve, reject) => {
      connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    }),
    get: (sql, params = []) => new Promise((resolve, reject) => {
      connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    }),
    close: () => new Promise((resolve, reject) => {
      connection.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function test(code, description, fn) {
  try {
    await fn();
    results.push({ code, description, pass: true });
  } catch (error) {
    results.push({ code, description, pass: false, error: error.stack || error.message });
  }
}

function fixtureRoot(base, name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  return root;
}

async function createProductionShapedLegacy(root) {
  const db = moDb(path.join(root, "data", "zalo.db"));
  await db.run(`CREATE TABLE ai_chat_config (
    id INTEGER PRIMARY KEY CHECK(id=1), groq_api_key TEXT NOT NULL DEFAULT '',
    allowed_topics TEXT NOT NULL DEFAULT '', role_tone TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0, allowed_group_id TEXT NOT NULL DEFAULT '',
    allowed_sender_ids TEXT NOT NULL DEFAULT '[]', use_knowledge INTEGER NOT NULL DEFAULT 0,
    knowledge_file_ids TEXT NOT NULL DEFAULT '[]', soul TEXT NOT NULL DEFAULT '',
    opencode_base_url TEXT NOT NULL DEFAULT 'http://opencode:4096',
    opencode_agent TEXT NOT NULL DEFAULT 'general', opencode_model TEXT NOT NULL DEFAULT '',
    bot_enabled INTEGER NOT NULL DEFAULT 0, doc_tep INTEGER NOT NULL DEFAULT 0
  )`);
  await db.run(`INSERT INTO ai_chat_config
    (id, allowed_topics, role_tone, use_knowledge, knowledge_file_ids, soul,
     opencode_base_url, opencode_agent, opencode_model, doc_tep, updated_at)
    VALUES (1, ?, ?, 1, ?, ?, ?, 'general', ?, 1, 1700000100)`, [
    "synthetic-topic-a\nsynthetic-topic-b",
    "synthetic calm tone",
    "[17,23]",
    "Synthetic Soul line 1\nSynthetic Soul line 2",
    "http://synthetic-runtime.invalid:4096",
    "synthetic/provider-model",
  ]);
  await db.run(`CREATE TABLE training_session (
    id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  await db.run(
    "INSERT INTO training_session (id, session_id, updated_at) VALUES (1, 'synthetic-session', 1700000200)"
  );
  await db.run(`CREATE TABLE training_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL,
    files TEXT, created_at INTEGER NOT NULL
  )`);
  await db.run(
    "INSERT INTO training_messages (role, content, files, created_at) VALUES (?, ?, ?, ?)",
    ["user", "Synthetic question one", '[{"name":"synthetic-a.txt","size":17}]', 1700000301]
  );
  await db.run(
    "INSERT INTO training_messages (role, content, files, created_at) VALUES (?, ?, ?, ?)",
    ["assistant", "Synthetic answer\nwith ordering", "[]", 1700000302]
  );
  await db.run(
    "INSERT INTO training_messages (role, content, files, created_at) VALUES (?, ?, ?, ?)",
    ["user", "Synthetic final message", null, 1700000303]
  );
  return db;
}

async function legacySnapshot(db) {
  return {
    aiColumns: (await db.all("PRAGMA table_info(ai_chat_config)")).map((column) => column.name),
    sessionColumns: (await db.all("PRAGMA table_info(training_session)")).map((column) => column.name),
    messageColumns: (await db.all("PRAGMA table_info(training_messages)")).map((column) => column.name),
    ai: await db.all(`SELECT id, allowed_topics, role_tone, use_knowledge,
      knowledge_file_ids, soul, opencode_model, updated_at FROM ai_chat_config ORDER BY id`),
    session: await db.all("SELECT id, session_id, updated_at FROM training_session ORDER BY id"),
    messages: await db.all(
      "SELECT id, role, content, files, created_at FROM training_messages ORDER BY id"
    ),
  };
}

async function migratedSnapshot(db) {
  return {
    ai: await db.all(`SELECT owner_uid, allowed_topics, role_tone, use_knowledge,
      knowledge_file_ids, soul, opencode_model, updated_at FROM ai_chat_config ORDER BY owner_uid`),
    session: await db.all(
      "SELECT owner_uid, session_id, updated_at FROM training_session ORDER BY owner_uid"
    ),
    messages: await db.all(
      "SELECT id, owner_uid, role, content, files, created_at FROM training_messages ORDER BY id"
    ),
  };
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 20_000,
  });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function normalStartupWorker(root) {
  process.chdir(root);
  try {
    const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
    await db.initDb();
    console.error("NORMAL_STARTUP_UNEXPECTEDLY_SUCCEEDED");
    process.exit(3);
  } catch (error) {
    const message = String(error?.message || error);
    console.error(message);
    process.exit(message.includes(EXPECTED_STOP) ? 0 : 2);
  }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p9-production-legacy-owner-"));
  let mappedRoot;
  let mappedBefore;

  await test("T1", "legacy production shape without mapping fails closed with zero ownership mutation", async () => {
    const root = fixtureRoot(temp, "t1-no-owner");
    const db = await createProductionShapedLegacy(root);
    const before = await legacySnapshot(db);
    await assert.rejects(
      () => migrateP9ZaloUidProfile(db),
      (error) => error.message === EXPECTED_STOP
    );
    assert.deepEqual(await legacySnapshot(db), before);
    assert.equal(
      await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_runtime_config'"),
      undefined
    );
    await db.close();
  });

  await test("T2", "one-shot CLI accepts deliberate explicit owner and completes migration", async () => {
    mappedRoot = fixtureRoot(temp, "t2-mapped");
    const db = await createProductionShapedLegacy(mappedRoot);
    mappedBefore = await legacySnapshot(db);
    await db.close();
    const cli = runCli(mappedRoot, ["--owner-uid", SYNTHETIC_OWNER]);
    assert.equal(cli.error, undefined);
    assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
    assert.match(cli.stdout, /P9_LEGACY_OWNER_MIGRATION = PASS/);
    assert.match(cli.stdout, /AI_MIGRATED = YES/);
    assert.match(cli.stdout, /TRAINING_MIGRATED = YES/);
  });

  await test("T3", "legacy AI profile belongs only to the supplied owner", async () => {
    const db = moDb(path.join(mappedRoot, "data", "zalo.db"), sqlite3.OPEN_READONLY);
    const after = await migratedSnapshot(db);
    assert.equal(after.ai.length, 1);
    assert.equal(after.ai[0].owner_uid, SYNTHETIC_OWNER);
    assert.deepEqual(
      { ...after.ai[0], owner_uid: undefined },
      {
        owner_uid: undefined,
        allowed_topics: mappedBefore.ai[0].allowed_topics,
        role_tone: mappedBefore.ai[0].role_tone,
        use_knowledge: mappedBefore.ai[0].use_knowledge,
        knowledge_file_ids: mappedBefore.ai[0].knowledge_file_ids,
        soul: mappedBefore.ai[0].soul,
        opencode_model: mappedBefore.ai[0].opencode_model,
        updated_at: mappedBefore.ai[0].updated_at,
      }
    );
    await db.close();
  });

  await test("T4", "every Training message belongs to the supplied owner", async () => {
    const db = moDb(path.join(mappedRoot, "data", "zalo.db"), sqlite3.OPEN_READONLY);
    const rows = await db.all("SELECT owner_uid FROM training_messages ORDER BY id");
    assert.equal(rows.length, mappedBefore.messages.length);
    assert.ok(rows.every((row) => row.owner_uid === SYNTHETIC_OWNER));
    await db.close();
  });

  await test("T5", "Training message count is unchanged", async () => {
    const db = moDb(path.join(mappedRoot, "data", "zalo.db"), sqlite3.OPEN_READONLY);
    const row = await db.get("SELECT COUNT(*) AS n FROM training_messages");
    assert.equal(row.n, mappedBefore.messages.length);
    await db.close();
  });

  await test("T6", "Training message order, content and files metadata are unchanged", async () => {
    const db = moDb(path.join(mappedRoot, "data", "zalo.db"), sqlite3.OPEN_READONLY);
    const after = await migratedSnapshot(db);
    assert.deepEqual(
      after.messages.map(({ owner_uid: _ownerUid, ...message }) => message),
      mappedBefore.messages
    );
    await db.close();
  });

  await test("T7", "Training session association and timestamp are preserved", async () => {
    const db = moDb(path.join(mappedRoot, "data", "zalo.db"), sqlite3.OPEN_READONLY);
    const after = await migratedSnapshot(db);
    assert.deepEqual(after.session, [{
      owner_uid: SYNTHETIC_OWNER,
      session_id: mappedBefore.session[0].session_id,
      updated_at: mappedBefore.session[0].updated_at,
    }]);
    await db.close();
  });

  await test("T8", "missing, empty and malformed owner are rejected before database mutation", async () => {
    const root = fixtureRoot(temp, "t8-invalid");
    const db = await createProductionShapedLegacy(root);
    await assert.rejects(
      () => migrateP9ZaloUidProfile(db, { legacyOwnerUid: "   " }),
      /owner UID duoc phe duyet khong duoc de trong/
    );
    await db.close();
    const file = path.join(root, "data", "zalo.db");
    const beforeHash = sha256(file);
    for (const args of [[], ["--owner-uid", ""], ["--owner-uid", "not-a-uid"]]) {
      const cli = runCli(root, args);
      assert.notEqual(cli.status, 0, `${args.join(" ")} unexpectedly succeeded`);
    }
    assert.equal(sha256(file), beforeHash);
  });

  await test("T9", "second one-shot run is idempotent and does not rewrite ownership/content", async () => {
    const file = path.join(mappedRoot, "data", "zalo.db");
    const dbBefore = moDb(file, sqlite3.OPEN_READONLY);
    const before = await migratedSnapshot(dbBefore);
    await dbBefore.close();
    const cli = runCli(mappedRoot, ["--owner-uid", SYNTHETIC_OWNER]);
    assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
    assert.match(cli.stdout, /AI_MIGRATED = NO/);
    assert.match(cli.stdout, /TRAINING_MIGRATED = NO/);
    const dbAfter = moDb(file, sqlite3.OPEN_READONLY);
    assert.deepEqual(await migratedSnapshot(dbAfter), before);
    await dbAfter.close();
  });

  await test("T10", "fresh database succeeds without explicit owner", async () => {
    const root = fixtureRoot(temp, "t10-fresh");
    const db = moDb(path.join(root, "data", "zalo.db"));
    const report = await migrateP9ZaloUidProfile(db);
    assert.deepEqual(report, {
      aiMigrated: false,
      trainingMigrated: false,
      legacyAiOwnerUid: null,
      legacyTrainingOwnerUid: null,
    });
    assert.ok((await db.all("PRAGMA table_info(ai_chat_config)")).some((column) => column.name === "owner_uid"));
    assert.ok((await db.all("PRAGMA table_info(training_messages)")).some((column) => column.name === "owner_uid"));
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM ai_chat_config")).n, 0);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM training_messages")).n, 0);
    await db.close();
  });

  await test("T11", "normal startup supplies no owner and still fails closed", async () => {
    const root = fixtureRoot(temp, "t11-normal-startup");
    const db = await createProductionShapedLegacy(root);
    const before = await legacySnapshot(db);
    await db.close();
    const worker = spawnSync(process.execPath, [THIS_FILE, "--normal-startup-worker", root], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env },
      timeout: 20_000,
    });
    assert.equal(worker.status, 0, `${worker.stdout}\n${worker.stderr}`);
    assert.match(worker.stderr, /P9_STOP: legacy Training khong rong/);
    const afterDb = moDb(path.join(root, "data", "zalo.db"), sqlite3.OPEN_READONLY);
    assert.deepEqual(await legacySnapshot(afterDb), before);
    await afterDb.close();
    const dbSource = fs.readFileSync(path.join(REPO, "lib", "db.js"), "utf8");
    assert.ok(dbSource.includes("await migrateP9ZaloUidProfile({ run, all, get });"));
  });

  await test("T12", "runtime code contains no hardcoded production owner UID", async () => {
    const runtime = [
      fs.readFileSync(path.join(REPO, "lib", "migrations", "p9-zalo-uid-profile.js"), "utf8"),
      fs.readFileSync(CLI, "utf8"),
    ].join("\n");
    assert.deepEqual(runtime.match(/\b[0-9]{12,30}\b/g) || [], []);
  });

  await test("T13", "no previous local UID authority or generic owner inference remains", async () => {
    const migrationSource = fs.readFileSync(
      path.join(REPO, "lib", "migrations", "p9-zalo-uid-profile.js"),
      "utf8"
    );
    const cliSource = fs.readFileSync(CLI, "utf8");
    assert.ok(!migrationSource.includes("LEGACY_AI_OWNER_UID"));
    for (const forbidden of ["account_config", "chuHienTai", "currentOwner", "only one account", "Soul text"]) {
      assert.ok(!migrationSource.includes(forbidden), `forbidden inference source: ${forbidden}`);
      assert.ok(!cliSource.includes(forbidden), `forbidden CLI inference source: ${forbidden}`);
    }
  });

  const failed = results.filter((result) => !result.pass);
  for (const result of results) {
    console.log(`${result.code} = ${result.pass ? "PASS" : "FAIL"}  ${result.description}`);
    if (result.error) console.log(`      -> ${result.error}`);
  }
  console.log(`\nTONG = ${results.length - failed.length}/${results.length} PASS`);
  console.log(`AI_ROWS_BEFORE = ${mappedBefore?.ai.length ?? "NOT_RUN"}`);
  console.log("AI_ROWS_AFTER = 1");
  console.log(`TRAINING_MESSAGES_BEFORE = ${mappedBefore?.messages.length ?? "NOT_RUN"}`);
  console.log("TRAINING_MESSAGES_AFTER = 3");
  console.log(`TRAINING_SESSION_BEFORE = ${mappedBefore?.session.length ?? "NOT_RUN"}`);
  console.log("TRAINING_SESSION_AFTER = 1");
  console.log("FIXTURE = SYNTHETIC");
  console.log("REAL_PROVIDER_CALL = 0");
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[2] === "--normal-startup-worker") {
  await normalStartupWorker(process.argv[3]);
} else {
  await main();
}
