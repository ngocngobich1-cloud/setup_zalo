/**
 * STAB-07A Lane 1: persisted thread previews are an atomic, chronological pair.
 *
 * The parent process creates disposable storage and the child owns the database.
 * This lets the parent remove every test artifact after the child exits, including
 * on Windows where an open SQLite handle prevents cleanup.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(TEST_FILE), "..");
const CHILD_FLAG = "--stab07a-child";

async function runParent() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stab07a-preview-"));
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
      env: { ...process.env, STAB07A_ISOLATED_TEST: "1" },
      stdio: "inherit",
    });

    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runChild(tempDir) {
  assert.equal(process.env.STAB07A_ISOLATED_TEST, "1");
  assert.equal(path.resolve(process.cwd()), path.resolve(tempDir));
  assert.notEqual(path.resolve(process.cwd(), "data"), path.join(REPO, "data"));

  const dbUrl = `${pathToFileURL(path.join(REPO, "lib", "db.js")).href}?stab07a=${process.pid}`;
  const db = await import(dbUrl);
  await db.initDb();

  const tests = [];
  const test = (code, description, run) => tests.push({ code, description, run });
  const preview = (thread) => [thread?.lastMessage ?? null, thread?.lastMessageAt ?? null];
  const expectPreview = async (ownerUid, threadId, expected) => {
    assert.deepEqual(preview(await db.getThread(ownerUid, threadId)), expected);
  };
  const put = (ownerUid, threadId, lastMessage, lastMessageAt, extra = {}) => db.upsertThread(ownerUid, {
    id: threadId,
    threadType: 0,
    lastMessage,
    lastMessageAt,
    ...extra,
  });
  const insert = (ownerUid, threadId, id, content, ts) => db.insertMessage(ownerUid, {
    id,
    threadId,
    threadType: 0,
    content,
    ts,
  });

  test("T1", "historical then newer live keeps the newer live preview", async () => {
    await put("owner-t1", "thread", "H", 100);
    await put("owner-t1", "thread", "L", 200);
    await expectPreview("owner-t1", "thread", ["L", 200]);
  });

  test("T2", "older historical processing cannot regress newer live", async () => {
    await put("owner-t2", "thread", "L", 200);
    await put("owner-t2", "thread", "H", 100);
    await expectPreview("owner-t2", "thread", ["L", 200]);
  });

  test("T3", "out-of-order live event preserves timestamp 200", async () => {
    await put("owner-t3", "thread", "new", 200);
    await put("owner-t3", "thread", "late-old", 150);
    await expectPreview("owner-t3", "thread", ["new", 200]);
  });

  test("T4", "legitimately newer candidate replaces current preview", async () => {
    await put("owner-t4", "thread", "old", 100);
    await put("owner-t4", "thread", "new", 200);
    await expectPreview("owner-t4", "thread", ["new", 200]);
  });

  test("T5", "equal timestamp preserves the existing preview", async () => {
    await put("owner-t5", "thread", "A", 200);
    await put("owner-t5", "thread", "B", 200);
    await expectPreview("owner-t5", "thread", ["A", 200]);
  });

  test("T6", "null current preview accepts a complete valid candidate", async () => {
    await db.upsertThread("owner-t6", { id: "thread", threadType: 0, title: "empty" });
    await put("owner-t6", "thread", "A", 100);
    await expectPreview("owner-t6", "thread", ["A", 100]);
  });

  test("T7", "metadata-only update preserves preview and refreshes metadata", async () => {
    await put("owner-t7", "thread", "A", 200, { title: "before" });
    const updated = await db.upsertThread("owner-t7", {
      id: "thread",
      threadType: 1,
      title: "after",
    });
    assert.equal(updated.title, "after");
    assert.equal(updated.threadType, 1);
    assert.deepEqual(preview(updated), ["A", 200]);
  });

  test("T8", "older candidate rejects preview text and timestamp atomically", async () => {
    await put("owner-t8", "thread", "A", 200);
    await put("owner-t8", "thread", "B", 100);
    await expectPreview("owner-t8", "thread", ["A", 200]);
  });

  test("T9", "rebuild candidate older than current live cannot win its write", async () => {
    await put("owner-t9", "thread", "H", 100);
    await insert("owner-t9", "thread", "history-100", "H", 100);
    await put("owner-t9", "thread", "L", 200);
    await db.rebuildThreadsFromMessages("owner-t9");
    await expectPreview("owner-t9", "thread", ["L", 200]);
  });

  test("T10", "newer rebuild candidate replaces current preview", async () => {
    await put("owner-t10", "thread", "H", 100);
    await insert("owner-t10", "thread", "live-200", "L", 200);
    await db.rebuildThreadsFromMessages("owner-t10");
    await expectPreview("owner-t10", "thread", ["L", 200]);
  });

  test("T11", "equal-timestamp rebuild preserves persisted preview", async () => {
    await put("owner-t11", "thread", "A", 200);
    await insert("owner-t11", "thread", "other-200", "B", 200);
    await db.rebuildThreadsFromMessages("owner-t11");
    await expectPreview("owner-t11", "thread", ["A", 200]);
  });

  test("T12", "non-positive candidate cannot replace valid preview", async () => {
    await put("owner-t12", "thread", "A", 200);
    await put("owner-t12", "thread", "B", 0);
    await expectPreview("owner-t12", "thread", ["A", 200]);
  });

  test("T13", "same remote thread ID remains isolated by owner", async () => {
    await put("owner-a", "shared", "A-old", 100);
    await put("owner-b", "shared", "B", 300);
    await put("owner-a", "shared", "A-new", 200);
    await expectPreview("owner-a", "shared", ["A-new", 200]);
    await expectPreview("owner-b", "shared", ["B", 300]);
  });

  test("T14", "thread sorting continues to follow newest persisted preview", async () => {
    await put("owner-t14", "X", "X-200", 200);
    await put("owner-t14", "Y", "Y-150", 150);
    await put("owner-t14", "X", "X-100", 100);
    const rows = await db.listThreads("owner-t14", { recentOnly: false });
    assert.deepEqual(rows.map((row) => [row.id, row.lastMessageAt]), [["X", 200], ["Y", 150]]);
  });

  test("T15", "text-only candidate preserves the existing preview pair", async () => {
    await put("owner-t15", "thread", "A", 200);
    await db.upsertThread("owner-t15", { id: "thread", lastMessage: "B" });
    await expectPreview("owner-t15", "thread", ["A", 200]);
  });

  test("T16", "timestamp-only candidate preserves the existing preview pair", async () => {
    await put("owner-t16", "thread", "A", 200);
    await db.upsertThread("owner-t16", { id: "thread", lastMessageAt: 300 });
    await expectPreview("owner-t16", "thread", ["A", 200]);
  });

  test("T17", "null current plus text-only candidate establishes no preview", async () => {
    await db.upsertThread("owner-t17", { id: "thread", lastMessage: "A" });
    await expectPreview("owner-t17", "thread", [null, null]);
  });

  test("T18", "null current plus timestamp-only candidate establishes no preview", async () => {
    await db.upsertThread("owner-t18", { id: "thread", lastMessageAt: 100 });
    await expectPreview("owner-t18", "thread", [null, null]);
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

  console.log(`\nSTAB07A_L1_RESULT: ${passed}/${tests.length} PASS, ${failed} FAIL`);
  if (failed) process.exitCode = 1;
}

if (process.argv[2] === CHILD_FLAG) {
  await runChild(process.argv[3]);
} else {
  await runParent();
}
