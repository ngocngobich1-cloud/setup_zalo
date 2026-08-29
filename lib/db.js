import sqlite3 from "sqlite3";
import path from "node:path";
import fs from "node:fs/promises";
import { formatSystemMessage } from "./message-utils.js";
import { daMachHoa, giaiMa, machHoa } from "./crypto-box.js";
import { migrateP9ZaloUidProfile } from "./migrations/p9-zalo-uid-profile.js";

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

/**
 * Them ranh gioi owner cho auto-reply ma khong doan chu cua du lieu cu.
 * Row legacy duoc giu owner_uid = NULL va moi query runtime/UI deu loai chung.
 */
async function ensureAutoReplyOwnerScope() {
  const indexSql = `
    CREATE INDEX IF NOT EXISTS idx_auto_reply_rules_owner_created
    ON auto_reply_rules(owner_uid, created_at)
  `;
  const columns = await all("PRAGMA table_info(auto_reply_rules)");
  if (columns.some((column) => column.name === "owner_uid")) {
    await run(indexSql);
    return;
  }

  let transactionOpen = false;
  try {
    await run("BEGIN IMMEDIATE");
    transactionOpen = true;

    // Kiem tra lai trong write transaction de migration van idempotent neu co
    // hai startup cung cham vao mot DB.
    const lockedColumns = await all("PRAGMA table_info(auto_reply_rules)");
    if (!lockedColumns.some((column) => column.name === "owner_uid")) {
      await run("ALTER TABLE auto_reply_rules ADD COLUMN owner_uid TEXT");
    }
    await run(indexSql);

    const verifiedColumns = await all("PRAGMA table_info(auto_reply_rules)");
    if (!verifiedColumns.some((column) => column.name === "owner_uid")) {
      throw new Error("Khong xac minh duoc cot auto_reply_rules.owner_uid sau migration.");
    }

    await run("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await run("ROLLBACK");
      } catch (rollbackError) {
        console.error("[db] Rollback migration auto-reply owner that bai:", rollbackError.message);
      }
    }
    throw new Error(`Migration auto-reply owner-scoping that bai: ${error.message}`);
  }
}

/**
 * Khoa cuc bo cua mot cuoc tro chuyen = "<uid chu tai khoan>:<id ben Zalo>".
 *
 * Vi sao phai co: id cua Zalo KHONG duy nhat giua cac tai khoan. Chat 1-1 thi
 * id chinh la uid nguoi kia, nhom thi la id nhom - hai tai khoan Zalo khac nhau
 * cung nhan voi mot nguoi (hoac cung o mot nhom) se ra CUNG mot id. De id do lam
 * khoa chinh nhu truoc thi hai tai khoan dam vao mot dong, va cau UPDATE se ghi
 * de quyen so hui - lich su cua tai khoan cu bi gan sang tai khoan moi.
 *
 * Dung chuoi ghep TAT DINH chu khong phai so tu tang: nho vay viec chuyen doi du
 * lieu cu chi la phep noi chuoi, chay lai bao nhieu lan cung ra ket qua nhu nhau,
 * va khong can bang anh xa id.
 */
export function khoaCucBo(ownerUid, remoteThreadId) {
  const chu = ownerUid === null || ownerUid === undefined || ownerUid === "" ? "unknown" : String(ownerUid);
  return `${chu}:${String(remoteThreadId)}`;
}

/** Bang threads con o dang cu (khoa chinh la id cua Zalo, chua co chu so huu)? */
async function soDoThreadsConCu() {
  const cols = await all("PRAGMA table_info(threads)");
  if (!cols.length) return false; // CSDL trong -> tao moi theo dang dung
  return !cols.some((c) => c.name === "owner_uid");
}

export async function initDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  db = new sqlite3.Database(DB_PATH);
  await run("PRAGMA journal_mode = WAL");

  // CHAN DUNG neu CSDL con o so do cu. KHONG tu dong chuyen doi: viec do phai
  // duoc chay co chu dich, sau khi da sao luu (xem chuyenDoiCachLyTaiKhoan).
  // Tu y chuyen doi luc khoi dong la thao tac khong the hoan tac tren du lieu
  // that cua khach - khong duoc phep xay ra chi vi container tinh co restart.
  if (await soDoThreadsConCu()) {
    throw new Error(
      "CSDL dang o so do CU (threads chua co cot owner_uid).\n" +
        "Phai sao luu roi chay chuyen doi cach ly tai khoan truoc khi khoi dong app.\n" +
        "App dung lai de khong lam hong du lieu."
    );
  }

  await run(`
    CREATE TABLE IF NOT EXISTS threads (
      local_id TEXT PRIMARY KEY,
      owner_uid TEXT,
      remote_thread_id TEXT NOT NULL,
      thread_type INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      avatar TEXT,
      last_message TEXT,
      last_message_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE(owner_uid, remote_thread_id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      content TEXT NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0,
      sender_id TEXT,
      sender_name TEXT,
      sender_avatar TEXT,
      msg_type TEXT,
      ts INTEGER NOT NULL,
      raw_json TEXT,
      -- Khoa ghep: msgId cua Zalo KHONG duoc chung minh la duy nhat toan cau.
      -- Neu hai tai khoan cung o mot nhom thi CUNG mot tin se mang CUNG msgId;
      -- de khoa chinh la id khong thi ban ghi thu hai bi INSERT OR IGNORE bo
      -- di lang le, mat du lieu ma khong ai biet.
      PRIMARY KEY (thread_id, id),
      FOREIGN KEY (thread_id) REFERENCES threads(local_id)
    )
  `);
  await run("CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(thread_id, ts)");
  await run("CREATE INDEX IF NOT EXISTS idx_threads_owner ON threads(owner_uid)");
  await addColumnIfMissing("ALTER TABLE threads ADD COLUMN avatar TEXT");
  await addColumnIfMissing("ALTER TABLE messages ADD COLUMN sender_id TEXT");
  await addColumnIfMissing("ALTER TABLE messages ADD COLUMN sender_avatar TEXT");

  // Cau hinh RIENG cho tung tai khoan Zalo. Khong co dong nao = mac dinh an toan
  // (bot TAT, moi lua chon de trong). Nho vay tai khoan B khong bao gio thua
  // huong cong tac bot hay lua chon nhom/nick cua tai khoan A.
  await run(`
    CREATE TABLE IF NOT EXISTS account_config (
      owner_uid TEXT PRIMARY KEY,
      bot_enabled INTEGER NOT NULL DEFAULT 0,
      allowed_group_id TEXT NOT NULL DEFAULT '',
      allowed_sender_ids TEXT NOT NULL DEFAULT '[]',
      otp_zalo_thread_id TEXT NOT NULL DEFAULT '',
      otp_zalo_label TEXT NOT NULL DEFAULT '',
      admin_zalo_uid TEXT NOT NULL DEFAULT '',
      admin_zalo_label TEXT NOT NULL DEFAULT '',
      setup_step INTEGER NOT NULL DEFAULT 0,
      setup_completed INTEGER NOT NULL DEFAULT 0,
      setup_data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  await addColumnIfMissing("ALTER TABLE account_config ADD COLUMN setup_step INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("ALTER TABLE account_config ADD COLUMN setup_completed INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("ALTER TABLE account_config ADD COLUMN setup_data TEXT NOT NULL DEFAULT '{}'");

  await run(`
    CREATE TABLE IF NOT EXISTS auto_reply_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_uid TEXT,
      command TEXT NOT NULL,
      match_anywhere INTEGER NOT NULL DEFAULT 0,
      normalize INTEGER NOT NULL DEFAULT 0,
      reply_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await ensureAutoReplyOwnerScope();

  // P9 migration la atomic va idempotent. Legacy Training khong rong se dung
  // startup truoc khi cham vao AI/profile vi owner cua no chua duoc chung minh.
  await migrateP9ZaloUidProfile({ run, all, get });

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
  // Lich su tra cuu email cung thuoc ve mot tai khoan Zalo cu the.
  await addColumnIfMissing("ALTER TABLE email_tra_cuu ADD COLUMN owner_uid TEXT");

  // Binh chon da tao. Phai luu ma lai thi sau nay moi xem ket qua / chot duoc -
  // Zalo khong cho liet ke binh chon cua mot nhom.
  await run(`
    CREATE TABLE IF NOT EXISTS binh_chon (
      poll_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      dich_ten TEXT NOT NULL DEFAULT '',
      cau_hoi TEXT NOT NULL,
      lua_chon TEXT NOT NULL DEFAULT '[]',
      da_chot INTEGER NOT NULL DEFAULT 0,
      tao_luc INTEGER NOT NULL
    )
  `);

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
  // Lich hen phai biet no thuoc tai khoan Zalo nao. Lich do tai khoan A dat ma
  // dem gui bang phien cua tai khoan B thi tin bay sang nguoi la.
  // Dong cu chua ro chu -> NULL -> khong bao gio den han duoi bat ky tai khoan nao.
  await addColumnIfMissing("ALTER TABLE lich_hen ADD COLUMN owner_uid TEXT");
  // 0 thuong, 1 quan trong, 2 khan - theo dung 3 muc cua Zalo.
  await addColumnIfMissing("ALTER TABLE lich_hen ADD COLUMN khan INTEGER NOT NULL DEFAULT 0");

  // Ho so khach hang. Khoa theo UID Zalo chu KHONG theo cuoc tro chuyen: cung
  // mot nguoi nhan rieng hay noi trong nhom lop thi van la mot ho so.
  await run(`
    CREATE TABLE IF NOT EXISTS customer_memory (
      owner_uid TEXT,
      uid TEXT NOT NULL,
      display_name TEXT,
      profile TEXT NOT NULL DEFAULT '',
      locked INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      -- Cung mot khach hang, hai tai khoan Zalo phai co hai ho so RIENG.
      -- Gop chung theo uid la mang ngu canh cua tai khoan nay sang tai khoan kia.
      PRIMARY KEY (owner_uid, uid)
    )
  `);

  // Chi dan rieng do CHINH CHU SHOP dat ra cho tung nguoi ("noi voi bo thi xung
  // con"). PHAI la cot rieng, khong duoc nhet vao profile: ducKetHoSo() ghi de
  // sach cot profile moi 6 luot khach nhan, nhet vao do thi AI se tu xoa mat
  // cau chi vua day. Cot nay chi lenh admin duoc ghi, AI khong bao gio cham vao.
  await addColumnIfMissing(
    "ALTER TABLE customer_memory ADD COLUMN owner_instruction TEXT NOT NULL DEFAULT ''"
  );

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
  // Legacy Knowledge khong co nguon owner dang tin cay. Them cot nullable va de
  // nguyen NULL de cac truy van owner-scoped ben duoi tu cach ly chung.
  await addColumnIfMissing("ALTER TABLE knowledge_files ADD COLUMN owner_uid TEXT NULL");

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
  // Nhat ky thuoc ve tai khoan Zalo nao. Dong cu chua ro chu -> NULL -> giu lai
  // nhung khong hien duoi bat ky tai khoan nao.
  await addColumnIfMissing("ALTER TABLE activity_logs ADD COLUMN owner_uid TEXT");

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
  // 1 = phai doi mat khau truoc khi dung app. Mac dinh 0: tai khoan da co tu
  // truoc KHONG bao gio bi bat doi lai.
  await addColumnIfMissing("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");

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
  await xoaGroqKeyCu();
}

