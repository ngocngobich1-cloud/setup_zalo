import {
  websiteDataAll,
  websiteDataGet,
  websiteDataRun,
  withWebsiteDataTransaction,
} from "./db.js";

const ACTIVE_BINDING_STATES = new Set(["claimed", "verified"]);
const BINDING_STATES = new Set(["claimed", "verified", "revoked", "conflict"]);
const EVENT_OUTCOMES = new Set(["applied", "stale_ignored", "rejected"]);
const PRODUCT_SOURCE_KINDS = new Set(["snapshot", "order"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readField(value, snakeName, camelName = null) {
  if (hasOwn(value, snakeName)) return value[snakeName];
  if (camelName && hasOwn(value, camelName)) return value[camelName];
  return undefined;
}

function requiredId(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function nullableText(value) {
  return value === null || value === undefined ? null : String(value);
}

function nullableInteger(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer or null`);
  return value;
}

/** Convert an accepted source timestamp to canonical UNIX epoch milliseconds. */
export function toEpochMilliseconds(value, label = "timestamp") {
  let date;
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value);
  } else if (typeof value === "string" && ISO_TIMESTAMP.test(value.trim())) {
    const source = value.trim();
    const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(source);
    date = new Date(hasZone ? source : `${source}Z`);
  } else {
    throw new Error(`${label} must be an ISO-8601 timestamp or epoch milliseconds`);
  }
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid`);
  return milliseconds;
}

function optionalTimestamp(value, label) {
  return value === null || value === undefined ? null : toEpochMilliseconds(value, label);
}

export function normalizeEmail(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}

export function normalizePhone(value) {
  if (value === null || value === undefined) return null;
  let normalized = String(value).trim().replace(/[\s().-]/g, "");
  if (normalized.startsWith("+")) normalized = normalized.slice(1);
  if (/^0\d{9}$/.test(normalized)) return `84${normalized.slice(1)}`;
  if (/^84\d{9}$/.test(normalized)) return normalized;
  return null;
}

export function normalizeProductKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ");
}

export function deriveEmailStatus({ sentAt, deliveredAt, failedAt, bouncedAt }) {
  if (bouncedAt !== null && bouncedAt !== undefined) return "bounced";
  if (failedAt !== null && failedAt !== undefined) return "failed";
  if (deliveredAt !== null && deliveredAt !== undefined) return "delivered";
  if (sentAt !== null && sentAt !== undefined) return "sent";
  return "pending";
}

function sourceTimestamp(snapshot) {
  return toEpochMilliseconds(
    readField(snapshot, "source_updated_at", "sourceUpdatedAt"),
    "source_updated_at"
  );
}

async function ensureCustomerStubInTransaction({ run }, websiteCustomerId, now) {
  await run(
    `INSERT INTO website_customers (website_customer_id, is_stub, local_updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(website_customer_id) DO NOTHING`,
    [websiteCustomerId, now]
  );
}

export async function ensureCustomerStub(websiteCustomerId) {
  const id = requiredId(websiteCustomerId, "website_customer_id");
  await withWebsiteDataTransaction((database) =>
    ensureCustomerStubInTransaction(database, id, Date.now())
  );
  return getWebsiteCustomer(id);
}

export async function getWebsiteCustomer(websiteCustomerId) {
  const id = requiredId(websiteCustomerId, "website_customer_id");
  return websiteDataGet(
    "SELECT * FROM website_customers WHERE website_customer_id = ?",
    [id]
  );
}

export async function upsertWebsiteCustomer(snapshot) {
  const websiteCustomerId = requiredId(
    readField(snapshot, "website_customer_id", "websiteCustomerId"),
    "website_customer_id"
  );
  const incomingSourceUpdatedAt = sourceTimestamp(snapshot);
  const email = nullableText(readField(snapshot, "email"));
  const phone = nullableText(readField(snapshot, "phone"));
  const normalized = {
    website_customer_id: websiteCustomerId,
    name: nullableText(readField(snapshot, "name")),
    phone,
    email,
    phone_normalized: normalizePhone(phone),
    email_normalized: normalizeEmail(email),
    total_spent: nullableInteger(readField(snapshot, "total_spent", "totalSpent"), "total_spent"),
    stage: nullableText(readField(snapshot, "stage")),
    source_updated_at: incomingSourceUpdatedAt,
    archived_at: optionalTimestamp(readField(snapshot, "archived_at", "archivedAt"), "archived_at"),
  };

  return withWebsiteDataTransaction(async ({ run, get }) => {
    const stored = await get(
      "SELECT * FROM website_customers WHERE website_customer_id = ?",
      [websiteCustomerId]
    );
    if (stored?.source_updated_at !== null
        && stored?.source_updated_at !== undefined
        && incomingSourceUpdatedAt < stored.source_updated_at) {
      return { applied: false, stale: true, customer: stored };
    }

    const localUpdatedAt = Date.now();
    await run(
      `INSERT INTO website_customers
         (website_customer_id, name, phone, email, phone_normalized, email_normalized,
          total_spent, stage, source_updated_at, local_updated_at, is_stub, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(website_customer_id) DO UPDATE SET
         name = excluded.name,
         phone = excluded.phone,
         email = excluded.email,
         phone_normalized = excluded.phone_normalized,
         email_normalized = excluded.email_normalized,
         total_spent = excluded.total_spent,
         stage = excluded.stage,
         source_updated_at = excluded.source_updated_at,
         local_updated_at = excluded.local_updated_at,
         is_stub = 0,
         archived_at = excluded.archived_at`,
      [
        normalized.website_customer_id,
        normalized.name,
        normalized.phone,
        normalized.email,
        normalized.phone_normalized,
        normalized.email_normalized,
        normalized.total_spent,
        normalized.stage,
        normalized.source_updated_at,
        localUpdatedAt,
        normalized.archived_at,
      ]
    );
    return {
      applied: true,
      stale: false,
      customer: await get("SELECT * FROM website_customers WHERE website_customer_id = ?", [websiteCustomerId]),
    };
  });
}

export async function upsertWebsiteOrder(snapshot) {
  const orderId = requiredId(readField(snapshot, "order_id", "orderId"), "order_id");
  const websiteCustomerId = requiredId(
    readField(snapshot, "website_customer_id", "websiteCustomerId"),
    "website_customer_id"
  );
  const incomingSourceUpdatedAt = sourceTimestamp(snapshot);
  const normalized = {
    order_id: orderId,
    website_customer_id: websiteCustomerId,
    product_id: nullableText(readField(snapshot, "product_id", "productId")),
    product_name: nullableText(readField(snapshot, "product_name", "productName")),
    purchase_date: optionalTimestamp(readField(snapshot, "purchase_date", "purchaseDate"), "purchase_date"),
    amount: nullableInteger(readField(snapshot, "amount"), "amount"),
    currency: nullableText(readField(snapshot, "currency")),
    payment_status: nullableText(readField(snapshot, "payment_status", "paymentStatus")),
    order_status: nullableText(readField(snapshot, "order_status", "orderStatus")),
    source_updated_at: incomingSourceUpdatedAt,
  };

  return withWebsiteDataTransaction(async (database) => {
    const localUpdatedAt = Date.now();
    await ensureCustomerStubInTransaction(database, websiteCustomerId, localUpdatedAt);
    const stored = await database.get("SELECT * FROM website_orders WHERE order_id = ?", [orderId]);
    if (stored && incomingSourceUpdatedAt < stored.source_updated_at) {
      return { applied: false, stale: true, order: stored };
    }
    await database.run(
      `INSERT INTO website_orders
         (order_id, website_customer_id, product_id, product_name, purchase_date, amount,
          currency, payment_status, order_status, source_updated_at, local_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         website_customer_id = excluded.website_customer_id,
         product_id = excluded.product_id,
         product_name = excluded.product_name,
         purchase_date = excluded.purchase_date,
         amount = excluded.amount,
         currency = excluded.currency,
         payment_status = excluded.payment_status,
         order_status = excluded.order_status,
         source_updated_at = excluded.source_updated_at,
         local_updated_at = excluded.local_updated_at`,
      [
        normalized.order_id,
        normalized.website_customer_id,
        normalized.product_id,
        normalized.product_name,
        normalized.purchase_date,
        normalized.amount,
        normalized.currency,
        normalized.payment_status,
        normalized.order_status,
        normalized.source_updated_at,
        localUpdatedAt,
      ]
    );
    return {
      applied: true,
      stale: false,
      order: await database.get("SELECT * FROM website_orders WHERE order_id = ?", [orderId]),
    };
  });
}

export async function listCustomerOrders(websiteCustomerId) {
  const id = requiredId(websiteCustomerId, "website_customer_id");
  return websiteDataAll(
    "SELECT * FROM website_orders WHERE website_customer_id = ? ORDER BY purchase_date, order_id",
    [id]
  );
}

export async function upsertCustomerProduct(snapshot) {
  const websiteCustomerId = requiredId(
    readField(snapshot, "website_customer_id", "websiteCustomerId"),
    "website_customer_id"
  );
  const productNameValue = readField(snapshot, "product_name", "productName");
  if (productNameValue === null || productNameValue === undefined) {
    throw new Error("product_name is required");
  }
  const productName = String(productNameValue);
  const productKey = normalizeProductKey(productName);
  if (!productKey) throw new Error("product_name must produce a non-empty product_key");
  const sourceKind = String(readField(snapshot, "source_kind", "sourceKind") ?? "").trim();
  if (!PRODUCT_SOURCE_KINDS.has(sourceKind)) throw new Error("source_kind must be snapshot or order");
  const incomingSourceUpdatedAt = sourceTimestamp(snapshot);

  return withWebsiteDataTransaction(async (database) => {
    const localUpdatedAt = Date.now();
    await ensureCustomerStubInTransaction(database, websiteCustomerId, localUpdatedAt);
    const stored = await database.get(
      `SELECT * FROM website_customer_products
       WHERE website_customer_id = ? AND product_key = ?`,
      [websiteCustomerId, productKey]
    );
    if (stored && incomingSourceUpdatedAt < stored.source_updated_at) {
      return { applied: false, stale: true, product: stored };
    }
    const effectiveSourceKind = stored?.source_kind === "order" ? "order" : sourceKind;
    await database.run(
      `INSERT INTO website_customer_products
         (website_customer_id, product_key, product_name, source_kind, source_updated_at, local_updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(website_customer_id, product_key) DO UPDATE SET
         product_name = excluded.product_name,
         source_kind = excluded.source_kind,
         source_updated_at = excluded.source_updated_at,
         local_updated_at = excluded.local_updated_at`,
      [websiteCustomerId, productKey, productName, effectiveSourceKind, incomingSourceUpdatedAt, localUpdatedAt]
    );
    return {
      applied: true,
      stale: false,
      product: await database.get(
        `SELECT * FROM website_customer_products
         WHERE website_customer_id = ? AND product_key = ?`,
        [websiteCustomerId, productKey]
      ),
    };
  });
}

export async function listCustomerProducts(websiteCustomerId) {
  const id = requiredId(websiteCustomerId, "website_customer_id");
  return websiteDataAll(
    "SELECT * FROM website_customer_products WHERE website_customer_id = ? ORDER BY product_key",
    [id]
  );
}

function earliestFact(stored, incoming) {
  if (incoming === null) return stored ?? null;
  if (stored === null || stored === undefined) return incoming;
  return Math.min(stored, incoming);
}

export async function upsertWebsiteEmailMessage(snapshot) {
  const providerMessageId = requiredId(
    readField(snapshot, "provider_message_id", "providerMessageId"),
    "provider_message_id"
  );
  const incomingSourceUpdatedAt = sourceTimestamp(snapshot);
  const customerValue = readField(snapshot, "website_customer_id", "websiteCustomerId");
  const websiteCustomerId = customerValue === null || customerValue === undefined
    ? null
    : requiredId(customerValue, "website_customer_id");
  const recipient = nullableText(readField(snapshot, "recipient"));
  const facts = {
    sent_at: optionalTimestamp(readField(snapshot, "sent_at", "sentAt"), "sent_at"),
    delivered_at: optionalTimestamp(readField(snapshot, "delivered_at", "deliveredAt"), "delivered_at"),
    failed_at: optionalTimestamp(readField(snapshot, "failed_at", "failedAt"), "failed_at"),
    bounced_at: optionalTimestamp(readField(snapshot, "bounced_at", "bouncedAt"), "bounced_at"),
  };
  const normalized = {
    provider_message_id: providerMessageId,
    website_customer_id: websiteCustomerId,
    provider: nullableText(readField(snapshot, "provider")),
    recipient,
    recipient_normalized: normalizeEmail(recipient),
    email_type: nullableText(readField(snapshot, "email_type", "emailType")),
    template_key: nullableText(readField(snapshot, "template_key", "templateKey")),
    failure_code: nullableText(readField(snapshot, "failure_code", "failureCode")),
    source_updated_at: incomingSourceUpdatedAt,
  };

  return withWebsiteDataTransaction(async (database) => {
    const localUpdatedAt = Date.now();
    if (websiteCustomerId) {
      await ensureCustomerStubInTransaction(database, websiteCustomerId, localUpdatedAt);
    }
    const stored = await database.get(
      "SELECT * FROM website_email_messages WHERE provider_message_id = ?",
      [providerMessageId]
    );
    if (stored && incomingSourceUpdatedAt < stored.source_updated_at) {
      return { applied: false, stale: true, message: stored };
    }
    const mergedFacts = {
      sent_at: earliestFact(stored?.sent_at, facts.sent_at),
      delivered_at: earliestFact(stored?.delivered_at, facts.delivered_at),
      failed_at: earliestFact(stored?.failed_at, facts.failed_at),
      bounced_at: earliestFact(stored?.bounced_at, facts.bounced_at),
    };
    const status = deriveEmailStatus({
      sentAt: mergedFacts.sent_at,
      deliveredAt: mergedFacts.delivered_at,
      failedAt: mergedFacts.failed_at,
      bouncedAt: mergedFacts.bounced_at,
    });
    await database.run(
      `INSERT INTO website_email_messages
         (provider_message_id, website_customer_id, provider, recipient, recipient_normalized,
          email_type, template_key, status, sent_at, delivered_at, failed_at, bounced_at,
          failure_code, source_updated_at, local_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_message_id) DO UPDATE SET
         website_customer_id = excluded.website_customer_id,
         provider = excluded.provider,
         recipient = excluded.recipient,
         recipient_normalized = excluded.recipient_normalized,
         email_type = excluded.email_type,
         template_key = excluded.template_key,
         status = excluded.status,
         sent_at = excluded.sent_at,
         delivered_at = excluded.delivered_at,
         failed_at = excluded.failed_at,
         bounced_at = excluded.bounced_at,
         failure_code = excluded.failure_code,
         source_updated_at = excluded.source_updated_at,
         local_updated_at = excluded.local_updated_at`,
      [
        normalized.provider_message_id,
        normalized.website_customer_id,
        normalized.provider,
        normalized.recipient,
        normalized.recipient_normalized,
        normalized.email_type,
        normalized.template_key,
        status,
        mergedFacts.sent_at,
        mergedFacts.delivered_at,
        mergedFacts.failed_at,
        mergedFacts.bounced_at,
        normalized.failure_code,
        normalized.source_updated_at,
        localUpdatedAt,
      ]
    );
    return {
      applied: true,
      stale: false,
      message: await database.get(
        "SELECT * FROM website_email_messages WHERE provider_message_id = ?",
        [providerMessageId]
      ),
    };
  });
}

export async function getWebsiteEmailMessage(providerMessageId) {
  const id = requiredId(providerMessageId, "provider_message_id");
  return websiteDataGet(
    "SELECT * FROM website_email_messages WHERE provider_message_id = ?",
    [id]
  );
}

export async function getLatestCustomerEmailStatus(websiteCustomerId) {
  const id = requiredId(websiteCustomerId, "website_customer_id");
  const message = await websiteDataGet(
    `SELECT * FROM website_email_messages
     WHERE website_customer_id = ?
     ORDER BY source_updated_at DESC, local_updated_at DESC, provider_message_id DESC
     LIMIT 1`,
    [id]
  );
  return message ? { status: message.status, message } : { status: "unknown", message: null };
}

export async function recordIngestEvent({
  event_id,
  event_type,
  entity_id,
  received_at,
  occurred_at,
  source_updated_at,
  outcome,
  payload_hash,
  error_code,
}) {
  const eventId = requiredId(event_id, "event_id");
  const eventType = requiredId(event_type, "event_type");
  if (!EVENT_OUTCOMES.has(outcome)) throw new Error("outcome is invalid");
  const event = {
    event_id: eventId,
    event_type: eventType,
    entity_id: nullableText(entity_id),
    received_at: received_at === null || received_at === undefined
      ? Date.now()
      : toEpochMilliseconds(received_at, "received_at"),
    occurred_at: optionalTimestamp(occurred_at, "occurred_at"),
    source_updated_at: optionalTimestamp(source_updated_at, "source_updated_at"),
    outcome,
    payload_hash: nullableText(payload_hash),
    error_code: nullableText(error_code),
  };
  return withWebsiteDataTransaction(async ({ run, get }) => {
    const stored = await get("SELECT * FROM website_ingest_events WHERE event_id = ?", [eventId]);
    if (stored) return { duplicate: true, outcome: stored.outcome, event: stored };
    await run(
      `INSERT INTO website_ingest_events
         (event_id, event_type, entity_id, received_at, occurred_at, source_updated_at,
          outcome, payload_hash, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.event_id,
        event.event_type,
        event.entity_id,
        event.received_at,
        event.occurred_at,
        event.source_updated_at,
        event.outcome,
        event.payload_hash,
        event.error_code,
      ]
    );
    const inserted = await get("SELECT * FROM website_ingest_events WHERE event_id = ?", [eventId]);
    return { duplicate: false, outcome: inserted.outcome, event: inserted };
  });
}

export async function getIngestEvent(eventId) {
  const id = requiredId(eventId, "event_id");
  return websiteDataGet("SELECT * FROM website_ingest_events WHERE event_id = ?", [id]);
}

export async function beginSyncRun({
  started_at = Date.now(),
  status = "running",
  source_kind = null,
  received_count = 0,
  applied_count = 0,
  skipped_count = 0,
  error_code = null,
  detail = null,
} = {}) {
  const result = await websiteDataRun(
    `INSERT INTO website_sync_runs
       (started_at, finished_at, status, source_kind, received_count, applied_count,
        skipped_count, error_code, detail_json)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toEpochMilliseconds(started_at, "started_at"),
      requiredId(status, "status"),
      nullableText(source_kind),
      nullableInteger(received_count, "received_count") ?? 0,
      nullableInteger(applied_count, "applied_count") ?? 0,
      nullableInteger(skipped_count, "skipped_count") ?? 0,
      nullableText(error_code),
      detail === null || detail === undefined ? null : JSON.stringify(detail),
    ]
  );
  return websiteDataGet("SELECT * FROM website_sync_runs WHERE id = ?", [result.lastID]);
}

export async function finishSyncRun(id, {
  finished_at = Date.now(),
  status,
  received_count = 0,
  applied_count = 0,
  skipped_count = 0,
  error_code = null,
  detail = null,
}) {
  const runId = Number(id);
  if (!Number.isInteger(runId) || runId <= 0) throw new Error("sync run id is invalid");
  await websiteDataRun(
    `UPDATE website_sync_runs
     SET finished_at = ?, status = ?, received_count = ?, applied_count = ?,
         skipped_count = ?, error_code = ?, detail_json = ?
     WHERE id = ?`,
    [
      toEpochMilliseconds(finished_at, "finished_at"),
      requiredId(status, "status"),
      nullableInteger(received_count, "received_count") ?? 0,
      nullableInteger(applied_count, "applied_count") ?? 0,
      nullableInteger(skipped_count, "skipped_count") ?? 0,
      nullableText(error_code),
      detail === null || detail === undefined ? null : JSON.stringify(detail),
      runId,
    ]
  );
  return websiteDataGet("SELECT * FROM website_sync_runs WHERE id = ?", [runId]);
}

export async function createOrUpdateBinding(snapshot) {
  const ownerUid = requiredId(readField(snapshot, "owner_uid", "ownerUid"), "owner_uid");
  const zaloUid = requiredId(readField(snapshot, "zalo_uid", "zaloUid"), "zalo_uid");
  const websiteCustomerId = requiredId(
    readField(snapshot, "website_customer_id", "websiteCustomerId"),
    "website_customer_id"
  );
  const state = String(readField(snapshot, "state") ?? "").trim();
  if (!BINDING_STATES.has(state)) throw new Error("binding state is invalid");
  const normalized = {
    matched_on: nullableText(readField(snapshot, "matched_on", "matchedOn")),
    bound_at: optionalTimestamp(readField(snapshot, "bound_at", "boundAt"), "bound_at"),
    last_verified_at: optionalTimestamp(
      readField(snapshot, "last_verified_at", "lastVerifiedAt"),
      "last_verified_at"
    ),
  };

  return withWebsiteDataTransaction(async (database) => {
    const now = Date.now();
    await ensureCustomerStubInTransaction(database, websiteCustomerId, now);
    const active = await database.get(
      `SELECT * FROM zalo_customer_bindings
       WHERE owner_uid = ? AND zalo_uid = ? AND state IN ('claimed', 'verified')`,
      [ownerUid, zaloUid]
    );

    if (active) {
      await database.run(
        `UPDATE zalo_customer_bindings
         SET website_customer_id = ?, state = ?, matched_on = ?, bound_at = ?,
             last_verified_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          websiteCustomerId,
          state,
          normalized.matched_on,
          normalized.bound_at,
          normalized.last_verified_at,
          now,
          active.id,
        ]
      );
      return database.get("SELECT * FROM zalo_customer_bindings WHERE id = ?", [active.id]);
    }

    const result = await database.run(
      `INSERT INTO zalo_customer_bindings
         (owner_uid, zalo_uid, website_customer_id, state, matched_on, bound_at,
          last_verified_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ownerUid,
        zaloUid,
        websiteCustomerId,
        state,
        normalized.matched_on,
        normalized.bound_at,
        normalized.last_verified_at,
        now,
      ]
    );
    return database.get("SELECT * FROM zalo_customer_bindings WHERE id = ?", [result.lastID]);
  });
}

export async function getActiveBinding(ownerUid, zaloUid) {
  const owner = requiredId(ownerUid, "owner_uid");
  const zalo = requiredId(zaloUid, "zalo_uid");
  return websiteDataGet(
    `SELECT * FROM zalo_customer_bindings
     WHERE owner_uid = ? AND zalo_uid = ? AND state IN ('claimed', 'verified')`,
    [owner, zalo]
  );
}

/**
 * Atomically promote one unambiguous legacy phone identity to an email key.
 * All promotion preconditions are checked after BEGIN IMMEDIATE and every
 * mutation uses the transaction's raw SQL helpers, avoiding nested writes.
 */
export async function promoteCustomerKey({ newCustomerId, phoneNormalized }) {
  const destinationId = requiredId(newCustomerId, "newCustomerId");
  const expectedPhone = requiredId(phoneNormalized, "phoneNormalized");
  if (!destinationId.startsWith("legacy_email:")) {
    throw new Error("newCustomerId must be a legacy_email key");
  }

  return withWebsiteDataTransaction(async ({ run, all, get }) => {
    const destination = await get(
      "SELECT website_customer_id FROM website_customers WHERE website_customer_id = ?",
      [destinationId]
    );
    if (destination) return { promoted: false, reason: "DESTINATION_EXISTS" };

    const candidates = await all(
      `SELECT website_customer_id
       FROM website_customers
       WHERE website_customer_id LIKE 'legacy_phone:%'
         AND phone_normalized = ?
         AND email_normalized IS NULL
       ORDER BY website_customer_id`,
      [expectedPhone]
    );
    if (candidates.length !== 1) {
      return { promoted: false, reason: candidates.length ? "AMBIGUOUS_PHONE" : "SOURCE_NOT_FOUND" };
    }

    const oldCustomerId = candidates[0].website_customer_id;
    const source = await get(
      `SELECT * FROM website_customers
       WHERE website_customer_id = ?
         AND website_customer_id LIKE 'legacy_phone:%'
         AND phone_normalized = ?
         AND email_normalized IS NULL`,
      [oldCustomerId, expectedPhone]
    );
    if (!source) return { promoted: false, reason: "SOURCE_CHANGED" };

    // Re-check destination immediately before the first mutation as well.
    if (await get(
      "SELECT website_customer_id FROM website_customers WHERE website_customer_id = ?",
      [destinationId]
    )) {
      return { promoted: false, reason: "DESTINATION_EXISTS" };
    }

    await run(
      `INSERT INTO website_customers
         (website_customer_id, name, phone, email, phone_normalized, email_normalized,
          total_spent, stage, source_updated_at, local_updated_at, is_stub, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        destinationId, source.name, source.phone, source.email, source.phone_normalized,
        source.email_normalized, source.total_spent, source.stage, source.source_updated_at,
        source.local_updated_at, source.is_stub, source.archived_at,
      ]
    );

    for (const table of [
      "website_customer_products",
      "website_orders",
      "website_email_messages",
      "zalo_customer_bindings",
    ]) {
      await run(
        `UPDATE ${table} SET website_customer_id = ? WHERE website_customer_id = ?`,
        [destinationId, oldCustomerId]
      );
    }
    await run("DELETE FROM website_customers WHERE website_customer_id = ?", [oldCustomerId]);
    return { promoted: true, oldCustomerId, newCustomerId: destinationId };
  });
}

export { ACTIVE_BINDING_STATES };
