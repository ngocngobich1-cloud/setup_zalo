import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REGISTER = path.join(REPO, "kiem-thu", "sqlite3-node24-test-register.js");
const REGISTER_URL = pathToFileURL(REGISTER).href;
const CANONICAL_DB = path.resolve(REPO, "data", "zalo.db");

async function worker(tempDirectory) {
  process.chdir(tempDirectory);
  const { resolveDatabasePaths } = await import(`${pathToFileURL(path.join(REPO, "lib", "database-path.js")).href}?slice2=${Date.now()}`);
  const testDbPath = path.resolve(resolveDatabasePaths(process.cwd()).dbPath);
  assert.notEqual(testDbPath, CANONICAL_DB);
  assert.ok(testDbPath.startsWith(`${path.resolve(tempDirectory)}${path.sep}`));

  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  await db.initDb();
  const store = await import(pathToFileURL(path.join(REPO, "lib", "website-data.js")).href);
  const sync = await import(pathToFileURL(path.join(REPO, "lib", "website-sync.js")).href);
  const query = await import(pathToFileURL(path.join(REPO, "lib", "website-query.js")).href);
  const identity = await import(pathToFileURL(path.join(REPO, "lib", "website-identity.js")).href);
  const website = await import(pathToFileURL(path.join(REPO, "lib", "website.js")).href);
  const test = async (id, name, operation) => {
    await operation();
    console.log(`${id} = PASS — ${name}`);
  };
  const key = (email, phone) => identity.deriveWebsiteCustomerKey({ email, phone }).customerKey;

  await test("SY2", "explicit order foundation does not erase snapshot customer fields", async () => {
    const customerId = key("sy2@example.com", "0901111111");
    await sync.reconcileWebsiteSnapshot({ customers: [{
      ten: "Snapshot Name", email: "sy2@example.com", phone: "0901111111",
      giai_doan: "Đã mua", tong_da_chi: "1.500.000", san_pham_da_mua: ["Khoá A"],
      email_status: { status: "not_tracked" }, da_mua: true, result_id: "ignored",
    }] }, 1_800_000_000_000, [{
      websiteCustomerId: customerId,
      order: { order_id: "sy2-order", purchase_date: "2026-09-09T08:00:00+07:00", amount: 500000 },
    }]);
    const saved = await store.getWebsiteCustomer(customerId);
    assert.equal(saved.name, "Snapshot Name");
    assert.equal(saved.stage, "Đã mua");
    assert.equal((await store.listCustomerOrders(customerId)).length, 1);
  });

  await test("SY3", "total_spent normalization follows the deterministic integer policy", async () => {
    const fixtures = [
      ["1.500.000", 1500000, false], ["1.500", 1500, false], ["1,500,000", 1500000, false],
      ["1500000", 1500000, false], [1500000.0, 1500000, false], [1500000.5, null, true],
      ["", null, false], [null, null, false], [undefined, null, false], ["1.5tr", null, true],
      ["chưa rõ", null, true], [-100, null, true],
    ];
    for (const [input, value, invalid] of fixtures) {
      assert.deepEqual(sync.normalizeTotalSpent(input), { value, invalid });
    }
  });

  await test("SY4", "bad purchase_date is detail-only and customer remains saved", async () => {
    const customerId = key("sy4@example.com");
    const report = await sync.reconcileWebsiteSnapshot(
      { customers: [{ ten: "SY4", email: "sy4@example.com" }] },
      1_800_000_000_100,
      [{ websiteCustomerId: customerId, order: { order_id: "sy4-order", purchase_date: "2026-09-09T08:00:00" } }]
    );
    assert.equal(report.saved, 1);
    assert.equal(report.skipped_count, 0);
    assert.equal(report.detail.reasons.ORDER_BAD_DATE, 1);
  });

  await test("SY5", "missing order_id is detail-only and customer remains saved", async () => {
    const customerId = key("sy5@example.com");
    const report = await sync.reconcileWebsiteSnapshot(
      { customers: [{ ten: "SY5", email: "sy5@example.com" }] },
      1_800_000_000_200,
      [{ websiteCustomerId: customerId, order: { purchase_date: "2026-09-09T08:00:00Z" } }]
    );
    assert.equal(report.saved, 1);
    assert.equal(report.detail.reasons.ORDER_NO_ID, 1);
  });

  await test("SY6", "not_tracked creates no email message and reads as no tracking data", async () => {
    const customerId = key("sy6@example.com");
    await sync.reconcileWebsiteSnapshot({ customers: [{
      ten: "SY6", email: "sy6@example.com", email_status: { status: "not_tracked" },
    }] }, 1_800_000_000_300);
    assert.equal((await db.websiteDataGet(
      "SELECT COUNT(*) AS n FROM website_email_messages WHERE website_customer_id = ?", [customerId]
    )).n, 0);
    const detail = await query.getWebsiteCustomerDetail(customerId);
    assert.deepEqual(detail.emailTracking, { hasData: false, status: "not_tracked", message: null });
  });

  await test("SY7", "repeating the same snapshot creates no duplicate persistent rows", async () => {
    const payload = { customers: [{ ten: "SY7", email: "sy7@example.com", san_pham_da_mua: ["Khoá 7"] }] };
    await sync.reconcileWebsiteSnapshot(payload, 1_800_000_000_400);
    await sync.reconcileWebsiteSnapshot(payload, 1_800_000_000_400);
    const customerId = key("sy7@example.com");
    assert.equal((await db.websiteDataGet("SELECT COUNT(*) AS n FROM website_customers WHERE website_customer_id = ?", [customerId])).n, 1);
    assert.equal((await store.listCustomerProducts(customerId)).length, 1);
  });

  await test("SY8", "received, saved, skipped and reason histogram stay consistent", async () => {
    const report = await sync.reconcileWebsiteSnapshot({ customers: [
      null,
      { ten: "No identity" },
      { ten: "First", email: "duplicate@example.com" },
      { ten: "Last", email: " DUPLICATE@example.com " },
    ] }, 1_800_000_000_500);
    assert.equal(report.received_count, 4);
    assert.equal(report.saved, 1);
    assert.equal(report.skipped_count, 3);
    assert.equal(report.received_count, report.saved + report.skipped_count);
    assert.deepEqual(report.detail.reasons, { INVALID_ROW: 1, NO_IDENTITY: 1, DUPLICATE_IN_BATCH: 1 });
  });

  await test("SY9", "email change creates a new identity without corrupting or unsafe merging", async () => {
    await sync.reconcileWebsiteSnapshot({ customers: [{ ten: "Old", email: "old-change@example.com", phone: "0902222222" }] }, 1_800_000_000_600);
    await sync.reconcileWebsiteSnapshot({ customers: [{ ten: "New", email: "new-change@example.com", phone: "0902222222" }] }, 1_800_000_000_700);
    assert.equal((await store.getWebsiteCustomer(key("old-change@example.com"))).name, "Old");
    assert.equal((await store.getWebsiteCustomer(key("new-change@example.com"))).name, "New");
  });

  await test("SY10", "phone identity safely promotes to email identity", async () => {
    const oldId = key(null, "0903333333");
    const newId = key("promote10@example.com", "0903333333");
    await sync.reconcileWebsiteSnapshot({ customers: [{ ten: "Phone", phone: "0903333333" }] }, 1_800_000_000_800);
    const report = await sync.reconcileWebsiteSnapshot({ customers: [{ ten: "Email", email: "promote10@example.com", phone: "0903333333" }] }, 1_800_000_000_900);
    assert.equal(report.detail.promoted_from_phone_key, 1);
    assert.equal(await store.getWebsiteCustomer(oldId), undefined);
    assert.equal((await store.getWebsiteCustomer(newId)).name, "Email");
  });

  await test("SY11_BATCH_DUPLICATE_LAST_WINS", "last same-key source row wins", async () => {
    const report = await sync.reconcileWebsiteSnapshot({ customers: [
      { ten: "First", email: "last-wins@example.com" },
      { ten: "Second", email: " LAST-WINS@example.com " },
    ] }, 1_800_000_001_000);
    assert.equal((await store.getWebsiteCustomer(key("last-wins@example.com"))).name, "Second");
    assert.equal(report.received_count, 2);
    assert.equal(report.saved, 1);
    assert.equal(report.skipped_count, 1);
    assert.equal(report.detail.reasons.DUPLICATE_IN_BATCH, 1);
  });

  await test("SY12_BATCH_ORDER_ENABLES_PROMOTION", "phone rows persist before email rows regardless of payload order", async () => {
    const oldId = key(null, "0904444444");
    const newId = key("order12@example.com", "0904444444");
    const report = await sync.reconcileWebsiteSnapshot({ customers: [
      { ten: "Email wins", email: "order12@example.com", phone: "0904444444" },
      { ten: "Phone first after sorting", phone: "0904444444" },
    ] }, 1_800_000_001_100);
    assert.equal(report.detail.promoted_from_phone_key, 1);
    assert.equal(await store.getWebsiteCustomer(oldId), undefined);
    assert.equal((await store.getWebsiteCustomer(newId)).name, "Email wins");
  });

  await test("SY13_FIELD_LEVEL_REASON_NOT_SKIPPED", "detail-only reasons do not increment skipped", async () => {
    const customerId = key("sy13@example.com");
    const report = await sync.reconcileWebsiteSnapshot(
      { customers: [{ ten: "SY13", email: "sy13@example.com", tong_da_chi: "chưa rõ" }] },
      1_800_000_001_200,
      [{ websiteCustomerId: customerId, order: { purchase_date: "2026-09-09T08:00:00Z" } }]
    );
    assert.equal(report.received_count, 1);
    assert.equal(report.saved, 1);
    assert.equal(report.skipped_count, 0);
    assert.equal(report.detail.reasons.INVALID_TOTAL_SPENT, 1);
    assert.equal(report.detail.reasons.ORDER_NO_ID, 1);
  });

  const secrets = new Map([
    ["website_connection_name", "Fixture"], ["website_api_url", "https://example.com/customers"],
    ["website_api_token", "test-token"], ["website_connection_verified", "1"],
  ]);
  website.capHinhKhoBiMat({ get: (name) => secrets.get(name), set: (name, value) => secrets.set(name, value) });
  website.capHinhTraDiaChi(async () => [{ address: "8.8.8.8", family: 4 }]);

  await test("A5", "concurrent manual sync rejects the second run", async () => {
    let release;
    website.capHinhGoiMang(() => new Promise((resolve) => { release = resolve; }));
    const first = sync.syncWebsiteData();
    await assert.rejects(() => sync.syncWebsiteData(), (error) => error.code === "SYNC_ALREADY_RUNNING");
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    release({ ok: true, status: 200, text: async () => JSON.stringify({ customers: [] }) });
    await first;
  });

  await test("A6", "Website failure marks the run failed and preserves prior local data", async () => {
    const before = (await db.websiteDataGet("SELECT COUNT(*) AS n FROM website_customers")).n;
    website.capHinhGoiMang(async () => { throw new Error("network fixture"); });
    await assert.rejects(() => sync.syncWebsiteData());
    assert.equal((await db.websiteDataGet("SELECT COUNT(*) AS n FROM website_customers")).n, before);
    assert.equal((await db.websiteDataGet("SELECT status FROM website_sync_runs ORDER BY id DESC LIMIT 1")).status, "failed");
  });

  await test("A7_SYNC_CRASH_RECOVERY", "failed sync releases the mutex and the next sync succeeds", async () => {
    website.capHinhGoiMang(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ customers: [] }) }));
    const result = await sync.syncWebsiteData();
    assert.equal(result.run.status, "completed");
    assert.equal(sync.isWebsiteSyncRunning(), false);
  });

  await test("A8_ORPHAN_RUNNING_REPORTED", "orphan running audit row is read as interrupted without mutation", async () => {
    const orphan = await store.beginSyncRun({ source_kind: "website_snapshot" });
    const status = await query.getWebsiteSyncStatus({ mutexHeld: false });
    assert.equal(status.status, "INTERRUPTED");
    const unchanged = await db.websiteDataGet("SELECT status, finished_at FROM website_sync_runs WHERE id = ?", [orphan.id]);
    assert.equal(unchanged.status, "running");
    assert.equal(unchanged.finished_at, null);
  });

  website.capHinhGoiMang(null);
  website.capHinhTraDiaChi(null);
  website.capHinhKhoBiMat(null);
  console.log("TEST_DB_ISOLATED = YES");
  console.log(`TEST_DB_PATH = ${testDbPath}`);
  console.log("CANONICAL_DB_OPENED_BY_TEST = NO");
  console.log("SY2_SY13_A5_A8 = PASS");
}

if (process.argv[2] === "--worker") {
  await worker(path.resolve(process.argv[3]));
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "website-sync-slice2-"));
  const child = spawnSync(process.execPath, [...process.execArgv, "--import", REGISTER_URL, THIS_FILE, "--worker", temp], {
    cwd: process.cwd(), encoding: "utf8", timeout: 90_000, env: { ...process.env },
  });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  fs.rmSync(temp, { recursive: true, force: true });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status || 1;
}