/**
 * App tung goi Groq truc tiep truoc khi chuyen sang OpenCode. Key do luu THANG
 * vao cot groq_api_key, khong ma hoa, va getAiChatConfig() tra ca cum config do
 * ra /api/ai-chat - tuc la key di thang ve trinh duyet sau khi dang nhap.
 *
 * Duong doc/ghi da go het. Day la buoc don not gia tri con sot lai. Khong DROP
 * COLUMN vi SQLite phai dung lai ca bang, rui ro hon nhieu so voi mot cot rong.
 */
async function xoaGroqKeyCu() {
  const row = await get(`SELECT length(groq_api_key) AS n FROM ai_runtime_config WHERE id = 1`);
  if (!row?.n) return;
  await run(`UPDATE ai_runtime_config SET groq_api_key = '' WHERE id = 1`);
  console.log(`[db] Da xoa Groq API key cu (${row.n} ky tu) khoi CSDL`);
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
    `SELECT thread_id, id, raw_json FROM messages WHERE content LIKE '{%' AND raw_json IS NOT NULL`
  );
  let fixed = 0;
  for (const row of rows) {
    const raw = safeJson(row.raw_json);
    const readable = formatSystemMessage(raw?.data?.content ?? raw?.content);
    if (!readable) continue;
    await run(
      `UPDATE messages SET content = ? WHERE thread_id = ? AND id = ?`,
      [readable, row.thread_id, row.id]
    );
    fixed++;
  }
  if (fixed > 0) {
    console.log(`[db] Da doc lai ${fixed} tin he thong (binh chon/nhom) sang dang de doc`);
  }
  return fixed;
}

/**
 * Danh sach cuoc tro chuyen cua DUNG mot tai khoan Zalo.
 *
 * Khong co chu -> tra ve rong, KHONG tra du lieu lich su. Dong nao owner_uid la
 * NULL (lich su cu khong chung minh duoc chu) cung khong bao gio lot vao day.
 */
export async function listThreads(ownerUid, { recentOnly = true } = {}) {
  if (!ownerUid) return [];
  const them = recentOnly
    ? "AND (last_message IS NOT NULL OR local_id IN (SELECT DISTINCT thread_id FROM messages))"
    : "";
  const rows = await all(
    `
    SELECT local_id, owner_uid, remote_thread_id, thread_type, title, avatar,
           last_message, last_message_at, updated_at
    FROM threads
    WHERE owner_uid = ? ${them}
    ORDER BY COALESCE(last_message_at, updated_at) DESC
  `,
    [String(ownerUid)]
  );
  return rows.map(mapThread);
}

/** Tra ve dong thread neu VA CHI NEU no thuoc ve ownerUid. */
export async function getThread(ownerUid, remoteThreadId) {
  if (!ownerUid) return null;
  const row = await get("SELECT * FROM threads WHERE owner_uid = ? AND remote_thread_id = ?", [
    String(ownerUid),
    String(remoteThreadId),
  ]);
  return row ? mapThread(row) : null;
}

export async function getThreadMessages(ownerUid, remoteThreadId, limit = 500) {
  if (!ownerUid) return [];
  const rows = await all(
    `SELECT m.*, t.remote_thread_id FROM messages m
     INNER JOIN threads t ON t.local_id = m.thread_id
     WHERE t.owner_uid = ? AND t.remote_thread_id = ?
     ORDER BY m.ts DESC LIMIT ?`,
    [String(ownerUid), String(remoteThreadId), limit]
  );
  return rows.reverse().map(mapMessage);
}

function normalizePreviewCandidate(thread) {
  const lastMessage = thread.lastMessage ?? thread.last_message ?? null;
  const rawLastMessageAt = thread.lastMessageAt ?? thread.last_message_at ?? null;
  const lastMessageAt = Number(rawLastMessageAt);
  const completeValidPair = lastMessage !== null
    && rawLastMessageAt !== null
    && Number.isFinite(lastMessageAt)
    && lastMessageAt > 0;

  return completeValidPair
    ? { lastMessage, lastMessageAt }
    : { lastMessage: null, lastMessageAt: null };
}

/**
 * Ghi/cap nhat mot cuoc tro chuyen CHO MOT TAI KHOAN cu the.
 *
 * Bat buoc co ownerUid. Khong co chu thi KHONG ghi - du lieu song khong bao gio
 * duoc gan nhan "unknown"; nhan do chi danh cho lich su cu khong the truy nguon.
 */
