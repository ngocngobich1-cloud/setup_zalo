/**
 * Canonical Stage 0 regression runner.
 *
 * Chỉ gom các suite đã được Stage 0 chứng minh là tự động và cô lập:
 * - không mở CSDL canonical trong data/
 * - không dùng Zalo/Zoom/provider thật
 * - không khởi động browser harness tồn tại lâu
 *
 * Chạy: node kiem-thu/chay-hoi-quy-stage-0.js
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const suites = [
  { id: "CONVERSATION_INFLIGHT", file: "kiem-thu/kiem-tra-conversation-inflight.js", timeoutMs: 15_000 },
  { id: "AI_ACTION_BOUNDARY", file: "kiem-thu/kiem-tra-ai-action-boundary.js", timeoutMs: 15_000 },
  { id: "AI_DEFAULT", file: "kiem-thu/kiem-tra-ai-default.js", timeoutMs: 30_000, requiresNativeSqlite: true },
  { id: "AI_MODEL_SOURCE", file: "kiem-thu/kiem-tra-ai-model-source.js", timeoutMs: 30_000, requiresNativeSqlite: true },
  { id: "ONBOARDING", file: "kiem-thu/kiem-tra-onboarding.js", timeoutMs: 45_000, requiresNativeSqlite: true },
  { id: "TEACH_BOT", file: "kiem-thu/kiem-tra-day-po.js", timeoutMs: 60_000, requiresNativeSqlite: true },
  { id: "CHAT_ATTACHMENT", file: "kiem-thu/kiem-tra-chat-attachment.js", timeoutMs: 20_000 },
  { id: "PDF_AUTOMATION", file: "kiem-thu/kiem-tra-pdf-automation.js", timeoutMs: 120_000, requiresNativeSqlite: true },
  { id: "P9_OWNER_PROFILE", file: "kiem-thu/kiem-tra-p9-owner-profile.js", timeoutMs: 45_000, requiresNativeSqlite: true },
  { id: "P9_FULL_PRESERVATION", file: "kiem-thu/kiem-tra-p9-production-legacy-owner.js", timeoutMs: 60_000, requiresNativeSqlite: true },
  { id: "P9_17_MODEL_SAVE", file: "kiem-thu/kiem-tra-p9-17-model-save.js", timeoutMs: 15_000 },
  { id: "PHONE_DIRECT_MESSAGE", file: "kiem-thu/kiem-tra-phone-direct-message.js", timeoutMs: 90_000 },
  { id: "ZOOM", file: "kiem-thu/kiem-tra-zoom.js", timeoutMs: 120_000, requiresNativeSqlite: true },
  { id: "STAB_04A_OWNER_CONTEXT", file: "kiem-thu/kiem-tra-stab-04-owner-context.js", timeoutMs: 90_000 },
];

let nativeSqliteBlocker = null;
try {
  await import("sqlite3");
} catch (error) {
  nativeSqliteBlocker = String(error?.message || error).split("\n", 1)[0];
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    if (suite.requiresNativeSqlite && nativeSqliteBlocker) {
      console.log(`\n===== ${suite.id} =====`);
      console.log(`COMMAND = ${process.execPath} ${suite.file}`);
      console.log(`PER_SUITE_TIMEOUT_MS = ${suite.timeoutMs}`);
      console.log("RESULT = ENVIRONMENT_BLOCKED");
      console.log("EXIT_CODE = NOT_RUN");
      console.log(`BLOCKER = sqlite3 native binding unavailable: ${nativeSqliteBlocker}`);
      resolve({
        ...suite,
        status: "ENVIRONMENT_BLOCKED",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        spawnError: nativeSqliteBlocker,
      });
      return;
    }

    let timedOut = false;
    let spawnError = null;

    console.log(`\n===== ${suite.id} =====`);
    console.log(`COMMAND = ${process.execPath} ${suite.file}`);
    console.log(`PER_SUITE_TIMEOUT_MS = ${suite.timeoutMs}`);

    const child = spawn(process.execPath, [path.join(REPO, suite.file)], {
      cwd: REPO,
      env: { ...process.env, STAGE0_SAFE_RUNNER: "1" },
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });

    const forceKill = setTimeout(() => {
      if (!timedOut) return;
      child.kill("SIGKILL");
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
      resolve({ ...suite, status, exitCode, signal, durationMs, spawnError: spawnError?.message || null });
    });
  });
}

const results = [];
for (const suite of suites) {
  results.push(await runSuite(suite));
}

console.log("\n===== STAGE 0 REGRESSION SUMMARY =====");
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

if (counts.FAIL > 0) process.exitCode = 1;
else if (counts.TIMEOUT > 0) process.exitCode = 124;
else if (counts.ENVIRONMENT_BLOCKED > 0) process.exitCode = 2;
