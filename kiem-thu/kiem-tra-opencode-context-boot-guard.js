/**
 * Server boot guard regression.
 *
 * Moi child dung CWD tam va fetch fixture. Khong doc credential, khong goi
 * OpenCode/provider that, khong khoi tao dang nhap Zalo da luu cua nguoi dung.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SERVER = path.join(REPO, "server.js");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-context-boot-guard-"));
const PRELOAD = path.join(TEST_ROOT, "fetch-fixture.mjs");
const APP_SECRET_KEY = "44".repeat(32);
const ERROR_CODE = "OPENCODE_CONTEXT_ROOT_REQUIRED";
const results = [];

fs.writeFileSync(PRELOAD, `
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    let value = {};
    if (url.pathname === "/provider" && method === "GET") {
      value = { all: [], connected: [] };
    } else if (url.pathname === "/config/providers" && method === "GET") {
      value = { providers: [] };
    } else if (url.pathname.startsWith("/auth/")) {
      value = true;
    }
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
`);

function childEnvironment(contextRoot) {
  const env = {
    ...process.env,
    APP_DOMAIN: "localhost",
    APP_SECRET_KEY,
    ADMIN_USERNAME: "boot-guard-fixture",
    ADMIN_PASSWORD: "boot-guard-fixture-password",
    COOKIE_SECURE: "false",
    PORT: "0",
    TLS_MODE: "internal",
  };
  if (contextRoot === undefined) delete env.OPENCODE_CONTEXT_ROOT;
  else env.OPENCODE_CONTEXT_ROOT = contextRoot;
  return env;
}

async function test(code, description, run) {
  try {
    await run();
    results.push({ code, description, pass: true });
  } catch (error) {
    results.push({ code, description, pass: false, error: error.stack || error.message });
  }
}

function refusedStartup(contextRoot, caseName) {
  const cwd = fs.mkdtempSync(path.join(TEST_ROOT, `${caseName}-`));
  const result = spawnSync(
    process.execPath,
    ["--import", PRELOAD, SERVER],
    {
      cwd,
      env: childEnvironment(contextRoot),
      encoding: "utf8",
      timeout: 8000,
    }
  );
  return { ...result, cwd, output: `${result.stdout || ""}\n${result.stderr || ""}` };
}

function startedWithValidRoot(contextRoot) {
  const cwd = fs.mkdtempSync(path.join(TEST_ROOT, "valid-"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", PRELOAD, SERVER],
      { cwd, env: childEnvironment(contextRoot), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    let sawStartup = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!sawStartup && stdout.includes("Zalo Web Chat dang chay")) {
        sawStartup = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!sawStartup) {
        reject(new Error(
          `valid context root did not reach listen (exit=${code}, signal=${signal}, guard=${stderr.includes(ERROR_CODE)})`
        ));
        return;
      }
      resolve({ cwd, stdout, stderr });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      reject(new Error("valid context root startup timed out"));
    }, 15000);
  });
}

await test("T67", "Unset OPENCODE_CONTEXT_ROOT refuses server startup", async () => {
  const result = refusedStartup(undefined, "unset");
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(ERROR_CODE));
  assert.ok(!result.output.includes(APP_SECRET_KEY));
  assert.equal(fs.existsSync(path.join(result.cwd, "data", "zalo.db")), false);
});

await test("T68", "Blank OPENCODE_CONTEXT_ROOT refuses server startup", async () => {
  const result = refusedStartup("   ", "blank");
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(ERROR_CODE));
  assert.ok(!result.output.includes(APP_SECRET_KEY));
  assert.equal(fs.existsSync(path.join(result.cwd, "data", "zalo.db")), false);
});

await test("T69", "Valid OPENCODE_CONTEXT_ROOT continues normal startup", async () => {
  const contextRoot = path.join(TEST_ROOT, "valid-context-root");
  const result = await startedWithValidRoot(contextRoot);
  assert.ok(result.stdout.includes("Zalo Web Chat dang chay"));
  assert.ok(!result.stderr.includes(ERROR_CODE));
  assert.equal(fs.existsSync(contextRoot), true);
});

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.code} = ${result.pass ? "PASS" : "FAIL"}  ${result.description}`);
  if (result.error) console.log(`      -> ${result.error}`);
}
console.log(`\nBOOT_GUARD_TESTS: ${results.length - failed.length}/${results.length} PASS`);
console.log("REAL_PROVIDER_CALLS = 0");
console.log("REAL_ZALO_MESSAGES = 0");

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
