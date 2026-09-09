import {
  beginSyncRun,
  finishSyncRun,
  promoteCustomerKey,
  upsertCustomerProduct,
  upsertWebsiteCustomer,
  upsertWebsiteOrder,
} from "./website-data.js";
import { deriveWebsiteCustomerKey } from "./website-identity.js";
import { fetchWebsiteCustomersRaw } from "./website.js";

const CUSTOMER_SKIP_REASONS = new Set([
  "NO_IDENTITY",
  "INVALID_ROW",
  "STALE_IGNORED",
  "DUPLICATE_IN_BATCH",
]);

let syncMutexHeld = false;

export class WebsiteSyncConflictError extends Error {
  constructor() {
    super("Một lượt đồng bộ Website khác đang chạy.");
    this.name = "WebsiteSyncConflictError";
    this.code = "SYNC_ALREADY_RUNNING";
  }
}

export function isWebsiteSyncRunning() {
  return syncMutexHeld;
}

export function normalizeTotalSpent(value) {
  if (value === null || value === undefined) return { value: null, invalid: false };
  if (typeof value === "number") {
    const valid = Number.isFinite(value) && Number.isInteger(value) && value >= 0;
    return { value: valid ? value : null, invalid: !valid };
  }
  if (typeof value !== "string") return { value: null, invalid: true };
  const trimmed = value.trim();
  if (!trimmed) return { value: null, invalid: false };
  const digits = trimmed.replace(/[.,\s]/g, "");
  if (!/^\d+$/.test(digits)) return { value: null, invalid: true };
  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed)
    ? { value: parsed, invalid: false }
    : { value: null, invalid: true };
}

function explicitTimezoneIso(value) {
  if (typeof value !== "string") return null;
  const source = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(source)) {
    return null;
  }
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function normalizeWebsiteOrder(order, { websiteCustomerId, sourceUpdatedAt } = {}) {
  if (!order || typeof order !== "object" || Array.isArray(order)) {
    return { accepted: false, reason: "ORDER_NO_ID" };
  }
  const orderId = String(order.order_id ?? "").trim();
  if (!orderId) return { accepted: false, reason: "ORDER_NO_ID" };
  const purchaseDate = order.purchase_date === null || order.purchase_date === undefined
    ? null
    : explicitTimezoneIso(order.purchase_date);
  if (order.purchase_date !== null && order.purchase_date !== undefined && purchaseDate === null) {
    return { accepted: false, reason: "ORDER_BAD_DATE" };
  }
  const amount = normalizeTotalSpent(order.amount);
  return {
    accepted: true,
    value: {
      order_id: orderId,
      website_customer_id: String(websiteCustomerId ?? order.website_customer_id ?? "").trim(),
      product_id: order.product_id ?? null,
      product_name: order.product_name ?? null,
      purchase_date: purchaseDate,
      amount: amount.value,
      currency: order.currency ?? null,
      payment_status: order.payment_status ?? null,
      order_status: order.order_status ?? null,
      source_updated_at: sourceUpdatedAt ?? Date.now(),
    },
  };
}

export async function persistWebsiteOrder(order, context = {}) {
  const normalized = normalizeWebsiteOrder(order, context);
  if (!normalized.accepted) return normalized;
  const result = await upsertWebsiteOrder(normalized.value);
  return { accepted: true, result };
}

function bump(histogram, reason, count = 1) {
  histogram[reason] = (histogram[reason] || 0) + count;
}

function normalizeRow(row, sourceUpdatedAt) {
  const identity = deriveWebsiteCustomerKey({ email: row.email, phone: row.phone });
  const totalSpent = normalizeTotalSpent(row.tong_da_chi);
  return {
    identity,
    totalSpent,
    customer: {
      website_customer_id: identity.customerKey,
      name: row.ten ?? null,
      phone: row.phone ?? null,
      email: identity.emailNormalized ? row.email : null,
      total_spent: totalSpent.value,
      stage: row.giai_doan ?? null,
      source_updated_at: sourceUpdatedAt,
    },
    products: Array.isArray(row.san_pham_da_mua) ? row.san_pham_da_mua : [],
  };
}

