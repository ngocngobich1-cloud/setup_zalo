import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REGISTER = path.join(REPO, "kiem-thu", "sqlite3-node24-test-register.js");
const ADAPTER = path.join(REPO, "kiem-thu", "sqlite3-node24-test-adapter.js");
const CANONICAL_DB = path.resolve(REPO, "data", "zalo.db");

function pass(id, message) {
  console.log(`${id} = PASS — ${message}`);
}

async function backendWorker(tempDirectory) {
  process.chdir(tempDirectory);
  const adapter = await import(pathToFileURL(ADAPTER).href);
  const originalAll = adapter.Database.prototype.all;
  const originalGet = adapter.Database.prototype.get;
  const queryCounts = { count: 0, paged: 0, candidates: 0, products: 0 };
  adapter.Database.prototype.all = function countRelevantQueries(sql, params, callback) {
    const compact = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT c\.website_customer_id, c\.name, c\.phone, c\.email, c\.total_spent, c\.stage,/i.test(compact)) {
      if (/ LIMIT \? OFFSET \?$/i.test(compact)) queryCounts.paged++;
      else queryCounts.candidates++;
    }
    if (/FROM website_customer_products WHERE website_customer_id IN \(/i.test(compact)) {
      queryCounts.products++;
    }
    return originalAll.call(this, sql, params, callback);
  };
  adapter.Database.prototype.get = function countCustomerCountQuery(sql, params, callback) {
    const compact = String(sql).replace(/\s+/g, " ").trim();
    if (/^SELECT COUNT\(\*\) AS total FROM website_customers c WHERE/i.test(compact)) {
      queryCounts.count++;
    }
    return originalGet.call(this, sql, params, callback);
  };

  const { resolveDatabasePaths } = await import(pathToFileURL(path.join(REPO, "lib", "database-path.js")).href);
  const testDbPath = path.resolve(resolveDatabasePaths(process.cwd()).dbPath);
  assert.notEqual(testDbPath, CANONICAL_DB);
  assert.ok(testDbPath.startsWith(`${path.resolve(tempDirectory)}${path.sep}`));

  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  const store = await import(pathToFileURL(path.join(REPO, "lib", "website-data.js")).href);
  const query = await import(pathToFileURL(path.join(REPO, "lib", "website-query.js")).href);
  await db.initDb();

  let timestamp = 1_800_300_000_000;
  const addCustomer = async (id, fields = {}) => {
    timestamp++;
    await store.upsertWebsiteCustomer({
      website_customer_id: id,
      name: fields.name ?? id,
      phone: fields.phone,
      email: fields.email,
      total_spent: fields.total_spent,
      stage: fields.stage,
      source_updated_at: timestamp,
    });
  };
  const addProduct = async (id, productName) => {
    timestamp++;
    await store.upsertCustomerProduct({
      website_customer_id: id,
      product_name: productName,
      source_kind: "snapshot",
      source_updated_at: timestamp,
    });
  };
  const addOrder = async (id, orderId, purchaseDate) => {
    timestamp++;
    await store.upsertWebsiteOrder({
      website_customer_id: id,
      order_id: orderId,
      purchase_date: purchaseDate,
      source_updated_at: timestamp,
    });
  };
  const resetCounts = () => {
    for (const key of Object.keys(queryCounts)) queryCounts[key] = 0;
  };

  await addCustomer("vn-nguyen", { name: "NGUYỄN VĂN AN", stage: "Case" });
  await addCustomer("vn-bich", { name: "Trần Thị Bích", stage: "Case" });
  await addCustomer("vn-glyphs", { name: "ĂN ÂN ĐÊM ÊM ÔNG ƠN ƯỚC Ắ Ầ Ế Ố Ờ Ứ", stage: "Case" });
  await addCustomer("ascii-name", { name: "ASCII CUSTOMER", stage: "Regression" });
  await addCustomer("email-case", { name: "Email Fixture", email: "USER@EXAMPLE.COM", stage: "Regression" });
  await addCustomer("raw-phone", { name: "Raw Phone Fixture", phone: "090 2468 135", stage: "Regression" });
  await addCustomer("normalized-phone", { name: "Normalized Phone Fixture", phone: "0901234567", stage: "Regression" });
  await addCustomer("wild-percent", { name: "Literal % Customer", email: "percent@example.test", stage: "Wildcard" });
  await addCustomer("wild-underscore", { name: "Literal _ Customer", email: "underscore@example.test", stage: "Wildcard" });

  const paginationIds = [];
  for (let index = 0; index < 27; index++) {
    const id = `pagination-${String(index).padStart(2, "0")}`;
    paginationIds.push(id);
    await addCustomer(id, {
      name: `KHÁCH VIỆT PHÂN TRANG ${String(index).padStart(2, "0")}`,
      stage: index === 0 ? "Excluded stage" : "Pagination",
    });
    await addProduct(id, index === 1 ? "Pagination Target" : "Pagination General");
  }
  await addCustomer("pagination-nonmatch", { name: "KHÁCH KHÔNG LIÊN QUAN", stage: "Pagination" });

  for (let index = 0; index < 4; index++) {
    const id = `product-search-${index}`;
    await addCustomer(id, { name: `SẢN PHẨM LỌC ${index}`, stage: "Product" });
    await addProduct(id, index < 2 ? "Khóa Mục Tiêu" : "Khóa Khác");
  }

  await addCustomer("date-inside", { name: "DATE RANGE INSIDE", stage: "Date" });
  await addOrder("date-inside", "order-inside", "2026-06-15T12:00:00Z");
  await addCustomer("date-outside", { name: "DATE RANGE OUTSIDE", stage: "Date" });
  await addOrder("date-outside", "order-outside", "2025-06-15T12:00:00Z");

  for (const search of ["nguyễn văn an", "Nguyễn Văn An", "NGUYỄN VĂN AN", "nGuYễN vĂn aN"]) {
    const result = await query.listWebsiteCustomers({ q: search });
    assert.deepEqual(result.items.map((item) => item.website_customer_id), ["vn-nguyen"]);
  }
  pass("A1", "uppercase Vietnamese name matches all four case variants");

  for (const search of ["trần thị bích", "TRẦN THỊ BÍCH"]) {
    const result = await query.listWebsiteCustomers({ q: search });
    assert.deepEqual(result.items.map((item) => item.website_customer_id), ["vn-bich"]);
  }
  pass("A2", "mixed-case stored Vietnamese name matches lower and upper queries");

  const glyphResult = await query.listWebsiteCustomers({ q: "ăn ân đêm êm ông ơn ước ắ ầ ế ố ờ ứ" });
  assert.deepEqual(glyphResult.items.map((item) => item.website_customer_id), ["vn-glyphs"]);
  pass("A3", "Ă Â Đ Ê Ô Ơ Ư and tone-marked forms case-fold in JavaScript");

  assert.equal((await query.listWebsiteCustomers({ q: "nguyen van an" })).total, 0);
  pass("A4", "accent-free query does not match accented data");

  const page1 = await query.listWebsiteCustomers({ q: "khách việt phân trang", page: 1, pageSize: 25 });
  const page2 = await query.listWebsiteCustomers({ q: "khách việt phân trang", page: 2, pageSize: 25 });
  const clamped = await query.listWebsiteCustomers({ q: "khách việt phân trang", page: 99, pageSize: 25 });
  assert.equal(page1.total, 27);
  assert.equal(page1.totalPages, 2);
  assert.equal(page1.items.length, 25);
  assert.equal(page2.items.length, 2);
  assert.equal(clamped.page, 2);
  assert.equal(clamped.total, 27);
  assert.equal(clamped.totalPages, 2);
  const union = [...page1.items, ...page2.items].map((item) => item.website_customer_id);
  assert.equal(new Set(union).size, union.length);
  assert.deepEqual(new Set(union), new Set(paginationIds));
  pass("A5", "active search totals before pagination, spans pages, and clamps page 99");

  resetCounts();
  const empty = await query.listWebsiteCustomers({ q: "không tồn tại tuyệt đối", page: 99, pageSize: 25 });
  assert.deepEqual({ total: empty.total, totalPages: empty.totalPages, page: empty.page, items: empty.items }, {
    total: 0, totalPages: 1, page: 1, items: [],
  });
  assert.equal(queryCounts.products, 0);
  pass("A6", "zero result preserves page=1 and runs zero products queries");

  assert.deepEqual((await query.listWebsiteCustomers({ q: "%" })).items.map((item) => item.website_customer_id), ["wild-percent"]);
  assert.deepEqual((await query.listWebsiteCustomers({ q: "_" })).items.map((item) => item.website_customer_id), ["wild-underscore"]);
  pass("A7", "percent and underscore are literal characters under String.includes");

  assert.deepEqual((await query.listWebsiteCustomers({ q: "ascii customer" })).items.map((item) => item.website_customer_id), ["ascii-name"]);
  pass("R1", "ASCII name search remains case-insensitive");

  for (const search of ["user@example.com", "USER@EXAMPLE.COM"]) {
    assert.deepEqual((await query.listWebsiteCustomers({ q: search })).items.map((item) => item.website_customer_id), ["email-case"]);
  }
  pass("R2", "email search remains case-insensitive in both directions");

  assert.deepEqual((await query.listWebsiteCustomers({ q: "2468" })).items.map((item) => item.website_customer_id), ["raw-phone"]);
  pass("R3", "raw phone substring search remains active");

  assert.deepEqual((await query.listWebsiteCustomers({ q: "+84901234567" })).items.map((item) => item.website_customer_id), ["normalized-phone"]);
  pass("R4", "normalized phone exact-match branch remains active");

  const productFiltered = await query.listWebsiteCustomers({ q: "sản phẩm lọc", product: " KHÓA  MỤC TIÊU " });
  assert.equal(productFiltered.total, 2);
  assert.deepEqual(new Set(productFiltered.items.map((item) => item.website_customer_id)), new Set(["product-search-0", "product-search-1"]));
  pass("R5", "product filter and q search retain AND semantics");

  const injectionGuard = await query.listWebsiteCustomers({ q: "khách việt", sort: "name; DROP TABLE website_customers;--" });
  assert.ok(injectionGuard.items.length > 0);
  assert.ok(await db.websiteDataGet("SELECT COUNT(*) AS total FROM website_customers"));
  pass("R6", "sort allowlist still blocks SQL injection input");

  for (const size of [25, 50, 100]) {
    assert.equal((await query.listWebsiteCustomers({ q: "khách việt", pageSize: size })).pageSize, size);
  }
  assert.equal((await query.listWebsiteCustomers({ q: "khách việt", pageSize: 2 })).pageSize, 50);
  pass("R7", "page-size allowlist remains 25/50/100 with invalid default 50");

  resetCounts();
  await query.listWebsiteCustomers({ q: "khách việt", pageSize: 25 });
  assert.equal(queryCounts.products, 1);
  resetCounts();
  await query.listWebsiteCustomers({ q: "khách việt", pageSize: 100 });
  assert.equal(queryCounts.products, 1);
  pass("R8", "non-empty page uses exactly one products query independent of page size");

  const absentItems = (await query.listWebsiteCustomers({ pageSize: 100 })).items;
  const presentItems = (await query.listWebsiteCustomers({ q: "khách việt", pageSize: 100 })).items;
  for (const item of [...absentItems, ...presentItems]) {
    assert.equal("phone_normalized" in item, false);
  }
  for (const secret of ["website_api_token", "provider_payload", "raw_payload"]) {
    assert.equal(JSON.stringify([...absentItems, ...presentItems]).includes(secret), false);
  }
  pass("R9", "q-absent and q-present responses expose no phone_normalized or secret fields");

  const dateFiltered = await query.listWebsiteCustomers({
    q: "date range", dateFrom: "2026-01-01", dateTo: "2026-12-31",
  });
  assert.equal(dateFiltered.capabilities.purchaseDateFilter, true);
  assert.deepEqual(dateFiltered.items.map((item) => item.website_customer_id), ["date-inside"]);
  assert.equal(dateFiltered.items[0].purchase_date, Date.parse("2026-06-15T12:00:00Z"));
  pass("R10", "purchase-date capability and filters remain active with q search");

  resetCounts();
  await query.listWebsiteCustomers({ page: 1, pageSize: 25 });
  assert.deepEqual(queryCounts, { count: 1, paged: 1, candidates: 0, products: 1 });
  pass("R12", "q-absent path retains COUNT plus LIMIT/OFFSET and one products query");

  resetCounts();
  await query.listWebsiteCustomers({ q: "khách việt", page: 1, pageSize: 25 });
  assert.deepEqual(queryCounts, { count: 0, paged: 0, candidates: 1, products: 1 });
  pass("PATH_B", "q-present path uses one candidate query, no COUNT, and one products query");

  const source = fs.readFileSync(path.join(REPO, "lib", "website-query.js"), "utf8");
  assert.doesNotMatch(source, /function likeTerm/);
  assert.doesNotMatch(source, /LIKE \? ESCAPE/);
  assert.doesNotMatch(source, /\.normalize\(/);
  assert.match(source, /String\(value \?\? ""\)\.toLowerCase\(\)/);
  pass("SOURCE", "case folding has no locale, normalization, LIKE helper, or SQL q predicate");

  console.log("TEST_DB_ISOLATED = YES");
  console.log(`TEST_DB_PATH = ${testDbPath}`);
  console.log("CANONICAL_DB_OPENED_BY_TEST = NO");
  console.log("PRODUCT_QUERY_COUNT = NON_EMPTY:1; ZERO:0");
  console.log("VIETNAMESE_SEARCH_NORMALIZATION_V1 = PASS");
}

if (process.argv[2] === "--backend-worker") {
  await backendWorker(path.resolve(process.argv[3]));
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vietnamese-search-normalization-v1-"));
  const child = spawnSync(process.execPath, [
    ...process.execArgv,
    "--import",
    pathToFileURL(REGISTER).href,
    THIS_FILE,
    "--backend-worker",
    temp,
  ], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env },
  });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  fs.rmSync(temp, { recursive: true, force: true });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status || 1;
}
