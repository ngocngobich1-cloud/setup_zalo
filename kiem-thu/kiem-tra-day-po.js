/**
 * KIEM THU TINH NANG "DAY PO" — chi dan rieng cua chu shop cho tung nguoi.
 *
 * Chay:  node kiem-thu/kiem-tra-day-po.js
 *
 * Nguyen tac cua bo kiem thu nay:
 *  - KHONG dung CSDL that. Moi bai chay tren mot thu muc tam: process.chdir()
 *    truoc khi import lib/db.js, vi db.js tinh path.resolve("data") ngay luc
 *    nap module.
 *  - KHONG goi provider that. OpenCode duoc thay bang mot may chu HTTP gia chay
 *    tren 127.0.0.1, tra ve dung mieng JSON ma bo phan tich lenh se tra ve.
 *  - KHONG gui tin Zalo that. Ham gui duoc thay bang ham dem.
 *  - Moi bai phai khang dinh TRANG THAI QUAN SAT DUOC (gia tri trong CSDL, noi
 *    dung prompt, so lan ghi), khong bai nao duoc "pass vi ham co ton tai".
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import sqlite3 from "sqlite3";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const napLib = (ten) => import(pathToFileURL(path.join(REPO, "lib", ten)).href);

/* ------------------------------------------------------------------ */
/* Khung chay                                                          */
/* ------------------------------------------------------------------ */
const bienBan = [];
async function bai(ma, moTa, fn) {
  try {
    await fn();
    bienBan.push({ ma, ketQua: "PASS", moTa });
  } catch (error) {
    bienBan.push({ ma, ketQua: "FAIL", moTa, loi: error.message });
  }
}

/* ------------------------------------------------------------------ */
/* OpenCode gia                                                        */
/* ------------------------------------------------------------------ */
let phanTichTiepTheo = null;
let soLanGoiPhanTich = 0;

const mayGia = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/session") {
      return res.end(JSON.stringify({ id: "phien-gia" }));
    }
    if (req.method === "POST" && req.url.endsWith("/message")) {
      soLanGoiPhanTich++;
      return res.end(JSON.stringify({ parts: [{ type: "text", text: JSON.stringify(phanTichTiepTheo) }] }));
    }
    return res.end(JSON.stringify({ ok: true }));
  });
});

function moMayGia() {
  return new Promise((resolve) => {
    mayGia.listen(0, "127.0.0.1", () => resolve(mayGia.address().port));
  });
}

/* ------------------------------------------------------------------ */
/* Du lieu dung chung                                                  */
/* ------------------------------------------------------------------ */
const CHU_A = "111111111";
const CHU_B = "222222222";
const ADMIN_A = "800000001";

const UID_BO = "900000001";
const UID_Y = "900000002";
const UID_NHOM = "950000001";
const UID_TRUNG_1 = "900000003";
const UID_TRUNG_2 = "900000004";
const UID_CU = "900000005";
const UID_KHONG_HO_SO = "900000006";

const CHI_DAN_BO = "Xưng con, gọi là bố.";

/** Doc thang tu SQLite, khong qua tang anh xa - de nhin thay dung gia tri cot. */
function docDongThô(duongDanDb, ownerUid, uid) {
  return new Promise((resolve, reject) => {
    const conn = new sqlite3.Database(duongDanDb, sqlite3.OPEN_READONLY);
    conn.get(
      "SELECT * FROM customer_memory WHERE owner_uid = ? AND uid = ?",
      [String(ownerUid), String(uid)],
      (err, row) => {
        conn.close();
        err ? reject(err) : resolve(row || null);
      }
    );
  });
}

