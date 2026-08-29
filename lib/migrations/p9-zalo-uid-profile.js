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

export function validateLegacyOwnerUid(value) {
  const ownerUid = String(value ?? "").trim();
  if (!ownerUid) {
    throw new Error("P9_STOP: owner UID duoc phe duyet khong duoc de trong.");
  }
  if (!/^[1-9][0-9]{5,29}$/.test(ownerUid)) {
    throw new Error("P9_STOP: owner UID duoc phe duyet khong hop le.");
  }
  return ownerUid;
}

function optionalLegacyOwnerUid(options) {
  return Object.prototype.hasOwnProperty.call(options, "legacyOwnerUid")
    ? validateLegacyOwnerUid(options.legacyOwnerUid)
    : null;
}

async function legacyAiHasOwnerData(get, columns) {
  const field = (name, fallback) => cotHoac(columns, name, fallback);
  const row = await get(`
    SELECT ${field("allowed_topics", "''")} AS allowed_topics,
           ${field("role_tone", "''")} AS role_tone,
           ${field("use_knowledge", "0")} AS use_knowledge,
           ${field("knowledge_file_ids", "'[]'")} AS knowledge_file_ids,
           ${field("soul", "''")} AS soul,
           ${field("opencode_model", "''")} AS opencode_model
    FROM ai_chat_config WHERE id = 1
  `);
  if (!row) return false;
  const knowledgeIds = String(row.knowledge_file_ids ?? "").trim();
  return [row.allowed_topics, row.role_tone, row.soul, row.opencode_model]
    .some((value) => String(value ?? "").trim() !== "")
    || Number(row.use_knowledge || 0) !== 0
    || (knowledgeIds !== "" && knowledgeIds !== "[]");
}

/**
 * P9 migration giao dich cho AI profile va Training theo physical Zalo UID.
 *
 * Normal startup khong truyen options va tiep tuc fail-closed. Chi one-shot
 * operator tool duoc truyen legacyOwnerUid sau mot quyet dinh owner ro rang.
 */
export async function migrateP9ZaloUidProfile({ run, all, get }, options = {}) {
  // Validate explicit authority before opening a write transaction. Omitted is
  // different from explicitly empty: omitted means normal fail-closed startup.
  const legacyOwnerUid = optionalLegacyOwnerUid(options);
  const result = {
    aiMigrated: false,
    trainingMigrated: false,
    legacyAiOwnerUid: null,
    legacyTrainingOwnerUid: null,
  };
  let transactionOpen = false;
  try {
    await run("BEGIN IMMEDIATE");
    transactionOpen = true;

    const aiColumns = await cotCua(all, "ai_chat_config");
    const sessionColumns = await cotCua(all, "training_session");
    const messageColumns = await cotCua(all, "training_messages");

    const aiLegacy = aiColumns.length > 0 && !coCot(aiColumns, "owner_uid");
    const sessionLegacy = sessionColumns.length > 0 && !coCot(sessionColumns, "owner_uid");
    const messageLegacy = messageColumns.length > 0 && !coCot(messageColumns, "owner_uid");

    if (sessionLegacy !== messageLegacy) {
      throw new Error("P9_STOP: training schema dang o trang thai chuyen doi do dang.");
    }

    const aiNeedsOwner = aiLegacy && await legacyAiHasOwnerData(get, aiColumns);
    let legacySession = null;
    let legacyMessageCount = 0;
    if (sessionLegacy) {
      legacySession = await get("SELECT session_id FROM training_session WHERE id = 1");
      const messages = await get("SELECT COUNT(*) AS n FROM training_messages");
      legacyMessageCount = Number(messages?.n || 0);
    }
    const trainingNeedsOwner = sessionLegacy
      && (String(legacySession?.session_id || "").trim() !== "" || legacyMessageCount !== 0);

    // Training is checked first to preserve the exact production incident stop.
    if (trainingNeedsOwner && !legacyOwnerUid) {
      throw new Error("P9_STOP: legacy Training khong rong; khong duoc tu suy owner.");
    }
    if (aiNeedsOwner && !legacyOwnerUid) {
      throw new Error("P9_STOP: legacy AI khong rong; khong duoc tu suy owner.");
    }

    await run(AI_RUNTIME_SCHEMA);
    await run("INSERT OR IGNORE INTO ai_runtime_config (id) VALUES (1)");

    if (aiLegacy) {
      const field = (name, fallback) => cotHoac(aiColumns, name, fallback);
      const legacyAiRow = await get("SELECT id FROM ai_chat_config WHERE id = 1");
      if (legacyAiRow) {
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
      }
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
      if (aiNeedsOwner) {
        await run(`
          INSERT INTO ai_chat_config_p9
            (owner_uid, allowed_topics, role_tone, use_knowledge, knowledge_file_ids, soul, opencode_model, updated_at)
          SELECT ?, ${field("allowed_topics", "''")}, ${field("role_tone", "''")},
                 ${field("use_knowledge", "0")}, ${field("knowledge_file_ids", "'[]'")},
                 ${field("soul", "''")}, ${field("opencode_model", "''")},
                 ${field("updated_at", "strftime('%s','now')")}
          FROM ai_chat_config WHERE id = 1
        `, [legacyOwnerUid]);
        result.legacyAiOwnerUid = legacyOwnerUid;
      }
      await run("DROP TABLE ai_chat_config");
      await run("ALTER TABLE ai_chat_config_p9 RENAME TO ai_chat_config");
      result.aiMigrated = true;
    } else {
      await run(AI_PROFILE_SCHEMA);
    }

    await run(`
      UPDATE ai_runtime_config SET opencode_base_url = 'http://opencode:4096'
      WHERE id = 1 AND opencode_base_url = 'http://host.docker.internal:4096'
    `);

    if (sessionLegacy) {
      const sessionUpdatedAt = cotHoac(sessionColumns, "updated_at", "0");
      const messageFiles = cotHoac(messageColumns, "files", "NULL");
      const messageCreatedAt = cotHoac(messageColumns, "created_at", "0");
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
      if (trainingNeedsOwner) {
        await run(`
          INSERT INTO training_session_p9 (owner_uid, session_id, updated_at)
          SELECT ?, session_id, ${sessionUpdatedAt}
          FROM training_session WHERE id = 1
        `, [legacyOwnerUid]);
        await run(`
          INSERT INTO training_messages_p9 (id, owner_uid, role, content, files, created_at)
          SELECT id, ?, role, content, ${messageFiles}, ${messageCreatedAt}
          FROM training_messages ORDER BY id ASC
        `, [legacyOwnerUid]);
        result.legacyTrainingOwnerUid = legacyOwnerUid;
      }
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

    if (aiNeedsOwner) {
      const owners = await all("SELECT owner_uid FROM ai_chat_config ORDER BY owner_uid");
      if (owners.length !== 1 || owners[0].owner_uid !== legacyOwnerUid) {
        throw new Error("P9_STOP: legacy AI snapshot khong duoc gan dung owner da phe duyet.");
      }
    }
    if (trainingNeedsOwner) {
      const sessionOwner = await get("SELECT owner_uid FROM training_session");
      const foreignMessages = await get(
        "SELECT COUNT(*) AS n FROM training_messages WHERE owner_uid <> ?",
        [legacyOwnerUid]
      );
      if (sessionOwner?.owner_uid !== legacyOwnerUid || Number(foreignMessages?.n || 0) !== 0) {
        throw new Error("P9_STOP: legacy Training khong duoc gan dung owner da phe duyet.");
      }
    }

    await run("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) await run("ROLLBACK").catch(() => {});
    throw error;
  }
}
