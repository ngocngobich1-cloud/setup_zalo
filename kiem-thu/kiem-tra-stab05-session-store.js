/**
 * Focused regression proof for STAB-05 Lane 1.
 *
 * The production module is loaded with an in-memory DB import replacement so
 * these tests never open the production database or use external services.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("../lib/session-store.js", import.meta.url);
const dbKey = `__stab05_session_db_${process.pid}`;
const calls = {
  getSession: [],
  setSession: [],
  deleteSession: [],
  touchSession: [],
  listSessions: [],
};
let behavior;

function reset(overrides = {}) {
  for (const values of Object.values(calls)) values.length = 0;
  behavior = {
    getSession: async () => null,
    setSession: async () => undefined,
    deleteSession: async () => undefined,
    touchSession: async () => undefined,
    listSessions: async () => [],
    ...overrides,
  };
}

globalThis[dbKey] = Object.fromEntries(
  Object.keys(calls).map((name) => [name, (...args) => {
    calls[name].push(args);
    return behavior[name](...args);
  }])
);

const originalSource = await readFile(sourceUrl, "utf8");
const sessionImport = 'import session from "express-session";';
const dbImport = 'import { deleteSession, getSession, listSessions, setSession, touchSession } from "./db.js";';
assert.equal(originalSource.includes(sessionImport), true, "Khong tim thay import express-session can stub");
assert.equal(originalSource.includes(dbImport), true, "Khong tim thay import DB can stub");

const testSource = originalSource
  .replace(sessionImport, "const session = { Store: class {} };")
  .replace(
    dbImport,
    `const { deleteSession, getSession, listSessions, setSession, touchSession } = globalThis[${JSON.stringify(dbKey)}];`
  );
const moduleUrl = `data:text/javascript;base64,${Buffer.from(testSource).toString("base64")}`;
const { SqliteSessionStore } = await import(moduleUrl);
const store = new SqliteSessionStore();

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function waitForCallback(invoke) {
  let callbackCount = 0;
  return new Promise((resolve) => {
    invoke((...args) => {
      callbackCount += 1;
      resolve({
        args,
        get callbackCount() {
          return callbackCount;
        },
      });
    });
  });
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function proveThrowDoesNotCauseSecondCallback(invoke, label) {
  const callbackError = new Error(`${label}-callback-throw`);
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let callbackCount = 0;
  try {
    invoke(() => {
      callbackCount += 1;
      throw callbackError;
    });
    await settle();
    assert.equal(callbackCount, 1, `${label}: callback bi goi lan thu hai sau khi callback thanh cong nem loi`);
    assert.deepEqual(unhandled, [callbackError], `${label}: loi callback phai nam ngoai store/DB error boundary`);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

test("get parses valid JSON exactly once", async () => {
  reset({ getSession: async () => '{"user":{"id":7}}' });
  const result = await waitForCallback((callback) => store.get("sid-valid", callback));
  await settle();
  assert.deepEqual(result.args, [null, { user: { id: 7 } }]);
  assert.equal(result.callbackCount, 1);
  assert.deepEqual(calls.getSession, [["sid-valid"]]);
  assert.equal(calls.deleteSession.length, 0);
});

test("get returns a missing session exactly once", async () => {
  reset({ getSession: async () => null });
  const result = await waitForCallback((callback) => store.get("sid-missing", callback));
  await settle();
  assert.deepEqual(result.args, [null, null]);
  assert.equal(result.callbackCount, 1);
  assert.equal(calls.deleteSession.length, 0);
});

test("get reports DB rejection exactly once", async () => {
  const dbError = new Error("get-db-error");
  reset({ getSession: async () => { throw dbError; } });
  const result = await waitForCallback((callback) => store.get("sid-db-error", callback));
  await settle();
  assert.deepEqual(result.args, [dbError]);
  assert.equal(result.callbackCount, 1);
  assert.equal(calls.deleteSession.length, 0);
});

test("get removes malformed JSON and returns a miss exactly once", async () => {
  reset({ getSession: async () => "{malformed" });
  const result = await waitForCallback((callback) => store.get("sid-corrupt", callback));
  await settle();
  assert.deepEqual(calls.deleteSession, [["sid-corrupt"]]);
  assert.deepEqual(result.args, [null, null]);
  assert.equal(result.callbackCount, 1);
});

test("get reports malformed-session cleanup failure exactly once", async () => {
  const cleanupError = new Error("cleanup-error");
  reset({
    getSession: async () => "not-json",
    deleteSession: async () => { throw cleanupError; },
  });
  const result = await waitForCallback((callback) => store.get("sid-cleanup-error", callback));
  await settle();
  assert.deepEqual(calls.deleteSession, [["sid-cleanup-error"]]);
  assert.deepEqual(result.args, [cleanupError]);
  assert.equal(result.callbackCount, 1);
  assert.equal(result.args.length, 1, "cleanup failure khong duoc tra session miss thanh cong");
});

test("get callback throw cannot reach a second callback", async () => {
  reset({ getSession: async () => '{"ok":true}' });
  await proveThrowDoesNotCauseSecondCallback(
    (callback) => store.get("sid-get-throw", callback),
    "get"
  );
});

test("set succeeds exactly once and preserves expiry", async () => {
  reset();
  const expires = new Date("2030-01-02T03:04:05.000Z");
  const phien = { cookie: { expires }, user: { id: 9 } };
  const result = await waitForCallback((callback) => store.set("sid-set", phien, callback));
  await settle();
  assert.deepEqual(result.args, [null]);
  assert.equal(result.callbackCount, 1);
  assert.deepEqual(calls.setSession, [["sid-set", JSON.stringify(phien), expires.getTime()]]);
});

test("set reports DB rejection exactly once", async () => {
  const dbError = new Error("set-db-error");
  reset({ setSession: async () => { throw dbError; } });
  const result = await waitForCallback((callback) => store.set("sid-set-error", {}, callback));
  await settle();
  assert.deepEqual(result.args, [dbError]);
  assert.equal(result.callbackCount, 1);
});

test("set callback throw cannot reach a second callback", async () => {
  reset();
  await proveThrowDoesNotCauseSecondCallback(
    (callback) => store.set("sid-set-throw", {}, callback),
    "set"
  );
});

test("destroy succeeds exactly once", async () => {
  reset();
  const result = await waitForCallback((callback) => store.destroy("sid-destroy", callback));
  await settle();
  assert.deepEqual(result.args, [null]);
  assert.equal(result.callbackCount, 1);
  assert.deepEqual(calls.deleteSession, [["sid-destroy"]]);
});

test("destroy reports DB rejection exactly once", async () => {
  const dbError = new Error("destroy-db-error");
  reset({ deleteSession: async () => { throw dbError; } });
  const result = await waitForCallback((callback) => store.destroy("sid-destroy-error", callback));
  await settle();
  assert.deepEqual(result.args, [dbError]);
  assert.equal(result.callbackCount, 1);
});

test("destroy callback throw cannot reach a second callback", async () => {
  reset();
  await proveThrowDoesNotCauseSecondCallback(
    (callback) => store.destroy("sid-destroy-throw", callback),
    "destroy"
  );
});

test("touch succeeds exactly once and preserves expiry", async () => {
  reset();
  const expires = new Date("2031-02-03T04:05:06.000Z");
  const result = await waitForCallback((callback) => store.touch(
    "sid-touch",
    { cookie: { expires } },
    callback
  ));
  await settle();
  assert.deepEqual(result.args, [null]);
  assert.equal(result.callbackCount, 1);
  assert.deepEqual(calls.touchSession, [["sid-touch", expires.getTime()]]);
});

test("touch reports DB rejection exactly once", async () => {
  const dbError = new Error("touch-db-error");
  reset({ touchSession: async () => { throw dbError; } });
  const result = await waitForCallback((callback) => store.touch("sid-touch-error", {}, callback));
  await settle();
  assert.deepEqual(result.args, [dbError]);
  assert.equal(result.callbackCount, 1);
});

test("touch callback throw cannot reach a second callback", async () => {
  reset();
  await proveThrowDoesNotCauseSecondCallback(
    (callback) => store.touch("sid-touch-throw", {}, callback),
    "touch"
  );
});

test("length returns the row count exactly once", async () => {
  reset({ listSessions: async () => [{ sid: "one" }, { sid: "two" }] });
  const result = await waitForCallback((callback) => store.length(callback));
  await settle();
  assert.deepEqual(result.args, [null, 2]);
  assert.equal(result.callbackCount, 1);
  assert.deepEqual(calls.listSessions, [[]]);
});

test("length reports DB rejection exactly once", async () => {
  const dbError = new Error("length-db-error");
  reset({ listSessions: async () => { throw dbError; } });
  const result = await waitForCallback((callback) => store.length(callback));
  await settle();
  assert.deepEqual(result.args, [dbError]);
  assert.equal(result.callbackCount, 1);
});

test("length callback throw cannot reach a second callback", async () => {
  reset();
  await proveThrowDoesNotCauseSecondCallback(
    (callback) => store.length(callback),
    "length"
  );
});

let passed = 0;
let failed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

delete globalThis[dbKey];
console.log(`PASS_COUNT = ${passed}`);
console.log(`FAIL_COUNT = ${failed}`);
if (failed > 0) process.exitCode = 1;
