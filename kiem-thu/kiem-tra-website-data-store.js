/** Slice 1 Website Data persistence regression. Disposable DB only. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CANONICAL_DB = path.resolve(REPO, "data", "zalo.db");

// Same provider-free fallback pattern already used by the canonical
// kiem-tra-phone-direct-message.js regression when native sqlite3 is absent.
function createSqliteShim() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "website-data-sqlite-shim-"));
  const preload = path.join(directory, "preload.cjs");
  fs.writeFileSync(preload, String.raw`
const Module = require("node:module");
const { DatabaseSync } = require("node:sqlite");
const OPEN_READONLY = 1;

function invoke(statement, method, params) {
  if (Array.isArray(params)) return statement[method](...params);
  if (params && typeof params === "object") return statement[method](params);
  return statement[method]();
}

class Database {
  constructor(filename, flags, callback) {
    if (typeof flags === "function") { callback = flags; flags = 0; }
    try {
      this.inner = new DatabaseSync(filename, { readOnly: flags === OPEN_READONLY });
      callback?.(null);
    } catch (error) {
      callback?.(error);
      if (!callback) throw error;
    }
  }
  run(sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    try {
      const result = invoke(this.inner.prepare(sql), "run", params || []);
      callback?.call({
        lastID: Number(result.lastInsertRowid || 0),
        changes: Number(result.changes || 0),
      }, null);
    } catch (error) { if (callback) callback(error); else throw error; }
    return this;
  }
  all(sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    try { callback?.(null, invoke(this.inner.prepare(sql), "all", params || [])); }
    catch (error) { if (callback) callback(error); else throw error; }
    return this;
  }
  get(sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    try { callback?.(null, invoke(this.inner.prepare(sql), "get", params || [])); }
    catch (error) { if (callback) callback(error); else throw error; }
    return this;
  }
  serialize(callback) { callback(); return this; }
  close(callback) {
    try { this.inner.close(); callback?.(null); }
    catch (error) { if (callback) callback(error); else throw error; }
  }
}

const sqlite3 = { Database, OPEN_READONLY, verbose() { return sqlite3; } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "sqlite3" || /node_modules[\\/]sqlite3[\\/]lib[\\/]sqlite3\.js$/.test(String(request))) {
    return sqlite3;
  }
  return originalLoad.call(this, request, parent, isMain);
};
`, "utf8");
  return { directory, preload };
}

function openSqlite(sqlite3, filename) {
  const connection = new sqlite3.Database(filename);
  return {
    run(sql, params = []) {
      return new Promise((resolve, reject) => connection.run(sql, params, function onRun(error) {
        if (error) reject(error);
        else resolve(this);
      }));
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => connection.all(sql, params, (error, rows) => {
        if (error) reject(error);
        else resolve(rows);
      }));
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => connection.get(sql, params, (error, row) => {
        if (error) reject(error);
        else resolve(row);
      }));
    },
    close() {
      return new Promise((resolve, reject) => connection.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function worker(tempDirectory) {
  process.chdir(tempDirectory);

  // A20: resolve inside the worker, after cwd points at the disposable root.
  const { resolveDatabasePaths } = await import(
    `${pathToFileURL(path.join(REPO, "lib", "database-path.js")).href}?website-data-path=${Date.now()}`
  );
  const resolvedTestDbPath = path.resolve(resolveDatabasePaths(process.cwd()).dbPath);
  const resolvedTemp = path.resolve(tempDirectory);
  assert.notEqual(resolvedTestDbPath, CANONICAL_DB, "Slice 1 test must never target canonical data/zalo.db");
  assert.ok(
    resolvedTestDbPath.startsWith(`${resolvedTemp}${path.sep}`),
    "Slice 1 test DB must be inside its disposable temp directory"
  );
  fs.mkdirSync(path.dirname(resolvedTestDbPath), { recursive: true });

  const sqlite3 = (await import("sqlite3")).default;
  const raw = openSqlite(sqlite3, resolvedTestDbPath);
  const migration = await import(
    `${pathToFileURL(path.join(REPO, "lib", "migrations", "data-01-website-store.js")).href}?direct=${Date.now()}`
  );
  const results = [];
  const test = async (id, name, operation) => {
    await operation();
    results.push({ id, name });
    console.log(`${id} = PASS — ${name}`);
  };

  await raw.run("CREATE TABLE legacy_guard (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  await raw.run("CREATE INDEX idx_legacy_guard_value ON legacy_guard(value)");
  const oldSchemaQuery = `
    SELECT name, type, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\\'
    ORDER BY type, name
  `;
  const oldSchemaBefore = await raw.all(oldSchemaQuery);

  await test("T1", "migration runs the first time", async () => {
    await migration.migrateData01WebsiteStore(raw);
    const tables = await raw.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'website_%' OR name = 'zalo_customer_bindings')"
    );
    assert.equal(tables.length, 7);
  });

  await test("T3", "existing schema objects remain byte-for-byte unchanged", async () => {
    const after = await raw.all(oldSchemaQuery);
    const beforeNames = new Set(oldSchemaBefore.map((row) => row.name));
    const afterOld = after.filter((row) => beforeNames.has(row.name));
    assert.deepEqual(afterOld, oldSchemaBefore);
    assert.ok(after.length > oldSchemaBefore.length);
  });

  await test("T2", "migration runs a second time idempotently", async () => {
    await migration.migrateData01WebsiteStore(raw);
    assert.deepEqual(await raw.all(oldSchemaQuery).then((rows) => {
      const beforeNames = new Set(oldSchemaBefore.map((row) => row.name));
      return rows.filter((row) => beforeNames.has(row.name));
    }), oldSchemaBefore);
  });
  await raw.close();

  // Import only after cwd isolation is proven. initDb therefore opens temp/data/zalo.db.
  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  await db.initDb();
  const store = await import(
    `${pathToFileURL(path.join(REPO, "lib", "website-data.js")).href}?website-data=${Date.now()}`
  );

  const t0 = "2026-09-08T10:15:00Z";
  const t1 = "2026-09-08T17:16:00+07:00";
  const t1Equal = "2026-09-08T10:16:00.000Z";
  const t2 = "2026-09-08T10:17:00Z";
  const t3 = "2026-09-08T10:18:00Z";
  const t4 = "2026-09-08T10:19:00Z";

  await test("T4", "insert customer", async () => {
    const result = await store.upsertWebsiteCustomer({
      website_customer_id: "c-main",
      name: "Alpha",
      phone: "0901234567",
      email: " Alpha@Example.COM ",
      total_spent: 1500000,
      stage: "lead",
      source_updated_at: t0,
    });
    assert.equal(result.applied, true);
    assert.equal(result.customer.website_customer_id, "c-main");
    assert.equal(result.customer.email_normalized, "alpha@example.com");
  });

  await test("T5", "newer customer update applies across timezone formats", async () => {
    const result = await store.upsertWebsiteCustomer({
      website_customer_id: "c-main",
      name: "Beta",
      stage: "customer",
      source_updated_at: t1,
    });
    assert.equal(result.applied, true);
    assert.equal(result.customer.name, "Beta");
    assert.equal(result.customer.source_updated_at, Date.parse(t1Equal));
  });

  await test("T6", "older customer update is ignored by instant, not string order", async () => {
    const result = await store.upsertWebsiteCustomer({
      website_customer_id: "c-main",
      name: "Must not apply",
      source_updated_at: "2026-09-08T12:00:00+07:00",
    });
    assert.equal(result.applied, false);
    assert.equal(result.stale, true);
    assert.equal((await store.getWebsiteCustomer("c-main")).name, "Beta");
  });

  await test("T7", "equal source timestamp reapplies a normalized full snapshot idempotently", async () => {
    assert.equal(store.toEpochMilliseconds(Date.parse(t1Equal)), Date.parse(t1Equal));
    const result = await store.upsertWebsiteCustomer({
      website_customer_id: "c-main",
      name: "Equal",
      email: " EQUAL@EXAMPLE.COM ",
      source_updated_at: t1Equal,
    });
    assert.equal(result.applied, true);
    assert.equal(result.customer.email_normalized, "equal@example.com");
    assert.equal(result.customer.stage, null);
    assert.equal((await db.websiteDataGet(
      "SELECT COUNT(*) AS n FROM website_customers WHERE website_customer_id = ?",
      ["c-main"]
    )).n, 1);
  });

  await test("T8", "missing, undefined and null nullable fields clear under full snapshot semantics", async () => {
    await store.upsertWebsiteCustomer({
      website_customer_id: "c-main",
      name: "Before clear",
      phone: "0901234567",
      email: "before@example.com",
      stage: "customer",
      total_spent: 7,
      source_updated_at: t2,
    });
    const cleared = await store.upsertWebsiteCustomer({
      website_customer_id: "c-main",
      name: "After clear",
      phone: undefined,
      email: null,
      source_updated_at: t3,
    });
    assert.equal(cleared.customer.phone, null);
    assert.equal(cleared.customer.email, null);
    assert.equal(cleared.customer.stage, null);
    assert.equal(cleared.customer.total_spent, null);
  });

  await test("T9", "missing canonical customer id is rejected", async () => {
    await assert.rejects(
      () => store.upsertWebsiteCustomer({ name: "No identity", source_updated_at: t0 }),
      /website_customer_id is required/
    );
    await assert.rejects(
      () => store.upsertWebsiteCustomer({
        website_customer_id: "c-invalid-time",
        source_updated_at: "not-a-timestamp",
      }),
      /source_updated_at/
    );
  });

  await test("T10", "order upsert atomically creates a customer stub", async () => {
    await store.upsertWebsiteOrder({
      order_id: "o-1",
      website_customer_id: "c-stub",
      product_name: "Course A",
      amount: 500000,
      source_updated_at: t0,
    });
    const customer = await store.getWebsiteCustomer("c-stub");
    assert.equal(customer.is_stub, 1);
    assert.equal(customer.name, null);
    assert.equal(customer.email, null);
  });

  await test("T11", "real customer snapshot fills a stub and clears is_stub", async () => {
    const result = await store.upsertWebsiteCustomer({
      website_customer_id: "c-stub",
      name: "Stub Filled",
      source_updated_at: t1,
    });
    assert.equal(result.customer.name, "Stub Filled");
    assert.equal(result.customer.is_stub, 0);
  });

  await test("T12", "duplicate order_id stays one row and equal timestamp is safe", async () => {
    await store.upsertWebsiteOrder({
      order_id: "o-1",
      website_customer_id: "c-stub",
      product_name: "Course A retry",
      source_updated_at: t0,
    });
    const count = await db.websiteDataGet("SELECT COUNT(*) AS n FROM website_orders WHERE order_id = 'o-1'");
    assert.equal(count.n, 1);
  });

  await test("T13", "product snapshot is stored without inventing an order", async () => {
    const result = await store.upsertCustomerProduct({
      website_customer_id: "c-main",
      product_name: "Khóa A",
      source_kind: "snapshot",
      source_updated_at: t0,
    });
    assert.equal(result.product.product_key, "khoa a");
    assert.equal((await store.listCustomerOrders("c-main")).length, 0);
  });

  await test("T14", "product key normalization is idempotent and order outranks snapshot", async () => {
    await store.upsertCustomerProduct({
      website_customer_id: "c-main",
      product_name: "kho\u0301a a",
      source_kind: "order",
      source_updated_at: t1,
    });
    await store.upsertCustomerProduct({
      website_customer_id: "c-main",
      product_name: " KHOÁ  A ",
      source_kind: "snapshot",
      source_updated_at: t2,
    });
    const products = await store.listCustomerProducts("c-main");
    assert.equal(products.length, 1);
    assert.equal(products[0].product_key, "khoa a");
    assert.equal(products[0].product_name, " KHOÁ  A ");
    assert.equal(products[0].source_kind, "order");
    await assert.rejects(
      () => store.upsertCustomerProduct({
        website_customer_id: "c-main",
        product_name: "   ",
        source_kind: "snapshot",
        source_updated_at: t2,
      }),
      /non-empty product_key/
    );
  });

  await test("T15", "email normalization lowercases and trims only", async () => {
    assert.equal(store.normalizeEmail("  Person+Tag@Example.COM  "), "person+tag@example.com");
    assert.equal(store.normalizeEmail(null), null);
  });

  await test("T16", "phone normalization accepts explicit V1 forms and rejects ambiguity", async () => {
    const fixtures = [
      ["0901234567", "84901234567"],
      ["+84901234567", "84901234567"],
      ["84901234567", "84901234567"],
      ["090 123-4567", "84901234567"],
      ["12345", null],
      ["+12025550123", null],
    ];
    for (const [input, expected] of fixtures) assert.equal(store.normalizePhone(input), expected);
  });

  await test("T17", "deriveEmailStatus and persistence handle delivered-before-sent", async () => {
    assert.equal(store.deriveEmailStatus({ deliveredAt: Date.parse(t1) }), "delivered");
    assert.equal(store.deriveEmailStatus({ sentAt: Date.parse(t0) }), "sent");
    assert.notEqual(
      store.deriveEmailStatus({ sentAt: Date.parse(t0) }),
      store.deriveEmailStatus({ deliveredAt: Date.parse(t1) })
    );
    const result = await store.upsertWebsiteEmailMessage({
      provider_message_id: "m-1",
      website_customer_id: "c-main",
      recipient: " Equal@Example.COM ",
      delivered_at: t1,
      sent_at: null,
      source_updated_at: t1,
    });
    assert.equal(result.message.status, "delivered");
    assert.equal(result.message.sent_at, null);
  });

  await test("T18", "later sent event preserves delivered fact and delivered status", async () => {
    const result = await store.upsertWebsiteEmailMessage({
      provider_message_id: "m-1",
      website_customer_id: "c-main",
      recipient: "equal@example.com",
      sent_at: t0,
      delivered_at: null,
      source_updated_at: t2,
    });
    assert.equal(result.message.sent_at, Date.parse(t0));
    assert.equal(result.message.delivered_at, Date.parse(t1));
    assert.equal(result.message.status, "delivered");
  });

  await test("T19", "bounce after delivery wins derived status precedence", async () => {
    assert.equal(store.deriveEmailStatus({ deliveredAt: 1, bouncedAt: 2 }), "bounced");
    const result = await store.upsertWebsiteEmailMessage({
      provider_message_id: "m-1",
      website_customer_id: "c-main",
      bounced_at: t3,
      source_updated_at: t3,
    });
    assert.equal(result.message.delivered_at, Date.parse(t1));
    assert.equal(result.message.status, "bounced");
  });

  await test("T20", "failed status outranks delivered and is materialized", async () => {
    assert.equal(store.deriveEmailStatus({ deliveredAt: 1, failedAt: 2 }), "failed");
    const result = await store.upsertWebsiteEmailMessage({
      provider_message_id: "m-2",
      recipient: "failed@example.com",
      delivered_at: t1,
      failed_at: t2,
      source_updated_at: t2,
    });
    assert.equal(result.message.status, "failed");
    assert.equal((await store.getWebsiteEmailMessage("m-2")).status, "failed");
  });

  let firstEvent;
  await test("T21", "ingest event is inserted with entity_id and hash only", async () => {
    firstEvent = await store.recordIngestEvent({
      event_id: "event-1",
      event_type: "customer.updated",
      entity_id: "c-main",
      received_at: t2,
      occurred_at: t1,
      source_updated_at: t1,
      outcome: "applied",
      payload_hash: "sha256:abc",
    });
    assert.equal(firstEvent.duplicate, false);
    assert.equal(firstEvent.outcome, "applied");
    assert.equal(firstEvent.event.entity_id, "c-main");
  });

  await test("T22", "duplicate event returns exact stored event and outcome", async () => {
    const duplicate = await store.recordIngestEvent({
      event_id: "event-1",
      event_type: "different.type",
      entity_id: "different",
      received_at: t4,
      outcome: "rejected",
      payload_hash: "sha256:different",
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.outcome, "applied");
    assert.deepEqual(duplicate.event, firstEvent.event);
    assert.equal((await db.websiteDataGet(
      "SELECT COUNT(*) AS n FROM website_ingest_events WHERE event_id = 'event-1'"
    )).n, 1);
  });

  await test("T23", "sync run can be created and finished", async () => {
    const started = await store.beginSyncRun({ started_at: t0, source_kind: "reconcile" });
    assert.equal(started.status, "running");
    const finished = await store.finishSyncRun(started.id, {
      finished_at: t1,
      status: "completed",
      received_count: 5,
      applied_count: 3,
      skipped_count: 2,
      detail: { source: "test" },
    });
    assert.equal(finished.applied_count, 3);
    assert.equal(finished.finished_at, Date.parse(t1));
  });

  await test("T24", "one owner/zalo pair has at most one active binding", async () => {
    const claimed = await store.createOrUpdateBinding({
      owner_uid: "owner-1",
      zalo_uid: "zalo-1",
      website_customer_id: "c-main",
      state: "claimed",
      bound_at: t0,
    });
    const verified = await store.createOrUpdateBinding({
      owner_uid: "owner-1",
      zalo_uid: "zalo-1",
      website_customer_id: "c-main",
      state: "verified",
      last_verified_at: t1,
    });
    assert.equal(verified.id, claimed.id);
    assert.equal((await db.websiteDataGet(
      `SELECT COUNT(*) AS n FROM zalo_customer_bindings
       WHERE owner_uid = 'owner-1' AND zalo_uid = 'zalo-1' AND state IN ('claimed','verified')`
    )).n, 1);
    await assert.rejects(
      () => db.websiteDataRun(
        `INSERT INTO zalo_customer_bindings
           (owner_uid, zalo_uid, website_customer_id, state, updated_at)
         VALUES ('owner-1', 'zalo-1', 'c-main', 'claimed', 1)`
      ),
      /UNIQUE constraint failed/
    );
  });

  await test("T25", "multiple revoked historical binding rows are allowed", async () => {
    await store.createOrUpdateBinding({
      owner_uid: "owner-2", zalo_uid: "zalo-2", website_customer_id: "c-main", state: "claimed",
    });
    await store.createOrUpdateBinding({
      owner_uid: "owner-2", zalo_uid: "zalo-2", website_customer_id: "c-main", state: "revoked",
    });
    await store.createOrUpdateBinding({
      owner_uid: "owner-2", zalo_uid: "zalo-2", website_customer_id: "c-main", state: "verified",
    });
    await store.createOrUpdateBinding({
      owner_uid: "owner-2", zalo_uid: "zalo-2", website_customer_id: "c-main", state: "revoked",
    });
    assert.equal((await db.websiteDataGet(
      `SELECT COUNT(*) AS n FROM zalo_customer_bindings
       WHERE owner_uid = 'owner-2' AND zalo_uid = 'zalo-2' AND state = 'revoked'`
    )).n, 2);
  });

  await test("T26", "one Website customer may bind to multiple different Zalo UIDs", async () => {
    await store.createOrUpdateBinding({
      owner_uid: "owner-3", zalo_uid: "zalo-a", website_customer_id: "c-main", state: "verified",
    });
    await store.createOrUpdateBinding({
      owner_uid: "owner-3", zalo_uid: "zalo-b", website_customer_id: "c-main", state: "verified",
    });
    assert.equal((await db.websiteDataGet(
      "SELECT COUNT(*) AS n FROM zalo_customer_bindings WHERE website_customer_id = 'c-main' AND owner_uid = 'owner-3'"
    )).n, 2);
  });

  const websiteDataSource = fs.readFileSync(path.join(REPO, "lib", "website-data.js"), "utf8");
  await test("T27", "canonical identity is Website ID; no fuzzy/name identity exists", async () => {
    const columns = await db.websiteDataAll("PRAGMA table_info(website_customers)");
    assert.equal(columns.find((column) => column.name === "website_customer_id")?.pk, 1);
    const customerIndexes = await db.websiteDataAll(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'website_customers' AND sql IS NOT NULL"
    );
    assert.ok(customerIndexes.every((index) => !/\bname\b/i.test(index.sql)));
    assert.doesNotMatch(websiteDataSource, /WHERE\s+name\b/i);
    assert.doesNotMatch(websiteDataSource, /fuzzy/i);
    assert.match(websiteDataSource, /website_customer_id/);
  });

  await test("T28", "ingest schema and source contain no raw provider payload storage", async () => {
    const columns = (await db.websiteDataAll("PRAGMA table_info(website_ingest_events)"))
      .map((column) => column.name);
    for (const forbidden of ["raw_payload", "raw_body", "payload_json", "provider_payload"]) {
      assert.ok(!columns.includes(forbidden));
      assert.doesNotMatch(websiteDataSource, new RegExp(`\\b${forbidden}\\b`, "i"));
    }
    assert.ok(columns.includes("payload_hash"));
  });

  await test("T29", "order on a complete customer does not mutate or restub that customer", async () => {
    await store.upsertWebsiteCustomer({
      website_customer_id: "c-complete",
      name: "Complete",
      phone: "0901234567",
      email: "complete@example.com",
      source_updated_at: t3,
    });
    const before = await store.getWebsiteCustomer("c-complete");
    await store.upsertWebsiteOrder({
      order_id: "o-complete",
      website_customer_id: "c-complete",
      product_name: "Course Complete",
      source_updated_at: t4,
    });
    const after = await store.getWebsiteCustomer("c-complete");
    assert.equal(after.name, before.name);
    assert.equal(after.phone, before.phone);
    assert.equal(after.email, before.email);
    assert.equal(after.is_stub, 0);
    assert.equal(after.local_updated_at, before.local_updated_at);
  });

  assert.equal(results.length, 29);
  console.log("TEST_DB_ISOLATED = YES");
  console.log(`TEST_DB_PATH = ${resolvedTestDbPath}`);
  console.log(`CANONICAL_DB_PATH = ${CANONICAL_DB}`);
  console.log("CANONICAL_DB_OPENED_BY_TEST = NO");
  console.log("SOURCE_TIMESTAMP_STORAGE = INTEGER_EPOCH_MILLISECONDS");
  console.log("EMAIL_TIMESTAMP_MERGE = SET_ONCE_EARLIEST_WINS");
  console.log("T1_T29 = PASS");
}

if (process.argv[2] === "--worker") {
  await worker(path.resolve(process.argv[3]));
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "website-data-store-"));
  const shim = createSqliteShim();
  const child = spawnSync(process.execPath, [...process.execArgv, "-r", shim.preload, THIS_FILE, "--worker", temp], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env },
    timeout: 60_000,
  });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(shim.directory, { recursive: true, force: true });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status || 1;
}
