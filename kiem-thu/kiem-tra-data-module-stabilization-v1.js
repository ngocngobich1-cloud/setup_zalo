import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REGISTER = path.join(REPO, "kiem-thu", "sqlite3-node24-test-register.js");

function pass(id, message) {
  console.log(`${id} = PASS — ${message}`);
}

async function backendWorker(tempDirectory) {
  process.chdir(tempDirectory);
  const canonicalDb = path.resolve(REPO, "data", "zalo.db");
  const { resolveDatabasePaths } = await import(pathToFileURL(path.join(REPO, "lib", "database-path.js")).href);
  const testDbPath = path.resolve(resolveDatabasePaths(process.cwd()).dbPath);
  assert.notEqual(testDbPath, canonicalDb);
  assert.ok(testDbPath.startsWith(`${path.resolve(tempDirectory)}${path.sep}`));

  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  const store = await import(pathToFileURL(path.join(REPO, "lib", "website-data.js")).href);
  const query = await import(pathToFileURL(path.join(REPO, "lib", "website-query.js")).href);
  await db.initDb();
  for (let index = 0; index < 51; index++) {
    await store.upsertWebsiteCustomer({
      website_customer_id: `stabilization-${String(index).padStart(2, "0")}`,
      name: `Customer ${String(index).padStart(2, "0")}`,
      source_updated_at: 1_800_200_000_000 + index,
    });
  }

  const clamped = await query.listWebsiteCustomers({ page: 99, pageSize: 25 });
  assert.equal(clamped.total, 51);
  assert.equal(clamped.totalPages, 3);
  assert.equal(clamped.page, 3);
  assert.equal(clamped.items.length, 1);
  pass("BACKEND_PAGE_CLAMP", "out-of-range page is clamped before OFFSET");

  const empty = await query.listWebsiteCustomers({ q: "no-such-customer", page: 9, pageSize: 25 });
  assert.equal(empty.total, 0);
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.page, 1);
  assert.deepEqual(empty.items, []);
  pass("BACKEND_ZERO_PAGE", "zero results return page=1 and totalPages=1");
  console.log("BACKEND_TEST_DB_ISOLATED = YES");
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : force;
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.listeners = new Map();
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.className = "";
  }
  get options() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  add(child) { this.children.push(child); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback({ target: this, ...event });
  }
  closest() { return null; }
}

class FakeOption extends FakeElement {
  constructor(label, value) {
    super("option");
    this.textContent = label;
    this.value = value;
  }
}

