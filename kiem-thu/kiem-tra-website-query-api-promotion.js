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
const ADAPTER = path.join(REPO, "kiem-thu", "sqlite3-node24-test-adapter.js");
const CANONICAL_DB = path.resolve(REPO, "data", "zalo.db");

async function worker(tempDirectory) {
  process.chdir(tempDirectory);
  const adapter = await import(pathToFileURL(ADAPTER).href);
  const originalRun = adapter.Database.prototype.run;
  const originalAll = adapter.Database.prototype.all;
  let failPromotionEmailUpdate = false;
  let relevantProductQueries = 0;
  adapter.Database.prototype.run = function runWithPredicateFailure(sql, params, callback) {
    if (failPromotionEmailUpdate && /^\s*UPDATE\s+website_email_messages\s+SET\s+website_customer_id/i.test(String(sql))) {
      failPromotionEmailUpdate = false;
      const done = typeof params === "function" ? params : callback;
      done?.call(this, new Error("P6 deterministic SQL predicate failure"));
      return this;
    }
    return originalRun.call(this, sql, params, callback);
  };
  adapter.Database.prototype.all = function countBoundedProductQuery(sql, params, callback) {
    if (/FROM\s+website_customer_products\s+WHERE\s+website_customer_id\s+IN/i.test(String(sql).replace(/\s+/g, " "))) {
      relevantProductQueries++;
    }
    return originalAll.call(this, sql, params, callback);
  };

  const { resolveDatabasePaths } = await import(`${pathToFileURL(path.join(REPO, "lib", "database-path.js")).href}?query=${Date.now()}`);
  const testDbPath = path.resolve(resolveDatabasePaths(process.cwd()).dbPath);
  assert.notEqual(testDbPath, CANONICAL_DB);
  assert.ok(testDbPath.startsWith(`${path.resolve(tempDirectory)}${path.sep}`));
  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  await db.initDb();
  const store = await import(pathToFileURL(path.join(REPO, "lib", "website-data.js")).href);
  const query = await import(pathToFileURL(path.join(REPO, "lib", "website-query.js")).href);
  const identity = await import(pathToFileURL(path.join(REPO, "lib", "website-identity.js")).href);
  const test = async (id, name, operation) => {
    await operation();
    console.log(`${id} = PASS — ${name}`);
  };
  const phoneKey = (phone) => identity.deriveWebsiteCustomerKey({ phone }).customerKey;
  const emailKey = (email, phone) => identity.deriveWebsiteCustomerKey({ email, phone }).customerKey;
  const customer = (id, fields = {}) => store.upsertWebsiteCustomer({
    website_customer_id: id, name: fields.name || id, phone: fields.phone,
    email: fields.email, total_spent: fields.total_spent, stage: fields.stage,
    source_updated_at: fields.source_updated_at || 1_800_100_000_000,
  });

  await test("P1", "promotion executes without a nested transaction", async () => {
    const oldId = phoneKey("0905000001");
    const newId = emailKey("p1@example.com", "0905000001");
    await customer(oldId, { phone: "0905000001" });
    const result = await store.promoteCustomerKey({ newCustomerId: newId, phoneNormalized: "84905000001" });
    assert.equal(result.promoted, true);
    assert.equal(await store.getWebsiteCustomer(oldId), undefined);
    assert.ok(await store.getWebsiteCustomer(newId));
  });

  await test("P2", "promotion moves all four child relations", async () => {
    const oldId = phoneKey("0905000002");
    const newId = emailKey("p2@example.com", "0905000002");
    await customer(oldId, { phone: "0905000002" });
    await store.upsertCustomerProduct({ website_customer_id: oldId, product_name: "P2 product", source_kind: "snapshot", source_updated_at: 1_800_100_000_001 });
    await store.upsertWebsiteOrder({ order_id: "p2-order", website_customer_id: oldId, product_name: "P2 product", source_updated_at: 1_800_100_000_001 });
    await store.upsertWebsiteEmailMessage({ provider_message_id: "p2-message", website_customer_id: oldId, recipient: "p2@example.com", source_updated_at: 1_800_100_000_001 });
    await store.createOrUpdateBinding({ owner_uid: "p2-owner", zalo_uid: "p2-zalo", website_customer_id: oldId, state: "claimed" });
    assert.equal((await store.promoteCustomerKey({ newCustomerId: newId, phoneNormalized: "84905000002" })).promoted, true);
    for (const table of ["website_customer_products", "website_orders", "website_email_messages", "zalo_customer_bindings"]) {
      assert.equal((await db.websiteDataGet(`SELECT COUNT(*) AS n FROM ${table} WHERE website_customer_id = ?`, [newId])).n, 1);
      assert.equal((await db.websiteDataGet(`SELECT COUNT(*) AS n FROM ${table} WHERE website_customer_id = ?`, [oldId])).n, 0);
    }
  });

  await test("P3", "existing destination primary key prevents promotion", async () => {
    const oldId = phoneKey("0905000003");
    const newId = emailKey("p3@example.com", "0905000003");
    await customer(oldId, { phone: "0905000003" });
    await customer(newId, { email: "p3@example.com", phone: "0905000003" });
    const result = await store.promoteCustomerKey({ newCustomerId: newId, phoneNormalized: "84905000003" });
    assert.equal(result.reason, "DESTINATION_EXISTS");
    assert.ok(await store.getWebsiteCustomer(oldId));
  });

  await test("P4", "multiple legacy-phone candidates prevent promotion", async () => {
    const phone = "0905000004";
    await customer("legacy_phone:" + "a".repeat(64), { phone });
    await customer("legacy_phone:" + "b".repeat(64), { phone });
    const result = await store.promoteCustomerKey({ newCustomerId: emailKey("p4@example.com", phone), phoneNormalized: "84905000004" });
    assert.equal(result.reason, "AMBIGUOUS_PHONE");
  });

  await test("P5", "phone-key row carrying an email is not a promotion source", async () => {
    const oldId = phoneKey("0905000005");
    await customer(oldId, { phone: "0905000005", email: "already@example.com" });
    const result = await store.promoteCustomerKey({ newCustomerId: emailKey("p5@example.com"), phoneNormalized: "84905000005" });
    assert.equal(result.reason, "SOURCE_NOT_FOUND");
    assert.ok(await store.getWebsiteCustomer(oldId));
  });

  await test("P6", "predicate-injected mid-promotion SQL failure rolls back every mutation", async () => {
    const oldId = phoneKey("0905000006");
    const newId = emailKey("p6@example.com", "0905000006");
    await customer(oldId, { phone: "0905000006" });
    await store.upsertCustomerProduct({ website_customer_id: oldId, product_name: "P6 product", source_kind: "snapshot", source_updated_at: 1_800_100_000_006 });
    await store.upsertWebsiteOrder({ order_id: "p6-order", website_customer_id: oldId, source_updated_at: 1_800_100_000_006 });
    await store.upsertWebsiteEmailMessage({ provider_message_id: "p6-message", website_customer_id: oldId, source_updated_at: 1_800_100_000_006 });
    failPromotionEmailUpdate = true;
    await assert.rejects(
      () => store.promoteCustomerKey({ newCustomerId: newId, phoneNormalized: "84905000006" }),
      /P6 deterministic SQL predicate failure/
    );
    assert.ok(await store.getWebsiteCustomer(oldId));
    assert.equal(await store.getWebsiteCustomer(newId), undefined);
    for (const table of ["website_customer_products", "website_orders", "website_email_messages"]) {
      assert.equal((await db.websiteDataGet(`SELECT COUNT(*) AS n FROM ${table} WHERE website_customer_id = ?`, [oldId])).n, 1);
      assert.equal((await db.websiteDataGet(`SELECT COUNT(*) AS n FROM ${table} WHERE website_customer_id = ?`, [newId])).n, 0);
    }
  });

  await test("P8_NO_NESTED_TRANSACTION", "promotion body uses only its transaction SQL helpers", async () => {
    const source = fs.readFileSync(path.join(REPO, "lib", "website-data.js"), "utf8");
    const body = source.slice(source.indexOf("export async function promoteCustomerKey"), source.indexOf("export { ACTIVE_BINDING_STATES"));
    for (const forbidden of ["upsertWebsiteCustomer", "upsertWebsiteOrder", "upsertCustomerProduct", "upsertWebsiteEmailMessage", "ensureCustomerStub", "createOrUpdateBinding", "recordIngestEvent"]) {
      assert.ok(!body.includes(`${forbidden}(`), `${forbidden} must not be called inside promotion`);
    }
    assert.match(body, /withWebsiteDataTransaction/);
    assert.match(body, /SELECT website_customer_id FROM website_customers WHERE website_customer_id = \?/);
    assert.doesNotMatch(body, /UPDATE\s+website_customers\s+SET\s+website_customer_id/i);
  });

  for (let index = 0; index < 110; index++) {
    const id = emailKey(`query-${index}@example.com`);
    await customer(id, {
      name: index === 0 ? "Nguyễn Search Name" : `Query Customer ${String(index).padStart(3, "0")}`,
      email: `query-${index}@example.com`, phone: index === 1 ? "0906666666" : undefined,
      stage: index % 2 ? "Khách hàng" : "Tiềm năng", total_spent: index % 7 === 0 ? null : index * 1000,
    });
    await store.upsertCustomerProduct({
      website_customer_id: id, product_name: index % 2 ? "Khóa Đặc Biệt" : "Khóa Chung",
      source_kind: "snapshot", source_updated_at: 1_800_100_100_000,
    });
  }

  await test("Q1", "server-side search by name", async () => {
    const result = await query.listWebsiteCustomers({ q: "Nguyễn Search" });
    assert.equal(result.items.length, 1);
  });
  await test("Q2", "server-side search by email", async () => {
    const result = await query.listWebsiteCustomers({ q: "query-2@example.com" });
    assert.equal(result.items.some((item) => item.email === "query-2@example.com"), true);
  });
  await test("Q3", "server-side search by normalized phone", async () => {
    const result = await query.listWebsiteCustomers({ q: "+84906666666" });
    assert.equal(result.items.some((item) => item.phone === "0906666666"), true);
  });
  await test("Q4", "pageSize allowlist supports 25, 50 and 100", async () => {
    for (const size of [25, 50, 100]) assert.equal((await query.listWebsiteCustomers({ pageSize: size })).items.length, size);
  });
  await test("Q5", "invalid pageSize safely normalizes to 50", async () => {
    const result = await query.listWebsiteCustomers({ pageSize: "999999" });
    assert.equal(result.pageSize, 50);
    assert.equal(result.items.length, 50);
  });
  await test("Q6", "sort allowlist blocks arbitrary SQL input", async () => {
    const result = await query.listWebsiteCustomers({ sort: "name; DROP TABLE website_customers;--" });
    assert.ok(result.items.length > 0);
    assert.ok(await db.websiteDataGet("SELECT COUNT(*) AS n FROM website_customers"));
  });
  await test("Q7", "product filtering uses normalized product_key", async () => {
    const result = await query.listWebsiteCustomers({ product: " KHOÁ  ĐẶC BIỆT ", pageSize: 100 });
    assert.ok(result.items.length > 0);
    assert.ok(result.items.every((item) => item.products.some((product) => product.product_key === "khoa dac biet")));
  });
  await test("Q8", "customer detail returns local customer, products, orders and tracking summary", async () => {
    const detail = await query.getWebsiteCustomerDetail(emailKey("query-0@example.com"));
    assert.equal(detail.customer.email, "query-0@example.com");
    assert.equal(detail.products.length, 1);
    assert.ok(Array.isArray(detail.orders));
    assert.ok(detail.emailTracking);
  });
  await test("Q9", "query responses contain no raw secrets", async () => {
    const serialized = JSON.stringify(await query.listWebsiteCustomers({ q: "query-0@example.com" }));
    for (const secretName of ["website_api_token", "provider_payload", "raw_payload"]) assert.ok(!serialized.includes(secretName));
  });
  await test("Q10", "date filter reports unavailable when no real purchase dates exist", async () => {
    const result = await query.listWebsiteCustomers({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    assert.equal(result.capabilities.purchaseDateFilter, false);
  });
  await test("Q11", "product query count does not scale from page 25 to page 100", async () => {
    relevantProductQueries = 0;
    await query.listWebsiteCustomers({ pageSize: 25 });
    const n1 = relevantProductQueries;
    relevantProductQueries = 0;
    await query.listWebsiteCustomers({ pageSize: 100 });
    const n2 = relevantProductQueries;
    assert.equal(n1, n2);
    assert.equal(n1, 1);
  });
  await test("Q12_TOTAL_SPENT_NULLS_LAST", "total_spent NULL values sort last in ASC and DESC", async () => {
    const productName = "Null Sort Fixture";
    for (const [suffix, amount] of [["null", null], ["ten", 10], ["twenty", 20]]) {
      const id = emailKey(`sort-${suffix}@example.com`);
      await customer(id, { email: `sort-${suffix}@example.com`, total_spent: amount });
      await store.upsertCustomerProduct({ website_customer_id: id, product_name: productName, source_kind: "snapshot", source_updated_at: 1_800_100_200_000 });
    }
    for (const dir of ["asc", "desc"]) {
      const result = await query.listWebsiteCustomers({ product: productName, sort: "total_spent", dir });
      assert.equal(result.items.at(-1).total_spent, null);
    }
  });

  await test("A1-A4", "all Data API routes live below the existing auth/session gates", async () => {
    const source = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
    const gate = source.indexOf("/* --- Tu day tro xuong: bat buoc da dang nhap --- */");
    assert.ok(gate > 0);
    for (const route of [
      'app.get("/api/data/customers"', 'app.get("/api/data/customers/:id"',
      'app.post("/api/data/sync"', 'app.get("/api/data/sync-status"',
    ]) assert.ok(source.indexOf(route) > gate, `${route} must remain auth-gated`);
  });

  await test("UI1", "Data module has desktop table, mobile cards and hardened search controls", async () => {
    const html = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
    const css = fs.readFileSync(path.join(REPO, "public", "style.css"), "utf8");
    const client = fs.readFileSync(path.join(REPO, "public", "data.js"), "utf8");
    assert.match(html, /id="module-data"/);
    assert.match(html, /class="data-table"/);
    assert.match(html, /id="data-cards"/);
    assert.match(html, /id="data-search" type="search"[\s\S]*?autocomplete="off"/);
    assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.data-toolbar input,[\s\S]*?font-size: 16px/);
    assert.match(client, /\/api\/data\/customers/);
    assert.match(client, /\/api\/data\/sync-status/);
    assert.match(client, /\/api\/data\/sync/);
  });

  console.log("P7 = DEFERRED_TO_SLICE_1_REGRESSION_COMMAND");
  console.log("TEST_DB_ISOLATED = YES");
  console.log(`TEST_DB_PATH = ${testDbPath}`);
  console.log("CANONICAL_DB_OPENED_BY_TEST = NO");
  console.log("P1_P6_P8_Q1_Q12_A1_A4_UI1 = PASS");
}

if (process.argv[2] === "--worker") {
  await worker(path.resolve(process.argv[3]));
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "website-query-promotion-"));
  const child = spawnSync(process.execPath, [...process.execArgv, "--import", REGISTER_URL, THIS_FILE, "--worker", temp], {
    cwd: process.cwd(), encoding: "utf8", timeout: 120_000, env: { ...process.env },
  });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  fs.rmSync(temp, { recursive: true, force: true });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status || 1;
}