export async function reconcileWebsiteSnapshot(payload, syncStartedAt = Date.now(), orderBatch = []) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.customers)) {
    const error = new Error("Website snapshot không có mảng customers hợp lệ.");
    error.code = "INVALID_SNAPSHOT";
    throw error;
  }

  const received = payload.customers.length;
  const histogram = {};
  let skipped = 0;
  let saved = 0;
  let promotedFromPhoneKey = 0;
  const deduped = new Map();

  for (let index = 0; index < payload.customers.length; index++) {
    const row = payload.customers[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      skipped++;
      bump(histogram, "INVALID_ROW");
      continue;
    }
    const identity = deriveWebsiteCustomerKey({ email: row.email, phone: row.phone });
    if (!identity.customerKey) {
      skipped++;
      bump(histogram, "NO_IDENTITY");
      continue;
    }
    if (deduped.has(identity.customerKey)) {
      skipped++;
      bump(histogram, "DUPLICATE_IN_BATCH");
    }
    deduped.set(identity.customerKey, { row, index, identity });
  }

  const ordered = [...deduped.values()].sort((a, b) => {
    const aGroup = a.identity.identityKind === "phone" ? 0 : 1;
    const bGroup = b.identity.identityKind === "phone" ? 0 : 1;
    return aGroup - bGroup || a.index - b.index;
  });

  for (const item of ordered) {
    const normalized = normalizeRow(item.row, syncStartedAt);
    if (normalized.totalSpent.invalid) bump(histogram, "INVALID_TOTAL_SPENT");

    if (item.identity.identityKind === "email" && item.identity.phoneNormalized) {
      const promotion = await promoteCustomerKey({
        newCustomerId: item.identity.customerKey,
        phoneNormalized: item.identity.phoneNormalized,
      });
      if (promotion.promoted) promotedFromPhoneKey++;
    }

    const customerResult = await upsertWebsiteCustomer(normalized.customer);
    if (customerResult.stale) {
      skipped++;
      bump(histogram, "STALE_IGNORED");
      continue;
    }

    for (const product of normalized.products) {
      if (typeof product !== "string" || !product.trim()) continue;
      await upsertCustomerProduct({
        website_customer_id: item.identity.customerKey,
        product_name: product,
        source_kind: "snapshot",
        source_updated_at: syncStartedAt,
      });
    }
    saved++;
  }

  // Explicit order inputs exercise the deferred persistence foundation. The
  // Website customer bulk payload is never inspected for guessed order fields.
  for (const input of Array.isArray(orderBatch) ? orderBatch : []) {
    const normalizedOrder = normalizeWebsiteOrder(input?.order, {
      websiteCustomerId: input?.websiteCustomerId,
      sourceUpdatedAt: syncStartedAt,
    });
    if (!normalizedOrder.accepted) {
      bump(histogram, normalizedOrder.reason);
      continue;
    }
    await upsertWebsiteOrder(normalizedOrder.value);
  }

  const skippedFromReasons = [...CUSTOMER_SKIP_REASONS]
    .reduce((total, reason) => total + Number(histogram[reason] || 0), 0);
  if (received !== saved + skipped || skipped !== skippedFromReasons) {
    const error = new Error("Sync counter invariant failed.");
    error.code = "COUNTER_INVARIANT_FAILED";
    throw error;
  }
  return {
    received_count: received,
    applied_count: saved,
    saved,
    skipped_count: skipped,
    detail: {
      reasons: histogram,
      promoted_from_phone_key: promotedFromPhoneKey,
      order_sync_activation: "DEFERRED_NO_BULK_CONTRACT",
    },
  };
}

export async function syncWebsiteData() {
  if (syncMutexHeld) throw new WebsiteSyncConflictError();
  syncMutexHeld = true;
  let run = null;
  const startedAt = Date.now();
  try {
    run = await beginSyncRun({ started_at: startedAt, source_kind: "website_snapshot" });
    const payload = await fetchWebsiteCustomersRaw();
    const report = await reconcileWebsiteSnapshot(payload, startedAt);
    const finished = await finishSyncRun(run.id, {
      status: "completed",
      received_count: report.received_count,
      applied_count: report.applied_count,
      skipped_count: report.skipped_count,
      detail: report.detail,
    });
    return { ...report, run: finished };
  } catch (error) {
    if (run) {
      try {
        await finishSyncRun(run.id, {
          status: "failed",
          error_code: String(error?.ma || error?.code || "SYNC_FAILED").slice(0, 80),
          detail: { reasons: {}, message: "Đồng bộ Website thất bại." },
        });
      } catch {
        // The original failure remains authoritative; finally still releases the mutex.
      }
    }
    throw error;
  } finally {
    syncMutexHeld = false;
  }
}
