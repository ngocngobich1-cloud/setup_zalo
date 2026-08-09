import sqlite3 from "sqlite3";
import path from "node:path";
import fs from "node:fs/promises";
import { formatSystemMessage } from "./message-utils.js";
import { daMachHoa, giaiMa, machHoa } from "./crypto-box.js";

const DATA_DIR = path.resolve("data");
const DB_PATH = path.join(DATA_DIR, "zalo.db");
let db;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

async function addColumnIfMissing(sql) {
  try {
    await run(sql);
  } catch (error) {
    if (!String(error.message).includes("duplicate column name")) {
      throw error;
    }
  }
}

export async function initDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  db = new sqlite3.Database(DB_PATH);
  await run("PRAGMA journal_mode = WAL");
  await run(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      thread_type INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      avatar TEXT,
      last_message TEXT,
      last_message_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      content TEXT NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0,
      sender_id TEXT,
      sender_name TEXT,
      sender_avatar TEXT,
      msg_type TEXT,
      ts INTEGER NOT NULL,
      raw_json TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);
  await run("CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(thread_id, ts)");
  await addColumnIfMissing("ALTER TABLE threads ADD COLUMN avatar TEXT");
  await addColumnIfMissing("ALTER TABLE messages ADD COLUMN sender_id TEXT");
  await addColumnIfMissing("ALTER TABLE messages ADD COLUMN sender_avatar TEXT");

  await run(`
    CREATE TABLE IF NOT EXISTS auto_reply_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      match_anywhere INTEGER NOT NULL DEFAULT 0,
      normalize INTEGER NOT NULL DEFAULT 0,
      reply_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS ai_chat_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      groq_api_key TEXT NOT NULL DEFAULT '',
      allowed_topics TEXT NOT NULL DEFAULT '',
      role_tone TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  await run(`
    INSERT OR IGNORE INTO ai_chat_config (id, groq_api_key, allowed_topics, role_tone)
    VALUES (1, '', '', '')
  `);
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN allowed_group_id TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN allowed_sender_ids TEXT NOT NULL DEFAULT '[]'");
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN use_knowledge INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN knowledge_file_ids TEXT NOT NULL DEFAULT '[]'");
  // Mac dinh TAT. Them cong tac ma mac dinh bat thi bot van tu tra loi khach
  // truoc khi ai kip quyet dinh - dung thu vua lam chi hoang.
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN bot_enabled INTEGER NOT NULL DEFAULT 0");
  // Cho bot doc anh/PDF khach gui. Mac dinh TAT: moi lan doc la mot lan tra tien,
  // bat san ma chu chua biet la hoa don doi len ma khong hieu vi sao.
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN doc_tep INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN soul TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN opencode_base_url TEXT NOT NULL DEFAULT 'http://opencode:4096'");
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN opencode_agent TEXT NOT NULL DEFAULT 'general'");
  await addColumnIfMissing("ALTER TABLE ai_chat_config ADD COLUMN opencode_model TEXT NOT NULL DEFAULT ''");

  // OpenCode da chuyen vao trong docker-compose nen host.docker.internal khong con
  // dung nua (va tren Linux thi ten do khong ton tai). Chi doi khi con dang la gia
  // tri mac dinh cu - neu nguoi dung da tu sua thanh dia chi khac thi giu nguyen.
  const doiDiaChi = await run(
    `UPDATE ai_chat_config SET opencode_base_url = 'http://opencode:4096'
     WHERE id = 1 AND opencode_base_url = 'http://host.docker.internal:4096'`
  );
  if (doiDiaChi.changes > 0) {
    console.log("[db] Da chuyen dia chi OpenCode sang http://opencode:4096 (dich vu trong docker-compose)");
  }

  await run(`
    CREATE TABLE IF NOT EXISTS opencode_sessions (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  // Dem luot de biet khi nao phien qua dai va can xoay (Dot 3).
  await addColumnIfMissing("ALTER TABLE opencode_sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0");

  // Ket noi Zoho Mail. client_secret va refresh_token deu duoc ma hoa truoc khi
  // ghi (xem crypto-box.js) - refresh_token khong bao gio het han nen lo ra la
  // nguoi khac doc duoc hop mail cua chu app cho toi khi bi thu hoi thu cong.
  await run(`
    CREATE TABLE IF NOT EXISTS zoho_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      vung TEXT NOT NULL DEFAULT 'com',
      client_id TEXT NOT NULL DEFAULT '',
      client_secret TEXT NOT NULL DEFAULT '',
      refresh_token TEXT NOT NULL DEFAULT '',
      access_token TEXT NOT NULL DEFAULT '',
      access_het_han INTEGER NOT NULL DEFAULT 0,
      account_id TEXT NOT NULL DEFAULT '',
      dia_chi TEXT NOT NULL DEFAULT '',
      bat INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`INSERT OR IGNORE INTO zoho_config (id) VALUES (1)`);

  // Nhat ky moi luot tra cuu. Chi yeu cau bot tra loi thang cho khach, nen phai
  // co cho de chi soi lai sau: ai hoi, hoi dia chi nao, luc nao.
  await run(`
    CREATE TABLE IF NOT EXISTS email_tra_cuu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      luc INTEGER NOT NULL,
      nguon TEXT NOT NULL DEFAULT 'bot',
      nguoi_hoi_ten TEXT,
      nguoi_hoi_uid TEXT,
      email_tra TEXT NOT NULL,
      ket_qua TEXT NOT NULL,
      gui_luc INTEGER,
      tieu_de TEXT,
      chi_tiet TEXT
    )
  `);
  await run("CREATE INDEX IF NOT EXISTS idx_email_tra_cuu_luc ON email_tra_cuu(luc DESC)");

  // So hen gio. Phai nam trong CSDL chu khong the giu trong bo nho: app khoi
  // dong lai la mat sach lich, ma chi se khong biet cho den luc tin khong den.
  await run(`
    CREATE TABLE IF NOT EXISTS lich_hen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dich_id TEXT NOT NULL,
      dich_ten TEXT NOT NULL,
      loai TEXT NOT NULL DEFAULT 'nick',
      noi_dung TEXT NOT NULL,
      luc_gui INTEGER NOT NULL,
      lap_lai TEXT NOT NULL DEFAULT '',
      trang_thai TEXT NOT NULL DEFAULT 'cho',
      cau_lenh TEXT,
      tao_luc INTEGER NOT NULL,
      gui_luc INTEGER,
      ghi_chu TEXT
    )
  `);
  await run("CREATE INDEX IF NOT EXISTS idx_lich_hen_den_han ON lich_hen(trang_thai, luc_gui)");

  // Ho so khach hang. Khoa theo UID Zalo chu KHONG theo cuoc tro chuyen: cung
  // mot nguoi nhan rieng hay noi trong nhom lop thi van la mot ho so.
  await run(`
    CREATE TABLE IF NOT EXISTS customer_memory (
      uid TEXT PRIMARY KEY,
      display_name TEXT,
      profile TEXT NOT NULL DEFAULT '',
      locked INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Phien huan luyen TACH HAN khoi session cua bot: cau chi day o day khong
  // duoc lan vao ngu canh dang noi chuyen voi khach that.
  await run(`
    CREATE TABLE IF NOT EXISTS training_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      session_id TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  await run(`INSERT OR IGNORE INTO training_session (id) VALUES (1)`);

  await run(`
    CREATE TABLE IF NOT EXISTS training_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      files TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      file_ext TEXT NOT NULL,
      content_md TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      summary TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  await run("CREATE INDEX IF NOT EXISTS idx_activity_logs_id ON activity_logs(id DESC)");

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Phien dang nhap luu xuong DB de con nguyen sau khi restart container.
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  await run(`DELETE FROM sessions WHERE expires_at < ?`, [Date.now()]);

  await addColumnIfMissing("ALTER TABLE users ADD COLUMN otp_enabled INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("ALTER TABLE users ADD COLUMN otp_zalo_thread_id TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing("ALTER TABLE users ADD COLUMN otp_zalo_label TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing("ALTER TABLE users ADD COLUMN otp_email TEXT NOT NULL DEFAULT ''");
  // Nick Zalo duoc quyen ra lenh cho bot. Rong = khong ai ra lenh duoc.
  await addColumnIfMissing("ALTER TABLE users ADD COLUMN admin_zalo_uid TEXT NOT NULL DEFAULT ''");
  await addColumnIfMissing("ALTER TABLE users ADD COLUMN admin_zalo_label TEXT NOT NULL DEFAULT ''");

  await run(`
    CREATE TABLE IF NOT EXISTS smtp_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      host TEXT NOT NULL DEFAULT '',
      port INTEGER NOT NULL DEFAULT 587,
      secure INTEGER NOT NULL DEFAULT 0,
      username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      from_address TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  await run(`INSERT OR IGNORE INTO smtp_config (id) VALUES (1)`);

  await backfillSystemMessageText();
  await machHoaBiMatCu();
}

/**
 * Ghi de lai cac bi mat con de tran tu ban truoc. Idempotent: da co tien to
 * "v1:" thi bo qua, nen chay lai bao nhieu lan cung khong sao.
 */
async function machHoaBiMatCu() {
  let daMa = 0;

  for (const row of await all(`SELECT key, value FROM app_secrets`)) {
    if (!row.value || daMachHoa(row.value)) continue;
    await run(`UPDATE app_secrets SET value = ? WHERE key = ?`, [machHoa(row.value), row.key]);
    daMa++;
  }

  const smtp = await get(`SELECT password FROM smtp_config WHERE id = 1`);
  if (smtp?.password && !daMachHoa(smtp.password)) {
    await run(`UPDATE smtp_config SET password = ? WHERE id = 1`, [machHoa(smtp.password)]);
    daMa++;
  }

  if (daMa > 0) console.log(`[db] Da ma hoa ${daMa} bi mat con de tran`);
}

/**
 * Cac tin he thong luu truoc khi co formatSystemMessage dang giu nguyen cuc JSON
 * trong cot content. Doc lai tu raw_json de hien thi cho nguoi doc.
 * Idempotent: chay xong thi content khong con bat dau bang '{' nua.
 * Tin sticker khong bi dung toi vi formatSystemMessage tra ve null cho chung.
 */
async function backfillSystemMessageText() {
  const rows = await all(
    `SELECT id, raw_json FROM messages WHERE content LIKE '{%' AND raw_json IS NOT NULL`
  );
  let fixed = 0;
  for (const row of rows) {
    const raw = safeJson(row.raw_json);
    const readable = formatSystemMessage(raw?.data?.content ?? raw?.content);
    if (!readable) continue;
    await run(`UPDATE messages SET content = ? WHERE id = ?`, [readable, row.id]);
    fixed++;
  }
  if (fixed > 0) {
    console.log(`[db] Da doc lai ${fixed} tin he thong (binh chon/nhom) sang dang de doc`);
  }
  return fixed;
}

export async function listThreads({ recentOnly = true } = {}) {
  const where = recentOnly
    ? "WHERE last_message IS NOT NULL OR id IN (SELECT DISTINCT thread_id FROM messages)"
    : "";
  const rows = await all(`
    SELECT id, thread_type, title, avatar, last_message, last_message_at, updated_at
    FROM threads
    ${where}
    ORDER BY COALESCE(last_message_at, updated_at) DESC
  `);
  return rows.map(mapThread);
}

export async function getThread(threadId) {
  const row = await get("SELECT * FROM threads WHERE id = ?", [threadId]);
  return row ? mapThread(row) : null;
}

export async function getThreadMessages(threadId, limit = 500) {
  const rows = await all(
    `SELECT * FROM messages WHERE thread_id = ? ORDER BY ts DESC LIMIT ?`,
    [threadId, limit]
  );
  return rows.reverse().map(mapMessage);
}

export async function upsertThread(thread) {
  const rawThreadType = thread.threadType ?? thread.thread_type;
  // Nguoi goi khong truyen thread_type (vd rebuildThreadsFromMessages) thi phai GIU
  // gia tri cu. Gan cung 0 se bien moi nhom (type 1) thanh chat ca nhan.
  const threadType = rawThreadType === undefined || rawThreadType === null
    ? null
    : Number(rawThreadType);

  await run(
    `
      INSERT INTO threads (id, thread_type, title, avatar, last_message, last_message_at, updated_at)
      VALUES ($id, COALESCE($threadType, 0), $title, $avatar, $lastMessage, $lastMessageAt, $updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        thread_type = COALESCE($threadType, threads.thread_type),
        title = COALESCE(excluded.title, threads.title),
        avatar = COALESCE(excluded.avatar, threads.avatar),
        last_message = COALESCE(excluded.last_message, threads.last_message),
        last_message_at = COALESCE(excluded.last_message_at, threads.last_message_at),
        updated_at = excluded.updated_at
    `,
    {
      $id: thread.id,
      $threadType: threadType,
      $title: thread.title ?? null,
      $avatar: thread.avatar ?? null,
      $lastMessage: thread.lastMessage ?? thread.last_message ?? null,
      $lastMessageAt: thread.lastMessageAt ?? thread.last_message_at ?? null,
      $updatedAt: Date.now(),
    }
  );
  return getThread(thread.id);
}

export async function insertMessage(message) {
  return await run(
    `
      INSERT OR IGNORE INTO messages
        (id, thread_id, content, is_self, sender_id, sender_name, sender_avatar, msg_type, ts, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      message.id,
      message.threadId,
      message.content || "",
      message.isSelf ? 1 : 0,
      message.senderId ?? null,
      message.senderName ?? null,
      message.senderAvatar ?? null,
      message.msgType ?? null,
      message.ts,
      message.rawJson ? JSON.stringify(message.rawJson) : null,
    ]
  );
}

export async function rebuildThreadsFromMessages() {
  const rows = await all(`
    SELECT m.thread_id, m.content, m.ts
    FROM messages m
    INNER JOIN (
      SELECT thread_id, MAX(ts) AS max_ts
      FROM messages
      GROUP BY thread_id
    ) latest ON latest.thread_id = m.thread_id AND latest.max_ts = m.ts
  `);
  for (const row of rows) {
    await upsertThread({
      id: row.thread_id,
      lastMessage: row.content,
      lastMessageAt: row.ts,
    });
  }
}

function mapThread(row) {
  return {
    id: row.id,
    threadType: row.thread_type,
    title: row.title,
    avatar: row.avatar,
    lastMessage: row.last_message,
    lastMessageAt: row.last_message_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    content: row.content,
    isSelf: Boolean(row.is_self),
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderAvatar: row.sender_avatar,
    msgType: row.msg_type,
    ts: row.ts,
    rawJson: row.raw_json ? safeJson(row.raw_json) : null,
  };
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getAutoReplyRules() {
  return await all(`SELECT * FROM auto_reply_rules ORDER BY created_at ASC`);
}

export async function insertAutoReplyRule(rule) {
  const result = await run(
    `INSERT INTO auto_reply_rules (command, match_anywhere, normalize, reply_text, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      rule.command,
      rule.match_anywhere ? 1 : 0,
      rule.normalize ? 1 : 0,
      rule.reply_text,
      Date.now()
    ]
  );
  return result;
}

export async function updateAutoReplyRule(id, rule) {
  const result = await run(
    `UPDATE auto_reply_rules
     SET command = ?, match_anywhere = ?, normalize = ?, reply_text = ?
     WHERE id = ?`,
    [
      rule.command,
      rule.match_anywhere ? 1 : 0,
      rule.normalize ? 1 : 0,
      rule.reply_text,
      id
    ]
  );
  return result;
}

export async function deleteAutoReplyRule(id) {
  await run(`DELETE FROM auto_reply_rules WHERE id = ?`, [id]);
}

export async function getAiChatConfig() {
  const row = await get(`SELECT * FROM ai_chat_config WHERE id = 1`);
  if (!row) return null;
  return {
    groqApiKey: row.groq_api_key,
    allowedTopics: row.allowed_topics,
    roleTone: row.role_tone,
    allowedGroupId: row.allowed_group_id,
    allowedSenderIds: safeJson(row.allowed_sender_ids) || [],
    useKnowledge: Boolean(row.use_knowledge),
    knowledgeFileIds: (safeJson(row.knowledge_file_ids) || [])
      .map(Number)
      .filter(Number.isInteger),
    botEnabled: Boolean(row.bot_enabled),
    docTep: Boolean(row.doc_tep),
    soul: row.soul || "",
    opencodeBaseUrl: row.opencode_base_url || "",
    opencodeAgent: row.opencode_agent || "general",
    opencodeModel: row.opencode_model || "",
    updatedAt: row.updated_at
  };
}

export async function setDocTep(bat) {
  await run(
    `UPDATE ai_chat_config SET doc_tep = ?, updated_at = strftime('%s','now') WHERE id = 1`,
    [bat ? 1 : 0]
  );
}

export async function setBotEnabled(enabled) {
  await run(
    `UPDATE ai_chat_config SET bot_enabled = ?, updated_at = strftime('%s','now') WHERE id = 1`,
    [enabled ? 1 : 0]
  );
}

export async function getOpencodeSession(threadId) {
  const row = await get(`SELECT * FROM opencode_sessions WHERE thread_id = ?`, [String(threadId)]);
  return row ? row.session_id : null;
}

/** Nhu tren nhung kem so luot, de biet phien da den luc xoay chua. */
export async function getOpencodeSessionInfo(threadId) {
  const row = await get(`SELECT * FROM opencode_sessions WHERE thread_id = ?`, [String(threadId)]);
  return row ? { sessionId: row.session_id, turns: row.turns || 0, createdAt: row.created_at } : null;
}

export async function bumpSessionTurns(threadId) {
  await run(`UPDATE opencode_sessions SET turns = turns + 1 WHERE thread_id = ?`, [String(threadId)]);
}

export async function saveOpencodeSession(threadId, sessionId) {
  await run(
    `INSERT INTO opencode_sessions (thread_id, session_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id, created_at = excluded.created_at`,
    [String(threadId), String(sessionId), Math.floor(Date.now() / 1000)]
  );
}

export async function deleteOpencodeSession(threadId) {
  await run(`DELETE FROM opencode_sessions WHERE thread_id = ?`, [String(threadId)]);
}

/**
 * Tra ve danh sach session_id vua bo, de nguoi goi con xoa han chung ben
 * OpenCode. Chi xoa dong o day thi session mo coi nam lai trong opencode-data
 * mai mai, khong ai don.
 */
export async function clearOpencodeSessions() {
  const rows = await all(`SELECT session_id FROM opencode_sessions`);
  await run(`DELETE FROM opencode_sessions`);
  return rows.map((row) => row.session_id).filter(Boolean);
}

/* --- ZOHO MAIL --- */

export async function getZohoConfig() {
  const row = await get(`SELECT * FROM zoho_config WHERE id = 1`);
  if (!row) return null;
  const moKhoa = (v) => {
    try {
      return giaiMa(v);
    } catch {
      return "";
    }
  };
  return {
    vung: row.vung || "com",
    clientId: moKhoa(row.client_id),
    clientSecret: moKhoa(row.client_secret),
    refreshToken: moKhoa(row.refresh_token),
    accessToken: moKhoa(row.access_token),
    accessHetHan: row.access_het_han || 0,
    accountId: row.account_id || "",
    diaChi: row.dia_chi || "",
    bat: Boolean(row.bat),
    updatedAt: row.updated_at || 0,
  };
}

/** Chi ghi de nhung truong duoc truyen; cac truong khac giu nguyen. */
export async function saveZohoConfig(patch) {
  const maNeuCo = (v) => (v === undefined || v === null ? null : machHoa(String(v)));
  await run(
    `UPDATE zoho_config SET
       vung           = COALESCE($vung, vung),
       client_id      = COALESCE($clientId, client_id),
       client_secret  = COALESCE($clientSecret, client_secret),
       refresh_token  = COALESCE($refreshToken, refresh_token),
       access_token   = COALESCE($accessToken, access_token),
       access_het_han = COALESCE($accessHetHan, access_het_han),
       account_id     = COALESCE($accountId, account_id),
       dia_chi        = COALESCE($diaChi, dia_chi),
       bat            = COALESCE($bat, bat),
       updated_at     = $now
     WHERE id = 1`,
    {
      $vung: patch.vung ?? null,
      $clientId: maNeuCo(patch.clientId),
      $clientSecret: maNeuCo(patch.clientSecret),
      $refreshToken: maNeuCo(patch.refreshToken),
      $accessToken: maNeuCo(patch.accessToken),
      $accessHetHan: patch.accessHetHan ?? null,
      $accountId: patch.accountId ?? null,
      $diaChi: patch.diaChi ?? null,
      $bat: patch.bat === undefined || patch.bat === null ? null : patch.bat ? 1 : 0,
      $now: Math.floor(Date.now() / 1000),
    }
  );
  return getZohoConfig();
}

/** Ngat ket noi: xoa sach chia khoa. Client ID/Secret giu lai de khoi nhap lai. */
export async function xoaKetNoiZoho() {
  await run(
    `UPDATE zoho_config SET refresh_token = '', access_token = '', access_het_han = 0,
       account_id = '', dia_chi = '', bat = 0, updated_at = ? WHERE id = 1`,
    [Math.floor(Date.now() / 1000)]
  );
}

export async function ghiTraCuu({ nguon, nguoiHoiTen, nguoiHoiUid, emailTra, ketQua, guiLuc, tieuDe, chiTiet }) {
  await run(
    `INSERT INTO email_tra_cuu (luc, nguon, nguoi_hoi_ten, nguoi_hoi_uid, email_tra, ket_qua, gui_luc, tieu_de, chi_tiet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Math.floor(Date.now() / 1000),
      nguon || "bot",
      nguoiHoiTen || null,
      nguoiHoiUid || null,
      String(emailTra),
      String(ketQua),
      guiLuc || null,
      tieuDe || null,
      chiTiet || null,
    ]
  );
}

export async function xoaLichSuTraCuu() {
  const truoc = await get(`SELECT COUNT(*) AS n FROM email_tra_cuu`);
  await run(`DELETE FROM email_tra_cuu`);
  return truoc?.n || 0;
}

export async function listTraCuu(gioiHan = 50) {
  const rows = await all(`SELECT * FROM email_tra_cuu ORDER BY luc DESC LIMIT ?`, [Number(gioiHan)]);
  return rows.map((r) => ({
    id: r.id,
    luc: r.luc,
    nguon: r.nguon,
    nguoiHoiTen: r.nguoi_hoi_ten || "",
    nguoiHoiUid: r.nguoi_hoi_uid || "",
    emailTra: r.email_tra,
    ketQua: r.ket_qua,
    guiLuc: r.gui_luc || null,
    tieuDe: r.tieu_de || "",
    chiTiet: r.chi_tiet || "",
  }));
}

/* --- SO HEN GIO --- */

function mapLichHen(row) {
  return {
    id: row.id,
    dichId: row.dich_id,
    dichTen: row.dich_ten,
    loai: row.loai,
    noiDung: row.noi_dung,
    lucGui: row.luc_gui,
    lapLai: row.lap_lai || "",
    trangThai: row.trang_thai,
    cauLenh: row.cau_lenh || "",
    taoLuc: row.tao_luc,
    guiLuc: row.gui_luc || null,
    ghiChu: row.ghi_chu || "",
  };
}

export async function themLichHen({ dichId, dichTen, loai, noiDung, lucGui, lapLai, cauLenh }) {
  const result = await run(
    `INSERT INTO lich_hen (dich_id, dich_ten, loai, noi_dung, luc_gui, lap_lai, trang_thai, cau_lenh, tao_luc)
     VALUES (?, ?, ?, ?, ?, ?, 'cho', ?, ?)`,
    [
      String(dichId),
      String(dichTen || dichId),
      loai === "nhom" ? "nhom" : "nick",
      String(noiDung),
      Number(lucGui),
      String(lapLai || ""),
      String(cauLenh || ""),
      Math.floor(Date.now() / 1000),
    ]
  );
  return getLichHen(result.lastID);
}

export async function getLichHen(id) {
  const row = await get(`SELECT * FROM lich_hen WHERE id = ?`, [Number(id)]);
  return row ? mapLichHen(row) : null;
}

/** Cac lich da toi gio ma chua gui. Cu nhat truoc de gui dung thu tu. */
export async function layLichDenHan(mocGiay) {
  const rows = await all(
    `SELECT * FROM lich_hen WHERE trang_thai = 'cho' AND luc_gui <= ? ORDER BY luc_gui ASC`,
    [Number(mocGiay)]
  );
  return rows.map(mapLichHen);
}

export async function listLichHen({ chiChoGui = false, gioiHan = 100 } = {}) {
  const rows = await all(
    chiChoGui
      ? `SELECT * FROM lich_hen WHERE trang_thai = 'cho' ORDER BY luc_gui ASC LIMIT ?`
      : `SELECT * FROM lich_hen ORDER BY (trang_thai = 'cho') DESC, luc_gui DESC LIMIT ?`,
    [Number(gioiHan)]
  );
  return rows.map(mapLichHen);
}

export async function capNhatLichHen(id, { trangThai, guiLuc, ghiChu, lucGui }) {
  await run(
    `UPDATE lich_hen SET
       trang_thai = COALESCE($trangThai, trang_thai),
       gui_luc    = COALESCE($guiLuc, gui_luc),
       ghi_chu    = COALESCE($ghiChu, ghi_chu),
       luc_gui    = COALESCE($lucGui, luc_gui)
     WHERE id = $id`,
    {
      $id: Number(id),
      $trangThai: trangThai ?? null,
      $guiLuc: guiLuc ?? null,
      $ghiChu: ghiChu ?? null,
      $lucGui: lucGui ?? null,
    }
  );
  return getLichHen(id);
}

/** Huy mot lich con dang cho. Da gui roi thi khong huy duoc nua. */
export async function huyLichHen(id) {
  const result = await run(
    `UPDATE lich_hen SET trang_thai = 'da_huy' WHERE id = ? AND trang_thai = 'cho'`,
    [Number(id)]
  );
  return result.changes > 0;
}

/* --- HO SO KHACH HANG --- */

function mapCustomer(row) {
  return {
    uid: row.uid,
    displayName: row.display_name || "",
    profile: row.profile || "",
    locked: Boolean(row.locked),
    turns: row.turns || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCustomerMemory(uid) {
  if (!uid) return null;
  const row = await get(`SELECT * FROM customer_memory WHERE uid = ?`, [String(uid)]);
  return row ? mapCustomer(row) : null;
}

export async function listCustomerMemories() {
  const rows = await all(`SELECT * FROM customer_memory ORDER BY updated_at DESC`);
  return rows.map(mapCustomer);
}

/** Ghi ho so. Chi dat nhung truong duoc truyen, cac truong khac giu nguyen. */
export async function saveCustomerMemory({ uid, displayName, profile, locked }) {
  if (!uid) throw new Error("Thiếu UID khách hàng");
  const now = Math.floor(Date.now() / 1000);
  await run(
    `
      INSERT INTO customer_memory (uid, display_name, profile, locked, turns, created_at, updated_at)
      VALUES ($uid, $displayName, COALESCE($profile, ''), COALESCE($locked, 0), 0, $now, $now)
      ON CONFLICT(uid) DO UPDATE SET
        display_name = COALESCE($displayName, customer_memory.display_name),
        profile      = COALESCE($profile, customer_memory.profile),
        locked       = COALESCE($locked, customer_memory.locked),
        updated_at   = $now
    `,
    {
      $uid: String(uid),
      $displayName: displayName ?? null,
      $profile: profile ?? null,
      $locked: locked === undefined || locked === null ? null : locked ? 1 : 0,
      $now: now,
    }
  );
  return getCustomerMemory(uid);
}

/** Tang bo dem luot cua khach va tra ve so moi. Tao dong neu chua co. */
export async function bumpCustomerTurns(uid, displayName) {
  if (!uid) return 0;
  const now = Math.floor(Date.now() / 1000);
  await run(
    `
      INSERT INTO customer_memory (uid, display_name, profile, locked, turns, created_at, updated_at)
      VALUES ($uid, $displayName, '', 0, 1, $now, $now)
      ON CONFLICT(uid) DO UPDATE SET
        turns = customer_memory.turns + 1,
        display_name = COALESCE($displayName, customer_memory.display_name)
    `,
    { $uid: String(uid), $displayName: displayName || null, $now: now }
  );
  const row = await get(`SELECT turns FROM customer_memory WHERE uid = ?`, [String(uid)]);
  return row?.turns || 0;
}

export async function resetCustomerTurns(uid) {
  await run(`UPDATE customer_memory SET turns = 0 WHERE uid = ?`, [String(uid)]);
}

export async function deleteCustomerMemory(uid) {
  await run(`DELETE FROM customer_memory WHERE uid = ?`, [String(uid)]);
}

/* --- PHIEN HUAN LUYEN --- */

export async function getTrainingSessionId() {
  const row = await get(`SELECT session_id FROM training_session WHERE id = 1`);
  return row?.session_id || null;
}

export async function saveTrainingSessionId(sessionId) {
  await run(
    `UPDATE training_session SET session_id = ?, updated_at = ? WHERE id = 1`,
    [String(sessionId || ""), Math.floor(Date.now() / 1000)]
  );
}

export async function addTrainingMessage({ role, content, files }) {
  const result = await run(
    `INSERT INTO training_messages (role, content, files, created_at) VALUES (?, ?, ?, ?)`,
    [role, String(content || ""), files?.length ? JSON.stringify(files) : null, Math.floor(Date.now() / 1000)]
  );
  return result.lastID;
}

export async function getTrainingMessages(limit = 200) {
  const rows = await all(
    `SELECT * FROM training_messages ORDER BY id ASC LIMIT ?`,
    [Math.min(500, Math.max(1, Number(limit) || 200))]
  );
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    files: row.files ? safeJson(row.files) || [] : [],
    createdAt: row.created_at,
  }));
}

export async function clearTrainingMessages() {
  await run(`DELETE FROM training_messages`);
  await saveTrainingSessionId("");
}

export async function saveAiChatConfig({
  groqApiKey,
  allowedTopics,
  roleTone,
  allowedGroupId,
  allowedSenderIds,
  useKnowledge,
  knowledgeFileIds,
  soul,
  opencodeBaseUrl,
  opencodeAgent,
  opencodeModel,
}) {
  const senderIdsStr = JSON.stringify(Array.isArray(allowedSenderIds) ? allowedSenderIds : []);
  const knowledgeIdsStr = JSON.stringify(
    (Array.isArray(knowledgeFileIds) ? knowledgeFileIds : []).map(Number).filter(Number.isInteger)
  );
  await run(
    `UPDATE ai_chat_config
     SET groq_api_key = ?, allowed_topics = ?, role_tone = ?, allowed_group_id = ?, allowed_sender_ids = ?,
         use_knowledge = ?, knowledge_file_ids = ?, soul = ?,
         opencode_base_url = ?, opencode_agent = ?, opencode_model = ?, updated_at = strftime('%s','now')
     WHERE id = 1`,
    [
      groqApiKey || '',
      allowedTopics || '',
      roleTone || '',
      allowedGroupId || '',
      senderIdsStr,
      useKnowledge ? 1 : 0,
      knowledgeIdsStr,
      soul || '',
      opencodeBaseUrl || '',
      opencodeAgent || 'general',
      opencodeModel || '',
    ]
  );
}

/* --- KHO TRI THUC --- */

function mapKnowledgeRow(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    fileExt: row.file_ext,
    fileSize: row.file_size,
    charCount: row.char_count,
    createdAt: row.created_at,
    ...(row.content_md === undefined ? {} : { contentMd: row.content_md }),
  };
}

/** Co tinh KHONG lay content_md: danh sach co the rat nang. */
export async function getAllKnowledgeFiles() {
  const rows = await all(
    `SELECT id, original_name, file_ext, file_size, char_count, created_at
     FROM knowledge_files ORDER BY created_at DESC, id DESC`
  );
  return rows.map(mapKnowledgeRow);
}

export async function getKnowledgeFileById(id) {
  const row = await get(`SELECT * FROM knowledge_files WHERE id = ?`, [Number(id)]);
  return row ? mapKnowledgeRow(row) : null;
}

export async function getKnowledgeFilesByIds(ids) {
  const safeIds = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (safeIds.length === 0) return [];
  const placeholders = safeIds.map(() => "?").join(", ");
  const rows = await all(
    `SELECT * FROM knowledge_files WHERE id IN (${placeholders}) ORDER BY id ASC`,
    safeIds
  );
  return rows.map(mapKnowledgeRow);
}

export async function createKnowledgeFile({ originalName, fileExt, contentMd, fileSize }) {
  const result = await run(
    `INSERT INTO knowledge_files (original_name, file_ext, content_md, file_size, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      originalName,
      fileExt,
      contentMd,
      Number(fileSize) || 0,
      contentMd.length,
      Math.floor(Date.now() / 1000),
    ]
  );
  return getKnowledgeFileById(result.lastID);
}

export async function deleteKnowledgeFile(id) {
  const result = await run(`DELETE FROM knowledge_files WHERE id = ?`, [Number(id)]);
  return result.changes > 0;
}

/* --- NHAT KY HOAT DONG --- */

const ACTIVITY_LOG_LIMIT = 500;

function mapLogRow(row) {
  return {
    id: row.id,
    event: row.event,
    level: row.level,
    summary: row.summary,
    detail: row.detail ? safeJson(row.detail) : null,
    createdAt: row.created_at,
  };
}

export async function insertActivityLog({ event, level, summary, detail }) {
  const result = await run(
    `INSERT INTO activity_logs (event, level, summary, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
    [
      event,
      level || "info",
      summary || "",
      detail === undefined || detail === null ? null : JSON.stringify(detail),
      Math.floor(Date.now() / 1000),
    ]
  );
  // Giu toi da ACTIVITY_LOG_LIMIT dong, xoa dong cu nhat khi vuot nguong.
  await run(
    `DELETE FROM activity_logs WHERE id <= (
       SELECT MAX(id) - ? FROM activity_logs
     )`,
    [ACTIVITY_LOG_LIMIT]
  );
  const row = await get(`SELECT * FROM activity_logs WHERE id = ?`, [result.lastID]);
  return row ? mapLogRow(row) : null;
}

export async function getActivityLogs(limit = 150) {
  const safeLimit = Math.min(ACTIVITY_LOG_LIMIT, Math.max(1, Number(limit) || 150));
  const rows = await all(
    `SELECT * FROM activity_logs ORDER BY id DESC LIMIT ?`,
    [safeLimit]
  );
  return rows.map(mapLogRow);
}

export async function clearActivityLogs() {
  await run(`DELETE FROM activity_logs`);
}

/* --- NGUOI DUNG --- */

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    otpEnabled: Boolean(row.otp_enabled),
    otpZaloThreadId: row.otp_zalo_thread_id || "",
    otpZaloLabel: row.otp_zalo_label || "",
    otpEmail: row.otp_email || "",
    adminZaloUid: row.admin_zalo_uid || "",
    adminZaloLabel: row.admin_zalo_label || "",
    updatedAt: row.updated_at,
  };
}

/** Nick Zalo duoc quyen ra lenh. Doc truc tiep tu DB moi lan de doi cau hinh la an ngay. */
export async function getAdminZalo() {
  const row = await get(`SELECT admin_zalo_uid, admin_zalo_label FROM users WHERE id = 1`);
  return { uid: row?.admin_zalo_uid || "", label: row?.admin_zalo_label || "" };
}

export async function setAdminZalo(uid, label) {
  await run(
    `UPDATE users SET admin_zalo_uid = ?, admin_zalo_label = ?, updated_at = ? WHERE id = 1`,
    [String(uid || ""), String(label || ""), Math.floor(Date.now() / 1000)]
  );
}

export async function countUsers() {
  const row = await get(`SELECT COUNT(*) n FROM users`);
  return row ? row.n : 0;
}

export async function getUserByUsername(username) {
  const row = await get(`SELECT * FROM users WHERE username = ?`, [String(username || "")]);
  return row ? mapUser(row) : null;
}

export async function getUserById(id) {
  const row = await get(`SELECT * FROM users WHERE id = ?`, [Number(id)]);
  return row ? mapUser(row) : null;
}

export async function createUser({ username, passwordHash }) {
  const result = await run(
    `INSERT INTO users (username, password_hash, updated_at) VALUES (?, ?, ?)`,
    [String(username), String(passwordHash), Math.floor(Date.now() / 1000)]
  );
  return getUserById(result.lastID);
}

export async function updateUserPassword(id, passwordHash) {
  const result = await run(
    `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
    [String(passwordHash), Math.floor(Date.now() / 1000), Number(id)]
  );
  return result.changes > 0;
}

export async function updateUsername(id, username) {
  const result = await run(
    `UPDATE users SET username = ?, updated_at = ? WHERE id = ?`,
    [String(username), Math.floor(Date.now() / 1000), Number(id)]
  );
  return result.changes > 0;
}

/* --- PHIEN DANG NHAP --- */

export async function getSession(sid) {
  const row = await get(`SELECT data, expires_at FROM sessions WHERE sid = ?`, [String(sid)]);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await deleteSession(sid);
    return null;
  }
  return row.data;
}

export async function setSession(sid, data, expiresAt) {
  await run(
    `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
    [String(sid), String(data), Number(expiresAt)]
  );
}

export async function touchSession(sid, expiresAt) {
  await run(`UPDATE sessions SET expires_at = ? WHERE sid = ?`, [Number(expiresAt), String(sid)]);
}

export async function deleteSession(sid) {
  await run(`DELETE FROM sessions WHERE sid = ?`, [String(sid)]);
}

export async function listSessions() {
  return all(`SELECT sid FROM sessions WHERE expires_at >= ?`, [Date.now()]);
}

/* --- KHO BI MAT CUA APP (khoa ky session...) --- */

export async function getAppSecret(key) {
  const row = await get(`SELECT value FROM app_secrets WHERE key = ?`, [String(key)]);
  if (!row?.value) return null;
  try {
    return giaiMa(row.value);
  } catch (error) {
    console.warn(`[db] Khong giai ma duoc bi mat "${key}":`, error.message);
    return null;
  }
}

export async function setAppSecret(key, value) {
  await run(
    `INSERT INTO app_secrets (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(key), machHoa(String(value))]
  );
}

export async function updateUserOtpSettings(id, { otpEnabled, otpZaloThreadId, otpZaloLabel, otpEmail }) {
  const result = await run(
    `UPDATE users
     SET otp_enabled = ?, otp_zalo_thread_id = ?, otp_zalo_label = ?, otp_email = ?, updated_at = ?
     WHERE id = ?`,
    [
      otpEnabled ? 1 : 0,
      String(otpZaloThreadId || ""),
      String(otpZaloLabel || ""),
      String(otpEmail || ""),
      Math.floor(Date.now() / 1000),
      Number(id),
    ]
  );
  return result.changes > 0;
}

/* --- SMTP --- */

export async function getSmtpConfig() {
  const row = await get(`SELECT * FROM smtp_config WHERE id = 1`);
  if (!row) return null;
  let password = "";
  try {
    password = giaiMa(row.password);
  } catch (error) {
    console.warn("[db] Khong giai ma duoc mat khau SMTP:", error.message);
  }
  return {
    host: row.host,
    port: row.port,
    secure: Boolean(row.secure),
    username: row.username,
    password,
    fromAddress: row.from_address,
    updatedAt: row.updated_at,
  };
}

export async function saveSmtpConfig({ host, port, secure, username, password, fromAddress }) {
  await run(
    `UPDATE smtp_config
     SET host = ?, port = ?, secure = ?, username = ?, password = ?, from_address = ?, updated_at = ?
     WHERE id = 1`,
    [
      String(host || ""),
      Number(port) || 587,
      secure ? 1 : 0,
      String(username || ""),
      machHoa(String(password || "")),
      String(fromAddress || ""),
      Math.floor(Date.now() / 1000),
    ]
  );
}
