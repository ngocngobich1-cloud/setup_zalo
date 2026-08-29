/**
 * STAB-04 owner-context focused regression.
 *
 * - Khong import server.js (import se khoi dong listener/live app).
 * - Khong goi Zoho/Zalo that; chi seam hai ham doc Zoho duoc contract cho phep.
 * - Worker chay voi DB tam trong repo; parent chi xoa dung thu muc tam no tao.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./node24-arm64-test-polyfills.js";
import "./sqlite3-node24-test-register.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPT = fileURLToPath(import.meta.url);
const TEMP_PARENT = path.join(REPO, ".tmp-stab04a");
const OWNER_A = "STAB04_OWNER_A";
const OWNER_B = "STAB04_OWNER_B";
const LEGACY_KNOWLEDGE_ID = 9001;
const CUSTOMER_UID = "STAB04_CUSTOMER_MEMORY";
const CUSTOMER_THREAD = "STAB04_CUSTOMER_THREAD";
const PROFILE_A = "Hoàn cảnh: hồ sơ chỉ thuộc Owner A.";
const PROFILE_B = "Hoàn cảnh: hồ sơ chỉ thuộc Owner B.";
const INSTRUCTION_A = "Luôn dùng chỉ dẫn riêng của Owner A.";
const INSTRUCTION_B = "Luôn dùng chỉ dẫn riêng của Owner B.";
const UPDATED_PROFILE_A = "Xưng hô: bạn\nHoàn cảnh: hồ sơ đã cập nhật cho Owner A.";

function assertInsideTempParent(candidate) {
  const parent = path.resolve(TEMP_PARENT);
  const target = path.resolve(candidate);
  assert.notEqual(target, parent, "Khong duoc xoa chinh thu muc cha temp.");
  assert.ok(target.startsWith(`${parent}${path.sep}`), `Temp target vuot khoi pham vi: ${target}`);
}

function blockAt(source, start, label) {
  assert.ok(start >= 0 && source[start] === "{", `Khong tim thay block: ${label}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  assert.fail(`Block khong dong: ${label}`);
}

function functionBody(source, signature, label) {
  const signatureAt = source.indexOf(signature);
  assert.ok(signatureAt >= 0, `Khong tim thay function: ${label}`);
  return blockAt(source, source.indexOf("{", signatureAt + signature.length), label);
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

function sqliteRun(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function sqliteGet(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function sqliteAll(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function sqliteClose(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });
}

function sourceProof() {
  const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  const scheduler = fs.readFileSync(path.join(REPO, "lib", "scheduler.js"), "utf8");
  const emailCheck = fs.readFileSync(path.join(REPO, "lib", "email-check.js"), "utf8");
  const aiChat = fs.readFileSync(path.join(REPO, "lib", "ai-chat.js"), "utf8");
  const adminCommand = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
  const customerMemory = fs.readFileSync(path.join(REPO, "lib", "customer-memory.js"), "utf8");
  const dbSource = fs.readFileSync(path.join(REPO, "lib", "db.js"), "utf8");
  const knowledgeSource = fs.readFileSync(path.join(REPO, "lib", "knowledge.js"), "utf8");
  const publicConfig = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");

  const adminBody = functionBody(
    server,
    "const nhanRiengChoAdmin = async (ownerUid, text) =>",
    "nhanRiengChoAdmin"
  );
  assert.match(adminBody, /await getAdminZalo\(ownerUid\)/);
  assert.match(adminBody, /sendChatMessage\(\{ threadId: admin\.uid, threadType: 0, text \}\)/);

  const schedulerBody = functionBody(scheduler, "async function chayMotVong()", "chayMotVong");
  assert.ok(schedulerBody.indexOf("const chu = layChuTaiKhoan()") < schedulerBody.indexOf("await layLichDenHan(chu"));
  assert.equal(count(schedulerBody, "baoAdmin?.(\n          chu,"), 2);

  const emailBody = functionBody(
    emailCheck,
    'export async function traCuu({ email, nguon = "bot", nguoiHoiTen = "", nguoiHoiUid = "" })',
    "traCuu"
  );
  const firstExecutable = emailBody.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  assert.equal(firstExecutable, "const chu = layChuTaiKhoan();");
  assert.ok(emailBody.indexOf("const chu = layChuTaiKhoan();") < emailBody.indexOf("await getZohoConfig()"));
  assert.equal(count(emailBody, "layChuTaiKhoan()"), 1);
  assert.match(emailBody, /ownerUid: chu,/);
  assert.match(emailBody, /baoAdmin\(chu, loiNhan\)/);

  const tryReplyBody = functionBody(aiChat, "export async function tryReply", "tryReply");
  assert.equal(count(tryReplyBody, "layChuTaiKhoan()"), 1);
  assert.ok(tryReplyBody.indexOf("const ownerUid = layChuTaiKhoan();") < tryReplyBody.indexOf("await addLog("));
  assert.match(tryReplyBody, /generateReply\(userMessage, messageObj, ownerUid, config\)/);
  assert.match(tryReplyBody, /\.ducKetNeuDenLuot\(config, messageObj, ownerUid\)/);

  const generateReplyBody = functionBody(aiChat, "export async function generateReply", "generateReply");
  assert.match(generateReplyBody, /\.bocPrompt\(session\.sessionId, messageObj, loiKhach, ownerUid\)/);

  const bocPromptBody = functionBody(customerMemory, "export async function bocPrompt", "bocPrompt");
  assert.equal(count(bocPromptBody, "layChuTaiKhoan()"), 0);
  assert.equal(count(bocPromptBody, "getCustomerMemory(ownerUid, uid)"), 1);
  assert.equal(count(bocPromptBody, "getOwnerInstruction(ownerUid, uid)"), 1);

  const ducKetBody = functionBody(
    customerMemory,
    "export async function ducKetHoSo(config, { uid, ten, threadId }, ownerUid = layChuTaiKhoan())",
    "ducKetHoSo"
  );
  assert.equal(count(ducKetBody, "layChuTaiKhoan()"), 0);
  assert.equal(count(ducKetBody, "buildRecentHistory(ownerUid, threadId"), 1);
  assert.equal(count(ducKetBody, "getCustomerMemory(ownerUid, uid)"), 1);
  assert.equal(count(ducKetBody, "const chuHoSo = ownerUid;"), 1);
  assert.equal(count(ducKetBody, "resetCustomerTurns(ownerUid, uid)"), 1);

  const denLuotBody = functionBody(customerMemory, "export async function ducKetNeuDenLuot", "ducKetNeuDenLuot");
  assert.equal(count(denLuotBody, "layChuTaiKhoan()"), 0);
  assert.equal(count(denLuotBody, "bumpCustomerTurns(ownerUid, uid, ten)"), 1);
  assert.equal(count(denLuotBody, "getCustomerMemory(ownerUid, uid)"), 1);
  assert.equal(count(denLuotBody, "resetCustomerTurns(ownerUid, uid)"), 1);
  assert.match(denLuotBody, /ducKetHoSo\(config, \{ uid, ten, threadId: messageObj\.threadId \}, ownerUid\)/);

  const pendingKeyBody = functionBody(
    adminCommand,
    "function khoaThaoTacCho(ownerUid, threadId)",
    "khoaThaoTacCho"
  );
  assert.match(pendingKeyBody, /return `\$\{String\(ownerUid \|\| ""\)\}::\$\{String\(threadId \|\| ""\)\}`;/);

  const adminCommandBody = functionBody(adminCommand, "export async function xuLyLenh", "xuLyLenh");
  assert.equal(count(adminCommandBody, "layChuTaiKhoan()"), 1);
  assert.ok(
    adminCommandBody.indexOf("const ownerUid = layChuTaiKhoan();")
      < adminCommandBody.indexOf("await xuLyBanNhapDay(message)")
  );
  assert.match(adminCommandBody, /const khoa = khoaThaoTacCho\(ownerUid, message\.threadId\);/);

  const choAccesses = [...adminCommand.matchAll(/\bcho\.(get|set|delete|has)\s*\(\s*([^,\n)]+)/g)];
  assert.equal(choAccesses.length, 23);
  for (const access of choAccesses) {
    assert.ok(
      access[2].trim() === "khoa" || access[2].trim() === "khoaThaoTacCho(ownerUid",
      `cho.${access[1]} con key khong owner-bound: ${access[2].trim()}`
    );
  }
  assert.doesNotMatch(adminCommand, /\bcho\.(?:get|set|delete|has)\s*\(\s*String\(message\?\.threadId\)/);

  const recentApprovalAccesses = [...adminCommand.matchAll(/\bchoDuyetGanDay\.(get|set|delete|has)\s*\(\s*([^\n]+)/g)];
  assert.equal(recentApprovalAccesses.length, 3);
  assert.ok(recentApprovalAccesses.every((access) => access[2].includes("khoaDuyetGanDay(ownerUid,")));

  assert.match(adminCommand, /const choDay = new Map\(\); \/\/ "<owner_uid>::<uid admin>"/);
  const draftKeyBody = functionBody(adminCommand, "function khoaBanNhap(ownerUid, senderId)", "khoaBanNhap");
  assert.match(draftKeyBody, /return `\$\{String\(ownerUid \|\| ""\)\}::\$\{String\(senderId \|\| ""\)\}`;/);
  assert.equal([...adminCommand.matchAll(/\bchoDay\.(get|set|delete|has)\s*\(/g)].length, 6);
  assert.doesNotMatch(adminCommand, /choDay\.(?:get|set|delete|has)\([^\n]*khoaThaoTacCho/);

  // STAB-04B2: nam SQL site van giu nguyen topology, nhung tat ca deu fail closed
  // theo owner. Legacy NULL khong duoc backfill/xoa tu dong.
  assert.match(dbSource, /ALTER TABLE knowledge_files ADD COLUMN owner_uid TEXT NULL/);
  assert.doesNotMatch(dbSource, /DELETE FROM knowledge_files WHERE owner_uid IS NULL/i);
  assert.doesNotMatch(dbSource, /UPDATE knowledge_files SET owner_uid/i);

  const listKnowledgeBody = functionBody(
    dbSource,
    "export async function getAllKnowledgeFiles(ownerUid)",
    "getAllKnowledgeFiles"
  );
  assert.match(listKnowledgeBody, /if \(!ownerUid\) return \[\];/);
  assert.match(listKnowledgeBody, /FROM knowledge_files WHERE owner_uid = \?/);

  const readKnowledgeBody = functionBody(
    dbSource,
    "export async function getKnowledgeFileById(ownerUid, id)",
    "getKnowledgeFileById"
  );
  assert.match(readKnowledgeBody, /WHERE id = \? AND owner_uid = \?/);

  const loadKnowledgeBody = functionBody(
    dbSource,
    "export async function getKnowledgeFilesByIds(ownerUid, ids)",
    "getKnowledgeFilesByIds"
  );
  assert.match(loadKnowledgeBody, /WHERE owner_uid = \? AND id IN/);

  const createKnowledgeBody = functionBody(
    dbSource,
    "export async function createKnowledgeFile(ownerUid, { originalName, fileExt, contentMd, fileSize })",
    "createKnowledgeFile"
  );
  assert.match(createKnowledgeBody, /if \(!ownerUid\) throw/);
  assert.match(createKnowledgeBody, /INSERT INTO knowledge_files \(owner_uid,/);
  assert.match(createKnowledgeBody, /getKnowledgeFileById\(ownerKey, result\.lastID\)/);

  const deleteKnowledgeBody = functionBody(
    dbSource,
    "export async function deleteKnowledgeFile(ownerUid, id)",
    "deleteKnowledgeFile"
  );
  assert.match(deleteKnowledgeBody, /WHERE id = \? AND owner_uid = \?/);

  assert.doesNotMatch(knowledgeSource, /layChuTaiKhoan\s*\(|chuHienTai\s*\(/);
  assert.match(knowledgeSource, /getContentsForAi\(ownerUid, fileIds, maxChars = 12000\)/);
  assert.match(knowledgeSource, /getKnowledgeFilesByIds\(ownerUid, fileIds\)/);
  assert.match(aiChat, /knowledge\.getContentsForAi\(ownerUid, knowledgeFileIds, KNOWLEDGE_MAX_CHARS\)/);

  const listRoute = functionBody(server, 'app.get("/api/knowledge", async (_req, res) =>', "GET Knowledge");
  assert.match(listRoute, /const ownerUid = chuHienTai\(\);/);
  assert.match(listRoute, /knowledge\.listFiles\(ownerUid\)/);
  const uploadRoute = functionBody(server, 'app.post("/api/knowledge", (req, res) =>', "POST Knowledge");
  assert.ok(uploadRoute.indexOf("const ownerUid = chuHienTai();") < uploadRoute.indexOf('upload.single("file")'));
  assert.match(uploadRoute, /knowledge\.addFile\(ownerUid, req\.file\.buffer, req\.file\.originalname\)/);
  const contentRoute = functionBody(
    server,
    'app.get("/api/knowledge/:id/content", async (req, res) =>',
    "GET Knowledge content"
  );
  assert.match(contentRoute, /knowledge\.getFileContent\(ownerUid, req\.params\.id\)/);
  const deleteRoute = functionBody(
    server,
    'app.delete("/api/knowledge/:id", async (req, res) =>',
    "DELETE Knowledge"
  );
  assert.match(deleteRoute, /knowledge\.removeFile\(ownerUid, req\.params\.id\)/);

  const getAiRoute = functionBody(server, 'app.get("/api/ai-chat", async (_req, res) =>', "GET AI Chat");
  assert.match(getAiRoute, /knowledge\.validateOwnedFileIds\(/);
  assert.match(getAiRoute, /config: \{ \.\.\.config, knowledgeFileIds \}/);
  assert.doesNotMatch(getAiRoute, /saveAiChatConfig/);
  const postAiRoute = functionBody(server, 'app.post("/api/ai-chat", async (req, res) =>', "POST AI Chat");
  assert.match(
    postAiRoute,
    /validateOwnedFileIds\(ownerUid, knowledgeFileIds\)[\s\S]*if \(!validation\.allOwned\)[\s\S]*return res\.status\(400\)[\s\S]*knowledgeFileIds: ownedKnowledgeFileIds/
  );

  const invalidateSettingsBody = functionBody(
    publicConfig,
    "export function invalidateSettingsOwnerState()",
    "invalidateSettingsOwnerState"
  );
  assert.match(invalidateSettingsBody, /settingsOwnerGeneration \+= 1;[\s\S]*invalidateKnowledgeOwnerSink\?\.\(\);/);
  const knowledgeTabAt = publicConfig.indexOf('id: "knowledge"');
  const knowledgeMountAt = publicConfig.indexOf("mount(panel)", knowledgeTabAt);
  const knowledgeMountBody = blockAt(
    publicConfig,
    publicConfig.indexOf("{", knowledgeMountAt + "mount(panel)".length),
    "Knowledge mount"
  );
  assert.match(knowledgeMountBody, /invalidateKnowledgeOwnerSink = \(\) => \{[\s\S]*list\.innerHTML = "";/);
  assert.match(knowledgeMountBody, /dangKyLamMoi\("tri thuc", fetchList\)/);
  assert.match(knowledgeMountBody, /generation !== settingsOwnerGeneration/);
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Het ${timeoutMs}ms ma dieu kien van chua dat.`);
}

async function behaviorProof(tempDir) {
  assertInsideTempParent(tempDir);
  process.env.APP_SECRET_KEY = "00".repeat(32);
  fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
  process.chdir(tempDir);

  // Tao dung schema Knowledge cu truoc khi initDb de chung minh additive upgrade
  // khong xoa, khong doi content va khong tu gan owner cho legacy row.
  const sqlite3 = (await import("sqlite3")).default;
  const testDbPath = path.join(tempDir, "data", "zalo.db");
  const legacySeedDb = new sqlite3.Database(testDbPath);
  await sqliteRun(legacySeedDb, `
    CREATE TABLE knowledge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      file_ext TEXT NOT NULL,
      content_md TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  await sqliteRun(
    legacySeedDb,
    `INSERT INTO knowledge_files
       (id, original_name, file_ext, content_md, file_size, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [LEGACY_KNOWLEDGE_ID, "legacy-b2.md", ".md", "B2_LEGACY_CONTENT", 17, 17, 1]
  );
  await sqliteClose(legacySeedDb);

  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  const aiChat = await import(pathToFileURL(path.join(REPO, "lib", "ai-chat.js")).href);
  const adminCommand = await import(pathToFileURL(path.join(REPO, "lib", "admin-command.js")).href);
  const customerMemory = await import(pathToFileURL(path.join(REPO, "lib", "customer-memory.js")).href);
  const emailCheck = await import(pathToFileURL(path.join(REPO, "lib", "email-check.js")).href);
  const knowledge = await import(pathToFileURL(path.join(REPO, "lib", "knowledge.js")).href);
  const scheduler = await import(pathToFileURL(path.join(REPO, "lib", "scheduler.js")).href);
  await db.initDb();

  const inspectionDb = new sqlite3.Database(testDbPath);
  const knowledgeColumns = await sqliteAll(inspectionDb, "PRAGMA table_info(knowledge_files)");
  const ownerColumn = knowledgeColumns.find((column) => column.name === "owner_uid");
  assert.ok(ownerColumn, "Schema upgrade chua them knowledge_files.owner_uid.");
  assert.equal(ownerColumn.notnull, 0);
  const legacyAfterSchema = await sqliteGet(
    inspectionDb,
    "SELECT owner_uid, content_md FROM knowledge_files WHERE id = ?",
    [LEGACY_KNOWLEDGE_ID]
  );
  assert.equal(legacyAfterSchema.owner_uid, null);
  assert.equal(legacyAfterSchema.content_md, "B2_LEGACY_CONTENT");
  const legacyRowsBefore = Number((await sqliteGet(
    inspectionDb,
    "SELECT COUNT(*) AS n FROM knowledge_files WHERE owner_uid IS NULL"
  )).n);
  assert.equal(legacyRowsBefore, 1);

  const ownerAKeep = await knowledge.addFile(
    OWNER_A,
    Buffer.from("B2_OWNER_A_CONTENT", "utf8"),
    "b2-owner-a.md"
  );
  const ownerADelete = await knowledge.addFile(
    OWNER_A,
    Buffer.from("B2_OWNER_A_DELETE_CONTENT", "utf8"),
    "b2-owner-a-delete.md"
  );
  const ownerBFile = await knowledge.addFile(
    OWNER_B,
    Buffer.from("B2_OWNER_B_CONTENT", "utf8"),
    "b2-owner-b.md"
  );
  await assert.rejects(
    knowledge.addFile("", Buffer.from("B2_OWNERLESS_CONTENT", "utf8"), "b2-ownerless.md"),
    /ownerUid/
  );
  assert.equal(Number((await sqliteGet(
    inspectionDb,
    "SELECT COUNT(*) AS n FROM knowledge_files WHERE original_name = ?",
    ["b2-ownerless.md"]
  )).n), 0);
  assert.equal((await sqliteGet(
    inspectionDb,
    "SELECT owner_uid FROM knowledge_files WHERE id = ?",
    [ownerAKeep.id]
  )).owner_uid, OWNER_A);
  assert.equal((await sqliteGet(
    inspectionDb,
    "SELECT owner_uid FROM knowledge_files WHERE id = ?",
    [ownerBFile.id]
  )).owner_uid, OWNER_B);

  assert.deepEqual(
    (await knowledge.listFiles(OWNER_A)).map((file) => file.id).sort((a, b) => a - b),
    [ownerAKeep.id, ownerADelete.id].sort((a, b) => a - b)
  );
  assert.deepEqual((await knowledge.listFiles(OWNER_B)).map((file) => file.id), [ownerBFile.id]);
  assert.deepEqual(await knowledge.listFiles(""), []);
  assert.equal((await knowledge.getFileContent(OWNER_A, ownerAKeep.id)).contentMd, "B2_OWNER_A_CONTENT");
  assert.equal(await knowledge.getFileContent(OWNER_A, ownerBFile.id), null);
  assert.equal(await knowledge.getFileContent(OWNER_A, LEGACY_KNOWLEDGE_ID), null);
  assert.equal(await knowledge.getFileContent(OWNER_B, ownerAKeep.id), null);

  assert.equal(await knowledge.removeFile(OWNER_B, ownerADelete.id), false);
  assert.ok(await knowledge.getFileContent(OWNER_A, ownerADelete.id));
  assert.equal(await knowledge.removeFile(OWNER_A, LEGACY_KNOWLEDGE_ID), false);
  assert.equal(await knowledge.removeFile(OWNER_A, ownerADelete.id), true);
  assert.equal(await knowledge.getFileContent(OWNER_A, ownerADelete.id), null);

  const mixedAiKnowledge = await knowledge.getContentsForAi(
    OWNER_A,
    [ownerAKeep.id, ownerBFile.id, LEGACY_KNOWLEDGE_ID],
    5000
  );
  assert.match(mixedAiKnowledge, /B2_OWNER_A_CONTENT/);
  assert.doesNotMatch(mixedAiKnowledge, /B2_OWNER_B_CONTENT/);
  assert.doesNotMatch(mixedAiKnowledge, /B2_LEGACY_CONTENT/);

  const validSelection = await knowledge.validateOwnedFileIds(OWNER_A, [ownerAKeep.id]);
  assert.equal(validSelection.allOwned, true);
  assert.deepEqual(validSelection.ownedIds, [ownerAKeep.id]);
  const mixedSelection = await knowledge.validateOwnedFileIds(
    OWNER_A,
    [ownerAKeep.id, ownerBFile.id, LEGACY_KNOWLEDGE_ID, 999999]
  );
  assert.equal(mixedSelection.allOwned, false);
  assert.deepEqual(mixedSelection.ownedIds, [ownerAKeep.id]);
  const legacySelection = await knowledge.validateOwnedFileIds(OWNER_A, [LEGACY_KNOWLEDGE_ID]);
  assert.equal(legacySelection.allOwned, false);
  assert.deepEqual(legacySelection.ownedIds, []);

  await db.saveAiChatConfig(OWNER_A, {
    allowedTopics: "B2 owner selection",
    roleTone: "Test-only",
    useKnowledge: true,
    knowledgeFileIds: [ownerAKeep.id, ownerBFile.id, LEGACY_KNOWLEDGE_ID, 999999],
    soul: "B2 selection sanitization",
    opencodeModel: "fixture/stab04b2",
  });
  const storedSelectionBeforeGet = (await db.getAiChatConfig(OWNER_A)).knowledgeFileIds;
  const sanitizedGetSelection = await knowledge.validateOwnedFileIds(OWNER_A, storedSelectionBeforeGet);
  assert.deepEqual(sanitizedGetSelection.ownedIds, [ownerAKeep.id]);
  const storedSelectionAfterGet = (await db.getAiChatConfig(OWNER_A)).knowledgeFileIds;
  assert.deepEqual(storedSelectionAfterGet, storedSelectionBeforeGet);
  await db.saveZohoConfig({
    bat: true,
    accountId: "STAB04_TEST_ACCOUNT",
    refreshToken: "STAB04_SYNTHETIC_TOKEN_NOT_FOR_NETWORK",
  });

  let emailOwner = OWNER_A;
  let emailOwnerReads = 0;
  let sentLookups = 0;
  let bouncedLookups = 0;
  const emailNotifications = [];
  emailCheck.capHinhChuTaiKhoan(() => {
    emailOwnerReads += 1;
    return emailOwner;
  });
  emailCheck.capHinhTimThuZohoChoKiemThu({
    timThuDaGui: async () => {
      sentLookups += 1;
      return [];
    },
    timThuTraVe: async () => {
      bouncedLookups += 1;
      return [];
    },
  });
  emailCheck.capHinhBaoAdmin(async (ownerUid, text) => {
    emailNotifications.push({ ownerUid, text });
  });

  const emailPromise = emailCheck.traCuu({
    email: "stab04-owner@example.invalid",
    nguon: "bot",
    nguoiHoiTen: "STAB-04 customer",
    nguoiHoiUid: "STAB04_CUSTOMER",
  });
  emailOwner = OWNER_B;
  const emailResult = await emailPromise;

  assert.equal(emailResult?.trangThai, "khong_thay");
  assert.equal(emailOwnerReads, 1);
  assert.equal(sentLookups, 1);
  assert.equal(bouncedLookups, 0);
  assert.equal((await db.listTraCuu(OWNER_A)).length, 1);
  assert.equal((await db.listTraCuu(OWNER_B)).length, 0);
  assert.equal(emailNotifications.length, 1);
  assert.equal(emailNotifications[0].ownerUid, OWNER_A);
  assert.match(emailNotifications[0].text, /stab04-owner@example\.invalid/);

  await db.themLichHen(OWNER_A, {
    dichId: "STAB04_DESTINATION",
    dichTen: "STAB-04 destination",
    loai: "nick",
    noiDung: "STAB-04 isolated reminder",
    lucGui: Math.floor(Date.now() / 1000) - scheduler.NGUONG_TRE_GIAY - 60,
    lapLai: "",
    cauLenh: "",
    khan: 0,
  });

  let schedulerOwner = OWNER_A;
  let schedulerOwnerReads = 0;
  let sends = 0;
  const schedulerNotifications = [];
  scheduler.capHinhScheduler({
    gui: async () => {
      sends += 1;
    },
    thongBaoAdmin: async (ownerUid, text) => {
      schedulerNotifications.push({ ownerUid, text });
    },
    layChu: () => {
      schedulerOwnerReads += 1;
      return schedulerOwner;
    },
  });

  const schedulerPromise = scheduler.quetNgay();
  schedulerOwner = OWNER_B;
  await schedulerPromise;

  assert.equal(schedulerOwnerReads, 1);
  assert.equal(sends, 0);
  assert.equal(schedulerNotifications.length, 1);
  assert.equal(schedulerNotifications[0].ownerUid, OWNER_A);
  assert.match(schedulerNotifications[0].text, /LỠ một lịch hẹn/);

  // STAB-04C: hai owner dung cung thread/group van phai co pending state rieng.
  const sharedGroupId = "STAB04C_SHARED_GROUP";
  const sharedAdminThread = "STAB04C_SHARED_ADMIN_THREAD";
  for (const ownerUid of [OWNER_A, OWNER_B]) {
    await db.insertMessage(ownerUid, {
      id: `STAB04C_GROUP_MESSAGE_${ownerUid}`,
      threadId: sharedGroupId,
      threadType: 1,
      content: "STAB-04C group fixture",
      senderId: "STAB04C_MEMBER",
      senderName: "STAB-04C member",
      ts: Date.now(),
    });
    await db.saveAiChatConfig(ownerUid, {
      allowedTopics: "STAB-04C pending proof",
      roleTone: "Test-only",
      useKnowledge: false,
      knowledgeFileIds: [],
      soul: "STAB-04C deterministic proof",
      opencodeBaseUrl: "http://127.0.0.1:1",
      opencodeAgent: "general",
      opencodeModel: "fixture/stab04c",
    });
  }

  let pendingOwner = OWNER_A;
  let groupApprovalSideEffects = 0;
  adminCommand.capHinhChuTaiKhoan(() => pendingOwner);
  adminCommand.capHinhPhanTichLenh(async (_config, noiDung) => (
    String(noiDung).includes("XEM")
      ? { hanhDong: "xem_cho_duyet", dichId: sharedGroupId }
      : { hanhDong: "duyet_vao_nhom", dichId: sharedGroupId, soThuTu: [1], dongY: true }
  ));
  adminCommand.capHinhNhom({
    xemCho: async () => pendingOwner === OWNER_A
      ? [{ uid: "STAB04C_APPLICANT_A", ten: "STAB04C Applicant A" }]
      : [{ uid: "STAB04C_APPLICANT_B", ten: "STAB04C Applicant B" }],
    duyet: async () => {
      groupApprovalSideEffects += 1;
      return [];
    },
  });

  const adminMessage = (content, threadId = sharedAdminThread) => ({
    content,
    threadId,
    threadType: 0,
    senderId: "STAB04C_ADMIN",
    senderName: "STAB-04C admin",
  });
  const ownerAList = await adminCommand.xuLyLenh(adminMessage("STAB04C_XEM"), async () => {});
  assert.match(ownerAList, /STAB04C Applicant A/);

  pendingOwner = OWNER_B;
  const ownerBCrossRead = await adminCommand.xuLyLenh(adminMessage("STAB04C_DUYET"), async () => {});
  assert.match(ownerBCrossRead, /xem danh sách chờ duyệt/);
  assert.doesNotMatch(ownerBCrossRead, /STAB04C Applicant A/);

  const ownerBList = await adminCommand.xuLyLenh(adminMessage("STAB04C_XEM"), async () => {});
  assert.match(ownerBList, /STAB04C Applicant B/);
  const ownerBPreview = await adminCommand.xuLyLenh(adminMessage("STAB04C_DUYET"), async () => {});
  assert.match(ownerBPreview, /STAB04C Applicant B/);
  assert.doesNotMatch(ownerBPreview, /STAB04C Applicant A/);

  pendingOwner = OWNER_A;
  const ownerAPreview = await adminCommand.xuLyLenh(adminMessage("STAB04C_DUYET"), async () => {});
  assert.match(ownerAPreview, /STAB04C Applicant A/);
  assert.doesNotMatch(ownerAPreview, /STAB04C Applicant B/);
  const ownerAApproval = await adminCommand.xuLyLenh(adminMessage("OK"), async () => {});
  assert.match(ownerAApproval, /Đã duyệt/);
  assert.equal(groupApprovalSideEffects, 1);

  pendingOwner = OWNER_B;
  const ownerBCancel = await adminCommand.xuLyLenh(adminMessage("HUỶ"), async () => {});
  assert.match(ownerBCancel, /không duyệt ai/);
  const ownerBPreviewAfterADelete = await adminCommand.xuLyLenh(adminMessage("STAB04C_DUYET"), async () => {});
  assert.match(ownerBPreviewAfterADelete, /STAB04C Applicant B/);
  await adminCommand.xuLyLenh(adminMessage("HUỶ"), async () => {});

  pendingOwner = OWNER_A;
  const ownerAAfterOwnDelete = await adminCommand.xuLyLenh(adminMessage("STAB04C_DUYET"), async () => {});
  assert.match(ownerAAfterOwnDelete, /xem danh sách chờ duyệt/);

  const zoomThread = "STAB04C_SHARED_ZOOM_THREAD";
  const zoomSideEffects = [];
  adminCommand.capHinhDongHoZoom(() => Date.parse("2026-08-25T10:00:00+07:00"));
  adminCommand.capHinhTaoZoom(async (deXuat) => {
    zoomSideEffects.push({ ownerUid: pendingOwner, topic: deXuat.topic });
    return {
      meetingId: `STAB04C_MEETING_${zoomSideEffects.length}`,
      participantPasscode: "STAB04C",
      joinUrl: "https://example.invalid/stab04c",
    };
  });
  adminCommand.capHinhPhanTichLenh(async () => ({ hanhDong: "khong_hieu" }));
  const zoomMessage = (content) => adminMessage(content, zoomThread);
  const makeZoom = (name) => `Tạo Zoom ${name} lúc 20h mai trong 60 phút`;

  pendingOwner = OWNER_A;
  assert.match(await adminCommand.xuLyLenh(zoomMessage(makeZoom("STAB04C A OK")), async () => {}), /Em hiểu bạn muốn tạo/);
  pendingOwner = OWNER_B;
  assert.equal(await adminCommand.xuLyLenh(zoomMessage("OK"), async () => {}), "Không có thao tác nào đang chờ OK.");
  assert.equal(zoomSideEffects.length, 0);
  pendingOwner = OWNER_A;
  assert.match(await adminCommand.xuLyLenh(zoomMessage("OK"), async () => {}), /Đã tạo cuộc họp Zoom/);
  assert.equal(zoomSideEffects.length, 1);
  assert.equal(zoomSideEffects[0].ownerUid, OWNER_A);

  assert.match(await adminCommand.xuLyLenh(zoomMessage(makeZoom("STAB04C A CROSS CANCEL")), async () => {}), /Em hiểu bạn muốn tạo/);
  pendingOwner = OWNER_B;
  assert.doesNotMatch(await adminCommand.xuLyLenh(zoomMessage("HUỶ"), async () => {}), /Đã hủy tạo cuộc họp Zoom/);
  pendingOwner = OWNER_A;
  assert.match(await adminCommand.xuLyLenh(zoomMessage("OK"), async () => {}), /Đã tạo cuộc họp Zoom/);
  assert.equal(zoomSideEffects.length, 2);

  assert.match(await adminCommand.xuLyLenh(zoomMessage(makeZoom("STAB04C A CANCEL")), async () => {}), /Em hiểu bạn muốn tạo/);
  assert.equal(await adminCommand.xuLyLenh(zoomMessage("HUỶ"), async () => {}), "Đã hủy tạo cuộc họp Zoom.");
  assert.equal(await adminCommand.xuLyLenh(zoomMessage("OK"), async () => {}), "Không có thao tác nào đang chờ OK.");
  assert.equal(zoomSideEffects.length, 2);

  assert.match(await adminCommand.xuLyLenh(zoomMessage(makeZoom("STAB04C OWNER A")), async () => {}), /Em hiểu bạn muốn tạo/);
  pendingOwner = OWNER_B;
  assert.match(await adminCommand.xuLyLenh(zoomMessage(makeZoom("STAB04C OWNER B")), async () => {}), /Em hiểu bạn muốn tạo/);
  pendingOwner = OWNER_A;
  assert.match(await adminCommand.xuLyLenh(zoomMessage("OK"), async () => {}), /Đã tạo cuộc họp Zoom/);
  pendingOwner = OWNER_B;
  assert.match(await adminCommand.xuLyLenh(zoomMessage("OK"), async () => {}), /Đã tạo cuộc họp Zoom/);
  assert.equal(zoomSideEffects.length, 4);
  assert.deepEqual(zoomSideEffects.slice(2).map((item) => item.ownerUid), [OWNER_A, OWNER_B]);

  const runtimeMessages = [];
  let runtimeSessionNumber = 0;
  let localRuntimeRequests = 0;
  const localRuntime = http.createServer(async (req, res) => {
    localRuntimeRequests += 1;
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");

    if (req.method === "POST" && req.url === "/session") {
      runtimeSessionNumber += 1;
      res.end(JSON.stringify({ id: `stab04b1-session-${runtimeSessionNumber}` }));
      return;
    }

    if (req.method === "POST" && /^\/session\/[^/]+\/message$/.test(req.url)) {
      const text = (payload.parts || [])
        .filter((part) => part?.type === "text")
        .map((part) => String(part.text || ""))
        .join("\n");
      runtimeMessages.push(text);
      const reply = text.includes("Bạn đang làm nhiệm vụ GHI CHÉP")
        ? UPDATED_PROFILE_A
        : text.includes("Nếu bạn đã nắm nhiệm vụ, trả lời đúng một từ: READY")
          ? "READY"
          : "STAB04_B1_AI_REPLY";
      res.end(JSON.stringify({
        parts: [{ type: "text", text: reply }],
        info: { tokens: { input: 1, output: 1 } },
      }));
      return;
    }

    if (req.method === "DELETE" && /^\/session\/[^/]+$/.test(req.url)) {
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "STAB-04B1 local fixture route not found" }));
  });

  await new Promise((resolve) => localRuntime.listen(0, "127.0.0.1", resolve));
  const localRuntimeUrl = `http://127.0.0.1:${localRuntime.address().port}`;

  let mutableOwnerResolverCallCount = 0;
  let mutableOwnerResolverThrowTriggered = false;
  try {
    await db.saveAiChatConfig(OWNER_A, {
      allowedTopics: "STAB-04B1 owner propagation",
      roleTone: "Test-only",
      useKnowledge: false,
      knowledgeFileIds: [],
      soul: "STAB-04B1 isolated test soul",
      opencodeBaseUrl: localRuntimeUrl,
      opencodeAgent: "general",
      opencodeModel: "fixture/stab04b1",
    });
    await db.saveAccountConfig(OWNER_A, {
      botEnabled: true,
      allowedGroupId: "",
      allowedSenderIds: [],
    });

    await db.saveCustomerMemory(OWNER_A, {
      uid: CUSTOMER_UID,
      displayName: "Khách A",
      profile: PROFILE_A,
    });
    await db.setOwnerInstruction(OWNER_A, {
      uid: CUSTOMER_UID,
      displayName: "Khách A",
      instruction: INSTRUCTION_A,
    });
    await db.saveCustomerMemory(OWNER_B, {
      uid: CUSTOMER_UID,
      displayName: "Khách B",
      profile: PROFILE_B,
    });
    await db.setOwnerInstruction(OWNER_B, {
      uid: CUSTOMER_UID,
      displayName: "Khách B",
      instruction: INSTRUCTION_B,
    });

    await db.insertMessage(OWNER_A, {
      id: "STAB04B1_HISTORY_A",
      threadId: CUSTOMER_THREAD,
      threadType: 0,
      content: "HISTORY_VISIBLE_ONLY_TO_OWNER_A",
      senderId: CUSTOMER_UID,
      senderName: "Khách A",
      ts: Date.now() - 2_000,
    });
    await db.insertMessage(OWNER_B, {
      id: "STAB04B1_HISTORY_B",
      threadId: CUSTOMER_THREAD,
      threadType: 0,
      content: "HISTORY_VISIBLE_ONLY_TO_OWNER_B",
      senderId: CUSTOMER_UID,
      senderName: "Khách B",
      ts: Date.now() - 1_000,
    });
    for (let turn = 0; turn < 5; turn += 1) {
      await db.bumpCustomerTurns(OWNER_A, CUSTOMER_UID, "Khách A");
    }

    let activeOwner = OWNER_A;
    aiChat.capHinhChuTaiKhoan(() => activeOwner);
    await aiChat.loadConfig();
    customerMemory.quenTatCaPhien();

    let originatingOwnerReads = 0;
    aiChat.capHinhChuTaiKhoan(() => {
      originatingOwnerReads += 1;
      if (originatingOwnerReads === 1) return activeOwner;
      mutableOwnerResolverCallCount += 1;
      mutableOwnerResolverThrowTriggered = true;
      throw new Error("STAB-04B1 mutable owner resolver was called after origin capture");
    });

    const normalAPrompt = await customerMemory.bocPrompt(
      "STAB04B1_NORMAL_A_SESSION",
      { threadId: CUSTOMER_THREAD, threadType: 0, senderId: CUSTOMER_UID, senderName: "Khách A" },
      "Normal Owner A request",
      OWNER_A
    );
    assert.match(normalAPrompt, new RegExp(PROFILE_A.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(normalAPrompt, new RegExp(INSTRUCTION_A.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(normalAPrompt, /Owner B/);

    const replyPromise = aiChat.tryReply("Tin nhắn kiểm tra owner propagation", {
      id: "STAB04B1_ORIGIN_MESSAGE",
      threadId: CUSTOMER_THREAD,
      threadType: 0,
      senderId: CUSTOMER_UID,
      senderName: "Khách A",
      isSelf: false,
    });
    activeOwner = OWNER_B;
    const reply = await replyPromise;
    assert.equal(reply, "STAB04_B1_AI_REPLY");

    await waitFor(async () => {
      const memory = await db.getCustomerMemory(OWNER_A, CUSTOMER_UID);
      return memory?.profile === UPDATED_PROFILE_A ? memory : null;
    });

    const ownerAMemory = await db.getCustomerMemory(OWNER_A, CUSTOMER_UID);
    const ownerBMemory = await db.getCustomerMemory(OWNER_B, CUSTOMER_UID);
    assert.equal(originatingOwnerReads, 1);
    assert.equal(mutableOwnerResolverCallCount, 0);
    assert.equal(mutableOwnerResolverThrowTriggered, false);
    assert.equal(ownerAMemory.profile, UPDATED_PROFILE_A);
    assert.equal(ownerAMemory.turns, 0);
    assert.equal(ownerBMemory.profile, PROFILE_B);
    assert.equal(await db.getOwnerInstruction(OWNER_A, CUSTOMER_UID), INSTRUCTION_A);
    assert.equal(await db.getOwnerInstruction(OWNER_B, CUSTOMER_UID), INSTRUCTION_B);

    const aiPrompt = runtimeMessages.find((text) => text.includes("Tin nhắn kiểm tra owner propagation"));
    assert.ok(aiPrompt, "Khong thu duoc AI prompt cua originating request.");
    assert.match(aiPrompt, new RegExp(PROFILE_A.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(aiPrompt, new RegExp(INSTRUCTION_A.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(aiPrompt, /Owner B/);

    const memoryPrompt = runtimeMessages.find((text) => text.includes("Bạn đang làm nhiệm vụ GHI CHÉP"));
    assert.ok(memoryPrompt, "Khong thu duoc prompt duc ket customer-memory.");
    assert.match(memoryPrompt, /HISTORY_VISIBLE_ONLY_TO_OWNER_A/);
    assert.doesNotMatch(memoryPrompt, /HISTORY_VISIBLE_ONLY_TO_OWNER_B/);

    await db.saveAiChatConfig(OWNER_B, {
      allowedTopics: "STAB-04B1 owner propagation",
      roleTone: "Test-only",
      useKnowledge: false,
      knowledgeFileIds: [],
      soul: "STAB-04B1 isolated test soul",
      opencodeBaseUrl: localRuntimeUrl,
      opencodeAgent: "general",
      opencodeModel: "fixture/stab04b1",
    });
    await db.saveAccountConfig(OWNER_B, {
      botEnabled: true,
      allowedGroupId: "",
      allowedSenderIds: [],
    });

    activeOwner = OWNER_B;
    aiChat.capHinhChuTaiKhoan(() => activeOwner);
    await aiChat.loadConfig();
    customerMemory.quenTatCaPhien();

    let ownerBOriginatingReads = 0;
    aiChat.capHinhChuTaiKhoan(() => {
      ownerBOriginatingReads += 1;
      if (ownerBOriginatingReads === 1) return activeOwner;
      mutableOwnerResolverCallCount += 1;
      mutableOwnerResolverThrowTriggered = true;
      throw new Error("STAB-04B1 Owner B mutable resolver was called after origin capture");
    });

    const ownerBReplyPromise = aiChat.tryReply("Independent Owner B request", {
      id: "STAB04B1_OWNER_B_MESSAGE",
      threadId: CUSTOMER_THREAD,
      threadType: 0,
      senderId: CUSTOMER_UID,
      senderName: "Khách B",
      isSelf: false,
    });
    activeOwner = OWNER_A;
    const ownerBReply = await ownerBReplyPromise;
    assert.equal(ownerBReply, "STAB04_B1_AI_REPLY");
    await waitFor(async () => (await db.getCustomerMemory(OWNER_B, CUSTOMER_UID))?.turns === 1);

    const ownerBPrompt = runtimeMessages.find((text) => text.includes("Independent Owner B request"));
    assert.ok(ownerBPrompt, "Khong thu duoc AI prompt cua Owner B request.");
    assert.match(ownerBPrompt, new RegExp(PROFILE_B.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(ownerBPrompt, new RegExp(INSTRUCTION_B.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(ownerBPrompt, /Owner A/);
    assert.ok(runtimeMessages.some(
      (text) => text.includes("HISTORY_VISIBLE_ONLY_TO_OWNER_B")
        && !text.includes("HISTORY_VISIBLE_ONLY_TO_OWNER_A")
    ));
    assert.equal(ownerBOriginatingReads, 1);
    assert.equal(mutableOwnerResolverCallCount, 0);
    assert.equal(mutableOwnerResolverThrowTriggered, false);
    assert.equal((await db.getCustomerMemory(OWNER_A, CUSTOMER_UID)).profile, UPDATED_PROFILE_A);
    assert.equal((await db.getCustomerMemory(OWNER_B, CUSTOMER_UID)).profile, PROFILE_B);
    assert.ok(localRuntimeRequests >= 6, "AI path va one-shot write chua chay du cac async boundary.");
  } finally {
    await new Promise((resolve) => localRuntime.close(resolve));
  }

  const legacyRowsAfter = Number((await sqliteGet(
    inspectionDb,
    "SELECT COUNT(*) AS n FROM knowledge_files WHERE owner_uid IS NULL"
  )).n);
  assert.equal(legacyRowsAfter, legacyRowsBefore);
  assert.equal((await sqliteGet(
    inspectionDb,
    "SELECT content_md FROM knowledge_files WHERE id = ?",
    [LEGACY_KNOWLEDGE_ID]
  )).content_md, "B2_LEGACY_CONTENT");
  await sqliteClose(inspectionDb);

  console.log("STAB_04A_ASSERTIONS = 31/31 PASS");
  console.log("EMAIL_OWNER_CAPTURED_BEFORE_GET_ZOHO_CONFIG = PASS");
  console.log("EMAIL_OWNER_CAPTURED_BEFORE_ASYNC = PASS");
  console.log("EMAIL_CAPTURED_OWNER_SURVIVES_ACCOUNT_SWITCH = PASS");
  console.log("EMAIL_LOOKUP_AND_NOTIFICATION_USE_SAME_OWNER = PASS");
  console.log("SCHEDULER_CAPTURED_OWNER_SURVIVES_ACCOUNT_SWITCH = PASS");
  console.log("STAB_04B1_STATIC_OWNER_ACCOUNTING = 9/9 COMPLETE");
  console.log(`AI_PATH_MUTABLE_OWNER_RESOLVER_CALL_COUNT = ${mutableOwnerResolverCallCount}`);
  console.log(`MUTABLE_OWNER_RESOLVER_THROW_TRIGGERED = ${mutableOwnerResolverThrowTriggered ? "YES" : "NO"}`);
  console.log("OWNER_A_SURVIVES_ACCOUNT_SWITCH = PASS");
  console.log("OWNER_A_NORMAL_PATH = PASS");
  console.log("PROFILE_OWNER_ISOLATION = PASS");
  console.log("HISTORY_CONTEXT_OWNER_ISOLATION = PASS");
  console.log("INSTRUCTION_MEMORY_OWNER_ISOLATION = PASS");
  console.log("WRITE_OWNER_ISOLATION = PASS");
  console.log("OWNER_B_INDEPENDENT_REQUEST = PASS");
  console.log("CROSS_OWNER_LEAKAGE = NO");
  console.log("STAB_04C_CHO_ACCESS_ACCOUNTING = 23/23 COMPLETE");
  console.log("A_CREATE_B_OK = PASS_ISOLATED");
  console.log("A_CREATE_B_CANCEL = PASS_ISOLATED");
  console.log("A_CREATE_A_OK = PASS");
  console.log("A_CREATE_A_CANCEL = PASS");
  console.log("SAME_THREAD_INDEPENDENT_OWNERS = PASS");
  console.log("CROSS_OWNER_PENDING_CONSUMPTION = 0");
  console.log("CROSS_OWNER_PENDING_CANCELLATION = 0");
  console.log("CROSS_OWNER_PENDING_SIDE_EFFECTS = 0");
  console.log("CHO_DUYET_GAN_DAY_OWNER_ISOLATION = PASS");
  console.log("CHO_DAY_CHANGED = NO");
  console.log("STAB_04B2_DB_ACCESS_ACCOUNTING = 5/5 COMPLETE");
  console.log("OWNER_COLUMN_NULLABLE = YES");
  console.log("LEGACY_ROW_DELETED_DURING_SCHEMA_CHANGE = NO");
  console.log("LEGACY_ROW_BACKFILLED = NO");
  console.log("NEW_UPLOAD_OWNER_BOUND = PASS");
  console.log("LIST_OWNER_ISOLATION = PASS");
  console.log("READ_OWNER_ISOLATION = PASS");
  console.log("DELETE_OWNER_ISOLATION = PASS");
  console.log("AI_OWNER_ISOLATION = PASS");
  console.log("POST_AI_SELECTION_OWNER_VALIDATION = PASS");
  console.log("GET_AI_SELECTION_SANITIZATION = PASS");
  console.log("UI_OWNER_SWITCH_PROOF_TYPE = STATIC_CONTRACT");
  console.log("OLD_OWNER_KNOWLEDGE_VISIBLE_AFTER_INVALIDATION = NO");
  console.log("NEW_OWNER_REFRESH_REGISTERED = YES");
  console.log("CROSS_OWNER_KNOWLEDGE_DELETE = 0");
  console.log("CROSS_OWNER_AI_KNOWLEDGE_CONTENT = 0");
  console.log("UNAUTHORIZED_LEGACY_DELETE_COUNT = 0");
  console.log("CANONICAL_DB_WRITTEN_BY_STAB04A = NO");
  console.log("LIVE_APP_OR_REAL_PROVIDER_USED = NO");
}

function runParent() {
  fs.mkdirSync(TEMP_PARENT, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(TEMP_PARENT, "focused-"));
  assertInsideTempParent(tempDir);

  let child;
  try {
    child = spawnSync(process.execPath, [SCRIPT, "--worker", tempDir], {
      cwd: REPO,
      encoding: "utf8",
      windowsHide: true,
      timeout: 45_000,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw child.error;
    assert.equal(child.status, 0, `STAB-04A focused worker that bai (exit ${child.status}).`);
  } finally {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    if (fs.existsSync(TEMP_PARENT) && fs.readdirSync(TEMP_PARENT).length === 0) {
      fs.rmdirSync(TEMP_PARENT);
    }
  }
}

if (process.argv[2] === "--worker") {
  sourceProof();
  behaviorProof(process.argv[3]).then(
    () => process.exit(0),
    (error) => {
      console.error("STAB-04A focused regression hong:", error);
      process.exit(1);
    }
  );
} else {
  runParent();
}
