import { websiteDataAll, websiteDataGet } from "./db.js";
import { normalizePhone, normalizeProductKey } from "./website-data.js";

const PAGE_SIZES = new Set([25, 50, 100]);
const SORTS = new Set(["name", "total_spent"]);

function positivePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function pageSize(value) {
  const size = Number.parseInt(value, 10);
  return PAGE_SIZES.has(size) ? size : 50;
}

function foldCase(value) {
  return String(value ?? "").toLowerCase();
}

function matchesSearch(row, foldedTerm, normalizedPhone) {
  return (
    foldCase(row.name).includes(foldedTerm)
    || foldCase(row.email).includes(foldedTerm)
    || foldCase(row.phone).includes(foldedTerm)
    || (normalizedPhone !== null && row.phone_normalized === normalizedPhone)
  );
}

function dateBoundary(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const milliseconds = Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

async function purchaseDateAvailable() {
  return Boolean(await websiteDataGet(
    "SELECT 1 AS available FROM website_orders WHERE purchase_date IS NOT NULL LIMIT 1"
  ));
}

export async function listWebsiteCustomers(options = {}) {
  const requestedPage = positivePage(options.page);
  const currentPageSize = pageSize(options.pageSize);
  const sort = SORTS.has(options.sort) ? options.sort : "name";
  const dir = String(options.dir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const hasPurchaseDates = await purchaseDateAvailable();
  const where = ["c.is_stub = 0"];
  const params = [];

  const q = String(options.q || "").trim();

  const stage = String(options.stage ?? options.status ?? "").trim();
  if (stage) {
    where.push("c.stage = ?");
    params.push(stage);
  }

  const productKey = normalizeProductKey(options.product);
  if (productKey) {
    where.push(`EXISTS (
      SELECT 1 FROM website_customer_products fp
      WHERE fp.website_customer_id = c.website_customer_id AND fp.product_key = ?
    )`);
    params.push(productKey);
  }

  if (hasPurchaseDates) {
    const from = dateBoundary(options.dateFrom);
    const to = dateBoundary(options.dateTo, true);
    if (from !== null) {
      where.push(`EXISTS (
        SELECT 1 FROM website_orders odf
        WHERE odf.website_customer_id = c.website_customer_id AND odf.purchase_date >= ?
      )`);
      params.push(from);
    }
    if (to !== null) {
      where.push(`EXISTS (
        SELECT 1 FROM website_orders odt
        WHERE odt.website_customer_id = c.website_customer_id AND odt.purchase_date <= ?
      )`);
      params.push(to);
    }
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const orderSql = sort === "total_spent"
    ? `(c.total_spent IS NULL) ASC, c.total_spent ${dir}, LOWER(COALESCE(c.name, '')) ASC, c.website_customer_id ASC`
    : `(c.name IS NULL OR c.name = '') ASC, LOWER(COALESCE(c.name, '')) ${dir}, c.website_customer_id ASC`;
  let total;
  let totalPages;
  let currentPage;
  let rows;
  if (q) {
    const foldedTerm = foldCase(q);
    const normalizedPhone = normalizePhone(q);
    const candidates = await websiteDataAll(
      `SELECT c.website_customer_id, c.name, c.phone, c.email, c.total_spent, c.stage,
              c.phone_normalized,
              (SELECT MAX(o.purchase_date) FROM website_orders o
               WHERE o.website_customer_id = c.website_customer_id) AS purchase_date
       FROM website_customers c
       ${whereSql}
       ORDER BY ${orderSql}`,
      params
    );
    const filtered = candidates.filter((row) => matchesSearch(row, foldedTerm, normalizedPhone));
    total = filtered.length;
    totalPages = Math.max(1, Math.ceil(total / currentPageSize));
    currentPage = Math.min(requestedPage, totalPages);
    const start = (currentPage - 1) * currentPageSize;
    rows = filtered.slice(start, start + currentPageSize).map(({ phone_normalized, ...row }) => row);
  } else {
    const count = await websiteDataGet(
      `SELECT COUNT(*) AS total FROM website_customers c ${whereSql}`,
      params
    );
    total = Number(count?.total || 0);
    totalPages = Math.max(1, Math.ceil(total / currentPageSize));
    currentPage = Math.min(requestedPage, totalPages);
    rows = await websiteDataAll(
      `SELECT c.website_customer_id, c.name, c.phone, c.email, c.total_spent, c.stage,
              (SELECT MAX(o.purchase_date) FROM website_orders o
               WHERE o.website_customer_id = c.website_customer_id) AS purchase_date
       FROM website_customers c
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ? OFFSET ?`,
      [...params, currentPageSize, (currentPage - 1) * currentPageSize]
    );
  }

  const productsByCustomer = new Map();
  if (rows.length) {
    const ids = rows.map((row) => row.website_customer_id);
    const placeholders = ids.map(() => "?").join(",");
    const products = await websiteDataAll(
      `SELECT website_customer_id, product_key, product_name, source_kind
       FROM website_customer_products
       WHERE website_customer_id IN (${placeholders})
       ORDER BY product_key`,
      ids
    );
    for (const product of products) {
      if (!productsByCustomer.has(product.website_customer_id)) {
        productsByCustomer.set(product.website_customer_id, []);
      }
      productsByCustomer.get(product.website_customer_id).push(product);
    }
  }

  const [productOptions, stageOptions] = await Promise.all([
    websiteDataAll(
      `SELECT product_key, MIN(product_name) AS product_name
       FROM website_customer_products GROUP BY product_key ORDER BY product_key`
    ),
    websiteDataAll(
      `SELECT DISTINCT stage FROM website_customers
       WHERE is_stub = 0 AND stage IS NOT NULL AND stage <> '' ORDER BY stage`
    ),
  ]);
  return {
    items: rows.map((row) => ({ ...row, products: productsByCustomer.get(row.website_customer_id) || [] })),
    page: currentPage,
    pageSize: currentPageSize,
    total,
    totalPages,
    capabilities: { purchaseDateFilter: hasPurchaseDates },
    filters: { products: productOptions, stages: stageOptions.map((item) => item.stage) },
  };
}

export async function getWebsiteCustomerDetail(websiteCustomerId) {
  const id = String(websiteCustomerId || "").trim();
  if (!id) return null;
  const customer = await websiteDataGet(
    `SELECT website_customer_id, name, phone, email, total_spent, stage,
            source_updated_at, local_updated_at
     FROM website_customers WHERE website_customer_id = ? AND is_stub = 0`,
    [id]
  );
  if (!customer) return null;
  const [products, orders, emailMessage] = await Promise.all([
    websiteDataAll(
      `SELECT product_key, product_name, source_kind, source_updated_at
       FROM website_customer_products WHERE website_customer_id = ? ORDER BY product_key`,
      [id]
    ),
    websiteDataAll(
      `SELECT order_id, product_id, product_name, purchase_date, amount, currency,
              payment_status, order_status, source_updated_at
       FROM website_orders WHERE website_customer_id = ?
       ORDER BY purchase_date DESC, order_id DESC`,
      [id]
    ),
    websiteDataGet(
      `SELECT provider, email_type, template_key, status, sent_at, delivered_at,
              failed_at, bounced_at, failure_code
       FROM website_email_messages WHERE website_customer_id = ?
       ORDER BY source_updated_at DESC, local_updated_at DESC, provider_message_id DESC LIMIT 1`,
      [id]
    ),
  ]);
  return {
    customer,
    products,
    orders,
    emailTracking: emailMessage
      ? { hasData: true, status: emailMessage.status, message: emailMessage }
      : { hasData: false, status: "not_tracked", message: null },
  };
}

function parseDetail(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function getWebsiteSyncStatus({ mutexHeld = false } = {}) {
  const [latest, total] = await Promise.all([
    websiteDataGet("SELECT * FROM website_sync_runs ORDER BY id DESC LIMIT 1"),
    websiteDataGet("SELECT COUNT(*) AS total FROM website_customers WHERE is_stub = 0"),
  ]);
  if (!latest) {
    return { status: "NEVER_RUN", run: null, total_customers: Number(total?.total || 0) };
  }
  let status = String(latest.status || "").toUpperCase();
  if (status === "RUNNING" && !mutexHeld) status = "INTERRUPTED";
  return {
    status,
    run: { ...latest, detail: parseDetail(latest.detail_json), detail_json: undefined },
    total_customers: Number(total?.total || 0),
  };
}

export const WEBSITE_DATA_PAGE_SIZES = Object.freeze([25, 50, 100]);