export async function upsertThread(ownerUid, thread) {
  if (!ownerUid) throw new Error("upsertThread: thieu ownerUid - khong ghi du lieu Zalo khi chua ro tai khoan.");
  const remoteId = String(thread.remoteThreadId ?? thread.id);
  const localId = khoaCucBo(ownerUid, remoteId);
  const rawThreadType = thread.threadType ?? thread.thread_type;
  // Nguoi goi khong truyen thread_type (vd rebuildThreadsFromMessages) thi phai GIU
  // gia tri cu. Gan cung 0 se bien moi nhom (type 1) thanh chat ca nhan.
  const threadType = rawThreadType === undefined || rawThreadType === null
    ? null
    : Number(rawThreadType);
  const preview = normalizePreviewCandidate(thread);

  await run(
    `
      INSERT INTO threads (local_id, owner_uid, remote_thread_id, thread_type, title, avatar,
                           last_message, last_message_at, updated_at)
      VALUES ($localId, $ownerUid, $remoteId, COALESCE($threadType, 0), $title, $avatar,
              $lastMessage, $lastMessageAt, $updatedAt)
      ON CONFLICT(local_id) DO UPDATE SET
        thread_type = COALESCE($threadType, threads.thread_type),
        title = COALESCE(excluded.title, threads.title),
        avatar = COALESCE(excluded.avatar, threads.avatar),
        last_message = CASE
          WHEN excluded.last_message IS NOT NULL
           AND excluded.last_message_at IS NOT NULL
           AND excluded.last_message_at > 0
           AND (threads.last_message_at IS NULL OR excluded.last_message_at > threads.last_message_at)
          THEN excluded.last_message
          ELSE threads.last_message
        END,
        last_message_at = CASE
          WHEN excluded.last_message IS NOT NULL
           AND excluded.last_message_at IS NOT NULL
           AND excluded.last_message_at > 0
           AND (threads.last_message_at IS NULL OR excluded.last_message_at > threads.last_message_at)
          THEN excluded.last_message_at
          ELSE threads.last_message_at
        END,
        updated_at = excluded.updated_at
    `,
    {
      $localId: localId,
      $ownerUid: String(ownerUid),
      $remoteId: remoteId,
      $threadType: threadType,
      $title: thread.title ?? null,
      $avatar: thread.avatar ?? null,
      $lastMessage: preview.lastMessage,
      $lastMessageAt: preview.lastMessageAt,
      $updatedAt: Date.now(),
    }
  );
  return getThread(ownerUid, remoteId);
}

/**
 * Ghi mot tin nhan vao dung cuoc tro chuyen cua tai khoan dang dang nhap.
 * Tao thread neu chua co - van la tao trong pham vi tai khoan do.
 */
