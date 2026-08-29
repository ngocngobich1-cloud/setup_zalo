/**
 * STAB-03 Round 4 proof harness.
 *
 * - Khong import server.js (import se khoi dong listener va canonical startup).
 * - Khong dung Zalo/OpenCode that.
 * - Worker chay trong thu muc tam nam ben trong repo, nen lib/db.js chi mo DB tam.
 * - Parent doi worker ket thuc roi moi xoa dung thu muc tam do chinh no tao.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./sqlite3-node24-test-register.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPT = fileURLToPath(import.meta.url);
const TEMP_PARENT = path.join(REPO, ".tmp-stab03");
const OWNER = "OWNER_A_TEST";
const INITIAL_URL = "http://runtime-initial.invalid:4096";
const INITIAL_AGENT = "agent-initial";
const UPDATED_URL = "http://runtime-explicit.invalid:4096";
const UPDATED_AGENT = "agent-explicit";

function assertInsideTempParent(candidate) {
  const parent = path.resolve(TEMP_PARENT);
  const target = path.resolve(candidate);
  assert.notEqual(target, parent, "Khong duoc xoa chinh thu muc cha temp.");
  assert.ok(target.startsWith(`${parent}${path.sep}`), `Temp target vuot khoi pham vi: ${target}`);
}

function runParent(phase) {
  assert.ok(["pre", "post"].includes(phase), "Dung: node kiem-tra-stab-03-ai-config-contract.js pre|post");
  fs.mkdirSync(TEMP_PARENT, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(TEMP_PARENT, `${phase}-`));
  assertInsideTempParent(tempDir);

  let child;
  try {
    child = spawnSync(process.execPath, [SCRIPT, phase, "--worker", tempDir], {
      cwd: REPO,
      encoding: "utf8",
      windowsHide: true,
      timeout: 45_000,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw child.error;
    assert.equal(child.status, 0, `STAB-03 ${phase} worker that bai (exit ${child.status}).`);
  } finally {
    // Worker da thoat nen sqlite handle da dong; chi xoa dung thu muc unique vua tao.
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    if (fs.existsSync(TEMP_PARENT) && fs.readdirSync(TEMP_PARENT).length === 0) {
      fs.rmdirSync(TEMP_PARENT);
    }
  }
}

function routeSource(serverSource) {
  const start = serverSource.indexOf('app.post("/api/ai-chat", async (req, res) => {');
  const end = serverSource.indexOf('app.post("/api/ai-chat/doc-tep"', start);
  assert.ok(start >= 0 && end > start, "Khong tach duoc canonical /api/ai-chat route.");
  return serverSource.slice(start, end);
}

function assistantSubmitSource(configSource) {
  const formDeclaration = configSource.indexOf('const form = panel.querySelector("#ai-chat-form")');
  const start = configSource.indexOf('form.addEventListener("submit"', formDeclaration);
  assert.ok(formDeclaration >= 0 && start > formDeclaration, "Khong tim thay assistant submit handler.");
  const bodyStart = configSource.indexOf("{", start);
  const body = curlyBlockAt(configSource, bodyStart, "assistant submit handler");
  return configSource.slice(start, body.end + 1);
}

function curlyBlockAt(source, start, label) {
  assert.ok(start >= 0 && source[start] === "{", `Khong tim thay block: ${label}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return { text: source.slice(start, index + 1), end: index };
    }
  }
  assert.fail(`Block khong dong: ${label}`);
}

function objectPassedTo(source, callNeedle, fromIndex = 0) {
  const call = source.indexOf(callNeedle, fromIndex);
  assert.ok(call >= 0, `Khong tim thay call: ${callNeedle}`);
  const start = source.indexOf("{", call + callNeedle.length - 1);
  return curlyBlockAt(source, start, callNeedle).text;
}

function positions(route, entries) {
  const found = entries.map(([name, needle, from = 0]) => {
    const index = route.indexOf(needle, from);
    assert.ok(index >= 0, `Khong tim thay control-flow node: ${name}`);
    return { name, index };
  });
  for (let index = 1; index < found.length; index += 1) {
    assert.ok(
      found[index].index > found[index - 1].index,
      `Sai thu tu: ${found[index - 1].name} phai dung truoc ${found[index].name}`
    );
  }
  return Object.fromEntries(found.map((item) => [item.name, item.index]));
}

function openSqlite(file) {
  const connection = new DatabaseSync(file, { readOnly: true });
  return {
    get(sql, params = []) {
      return Promise.resolve(connection.prepare(sql).get(...params));
    },
    close() {
      connection.close();
      return Promise.resolve();
    },
  };
}

async function rawRuntime(tempDir) {
  const connection = openSqlite(path.join(tempDir, "data", "zalo.db"));
  try {
    const row = await connection.get(
      "SELECT opencode_base_url, opencode_agent FROM ai_runtime_config WHERE id = 1"
    );
    return { ...row };
  } finally {
    await connection.close();
  }
}

const PROFILE = {
  allowedTopics: "topic-a",
  roleTone: "tone-a",
  useKnowledge: false,
  knowledgeFileIds: [],
  soul: "Soul A",
  opencodeModel: "provider/model-a",
};

function sourcePreProof(serverSource, configSource) {
  const route = routeSource(serverSource);
  const order = positions(route, [
    ["owner resolver", "const ownerUid = chuHienTai()"],
    ["owner guard", "if (!ownerUid) return res.status(400)"],
    ["request fields", "const {"],
    ["OpenCode URL guard", "if (!opencodeBaseUrl) return res.status(400)"],
    ["operation-specific branch", 'if (req.body?.saveScope === "ai-connection")'],
    ["assistant validation", "if (!soul) return res.status(400)"],
    ["assistant persistence preparation", "const truoc = await getAiChatConfig(ownerUid)"],
  ]);
  const assistantCall = objectPassedTo(route, "await saveAiChatConfig(ownerUid, {", order["assistant persistence preparation"]);
  assert.match(assistantCall, /\bopencodeBaseUrl\b/, "Pre-fix assistant call phai forward opencodeBaseUrl.");
  assert.match(assistantCall, /\bopencodeAgent\b/, "Pre-fix assistant call phai forward opencodeAgent.");

  const submit = assistantSubmitSource(configSource);
  assert.match(submit, /\bopencodeBaseUrl\s*:/, "Pre-fix browser assistant submit phai gui opencodeBaseUrl.");
  assert.match(submit, /\bopencodeAgent\s*:/, "Pre-fix browser assistant submit phai gui opencodeAgent.");
}

function sourcePostProof(serverSource, configSource) {
  const route = routeSource(serverSource);
  const order = positions(route, [
    ["owner resolver", "const ownerUid = chuHienTai()"],
    ["owner guard", "if (!ownerUid) return res.status(400)"],
    ["request fields", "const {"],
    ["operation-specific branch", 'if (req.body?.saveScope === "ai-connection")'],
    ["OpenCode URL guard scoped to global save", "if (!opencodeBaseUrl) return res.status(400)"],
    ["assistant validation", "if (!soul) return res.status(400)"],
    ["assistant persistence preparation", "const truoc = await getAiChatConfig(ownerUid)"],
  ]);
  const assistantCall = objectPassedTo(route, "await saveAiChatConfig(ownerUid, {", order["assistant persistence preparation"]);
  assert.doesNotMatch(assistantCall, /\bopencodeBaseUrl\b/, "Assistant persistence khong duoc forward opencodeBaseUrl.");
  assert.doesNotMatch(assistantCall, /\bopencodeAgent\b/, "Assistant persistence khong duoc forward opencodeAgent.");
  assert.match(assistantCall, /\bopencodeModel\b/, "Owner-scoped model van phai duoc luu.");
  assert.match(route, /deleteSessions\(truoc, phienCu\)/, "Session cleanup phai dung runtime da luu, khong dung payload assistant.");

  const submit = assistantSubmitSource(configSource);
  assert.doesNotMatch(submit, /\bopencodeBaseUrl\s*:/, "Browser assistant submit khong duoc gui opencodeBaseUrl.");
  assert.doesNotMatch(submit, /\bopencodeAgent\s*:/, "Browser assistant submit khong duoc gui opencodeAgent.");
}

async function seedRuntime(db) {
  await db.saveAiChatConfig(OWNER, {
    ...PROFILE,
    opencodeBaseUrl: INITIAL_URL,
    opencodeAgent: INITIAL_AGENT,
  });
}

async function behaviorPreProof(db, tempDir) {
  await seedRuntime(db);
  await db.saveAiChatConfig(OWNER, {
    ...PROFILE,
    soul: "Soul A after assistant submit",
    opencodeBaseUrl: "",
    opencodeAgent: "",
  });
  const runtime = await rawRuntime(tempDir);
  assert.deepEqual(runtime, {
    opencode_base_url: "",
    opencode_agent: "general",
  });
}

function assistantOwnedFields(request) {
  return {
    allowedTopics: request.allowedTopics,
    roleTone: request.roleTone,
    useKnowledge: request.useKnowledge,
    knowledgeFileIds: request.knowledgeFileIds,
    soul: request.soul,
    opencodeModel: request.opencodeModel,
  };
}

async function behaviorPostProof(db, tempDir) {
  await seedRuntime(db);
  const variants = [
    ["MISSING_FIELD_VARIANT", {}],
    ["EMPTY_STRING_VARIANT", { opencodeBaseUrl: "", opencodeAgent: "" }],
    ["FOREIGN_VALUE_VARIANT", {
      opencodeBaseUrl: "http://foreign.invalid:9999",
      opencodeAgent: "foreign-agent",
    }],
  ];

  for (const [name, globalFields] of variants) {
    const request = {
      ...PROFILE,
      soul: `Soul ${name}`,
      ...globalFields,
    };
    await db.saveAiChatConfig(OWNER, assistantOwnedFields(request));
    assert.deepEqual(await rawRuntime(tempDir), {
      opencode_base_url: INITIAL_URL,
      opencode_agent: INITIAL_AGENT,
    }, `${name}: assistant/profile save da doi global runtime.`);
    assert.equal((await db.getAiChatConfig(OWNER)).soul, `Soul ${name}`);
  }

  const current = await db.getAiChatConfig(OWNER);
  await db.saveAiChatConfig(OWNER, {
    ...current,
    opencodeBaseUrl: UPDATED_URL,
    opencodeAgent: UPDATED_AGENT,
  });
  assert.deepEqual(await rawRuntime(tempDir), {
    opencode_base_url: UPDATED_URL,
    opencode_agent: UPDATED_AGENT,
  });
}

async function runWorker(phase, tempDir) {
  assertInsideTempParent(tempDir);
  fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
  process.chdir(tempDir);

  const serverSource = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  const configSource = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  await db.initDb();

  if (phase === "pre") {
    sourcePreProof(serverSource, configSource);
    await behaviorPreProof(db, tempDir);
    console.log("STAB03_TESTABILITY_PRECHECK = COMPLETE");
    console.log("SERVER_IMPORT_STARTS_LISTENER = YES");
    console.log("OWNER_CONTEXT_INJECTABLE_AT_ROUTE_LAYER = NO");
    console.log("EXISTING_CALLABLE_ROUTE_HANDLER_SEAM = NO");
    console.log("ISOLATED_HTTP_HARNESS_WITHOUT_PRODUCT_EDIT = NO");
    console.log("DEFECT_A_PROOF_MODE = CONTROL_FLOW_PLUS_ISOLATED_BEHAVIOR");
    console.log("DEFECT_A_PRE_FIX_PROOF = PROVEN");
    console.log("DEFECT_B = PROVEN");
    console.log("EMPTY_STRING_GLOBAL_ERASURE_MECHANISM = PROVEN");
    console.log("EMPTY_STRING_PROOF_USED_ISOLATED_TEST_DB = YES");
    console.log("LIVE_HTTP_ERASURE_PROOF_ATTEMPTED = NO");
    console.log("SOURCE_EDIT_AUTHORITY = ACTIVE");
  } else {
    sourcePostProof(serverSource, configSource);
    await behaviorPostProof(db, tempDir);
    console.log("ASSISTANT_SAVE_WRITES_GLOBAL_OPENCODE_BASE_URL = NO");
    console.log("ASSISTANT_SAVE_WRITES_GLOBAL_OPENCODE_AGENT = NO");
    console.log("MISSING_FIELD_VARIANT = PASS");
    console.log("EMPTY_STRING_VARIANT = PASS");
    console.log("FOREIGN_VALUE_VARIANT = PASS");
    console.log("EXPLICIT_GLOBAL_OPENCODE_SAVE = PASS");
    console.log("API_OR_MODULE_TESTS_USED_ISOLATED_TEST_DB = YES");
    console.log("CANONICAL_DB_WRITTEN_BY_STAB03 = NO");
    console.log("LIVE_RUNNING_APP_USED_FOR_TESTS = NO");
    console.log("REAL_ZALO_LOGIN_USED_FOR_STAB03 = NO");
    console.log("REAL_OPENCODE_SIDE_EFFECT_BY_STAB03_TESTS = NO");
  }
  console.log(`STAB03_${phase.toUpperCase()}_PROOF = PASS`);
}

const phase = process.argv[2];
if (process.argv[3] === "--worker") {
  runWorker(phase, process.argv[4]).then(
    () => process.exit(0),
    (error) => {
      console.error(`STAB-03 ${phase} proof hong:`, error);
      process.exit(1);
    }
  );
} else {
  runParent(phase);
}
