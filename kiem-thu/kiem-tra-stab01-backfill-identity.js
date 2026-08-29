/**
 * STAB-01 carry-forward: startup system-message backfill must use the canonical
 * message identity (thread_id, id). All database state is disposable.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(TEST_FILE), "..");
const CHILD_FLAG = "--stab01-backfill-child";

function sqliteRun(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function sqliteAll(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

function sqliteGet(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function sqliteClose(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });
}

function systemRaw(actor, subject) {
  return JSON.stringify({
    data: {
      content: {
        action: "group_event",
        params: JSON.stringify({
          msg: { vi: "%1$s cập nhật: %2$s" },
          dName: actor,
          question: subject,
        }),
      },
    },
  });
}

function rowKey(row) {
  return `${row.thread_id}\u0000${row.id}`;
}

async function readMessages(sqlite3, dbPath) {
  const database = new sqlite3.Database(dbPath);
  try {
    return await sqliteAll(
      database,
      `SELECT id, thread_id, content, is_self, sender_id, sender_name,
              sender_avatar, msg_type, ts, raw_json
       FROM messages ORDER BY thread_id, id`
    );
  } finally {
    await sqliteClose(database);
  }
}

async function runParent() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stab01-backfill-"));
  const childArgs = [...process.execArgv];
  const sqliteRegisterUrl = pathToFileURL(
    path.join(REPO, "kiem-thu", "sqlite3-node24-test-register.js")
  ).href;

  try {
    try {
      await import("sqlite3");
    } catch {
      if (!childArgs.some((arg) => String(arg).includes("sqlite3-node24-test-register.js"))) {
        childArgs.push("--import", sqliteRegisterUrl);
      }
    }

    childArgs.push(TEST_FILE, CHILD_FLAG, tempDir);
    const result = spawnSync(process.execPath, childArgs, {
      cwd: tempDir,
      env: {
        ...process.env,
        APP_SECRET_KEY: "00".repeat(32),
        STAB01_BACKFILL_ISOLATED_TEST: "1",
      },
      stdio: "inherit",
    });

    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runChild(tempDir) {
  assert.equal(process.env.STAB01_BACKFILL_ISOLATED_TEST, "1");
  assert.equal(path.resolve(process.cwd()), path.resolve(tempDir));
  assert.notEqual(path.resolve(process.cwd(), "data"), path.join(REPO, "data"));

  const sqlite3 = (await import("sqlite3")).default;
  const dbUrl = `${pathToFileURL(path.join(REPO, "lib", "db.js")).href}?stab01=${process.pid}`;
  const db = await import(dbUrl);
  const dbPath = path.join(tempDir, "data", "zalo.db");

  // First startup creates the current production schema in disposable storage.
  await db.initDb();

  const seedDb = new sqlite3.Database(dbPath);
  const threadIds = [
    "t01-A",
    "t02-A", "t02-B",
    "t03-A", "t03-B",
    "t04-A", "t04-B",
    "t05-A",
    "t06-A", "t06-B",
    "t07-A",
    "t08-A", "t08-B", "t08-C",
  ];
  try {
    for (const threadId of threadIds) {
      await sqliteRun(
        seedDb,
        `INSERT INTO threads
           (local_id, owner_uid, remote_thread_id, thread_type, updated_at)
         VALUES (?, ?, ?, 0, ?)`,
        [threadId, "owner-stab01", threadId, 1]
      );
    }

    const rows = [
      ["t01-single", "t01-A", "{legacy-t01}", systemRaw("A1", "content-01"), 101],

      ["t02-duplicate", "t02-A", "{legacy-t02-A}", systemRaw("A2", "content-A2"), 201],
      ["t02-duplicate", "t02-B", "T02_B_MUST_STAY", systemRaw("B2", "unused-B2"), 202],

      ["t03-duplicate", "t03-A", "{legacy-t03-A}", systemRaw("A3", "content-A3"), 301],
      ["t03-duplicate", "t03-B", "{legacy-t03-B}", systemRaw("B3", "content-B3"), 302],

      ["t04-duplicate", "t04-A", "{legacy-t04-A}", systemRaw("A4", "content-A4"), 401],
      ["t04-duplicate", "t04-B", "T04_BYTE_SENTINEL", "{\"ordinary\":true}", 402],

      ["t05-target", "t05-A", "{legacy-t05-target}", systemRaw("A5", "content-A5"), 501],
      ["t05-other", "t05-A", "T05_OTHER_MUST_STAY", systemRaw("B5", "unused-B5"), 502],

      ["t06-unusable", "t06-A", "{legacy-t06-invalid}", "", 601],
      ["t06-unusable", "t06-B", "T06_B_MUST_STAY", systemRaw("B6", "unused-B6"), 602],

      ["t07-idempotent", "t07-A", "{legacy-t07}", systemRaw("A7", "content-A7"), 701],

      ["t08-cardinality", "t08-A", "{legacy-t08-A}", systemRaw("A8", "content-A8"), 801],
      ["t08-cardinality", "t08-B", "T08_B_MUST_STAY", systemRaw("B8", "unused-B8"), 802],
      ["t08-cardinality", "t08-C", "T08_C_MUST_STAY", systemRaw("C8", "unused-C8"), 803],
    ];

    for (const [id, threadId, content, rawJson, ts] of rows) {
      await sqliteRun(
        seedDb,
        `INSERT INTO messages
           (id, thread_id, content, is_self, sender_id, sender_name,
            sender_avatar, msg_type, ts, raw_json)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [id, threadId, content, `sender-${threadId}`, `name-${threadId}`,
          `avatar-${threadId}`, "system", ts, rawJson]
      );
    }
  } finally {
    await sqliteClose(seedDb);
  }

  const beforeRows = await readMessages(sqlite3, dbPath);
  const before = new Map(beforeRows.map((row) => [rowKey(row), row]));

  // Second startup is the first run over seeded rows; third proves idempotency.
  await db.initDb();
  const afterFirstRows = await readMessages(sqlite3, dbPath);
  await db.initDb();
  const afterSecondRows = await readMessages(sqlite3, dbPath);
  const after = new Map(afterSecondRows.map((row) => [rowKey(row), row]));
  const content = (threadId, id) => after.get(`${threadId}\u0000${id}`)?.content;

  const tests = [];
  const test = (code, description, run) => tests.push({ code, description, run });

  test("T01", "basic single-row backfill updates the intended row", () => {
    assert.equal(content("t01-A", "t01-single"), "A1 cập nhật: content-01");
  });

  test("T02", "duplicate ID in another thread is not changed", () => {
    assert.equal(content("t02-A", "t02-duplicate"), "A2 cập nhật: content-A2");
    assert.equal(content("t02-B", "t02-duplicate"), "T02_B_MUST_STAY");
  });

  test("T03", "two same-ID candidates retain their different derived content", () => {
    assert.equal(content("t03-A", "t03-duplicate"), "A3 cập nhật: content-A3");
    assert.equal(content("t03-B", "t03-duplicate"), "B3 cập nhật: content-B3");
  });

  test("T04", "same-ID non-candidate remains byte-for-byte unchanged", () => {
    assert.deepEqual(
      after.get("t04-B\u0000t04-duplicate"),
      before.get("t04-B\u0000t04-duplicate")
    );
  });

  test("T05", "different ID in the same thread remains unchanged", () => {
    assert.equal(content("t05-A", "t05-target"), "A5 cập nhật: content-A5");
    assert.deepEqual(after.get("t05-A\u0000t05-other"), before.get("t05-A\u0000t05-other"));
  });

  test("T06", "unusable raw JSON fabricates nothing and crosses no thread", () => {
    assert.deepEqual(after.get("t06-A\u0000t06-unusable"), before.get("t06-A\u0000t06-unusable"));
    assert.deepEqual(after.get("t06-B\u0000t06-unusable"), before.get("t06-B\u0000t06-unusable"));
  });

  test("T07", "second startup backfill is idempotent", () => {
    assert.deepEqual(afterSecondRows, afterFirstRows);
  });

  test("T08", "one candidate changes no more than one composite identity", () => {
    const changed = afterSecondRows.filter((row) => {
      const old = before.get(rowKey(row));
      return row.id === "t08-cardinality" && row.content !== old.content;
    });
    assert.deepEqual(changed.map((row) => [row.thread_id, row.id]), [["t08-A", "t08-cardinality"]]);
  });

  test("T09", "declared message FK rejects an orphan when enforcement is enabled", async () => {
    const constraintDb = new sqlite3.Database(dbPath);
    try {
      await sqliteRun(constraintDb, "PRAGMA foreign_keys = ON");
      assert.equal(Number((await sqliteGet(constraintDb, "PRAGMA foreign_keys")).foreign_keys), 1);
      const foreignKeys = await sqliteAll(constraintDb, "PRAGMA foreign_key_list(messages)");
      assert.ok(foreignKeys.some((fk) => fk.table === "threads" && fk.from === "thread_id" && fk.to === "local_id"));
      await assert.rejects(
        sqliteRun(
          constraintDb,
          `INSERT INTO messages (id, thread_id, content, ts)
           VALUES ('orphan-id', 'missing-thread', 'orphan', 1)`
        ),
        /FOREIGN KEY constraint failed/i
      );
      assert.equal(Number((await sqliteGet(
        constraintDb,
        "SELECT COUNT(*) AS n FROM messages WHERE id = 'orphan-id'"
      )).n), 0);
    } finally {
      await sqliteClose(constraintDb);
    }
  });

  let passed = 0;
  let failed = 0;
  for (const { code, description, run } of tests) {
    try {
      await run();
      passed += 1;
      console.log(`PASS ${code} - ${description}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${code} - ${description}`);
      console.error(error?.stack || error);
    }
  }

  console.log(`\nSTAB01_BACKFILL_RESULT: ${passed}/${tests.length} PASS, ${failed} FAIL`);
  console.log(`PRIMARY_DUPLICATE_ID_REGRESSION = ${failed === 0 ? "PASS" : "FAIL"}`);
  if (failed) process.exitCode = 1;
}

if (process.argv[2] === CHILD_FLAG) {
  await runChild(process.argv[3]);
} else {
  await runParent();
}