export async function insertMessage(ownerUid, message) {
  if (!ownerUid) throw new Error("insertMessage: thieu ownerUid - khong ghi tin nhan khi chua ro tai khoan.");
  const remoteId = String(message.threadId);
  const localId = khoaCucBo(ownerUid, remoteId);

  // Thread phai ton tai truoc vi messages.thread_id co khoa ngoai tro toi no.
  await run(
    `INSERT OR IGNORE INTO threads (local_id, owner_uid, remote_thread_id, thread_type, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [localId, String(ownerUid), remoteId, Number(message.threadType ?? 0), Date.now()]
  );

  // Van OR IGNORE, nhung gio khoa la (thread_id, id) nen chi bo qua ban trung
  // TRONG CUNG mot cuoc tro chuyen - khong con bo nham ban sao hop le cua tai
  // khoan khac nua.
  return await run(
    `
      INSERT OR IGNORE INTO messages
        (id, thread_id, content, is_self, sender_id, sender_name, sender_avatar, msg_type, ts, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      message.id,
      localId,
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

/**
 * Dung lai dong tom tat cua tung cuoc tro chuyen tu tin nhan da luu.
 * CHI trong pham vi mot tai khoan - khong gop danh muc chung cua moi tai khoan.
 */
export async function rebuildThreadsFromMessages(ownerUid) {
  if (!ownerUid) return;
  const rows = await all(
    `
    SELECT m.thread_id, m.content, m.ts
    FROM messages m
    INNER JOIN threads t ON t.local_id = m.thread_id
    INNER JOIN (
      SELECT thread_id, MAX(ts) AS max_ts
      FROM messages
      GROUP BY thread_id
    ) latest ON latest.thread_id = m.thread_id AND latest.max_ts = m.ts
    WHERE t.owner_uid = ?
  `,
    [String(ownerUid)]
  );
  for (const row of rows) {
    const preview = normalizePreviewCandidate({
      lastMessage: row.content,
      lastMessageAt: row.ts,
    });
    await run(
      `UPDATE threads
       SET last_message = CASE
             WHEN $lastMessage IS NOT NULL
              AND $lastMessageAt IS NOT NULL
              AND $lastMessageAt > 0
              AND (last_message_at IS NULL OR $lastMessageAt > last_message_at)
             THEN $lastMessage
             ELSE last_message
           END,
           last_message_at = CASE
             WHEN $lastMessage IS NOT NULL
              AND $lastMessageAt IS NOT NULL
              AND $lastMessageAt > 0
              AND (last_message_at IS NULL OR $lastMessageAt > last_message_at)
             THEN $lastMessageAt
             ELSE last_message_at
           END,
           updated_at = $updatedAt
       WHERE local_id = $localId AND owner_uid = $ownerUid`,
      {
        $lastMessage: preview.lastMessage,
        $lastMessageAt: preview.lastMessageAt,
        $updatedAt: Date.now(),
        $localId: row.thread_id,
        $ownerUid: String(ownerUid),
      }
    );
  }
}

/**
 * Doi ve hinh dang CU ma trinh duyet dang dung: `id` van la id ben Zalo.
 * Nho vay khong phai sua mot dong nao trong public/.
 */
function mapThread(row) {
  return {
    id: row.remote_thread_id,
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
    // Tra ve id ben Zalo chu khong phai khoa cuc bo: trinh duyet va cac lop tren
    // van lam viec voi id cua Zalo nhu truoc.
    threadId: row.remote_thread_id ?? row.thread_id,
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

function requireAutoReplyOwnerUid(ownerUid) {
  const owner = typeof ownerUid === "string" ? ownerUid.trim() : "";
  if (!owner) throw new Error("Thieu ownerUid cho auto-reply.");
  return owner;
}

export async function getAutoReplyRules(ownerUid) {
  const owner = requireAutoReplyOwnerUid(ownerUid);
  return await all(
    `SELECT id, command, match_anywhere, normalize, reply_text, created_at
     FROM auto_reply_rules
     WHERE owner_uid = ?
     ORDER BY created_at ASC`,
    [owner]
  );
}

export async function insertAutoReplyRule(ownerUid, rule) {
  const owner = requireAutoReplyOwnerUid(ownerUid);
  const result = await run(
    `INSERT INTO auto_reply_rules
       (owner_uid, command, match_anywhere, normalize, reply_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      owner,
      rule.command,
      rule.match_anywhere ? 1 : 0,
      rule.normalize ? 1 : 0,
      rule.reply_text,
      Date.now()
    ]
  );
  return result;
}

export async function updateAutoReplyRule(ownerUid, id, rule) {
  const owner = requireAutoReplyOwnerUid(ownerUid);
  const result = await run(
    `UPDATE auto_reply_rules
     SET command = ?, match_anywhere = ?, normalize = ?, reply_text = ?
     WHERE owner_uid = ? AND id = ?`,
    [
      rule.command,
      rule.match_anywhere ? 1 : 0,
      rule.normalize ? 1 : 0,
      rule.reply_text,
      owner,
      id
    ]
  );
  return result;
}

export async function deleteAutoReplyRule(ownerUid, id) {
  const owner = requireAutoReplyOwnerUid(ownerUid);
  await run(
    `DELETE FROM auto_reply_rules WHERE owner_uid = ? AND id = ?`,
    [owner, id]
  );
}

export async function getAiRuntimeConfig() {
  const row = await get(`SELECT * FROM ai_runtime_config WHERE id = 1`);
  if (!row) return {
    opencodeBaseUrl: "http://opencode:4096",
    opencodeAgent: "general",
    docTep: false,
  };
  return {
    opencodeBaseUrl: row.opencode_base_url || "http://opencode:4096",
    opencodeAgent: row.opencode_agent || "general",
    docTep: Boolean(row.doc_tep),
    runtimeUpdatedAt: row.updated_at,
  };
}

export async function getAiChatConfig(ownerUid) {
  if (!ownerUid) return null;
  const [runtime, row] = await Promise.all([
    getAiRuntimeConfig(),
    get(`SELECT * FROM ai_chat_config WHERE owner_uid = ?`, [String(ownerUid)]),
  ]);
  return {
    allowedTopics: row?.allowed_topics || "",
    roleTone: row?.role_tone || "",
    useKnowledge: Boolean(row?.use_knowledge),
    knowledgeFileIds: (safeJson(row?.knowledge_file_ids) || [])
      .map(Number)
      .filter(Number.isInteger),
    soul: row?.soul || "",
    opencodeModel: row?.opencode_model || "",
    ...runtime,
    updatedAt: row?.updated_at || null,
  };
}

export async function setDocTep(bat) {
  await run(
    `UPDATE ai_runtime_config SET doc_tep = ?, updated_at = strftime('%s','now') WHERE id = 1`,
    [bat ? 1 : 0]
  );
}

/* --- CAU HINH RIENG TUNG TAI KHOAN ZALO --- */

/** Mac dinh an toan khi tai khoan chua co dong cau hinh nao. */
const CAU_HINH_TAI_KHOAN_MAC_DINH = {
  botEnabled: false,
  allowedGroupId: "",
  allowedSenderIds: [],
  otpZaloThreadId: "",
  otpZaloLabel: "",
  adminZaloUid: "",
  adminZaloLabel: "",
  setupStep: 0,
  setupCompleted: false,
  setupData: {},
};

/**
 * Doc cau hinh cua DUNG tai khoan dang dang nhap.
 * Khong co tai khoan, hoac tai khoan chua tung luu gi -> tra ve mac dinh TAT.
 * Tuyet doi khong roi ve cau hinh toan cuc cu: nhu vay la tai khoan B thua
 * huong cong tac bot cua tai khoan A.
 */
export async function getAccountConfig(ownerUid) {
  if (!ownerUid) return { ...CAU_HINH_TAI_KHOAN_MAC_DINH };
  const row = await get(`SELECT * FROM account_config WHERE owner_uid = ?`, [String(ownerUid)]);
  if (!row) return { ...CAU_HINH_TAI_KHOAN_MAC_DINH };
  return {
    botEnabled: Boolean(row.bot_enabled),
    allowedGroupId: row.allowed_group_id || "",
    allowedSenderIds: safeJson(row.allowed_sender_ids) || [],
    otpZaloThreadId: row.otp_zalo_thread_id || "",
    otpZaloLabel: row.otp_zalo_label || "",
    adminZaloUid: row.admin_zalo_uid || "",
    adminZaloLabel: row.admin_zalo_label || "",
    setupStep: Math.max(0, Math.min(9, Number(row.setup_step) || 0)),
    setupCompleted: Boolean(row.setup_completed),
    setupData: safeJson(row.setup_data) || {},
    updatedAt: row.updated_at,
  };
}

/** Ghi cau hinh tai khoan. Chi dat truong duoc truyen, truong khac giu nguyen. */
export async function saveAccountConfig(ownerUid, patch = {}) {
  if (!ownerUid) throw new Error("saveAccountConfig: thieu ownerUid.");
  const now = Math.floor(Date.now() / 1000);
  await run(
    `
      INSERT INTO account_config (owner_uid, bot_enabled, allowed_group_id, allowed_sender_ids,
                                  otp_zalo_thread_id, otp_zalo_label, admin_zalo_uid, admin_zalo_label,
                                  setup_step, setup_completed, setup_data, updated_at)
      VALUES ($ownerUid, COALESCE($botEnabled,0), COALESCE($groupId,''), COALESCE($senderIds,'[]'),
              COALESCE($otpThread,''), COALESCE($otpLabel,''), COALESCE($adminUid,''), COALESCE($adminLabel,''),
              COALESCE($setupStep,0), COALESCE($setupCompleted,0), COALESCE($setupData,'{}'), $now)
      ON CONFLICT(owner_uid) DO UPDATE SET
        bot_enabled        = COALESCE($botEnabled, account_config.bot_enabled),
        allowed_group_id   = COALESCE($groupId, account_config.allowed_group_id),
        allowed_sender_ids = COALESCE($senderIds, account_config.allowed_sender_ids),
        otp_zalo_thread_id = COALESCE($otpThread, account_config.otp_zalo_thread_id),
        otp_zalo_label     = COALESCE($otpLabel, account_config.otp_zalo_label),
        admin_zalo_uid     = COALESCE($adminUid, account_config.admin_zalo_uid),
        admin_zalo_label   = COALESCE($adminLabel, account_config.admin_zalo_label),
        setup_step         = COALESCE($setupStep, account_config.setup_step),
        setup_completed    = COALESCE($setupCompleted, account_config.setup_completed),
        setup_data         = COALESCE($setupData, account_config.setup_data),
        updated_at         = $now
    `,
    {
      $ownerUid: String(ownerUid),
      $botEnabled: patch.botEnabled === undefined ? null : patch.botEnabled ? 1 : 0,
      $groupId: patch.allowedGroupId === undefined ? null : String(patch.allowedGroupId || ""),
      $senderIds: patch.allowedSenderIds === undefined ? null : JSON.stringify(patch.allowedSenderIds || []),
      $otpThread: patch.otpZaloThreadId === undefined ? null : String(patch.otpZaloThreadId || ""),
      $otpLabel: patch.otpZaloLabel === undefined ? null : String(patch.otpZaloLabel || ""),
      $adminUid: patch.adminZaloUid === undefined ? null : String(patch.adminZaloUid || ""),
      $adminLabel: patch.adminZaloLabel === undefined ? null : String(patch.adminZaloLabel || ""),
      $setupStep: patch.setupStep === undefined ? null : Math.max(0, Math.min(9, Number(patch.setupStep) || 0)),
      $setupCompleted: patch.setupCompleted === undefined ? null : patch.setupCompleted ? 1 : 0,
      $setupData: patch.setupData === undefined ? null : JSON.stringify(patch.setupData || {}),
      $now: now,
    }
  );
  return getAccountConfig(ownerUid);
}

export async function setBotEnabled(ownerUid, enabled) {
  if (!ownerUid) throw new Error("setBotEnabled: thieu ownerUid - khong doi cong tac bot khi chua ro tai khoan.");
  return saveAccountConfig(ownerUid, { botEnabled: Boolean(enabled) });
}

export async function getOpencodeSession(ownerUid, threadId) {
  if (!ownerUid) return null;
  const row = await get(`SELECT * FROM opencode_sessions WHERE thread_id = ?`, [khoaCucBo(ownerUid, threadId)]);
  return row ? row.session_id : null;
}

/** Nhu tren nhung kem so luot, de biet phien da den luc xoay chua. */
export async function getOpencodeSessionInfo(ownerUid, threadId) {
  if (!ownerUid) return null;
  const row = await get(`SELECT * FROM opencode_sessions WHERE thread_id = ?`, [khoaCucBo(ownerUid, threadId)]);
  return row ? { sessionId: row.session_id, turns: row.turns || 0, createdAt: row.created_at } : null;
}

export async function bumpSessionTurns(ownerUid, threadId) {
  if (!ownerUid) return;
  await run(`UPDATE opencode_sessions SET turns = turns + 1 WHERE thread_id = ?`, [khoaCucBo(ownerUid, threadId)]);
}

export async function saveOpencodeSession(ownerUid, threadId, sessionId) {
  if (!ownerUid) throw new Error("saveOpencodeSession: thieu ownerUid.");
  await run(
    `INSERT INTO opencode_sessions (thread_id, session_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id, created_at = excluded.created_at`,
    [khoaCucBo(ownerUid, threadId), String(sessionId), Math.floor(Date.now() / 1000)]
  );
}

export async function deleteOpencodeSession(ownerUid, threadId) {
  if (!ownerUid) return;
  await run(`DELETE FROM opencode_sessions WHERE thread_id = ?`, [khoaCucBo(ownerUid, threadId)]);
}

/**
 * Tra ve danh sach session_id vua bo, de nguoi goi con xoa han chung ben
 * OpenCode. Chi xoa dong o day thi session mo coi nam lai trong opencode-data
 * mai mai, khong ai don.
 */
export async function clearOpencodeSessions(ownerUid) {
  if (!ownerUid) throw new Error("clearOpencodeSessions: thieu ownerUid.");
  const rows = await all(
    `SELECT s.session_id
     FROM opencode_sessions s
     JOIN threads t ON t.local_id = s.thread_id
     WHERE t.owner_uid = ?`,
    [String(ownerUid)]
  );
  await run(
    `DELETE FROM opencode_sessions
     WHERE thread_id IN (SELECT local_id FROM threads WHERE owner_uid = ?)`,
    [String(ownerUid)]
  );
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

export async function ghiTraCuu({ ownerUid = null, nguon, nguoiHoiTen, nguoiHoiUid, emailTra, ketQua, guiLuc, tieuDe, chiTiet }) {
  await run(
    `INSERT INTO email_tra_cuu (owner_uid, luc, nguon, nguoi_hoi_ten, nguoi_hoi_uid, email_tra, ket_qua, gui_luc, tieu_de, chi_tiet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerUid ? String(ownerUid) : null,
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

export async function xoaLichSuTraCuu(ownerUid) {
  if (!ownerUid) return 0;
  const truoc = await get(`SELECT COUNT(*) AS n FROM email_tra_cuu WHERE owner_uid = ?`, [String(ownerUid)]);
  await run(`DELETE FROM email_tra_cuu WHERE owner_uid = ?`, [String(ownerUid)]);
  return truoc?.n || 0;
}

export async function listTraCuu(ownerUid, gioiHan = 50) {
  if (!ownerUid) return [];
  const rows = await all(`SELECT * FROM email_tra_cuu WHERE owner_uid = ? ORDER BY luc DESC LIMIT ?`, [String(ownerUid), Number(gioiHan)]);
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

/* --- BINH CHON --- */

export async function themBinhChon({ pollId, threadId, dichTen, cauHoi, luaChon }) {
  await run(
    `INSERT OR REPLACE INTO binh_chon (poll_id, thread_id, dich_ten, cau_hoi, lua_chon, da_chot, tao_luc)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [String(pollId), String(threadId), String(dichTen || ""), String(cauHoi), JSON.stringify(luaChon || []), Math.floor(Date.now() / 1000)]
  );
}

export async function listBinhChon(gioiHan = 20) {
  const rows = await all(`SELECT * FROM binh_chon ORDER BY tao_luc DESC LIMIT ?`, [Number(gioiHan)]);
  return rows.map((r) => ({
    pollId: r.poll_id,
    threadId: r.thread_id,
    dichTen: r.dich_ten,
    cauHoi: r.cau_hoi,
    luaChon: safeJson(r.lua_chon) || [],
    daChot: Boolean(r.da_chot),
    taoLuc: r.tao_luc,
  }));
}

export async function danhDauChotBinhChon(pollId) {
  await run(`UPDATE binh_chon SET da_chot = 1 WHERE poll_id = ?`, [String(pollId)]);
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
    khan: row.khan || 0,
    trangThai: row.trang_thai,
    cauLenh: row.cau_lenh || "",
    taoLuc: row.tao_luc,
    guiLuc: row.gui_luc || null,
    ghiChu: row.ghi_chu || "",
  };
}

export async function themLichHen(ownerUid, { dichId, dichTen, loai, noiDung, lucGui, lapLai, cauLenh, khan }) {
  // Lich phai mang ten chu ngay tu luc tao: dem gui, dong ho se chi lay lich cua
  // dung tai khoan dang dang nhap.
  if (!ownerUid) throw new Error("themLichHen: thieu ownerUid - khong dat lich khi chua ro tai khoan.");
  const result = await run(
    `INSERT INTO lich_hen (dich_id, dich_ten, loai, noi_dung, luc_gui, lap_lai, trang_thai, cau_lenh, tao_luc, khan, owner_uid)
     VALUES (?, ?, ?, ?, ?, ?, 'cho', ?, ?, ?, ?)`,
    [
      String(dichId),
      String(dichTen || dichId),
      loai === "nhom" ? "nhom" : "nick",
      String(noiDung),
      Number(lucGui),
      String(lapLai || ""),
      String(cauLenh || ""),
      Math.floor(Date.now() / 1000),
      Number(khan) || 0,
      String(ownerUid),
    ]
  );
  return getLichHen(result.lastID);
}

export async function getLichHen(id) {
  const row = await get(`SELECT * FROM lich_hen WHERE id = ?`, [Number(id)]);
  return row ? mapLichHen(row) : null;
}

/** Cac lich da toi gio ma chua gui. Cu nhat truoc de gui dung thu tu. */
/**
 * Lich den han CUA DUNG mot tai khoan Zalo.
 * Lich cua tai khoan khac - va lich cu chua ro chu (owner_uid NULL) - khong bao
 * gio den han, vi gui bang phien cua tai khoan dang dang nhap la gui nham nguoi.
 */
export async function layLichDenHan(ownerUid, mocGiay) {
  if (!ownerUid) return [];
  const rows = await all(
    `SELECT * FROM lich_hen WHERE trang_thai = 'cho' AND luc_gui <= ? AND owner_uid = ? ORDER BY luc_gui ASC`,
    [Number(mocGiay), String(ownerUid)]
  );
  return rows.map(mapLichHen);
}

/** Lich hen CUA MOT tai khoan. Dong cu chua ro chu khong bao gio hien ra. */
export async function listLichHen(ownerUid, { chiChoGui = false, gioiHan = 100 } = {}) {
  if (!ownerUid) return [];
  const rows = await all(
    chiChoGui
      ? `SELECT * FROM lich_hen WHERE owner_uid = ? AND trang_thai = 'cho' ORDER BY luc_gui ASC LIMIT ?`
      : `SELECT * FROM lich_hen WHERE owner_uid = ? ORDER BY (trang_thai = 'cho') DESC, luc_gui DESC LIMIT ?`,
    [String(ownerUid), Number(gioiHan)]
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
export async function huyLichHen(ownerUid, id) {
  // Khong co chu, hoac lich khong thuoc tai khoan nay -> khong huy duoc.
  if (!ownerUid) return false;
  const result = await run(
    `UPDATE lich_hen SET trang_thai = 'da_huy' WHERE id = ? AND owner_uid = ? AND trang_thai = 'cho'`,
    [Number(id), String(ownerUid)]
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

export async function getCustomerMemory(ownerUid, uid) {
  if (!ownerUid || !uid) return null;
  const row = await get(`SELECT * FROM customer_memory WHERE owner_uid = ? AND uid = ?`, [
    String(ownerUid),
    String(uid),
  ]);
  return row ? mapCustomer(row) : null;
}

export async function listCustomerMemories(ownerUid) {
  if (!ownerUid) return [];
  const rows = await all(`SELECT * FROM customer_memory WHERE owner_uid = ? ORDER BY updated_at DESC`, [
    String(ownerUid),
  ]);
  return rows.map(mapCustomer);
}

/** Ghi ho so. Chi dat nhung truong duoc truyen, cac truong khac giu nguyen. */
export async function saveCustomerMemory(ownerUid, { uid, displayName, profile, locked }) {
  if (!ownerUid) throw new Error("saveCustomerMemory: thieu ownerUid - khong ghi ho so khi chua ro tai khoan.");
  if (!uid) throw new Error("Thiếu UID khách hàng");
  const now = Math.floor(Date.now() / 1000);
  await run(
    `
      INSERT INTO customer_memory (owner_uid, uid, display_name, profile, locked, turns, created_at, updated_at)
      VALUES ($ownerUid, $uid, $displayName, COALESCE($profile, ''), COALESCE($locked, 0), 0, $now, $now)
      ON CONFLICT(owner_uid, uid) DO UPDATE SET
        display_name = COALESCE($displayName, customer_memory.display_name),
        profile      = COALESCE($profile, customer_memory.profile),
        locked       = COALESCE($locked, customer_memory.locked),
        updated_at   = $now
    `,
    {
      $ownerUid: String(ownerUid),
      $uid: String(uid),
      $displayName: displayName ?? null,
      $profile: profile ?? null,
      $locked: locked === undefined || locked === null ? null : locked ? 1 : 0,
      $now: now,
    }
  );
  return getCustomerMemory(ownerUid, uid);
}

/** Tang bo dem luot cua khach va tra ve so moi. Tao dong neu chua co. */
/**
 * Bo dem luot noi chuyen. Khoa chinh cua bang la (owner_uid, uid) nen BAT BUOC
 * co ca hai - thieu chu se tao ra dong mo coi owner_uid NULL, va bo dem cua tai
 * khoan nay se de len tai khoan kia.
 */
export async function bumpCustomerTurns(ownerUid, uid, displayName) {
  if (!ownerUid || !uid) return 0;
  const now = Math.floor(Date.now() / 1000);
  await run(
    `
      INSERT INTO customer_memory (owner_uid, uid, display_name, profile, locked, turns, created_at, updated_at)
      VALUES ($ownerUid, $uid, $displayName, '', 0, 1, $now, $now)
      ON CONFLICT(owner_uid, uid) DO UPDATE SET
        turns = customer_memory.turns + 1,
        display_name = COALESCE($displayName, customer_memory.display_name)
    `,
    { $ownerUid: String(ownerUid), $uid: String(uid), $displayName: displayName || null, $now: now }
  );
  const row = await get(`SELECT turns FROM customer_memory WHERE owner_uid = ? AND uid = ?`, [String(ownerUid), String(uid)]);
  return row?.turns || 0;
}

export async function resetCustomerTurns(ownerUid, uid) {
  if (!ownerUid || !uid) return;
  await run(`UPDATE customer_memory SET turns = 0 WHERE owner_uid = ? AND uid = ?`, [String(ownerUid), String(uid)]);
}

export async function deleteCustomerMemory(ownerUid, uid) {
  if (!ownerUid) return { changes: 0 };
  await run(`DELETE FROM customer_memory WHERE owner_uid = ? AND uid = ?`, [String(ownerUid), String(uid)]);
}

/* --- CHI DAN RIENG CUA CHU SHOP CHO TUNG NGUOI ---
 *
 * Hai vung du lieu TACH HAN nhau tren cung mot dong:
 *   profile           -> AI viet, AI duoc ghi de (ducKetHoSo).
 *   owner_instruction -> chi lenh admin viet, AI KHONG BAO GIO cham vao.
 *
 * Ba ham duoi day co y KHONG dung lai saveCustomerMemory(): ham do COALESCE ca
 * display_name/profile/locked, tuc la mot lenh day co the vo tinh gianh quyen
 * ghi len du lieu cua AI. O day moi cau lenh chi dung dung nhung cot no so huu.
 */

/** Doc chi dan rieng. Thuan doc, khong bao gio ghi. Khong ro chu -> chuoi rong. */
export async function getOwnerInstruction(ownerUid, uid) {
  if (!ownerUid || !uid) return "";
  const row = await get(
    `SELECT owner_instruction FROM customer_memory WHERE owner_uid = ? AND uid = ?`,
    [String(ownerUid), String(uid)]
  );
  return row?.owner_instruction || "";
}

/**
 * Ghi chi dan rieng (day_ghi_nho / day_sua).
 *
 * Dong DA CO: chi duoc doi owner_instruction va updated_at. Menh de VALUES ben
 * duoi chi chay cho nhanh INSERT; nhanh xung dot khong tham chieu excluded.* nen
 * profile/display_name/locked/turns/created_at cua dong cu khong the bi cham toi.
 */
export async function setOwnerInstruction(ownerUid, { uid, instruction, displayName }) {
  if (!ownerUid) throw new Error("setOwnerInstruction: thieu ownerUid - khong ghi khi chua ro tai khoan.");
  if (!uid) throw new Error("Thiếu UID khách hàng");
  const now = Math.floor(Date.now() / 1000);
  await run(
    `
      INSERT INTO customer_memory
        (owner_uid, uid, display_name, profile, locked, turns, owner_instruction, created_at, updated_at)
      VALUES
        ($ownerUid, $uid, $displayName, '', 0, 0, $instruction, $now, $now)
      ON CONFLICT(owner_uid, uid) DO UPDATE SET
        owner_instruction = $instruction,
        updated_at        = $now
    `,
    {
      $ownerUid: String(ownerUid),
      $uid: String(uid),
      $displayName: displayName || null,
      $instruction: String(instruction ?? ""),
      $now: now,
    }
  );
  return getOwnerInstruction(ownerUid, uid);
}

/**
 * Xoa chi dan rieng (day_quen).
 *
 * La UPDATE thuan nen KHONG BAO GIO de ra dong moi: quen mot chi dan chua tung
 * ton tai thi khong duoc tao ho so rong cho nguoi ta. Dieu kien owner_instruction
 * <> '' khien changes === 0 mang dung nghia "von chang co gi de quen", de lenh
 * admin bao lai cho chi that long thay vi bao thanh cong gia.
 */
export async function clearOwnerInstruction(ownerUid, uid) {
  if (!ownerUid || !uid) return { changes: 0 };
  const now = Math.floor(Date.now() / 1000);
  const result = await run(
    `UPDATE customer_memory
        SET owner_instruction = '', updated_at = ?
      WHERE owner_uid = ? AND uid = ? AND owner_instruction <> ''`,
    [now, String(ownerUid), String(uid)]
  );
  return { changes: result?.changes || 0 };
}

/* --- PHIEN HUAN LUYEN --- */

export async function getTrainingSessionId(ownerUid) {
  if (!ownerUid) return null;
  const row = await get(`SELECT session_id FROM training_session WHERE owner_uid = ?`, [String(ownerUid)]);
  return row?.session_id || null;
}

export async function saveTrainingSessionId(ownerUid, sessionId) {
  if (!ownerUid) throw new Error("saveTrainingSessionId: thieu ownerUid.");
  await run(
    `INSERT INTO training_session (owner_uid, session_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(owner_uid) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    [String(ownerUid), String(sessionId || ""), Math.floor(Date.now() / 1000)]
  );
}

export async function addTrainingMessage(ownerUid, { role, content, files }) {
  if (!ownerUid) throw new Error("addTrainingMessage: thieu ownerUid.");
  const result = await run(
    `INSERT INTO training_messages (owner_uid, role, content, files, created_at) VALUES (?, ?, ?, ?, ?)`,
    [String(ownerUid), role, String(content || ""), files?.length ? JSON.stringify(files) : null, Math.floor(Date.now() / 1000)]
  );
  return result.lastID;
}

export async function getTrainingMessages(ownerUid, limit = 200) {
  if (!ownerUid) return [];
  const rows = await all(
    `SELECT * FROM training_messages WHERE owner_uid = ? ORDER BY id ASC LIMIT ?`,
    [String(ownerUid), Math.min(500, Math.max(1, Number(limit) || 200))]
  );
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    files: row.files ? safeJson(row.files) || [] : [],
    createdAt: row.created_at,
  }));
}

export async function clearTrainingMessages(ownerUid) {
  if (!ownerUid) throw new Error("clearTrainingMessages: thieu ownerUid.");
  await run("BEGIN IMMEDIATE");
  try {
    await run(`DELETE FROM training_messages WHERE owner_uid = ?`, [String(ownerUid)]);
    await run(`DELETE FROM training_session WHERE owner_uid = ?`, [String(ownerUid)]);
    await run("COMMIT");
  } catch (error) {
    await run("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Cau hinh CHUNG cho moi tai khoan Zalo: giong dieu, chu de, Soul, tri thuc,
 * dia chi OpenCode.
 *
 * KHONG con nhan allowedGroupId / allowedSenderIds nua. Hai truong do thuoc ve
 * TUNG TAI KHOAN va nam trong account_config; truoc day server ghi chung vao
 * bang toan cuc nay trong khi luc doc lai doc tu account_config, nen lua chon
 * nhom/nick cua nguoi dung khong bao gio co tac dung.
 * Hai cot cu trong ai_chat_config duoc GIU LAI (khong xoa) de tuong thich nguoc,
 * nhung tu gio khong ai ghi vao chung nua.
 */
export async function saveAiChatConfig(ownerUid, {
  allowedTopics,
  roleTone,
  useKnowledge,
  knowledgeFileIds,
  soul,
  opencodeBaseUrl,
  opencodeAgent,
  opencodeModel,
}) {
  if (!ownerUid) throw new Error("saveAiChatConfig: thieu ownerUid - khong ghi global fallback.");
  const knowledgeIdsStr = JSON.stringify(
    (Array.isArray(knowledgeFileIds) ? knowledgeFileIds : []).map(Number).filter(Number.isInteger)
  );
  if (opencodeBaseUrl !== undefined || opencodeAgent !== undefined) {
    await run(
      `UPDATE ai_runtime_config
       SET opencode_base_url = COALESCE(?, opencode_base_url),
           opencode_agent = COALESCE(?, opencode_agent),
           updated_at = strftime('%s','now')
       WHERE id = 1`,
      [
        opencodeBaseUrl === undefined ? null : String(opencodeBaseUrl || ""),
        opencodeAgent === undefined ? null : String(opencodeAgent || "general"),
      ]
    );
  }
  await run(
    `INSERT INTO ai_chat_config
       (owner_uid, allowed_topics, role_tone, use_knowledge, knowledge_file_ids, soul, opencode_model, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
     ON CONFLICT(owner_uid) DO UPDATE SET
       allowed_topics = excluded.allowed_topics,
       role_tone = excluded.role_tone,
       use_knowledge = excluded.use_knowledge,
       knowledge_file_ids = excluded.knowledge_file_ids,
       soul = excluded.soul,
       opencode_model = excluded.opencode_model,
       updated_at = excluded.updated_at`,
    [
      String(ownerUid),
      allowedTopics || '',
      roleTone || '',
      useKnowledge ? 1 : 0,
      knowledgeIdsStr,
      soul || '',
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
export async function getAllKnowledgeFiles(ownerUid) {
  if (!ownerUid) return [];
  const rows = await all(
    `SELECT id, original_name, file_ext, file_size, char_count, created_at
     FROM knowledge_files WHERE owner_uid = ? ORDER BY created_at DESC, id DESC`,
    [String(ownerUid)]
  );
  return rows.map(mapKnowledgeRow);
}

export async function getKnowledgeFileById(ownerUid, id) {
  if (!ownerUid) return null;
  const row = await get(
    `SELECT * FROM knowledge_files WHERE id = ? AND owner_uid = ?`,
    [Number(id), String(ownerUid)]
  );
  return row ? mapKnowledgeRow(row) : null;
}

export async function getKnowledgeFilesByIds(ownerUid, ids) {
  if (!ownerUid) return [];
  const safeIds = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (safeIds.length === 0) return [];
  const placeholders = safeIds.map(() => "?").join(", ");
  const rows = await all(
    `SELECT * FROM knowledge_files WHERE owner_uid = ? AND id IN (${placeholders}) ORDER BY id ASC`,
    [String(ownerUid), ...safeIds]
  );
  return rows.map(mapKnowledgeRow);
}

export async function createKnowledgeFile(ownerUid, { originalName, fileExt, contentMd, fileSize }) {
  if (!ownerUid) throw new Error("createKnowledgeFile: thieu ownerUid.");
  const ownerKey = String(ownerUid);
  const result = await run(
    `INSERT INTO knowledge_files (owner_uid, original_name, file_ext, content_md, file_size, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerKey,
      originalName,
      fileExt,
      contentMd,
      Number(fileSize) || 0,
      contentMd.length,
      Math.floor(Date.now() / 1000),
    ]
  );
  return getKnowledgeFileById(ownerKey, result.lastID);
}

export async function deleteKnowledgeFile(ownerUid, id) {
  if (!ownerUid) return false;
  const result = await run(
    `DELETE FROM knowledge_files WHERE id = ? AND owner_uid = ?`,
    [Number(id), String(ownerUid)]
  );
  return result.changes > 0;
}

/* --- NHAT KY HOAT DONG --- */

const ACTIVITY_LOG_LIMIT = 500;

function mapLogRow(row) {
  return {
    id: row.id,
    // Kem theo chu so huu de ben nhan realtime con loc duoc.
    ownerUid: row.owner_uid || null,
    event: row.event,
    level: row.level,
    summary: row.summary,
    detail: row.detail ? safeJson(row.detail) : null,
    createdAt: row.created_at,
  };
}

export async function insertActivityLog({ ownerUid = null, event, level, summary, detail }) {
  const result = await run(
    `INSERT INTO activity_logs (owner_uid, event, level, summary, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      ownerUid ? String(ownerUid) : null,
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

/** Nhat ky cua DUNG mot tai khoan. Khong co chu -> rong (dong cua). */
export async function getActivityLogs(ownerUid, limit = 150) {
  if (!ownerUid) return [];
  const safeLimit = Math.min(ACTIVITY_LOG_LIMIT, Math.max(1, Number(limit) || 150));
  const rows = await all(
    `SELECT * FROM activity_logs WHERE owner_uid = ? ORDER BY id DESC LIMIT ?`,
    [String(ownerUid), safeLimit]
  );
  return rows.map(mapLogRow);
}

export async function clearActivityLogs(ownerUid) {
  // Chi xoa log CUA MINH. Dong cu (owner_uid NULL) va log cua tai khoan khac
  // khong bao gio bi cuon theo.
  if (!ownerUid) return;
  await run(`DELETE FROM activity_logs WHERE owner_uid = ?`, [String(ownerUid)]);
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
    mustChangePassword: Boolean(row.must_change_password),
    updatedAt: row.updated_at,
  };
}

/** Nick Zalo duoc quyen ra lenh. Doc truc tiep tu DB moi lan de doi cau hinh la an ngay. */
export async function getAdminZalo(ownerUid) {
  // Khong ro tai khoan -> khong ai duoc quyen ra lenh cho bot (dong cua).
  if (!ownerUid) return { uid: "", label: "" };
  const c = await getAccountConfig(ownerUid);
  return { uid: c.adminZaloUid || "", label: c.adminZaloLabel || "" };
}

/**
 * Nick Zalo duoc quyen ra lenh cho bot - luu THEO TUNG TAI KHOAN.
 * Nick cua tai khoan A khong duoc phep sai khien bot khi tai khoan B dang chay.
 */
export async function setAdminZalo(ownerUid, uid, label) {
  if (!ownerUid) throw new Error("setAdminZalo: thieu ownerUid.");
  await saveAccountConfig(ownerUid, { adminZaloUid: uid || "", adminZaloLabel: label || "" });
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

export async function createUser({ username, passwordHash, mustChangePassword = false }) {
  const result = await run(
    `INSERT INTO users (username, password_hash, must_change_password, updated_at) VALUES (?, ?, ?, ?)`,
    [String(username), String(passwordHash), mustChangePassword ? 1 : 0, Math.floor(Date.now() / 1000)]
  );
  return getUserById(result.lastID);
}

/**
 * Doi mat khau VA go co bat buoc doi trong CUNG mot cau lenh: neu tach lam hai,
 * doi thanh cong ma go co that bai thi nguoi dung ket vinh vien o man doi mat khau.
 */
export async function updateUserPassword(id, passwordHash) {
  const result = await run(
    `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`,
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

/* =====================================================================
 * CHUYEN DOI CACH LY TAI KHOAN
 *
 * KHONG duoc goi tu initDb(). Phai duoc goi CO CHU DICH, sau khi da sao luu.
 * Ly do: day la thao tac khong hoan tac duoc tren du lieu that cua khach; chay
 * tu dong luc khoi dong nghia la mot cai restart tinh co cung du lam hong du lieu.
 *
 * Nguyen tac:
 *   - Khong xoa du lieu. Khong doan chu so huu.
 *   - Chi quy chu khi CHUNG MINH duoc: trong mot cuoc tro chuyen, cac tin "cua
 *     minh" (is_self = 1) chi mang DUY NHAT mot sender_id -> do la uid cua tai
 *     khoan da so huu cuoc tro chuyen ay.
 *   - Khong chung minh duoc -> owner_uid = NULL, khoa "unknown:<id>", giu nguyen
 *     lich su nhung khong bao gio lot vao du lieu dang hoat dong.
 *   - Toan bo nam trong MOT giao dich; sai mot phep kiem la ROLLBACK.
 * ===================================================================== */
export async function chuyenDoiCachLyTaiKhoan(duongDan = DB_PATH) {
  const conn = new sqlite3.Database(duongDan);
  const chay = (sql, p = []) =>
    new Promise((res, rej) => conn.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  const lay = (sql, p = []) =>
    new Promise((res, rej) => conn.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const layTatCa = (sql, p = []) =>
    new Promise((res, rej) => conn.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const dong = () => new Promise((res) => conn.close(() => res()));

  const bienBan = { daChay: false, lyDo: "" };
  try {
    const cols = await layTatCa("PRAGMA table_info(threads)");
    if (!cols.length) { bienBan.lyDo = "Khong co bang threads - khong can chuyen doi."; return bienBan; }
    if (cols.some((c) => c.name === "owner_uid")) { bienBan.lyDo = "Da o so do moi - bo qua."; return bienBan; }

    bienBan.threadsTruoc = (await lay("SELECT COUNT(*) n FROM threads")).n;
    bienBan.messagesTruoc = (await lay("SELECT COUNT(*) n FROM messages")).n;
    bienBan.customerTruoc = (await lay("SELECT COUNT(*) n FROM customer_memory")).n;
    const coOpencode = await lay("SELECT name FROM sqlite_master WHERE type='table' AND name='opencode_sessions'");
    bienBan.opencodeTruoc = coOpencode ? (await lay("SELECT COUNT(*) n FROM opencode_sessions")).n : 0;

    // Cong chan: cong tac bot toan cuc dang BAT thi KHONG tu gan cho tai khoan nao.
    const cauHinhCu = await lay("SELECT bot_enabled, allowed_group_id, allowed_sender_ids FROM ai_chat_config WHERE id = 1");
    const nguoiCu = await lay("SELECT otp_zalo_thread_id, admin_zalo_uid FROM users WHERE id = 1");
    bienBan.botToanCucDangBat = Boolean(cauHinhCu && cauHinhCu.bot_enabled);
    bienBan.cauHinhCuCoGiaTri = Boolean(
      (cauHinhCu && cauHinhCu.allowed_group_id) ||
      (cauHinhCu && cauHinhCu.allowed_sender_ids && cauHinhCu.allowed_sender_ids !== "[]") ||
      (nguoiCu && nguoiCu.otp_zalo_thread_id) ||
      (nguoiCu && nguoiCu.admin_zalo_uid)
    );

    await chay("PRAGMA foreign_keys = OFF");
    await chay("BEGIN IMMEDIATE");

    // Quy chu TAT DINH: chi khi tin cua minh trong thread do co dung 1 sender_id.
    const quyChu = await layTatCa(`
      SELECT t.id AS remote_id,
             (SELECT COUNT(DISTINCT m.sender_id) FROM messages m
               WHERE m.thread_id = t.id AND m.is_self = 1 AND m.sender_id IS NOT NULL) AS so_chu,
             (SELECT MIN(m.sender_id) FROM messages m
               WHERE m.thread_id = t.id AND m.is_self = 1 AND m.sender_id IS NOT NULL) AS chu
      FROM threads t
    `);
    const chuCua = new Map();
    for (const r of quyChu) chuCua.set(String(r.remote_id), r.so_chu === 1 ? String(r.chu) : null);
    const khoa = (remoteId) => khoaCucBo(chuCua.get(String(remoteId)) ?? null, remoteId);

    bienBan.threadCoChu = [...chuCua.values()].filter(Boolean).length;
    bienBan.threadKhongRoChu = [...chuCua.values()].filter((v) => !v).length;

    await chay(`CREATE TABLE threads_moi (
      local_id TEXT PRIMARY KEY, owner_uid TEXT, remote_thread_id TEXT NOT NULL,
      thread_type INTEGER NOT NULL DEFAULT 0, title TEXT, avatar TEXT,
      last_message TEXT, last_message_at INTEGER, updated_at INTEGER NOT NULL,
      UNIQUE(owner_uid, remote_thread_id))`);
    await chay(`CREATE TABLE messages_moi (
      id TEXT NOT NULL, thread_id TEXT NOT NULL, content TEXT NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0, sender_id TEXT, sender_name TEXT,
      sender_avatar TEXT, msg_type TEXT, ts INTEGER NOT NULL, raw_json TEXT,
      PRIMARY KEY (thread_id, id),
      FOREIGN KEY (thread_id) REFERENCES threads_moi(local_id))`);

    for (const t of await layTatCa("SELECT * FROM threads")) {
      await chay(
        `INSERT INTO threads_moi (local_id, owner_uid, remote_thread_id, thread_type, title, avatar,
                                  last_message, last_message_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [khoa(t.id), chuCua.get(String(t.id)) ?? null, String(t.id), t.thread_type,
         t.title, t.avatar, t.last_message, t.last_message_at, t.updated_at]
      );
    }
    for (const m of await layTatCa("SELECT * FROM messages")) {
      await chay(
        `INSERT OR IGNORE INTO messages_moi
           (id, thread_id, content, is_self, sender_id, sender_name, sender_avatar, msg_type, ts, raw_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [m.id, khoa(m.thread_id), m.content, m.is_self, m.sender_id, m.sender_name,
         m.sender_avatar, m.msg_type, m.ts, m.raw_json]
      );
    }

    const sauThreads = (await lay("SELECT COUNT(*) n FROM threads_moi")).n;
    const sauMessages = (await lay("SELECT COUNT(*) n FROM messages_moi")).n;
    const moCoi = (await lay(
      `SELECT COUNT(*) n FROM messages_moi m LEFT JOIN threads_moi t ON t.local_id = m.thread_id
       WHERE t.local_id IS NULL`
    )).n;
    if (sauThreads !== bienBan.threadsTruoc) throw new Error(`Lech so thread: ${bienBan.threadsTruoc} -> ${sauThreads}`);
    if (sauMessages !== bienBan.messagesTruoc) throw new Error(`Lech so tin nhan: ${bienBan.messagesTruoc} -> ${sauMessages}`);
    if (moCoi !== 0) throw new Error(`Co ${moCoi} tin nhan mo coi`);

    if (coOpencode) {
      for (const s of await layTatCa("SELECT * FROM opencode_sessions")) {
        await chay("UPDATE opencode_sessions SET thread_id = ? WHERE thread_id = ?", [khoa(s.thread_id), s.thread_id]);
      }
    }

    await chay(`CREATE TABLE customer_memory_moi (
      owner_uid TEXT, uid TEXT NOT NULL, display_name TEXT, profile TEXT NOT NULL DEFAULT '',
      locked INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_uid, uid))`);
    let khachCoChu = 0;
    let khachKhongRo = 0;
    for (const c of await layTatCa("SELECT * FROM customer_memory")) {
      // uid cua khach chinh la id cuoc tro chuyen 1-1 -> dung lai ket qua quy chu.
      const chu = chuCua.get(String(c.uid)) ?? null;
      if (chu) khachCoChu++; else khachKhongRo++;
      await chay(
        `INSERT OR IGNORE INTO customer_memory_moi
           (owner_uid, uid, display_name, profile, locked, turns, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [chu, String(c.uid), c.display_name, c.profile, c.locked, c.turns, c.created_at, c.updated_at]
      );
    }
    const sauKhach = (await lay("SELECT COUNT(*) n FROM customer_memory_moi")).n;
    if (sauKhach !== bienBan.customerTruoc) throw new Error(`Lech so ho so khach: ${bienBan.customerTruoc} -> ${sauKhach}`);
    bienBan.customerCoChu = khachCoChu;
    bienBan.customerKhongRo = khachKhongRo;

    try { await chay("ALTER TABLE lich_hen ADD COLUMN owner_uid TEXT"); }
    catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }

    await chay(`CREATE TABLE IF NOT EXISTS account_config (
      owner_uid TEXT PRIMARY KEY, bot_enabled INTEGER NOT NULL DEFAULT 0,
      allowed_group_id TEXT NOT NULL DEFAULT '', allowed_sender_ids TEXT NOT NULL DEFAULT '[]',
      otp_zalo_thread_id TEXT NOT NULL DEFAULT '', otp_zalo_label TEXT NOT NULL DEFAULT '',
      admin_zalo_uid TEXT NOT NULL DEFAULT '', admin_zalo_label TEXT NOT NULL DEFAULT '',
      setup_step INTEGER NOT NULL DEFAULT 0, setup_completed INTEGER NOT NULL DEFAULT 0,
      setup_data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`);
    // KHONG chuyen gia tri cu sang bat ky tai khoan nao: gan cong tac bot dang BAT
    // cho tai khoan tinh co dang dang nhap la mot phep DOAN - va la phep doan co
    // the khien bot nhan cho khach that.

    await chay("DROP TABLE messages");
    await chay("DROP TABLE threads");
    await chay("DROP TABLE customer_memory");
    await chay("ALTER TABLE threads_moi RENAME TO threads");
    await chay("ALTER TABLE messages_moi RENAME TO messages");
    await chay("ALTER TABLE customer_memory_moi RENAME TO customer_memory");
    await chay("CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(thread_id, ts)");
    await chay("CREATE INDEX IF NOT EXISTS idx_threads_owner ON threads(owner_uid)");

    await chay("COMMIT");
    await chay("PRAGMA foreign_keys = ON");
    bienBan.daChay = true;
    bienBan.threadsSau = sauThreads;
    bienBan.messagesSau = sauMessages;
    bienBan.customerSau = sauKhach;
    bienBan.opencodeSau = bienBan.opencodeTruoc;
    bienBan.moCoi = moCoi;
    return bienBan;
  } catch (error) {
    try { await chay("ROLLBACK"); } catch { /* chua mo giao dich */ }
    bienBan.loi = error.message;
    throw error;
  } finally {
    await dong();
  }
}
