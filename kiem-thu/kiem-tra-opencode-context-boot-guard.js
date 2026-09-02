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
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SERVER = path.join(REPO, "server.js");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-context-boot-guard-"));
const PRELOAD = path.join(TEST_ROOT, "fetch-fixture.mjs");
const PRELOAD_URL = pathToFileURL(PRELOAD).href;
const APP_SECRET_KEY = "44".repeat(32);
const ERROR_CODE = "OPENCODE_CONTEXT_ROOT_REQUIRED";
const results = [];

fs.writeFileSync(PRELOAD, `
  let delayedProviderCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    let value = {};
    if (url.pathname === "/provider" && method === "GET") {
      if (process.env.BOOT_GUARD_DELAY_PROJECTION === "true" && delayedProviderCalls++ === 0) {
        console.log("BOOT_GUARD_PROJECTION_STARTED");
        return new Promise((_, reject) => {
          setTimeout(() => {
            console.log("BOOT_GUARD_PROJECTION_SETTLED");
            reject(new Error("fixture delayed projection rejection"));
          }, 1200);
        });
      }
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
    ["--import", PRELOAD_URL, SERVER],
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
      ["--import", PRELOAD_URL, SERVER],
      { cwd, env: childEnvironment(contextRoot), stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    let sawStartup = false;
    let settled = false;
    const stopWhenReady = () => {
      if (!settled && sawStartup && fs.existsSync(contextRoot)) child.kill("SIGTERM");
    };
    const readinessPoll = setInterval(stopWhenReady, 25);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!sawStartup && stdout.includes("Zalo Web Chat dang chay")) {
        sawStartup = true;
        stopWhenReady();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(readinessPoll);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(readinessPoll);
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
      clearInterval(readinessPoll);
      reject(new Error("valid context root startup timed out"));
    }, 15000);
  });
}

function startedBeforeSlowProjectionSettles(contextRoot) {
  const cwd = fs.mkdtempSync(path.join(TEST_ROOT, "slow-projection-"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", PRELOAD_URL, SERVER],
      {
        cwd,
        env: {
          ...childEnvironment(contextRoot),
          BOOT_GUARD_DELAY_PROJECTION: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    let port = null;
    let projectionStarted = false;
    let projectionSettled = false;
    let projectionPendingAtHttpReady = false;
    let httpReady = false;
    let httpStatus = null;
    let probeInFlight = false;
    let expectedStop = false;
    let completion = null;
    let finished = false;

    const output = () => `${stdout}\n${stderr}`;
    const stopWithError = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      reject(error);
    };
    const maybeComplete = () => {
      const rejectionHandled = stderr.includes(
        "[owner-credentials] Startup empty projection failed: CREDENTIAL_PROJECTION_FAILED"
      );
      if (!httpReady || !projectionSettled || !rejectionHandled || expectedStop) return;
      completion = {
        projectionStarted,
        projectionPendingAtHttpReady,
        httpReady,
        httpStatus,
        projectionSettled,
        rejectionHandled,
        aliveAfterProjectionRejection: child.exitCode === null,
      };
      expectedStop = true;
      child.kill("SIGTERM");
    };
    const probeHttpWhileProjectionPending = async () => {
      if (probeInFlight || httpReady || !projectionStarted || projectionSettled || !port) return;
      probeInFlight = true;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
        httpStatus = response.status;
        httpReady = response.status >= 200 && response.status < 400;
        projectionPendingAtHttpReady = !projectionSettled;
      } catch (error) {
        stopWithError(new Error(`HTTP probe failed while projection pending: ${error.message}\n${output()}`));
        return;
      } finally {
        probeInFlight = false;
      }
      maybeComplete();
    };
    const observeOutput = () => {
      projectionStarted = stdout.includes("BOOT_GUARD_PROJECTION_STARTED");
      projectionSettled = stdout.includes("BOOT_GUARD_PROJECTION_SETTLED");
      const portMatch = stdout.match(/Mo trinh duyet: http:\/\/127\.0\.0\.1:(\d+)/);
      if (portMatch) port = Number(portMatch[1]);
      void probeHttpWhileProjectionPending();
      maybeComplete();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      observeOutput();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      observeOutput();
    });
    child.once("error", stopWithError);
    child.once("exit", (code, signal) => {
      if (finished) return;
      clearTimeout(timer);
      if (!expectedStop || !completion) {
        finished = true;
        reject(new Error(`slow projection child exited early (exit=${code}, signal=${signal})\n${output()}`));
        return;
      }
      finished = true;
      resolve({ cwd, stdout, stderr, ...completion });
    });
    const timer = setTimeout(() => {
      stopWithError(new Error(`slow projection readiness test timed out\n${output()}`));
    }, 10000);
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

await test("T70", "HTTP listener is ready while startup credential projection is still pending", async () => {
  const contextRoot = path.join(TEST_ROOT, "slow-projection-context-root");
  const result = await startedBeforeSlowProjectionSettles(contextRoot);
  assert.equal(result.projectionStarted, true);
  assert.equal(result.projectionPendingAtHttpReady, true);
  assert.equal(result.httpReady, true);
  assert.ok(result.httpStatus >= 200 && result.httpStatus < 400);
  assert.equal(result.projectionSettled, true);
  assert.equal(result.rejectionHandled, true);
  assert.equal(result.aliveAfterProjectionRejection, true);
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