function listData(name, { page = 1, totalPages = 1, purchaseDate = null } = {}) {
  return {
    items: name ? [{
      website_customer_id: name.toLowerCase().replaceAll(" ", "-"), name,
      phone: null, email: null, products: [], purchase_date: purchaseDate,
      stage: "STAGE_03", total_spent: 1000,
    }] : [],
    page, pageSize: 50, total: name ? 1 : 0, totalPages,
    capabilities: { purchaseDateFilter: false },
    filters: { products: [], stages: ["STAGE_03"] },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(body, ok = true) {
  return { ok, json: async () => body };
}

async function frontendTests() {
  const selectors = [
    "#data-sync", "#data-toolbar", "#data-search", "#data-product", "#data-stage",
    "#data-date-from", "#data-date-to", "#data-date-note", "#data-sort", "#data-page-size",
    "#data-prev", "#data-next", "#data-page-label", "#data-table-body", "#data-cards",
    "#data-empty", "#data-message", "#data-last-sync", "#data-received", "#data-saved",
    "#data-skipped", "#data-total-customers", "#data-detail", "#data-detail-backdrop",
    "#data-detail-close", "#data-detail-title", "#data-detail-body", ".data-results",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement()]));
  elements.get("#data-sort").value = "name:asc";
  elements.get("#data-page-size").value = "50";
  globalThis.Option = FakeOption;
  globalThis.document = {
    querySelector: (selector) => elements.get(selector) || null,
    createElement: (tag) => new FakeElement(tag),
  };
  globalThis.window = { clearTimeout, setTimeout };

  const requests = [];
  globalThis.fetch = (url) => {
    const pending = deferred();
    requests.push({ url: String(url), pending });
    return pending.promise;
  };

  const originalSource = fs.readFileSync(path.join(REPO, "public", "data.js"), "utf8");
  const testExports = `\nexport { date as __date, makeRow as __makeRow, makeCard as __makeCard, openDetail as __openDetail, loadList as __loadList, loadStatus as __loadStatus, state as __state };`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(originalSource + testExports).toString("base64")}`;
  const client = await import(moduleUrl);

  const validMs = 1_800_000_000_000;
  for (const invalid of [null, undefined, "", 0, "0", Number.NaN, "abc"]) {
    assert.equal(client.__date(invalid), "—");
  }
  assert.equal(client.__date(validMs), new Intl.DateTimeFormat("vi-VN", { dateStyle: "short" }).format(new Date(validMs)));
  assert.equal(client.__makeRow(listData("Desktop").items[0]).children[4].textContent, "—");
  assert.equal(client.__makeCard(listData("Mobile").items[0]).children[4].children[1].textContent, "—");
  pass("DATE_MATRIX", "null/zero/malformed dates render em dash; valid milliseconds remain formatted");
  pass("DATE_DESKTOP_MOBILE", "desktop row and mobile card share the guarded formatter");

  elements.get("#data-search").value = "old search";
  const oldSearch = client.__loadList(4);
  elements.get("#data-search").value = "new search";
  const newSearch = client.__loadList(1);
  assert.equal(new URL(requests.at(-2).url, "http://local").searchParams.get("q"), "old search");
  assert.equal(new URL(requests.at(-1).url, "http://local").searchParams.get("q"), "new search");
  requests.at(-1).pending.resolve(response(listData("Newest Search")));
  await newSearch;
  requests.at(-2).pending.resolve(response(listData("Stale Search", { page: 4, totalPages: 4 })));
  await oldSearch;
  assert.equal(elements.get("#data-table-body").children[0].children[0].textContent, "Newest Search");
  assert.equal(client.__state.page, 1);
  pass("LATEST_SEARCH", "stale search success cannot overwrite the newest result");

  elements.get("#data-product").value = "old-product";
  const oldFilter = client.__loadList(2);
  elements.get("#data-product").value = "new-product";
  const newFilter = client.__loadList(1);
  assert.equal(new URL(requests.at(-2).url, "http://local").searchParams.get("product"), "old-product");
  assert.equal(new URL(requests.at(-1).url, "http://local").searchParams.get("product"), "new-product");
  requests.at(-1).pending.resolve(response(listData("Newest Filter")));
  await newFilter;
  requests.at(-2).pending.resolve(response(listData("Stale Filter", { page: 2, totalPages: 2 })));
  await oldFilter;
  assert.equal(elements.get("#data-table-body").children[0].children[0].textContent, "Newest Filter");
  pass("LATEST_FILTER", "stale filter success cannot overwrite the newest result");

  const staleError = client.__loadList(1);
  const newerSuccess = client.__loadList(1);
  requests.at(-1).pending.resolve(response(listData("Success After Error")));
  await newerSuccess;
  requests.at(-2).pending.resolve(response({ error: "stale failure" }, false));
  await staleError;
  assert.equal(elements.get("#data-message").textContent, "");
  assert.equal(elements.get("#data-table-body").children[0].children[0].textContent, "Success After Error");
  assert.equal(client.__state.loading, false);
  pass("STALE_ERROR", "stale error and stale finally have no visible/loading side effects");

  client.__state.page = 1;
  client.__state.totalPages = 3;
  const firstNext = client.__loadList(client.__state.page + 1);
  const secondNext = client.__loadList(client.__state.page + 1);
  assert.equal(new URL(requests.at(-2).url, "http://local").searchParams.get("page"), "2");
  assert.equal(new URL(requests.at(-1).url, "http://local").searchParams.get("page"), "2");
  assert.equal(client.__state.page, 1);
  requests.at(-1).pending.resolve(response(listData("Page Two", { page: 2, totalPages: 3 })));
  await secondNext;
  requests.at(-2).pending.resolve(response(listData("Duplicate Page Two", { page: 2, totalPages: 3 })));
  await firstNext;
  assert.equal(client.__state.page, 2);
  pass("PAGINATION_RAPID", "rapid Next requests the same target without speculative page mutation");

  client.__state.page = 7;
  const clampRequest = client.__loadList(7);
  requests.at(-1).pending.resolve(response(listData("Clamped", { page: 3, totalPages: 3 })));
  await clampRequest;
  assert.equal(client.__state.page, 3);
  const previousAfterClamp = client.__loadList(client.__state.page - 1);
  assert.equal(new URL(requests.at(-1).url, "http://local").searchParams.get("page"), "2");
  requests.at(-1).pending.resolve(response(listData("Previous", { page: 2, totalPages: 3 })));
  await previousAfterClamp;
  assert.equal(client.__state.page, 2);
  pass("FRONTEND_PAGE_CLAMP", "accepted API page is committed and Previous navigates from the clamp");

  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/data\/customers\/detail-customer/);
    return response({
      customer: { name: "Detail", phone: null, email: null, stage: "STAGE_03", total_spent: 0 },
      products: [],
      orders: [{ order_id: "order-1", product_name: null, purchase_date: null, amount: null }],
      emailTracking: { hasData: false, status: "not_tracked", message: null },
    });
  };
  await client.__openDetail("detail-customer");
  const orderText = elements.get("#data-detail-body").children[2].children[1].textContent;
  assert.match(orderText, /order-1 · — · — · —/);
  pass("DATE_DETAIL", "detail order date uses the guarded formatter");

  const statuses = [
    ["NEVER_RUN", null, "Chưa đồng bộ", "—"],
    ["RUNNING", { finished_at: validMs, received_count: 0, applied_count: 0, skipped_count: 0 }, "Đang đồng bộ…", "—"],
    ["INTERRUPTED", { finished_at: validMs, received_count: 0, applied_count: 0, skipped_count: 0 }, "Bị gián đoạn", "—"],
    ["FAILED", { finished_at: validMs, received_count: 0, applied_count: 0, skipped_count: 0 }, "Đồng bộ thất bại", "—"],
    ["COMPLETED", { finished_at: validMs, received_count: 9, applied_count: 8, skipped_count: 1 }, client.__date(validMs, true), "9"],
  ];
  for (const [status, run, label, received] of statuses) {
    globalThis.fetch = async () => response({ status, run, total_customers: 12 });
    await client.__loadStatus();
    assert.equal(elements.get("#data-last-sync").textContent, label);
    assert.equal(elements.get("#data-received").textContent, received);
    if (status === "FAILED") {
      assert.equal(elements.get("#data-saved").textContent, "—");
      assert.equal(elements.get("#data-skipped").textContent, "—");
    }
  }
  pass("SYNC_STATUS_MATRIX", "NEVER/RUNNING/INTERRUPTED/FAILED/COMPLETED are distinct; failed counts are em dashes");
}

function layoutStructureTests() {
  const css = fs.readFileSync(path.join(REPO, "public", "style.css"), "utf8");
  const tracks = "auto auto auto auto auto minmax(0, 1fr) auto";
  const panelRules = [...css.matchAll(/\.data-panel\s*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(panelRules.length >= 2);
  assert.ok(panelRules[0].includes(`grid-template-rows: ${tracks}`));
  const mobileStart = css.indexOf("@media (max-width: 760px)");
  assert.ok(mobileStart >= 0);
  assert.match(css.slice(mobileStart), new RegExp(`\\.data-panel \\{ grid-template-rows: ${tracks.replace(/[()]/g, "\\$&")}\\; \\}`));
  for (const [selector, row] of [
    [".data-header", 1], [".data-sync-status", 2], ["#data-toolbar", 3],
    ["#data-date-note", 4], ["#data-message", 5], [".data-results", 6],
    [".data-pagination", 7],
  ]) {
    const escaped = selector.replace(/[.#]/g, "\\$&");
    assert.match(css, new RegExp(`\\.data-panel > ${escaped} \\{ grid-row: ${row}\\; \\}`));
  }
  assert.match(css, /\.hidden\s*\{\s*display:\s*none !important;\s*\}/);
  assert.match(css, /\.module-panel\s*\{[\s\S]*?grid-area:\s*1 \/ 1;[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;\s*\}/);
  pass("LAYOUT_STRUCTURE", "desktop/mobile have seven tracks and all children are explicitly pinned");
  pass("SHARED_CSS_LOCK", "locked shared selectors are untouched");
}

async function main() {
  layoutStructureTests();
  await frontendTests();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "data-stabilization-v1-"));
  const child = spawnSync(process.execPath, [...process.execArgv, "--import", pathToFileURL(REGISTER).href, THIS_FILE, "--backend-worker", temp], {
    cwd: REPO, encoding: "utf8", timeout: 120_000, env: { ...process.env },
  });
  process.stdout.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  fs.rmSync(temp, { recursive: true, force: true });
  if (child.error) throw child.error;
  assert.equal(child.status, 0);
  console.log("DATA_MODULE_STABILIZATION_V1_AUTOMATED = PASS");
}

if (process.argv[2] === "--backend-worker") await backendWorker(path.resolve(process.argv[3]));
else await main();
