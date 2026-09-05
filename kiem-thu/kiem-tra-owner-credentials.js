/**
 * Owner credential authority regression.
 *
 * SQLite chi dung thu muc tam. OpenCode/fetch la deterministic stub; khong co
 * provider, Zalo, network hay paid key that. T30 la conformance probe thu cong
 * rieng tren disposable OpenCode 1.18.4 va KHONG duoc lap lai trong suite nay.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeAllTestDatabases } from "./sqlite3-node24-test-adapter.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "owner-credentials-"));
const ORIGINAL_CWD = process.cwd();
const APP_SECRET_KEY = "11".repeat(32);
const TEST_CONTEXT_ROOT = path.join(TEST_ROOT, "opencode-context");
process.env.APP_SECRET_KEY = APP_SECRET_KEY;
process.env.OPENCODE_CONTEXT_ROOT = TEST_CONTEXT_ROOT;
process.chdir(TEST_ROOT);

const source = {
  db: fs.readFileSync(path.join(REPO, "lib", "db.js"), "utf8"),
  opencode: fs.readFileSync(path.join(REPO, "lib", "opencode.js"), "utf8"),
  owner: fs.readFileSync(path.join(REPO, "lib", "owner-credentials.js"), "utf8"),
  server: fs.readFileSync(path.join(REPO, "server.js"), "utf8"),
  training: fs.readFileSync(path.join(REPO, "public", "training.js"), "utf8"),
  config: fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8"),
  index: fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8"),
  zalo: fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8"),
};
const EVIDENCE_PATH = path.join(
  REPO,
  "kiem-thu",
  "evidence",
  "opencode-auth-directory-probe-1.18.4.md"
);
const OPENCODE_MODULE_URL = pathToFileURL(path.join(REPO, "lib", "opencode.js")).href;

function inheritedNodeArgs() {
  const absoluteImport = (value) => {
    if (/^file:/i.test(value)) return value;
    return pathToFileURL(path.isAbsolute(value) ? value : path.resolve(REPO, value)).href;
  };
  const result = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index];
    if (arg === "--import" && process.execArgv[index + 1]) {
      result.push(arg, absoluteImport(process.execArgv[index + 1]));
      index += 1;
    } else if (arg.startsWith("--import=")) {
      result.push(`--import=${absoluteImport(arg.slice("--import=".length))}`);
    } else {
      result.push(arg);
    }
  }
  return result;
}

const CHILD_NODE_ARGS = inheritedNodeArgs();

const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
const opencode = await import(pathToFileURL(path.join(REPO, "lib", "opencode.js")).href);
const ownerCredentials = await import(pathToFileURL(path.join(REPO, "lib", "owner-credentials.js")).href);
await db.initDb();

const CONFIG = {
  opencodeBaseUrl: "http://opencode.invalid",
  opencodeAgent: "general",
  opencodeModel: "provider-x/chat-model",
  opencodeFallbackModel: "provider-y/chat-model",
};
const REAL_SET_TIMEOUT = globalThis.setTimeout;
const fake = {
  auth: new Map(),
  calls: [],
  contexts: new Map(),
  contextCreations: [],
  inferenceKeys: [],
  failInference: false,
  failPutProvider: null,
  failNextNewDirectoryProviderGet: false,
  fetchOverride: null,
  captureCallTimeouts: false,
  lastScheduledTimeoutMs: null,
  nextSession: 1,
  sessions: new Map(),
};
const providers = ["provider-x", "provider-y"].map((id) => ({
  id,
  name: id === "provider-x" ? "Provider X" : "Provider Y",
  models: {
    "chat-model": {
      name: "Chat Model",
      capabilities: { input: { text: true }, output: { text: true } },
      limit: { context: 16000 },
    },
  },
}));

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function abortError() {
  const error = new Error("fixture aborted");
  error.name = "AbortError";
  return error;
}

function abortableDelay(ms, value, signal, { hang = false } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const abort = () => {
      if (timer) clearTimeout(timer);
      reject(abortError());
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (!hang) {
      timer = REAL_SET_TIMEOUT(() => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      }, ms);
    }
  });
}

async function withCallTimeoutCapture(operation) {
  const originalSetTimeout = globalThis.setTimeout;
  fake.captureCallTimeouts = true;
  globalThis.setTimeout = (callback, delay, ...args) => {
    fake.lastScheduledTimeoutMs = Number(delay);
    return originalSetTimeout(callback, delay, ...args);
  };
  try {
    return await operation();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    fake.captureCallTimeouts = false;
    fake.lastScheduledTimeoutMs = null;
  }
}

const DEFAULT_DIRECTORY = "__default__";

function directoryOf(url) {
  return url.searchParams.get("directory") || DEFAULT_DIRECTORY;
}

function contextFor(directory) {
  if (!fake.contexts.has(directory)) {
    fake.contexts.set(directory, { auth: new Map(fake.auth) });
    fake.contextCreations.push(directory);
  }
  return fake.contexts.get(directory);
}

function providersForContext(context) {
  return providers.filter((provider) => context.auth.has(provider.id));
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const method = String(options.method || "GET").toUpperCase();
  const pathname = url.pathname;
  const directory = directoryOf(url);
  const body = options.body ? JSON.parse(String(options.body)) : null;
  const directoryExists = directory === DEFAULT_DIRECTORY || fs.existsSync(directory);
  const recordedCall = {
    method,
    pathname,
    directory,
    directoryExists,
    publishedDirectory: opencode.credentialPlaneState().credentialDirectory,
    activeReaders: opencode.credentialPlaneState().lock.activeReaders,
    timeoutMs: fake.captureCallTimeouts ? fake.lastScheduledTimeoutMs : undefined,
    recordedAt: Date.now(),
    body,
  };
  fake.calls.push(recordedCall);

  const overridden = fake.fetchOverride?.(recordedCall, options);
  if (overridden !== undefined) return await overridden;

  if (pathname === "/provider" && method === "GET") {
    const isNewDirectory = !fake.contexts.has(directory);
    const context = contextFor(directory);
    if (
      directory !== DEFAULT_DIRECTORY
      && isNewDirectory
      && fake.failNextNewDirectoryProviderGet
    ) {
      fake.failNextNewDirectoryProviderGet = false;
      return json({ error: "fixture candidate provider failure" }, 500);
    }
    return json({ all: providers, default: {}, connected: [...context.auth.keys()] });
  }
  if (pathname === "/config/providers" && method === "GET") {
    return json({ providers: providersForContext(contextFor(directory)) });
  }
  if (pathname.startsWith("/auth/") && method === "PUT") {
    const providerId = decodeURIComponent(pathname.slice("/auth/".length));
    if (fake.failPutProvider === providerId) return json({ error: "fixture put failure" }, 500);
    fake.auth.set(providerId, body.key);
    return json(true);
  }
  if (pathname.startsWith("/auth/") && method === "DELETE") {
    fake.auth.delete(decodeURIComponent(pathname.slice("/auth/".length)));
    return json(true);
  }
  if (pathname === "/session" && method === "POST") {
    const sessionId = `session-${fake.nextSession++}`;
    contextFor(directory);
    fake.sessions.set(sessionId, { directory });
    return json({ id: sessionId });
  }
  if (/^\/session\/[^/]+$/.test(pathname) && method === "GET") {
    const sessionId = pathname.split("/").pop();
    const session = fake.sessions.get(sessionId);
    return session?.directory === directory ? json({ id: sessionId }) : json({ error: "not found" }, 404);
  }
  if (/^\/session\/[^/]+$/.test(pathname) && method === "DELETE") {
    const sessionId = pathname.split("/").pop();
    const session = fake.sessions.get(sessionId);
    if (session?.directory === directory) fake.sessions.delete(sessionId);
    return json(true);
  }
  if (/^\/session\/[^/]+\/message$/.test(pathname) && method === "POST") {
    const sessionId = pathname.split("/")[2];
    const session = fake.sessions.get(sessionId);
    if (session?.directory !== directory) return json({ error: "session context mismatch" }, 404);
    if (!fs.existsSync(directory)) {
      return json({
        name: "UnknownError",
        data: { message: "fixture projection directory is missing" },
      }, 500);
    }
    const providerId = body?.model?.providerID || "provider-x";
    const context = contextFor(directory);
    fake.inferenceKeys.push({
      providerId,
      key: context.auth.get(providerId) || null,
      tools: body?.tools,
      directory,
      sessionId,
    });
    if (fake.failInference) {
      return json({ info: { error: { status: 401, data: { message: "invalid api key" } } }, parts: [] });
    }
    return json({
      info: { providerID: providerId, modelID: body?.model?.modelID || "chat-model", tokens: {} },
      parts: [{ type: "text", text: "OK" }],
    });
  }
  if (pathname === "/agent") return json([{ name: "general" }]);
  if (pathname === "/experimental/tool/ids") return json([]);
  return json({ error: `unhandled ${method} ${pathname}` }, 404);
};

let currentOwner = null;
ownerCredentials.configureCurrentOwnerResolver(() => currentOwner);
await ownerCredentials.projectOwnerCredentials(null, { config: CONFIG });

const sql = new DatabaseSync(path.join(TEST_ROOT, "data", "zalo.db"));
const results = [];

async function test(code, description, run) {
  try {
    await run();
    results.push({ code, description, pass: true });
  } catch (error) {
    if (error?.code === "TEST_MANUAL_SKIP") {
      results.push({ code, description, pass: true, skipped: true, error: error.message });
    } else {
      results.push({ code, description, pass: false, error: error.stack || error.message });
    }
  }
}

function row(ownerUid, providerId) {
  return sql.prepare(
    "SELECT owner_uid, provider_id, secret_enc, created_at, updated_at FROM owner_provider_credentials WHERE owner_uid=? AND provider_id=?"
  ).get(ownerUid, providerId);
}

function rows(ownerUid) {
  return sql.prepare(
    "SELECT owner_uid, provider_id, secret_enc, created_at, updated_at FROM owner_provider_credentials WHERE owner_uid=? ORDER BY provider_id"
  ).all(ownerUid);
}

async function activate(ownerUid) {
  currentOwner = ownerUid;
  return ownerCredentials.projectOwnerCredentials(ownerUid, { config: CONFIG });
}

const KEY_A1 = "fixture-a-one";
const KEY_A2 = "fixture-a-two";
const KEY_B = "fixture-b-one";
const directoryScenario = {};

function projectionDirectories() {
  return fake.contextCreations.filter((directory) =>
    path.dirname(path.resolve(directory)) === path.resolve(TEST_CONTEXT_ROOT)
    && /^zalo-owner-credential-context-[0-9a-f-]+-\d+$/i.test(path.basename(directory))
  );
}

function projectionDirectoryParts(directory) {
  assert.equal(
    path.dirname(path.resolve(directory)),
    path.resolve(TEST_CONTEXT_ROOT),
    `directory nằm ngoài configured root: ${directory}`
  );
  const match = path.basename(String(directory)).match(
    /^zalo-owner-credential-context-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/i
  );
  assert.ok(match, `directory không đúng boot-id form: ${directory}`);
  return { bootId: match[1], generation: Number(match[2]) };
}

function runModuleChild(script, nodeEnv = undefined, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  return spawnSync(process.execPath, [...CHILD_NODE_ARGS, "--input-type=module", "--eval", script], {
    cwd: REPO,
    env,
    encoding: "utf8",
  });
}

await test("T01", "Owner A save creates one encrypted (A,X) row", async () => {
  await activate("A");
  await ownerCredentials.saveCurrentOwnerCredential("A", "provider-x", KEY_A1, { config: CONFIG });
  const saved = row("A", "provider-x");
  assert.ok(saved);
  assert.match(saved.secret_enc, /^v1:/);
  assert.notEqual(saved.secret_enc, KEY_A1);
  assert.equal(rows("A").length, 1);
});

await test("T02", "Owner B status does not expose A", async () => {
  await activate("B");
  assert.deepEqual((await ownerCredentials.listCurrentOwnerCredentialStatus("B", { config: CONFIG })).providers, []);
});

await test("T03", "B saves same provider without changing A", async () => {
  const aBefore = row("A", "provider-x").secret_enc;
  await ownerCredentials.saveCurrentOwnerCredential("B", "provider-x", KEY_B, { config: CONFIG });
  assert.equal(row("A", "provider-x").secret_enc, aBefore);
  assert.notEqual(row("B", "provider-x").secret_enc, aBefore);
});

await test("T04", "A overwrite preserves created_at and advances updated_at", async () => {
  await activate("A");
  const before = row("A", "provider-x");
  await ownerCredentials.saveCurrentOwnerCredential("A", "provider-x", KEY_A2, { config: CONFIG });
  const after = row("A", "provider-x");
  assert.equal(after.created_at, before.created_at);
  assert.ok(after.updated_at > before.updated_at);
  assert.notEqual(after.secret_enc, before.secret_enc);
});

await test("T05", "A selected delete keeps B intact", async () => {
  const bBefore = row("B", "provider-x").secret_enc;
  await ownerCredentials.deleteCurrentOwnerCredential("A", "provider-x", { config: CONFIG });
  assert.equal(row("A", "provider-x"), undefined);
  assert.equal(row("B", "provider-x").secret_enc, bBefore);
});

await test("T06", "A delete-all removes only A rows", async () => {
  await ownerCredentials.saveCurrentOwnerCredential("A", "provider-x", KEY_A2, { config: CONFIG });
  await ownerCredentials.saveCurrentOwnerCredential("A", "provider-y", "fixture-a-y", { config: CONFIG });
  await ownerCredentials.deleteAllCurrentOwnerCredentials("A", { config: CONFIG });
  assert.equal(rows("A").length, 0);
  assert.equal(rows("B").length, 1);
});

await test("T07", "Public contracts contain no plaintext or ciphertext fields", async () => {
  await ownerCredentials.saveCurrentOwnerCredential("A", "provider-x", KEY_A2, { config: CONFIG });
  const status = await ownerCredentials.listCurrentOwnerCredentialStatus("A", { config: CONFIG });
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(KEY_A2));
  assert.ok(!serialized.includes("secret_enc"));
  assert.match(source.server, /res\.json\(\{ ok: true, providerId: saved\.providerId, updatedAt: saved\.updatedAt \}\)/);
  assert.ok(!source.server.includes("req.body?.ownerUid"));
});

await test("T08", "Ciphertext round-trips only through internal decrypt", async () => {
  const stored = row("A", "provider-x");
  assert.notEqual(stored.secret_enc, KEY_A2);
  assert.equal((await db.getOwnerProviderCredential("A", "provider-x")).apiKey, KEY_A2);
});

await test("T09", "Test A uses A projected credential", async () => {
  await activate("A");
  fake.inferenceKeys = [];
  const tested = await ownerCredentials.testCurrentOwnerCredential("A", "provider-x", { config: CONFIG });
  assert.equal(tested.reply, "OK");
  assert.equal(fake.inferenceKeys.at(-1).key, KEY_A2);
  assert.deepEqual(fake.inferenceKeys.at(-1).tools, opencode.KHONG_TOOL);
});

await test("T10", "Test failure does not mutate saved DB state", async () => {
  const before = { ...row("A", "provider-x") };
  fake.failInference = true;
  await assert.rejects(
    ownerCredentials.testCurrentOwnerCredential("A", "provider-x", { config: CONFIG }),
    (error) => error.code === "INVALID_KEY"
  );
  fake.failInference = false;
  const after = row("A", "provider-x");
  for (const field of ["owner_uid", "provider_id", "secret_enc", "created_at", "updated_at"]) {
    assert.equal(after[field], before[field]);
  }
});

await test("T11", "Test key performs no auth mutation", async () => {
  const start = fake.calls.length;
  await ownerCredentials.testCurrentOwnerCredential("A", "provider-x", { config: CONFIG });
  assert.equal(fake.calls.slice(start).filter((call) => call.pathname.startsWith("/auth/")).length, 0);
});

await test("T12", "Concurrent A/B projection boundary never overlaps an A reader", async () => {
  await activate("A");
  const events = [];
  const reader = ownerCredentials.withCurrentOwnerCredentialRead("A", CONFIG, async () => {
    events.push("reader-start");
    await new Promise((resolve) => setTimeout(resolve, 40));
    events.push("reader-end");
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  currentOwner = "B";
  const writer = ownerCredentials.projectOwnerCredentials("B", { config: CONFIG }).then(() => events.push("writer"));
  await Promise.all([reader, writer]);
  assert.deepEqual(events, ["reader-start", "reader-end", "writer"]);
  assert.equal(fake.auth.get("provider-x"), KEY_B);
});

await test("T13", "Credential rows survive a fresh DB process", async () => {
  const dbUrl = pathToFileURL(path.join(REPO, "lib", "db.js")).href;
  const script = [
    `process.env.APP_SECRET_KEY=${JSON.stringify(APP_SECRET_KEY)};`,
    `const db=await import(${JSON.stringify(dbUrl)});`,
    "await db.initDb();",
    "const rows=await db.listOwnerProviderCredentialStatus('B');",
    "if(rows.length!==1||rows[0].providerId!=='provider-x') process.exit(3);",
    "process.exit(0);",
  ].join("");
  const child = spawnSync(process.execPath, [...CHILD_NODE_ARGS, "--input-type=module", "-e", script], {
    cwd: TEST_ROOT,
    env: { ...process.env, APP_SECRET_KEY },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

await test("T14", "Unknown provider is rejected without DB mutation", async () => {
  const before = rows("B").length;
  await assert.rejects(
    ownerCredentials.saveCurrentOwnerCredential("B", "provider-unknown", "fixture", { config: CONFIG }),
    (error) => error.code === "UNKNOWN_PROVIDER"
  );
  assert.equal(rows("B").length, before);
});

await test("T15", "No active owner is rejected", async () => {
  currentOwner = null;
  await assert.rejects(
    ownerCredentials.saveCurrentOwnerCredential(null, "provider-x", "fixture", { config: CONFIG }),
    (error) => error.code === "NO_ACTIVE_OWNER"
  );
  currentOwner = "B";
});

await test("T16", "Model save leaves credentials untouched", async () => {
  const before = row("B", "provider-x").secret_enc;
  await db.saveAiChatConfig("B", { opencodeModel: "provider-x/chat-model" });
  assert.equal(row("B", "provider-x").secret_enc, before);
});

await test("T17", "Assistant save leaves credentials untouched", async () => {
  const before = row("B", "provider-x").secret_enc;
  await db.saveAiChatConfig("B", { soul: "soul", roleTone: "tone", allowedTopics: "topics" });
  assert.equal(row("B", "provider-x").secret_enc, before);
});

await test("T18", "Credential mutation leaves model and fallback untouched", async () => {
  await db.saveAiChatConfig("B", {
    opencodeModel: "provider-x/chat-model",
    opencodeFallbackModel: "provider-y/chat-model",
  });
  const before = await db.getAiChatConfig("B");
  await ownerCredentials.saveCurrentOwnerCredential("B", "provider-y", "fixture-b-y", { config: CONFIG });
  const after = await db.getAiChatConfig("B");
  assert.equal(after.opencodeModel, before.opencodeModel);
  assert.equal(after.opencodeFallbackModel, before.opencodeFallbackModel);
});

await test("T19", "Zero-row owner projects empty and cannot use legacy key", async () => {
  fake.auth.set("provider-x", "legacy-global-fixture");
  await activate("C");
  assert.equal(fake.auth.size, 0);
  assert.deepEqual(opencode.credentialPlaneState().projectedProviderIds, []);
  await assert.rejects(
    ownerCredentials.withCurrentOwnerCredentialRead("C", CONFIG, async () => "forbidden"),
    (error) => error.code === "OWNER_PROVIDER_CREDENTIAL_MISSING"
  );
});

await test("T20", "Settings and Training share owner-scoped authority", async () => {
  for (const browserSource of [source.config, source.training]) {
    assert.ok(browserSource.includes("/api/ai-chat/owner-credentials"));
    assert.ok(browserSource.includes("/api/ai-chat/owner-credentials/test"));
    assert.ok(!browserSource.includes("/api/ai-chat/provider-key"));
  }
});

await test("T21", "Whitespace API key is rejected", async () => {
  await activate("B");
  await assert.rejects(
    ownerCredentials.saveCurrentOwnerCredential("B", "provider-x", "   ", { config: CONFIG }),
    (error) => error.code === "EMPTY_API_KEY"
  );
});

await test("T22", "Corrupt ciphertext fails loudly", async () => {
  const before = row("B", "provider-x").secret_enc;
  sql.prepare("UPDATE owner_provider_credentials SET secret_enc=? WHERE owner_uid=? AND provider_id=?")
    .run("v1:broken", "B", "provider-x");
  await assert.rejects(db.getOwnerProviderCredential("B", "provider-x"), /mã hoá hỏng|Không giải mã/);
  sql.prepare("UPDATE owner_provider_credentials SET secret_enc=? WHERE owner_uid=? AND provider_id=?")
    .run("plaintext-is-forbidden", "B", "provider-x");
  await assert.rejects(db.getOwnerProviderCredential("B", "provider-x"), /định dạng mã hoá v1/);
  sql.prepare("UPDATE owner_provider_credentials SET secret_enc=? WHERE owner_uid=? AND provider_id=?")
    .run(before, "B", "provider-x");
  const dbUrl = pathToFileURL(path.join(REPO, "lib", "db.js")).href;
  const wrongKeyScript = [
    `process.env.APP_SECRET_KEY=${JSON.stringify("22".repeat(32))};`,
    `const db=await import(${JSON.stringify(dbUrl)});`,
    "await db.initDb();",
    "try{await db.getOwnerProviderCredential('B','provider-x');process.exit(0)}catch{process.exit(7)}",
  ].join("");
  const child = spawnSync(process.execPath, [...CHILD_NODE_ARGS, "--input-type=module", "-e", wrongKeyScript], {
    cwd: TEST_ROOT,
    env: { ...process.env, APP_SECRET_KEY: "22".repeat(32) },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(child.status, 7, child.stderr || child.stdout);
});

await test("T23", "Projection uses only PUT/DELETE auth primitives", async () => {
  const start = fake.calls.length;
  await activate("B");
  const mutations = fake.calls.slice(start).filter((call) => !["GET", "POST"].includes(call.method));
  assert.ok(mutations.every((call) => call.pathname.startsWith("/auth/")));
  assert.ok(!source.opencode.includes("/global/config"));
});

await test("T24", "Owner switch waits for active inference reader", async () => {
  await activate("B");
  let releaseReader;
  const reader = ownerCredentials.withCurrentOwnerCredentialRead("B", CONFIG, () =>
    new Promise((resolve) => { releaseReader = resolve; })
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  currentOwner = "A";
  const authStart = fake.calls.length;
  const writer = ownerCredentials.projectOwnerCredentials("A", { config: CONFIG });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(fake.calls.slice(authStart).some((call) => call.pathname.startsWith("/auth/")), false);
  releaseReader();
  await Promise.all([reader, writer]);
});

await test("T25", "20s drain deadline is wired to abort registry and stale send guard", async () => {
  assert.equal(opencode.CREDENTIAL_DRAIN_DEADLINE_MS, 20000);
  assert.match(source.opencode, /onDrainDeadline:[\s\S]*activeCredentialAbortControllers[\s\S]*controller\.abort\(\)/);
  assert.match(source.zalo, /withCurrentOwnerCredentialRead[\s\S]*originConHieuLuc\(originToken\)/);
  let deadline = false;
  let releaseReader;
  const lock = new opencode.WriterPriorityRwLock({
    drainDeadlineMs: 20,
    onDrainDeadline: () => { deadline = true; releaseReader(); },
  });
  releaseReader = await lock.acquireRead();
  const writer = lock.acquireWrite();
  await new Promise((resolve) => setTimeout(resolve, 35));
  const releaseWriter = await writer;
  assert.equal(deadline, true);
  releaseWriter();
});

await test("T26", "Writer priority prevents continuous reader starvation", async () => {
  const lock = new opencode.WriterPriorityRwLock({ drainDeadlineMs: 1000 });
  const order = [];
  const releaseFirst = await lock.acquireRead();
  const writer = lock.acquireWrite().then((release) => { order.push("writer"); return release; });
  const secondReader = lock.acquireRead().then((release) => { order.push("reader-2"); return release; });
  releaseFirst();
  const releaseWriter = await writer;
  assert.deepEqual(order, ["writer"]);
  releaseWriter();
  const releaseSecond = await secondReader;
  assert.deepEqual(order, ["writer", "reader-2"]);
  releaseSecond();
});

await test("T27", "Same-owner mutation serializes with inference", async () => {
  await activate("A");
  let releaseReader;
  const reader = ownerCredentials.withCurrentOwnerCredentialRead("A", CONFIG, () =>
    new Promise((resolve) => { releaseReader = resolve; })
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const start = fake.calls.length;
  const mutation = ownerCredentials.saveCurrentOwnerCredential("A", "provider-x", "fixture-a-three", { config: CONFIG });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(fake.calls.slice(start).some((call) => call.pathname.startsWith("/auth/")), false);
  releaseReader();
  await Promise.all([reader, mutation]);
});

await test("T28", "Test read can coexist with readers but not writer projection", async () => {
  const lock = new opencode.WriterPriorityRwLock({ drainDeadlineMs: 1000 });
  const releaseA = await lock.acquireRead();
  const releaseTest = await lock.acquireRead();
  const writerPromise = lock.acquireWrite();
  let writerAcquired = false;
  writerPromise.then(() => { writerAcquired = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(lock.snapshot().activeReaders, 2);
  assert.equal(writerAcquired, false);
  releaseA();
  releaseTest();
  const releaseWriter = await writerPromise;
  releaseWriter();
});

await test("T29", "Legacy clear-all/global mutation path is unreachable", async () => {
  const activeCredentialSource = source.opencode + source.owner + source.server + source.config + source.training;
  assert.ok(!activeCredentialSource.includes("clearAllProviderKeys"));
  assert.ok(!activeCredentialSource.includes("/global/config"));
  assert.ok(!activeCredentialSource.includes("provider: null"));
});

await test("T30", "Manual OpenCode directory probe evidence is present and parseable", async () => {
  if (!fs.existsSync(EVIDENCE_PATH)) {
    const error = new Error("SKIP: canonical baseline không có manual artifact; task này cấm gọi provider thật.");
    error.code = "TEST_MANUAL_SKIP";
    throw error;
  }
  const evidence = fs.readFileSync(EVIDENCE_PATH, "utf8");
  for (const required of [
    "OPENCODE_VERSION = 1.18.4",
    "PROBE_ENVIRONMENT = ISOLATED_DISPOSABLE_LOCAL_SIDECAR",
    "DEFAULT_CONTEXT_AFTER_PUT = STALE",
    "DEFAULT_CONTEXT_AFTER_DELETE = UNKNOWN_BECAUSE_DEFAULT_CONTEXT_NEVER_OBSERVED_PUT",
    "CONFIG_PROVIDERS_CONTEXT_BEHAVIOR = CONTEXT_DEPENDENT",
    "SYNTHETIC_DIRECTORY_ACCEPTED_BY_OPENCODE = YES",
    "FINAL_FIX_02_DIRECTORY_FORM = /tmp/zalo-owner-credential-context-<bootId>-<projectionGeneration>",
    "FINAL_FIX_02_DIRECTORY_FORM_ACCEPTED_BY_OPENCODE = YES",
    "SELECTED_IMPLEMENTATION_PATH = B_PROJECTION_DIRECTORY",
    "REAL_PROVIDER_CALLS = 0",
    "REAL_API_KEY_USED = NO",
    "USER_CREDENTIAL_TOUCHED = NO",
  ]) {
    assert.ok(evidence.includes(required), `thiếu evidence field: ${required}`);
  }
  assert.ok(!/Authorization\s*:/i.test(evidence));
  assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(evidence));
});

await test("T31", "Partial projection failure cleans sidecar and marks plane not ready", async () => {
  await activate("B");
  fake.failPutProvider = "provider-y";
  const cleanupStart = fake.calls.length;
  await assert.rejects(
    ownerCredentials.saveCurrentOwnerCredential("B", "provider-y", "fixture-failing-y", { config: CONFIG }),
    (error) => error.code === "CREDENTIAL_PROJECTION_FAILED"
  );
  fake.failPutProvider = null;
  assert.equal(opencode.credentialPlaneState().credentialPlaneReady, false);
  assert.equal(fake.auth.size, 0);
  assert.ok(fake.calls.slice(cleanupStart).some((call) => call.method === "DELETE" && call.pathname.startsWith("/auth/")));
  await assert.rejects(
    opencode.withCredentialPlaneRead({}, async () => true),
    (error) => error.code === "CREDENTIAL_PLANE_NOT_READY"
  );
  await ownerCredentials.projectOwnerCredentials("B", { config: CONFIG });
});

await test("T32", "Stale A mutation queued behind switch to B returns 409 semantics", async () => {
  await activate("A");
  const before = row("A", "provider-x").secret_enc;
  let releaseReader;
  const reader = ownerCredentials.withCurrentOwnerCredentialRead("A", CONFIG, () =>
    new Promise((resolve) => { releaseReader = resolve; })
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  currentOwner = "B";
  const switchWriter = ownerCredentials.projectOwnerCredentials("B", { config: CONFIG });
  const staleMutation = ownerCredentials.saveCurrentOwnerCredential(
    "A",
    "provider-x",
    "fixture-stale-a",
    { config: CONFIG }
  );
  releaseReader();
  await reader;
  await switchWriter;
  await assert.rejects(staleMutation, (error) => error.code === "OWNER_CONTEXT_CHANGED");
  assert.equal(ownerCredentials.ownerCredentialHttpError(
    Object.assign(new Error("stale"), { code: "OWNER_CONTEXT_CHANGED" })
  ).status, 409);
  assert.equal(row("A", "provider-x").secret_enc, before);
  assert.equal(fake.auth.get("provider-x"), KEY_B);
});

await test("T33", "Stale default/A cache can never answer B inference", async () => {
  await activate("A");
  const aDirectory = opencode.credentialPlaneState().credentialDirectory;
  const aKey = (await db.getOwnerProviderCredential("A", "provider-x")).apiKey;
  assert.equal(fake.contexts.get(aDirectory).auth.get("provider-x"), aKey);

  // Mo phong dung P1: default context da cache A va se khong thay PUT B.
  fake.contexts.set(DEFAULT_DIRECTORY, { auth: new Map([["provider-x", aKey]]) });
  const projectionStart = fake.calls.length;
  await activate("B");
  const bDirectory = opencode.credentialPlaneState().credentialDirectory;
  const projectionCalls = fake.calls.slice(projectionStart);
  const verification = projectionCalls.find(
    (call) => call.method === "GET" && call.pathname === "/provider" && call.directory === bDirectory
  );
  assert.ok(verification, "B projection không verify candidate directory");

  fake.inferenceKeys = [];
  await opencode.runOneShot(CONFIG, "T33", "fixture");
  const inference = fake.inferenceKeys.at(-1);
  assert.equal(inference.directory, bDirectory);
  assert.equal(inference.key, KEY_B);
  assert.notEqual(inference.directory, aDirectory);
  assert.notEqual(inference.directory, DEFAULT_DIRECTORY);
  assert.equal(fake.contexts.get(DEFAULT_DIRECTORY).auth.get("provider-x"), aKey);
  directoryScenario.aDirectory = aDirectory;
  directoryScenario.bDirectory = bDirectory;
  directoryScenario.bVerificationDirectory = verification.directory;
  directoryScenario.bInferenceDirectory = inference.directory;
});

await test("T34", "Verification directory exactly matches inference directory", async () => {
  assert.equal(directoryScenario.bVerificationDirectory, directoryScenario.bInferenceDirectory);
  assert.equal(directoryScenario.bInferenceDirectory, opencode.credentialPlaneState().credentialDirectory);
});

await test("T35", "/config/providers uses active inference directory", async () => {
  const start = fake.calls.length;
  await opencode.loadChatProviders(CONFIG);
  const calls = fake.calls.slice(start).filter((call) => call.pathname === "/config/providers");
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.directory === opencode.credentialPlaneState().credentialDirectory));
});

await test("T36", "POST /session uses active inference directory", async () => {
  const start = fake.calls.length;
  await opencode.runOneShot(CONFIG, "T36", "fixture");
  const create = fake.calls.slice(start).find(
    (call) => call.method === "POST" && call.pathname === "/session"
  );
  assert.equal(create.directory, opencode.credentialPlaneState().credentialDirectory);
});

await test("T37", "POST session message uses active inference directory", async () => {
  const start = fake.calls.length;
  await opencode.runOneShot(CONFIG, "T37", "fixture");
  const message = fake.calls.slice(start).find(
    (call) => call.method === "POST" && /\/session\/[^/]+\/message$/.test(call.pathname)
  );
  assert.equal(message.directory, opencode.credentialPlaneState().credentialDirectory);
});

await test("T38", "testProviderKey uses active inference directory", async () => {
  const activeDirectory = opencode.credentialPlaneState().credentialDirectory;
  const start = fake.calls.length;
  await ownerCredentials.testCurrentOwnerCredential("B", "provider-x", { config: CONFIG });
  const relevant = fake.calls.slice(start).filter((call) =>
    call.pathname === "/config/providers"
    || call.pathname === "/session"
    || /\/session\/[^/]+(?:\/message)?$/.test(call.pathname)
  );
  assert.ok(relevant.length >= 4);
  assert.ok(relevant.every((call) => call.directory === activeDirectory));
});

await test("T39", "A to B projection advances directory exactly once", async () => {
  await activate("A");
  const aDirectory = opencode.credentialPlaneState().credentialDirectory;
  const before = projectionDirectories().length;
  await activate("B");
  const after = projectionDirectories().length;
  const bDirectory = opencode.credentialPlaneState().credentialDirectory;
  assert.equal(after - before, 1);
  assert.notEqual(bDirectory, aDirectory);
});

await test("T40", "Status and catalog reads never rotate projection directory", async () => {
  const beforeDirectory = opencode.credentialPlaneState().credentialDirectory;
  const beforeGeneration = opencode.credentialPlaneState().projectionGeneration;
  const beforeCount = projectionDirectories().length;
  await ownerCredentials.listCurrentOwnerCredentialStatus("B", { config: CONFIG });
  await ownerCredentials.listCurrentOwnerProviderCatalog("B", { config: CONFIG });
  await opencode.loadChatProviders(CONFIG);
  await ownerCredentials.listCurrentOwnerCredentialStatus("B", { config: CONFIG });
  assert.equal(projectionDirectories().length, beforeCount);
  assert.equal(opencode.credentialPlaneState().credentialDirectory, beforeDirectory);
  assert.equal(opencode.credentialPlaneState().projectionGeneration, beforeGeneration);
  assert.ok(!source.opencode.includes("providerReadGeneration"));
});

await test("T41", "Failed projection never publishes candidate directory", async () => {
  const publishedBefore = opencode.credentialPlaneState().credentialDirectory;
  const createdBefore = projectionDirectories().length;
  fake.failNextNewDirectoryProviderGet = true;
  await assert.rejects(
    ownerCredentials.projectOwnerCredentials("B", { config: CONFIG }),
    (error) => error.code === "CREDENTIAL_PROJECTION_FAILED"
  );
  const failedCandidate = projectionDirectories().at(-1);
  assert.equal(projectionDirectories().length - createdBefore, 1);
  assert.notEqual(failedCandidate, publishedBefore);
  assert.equal(opencode.credentialPlaneState().credentialPlaneReady, false);
  assert.equal(opencode.credentialPlaneState().credentialDirectory, null);
  await ownerCredentials.projectOwnerCredentials("B", { config: CONFIG });
});

await test("T42", "Old projection directory is unusable after owner switch", async () => {
  const oldBDirectory = opencode.credentialPlaneState().credentialDirectory;
  await activate("A");
  await assert.rejects(
    opencode.call(CONFIG, "/config/providers", {
      method: "GET",
      credentialDirectory: oldBDirectory,
    }),
    (error) => error.code === "CREDENTIAL_DIRECTORY_CONTEXT_CHANGED"
  );
  await assert.rejects(
    ownerCredentials.withCurrentOwnerCredentialRead("B", CONFIG, async () => true),
    (error) => error.code === "OWNER_CONTEXT_CHANGED"
  );
  await activate("B");
});

await test("T43", "Same provider A key is overwritten and observed as B key", async () => {
  await activate("A");
  const aKey = (await db.getOwnerProviderCredential("A", "provider-x")).apiKey;
  assert.equal(fake.contexts.get(opencode.credentialPlaneState().credentialDirectory).auth.get("provider-x"), aKey);
  const start = fake.calls.length;
  await activate("B");
  const projectionCalls = fake.calls.slice(start);
  assert.equal(projectionCalls.filter(
    (call) => call.method === "PUT" && call.pathname === "/auth/provider-x"
  ).length, 1);
  assert.equal(fake.auth.get("provider-x"), KEY_B);
  const bDirectory = opencode.credentialPlaneState().credentialDirectory;
  assert.equal(fake.contexts.get(bDirectory).auth.get("provider-x"), KEY_B);
  fake.inferenceKeys = [];
  await opencode.runOneShot(CONFIG, "T43", "fixture");
  assert.equal(fake.inferenceKeys.at(-1).key, KEY_B);
  assert.equal(fake.inferenceKeys.at(-1).directory, bDirectory);
});

await test("T44", "Session from old projection directory is recreated", async () => {
  const threadId = "directory-sensitive-thread";
  const bootstrap = {
    threadTitle: "Fixture",
    soul: "Fixture",
    roleTone: "",
    allowedTopics: "fixture",
    knowledgeSection: "",
    recentHistory: "",
  };
  const firstDirectory = opencode.credentialPlaneState().credentialDirectory;
  const first = await opencode.ensureSession(CONFIG, "B", threadId, bootstrap);
  assert.equal(first.created, true);
  assert.equal(fake.sessions.get(first.sessionId).directory, firstDirectory);
  const sameGenerationStart = fake.calls.length;
  const reused = await opencode.ensureSession(CONFIG, "B", threadId, bootstrap);
  assert.equal(reused.created, false);
  assert.equal(reused.sessionId, first.sessionId);
  const validation = fake.calls.slice(sameGenerationStart).find(
    (call) => call.method === "GET" && call.pathname === `/session/${first.sessionId}`
  );
  assert.equal(validation.directory, firstDirectory);

  await ownerCredentials.saveCurrentOwnerCredential(
    "B",
    "provider-x",
    "fixture-b-rotated",
    { config: CONFIG }
  );
  const secondDirectory = opencode.credentialPlaneState().credentialDirectory;
  assert.notEqual(secondDirectory, firstDirectory);
  const start = fake.calls.length;
  const second = await opencode.ensureSession(CONFIG, "B", threadId, bootstrap);
  assert.equal(second.created, true);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(fake.sessions.get(second.sessionId).directory, secondDirectory);
  assert.equal(fake.calls.slice(start).some(
    (call) => call.method === "GET" && call.pathname === `/session/${first.sessionId}`
  ), false);
  assert.equal(fake.inferenceKeys.at(-1).key, "fixture-b-rotated");
  assert.equal(fake.inferenceKeys.at(-1).directory, secondDirectory);
});

await test("T45", "Projection directory contains stable per-boot entropy", async () => {
  const firstDirectory = opencode.credentialPlaneState().credentialDirectory;
  await activate("B");
  const secondDirectory = opencode.credentialPlaneState().credentialDirectory;
  const first = projectionDirectoryParts(firstDirectory);
  const second = projectionDirectoryParts(secondDirectory);
  directoryScenario.sameBootFirst = firstDirectory;
  directoryScenario.sameBootSecond = secondDirectory;
  directoryScenario.bootId = first.bootId;
  assert.equal(first.bootId, second.bootId);
  assert.ok(first.bootId.length > 0);
});

await test("T46", "Two projection generations in one boot use different directories", async () => {
  assert.notEqual(directoryScenario.sameBootFirst, directoryScenario.sameBootSecond);
  const first = projectionDirectoryParts(directoryScenario.sameBootFirst);
  const second = projectionDirectoryParts(directoryScenario.sameBootSecond);
  assert.notEqual(first.generation, second.generation);
  assert.equal(first.bootId, second.bootId);
});

await test("T47", "A new app boot remains unique with reset projection generation", async () => {
  const childScript = `
    const opencode = await import(${JSON.stringify(OPENCODE_MODULE_URL)});
    const directory = await opencode.withCredentialPlaneWrite(
      () => opencode.allocateCredentialProjectionDirectory()
    );
    console.log("DIRECTORY=" + directory);
  `;
  const first = runModuleChild(childScript);
  const second = runModuleChild(childScript);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const firstDirectory = first.stdout.match(/DIRECTORY=([^\r\n]+)/)?.[1];
  const secondDirectory = second.stdout.match(/DIRECTORY=([^\r\n]+)/)?.[1];
  assert.ok(firstDirectory);
  assert.ok(secondDirectory);
  assert.equal(projectionDirectoryParts(firstDirectory).generation, 1);
  assert.equal(projectionDirectoryParts(secondDirectory).generation, 1);
  assert.notEqual(firstDirectory, secondDirectory);
});

await test("T48", "POST /session records the active directory", async () => {
  const activeDirectory = opencode.credentialPlaneState().credentialDirectory;
  const bindingsBefore = opencode.credentialPlaneState().sessionDirectoryBindings;
  const session = await opencode.call(CONFIG, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "T48" }),
  });
  assert.equal(fake.sessions.get(session.id).directory, activeDirectory);
  assert.equal(opencode.credentialPlaneState().sessionDirectoryBindings, bindingsBefore + 1);
  directoryScenario.boundSessionId = session.id;
  directoryScenario.boundSessionDirectory = activeDirectory;
});

await test("T49", "GET /session/{id} automatically uses its bound directory", async () => {
  const start = fake.calls.length;
  await opencode.call(CONFIG, `/session/${encodeURIComponent(directoryScenario.boundSessionId)}`, {
    method: "GET",
  });
  const call = fake.calls.slice(start).find((item) => item.method === "GET");
  assert.equal(call.directory, directoryScenario.boundSessionDirectory);
});

await test("T50", "DELETE /session/{id} automatically uses its bound directory", async () => {
  const activeDirectory = opencode.credentialPlaneState().credentialDirectory;
  const session = await opencode.call(CONFIG, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "T50" }),
  });
  const start = fake.calls.length;
  await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" });
  const call = fake.calls.slice(start).find((item) => item.method === "DELETE");
  assert.equal(call.directory, activeDirectory);
});

await test("T51", "POST /session/{id}/message uses its bound directory", async () => {
  const start = fake.calls.length;
  await opencode.call(
    CONFIG,
    `/session/${encodeURIComponent(directoryScenario.boundSessionId)}/message`,
    {
      method: "POST",
      body: JSON.stringify({
        model: { providerID: "provider-x", modelID: "chat-model" },
        parts: [{ type: "text", text: "T51" }],
      }),
    }
  );
  const call = fake.calls.slice(start).find((item) => item.method === "POST");
  assert.equal(call.directory, directoryScenario.boundSessionDirectory);
});

await test("T52", "Projection change prevents reuse of an old session", async () => {
  const session = await opencode.call(CONFIG, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "T52" }),
  });
  const oldDirectory = opencode.credentialPlaneState().credentialDirectory;
  await activate("B");
  assert.notEqual(opencode.credentialPlaneState().credentialDirectory, oldDirectory);
  const start = fake.calls.length;
  await assert.rejects(
    opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, { method: "GET" }),
    (error) => error.status === 404 && error.code === "OPENCODE_SESSION_CONTEXT_STALE"
  );
  assert.equal(fake.calls.length, start);
});

await test("T53", "Training-style direct session lifecycle stays in one directory", async () => {
  const activeDirectory = opencode.credentialPlaneState().credentialDirectory;
  const start = fake.calls.length;
  const session = await opencode.call(CONFIG, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "T53" }),
  });
  await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, { method: "GET" });
  await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}/message`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "T53" }] }),
  });
  await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" });
  const calls = fake.calls.slice(start).filter((item) =>
    item.pathname === "/session" || item.pathname.includes(`/session/${session.id}`)
  );
  assert.equal(calls.length, 4);
  assert.ok(calls.every((item) => item.directory === activeDirectory));
});

await test("T54", "Admin-style direct DELETE uses the recorded directory", async () => {
  const session = await opencode.call(CONFIG, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "T54" }),
  });
  const recordedDirectory = opencode.credentialPlaneState().credentialDirectory;
  await activate("B");
  assert.notEqual(opencode.credentialPlaneState().credentialDirectory, recordedDirectory);
  const start = fake.calls.length;
  await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" });
  const call = fake.calls.slice(start).find((item) => item.method === "DELETE");
  assert.equal(call.directory, recordedDirectory);
  assert.equal(fake.sessions.has(session.id), false);
});

await test("T55", "Successful DELETE removes the session-directory mapping", async () => {
  const session = await opencode.call(CONFIG, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "T55" }),
  });
  const boundCount = opencode.credentialPlaneState().sessionDirectoryBindings;
  await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" });
  assert.equal(opencode.credentialPlaneState().sessionDirectoryBindings, boundCount - 1);
  const start = fake.calls.length;
  await assert.rejects(
    opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, { method: "GET" }),
    (error) => error.status === 404 && error.code === "OPENCODE_SESSION_DIRECTORY_UNKNOWN"
  );
  assert.equal(fake.calls.length, start);
});

await test("T56", "Unknown session cannot fall back to the default directory", async () => {
  const start = fake.calls.length;
  await assert.rejects(
    opencode.call(CONFIG, "/session/fixture-unknown", {
      method: "GET",
      credentialDependent: false,
    }),
    (error) => error.status === 404 && error.code === "OPENCODE_SESSION_DIRECTORY_UNKNOWN"
  );
  assert.equal(fake.calls.length, start);
  assert.equal(fake.calls.slice(start).some((item) => item.directory === DEFAULT_DIRECTORY), false);
});

await test("T57", "Explicit credential directory works with NODE_ENV unset", async () => {
  const directory = "/tmp/test-t57-explicit-credential-context";
  const childScript = `
    const opencode = await import(${JSON.stringify(OPENCODE_MODULE_URL)});
    let observed = null;
    globalThis.fetch = async (input) => {
      observed = String(input);
      return new Response(JSON.stringify({ providers: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    opencode.markCredentialPlaneReady("T57", [], ${JSON.stringify(directory)});
    await opencode.call(
      { opencodeBaseUrl: "http://fixture.invalid" },
      "/config/providers",
      { method: "GET" }
    );
    console.log("OBSERVED=" + observed);
  `;
  const child = runModuleChild(childScript);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.ok(child.stdout.includes(`directory=${encodeURIComponent(directory)}`));
});

await test("T58", "Missing directory fails closed even with NODE_ENV=test", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    assert.throws(
      () => opencode.markCredentialPlaneReady("T58", []),
      (error) => error.code === "CREDENTIAL_DIRECTORY_REQUIRED"
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
  assert.ok(!source.opencode.includes("testDefaultCredentialContext"));
  assert.ok(!source.opencode.includes("process.env.NODE_ENV"));
});

await test("T59", "Projection directory physically exists before publication", async () => {
  const previouslyPublished = opencode.credentialPlaneState().credentialDirectory;
  const start = fake.calls.length;
  await activate("B");
  const activeDirectory = opencode.credentialPlaneState().credentialDirectory;
  const verification = fake.calls.slice(start).find((call) =>
    call.method === "GET"
    && call.pathname === "/provider"
    && call.directory === activeDirectory
  );
  assert.ok(verification, "projection candidate was not verified");
  assert.equal(verification.directoryExists, true);
  assert.equal(verification.publishedDirectory, previouslyPublished);
  assert.notEqual(verification.publishedDirectory, activeDirectory);
  assert.equal(fs.existsSync(activeDirectory), true);
});

await test("T60", "Projection refuses to publish when mkdir fails", async () => {
  const blockedRoot = path.join(TEST_ROOT, "blocked-context-root");
  fs.writeFileSync(blockedRoot, "fixture regular file");
  const childScript = `
    globalThis.fetch = async () => new Response(JSON.stringify({ all: [], connected: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const opencode = await import(${JSON.stringify(OPENCODE_MODULE_URL)});
    const owner = await import(${JSON.stringify(
      pathToFileURL(path.join(REPO, "lib", "owner-credentials.js")).href
    )});
    try {
      await owner.projectOwnerCredentials(null, {
        config: { opencodeBaseUrl: "http://fixture.invalid" },
      });
      console.log("RESULT=" + JSON.stringify({ unexpectedlyPublished: true }));
      process.exitCode = 2;
    } catch (error) {
      const state = opencode.credentialPlaneState();
      console.log("RESULT=" + JSON.stringify({
        code: error.code,
        causeCode: error.cause?.code,
        failedCandidate: error.cause?.credentialDirectory || null,
        credentialPlaneReady: state.credentialPlaneReady,
        activeDirectory: state.credentialDirectory,
      }));
    }
  `;
  const child = runModuleChild(childScript, undefined, {
    OPENCODE_CONTEXT_ROOT: blockedRoot,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const resultLine = child.stdout.split(/\r?\n/).find((line) => line.startsWith("RESULT="));
  assert.ok(resultLine, child.stdout);
  const result = JSON.parse(resultLine.slice("RESULT=".length));
  assert.equal(result.code, "CREDENTIAL_PROJECTION_FAILED");
  assert.equal(result.causeCode, "CREDENTIAL_DIRECTORY_CREATE_FAILED");
  assert.equal(result.credentialPlaneReady, false);
  assert.equal(result.activeDirectory, null);
  assert.ok(result.failedCandidate);
  directoryScenario.mkdirFailure = result;
});

await test("T61", "Message inference fails safely for a nonexistent directory", async () => {
  const activeDirectory = opencode.credentialPlaneState().credentialDirectory;
  const session = await opencode.call(CONFIG, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "T61" }),
  });
  let runtimeError = null;
  try {
    fs.rmdirSync(activeDirectory);
    runtimeError = await opencode.call(
      CONFIG,
      `/session/${encodeURIComponent(session.id)}/message`,
      {
        method: "POST",
        body: JSON.stringify({
          model: { providerID: "provider-x", modelID: "chat-model" },
          parts: [{ type: "text", text: "T61" }],
        }),
      }
    ).then(() => null, (error) => error);
  } finally {
    fs.mkdirSync(activeDirectory, { recursive: true });
    await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, {
      method: "DELETE",
    }).catch(() => {});
  }
  assert.ok(runtimeError);
  assert.equal(runtimeError.code, "OPENCODE_RUNTIME_ERROR");
  assert.equal(runtimeError.message, "Hệ thống AI đang gặp lỗi kỹ thuật. Vui lòng thử lại.");
  assert.deepEqual(runtimeError.opencodeDiagnostic, { status: 500, name: "UnknownError" });
  assert.ok(!runtimeError.message.includes("fixture projection directory is missing"));
  assert.ok(!runtimeError.message.includes(activeDirectory));
  assert.deepEqual(ownerCredentials.ownerCredentialHttpError(runtimeError), {
    status: 503,
    code: "OPENCODE_RUNTIME_ERROR",
    message: "Hệ thống AI đang gặp lỗi kỹ thuật. Vui lòng thử lại.",
  });
});

await test("T62", "Message inference succeeds for an existing projection directory", async () => {
  const activeDirectory = opencode.credentialPlaneState().credentialDirectory;
  assert.equal(fs.existsSync(activeDirectory), true);
  const session = await opencode.call(CONFIG, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "T62" }),
  });
  const start = fake.calls.length;
  const response = await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}/message`, {
    method: "POST",
    body: JSON.stringify({
      model: { providerID: "provider-x", modelID: "chat-model" },
      parts: [{ type: "text", text: "T62" }],
    }),
  });
  const messageCall = fake.calls.slice(start).find((call) => call.method === "POST");
  assert.equal(opencode.extractReply(response), "OK");
  assert.equal(messageCall.directory, activeDirectory);
  assert.equal(messageCall.directoryExists, true);
  await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" });
});

await test("T63", "Active projection is under the configured context root", async () => {
  const activeDirectory = path.resolve(opencode.credentialPlaneState().credentialDirectory);
  assert.equal(opencode.OPENCODE_CONTEXT_ROOT, path.resolve(TEST_CONTEXT_ROOT));
  assert.equal(path.dirname(activeDirectory), path.resolve(TEST_CONTEXT_ROOT));
  assert.ok(path.basename(activeDirectory).startsWith("zalo-owner-credential-context-"));
});

await test("T64", "Verification, catalog, session and message share one directory", async () => {
  const start = fake.calls.length;
  await activate("B");
  const activeDirectory = opencode.credentialPlaneState().credentialDirectory;
  await opencode.loadChatProviders(CONFIG);
  const session = await opencode.call(CONFIG, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "T64" }),
  });
  await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}/message`, {
    method: "POST",
    body: JSON.stringify({
      model: { providerID: "provider-x", modelID: "chat-model" },
      parts: [{ type: "text", text: "T64" }],
    }),
  });
  const relevant = fake.calls.slice(start).filter((call) =>
    (call.pathname === "/provider" && call.directory === activeDirectory)
    || call.pathname === "/config/providers"
    || call.pathname === "/session"
    || call.pathname === `/session/${session.id}/message`
  );
  assert.equal(relevant.filter((call) => call.pathname === "/provider").length, 1);
  assert.equal(relevant.filter((call) => call.pathname === "/config/providers").length, 1);
  assert.equal(relevant.filter((call) => call.pathname === "/session").length, 1);
  assert.equal(relevant.filter((call) => call.pathname.endsWith("/message")).length, 1);
  assert.ok(relevant.every((call) => call.directory === activeDirectory));
  assert.ok(relevant.every((call) => call.directoryExists === true));
  const messageCall = relevant.find((call) => call.pathname.endsWith("/message"));
  assert.deepEqual(messageCall.body.model, {
    providerID: "provider-x",
    modelID: "chat-model",
  });
  await opencode.call(CONFIG, `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" });
});

await test("T65", "Projection switch creates a new physical directory", async () => {
  const oldDirectory = opencode.credentialPlaneState().credentialDirectory;
  await activate("B");
  const newDirectory = opencode.credentialPlaneState().credentialDirectory;
  assert.notEqual(newDirectory, oldDirectory);
  assert.equal(fs.existsSync(oldDirectory), true);
  assert.equal(fs.existsSync(newDirectory), true);
});

await test("T66", "Failed mkdir candidate never becomes active", async () => {
  const result = directoryScenario.mkdirFailure;
  assert.ok(result?.failedCandidate);
  assert.equal(result.credentialPlaneReady, false);
  assert.equal(result.activeDirectory, null);
  assert.equal(fs.existsSync(result.failedCandidate), false);
  assert.notEqual(result.failedCandidate, opencode.credentialPlaneState().credentialDirectory);
});

await test("T67", "Save reuses before snapshot: two provider-state calls and zero inference", async () => {
  await activate("B");
  const otherBefore = row("B", "provider-y")?.secret_enc;
  const start = fake.calls.length;
  await ownerCredentials.saveCurrentOwnerCredential(
    "B",
    "provider-x",
    "fixture-b-two-provider-state-calls",
    { config: CONFIG }
  );
  const calls = fake.calls.slice(start);
  const providerStateCalls = calls.filter(
    (call) => call.method === "GET" && call.pathname === "/provider"
  );
  assert.equal(providerStateCalls.length, 2);
  assert.ok(calls.indexOf(providerStateCalls[0]) < calls.findIndex((call) => call.pathname.startsWith("/auth/")));
  assert.ok(calls.indexOf(providerStateCalls[1]) > calls.findIndex((call) => call.pathname.startsWith("/auth/")));
  assert.equal(calls.some((call) => /\/session(?:\/|$)/.test(call.pathname)), false);
  assert.equal(calls.some((call) => call.pathname === "/config/providers"), false);
  assert.equal(row("B", "provider-y")?.secret_enc, otherBefore);
});

await test("T68", "Test key attempts exactly one selected or deterministic provider model", async () => {
  await activate("B");
  const providerY = providers.find((provider) => provider.id === "provider-y");
  const modelFixture = providerY.models["chat-model"];
  providerY.models = {
    "zeta-chat": modelFixture,
    "chat-model": modelFixture,
    "alpha-chat": modelFixture,
  };

  let start = fake.calls.length;
  const selected = await ownerCredentials.testCurrentOwnerCredential("B", "provider-x", { config: CONFIG });
  let messages = fake.calls.slice(start).filter(
    (call) => call.method === "POST" && /\/session\/[^/]+\/message$/.test(call.pathname)
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body.model.providerID, "provider-x");
  assert.equal(messages[0].body.model.modelID, "chat-model");
  assert.equal(selected.daThu, 1);

  start = fake.calls.length;
  const deterministic = await ownerCredentials.testCurrentOwnerCredential("B", "provider-y", { config: CONFIG });
  messages = fake.calls.slice(start).filter(
    (call) => call.method === "POST" && /\/session\/[^/]+\/message$/.test(call.pathname)
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body.model.providerID, "provider-y");
  assert.equal(messages[0].body.model.modelID, "alpha-chat");
  assert.equal(deterministic.daThu, 1);
  assert.equal(deterministic.model, "provider-y/alpha-chat");
  assert.match(source.opencode, /const TEST_MAX_MODELS = 1/);
  const testSource = source.opencode.slice(
    source.opencode.indexOf("export async function testProviderKey"),
    source.opencode.indexOf("export async function sendPrompt")
  );
  assert.doesNotMatch(testSource, /opencodeFallbackModel/);
});

await test("T69", "Test-key failure taxonomy remains distinct", () => {
  assert.equal(opencode.classifyProviderTestFailure({ status: 401, message: "invalid api key" }), "INVALID_KEY");
  assert.equal(opencode.classifyProviderTestFailure({ status: 402, message: "payment required" }), "NO_QUOTA");
  assert.equal(opencode.classifyProviderTestFailure({ code: "TIMEOUT", message: "timeout" }), "TIMEOUT");
  assert.equal(opencode.classifyProviderTestFailure({ status: 503, message: "service unavailable" }), "PROVIDER_UNAVAILABLE");
  assert.equal(opencode.classifyProviderTestFailure({ code: "OPENCODE_RUNTIME_ERROR" }), "OPENCODE_RUNTIME_ERROR");
});

await test("T70", "Frontend Save/Test boundaries are scoped, immediate and secret-safe", () => {
  const saveStart = source.config.indexOf('btnKeySave.addEventListener("click"');
  const testStart = source.config.indexOf('btnKeyTest.addEventListener("click"');
  const deleteStart = source.config.indexOf('btnKeyDelete.addEventListener("click"');
  const saveSource = source.config.slice(saveStart, testStart);
  const testSource = source.config.slice(testStart, deleteStart);
  const successIndex = saveSource.indexOf("Đã lưu API key ${providerName} thành công");
  const busyReleaseIndex = saveSource.indexOf("keyBusy = false");
  const refreshProviderIndex = saveSource.indexOf("await napDanhSachHangChoKey");
  const refreshModelIndex = saveSource.indexOf("await napAgentVaModel");

  assert.equal([...saveSource.matchAll(/fetch\("\/api\/ai-chat\/owner-credentials"/g)].length, 1);
  assert.match(saveSource, /method: "POST"/);
  assert.match(saveSource, /body: JSON\.stringify\(\{ providerId, apiKey: keyValue\.value\.trim\(\) \}\)/);
  assert.match(saveSource, /baoKey\("Đang lưu\.\.\."\)/);
  assert.ok(successIndex >= 0 && successIndex < busyReleaseIndex);
  assert.ok(busyReleaseIndex < refreshProviderIndex);
  assert.ok(busyReleaseIndex < refreshModelIndex);
  assert.match(saveSource.slice(successIndex, refreshProviderIndex), /keyBusy = false;\s*updateKeyButtons\(\);/);
  assert.match(saveSource, /try\s*\{\s*await napDanhSachHangChoKey\(\{ preserveStatus: true \}\);\s*\} catch/);
  assert.match(saveSource, /try\s*\{\s*await napAgentVaModel[\s\S]*?\} catch/);

  assert.match(testSource, /body: JSON\.stringify\(\{ providerId \}\)/);
  assert.doesNotMatch(testSource, /apiKey|keyValue|opencodeFallbackModel/);
  assert.match(testSource, /THONG_BAO_THU_KEY\[String\(data\.error \|\| ""\)\]/);
  assert.match(testSource, /API key \$\{providerName\} hoạt động bình thường\./);
  assert.doesNotMatch(testSource, /Key không dùng được/);
  for (const message of [
    "API key không hợp lệ.",
    "API key hợp lệ nhưng tài khoản đã hết hạn mức hoặc cần thanh toán.",
    "Nhà cung cấp AI phản hồi quá lâu. Vui lòng thử lại.",
    "Nhà cung cấp AI đang tạm thời không khả dụng.",
  ]) assert.ok(source.config.includes(message));

  assert.match(
    source.server,
    /saveCurrentOwnerCredential\([\s\S]*?await aiChat\.refreshConfig\(\);\s*res\.json\(\{ ok: true, providerId: saved\.providerId/
  );
});

await test("T71", "Explicit Test deadline starts at entry and provider pre-validation is absent", () => {
  const start = source.owner.indexOf("export async function testCurrentOwnerCredential");
  const end = source.owner.indexOf("export async function withCurrentOwnerCredentialRead", start);
  const testSource = source.owner.slice(start, end);
  const clockIndex = testSource.indexOf("const startedAt = Date.now()");
  const canonicalIndex = testSource.indexOf("const owner = canonicalOwner");
  assert.ok(clockIndex >= 0 && clockIndex < canonicalIndex);
  assert.match(testSource, /const deadlineAt = startedAt \+ 20_000/);
  assert.doesNotMatch(testSource, /validateProviderUnlocked|getProviderState/);
  assert.match(testSource, /testProviderKey\(config, provider, \{ deadlineAt \}\)/);
  assert.equal(opencode.PROVIDER_TEST_TIMEOUT_MS, 20000);
  assert.equal(opencode.CREDENTIAL_TEST_CLEANUP_RESERVE_MS, 500);
});

await test("T72", "/config/providers hang is bounded by remaining explicit-Test deadline", async () => {
  await activate("B");
  const start = fake.calls.length;
  const startedAt = Date.now();
  fake.fetchOverride = (call, options) => call.pathname === "/config/providers"
    ? abortableDelay(0, null, options.signal, { hang: true })
    : undefined;
  try {
    await withCallTimeoutCapture(() => assert.rejects(
      opencode.testProviderKey(CONFIG, "provider-x", { deadlineAt: startedAt + 80 }),
      (error) => error.code === "TIMEOUT"
    ));
  } finally {
    fake.fetchOverride = null;
  }
  const elapsed = Date.now() - startedAt;
  const calls = fake.calls.slice(start);
  const catalog = calls.find((call) => call.pathname === "/config/providers");
  assert.ok(elapsed < 500);
  assert.ok(catalog.timeoutMs > 0 && catalog.timeoutMs <= 80);
  assert.equal(calls.some((call) => call.pathname === "/session"), false);
  assert.equal(calls.some(
    (call) => call.method === "DELETE" && /^\/session\/[^/]+$/.test(call.pathname)
  ), false);
});

await test("T73", "Session create and message probe receive only remaining deadline budget", async () => {
  await activate("B");
  const start = fake.calls.length;
  let delayedSessionId = null;
  fake.fetchOverride = (call, options) => {
    if (call.pathname === "/config/providers") {
      return abortableDelay(
        30,
        json({ providers: providersForContext(contextFor(call.directory)) }),
        options.signal
      );
    }
    if (call.pathname === "/session" && call.method === "POST") {
      delayedSessionId = `session-${fake.nextSession++}`;
      fake.sessions.set(delayedSessionId, { directory: call.directory });
      return abortableDelay(40, json({ id: delayedSessionId }), options.signal);
    }
    return undefined;
  };
  try {
    const result = await withCallTimeoutCapture(() => opencode.testProviderKey(
      CONFIG,
      "provider-x",
      { deadlineAt: Date.now() + 800 }
    ));
    assert.equal(result.daThu, 1);
  } finally {
    fake.fetchOverride = null;
    if (delayedSessionId) fake.sessions.delete(delayedSessionId);
  }
  const calls = fake.calls.slice(start);
  const catalog = calls.find((call) => call.pathname === "/config/providers");
  const create = calls.find((call) => call.pathname === "/session" && call.method === "POST");
  const probe = calls.find((call) => /\/session\/[^/]+\/message$/.test(call.pathname));
  assert.ok(catalog.timeoutMs <= 800);
  assert.ok(create.timeoutMs <= 300);
  assert.ok(create.timeoutMs > 0 && create.timeoutMs < catalog.timeoutMs);
  assert.ok(probe.timeoutMs > 0 && probe.timeoutMs < create.timeoutMs);
});

await test("T74", "Hanging probe returns TIMEOUT, tries one model and awaits cleanup", async () => {
  await activate("B");
  const start = fake.calls.length;
  const startedAt = Date.now();
  const deadlineAt = startedAt + 650;
  fake.fetchOverride = (call, options) => /\/session\/[^/]+\/message$/.test(call.pathname)
    ? abortableDelay(0, null, options.signal, { hang: true })
    : undefined;
  try {
    await withCallTimeoutCapture(() => assert.rejects(
      opencode.testProviderKey(CONFIG, "provider-x", { deadlineAt }),
      (error) => error.code === "TIMEOUT"
    ));
  } finally {
    fake.fetchOverride = null;
  }
  const calls = fake.calls.slice(start);
  const probes = calls.filter((call) => /\/session\/[^/]+\/message$/.test(call.pathname));
  const cleanup = calls.find((call) => call.method === "DELETE" && /^\/session\/[^/]+$/.test(call.pathname));
  assert.ok(Date.now() - startedAt < 650);
  assert.equal(probes.length, 1);
  assert.ok(probes[0].timeoutMs > 0 && probes[0].timeoutMs <= 150);
  assert.ok(cleanup);
  assert.equal(cleanup.activeReaders, 1);
  assert.ok(cleanup.timeoutMs > 0);
  assert.ok(cleanup.timeoutMs <= Math.max(0, deadlineAt - cleanup.recordedAt) + 5);
});

await test("T75", "Slow cleanup stays awaited inside credential READ and remains deadline-bounded", async () => {
  await activate("B");
  const start = fake.calls.length;
  const startedAt = Date.now();
  const deadlineAt = startedAt + 650;
  fake.fetchOverride = (call, options) => call.method === "DELETE" && /^\/session\/[^/]+$/.test(call.pathname)
    ? abortableDelay(0, null, options.signal, { hang: true })
    : undefined;
  let result;
  try {
    result = await withCallTimeoutCapture(() => opencode.testProviderKey(
      CONFIG,
      "provider-x",
      { deadlineAt }
    ));
  } finally {
    fake.fetchOverride = null;
  }
  const elapsed = Date.now() - startedAt;
  const cleanup = fake.calls.slice(start).find(
    (call) => call.method === "DELETE" && /^\/session\/[^/]+$/.test(call.pathname)
  );
  assert.equal(result.reply, "OK");
  assert.ok(elapsed >= cleanup.timeoutMs - 20);
  assert.ok(elapsed < 800);
  assert.ok(cleanup.timeoutMs > 0);
  assert.ok(cleanup.timeoutMs <= Math.max(0, deadlineAt - cleanup.recordedAt) + 5);
  assert.equal(cleanup.activeReaders, 1);
  assert.equal(opencode.credentialPlaneState().lock.activeReaders, 0);
});

await test("T76", "Explicit Test error-code delta is characterized without taxonomy remapping", async () => {
  await activate("A");
  await assert.rejects(
    ownerCredentials.testCurrentOwnerCredential("A", "provider-y", { config: CONFIG }),
    (error) => error.code === "CREDENTIAL_NOT_SAVED"
  );
  await assert.rejects(
    ownerCredentials.testCurrentOwnerCredential("A", "provider-unknown", { config: CONFIG }),
    (error) => error.code === "CREDENTIAL_NOT_SAVED"
  );

  await activate("B");
  fake.fetchOverride = (call) => call.pathname === "/config/providers"
    ? json({ providers: [] })
    : undefined;
  try {
    await assert.rejects(
      ownerCredentials.testCurrentOwnerCredential("B", "provider-x", { config: CONFIG }),
      (error) => error.code === "PROVIDER_UNAVAILABLE"
    );
  } finally {
    fake.fetchOverride = null;
  }
});

await test("T77", "Hanging /provider is absent from explicit Test path (F5-H)", async () => {
  await activate("B");
  const start = fake.calls.length;
  const startedAt = Date.now();
  fake.fetchOverride = (call, options) => call.pathname === "/provider"
    ? abortableDelay(0, null, options.signal, { hang: true })
    : undefined;
  try {
    const result = await withCallTimeoutCapture(() => ownerCredentials.testCurrentOwnerCredential(
      "B",
      "provider-x",
      { config: CONFIG }
    ));
    assert.equal(result.daThu, 1);
  } finally {
    fake.fetchOverride = null;
  }
  const calls = fake.calls.slice(start);
  assert.equal(calls.filter((call) => call.pathname === "/provider").length, 0);
  const catalog = calls.find((call) => call.pathname === "/config/providers");
  assert.ok(catalog.timeoutMs > 0 && catalog.timeoutMs <= 20000);
  assert.ok(Date.now() - startedAt < 500);
});

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.code} = ${result.skipped ? "SKIP" : result.pass ? "PASS" : "FAIL"}  ${result.description}`);
  if (result.error) console.log(`      -> ${result.error}`);
}
console.log(`T30_MANUAL_LOCAL_SIDECAR_PROBE = ${
  results.find((result) => result.code === "T30")?.skipped
    ? "NOT_RUN_BY_NO_REAL_PROVIDER_POLICY"
    : results.find((result) => result.code === "T30")?.pass
    ? "RECORDED_ARTIFACT_PRESENT"
    : "EVIDENCE_MISSING_OR_INVALID"
}`);
console.log(`AUTOMATED_DIRECTORY_TESTS_T33_T44 = ${
  results.filter((result) => /^T(?:3[3-9]|4[0-4])$/.test(result.code)).every((result) => result.pass)
    ? "12/12 PASS"
    : "FAIL"
}`);
console.log(`AUTOMATED_DIRECTORY_TESTS_T45_T58 = ${
  results.filter((result) => /^T(?:4[5-9]|5[0-8])$/.test(result.code)).every((result) => result.pass)
    ? "14/14 PASS"
    : "FAIL"
}`);
console.log(`T01_T58_AUTOMATED = ${
  results.filter((result) => /^T(?:0[1-9]|[1-4][0-9]|5[0-8])$/.test(result.code) && !result.skipped)
    .every((result) => result.pass)
    ? "57/57 PASS, T30 MANUAL SKIP"
    : "FAIL"
}`);
console.log(`AUTOMATED_DIRECTORY_TESTS_T59_T66 = ${
  results.filter((result) => /^T(?:59|6[0-6])$/.test(result.code))
    .every((result) => result.pass)
    ? "8/8 PASS"
    : "FAIL"
}`);
const automated = results.filter((result) => !result.skipped);
console.log(`\nOWNER_CREDENTIALS: ${automated.filter((result) => result.pass).length}/${automated.length} AUTOMATED PASS, ${results.length - automated.length} MANUAL SKIP`);
console.log("REAL_PROVIDER_CALLS = 0");
console.log("REAL_ZALO_MESSAGES = 0");

sql.close();
closeAllTestDatabases();
process.chdir(ORIGINAL_CWD);
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
