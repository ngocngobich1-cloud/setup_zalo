/**
 * Additive persistence foundation for Website-owned customer data.
 *
 * IMPORTANT TIMESTAMP CONVENTION:
 * Every *_at column created here stores UNIX epoch MILLISECONDS. Existing
 * repository tables (activity_logs, users, zoho_config, lich_hen, ...) use
 * epoch seconds. Values from the two groups must not be compared or joined
 * without an explicit unit conversion.
 */
export async function migrateData01WebsiteStore({ run }) {
  let transactionOpen = false;
  try {
    await run("BEGIN IMMEDIATE");
    transactionOpen = true;

    await run(`
      CREATE TABLE IF NOT EXISTS website_customers (
        -- CẢNH BÁO: các cột *_at trong bảng website_* dùng EPOCH MILLISECONDS.
        -- Bảng cũ của repo (activity_logs, users, zoho_config, lich_hen...)
        -- dùng EPOCH GIÂY. Không so sánh/join trực tiếp giữa hai nhóm.
        website_customer_id TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT,
        email TEXT,
        phone_normalized TEXT,
        email_normalized TEXT,
        total_spent INTEGER,
        stage TEXT,
        source_updated_at INTEGER,
        local_updated_at INTEGER NOT NULL,
        is_stub INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER
      )
    `);
    await run("CREATE INDEX IF NOT EXISTS idx_wc_email_normalized ON website_customers(email_normalized)");
    await run("CREATE INDEX IF NOT EXISTS idx_wc_phone_normalized ON website_customers(phone_normalized)");
    await run("CREATE INDEX IF NOT EXISTS idx_wc_source_updated_at ON website_customers(source_updated_at)");

    await run(`
      CREATE TABLE IF NOT EXISTS website_orders (
        -- *_at columns in website_* tables are UNIX epoch MILLISECONDS.
        order_id TEXT PRIMARY KEY,
        website_customer_id TEXT NOT NULL,
        product_id TEXT,
        product_name TEXT,
        purchase_date INTEGER,
        amount INTEGER,
        currency TEXT,
        payment_status TEXT,
        order_status TEXT,
        source_updated_at INTEGER NOT NULL,
        local_updated_at INTEGER NOT NULL,
        FOREIGN KEY (website_customer_id) REFERENCES website_customers(website_customer_id)
      )
    `);
    await run("CREATE INDEX IF NOT EXISTS idx_wo_customer ON website_orders(website_customer_id)");
    await run("CREATE INDEX IF NOT EXISTS idx_wo_source_updated_at ON website_orders(source_updated_at)");

    await run(`
      CREATE TABLE IF NOT EXISTS website_customer_products (
        -- *_at columns in website_* tables are UNIX epoch MILLISECONDS.
        website_customer_id TEXT NOT NULL,
        product_key TEXT NOT NULL,
        product_name TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('snapshot', 'order')),
        source_updated_at INTEGER NOT NULL,
        local_updated_at INTEGER NOT NULL,
        PRIMARY KEY (website_customer_id, product_key),
        FOREIGN KEY (website_customer_id) REFERENCES website_customers(website_customer_id)
      )
    `);
    await run("CREATE INDEX IF NOT EXISTS idx_wcp_customer ON website_customer_products(website_customer_id)");

    await run(`
      CREATE TABLE IF NOT EXISTS website_email_messages (
        -- *_at columns in website_* tables are UNIX epoch MILLISECONDS.
        provider_message_id TEXT PRIMARY KEY,
        website_customer_id TEXT,
        provider TEXT,
        recipient TEXT,
        recipient_normalized TEXT,
        email_type TEXT,
        template_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'bounced')),
        sent_at INTEGER,
        delivered_at INTEGER,
        failed_at INTEGER,
        bounced_at INTEGER,
        failure_code TEXT,
        source_updated_at INTEGER NOT NULL,
        local_updated_at INTEGER NOT NULL,
        FOREIGN KEY (website_customer_id) REFERENCES website_customers(website_customer_id)
      )
    `);
    await run("CREATE INDEX IF NOT EXISTS idx_wem_recipient_normalized ON website_email_messages(recipient_normalized)");
    await run("CREATE INDEX IF NOT EXISTS idx_wem_customer ON website_email_messages(website_customer_id)");
    await run("CREATE INDEX IF NOT EXISTS idx_wem_status ON website_email_messages(status)");

    await run(`
      CREATE TABLE IF NOT EXISTS website_ingest_events (
        -- *_at columns in website_* tables are UNIX epoch MILLISECONDS.
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        entity_id TEXT,
        received_at INTEGER NOT NULL,
        occurred_at INTEGER,
        source_updated_at INTEGER,
        outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'stale_ignored', 'rejected')),
        payload_hash TEXT,
        error_code TEXT
      )
    `);
    await run("CREATE INDEX IF NOT EXISTS idx_wie_received_at ON website_ingest_events(received_at)");

    await run(`
      CREATE TABLE IF NOT EXISTS website_sync_runs (
        -- *_at columns in website_* tables are UNIX epoch MILLISECONDS.
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        source_kind TEXT,
        received_count INTEGER NOT NULL DEFAULT 0,
        applied_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        detail_json TEXT
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS zalo_customer_bindings (
        -- *_at columns in this Slice 1 table are UNIX epoch MILLISECONDS.
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_uid TEXT NOT NULL,
        zalo_uid TEXT NOT NULL,
        website_customer_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'verified', 'revoked', 'conflict')),
        matched_on TEXT,
        bound_at INTEGER,
        last_verified_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (website_customer_id) REFERENCES website_customers(website_customer_id)
      )
    `);
    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_zcb_one_active
      ON zalo_customer_bindings(owner_uid, zalo_uid)
      WHERE state IN ('claimed', 'verified')
    `);
    await run("CREATE INDEX IF NOT EXISTS idx_zcb_customer ON zalo_customer_bindings(website_customer_id)");

    await run("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await run("ROLLBACK").catch(() => {});
    throw error;
  }
}
