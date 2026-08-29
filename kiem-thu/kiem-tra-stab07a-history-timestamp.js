/**
 * STAB-07A Lane 2: historical imports must not use processing time as event time.
 *
 * The parent starts a child in disposable storage so the focused checks never
 * read or write the project database. Provider-facing paths use local fakes only.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(TEST_FILE), "..");
const CHILD_FLAG = "--stab07a-history-child";

async function runParent() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stab07a-history-"));
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
      env: { ...process.env, STAB07A_HISTORY_ISOLATED_TEST: "1" },
      stdio: "inherit",
    });

    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runChild(tempDir) {
  assert.equal(process.env.STAB07A_HISTORY_ISOLATED_TEST, "1");
  assert.equal(path.resolve(process.cwd()), path.resolve(tempDir));
  assert.notEqual(path.resolve(process.cwd(), "data"), path.join(REPO, "data"));

  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  const messageUtils = await import(pathToFileURL(path.join(REPO, "lib", "message-utils.js")).href);
  const history = await import(pathToFileURL(path.join(REPO, "lib", "chat-history.js")).href);
  await db.initDb();

  const HISTORICAL_OPTIONS = { allowProcessingTimeFallback: false };
  const OMIT_TIMESTAMP = Symbol("omit-timestamp");
  const tests = [];
  const test = (code, description, run) => tests.push({ code, description, run });
  const raw = (id, threadId, ts = OMIT_TIMESTAMP, content = id) => {
    const data = { msgId: id, content };
    if (ts !== OMIT_TIMESTAMP) data.ts = ts;
    return { threadId, data };
  };
  const normalizeHistorical = (message, fallbackThreadType = 0) =>
    messageUtils.normalizeIncomingMessage(message, fallbackThreadType, HISTORICAL_OPTIONS);
  const preview = (thread) => [thread?.lastMessage ?? null, thread?.lastMessageAt ?? null];
  const expectPreview = async (ownerUid, threadId, expected) => {
    assert.deepEqual(preview(await db.getThread(ownerUid, threadId)), expected);
  };
  const messages = (ownerUid, threadId) => db.getThreadMessages(ownerUid, threadId, 500);

  test("T1", "valid millisecond history timestamp is preserved", async () => {
    assert.equal(normalizeHistorical(raw("t1", "thread", 1_700_000_000_000)).ts, 1_700_000_000_000);
  });

  test("T2", "valid seconds history timestamp is converted to milliseconds", async () => {
    assert.equal(normalizeHistorical(raw("t2", "thread", 1_700_000_000)).ts, 1_700_000_000_000);
  });

  test("T3", "missing history timestamp becomes zero", async () => {
    assert.equal(normalizeHistorical(raw("t3", "thread")).ts, 0);
  });

  test("T4", "null history timestamp becomes zero", async () => {
    assert.equal(normalizeHistorical(raw("t4", "thread", null)).ts, 0);
  });

  test("T5", "zero history timestamp remains zero", async () => {
    assert.equal(normalizeHistorical(raw("t5", "thread", 0)).ts, 0);
  });

  test("T6", "empty history timestamp becomes zero", async () => {
    assert.equal(normalizeHistorical(raw("t6", "thread", "")).ts, 0);
  });

  test("T7", "invalid truthy history timestamp becomes finite zero", async () => {
    const normalized = normalizeHistorical(raw("t7", "thread", "not-a-time")).ts;
    assert.equal(normalized, 0);
    assert.equal(Number.isFinite(normalized), true);
  });

  test("T8", "NaN history timestamp becomes zero", async () => {
    assert.equal(normalizeHistorical(raw("t8", "thread", Number.NaN)).ts, 0);
  });

  test("T9", "negative history timestamp becomes zero", async () => {
    assert.equal(normalizeHistorical(raw("t9", "thread", -10)).ts, 0);
  });

  test("T10", "default live normalization retains processing-time fallback", async () => {
    const originalNow = Date.now;
    Date.now = () => 1_800_000_000_123;
    try {
      assert.equal(messageUtils.normalizeIncomingMessage(raw("t10", "thread")).ts, 1_800_000_000_123);
    } finally {
      Date.now = originalNow;
    }
  });

  test("T11", "invalid historical message persists with timestamp zero", async () => {
    await history.storeMessagesBatch("owner-t11", [raw("t11", "thread", undefined, "stored")]);
    const stored = await messages("owner-t11", "thread");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].content, "stored");
    assert.equal(stored[0].ts, 0);
  });

  test("T12", "invalid history cannot replace a valid preview", async () => {
    await db.upsertThread("owner-t12", {
      id: "thread",
      threadType: 0,
      lastMessage: "live",
      lastMessageAt: 1_700_000_000_200,
    });
    await history.storeMessagesBatch("owner-t12", [raw("t12", "thread", null, "history")]);
    await expectPreview("owner-t12", "thread", ["live", 1_700_000_000_200]);
    assert.equal((await messages("owner-t12", "thread")).length, 1);
  });

  test("T13", "invalid history cannot establish a null preview", async () => {
    await history.storeMessagesBatch("owner-t13", [raw("t13", "thread", 0, "history")]);
    await expectPreview("owner-t13", "thread", [null, null]);
    assert.equal((await messages("owner-t13", "thread")).length, 1);
  });

  test("T14", "hostile mixed batch keeps the newest valid event", async () => {
    await history.storeMessagesBatch("owner-t14", [
      raw("valid-200", "thread", 1_700_000_000_200, "valid 200"),
      raw("invalid-after-200", "thread", undefined, "invalid after 200"),
      raw("valid-100", "thread", 1_700_000_000_100, "valid 100"),
      raw("invalid-last", "thread", "bad", "invalid last"),
    ]);
    await expectPreview("owner-t14", "thread", ["valid 200", 1_700_000_000_200]);
    assert.equal((await messages("owner-t14", "thread")).length, 4);
  });

  test("T15", "valid history wins after an invalid event", async () => {
    await history.storeMessagesBatch("owner-t15", [
      raw("invalid", "thread", undefined, "invalid"),
      raw("valid", "thread", 1_700_000_000_200, "valid 200"),
    ]);
    await expectPreview("owner-t15", "thread", ["valid 200", 1_700_000_000_200]);
  });

  test("T16", "all-invalid history batch persists without a preview", async () => {
    await history.storeMessagesBatch("owner-t16", [
      raw("missing", "thread", OMIT_TIMESTAMP),
      raw("null", "thread", null),
      raw("zero", "thread", 0),
      raw("empty", "thread", ""),
      raw("string", "thread", "not-a-time"),
      raw("nan", "thread", Number.NaN),
      raw("negative", "thread", -1),
    ]);
    const stored = await messages("owner-t16", "thread");
    assert.equal(stored.length, 7);
    assert.deepEqual(new Set(stored.map((message) => message.ts)), new Set([0]));
    await expectPreview("owner-t16", "thread", [null, null]);
  });

  test("T17", "rebuild ignores zero rows and uses a positive maximum", async () => {
    const ownerUid = "owner-t17";
    await db.insertMessage(ownerUid, {
      id: "mixed-zero",
      threadId: "mixed",
      threadType: 0,
      content: "zero",
      ts: 0,
    });
    await db.insertMessage(ownerUid, {
      id: "mixed-valid",
      threadId: "mixed",
      threadType: 0,
      content: "valid",
      ts: 200,
    });
    await db.insertMessage(ownerUid, {
      id: "only-zero",
      threadId: "only-zero",
      threadType: 0,
      content: "unknown",
      ts: 0,
    });
    await db.rebuildThreadsFromMessages(ownerUid);
    await expectPreview(ownerUid, "mixed", ["valid", 200]);
    await expectPreview(ownerUid, "only-zero", [null, null]);
  });

  test("T18", "initial old_messages path uses historical timestamp mode", async () => {
    history.resetHistorySyncState();
    let oldMessagesListener;
    let resolveStored;
    const stored = new Promise((resolve) => { resolveStored = resolve; });
    const api = {
      listener: {
        on(event, listener) {
          assert.equal(event, "old_messages");
          oldMessagesListener = listener;
        },
      },
    };
    history.attachOldMessagesListener(api, () => "owner-t18", resolveStored);
    assert.equal(typeof oldMessagesListener, "function");

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
    try {
      oldMessagesListener([raw("initial-invalid", "thread", undefined, "initial")], 1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    let deadline;
    try {
      await Promise.race([
        stored,
        new Promise((_, reject) => {
          deadline = originalSetTimeout(() => reject(new Error("old_messages test timed out")), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    const rows = await messages("owner-t18", "thread");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ts, 0);
    await expectPreview("owner-t18", "thread", [null, null]);
    history.resetHistorySyncState();
  });

  test("T19", "on-demand group history path uses historical timestamp mode", async () => {
    history.resetHistorySyncState();
    let providerCalls = 0;
    const api = {
      async getGroupChatHistory(threadId, limit) {
        providerCalls += 1;
        assert.equal(threadId, "thread");
        assert.equal(limit, 50);
        return { groupMsgs: [raw("on-demand-invalid", "thread", undefined, "on demand")] };
      },
    };
    await history.syncHistoryForThread(api, "owner-t19", "thread", 1);
    assert.equal(providerCalls, 1);
    const rows = await messages("owner-t19", "thread");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ts, 0);
    await expectPreview("owner-t19", "thread", [null, null]);
    history.resetHistorySyncState();
  });

  test("T20", "outbound timestamp construction remains completion-time based", async () => {
    const source = await fs.readFile(path.join(REPO, "lib", "zalo-service.js"), "utf8");
    assert.match(source, /normalizedMsg\s*=\s*normalizeIncomingMessage\(message\)/);
    assert.match(source, /export async function sendChatMessage[\s\S]*?ts:\s*normalizeTs\(Date\.now\(\)\)/);
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

  console.log(`\nSTAB07A_L2_RESULT: ${passed}/${tests.length} PASS, ${failed} FAIL`);
  if (failed) process.exitCode = 1;
}

if (process.argv[2] === CHILD_FLAG) {
  await runChild(process.argv[3]);
} else {
  await runParent();
}