/* ------------------------------------------------------------------ */
/* CHAY                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  const cong = await moMayGia();

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "day-po-"));
  fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
  process.chdir(TMP);
  const DB_FILE = path.join(TMP, "data", "zalo.db");

  const db = await napLib("db.js");
  await db.initDb();

  const adminCmd = await napLib("admin-command.js");
  const customerMemory = await napLib("customer-memory.js");

  // Tai khoan Zalo dang dang nhap. Ca hai module deu lay chu qua seam nay.
  let chuHienTai = CHU_A;
  adminCmd.capHinhChuTaiKhoan(() => chuHienTai);
  customerMemory.capHinhChuTaiKhoan(() => chuHienTai);

  await db.saveAiChatConfig({
    allowedTopics: "",
    roleTone: "",
    useKnowledge: false,
    knowledgeFileIds: [],
    soul: "",
    opencodeBaseUrl: `http://127.0.0.1:${cong}`,
    opencodeAgent: "general",
    opencodeModel: "",
  });
  await db.setAdminZalo(CHU_A, ADMIN_A, "Chủ shop");

  const bayGio = Math.floor(Date.now() / 1000);
  const recent = { lastMessage: "xin chào", lastMessageAt: bayGio, updatedAt: bayGio };

  await db.upsertThread(CHU_A, { id: UID_BO, threadType: 0, title: "Bố", ...recent });
  await db.upsertThread(CHU_A, { id: UID_Y, threadType: 0, title: "Chị Y", ...recent });
  await db.upsertThread(CHU_A, { id: UID_NHOM, threadType: 1, title: "Lớp K13", ...recent });
  await db.upsertThread(CHU_A, { id: UID_TRUNG_1, threadType: 0, title: "Thu Hà", ...recent });
  await db.upsertThread(CHU_A, { id: UID_TRUNG_2, threadType: 0, title: "Thu Hà", ...recent });
  await db.upsertThread(CHU_A, { id: UID_KHONG_HO_SO, threadType: 0, title: "Khách Mới", ...recent });
  // Lien he CU: khong co tin nhan nao -> chi nhin thay khi recentOnly:false.
  await db.upsertThread(CHU_A, { id: UID_CU, threadType: 0, title: "Bác Cũ", updatedAt: bayGio });
  await db.upsertThread(CHU_B, { id: UID_BO, threadType: 0, title: "Bố", ...recent });

  const tinAdmin = (noiDung) => ({
    threadId: ADMIN_A,
    threadType: 0,
    senderId: ADMIN_A,
    senderName: "Chủ shop",
    content: noiDung,
  });
  // Ham gui GIA: ghi lai loi goi de khang dinh, tuyet doi khong cham Zalo that.
  const daGui = [];
  const guiGia = async (payload) => { daGui.push(payload); };

  /** Chay mot lenh admin qua DUNG duong dispatch that cua xuLyLenh. */
  async function raLenh(parse, cauLenh = "câu lệnh của chị") {
    phanTichTiepTheo = parse;
    return adminCmd.xuLyLenh(tinAdmin(cauLenh), guiGia);
  }

  /** Gui mot cau thuan tuy, khong dat truoc ket qua phan tich. */
  async function noi(cauLenh, tin = null) {
    return adminCmd.xuLyLenh(tin || tinAdmin(cauLenh), guiGia);
  }

  /**
   * Go "OK". CAI BAY: dat san mot ket qua phan tich vo nghia, neu buoc
   * xac nhan lo goi bo phan tich thi lenh se hong ngay va bai test thay duoc.
   */
  async function xacNhan(cau = "OK", tin = null) {
    phanTichTiepTheo = { hanhDong: "khong_hieu", lyDo: "BO PHAN TICH KHONG DUOC GOI O BUOC XAC NHAN" };
    return noi(cau, tin);
  }

  /** Xoa sach moi thu dang cho (ban nhap day + lenh gui cho xac nhan). */
  async function donDep() {
    phanTichTiepTheo = { hanhDong: "khong_hieu", lyDo: "don dep" };
    await noi("hủy");
    await noi("hủy");
  }

  const tinKhach = (uid, ten, threadType, noiDung = "alo em") => ({
    threadId: uid,
    threadType,
    senderId: uid,
    senderName: ten,
    content: noiDung,
  });

  /* ================= T01–T24 ================= */

  await bai("T01", "admin dạy contact X → đọc lại, xác nhận, rồi mới ghi", async () => {
    const xem = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Bố", quyTac: CHI_DAN_BO });
    assert.match(xem, /OK/, `phải đọc lại chờ OK: ${xem}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), "", "đã ghi khi chị CHƯA xác nhận");

    const xong = await xacNhan();
    assert.match(xong, /Em đã ghi nhớ rồi/, `trả lời bất ngờ: ${xong}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), CHI_DAN_BO);
  });

  await bai("T02", "chỉ dẫn nằm đúng dưới owner_uid + uid của X", async () => {
    const dong = await docDongThô(DB_FILE, CHU_A, UID_BO);
    assert.ok(dong, "không thấy dòng customer_memory");
    assert.equal(dong.owner_uid, CHU_A);
    assert.equal(dong.uid, UID_BO);
    assert.equal(dong.owner_instruction, CHI_DAN_BO);
  });

  await bai("T03", "prompt 1-1 của X có chứa chỉ dẫn", async () => {
    const p = await customerMemory.bocPrompt("phien-1", tinKhach(UID_BO, "Bố", 0), "con chào");
    assert.ok(p.includes(CHI_DAN_BO), "prompt thiếu chỉ dẫn");
    assert.ok(p.includes("CHỈ DẪN RIÊNG CỦA CHỦ SHOP"), "thiếu tiêu đề khối chỉ dẫn");
  });

  await bai("T04", "prompt của contact Y KHÔNG chứa chỉ dẫn của X", async () => {
    const p = await customerMemory.bocPrompt("phien-1", tinKhach(UID_Y, "Chị Y", 0), "alo");
    assert.ok(!p.includes(CHI_DAN_BO), "rò rỉ chỉ dẫn sang người khác");
    assert.ok(!p.includes("CHỈ DẪN RIÊNG"), "Y không được có khối chỉ dẫn nào");
  });

  await bai("T05", "tài khoản Zalo B KHÔNG thừa hưởng chỉ dẫn của A", async () => {
    assert.equal(await db.getOwnerInstruction(CHU_B, UID_BO), "");
    chuHienTai = CHU_B;
    const p = await customerMemory.bocPrompt("phien-B", tinKhach(UID_BO, "Bố", 0), "alo");
    chuHienTai = CHU_A;
    assert.ok(!p.includes(CHI_DAN_BO), "chỉ dẫn của tài khoản A lọt sang tài khoản B");
  });

  await bai("T06", "khách thường không sửa được owner_instruction", async () => {
    const laAdmin = await adminCmd.laLenhAdmin(
      { threadId: UID_BO, threadType: 0, senderId: UID_BO, content: "dạy: xưng anh với tôi" }
    );
    assert.equal(laAdmin, false, "nick khách bị coi là admin");
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), CHI_DAN_BO, "chỉ dẫn bị đổi");
  });

  await bai("T07", "lệnh dạy không biến thành hồ sơ khách của admin", async () => {
    const dong = await docDongThô(DB_FILE, CHU_A, ADMIN_A);
    assert.equal(dong, null, "lệnh dạy đã tạo hồ sơ khách cho chính nick admin");
  });

  await bai("T08", "dạy thêm câu khác → nối thêm dòng, giữ câu cũ", async () => {
    const them = "Không nhắc chuyện tiền nong.";
    await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Bố", quyTac: them });
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), CHI_DAN_BO, "ghi khi chưa xác nhận");
    await xacNhan();
    const sau = await db.getOwnerInstruction(CHU_A, UID_BO);
    assert.equal(sau, `${CHI_DAN_BO}\n${them}`);
  });

  await bai("T09", "dạy trùng câu đã có → KHÔNG ghi thêm", async () => {
    const truoc = await db.getOwnerInstruction(CHU_A, UID_BO);
    const traLoi = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Bố", quyTac: "  xưng CON, gọi là Bố.  " });
    assert.match(traLoi, /đã ghi nhớ.*từ trước/, `trả lời bất ngờ: ${traLoi}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), truoc, "đã ghi trùng");
  });

  await bai("T10", "day_sua thay toàn bộ chỉ dẫn", async () => {
    const moi = "Gọi là bố, xưng con, luôn hỏi thăm sức khoẻ.";
    const truoc = await db.getOwnerInstruction(CHU_A, UID_BO);
    await raLenh({ hanhDong: "day_sua", dichTen: "Bố", quyTac: moi });
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), truoc, "ghi khi chưa xác nhận");
    await xacNhan();
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), moi);
  });

  await bai("T11", "day_sua giữ nguyên profile/display_name/turns/locked/created_at", async () => {
    // Dung du lieu that do AI/luong binh thuong tao ra truoc, roi day len tren.
    await db.saveCustomerMemory(CHU_A, {
      uid: UID_Y,
      displayName: "Chị Y",
      profile: "Hoàn cảnh: đang học lớp K13.",
      locked: true,
    });
    await db.bumpCustomerTurns(CHU_A, UID_Y, "Chị Y");
    const truoc = await docDongThô(DB_FILE, CHU_A, UID_Y);

    await raLenh({ hanhDong: "day_sua", dichTen: "Chị Y", quyTac: "Gọi là chị, xưng em." });
    await xacNhan();
    const sau = await docDongThô(DB_FILE, CHU_A, UID_Y);

    assert.equal(sau.owner_instruction, "Gọi là chị, xưng em.", "chỉ dẫn chưa được ghi");
    assert.equal(sau.profile, truoc.profile, "profile bị đổi");
    assert.equal(sau.display_name, truoc.display_name, "display_name bị đổi");
    assert.equal(sau.turns, truoc.turns, "turns bị đổi");
    assert.equal(sau.locked, truoc.locked, "locked bị đổi");
    assert.equal(sau.created_at, truoc.created_at, "created_at bị đổi");
  });

  await bai("T12", "day_quen chỉ xoá owner_instruction, giữ phần còn lại", async () => {
    const truoc = await docDongThô(DB_FILE, CHU_A, UID_Y);
    const traLoi = await raLenh({ hanhDong: "day_quen", dichTen: "Chị Y" });
    assert.match(traLoi, /quên hết/, `trả lời bất ngờ: ${traLoi}`);
    const sau = await docDongThô(DB_FILE, CHU_A, UID_Y);
    assert.equal(sau.owner_instruction, "");
    assert.equal(sau.profile, truoc.profile, "profile bị đổi");
    assert.equal(sau.display_name, truoc.display_name, "display_name bị đổi");
    assert.equal(sau.turns, truoc.turns, "turns bị đổi");
    assert.equal(sau.locked, truoc.locked, "locked bị đổi");

    // Quen lan hai khi da rong: khong con gi de ghi, phai bao that.
    const lai = await raLenh({ hanhDong: "day_quen", dichTen: "Chị Y" });
    assert.match(lai, /chưa có chỉ dẫn riêng nào/, `trả lời bất ngờ: ${lai}`);
  });

  await bai("T13", "day_xem chỉ đọc, không ghi", async () => {
    const truoc = await docDongThô(DB_FILE, CHU_A, UID_BO);
    const traLoi = await raLenh({ hanhDong: "day_xem", dichTen: "Bố" });
    const sau = await docDongThô(DB_FILE, CHU_A, UID_BO);
    assert.ok(traLoi.includes(truoc.owner_instruction), "không trả về đúng chỉ dẫn");
    assert.deepEqual(sau, truoc, "day_xem đã làm thay đổi dòng dữ liệu");
    assert.ok(!traLoi.includes("Hoàn cảnh:"), "day_xem để lộ profile");
  });

  await bai("T14", "đích không tồn tại → không ghi", async () => {
    const traLoi = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Người Không Có Thật", quyTac: "abc" });
    assert.match(traLoi, /không tìm thấy/i, `trả lời bất ngờ: ${traLoi}`);
    const dong = await docDongThô(DB_FILE, CHU_A, "Người Không Có Thật");
    assert.equal(dong, null);
  });

  await bai("T15", "trùng tên hiển thị → không ghi", async () => {
    const traLoi = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Thu Hà", quyTac: "gọi là em" });
    assert.match(traLoi, /trùng tên/, `trả lời bất ngờ: ${traLoi}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_TRUNG_1), "");
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_TRUNG_2), "");
  });

  await bai("T16", "liên hệ cũ (không recent) vẫn tra ra được", async () => {
    // Chung minh dung: recentOnly:true KHONG nhin thay nguoi nay.
    const recent = await db.listThreads(CHU_A, { recentOnly: true });
    assert.ok(!recent.some((t) => String(t.id) === UID_CU), "bối cảnh sai: Bác Cũ vẫn nằm trong danh sách recent");

    const traLoi = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Bác Cũ", quyTac: "Gọi là bác, xưng cháu." });
    assert.match(traLoi, /Bác Cũ/, `không resolve được liên hệ cũ: ${traLoi}`);
    await xacNhan();
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_CU), "Gọi là bác, xưng cháu.");
  });

  await bai("T17", "đích là nhóm → từ chối, không ghi", async () => {
    const traLoi = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Lớp K13", quyTac: "gọi cả lớp là các em" });
    assert.match(traLoi, /nhóm/, `trả lời bất ngờ: ${traLoi}`);
    assert.match(traLoi, /chưa áp dụng cho nhóm/, `thiếu lý do từ chối: ${traLoi}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_NHOM), "");
  });

  await bai("T18", "vượt 300 ký tự → từ chối, giữ nguyên giá trị cũ", async () => {
    const truoc = await db.getOwnerInstruction(CHU_A, UID_BO);
    const dai = "x".repeat(301);

    const r1 = await raLenh({ hanhDong: "day_sua", dichTen: "Bố", quyTac: dai });
    assert.match(r1, /quá mức 300/, `trả lời bất ngờ: ${r1}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), truoc, "day_sua đã ghi đè dù quá dài");

    // Noi them cho tong vuot 300 -> cung phai tu choi, tinh tren GIA TRI CUOI.
    const them = "y".repeat(300 - truoc.length);
    const r2 = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Bố", quyTac: them });
    assert.match(r2, /quá mức 300/, `trả lời bất ngờ: ${r2}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), truoc, "day_ghi_nho đã ghi dù vượt trần");
  });

  await bai("T19", "ducKetHoSo ghi đè profile nhưng KHÔNG đụng owner_instruction", async () => {
    const truoc = await db.getOwnerInstruction(CHU_A, UID_BO);
    assert.ok(truoc, "bối cảnh sai: Bố phải đang có chỉ dẫn");
    // Dung dung ham ma ducKetHoSo() goi de ghi ho so.
    await db.saveCustomerMemory(CHU_A, {
      uid: UID_BO,
      displayName: "Bố",
      profile: "Xưng hô: chưa rõ\nHoàn cảnh: chưa rõ",
    });
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), truoc, "AI đã xoá mất chỉ dẫn của chị");
    const dong = await docDongThô(DB_FILE, CHU_A, UID_BO);
    assert.match(dong.profile, /Xưng hô: chưa rõ/, "profile chưa được ghi");
  });

  await bai("T20", "chỉ dẫn sống qua restart (tiến trình mới, cùng CSDL)", async () => {
    const kichBan = `
      process.chdir(${JSON.stringify(TMP)});
      const db = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "lib", "db.js")).href)});
      await db.initDb();
      console.log(JSON.stringify({ chiDan: await db.getOwnerInstruction(${JSON.stringify(CHU_A)}, ${JSON.stringify(UID_BO)}) }));
    `;
    const ra = execFileSync(process.execPath, ["--input-type=module", "-e", kichBan], { encoding: "utf8" });
    const doc = JSON.parse(ra.trim().split("\n").pop());
    assert.equal(doc.chiDan, await db.getOwnerInstruction(CHU_A, UID_BO));
    assert.ok(doc.chiDan, "tiến trình mới đọc ra chuỗi rỗng");
  });

  await bai("T21", "người không có chỉ dẫn → prompt giữ nguyên hành vi cũ", async () => {
    await db.saveCustomerMemory(CHU_A, {
      uid: UID_Y,
      displayName: "Chị Y",
      profile: "Hoàn cảnh: đang học lớp K13.",
    });
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_Y), "", "bối cảnh sai: Y phải không có chỉ dẫn");

    // 1-1 co ho so: y het hanh vi cu — khoi ho so + tin goc, khong tien to ten.
    const rieng = await customerMemory.bocPrompt("phien-T21a", tinKhach(UID_Y, "Chị Y", 0), "em hỏi chút");
    assert.equal(
      rieng,
      "# HỒ SƠ NGƯỜI ĐANG NHẮN — Chị Y\n" +
        "Hoàn cảnh: đang học lớp K13.\n" +
        "(Đây là ghi chú nội bộ để bạn hiểu ngữ cảnh. KHÔNG đọc lại nguyên văn cho khách, " +
        "KHÔNG khoe rằng bạn có hồ sơ. Chỉ dùng để trả lời cho nhất quán.)\n\n" +
        "em hỏi chút"
    );

    // Trong nhom: van gan ten nguoi gui vao dau tin nhu truoc.
    const nhom = await customerMemory.bocPrompt("phien-T21b", tinKhach(UID_Y, "Chị Y", 1), "em hỏi chút");
    assert.ok(nhom.endsWith("Chị Y: em hỏi chút"), `hành vi nhóm đã đổi: ${nhom}`);

    // Nguoi hoan toan chua co gi: tra ve dung tin goc.
    const tron = await customerMemory.bocPrompt("phien-T21c", tinKhach(UID_KHONG_HO_SO, "Khách Mới", 0), "chào em");
    assert.equal(tron, "chào em");
  });

  await bai("T22", "Soul / tri thức / bootstrap không bị đụng", async () => {
    const opencode = fs.readFileSync(path.join(REPO, "lib", "opencode.js"), "utf8");
    assert.ok(opencode.includes("buildBootstrapMessage"), "bootstrap biến mất");
    assert.ok(!opencode.includes("owner_instruction"), "opencode.js bị chèn owner_instruction");
    const aiChat = fs.readFileSync(path.join(REPO, "lib", "ai-chat.js"), "utf8");
    assert.ok(!aiChat.includes("owner_instruction"), "ai-chat.js bị chèn owner_instruction");
    assert.ok(!aiChat.includes("OwnerInstruction"), "ai-chat.js bị chèn hàm chỉ dẫn");
    const knowledge = fs.readFileSync(path.join(REPO, "lib", "knowledge.js"), "utf8");
    assert.ok(!knowledge.includes("owner_instruction"), "knowledge.js bị đụng");
  });

  await bai("T23", "lệnh admin cũ vẫn chạy đúng (gui_tin, xem_lich)", async () => {
    const r1 = await raLenh({ hanhDong: "gui_tin", dichIds: [UID_NHOM], noiDung: "mai nghỉ học" });
    assert.match(r1, /Em sẽ gửi vào/, `gui_tin hỏng: ${r1}`);
    assert.match(r1, /Lớp K13/, `gui_tin mất đích: ${r1}`);
    assert.match(r1, /OK để em gửi/, `gui_tin mất bước xác nhận: ${r1}`);

    const r2 = await raLenh({ hanhDong: "xem_lich" });
    assert.match(r2, /lịch hẹn nào đang chờ|lịch đang chờ/, `xem_lich hỏng: ${r2}`);

    const r3 = await raLenh({ hanhDong: "khong_hieu", lyDo: "thử" });
    assert.match(r3, /Em chưa hiểu/, `nhánh không hiểu bị hỏng: ${r3}`);

    // Bai nay tao ra mot lenh gui dang cho -> phai don di, khong thi cac bai sau
    // se bi chan boi dung cai chot chan R1 ma minh vua them.
    const r4 = await noi("hủy");
    assert.match(r4, /Đã huỷ/, `huỷ lệnh gửi đang chờ bị hỏng: ${r4}`);
  });

  await bai("T24", "CSDL cũ đã có dữ liệu → thêm cột, giữ nguyên dữ liệu", async () => {
    const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "day-po-cu-"));
    fs.mkdirSync(path.join(TMP2, "data"), { recursive: true });
    const db2 = path.join(TMP2, "data", "zalo.db");

    // Dung mot CSDL "truoc khi co tinh nang": customer_memory KHONG co cot moi.
    await new Promise((resolve, reject) => {
      const conn = new sqlite3.Database(db2);
      conn.serialize(() => {
        conn.run(`CREATE TABLE threads (
          local_id TEXT PRIMARY KEY, owner_uid TEXT, remote_thread_id TEXT NOT NULL,
          thread_type INTEGER NOT NULL DEFAULT 0, title TEXT, avatar TEXT,
          last_message TEXT, last_message_at INTEGER, updated_at INTEGER NOT NULL,
          UNIQUE(owner_uid, remote_thread_id))`);
        conn.run(`CREATE TABLE customer_memory (
          owner_uid TEXT, uid TEXT NOT NULL, display_name TEXT,
          profile TEXT NOT NULL DEFAULT '', locked INTEGER NOT NULL DEFAULT 0,
          turns INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY (owner_uid, uid))`);
        conn.run(
          `INSERT INTO customer_memory (owner_uid, uid, display_name, profile, locked, turns, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [CHU_A, UID_BO, "Bố", "Hoàn cảnh: hồ sơ có từ trước.", 1, 4, 1000, 2000],
          (e) => (e ? reject(e) : conn.close(() => resolve()))
        );
      });
    });

    const kichBan = `
      process.chdir(${JSON.stringify(TMP2)});
      const db = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "lib", "db.js")).href)});
      await db.initDb();
      console.log(JSON.stringify({ chiDan: await db.getOwnerInstruction(${JSON.stringify(CHU_A)}, ${JSON.stringify(UID_BO)}) }));
    `;
    const ra = execFileSync(process.execPath, ["--input-type=module", "-e", kichBan], { encoding: "utf8" });
    const doc = JSON.parse(ra.trim().split("\n").pop());
    assert.equal(doc.chiDan, "", "cột mới phải mặc định rỗng cho dòng cũ");

    const dong = await docDongThô(db2, CHU_A, UID_BO);
    assert.equal(dong.profile, "Hoàn cảnh: hồ sơ có từ trước.", "profile cũ bị mất");
    assert.equal(dong.display_name, "Bố", "display_name cũ bị mất");
    assert.equal(dong.locked, 1, "locked cũ bị mất");
    assert.equal(dong.turns, 4, "turns cũ bị mất");
    assert.equal(dong.created_at, 1000, "created_at cũ bị mất");
    assert.equal(dong.owner_instruction, "", "cột mới không được tạo");
    fs.rmSync(TMP2, { recursive: true, force: true });
  });

  /* ================= A01–A10 ================= */

  await bai("A01", "X nói trong NHÓM → không bơm chỉ dẫn", async () => {
    const chiDan = await db.getOwnerInstruction(CHU_A, UID_BO);
    assert.ok(chiDan, "bối cảnh sai: Bố phải đang có chỉ dẫn");
    const p = await customerMemory.bocPrompt("phien-nhom", tinKhach(UID_BO, "Bố", 1), "alo");
    assert.ok(!p.includes(chiDan), "chỉ dẫn riêng lọt vào nhóm");
    assert.ok(!p.includes("CHỈ DẪN RIÊNG"), "khối chỉ dẫn lọt vào nhóm");
  });

  await bai("A02", "threadType undefined → không bơm", async () => {
    const p = await customerMemory.bocPrompt("phien-a02", {
      threadId: UID_BO, senderId: UID_BO, senderName: "Bố", content: "alo",
    }, "alo");
    assert.ok(!p.includes("CHỈ DẪN RIÊNG"), "fail-open với undefined");
  });

  await bai("A03", "threadType null → không bơm", async () => {
    const p = await customerMemory.bocPrompt("phien-a03", tinKhach(UID_BO, "Bố", null), "alo");
    assert.ok(!p.includes("CHỈ DẪN RIÊNG"), "Number(null)===0 đã lọt");
  });

  await bai("A04", "threadType lạ → không bơm", async () => {
    // Tat ca nhung thu duoi day deu bi Number(x) quy thanh 0 hoac la rac:
    // false, [], [0], " ", new Number(0)... khong cai nao duoc coi la chat rieng.
    const rac = [2, "nhom", "", " ", NaN, {}, [], [0], [[]], "0abc", 0.5, true, false, new Number(0)];
    for (const kieu of rac) {
      const p = await customerMemory.bocPrompt("phien-a04", tinKhach(UID_BO, "Bố", kieu), "alo");
      assert.ok(!p.includes("CHỈ DẪN RIÊNG"), `lọt với threadType = ${JSON.stringify(kieu)}`);
    }
    // ...nhung so 0 va chuoi "0" van phai duoc coi la chat rieng that.
    for (const kieu of [0, "0"]) {
      const p = await customerMemory.bocPrompt("phien-a04b", tinKhach(UID_BO, "Bố", kieu), "alo");
      assert.ok(p.includes("CHỈ DẪN RIÊNG"), `chặn nhầm chat riêng với ${JSON.stringify(kieu)}`);
    }
  });

  await bai("A05", "người chưa có profile vẫn nhận được chỉ dẫn", async () => {
    await db.setOwnerInstruction(CHU_A, { uid: UID_KHONG_HO_SO, instruction: "Gọi là bạn.", displayName: "Khách Mới" });
    const dong = await docDongThô(DB_FILE, CHU_A, UID_KHONG_HO_SO);
    assert.equal(dong.profile, "", "bối cảnh sai: người này phải chưa có profile");
    const p = await customerMemory.bocPrompt("phien-a05", tinKhach(UID_KHONG_HO_SO, "Khách Mới", 0), "chào");
    assert.ok(p.includes("Gọi là bạn."), "người chưa có hồ sơ bị bỏ qua chỉ dẫn");
    assert.ok(!p.includes("HỒ SƠ NGƯỜI ĐANG NHẮN"), "không được bịa khối hồ sơ rỗng");
  });

  await bai("A06", "chỉ dẫn xuất hiện ở MỌI lượt 1-1, không chỉ lượt đầu", async () => {
    const chiDan = await db.getOwnerInstruction(CHU_A, UID_BO);
    for (let i = 1; i <= 3; i++) {
      const p = await customerMemory.bocPrompt("phien-lien-tuc", tinKhach(UID_BO, "Bố", 0), `tin ${i}`);
      assert.ok(p.includes(chiDan), `lượt ${i} mất chỉ dẫn`);
    }
  });

  await bai("A07", "lệnh dạy KHÔNG gọi quenTatCaPhien()", async () => {
    // Bang chung 1 — nguon: khong co loi goi nao trong admin-command.js.
    const nguon = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
    assert.ok(!nguon.includes("quenTatCaPhien"), "admin-command.js có gọi quenTatCaPhien");

    // Bang chung 2 — hanh vi: nap ho so vao mot phien, day mot cau, roi kiem
    // tra so danh dau cua phien do VAN CON (neu bi quen thi khoi ho so se hien
    // lai o luot sau).
    await db.saveCustomerMemory(CHU_A, { uid: UID_BO, displayName: "Bố", profile: "Hoàn cảnh: ABC." });
    const p1 = await customerMemory.bocPrompt("phien-a07", tinKhach(UID_BO, "Bố", 0), "tin 1");
    assert.ok(p1.includes("HỒ SƠ NGƯỜI ĐANG NHẮN"), "bối cảnh sai: lượt đầu phải có hồ sơ");

    await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Bác Cũ", quyTac: "Hỏi thăm sức khoẻ trước." });
    await xacNhan();

    const p2 = await customerMemory.bocPrompt("phien-a07", tinKhach(UID_BO, "Bố", 0), "tin 2");
    assert.ok(!p2.includes("HỒ SƠ NGƯỜI ĐANG NHẮN"), "cache phiên đã bị xoá → có ai đó gọi quenTatCaPhien");
  });

  await bai("A08", "display_name của dòng cũ không đổi sau day_ghi_nho/day_sua", async () => {
    await db.saveCustomerMemory(CHU_A, { uid: UID_CU, displayName: "Tên Gốc Trong Hồ Sơ", profile: "abc" });
    const truoc = await docDongThô(DB_FILE, CHU_A, UID_CU);
    assert.equal(truoc.display_name, "Tên Gốc Trong Hồ Sơ");

    // Ten trong threads la "Bac Cu" — khac han. Neu conflict-update con
    // display_name = COALESCE(...) thi cho nay se bi ghi de.
    await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Bác Cũ", quyTac: "Nói chậm thôi." });
    await xacNhan();
    assert.equal((await docDongThô(DB_FILE, CHU_A, UID_CU)).display_name, "Tên Gốc Trong Hồ Sơ", "day_ghi_nho đổi display_name");

    await raLenh({ hanhDong: "day_sua", dichTen: "Bác Cũ", quyTac: "Nói chậm và rõ." });
    await xacNhan();
    assert.equal((await docDongThô(DB_FILE, CHU_A, UID_CU)).display_name, "Tên Gốc Trong Hồ Sơ", "day_sua đổi display_name");
  });

  await bai("A09", "quên khi chưa có dòng nào → KHÔNG tạo dòng mới", async () => {
    assert.equal(await docDongThô(DB_FILE, CHU_A, UID_TRUNG_1), null, "bối cảnh sai: phải chưa có dòng");
    const kq = await db.clearOwnerInstruction(CHU_A, UID_TRUNG_1);
    assert.equal(kq.changes, 0);
    assert.equal(await docDongThô(DB_FILE, CHU_A, UID_TRUNG_1), null, "clear đã đẻ ra dòng rỗng");
  });

  await bai("A10", "owner_instruction KHÔNG lộ qua mapCustomer / API hiện có", async () => {
    const kh = await db.getCustomerMemory(CHU_A, UID_BO);
    assert.ok(kh, "không đọc được hồ sơ");
    assert.equal(kh.ownerInstruction, undefined, "mapCustomer đã lộ chỉ dẫn");
    assert.equal(kh.owner_instruction, undefined, "mapCustomer đã lộ chỉ dẫn");
    assert.deepEqual(
      Object.keys(kh).sort(),
      ["createdAt", "displayName", "locked", "profile", "turns", "uid", "updatedAt"],
      "hợp đồng mapCustomer đã đổi"
    );
    const ds = await db.listCustomerMemories(CHU_A);
    assert.ok(ds.every((k) => k.ownerInstruction === undefined), "listCustomerMemories lộ chỉ dẫn");

    // PUT /api/customer-memory dung saveCustomerMemory -> khong duoc xoa chi dan.
    const truoc = await db.getOwnerInstruction(CHU_A, UID_BO);
    await db.saveCustomerMemory(CHU_A, { uid: UID_BO, profile: "Hồ sơ do chị sửa tay." });
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_BO), truoc, "sửa hồ sơ tay đã xoá chỉ dẫn");
  });

  /* ================= C01–C18: XAC NHAN TRUOC KHI GHI ================= */

  const UID_C = UID_KHONG_HO_SO; // "Khách Mới" - dung rieng cho nhom bai C

  await bai("C01", "day_ghi_nho pha 1 → đọc lại, CHƯA ghi, có bản nháp", async () => {
    await donDep();
    const truoc = await db.getOwnerInstruction(CHU_A, UID_C);
    const xem = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Luôn chào bằng tên." });
    assert.ok(xem.includes("Luôn chào bằng tên."), `câu đọc lại thiếu nội dung: ${xem}`);
    assert.match(xem, /OK/, "không mời chị trả lời OK");
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), truoc, "ĐÃ GHI khi chưa xác nhận");
    // Ban nhap ton tai: xac nhan ngay sau do phai ghi duoc.
    await xacNhan();
    assert.notEqual(await db.getOwnerInstruction(CHU_A, UID_C), truoc, "không có bản nháp nào tồn tại");
  });

  await bai("C02", "bản nháp + đúng token OK → ghi, bản nháp bị tiêu thụ", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "", displayName: "Khách Mới" });
    await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Gọi bằng anh." });
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "", "ghi sớm");

    const xong = await xacNhan();
    assert.match(xong, /Em đã ghi nhớ rồi/, `trả lời bất ngờ: ${xong}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "Gọi bằng anh.");

    // Tieu thu roi: xac nhan lan hai khong con gi de ghi.
    const lai = await xacNhan();
    assert.match(lai, /không có thao tác nào đang chờ OK/i, `bản nháp chưa bị tiêu thụ: ${lai}`);
  });

  await bai("C03", "day_sua pha 1 CHƯA ghi; xác nhận thì thay TOÀN BỘ", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "Dòng cũ một.\nDòng cũ hai.", displayName: "Khách Mới" });
    const xem = await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Chỉ còn một dòng mới." });
    assert.ok(xem.includes("Chỉ còn một dòng mới."), `câu đọc lại thiếu nội dung: ${xem}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "Dòng cũ một.\nDòng cũ hai.", "ghi sớm");

    const xong = await xacNhan();
    assert.match(xong, /Em đã cập nhật rồi/, `trả lời bất ngờ: ${xong}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "Chỉ còn một dòng mới.", "không thay toàn bộ");
  });

  await bai("C04", "bản nháp + “hủy” → bỏ nháp, KHÔNG ghi", async () => {
    await donDep();
    const truoc = await db.getOwnerInstruction(CHU_A, UID_C);
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Nội dung sẽ bị huỷ." });
    const bo = await xacNhan("hủy");
    assert.match(bo, /chưa lưu/, `trả lời bất ngờ: ${bo}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), truoc, "đã ghi dù chị huỷ");
    const sau = await xacNhan();
    assert.match(sau, /không có thao tác nào đang chờ OK/i, "bản nháp chưa bị xoá");
  });

  await bai("C05", "bản nháp + “không” / “sai rồi” → bỏ nháp, KHÔNG ghi", async () => {
    for (const tuChoi of ["không", "sai rồi"]) {
      await donDep();
      const truoc = await db.getOwnerInstruction(CHU_A, UID_C);
      await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: `Bị từ chối bằng ${tuChoi}.` });
      const bo = await xacNhan(tuChoi);
      assert.match(bo, /chưa lưu/, `“${tuChoi}” không được hiểu là từ chối: ${bo}`);
      assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), truoc, `đã ghi dù chị nói “${tuChoi}”`);
    }
  });

  await bai("C06", "câu khác xen vào → nháp cũ bị bỏ, OK sau đó vô hiệu", async () => {
    await donDep();
    const truoc = await db.getOwnerInstruction(CHU_A, UID_C);
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Nội dung nháp cũ." });

    // Mot cau hoan toan khac xen vao giua.
    await raLenh({ hanhDong: "xem_lich" }, "xem lịch giúp chị");

    const sau = await xacNhan();
    assert.match(sau, /không có thao tác nào đang chờ OK/i, `nháp cũ vẫn sống: ${sau}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), truoc, "nháp cũ đã bị ghi nhầm");
  });

  await bai("C07", "lệnh dạy mới thay nháp cũ; chỉ nháp mới được xác nhận", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "", displayName: "Khách Mới" });
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "BẢN CŨ không được lưu." });
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "BẢN MỚI mới đúng." });
    await xacNhan();
    const luu = await db.getOwnerInstruction(CHU_A, UID_C);
    assert.equal(luu, "BẢN MỚI mới đúng.", `lưu nhầm bản nháp: ${luu}`);
    assert.ok(!luu.includes("BẢN CŨ"), "bản nháp cũ lọt vào");
  });

  await bai("C08", "OK khi không có gì đang chờ → không ghi, trả lời rõ", async () => {
    await donDep();
    const truoc = await db.getOwnerInstruction(CHU_A, UID_C);
    const traLoi = await xacNhan();
    assert.match(traLoi, /không có thao tác nào đang chờ OK/i, `trả lời bất ngờ: ${traLoi}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), truoc);
  });

  await bai("C09", "bản nháp tách theo chủ tài khoản và theo nick admin", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "", displayName: "Khách Mới" });
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Chỉ của tài khoản A." });

    // (1) Nick admin KHAC, cung tai khoan -> khong xac nhan ho duoc.
    const nickKhac = { threadId: "800000009", threadType: 0, senderId: "800000009", senderName: "Người khác", content: "OK" };
    const r1 = await xacNhan("OK", nickKhac);
    assert.match(r1, /không có thao tác nào đang chờ OK/i, `nick khác xác nhận được nháp của chị: ${r1}`);

    // (2) Tai khoan Zalo KHAC -> cung khong xac nhan ho duoc.
    chuHienTai = CHU_B;
    const r2 = await xacNhan();
    chuHienTai = CHU_A;
    assert.match(r2, /không có thao tác nào đang chờ OK/i, `tài khoản B xác nhận được nháp của A: ${r2}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "", "đã bị ghi bởi người không có quyền");

    // (3) Dung chu, dung nick -> van con hieu luc.
    const r3 = await xacNhan();
    assert.match(r3, /Em đã cập nhật rồi/, `chủ thật lại không xác nhận được: ${r3}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "Chỉ của tài khoản A.");
  });

  await bai("C10", "tiến trình mới (khởi động lại) → mất nháp, xác nhận không ghi được", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "GIỮ NGUYÊN", displayName: "Khách Mới" });
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Nháp sẽ mất khi restart." });

    const kichBan = `
      process.chdir(${JSON.stringify(TMP)});
      const db = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "lib", "db.js")).href)});
      const ac = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "lib", "admin-command.js")).href)});
      await db.initDb();
      ac.capHinhChuTaiKhoan(() => ${JSON.stringify(CHU_A)});
      const traLoi = await ac.xuLyLenh(
        { threadId: ${JSON.stringify(ADMIN_A)}, threadType: 0, senderId: ${JSON.stringify(ADMIN_A)}, content: "OK" },
        async () => {}
      );
      console.log(JSON.stringify({ traLoi, chiDan: await db.getOwnerInstruction(${JSON.stringify(CHU_A)}, ${JSON.stringify(UID_C)}) }));
    `;
    const ra = execFileSync(process.execPath, ["--input-type=module", "-e", kichBan], { encoding: "utf8" });
    const doc = JSON.parse(ra.trim().split("\n").pop());
    assert.match(doc.traLoi, /không có thao tác nào đang chờ OK/i, `tiến trình mới vẫn thấy nháp: ${doc.traLoi}`);
    assert.equal(doc.chiDan, "GIỮ NGUYÊN", "nháp sống sót qua restart và đã ghi");
    await donDep();
  });

  await bai("C11", "đích sai / nhóm / toàn cục / quá dài → KHÔNG tạo nháp", async () => {
    const truoc = await db.getOwnerInstruction(CHU_A, UID_C);
    const cacCa = [
      { ten: "không tìm thấy", parse: { hanhDong: "day_ghi_nho", dichTen: "Ai Đó Không Có", quyTac: "abc" } },
      { ten: "trùng tên", parse: { hanhDong: "day_ghi_nho", dichTen: "Thu Hà", quyTac: "abc" } },
      { ten: "là nhóm", parse: { hanhDong: "day_ghi_nho", dichTen: "Lớp K13", quyTac: "abc" } },
      { ten: "toàn cục", parse: { hanhDong: "day_ghi_nho", dichTen: "mọi khách", quyTac: "abc" } },
      { ten: "đích rỗng", parse: { hanhDong: "day_ghi_nho", dichTen: "", quyTac: "abc" } },
      { ten: "quy tắc rỗng", parse: { hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "   " } },
      { ten: "quá 300", parse: { hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "z".repeat(301) } },
    ];
    for (const ca of cacCa) {
      await donDep();
      await raLenh(ca.parse);
      const sau = await xacNhan();
      assert.match(sau, /không có thao tác nào đang chờ OK/i, `ca “${ca.ten}” đã tạo bản nháp: ${sau}`);
      assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), truoc, `ca “${ca.ten}” đã ghi`);
    }
  });

  await bai("C12", "dạy trùng câu đã có → không nháp, không ghi", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "Gọi bằng anh.", displayName: "Khách Mới" });
    const traLoi = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "  gọi BẰNG anh.  " });
    assert.match(traLoi, /đã ghi nhớ.*từ trước/, `trả lời bất ngờ: ${traLoi}`);
    const sau = await xacNhan();
    assert.match(sau, /không có thao tác nào đang chờ OK/i, "đã tạo nháp cho một câu trùng");
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "Gọi bằng anh.");
  });

  await bai("C13", "bước xác nhận KHÔNG gọi OpenCode", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "", displayName: "Khách Mới" });
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Không gọi parser khi xác nhận." });

    const truocDem = soLanGoiPhanTich;
    const xong = await xacNhan();
    assert.equal(soLanGoiPhanTich, truocDem, "đã gọi bộ phân tích ở bước xác nhận");
    assert.match(xong, /Em đã cập nhật rồi/, `bẫy parser đã nổ: ${xong}`);

    // Ca truong hop khong co nhap cung khong duoc goi parser.
    const demTruocRong = soLanGoiPhanTich;
    await xacNhan();
    assert.equal(soLanGoiPhanTich, demTruocRong, "gọi parser chỉ để hiểu chữ “xác nhận”");
  });

  await bai("C14", "bước huỷ KHÔNG gọi OpenCode", async () => {
    await donDep();
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Sẽ bị huỷ, không gọi parser." });
    const truocDem = soLanGoiPhanTich;
    const bo = await xacNhan("sai rồi");
    assert.equal(soLanGoiPhanTich, truocDem, "đã gọi bộ phân tích ở bước huỷ");
    assert.match(bo, /chưa lưu/, `bẫy parser đã nổ: ${bo}`);
  });

  await bai("C15", "câu đọc lại đúng bằng chuỗi sẽ lưu, không tóm tắt lần hai", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "", displayName: "Khách Mới" });
    const quyTac = "Với bố thì xưng là con, gọi bố là bố, và đừng nhắc chuyện vay tiền.";
    const xem = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac });
    assert.ok(xem.includes(quyTac), `câu đọc lại KHÔNG chứa nguyên văn:\n${xem}`);
    await xacNhan();
    const luu = await db.getOwnerInstruction(CHU_A, UID_C);
    assert.equal(luu, quyTac, `lưu khác câu đã đọc lại:\nđọc lại: ${quyTac}\nđã lưu : ${luu}`);
  });

  await bai("C16", "HUONG_DAN không còn cho phép “viết gọn” quyTac", async () => {
    const nguon = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
    const khoi = nguon.slice(nguon.indexOf("DẠY EM CÁCH CƯ XỬ"), nguon.indexOf("KHÔNG HIỂU:"));
    assert.ok(khoi.length > 100, "không tách được khối hướng dẫn dạy");
    assert.ok(!/quyTac[^\n]*viết gọn/.test(khoi), "vẫn còn cho phép “viết gọn” quyTac");
    assert.ok(khoi.includes("GIỮ ĐẦY ĐỦ"), "thiếu yêu cầu giữ đầy đủ nội dung");
    for (const cam of ["tóm tắt", "rút gọn", "bỏ bớt mệnh đề", "thêm ý mới", "đổi nghĩa"]) {
      assert.ok(khoi.includes(cam), `thiếu điều cấm “${cam}”`);
    }
    assert.ok(khoi.includes("giữ ĐỦ TẤT CẢ"), "thiếu yêu cầu giữ đủ mọi mệnh đề");
  });

  await bai("C17", "sau parser KHÔNG có lượt viết lại bằng LLM thứ hai", async () => {
    const nguon = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
    const khoi = nguon.slice(nguon.indexOf("--- DAY PO:"));
    for (const cam of ["call(config", "runOneShot", "extractReply", "phanTichLenh"]) {
      assert.ok(!khoi.includes(cam), `vùng dạy PO có gọi LLM: ${cam}`);
    }
    // Toan file khong duoc phat sinh diem goi provider moi so voi truoc repair.
    const soLanGoi = (nguon.match(/await call\(config/g) || []).length;
    assert.equal(soLanGoi, 3, `số điểm gọi OpenCode đã đổi: ${soLanGoi}`);
  });

  /* ============ R01–R07: MOT LUC CHI CO MOT THAO TAC CHO XAC NHAN ============ */

  const bam = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
  const mocTuongLai = () => {
    const d = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:00`;
  };
  const taoLenhGui = () => raLenh({ hanhDong: "gui_tin", dichIds: [UID_NHOM], noiDung: "mai nghỉ học" });
  const taoLenhLich = () =>
    raLenh({ hanhDong: "dat_lich", lich: [{ dichId: UID_NHOM, dichTen: "Lớp K13", noiDung: "nhắc cả lớp", luc: mocTuongLai(), lapLai: "" }] });

  await bai("R01", "đang chờ xác nhận GỬI TIN → từ chối dạy, lệnh gửi còn nguyên", async () => {
    await donDep();
    const r1 = await taoLenhGui();
    assert.match(r1, /OK để em gửi/, `chưa tạo được lệnh gửi đang chờ: ${r1}`);

    const r2 = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Gọi bằng anh." });
    assert.match(r2, /thao tác khác chờ OK/, `không từ chối lệnh dạy: ${r2}`);
    assert.ok(!/để em lưu/.test(r2), "vẫn trả về bản xem trước dù đang có thao tác khác");

    // Lenh gui CU van con nguyen: huy duoc thi tuc la no chua he bi xoa.
    const r3 = await noi("hủy");
    assert.match(r3, /Đã huỷ, em không gửi gì cả/, `lệnh gửi cũ đã bị lệnh dạy xoá mất: ${r3}`);
  });

  await bai("R02", "đang chờ xác nhận ĐẶT LỊCH → từ chối dạy, lịch còn nguyên", async () => {
    await donDep();
    await taoLenhLich();
    const r2 = await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Nội dung mới." });
    assert.match(r2, /thao tác khác chờ OK/, `không từ chối lệnh dạy: ${r2}`);

    const r3 = await noi("hủy");
    assert.match(r3, /Đã huỷ, em không đặt lịch nào cả/, `lịch đang chờ đã bị mất: ${r3}`);
  });

  await bai("R03", "trong lúc xung đột, owner_instruction KHÔNG bị ghi", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "GIỮ NGUYÊN", displayName: "Khách Mới" });
    const truoc = bam(await db.getOwnerInstruction(CHU_A, UID_C));

    await taoLenhGui();
    await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Câu sẽ không được ghi." });
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Câu này cũng không." });

    assert.equal(bam(await db.getOwnerInstruction(CHU_A, UID_C)), truoc, "đã ghi trong lúc xung đột");
    await donDep();
  });

  await bai("R04", "câu từ chối nói rõ phải xử lý thao tác cũ trước", async () => {
    await donDep();
    await taoLenhGui();
    const r = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "abc" });
    assert.match(r, /thao tác khác chờ OK/, `thiếu lý do: ${r}`);
    assert.match(r, /OK hoặc huỷ/, `không hướng dẫn cách xử lý: ${r}`);
    assert.ok(!/Em hiểu bạn muốn/.test(r), "lại trả về bản xem trước");
    await donDep();
  });

  await bai("R05", "sau khi lệnh dạy bị chặn, OK vẫn chạy đúng lệnh cũ", async () => {
    await donDep();
    await taoLenhGui();
    await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Bị chặn." });

    const truocSo = daGui.length;
    const r = await noi("ok");
    assert.match(r, /Đã gửi vào/, `lệnh gửi cũ không chạy được nữa: ${r}`);
    assert.equal(daGui.length, truocSo + 1, "hàm gửi (giả) không được gọi");
    assert.equal(String(daGui[daGui.length - 1].threadId), UID_NHOM, "gửi sai đích");
  });

  await bai("R06", "xử lý xong thao tác cũ thì dạy được ngay, không cần restart", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "", displayName: "Khách Mới" });
    await taoLenhGui();
    const biChan = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Gọi bằng anh." });
    assert.match(biChan, /thao tác khác chờ OK/);

    await noi("hủy"); // xu ly xong thao tac cu

    const xem = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Gọi bằng anh." });
    assert.match(xem, /Em hiểu bạn muốn/, `sau khi dọn vẫn không dạy được: ${xem}`);
    const xong = await xacNhan();
    assert.match(xong, /Em đã ghi nhớ rồi/, `không ghi được: ${xong}`);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "Gọi bằng anh.");
  });

  await bai("R07", "không bao giờ tồn tại đồng thời hai thao tác chờ xác nhận", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "KHONG DUOC DOI", displayName: "Khách Mới" });
    const truoc = bam(await db.getOwnerInstruction(CHU_A, UID_C));

    await taoLenhGui();
    await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Không được ghi." });

    // Mot token "OK" -> phai ung voi DUNG MOT thao tac: lenh gui.
    const truocSo = daGui.length;
    const r1 = await xacNhan();
    assert.match(r1, /Đã gửi vào/, `"OK" không ứng với lệnh gửi: ${r1}`);
    assert.equal(daGui.length, truocSo + 1, "lệnh gửi không chạy");
    assert.equal(bam(await db.getOwnerInstruction(CHU_A, UID_C)), truoc, "chỉ dẫn bị ghi kèm");

    // Va khong con thao tac nao khac nam cho phia sau.
    const r2 = await xacNhan();
    assert.match(r2, /không có thao tác nào đang chờ OK/i, `còn sót một thao tác thứ hai: ${r2}`);
  });

  /* ============ G01–G07: LOI THOAI DUNG DUOC CHO MOI BAN CAI ============ */

  /** Loi thoai cua tinh nang day KHONG duoc gan cung mot nguoi/mot bot cu the. */
  function kiemGeneric(nhan, s) {
    assert.ok(!String(s).includes("chị"), `${nhan}: còn chữ “chị” — ${s}`);
    assert.ok(!String(s).includes("Chị"), `${nhan}: còn chữ “Chị” — ${s}`);
    assert.ok(!/\bPo\b/.test(String(s)), `${nhan}: còn tên riêng “Po” — ${s}`);
    assert.ok(!String(s).includes("bố"), `${nhan}: còn ví dụ cứng “bố” — ${s}`);
    assert.ok(!String(s).includes("Bố"), `${nhan}: còn ví dụ cứng “Bố” — ${s}`);
  }

  await bai("G01", "câu đọc lại trung tính và dùng tên đích động", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "", displayName: "Khách Mới" });
    const xem = await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Gọi bằng anh." });
    kiemGeneric("preview day_ghi_nho", xem);
    assert.ok(xem.includes("Khách Mới"), "không dùng tên đích động");
    assert.ok(xem.includes("Gọi bằng anh."), "không chứa nguyên văn quy tắc");

    await donDep();
    const xem2 = await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Gọi bằng chú." });
    kiemGeneric("preview day_sua", xem2);
    assert.ok(xem2.includes("Khách Mới"), "không dùng tên đích động");
    await donDep();
  });

  await bai("G02", "câu “không có gì đang chờ” trung tính", async () => {
    await donDep();
    const r = await xacNhan();
    kiemGeneric("no-pending", r);
    assert.match(r, /không có thao tác nào đang chờ OK/i);
  });

  await bai("G03", "câu huỷ bản nháp trung tính", async () => {
    await donDep();
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Sẽ huỷ." });
    const r = await xacNhan("sai rồi");
    kiemGeneric("cancel", r);
    assert.match(r, /chưa lưu/);
  });

  await bai("G04", "câu báo lưu thành công trung tính", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "", displayName: "Khách Mới" });
    await raLenh({ hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "Gọi bằng anh." });
    const r1 = await xacNhan();
    kiemGeneric("confirm day_ghi_nho", r1);
    assert.match(r1, /Em đã ghi nhớ rồi/);

    await donDep();
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Gọi bằng chú." });
    const r2 = await xacNhan();
    kiemGeneric("confirm day_sua", r2);
    assert.match(r2, /Em đã cập nhật rồi/);
  });

  await bai("G05", "day_xem trung tính ở cả hai nhánh", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "Gọi bằng chú.", displayName: "Khách Mới" });
    const co = await raLenh({ hanhDong: "day_xem", dichTen: "Khách Mới" });
    kiemGeneric("day_xem có rule", co);
    assert.ok(co.includes("Gọi bằng chú."), "không trả về nguyên văn chỉ dẫn");
    assert.ok(co.includes("Khách Mới"), "không dùng tên đích động");

    await db.clearOwnerInstruction(CHU_A, UID_C);
    const khong = await raLenh({ hanhDong: "day_xem", dichTen: "Khách Mới" });
    kiemGeneric("day_xem không rule", khong);
    assert.match(khong, /chưa có chỉ dẫn riêng nào/);
  });

  await bai("G06", "mọi câu báo lỗi của tính năng dạy đều trung tính", async () => {
    const cacCa = [
      ["không tìm thấy", { hanhDong: "day_ghi_nho", dichTen: "Ai Đó Không Có", quyTac: "abc" }],
      ["trùng tên", { hanhDong: "day_ghi_nho", dichTen: "Thu Hà", quyTac: "abc" }],
      ["là nhóm", { hanhDong: "day_ghi_nho", dichTen: "Lớp K13", quyTac: "abc" }],
      ["toàn cục", { hanhDong: "day_ghi_nho", dichTen: "mọi khách", quyTac: "abc" }],
      ["quy tắc rỗng", { hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "  " }],
      ["quá 300 (ghi thêm)", { hanhDong: "day_ghi_nho", dichTen: "Khách Mới", quyTac: "z".repeat(301) }],
      ["quá 300 (sửa)", { hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "z".repeat(301) }],
    ];
    for (const [ten, parse] of cacCa) {
      await donDep();
      kiemGeneric(`lỗi "${ten}"`, await raLenh(parse));
    }
    // Cau bao loi ghi CSDL cung phai trung tinh (kiem tren nguon, vi ep loi that
    // se pha bang - viec do de bai C18 lam o cuoi).
    const nguon = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
    assert.ok(nguon.includes("Em chưa lưu được chỉ dẫn."), "câu báo lỗi ghi CSDL không còn trung tính");
  });

  await bai("G07", "mã chạy thật không hardcode “bố”; ví dụ chỉ nằm trong hướng dẫn parser", async () => {
    const nguon = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
    // Chi tinh DUNG khoi ma cua tinh nang day. Cac lenh cu (nhan, nhom, binh
    // chon...) nam sau do va van dung loi thoai rieng cua chung - khong thuoc
    // pham vi vong nay.
    const dau = nguon.indexOf("--- DAY BOT:");
    const cuoi = nguon.indexOf("--- NHAN HOI THOAI ---");
    assert.ok(dau > 0 && cuoi > dau, "không tách được vùng mã dạy");
    const vungLenh = nguon.slice(dau, cuoi);
    assert.ok(vungLenh.length > 500, "vùng mã dạy quá ngắn, cắt sai");
    for (const cam of ["bố", "Bố", "Po ", "chị ", "Chị "]) {
      assert.ok(!vungLenh.includes(cam), `vùng mã chạy thật còn hardcode “${cam}”`);
    }
    // ...nhung HUONG_DAN (hop dong cho parser) VAN duoc phep giu vi du.
    const vungHuongDan = nguon.slice(nguon.indexOf("DẠY EM CÁCH CƯ XỬ"), nguon.indexOf("KHÔNG HIỂU:"));
    assert.ok(vungHuongDan.includes("bố"), "ví dụ trong hướng dẫn parser đã bị xoá nhầm");
  });

  /* ============ O01–O08: GLOBAL CANONICAL CONFIRM TOKEN = OK ============ */

  await bai("O01", "gui_tin: token xác nhận cũ không còn gửi", async () => {
    await donDep();
    const truoc = daGui.length;
    await taoLenhGui();
    const r = await noi("xác nhận");
    assert.match(r, /trả lời OK/i);
    assert.equal(daGui.length, truoc, "token cũ vẫn gọi hàm gửi");
    await noi("hủy");
  });

  await bai("O02", "gui_tin: exact OK giữ nguyên hành vi gửi giả", async () => {
    await donDep();
    const truoc = daGui.length;
    await taoLenhGui();
    const r = await noi("OK");
    assert.match(r, /Đã gửi vào/);
    assert.equal(daGui.length, truoc + 1, "OK không gọi đúng một lượt gửi giả");
  });

  await bai("O03", "dat_lich: token xác nhận cũ không còn đặt lịch", async () => {
    await donDep();
    const truoc = (await db.listLichHen(CHU_A)).length;
    await taoLenhLich();
    const r = await noi("xac nhan");
    assert.match(r, /trả lời OK/i);
    assert.equal((await db.listLichHen(CHU_A)).length, truoc, "token cũ vẫn ghi lịch");
    await noi("hủy");
  });

  await bai("O04", "dat_lich: exact OK giữ nguyên hành vi đặt lịch", async () => {
    await donDep();
    const truoc = (await db.listLichHen(CHU_A)).length;
    await taoLenhLich();
    const r = await noi("OK");
    assert.match(r, /Đã đặt xong 1 lịch/);
    assert.equal((await db.listLichHen(CHU_A)).length, truoc + 1, "OK không ghi đúng một lịch");
  });

  await bai("O05", "Teach Bot: token xác nhận cũ không còn ghi", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "GIỮ NGUYÊN", displayName: "Khách Mới" });
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "KHÔNG ĐƯỢC GHI BẰNG TOKEN CŨ" });
    const r = await noi("xác nhận");
    assert.match(r, /trả lời OK/i);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "GIỮ NGUYÊN");
    await noi("hủy");
  });

  await bai("O06", "Teach Bot: exact OK thực hiện write đã duyệt", async () => {
    await donDep();
    await db.setOwnerInstruction(CHU_A, { uid: UID_C, instruction: "CŨ", displayName: "Khách Mới" });
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "MỚI QUA OK" });
    const r = await noi("OK");
    assert.match(r, /Em đã cập nhật rồi/);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), "MỚI QUA OK");
  });

  await bai("O07", "mọi copy xác nhận Teach Bot hiển thị canonical OK", async () => {
    await donDep();
    const r = await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Bản xem trước" });
    assert.match(r, /trả lời “OK”/);
    assert.ok(!/trả lời “xác nhận”/i.test(r), `copy còn token cũ: ${r}`);
    await noi("hủy");
  });

  await bai("O08", "OK khi không có pending không thực hiện hành động tuỳ ý", async () => {
    await donDep();
    const guiTruoc = daGui.length;
    const lichTruoc = (await db.listLichHen(CHU_A)).length;
    const chiDanTruoc = await db.getOwnerInstruction(CHU_A, UID_C);
    const r = await noi("OK");
    assert.match(r, /không có thao tác nào đang chờ OK/i);
    assert.equal(daGui.length, guiTruoc);
    assert.equal((await db.listLichHen(CHU_A)).length, lichTruoc);
    assert.equal(await db.getOwnerInstruction(CHU_A, UID_C), chiDanTruoc);
  });

  /* --- C18 de CUOI CUNG: bai nay pha hong bang customer_memory co chu dich. --- */
  await bai("C18", "ghi hỏng lúc xác nhận → KHÔNG báo thành công giả", async () => {
    await donDep();
    await raLenh({ hanhDong: "day_sua", dichTen: "Khách Mới", quyTac: "Sẽ không ghi được." });

    // Ep mot loi ghi THAT: bo han cai bang di.
    await new Promise((res, rej) => {
      const conn = new sqlite3.Database(DB_FILE);
      conn.run("DROP TABLE customer_memory", (e) => { conn.close(); e ? rej(e) : res(); });
    });

    const traLoi = await xacNhan();
    assert.ok(!/đã ghi nhớ|đã cập nhật/.test(traLoi), `BÁO THÀNH CÔNG GIẢ: ${traLoi}`);
    assert.match(traLoi, /chưa lưu được/, `trả lời bất ngờ: ${traLoi}`);
    assert.ok(!traLoi.includes("chị") && !/\bPo\b/.test(traLoi), `câu báo lỗi chưa trung tính: ${traLoi}`);

    // Ban nhap van phai bi tieu thu, khong duoc treo lai cho lan sau.
    const lai = await xacNhan();
    assert.match(lai, /không có thao tác nào đang chờ OK/i, `bản nháp còn treo: ${lai}`);
  });

  /* ================= Bao cao ================= */
  mayGia.close();

  const rong = bienBan.filter((b) => b.ketQua === "FAIL");
  console.log("");
  for (const b of bienBan) {
    console.log(`${b.ma} = ${b.ketQua}  ${b.moTa}${b.loi ? `\n        ↳ ${b.loi}` : ""}`);
  }
  console.log("");
  console.log(`TONG: ${bienBan.length - rong.length}/${bienBan.length} PASS`);
  console.log(`So lan goi bo phan tich (OpenCode GIA, 127.0.0.1): ${soLanGoiPhanTich}`);
  console.log(`Thu muc tam: ${TMP}`);

  process.exit(rong.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Khung kiem thu hong:", error);
  process.exit(2);
});
