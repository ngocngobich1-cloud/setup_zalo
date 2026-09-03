/** Additive config persistence regression. Disposable DB only; no runtime/provider/Zalo call. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function worker(temp) {
  process.chdir(temp);
  const db = await import(`${pathToFileURL(path.join(repo, "lib", "db.js")).href}?capability-db=${Date.now()}`);
  await db.initDb();

  const defaults = await db.getAiChatConfig("owner-a");
  assert.deepEqual(defaults.opencodeFallbackCapabilities, []);
  assert.equal(defaults.opencodeFailoverEnabled, false);

  await db.saveAiChatConfig("owner-a", {
    opencodeModel: "primary/text",
    opencodeFallbackModel: "secondary/assist",
    opencodeFallbackCapabilities: ["WEB_SEARCH", "IMAGE_INPUT", "IMAGE_INPUT", "FILE_INPUT"],
    opencodeFailoverEnabled: true,
  });
  const reloaded = await db.getAiChatConfig("owner-a");
  assert.deepEqual(reloaded.opencodeFallbackCapabilities, ["IMAGE_INPUT", "FILE_INPUT", "WEB_SEARCH"]);
  assert.equal(reloaded.opencodeFailoverEnabled, true);

  await assert.rejects(() => db.saveAiChatConfig("owner-a", {
    opencodeFallbackCapabilities: ["AUDIO"],
  }), /không hợp lệ/);
  await assert.rejects(() => db.saveAiChatConfig("owner-a", {
    opencodeFailoverEnabled: "true",
  }), /boolean/);

  const sqlite3 = (await import("sqlite3")).default;
  const file = path.join(temp, "data", "zalo.db");
  const raw = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
  const columns = await new Promise((resolve, reject) => raw.all(
    "PRAGMA table_info(ai_chat_config)",
    (error, rows) => error ? reject(error) : resolve(rows)
  ));
  assert.ok(columns.some((column) => column.name === "opencode_fallback_capabilities"));
  assert.ok(columns.some((column) => column.name === "opencode_failover_enabled"));
  await new Promise((resolve, reject) => raw.close((error) => error ? reject(error) : resolve()));

  console.log("A01_A10_CONFIG_DB = PASS");
  console.log("CONFIG_RELOAD = PASS");
  console.log("PRODUCTION_DB_MUTATION = 0");
}
if (process.argv[2] === "--worker") {
  await worker(process.argv[3]);
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "capability-routing-db-"));
  const child = spawnSync(process.execPath, [...process.execArgv, THIS_FILE, "--worker", temp], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env },
    timeout: 20_000,
  });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  fs.rmSync(temp, { recursive: true, force: true });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status || 1;
}
