export const LEGACY_AI_OWNER_UID = "1483263118759934515";

const AI_PROFILE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_chat_config (
    owner_uid TEXT PRIMARY KEY,
    allowed_topics TEXT NOT NULL DEFAULT '',
    role_tone TEXT NOT NULL DEFAULT '',
    use_knowledge INTEGER NOT NULL DEFAULT 0,
    knowledge_file_ids TEXT NOT NULL DEFAULT '[]',
    soul TEXT NOT NULL DEFAULT '',
    opencode_model TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )
`;

const AI_RUNTIME_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_runtime_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    groq_api_key TEXT NOT NULL DEFAULT '',
    opencode_base_url TEXT NOT NULL DEFAULT 'http://opencode:4096',
    opencode_agent TEXT NOT NULL DEFAULT 'general',
    doc_tep INTEGER NOT NULL DEFAULT 0,
    legacy_allowed_group_id TEXT NOT NULL DEFAULT '',
    legacy_allowed_sender_ids TEXT NOT NULL DEFAULT '[]',
    legacy_bot_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )
`;

const TRAINING_SESSION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS training_session (
    owner_uid TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  )
`;

const TRAINING_MESSAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS training_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_uid TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    files TEXT,
    created_at INTEGER NOT NULL
  )
`;

function coCot(columns, name) {
  return columns.some((column) => column.name === name);
}

function cotHoac(columns, name, fallbackSql) {
  return coCot(columns, name) ? name : fallbackSql;
}

async function cotCua(all, table) {
  return all(`PRAGMA table_info(${table})`);
}

/** P9 migration giao dich cho AI profile va Training theo physical Zalo UID. */
export async function migrateP9ZaloUidProfile({ run, all, get }) {
  const aiColumns = await cotCua(all, "ai_chat_config");
  const sessionColumns = await cotCua(all, "training_session");
  const messageColumns = await cotCua(all, "training_messages");

  const aiLegacy = aiColumns.length > 0 && !coCot(aiColumns, "owner_uid");
  const sessionLegacy = sessionColumns.length > 0 && !coCot(sessionColumns, "owner_uid");
  const messageLegacy = messageColumns.length > 0 && !coCot(messageColumns, "owner_uid");

  if (sessionLegacy !== messageLegacy) {
    throw new Error("P9_STOP: training schema dang o trang thai chuyen doi do dang.");
  }

  // Stop condition duoc kiem tra truoc transaction: khong cham AI neu Training
  // legacy co du lieu ma chua chung minh duoc owner.
  if (sessionLegacy) {
    const session = await get("SELECT session_id FROM training_session WHERE id = 1");
    const messages = await get("SELECT COUNT(*) AS n FROM training_messages");
    if (String(session?.session_id || "").trim() || Number(messages?.n || 0) !== 0) {
      throw new Error("P9_STOP: legacy Training khong rong; khong duoc tu suy owner.");
    }
  }

  const result = { aiMigrated: false, trainingMigrated: false, legacyAiOwnerUid: null };
  await run("BEGIN IMMEDIATE");
  try {
    await run(AI_RUNTIME_SCHEMA);
    await run("INSERT OR IGNORE INTO ai_runtime_config (id) VALUES (1)");

    if (aiLegacy) {
      const field = (name, fallback) => cotHoac(aiColumns, name, fallback);
      await run(`
        UPDATE ai_runtime_config
        SET groq_api_key = (SELECT ${field("groq_api_key", "''")} FROM ai_chat_config WHERE id = 1),
            opencode_base_url = (SELECT ${field("opencode_base_url", "'http://opencode:4096'")} FROM ai_chat_config WHERE id = 1),
            opencode_agent = (SELECT ${field("opencode_agent", "'general'")} FROM ai_chat_config WHERE id = 1),
            doc_tep = (SELECT ${field("doc_tep", "0")} FROM ai_chat_config WHERE id = 1),
            legacy_allowed_group_id = (SELECT ${field("allowed_group_id", "''")} FROM ai_chat_config WHERE id = 1),
            legacy_allowed_sender_ids = (SELECT ${field("allowed_sender_ids", "'[]'")} FROM ai_chat_config WHERE id = 1),
            legacy_bot_enabled = (SELECT ${field("bot_enabled", "0")} FROM ai_chat_config WHERE id = 1),
            updated_at = (SELECT ${field("updated_at", "strftime('%s','now')")} FROM ai_chat_config WHERE id = 1)
        WHERE id = 1
      `);
      await run(`
        CREATE TABLE ai_chat_config_p9 (
          owner_uid TEXT PRIMARY KEY,
          allowed_topics TEXT NOT NULL DEFAULT '',
          role_tone TEXT NOT NULL DEFAULT '',
          use_knowledge INTEGER NOT NULL DEFAULT 0,
          knowledge_file_ids TEXT NOT NULL DEFAULT '[]',
          soul TEXT NOT NULL DEFAULT '',
          opencode_model TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
      `);
      await run(`
        INSERT INTO ai_chat_config_p9
          (owner_uid, allowed_topics, role_tone, use_knowledge, knowledge_file_ids, soul, opencode_model, updated_at)
        SELECT ?, ${field("allowed_topics", "''")}, ${field("role_tone", "''")},
               ${field("use_knowledge", "0")}, ${field("knowledge_file_ids", "'[]'")},
               ${field("soul", "''")}, ${field("opencode_model", "''")},
               ${field("updated_at", "strftime('%s','now')")}
        FROM ai_chat_config WHERE id = 1
      `, [LEGACY_AI_OWNER_UID]);
      await run("DROP TABLE ai_chat_config");
      await run("ALTER TABLE ai_chat_config_p9 RENAME TO ai_chat_config");
      result.aiMigrated = true;
      result.legacyAiOwnerUid = LEGACY_AI_OWNER_UID;
    } else {
      await run(AI_PROFILE_SCHEMA);
    }

    await run(`
      UPDATE ai_runtime_config SET opencode_base_url = 'http://opencode:4096'
      WHERE id = 1 AND opencode_base_url = 'http://host.docker.internal:4096'
    `);

    if (sessionLegacy) {
      await run(`
        CREATE TABLE training_session_p9 (
          owner_uid TEXT PRIMARY KEY,
          session_id TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL DEFAULT 0
        )
      `);
      await run(`
        CREATE TABLE training_messages_p9 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_uid TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          files TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      await run("DROP TABLE training_messages");
      await run("DROP TABLE training_session");
      await run("ALTER TABLE training_session_p9 RENAME TO training_session");
      await run("ALTER TABLE training_messages_p9 RENAME TO training_messages");
      result.trainingMigrated = true;
    } else {
      await run(TRAINING_SESSION_SCHEMA);
      await run(TRAINING_MESSAGE_SCHEMA);
    }
    await run("CREATE INDEX IF NOT EXISTS idx_training_messages_owner_id ON training_messages(owner_uid, id)");

    if (aiLegacy) {
      const owners = await all("SELECT owner_uid FROM ai_chat_config ORDER BY owner_uid");
      if (owners.length !== 1 || owners[0].owner_uid !== LEGACY_AI_OWNER_UID) {
        throw new Error("P9_STOP: legacy AI snapshot khong duoc gan dung owner da phe duyet.");
      }
    }

    await run("COMMIT");
    return result;
  } catch (error) {
    await run("ROLLBACK").catch(() => {});
    throw error;
  }
}
