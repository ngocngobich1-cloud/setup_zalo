/**
 * Stage 0D infrastructure wrapper: run only the six suites that were blocked
 * by the missing host sqlite3 native binding. Assertions and suite entrypoints
 * remain untouched; timeouts match the canonical Stage 0 runner.
 *
 * Run inside the Stage 0D image:
 *   node kiem-thu/chay-stage0d-six.js
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const suites = [
  { id: "AI_DEFAULT", file: "kiem-thu/kiem-tra-ai-default.js", timeoutMs: 30_000 },
  { id: "AI_MODEL_SOURCE", file: "kiem-thu/kiem-tra-ai-model-source.js", timeoutMs: 30_000 },
  { id: "ONBOARDING", file: "kiem-thu/kiem-tra-onboarding.js", timeoutMs: 45_000 },
  { id: "TEACH_BOT", file: "kiem-thu/kiem-tra-day-po.js", timeoutMs: 60_000 },
  { id: "P9_OWNER_PROFILE", file: "kiem-thu/kiem-tra-p9-owner-profile.js", timeoutMs: 45_000 },
  { id: "ZOOM", file: "kiem-thu/kiem-tra-zoom.js", timeoutMs: 120_000 },
];

let sqliteBlocker = null;
try {
  await import("sqlite3");
} catch (error) {
  sqliteBlocker = String(error?.message || error).split("\n", 1)[0];
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    let spawnError = null;

    console.log(`\n===== ${suite.id} =====`);
    console.log(`COMMAND = ${process.execPath} ${suite.file}`);
    console.log(`PER_SUITE_TIMEOUT_MS = ${suite.timeoutMs}`);

    const child = spawn(process.execPath, [path.join(REPO, suite.file)], {
      cwd: REPO,
      env: {
        ...process.env,
        STAGE0_SAFE_RUNNER: "1",
        STAGE0D_BLOCKED_SIX_ONLY: "1",
      },
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });

    const forceKill = setTimeout(() => {
      if (timedOut) child.kill("SIGKILL");
    }, suite.timeoutMs + 2_000);
    forceKill.unref();

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, suite.timeoutMs);

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      const durationMs = Date.now() - startedAt;
      const status = timedOut
        ? "TIMEOUT"
        : spawnError
          ? "ENVIRONMENT_BLOCKED"
          : exitCode === 0
            ? "PASS"
            : "FAIL";

      console.log(`RESULT = ${status}`);
      console.log(`EXIT_CODE = ${exitCode ?? "NONE"}`);
      console.log(`SIGNAL = ${signal ?? "NONE"}`);
      console.log(`DURATION_MS = ${durationMs}`);
      if (spawnError) console.error(`SPAWN_ERROR = ${spawnError.message}`);
      resolve({ ...suite, status, exitCode, signal, durationMs });
    });
  });
}

console.log("===== STAGE 0D SQLITE PREFLIGHT =====");
console.log(`SQLITE3_BINDING_WORKING = ${sqliteBlocker ? "NO" : "YES"}`);
if (sqliteBlocker) {
  console.error(`BLOCKER = ${sqliteBlocker}`);
  process.exitCode = 2;
} else {
  const results = [];
  for (const suite of suites) results.push(await runSuite(suite));

  console.log("\n===== STAGE 0D PREVIOUSLY BLOCKED SIX SUMMARY =====");
  for (const result of results) {
    console.log(
      `${result.id} = ${result.status}; EXIT_CODE=${result.exitCode ?? "NONE"}; `
        + `DURATION_MS=${result.durationMs}; TIMEOUT_MS=${result.timeoutMs}`
    );
  }

  const counts = Object.fromEntries(
    ["PASS", "FAIL", "TIMEOUT", "ENVIRONMENT_BLOCKED"].map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ])
  );
  console.log(`PASS = ${counts.PASS}`);
  console.log(`FAIL = ${counts.FAIL}`);
  console.log(`TIMEOUT = ${counts.TIMEOUT}`);
  console.log(`ENVIRONMENT_BLOCKED = ${counts.ENVIRONMENT_BLOCKED}`);
  console.log(`PREVIOUSLY_BLOCKED_SUITES_EXECUTED = ${results.length}/6`);

  if (counts.FAIL > 0) process.exitCode = 1;
  else if (counts.TIMEOUT > 0) process.exitCode = 124;
  else if (counts.ENVIRONMENT_BLOCKED > 0) process.exitCode = 2;
}
