/**
 * Provider-free tests for phone -> exact Zalo UID -> preview -> OK -> one send.
 *
 * Chay: node kiem-thu/kiem-tra-phone-direct-message.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const napLib = (ten) => import(pathToFileURL(path.join(REPO, "lib", ten)).href);

function taoSQLiteShim() {
  const thuMuc = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite3-node-shim-"));
  const tep = path.join(thuMuc, "preload.cjs");
  fs.writeFileSync(
    tep,
    String.raw`
const Module = require("node:module");
const { DatabaseSync } = require("node:sqlite");

// zalo-service imports the document stack, but this focused test never renders.
// Minimal inert globals keep that optional stack from loading native canvas.
global.DOMMatrix ||= class DOMMatrix {};
global.ImageData ||= class ImageData {};
global.Path2D ||= class Path2D {};

const OPEN_READONLY = 1;

function goi(statement, method, params) {
  if (Array.isArray(params)) return statement[method](...params);
  if (params && typeof params === "object") return statement[method](params);
  return statement[method]();
}

class Database {
  constructor(filename, flags, callback) {
    if (typeof flags === "function") {
      callback = flags;
      flags = 0;
    }
    try {
      this.inner = new DatabaseSync(filename, { readOnly: flags === OPEN_READONLY });
      callback?.(null);
    } catch (error) {
      callback?.(error);
      if (!callback) throw error;
    }
  }

  run(sql, params, callback) {
    if (typeof params === "function") {
      callback = params;
      params = [];
    }
    try {
      const result = goi(this.inner.prepare(sql), "run", params || []);
      const context = {
        lastID: Number(result.lastInsertRowid || 0),
        changes: Number(result.changes || 0),
      };
      callback?.call(context, null);
    } catch (error) {
      if (callback) callback(error);
      else throw error;
    }
    return this;
  }

  all(sql, params, callback) {
    if (typeof params === "function") {
      callback = params;
      params = [];
    }
    try {
      callback?.(null, goi(this.inner.prepare(sql), "all", params || []));
    } catch (error) {
      if (callback) callback(error);
      else throw error;
    }
    return this;
  }

  get(sql, params, callback) {
    if (typeof params === "function") {
      callback = params;
      params = [];
    }
    try {
      callback?.(null, goi(this.inner.prepare(sql), "get", params || []));
    } catch (error) {
      if (callback) callback(error);
      else throw error;
    }
    return this;
  }

  serialize(callback) {
    callback();
    return this;
  }

  close(callback) {
    try {
      this.inner.close();
      callback?.(null);
    } catch (error) {
      if (callback) callback(error);
      else throw error;
    }
  }
}

const sqlite3 = { Database, OPEN_READONLY, verbose() { return sqlite3; } };
const loadCu = Module._load;
Module._load = function (request, parent, isMain) {
  if (
    request === "sqlite3" ||
    /node_modules[\\/]sqlite3[\\/]lib[\\/]sqlite3\.js$/.test(String(request))
  ) return sqlite3;
  return loadCu.call(this, request, parent, isMain);
};
`,
    "utf8"
  );
  return tep;
}

function chayTrongRuntimeTest() {
  const shim = taoSQLiteShim();
  const shimNodeOption = `--require=${JSON.stringify(shim)}`;
  const regression = process.argv.includes("--existing-regression");
  const target = regression
    ? path.join(REPO, "kiem-thu", "kiem-tra-day-po.js")
    : fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, ["-r", shim, target], {
    cwd: REPO,
    env: {
      ...process.env,
      PHONE_DIRECT_SQLITE_SHIM: "1",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, shimNodeOption].filter(Boolean).join(" "),
    },
    stdio: "inherit",
  });
  process.exitCode = child.status ?? 1;
}

const ketQua = [];
async function bai(ma, moTa, fn) {
  try {
    await fn();
    ketQua.push({ ma, moTa, pass: true });
    console.log(`PASS ${ma} - ${moTa}`);
  } catch (error) {
    ketQua.push({ ma, moTa, pass: false, error });
    console.error(`FAIL ${ma} - ${moTa}: ${error.message}`);
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-direct-message-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  process.chdir(tmp);

  const db = await napLib("db.js");
  await db.initDb();
  const adminCmd = await napLib("admin-command.js");
  const messageUtils = await napLib("message-utils.js");
  const tinHeThong = await napLib("tin-he-thong.js");
  const zaloService = await napLib("zalo-service.js");

  const OWNER_A = "owner-phone-a";
  const OWNER_B = "owner-phone-b";
  const UID = "900000000001";
  const TEN = "Bạn Thảo";
  const NOI_DUNG = "Chào Thảo, chiều nay mình trao đổi nhé.";

  adminCmd.capHinhChuTaiKhoan(() => OWNER_A);

  let lookupCount = 0;
  let lookupInputs = [];
  let lookupUid = UID;
  let lookupName = TEN;
  let lookupError = null;

  adminCmd.capHinhTimNguoi({
    tim: async (soNhap) => {
      lookupCount += 1;
      lookupInputs.push(soNhap);
      if (lookupError) throw lookupError;
      return {
        uid: lookupUid,
        display_name: lookupName,
        zalo_name: "Thảo",
        phone: zaloService.chuanHoaSo(soNhap),
        anh: "avatar-fake",
      };
    },
    conLuot: () => 20,
  });

  let soThread = 0;
  const threadMoi = (nhan) => `admin-phone-${nhan}-${++soThread}`;
  const tinAdmin = (content, threadId) => ({
    threadId,
    threadType: 0,
    senderId: "admin-phone",
    senderName: "Chủ shop",
    content,
  });
  const cauLenh = (so, noiDung = NOI_DUNG) => `Nhắn qua số ${so} nội dung ${noiDung}`;
  const guiThuongKhongDuocGoi = async () => {
    throw new Error("Đường gửi thường không được gọi cho lệnh theo số điện thoại");
  };
  const xuLy = (content, threadId, guiRieng) =>
    adminCmd.xuLyLenh(tinAdmin(content, threadId), guiThuongKhongDuocGoi, guiRieng);

  await bai("T01", "0962117130 chuẩn hoá và resolve thành 84962117130", async () => {
    const thread = threadMoi("t01");
    const truoc = lookupCount;
    const xem = await xuLy(cauLenh("0962117130"), thread, async () => {});
    assert.match(xem, /84962117130/);
    assert.equal(lookupCount, truoc + 1);
    assert.equal(lookupInputs.at(-1), "0962117130");
  });

  await bai("T02", "84962117130 chuẩn hoá và resolve đúng", async () => {
    const thread = threadMoi("t02");
    const xem = await xuLy(cauLenh("84962117130"), thread, async () => {});
    assert.match(xem, /84962117130/);
    assert.equal(lookupInputs.at(-1), "84962117130");
  });

  await bai("T03", "+84962117130 chuẩn hoá và resolve thành 84962117130", async () => {
    const thread = threadMoi("t03");
    const xem = await xuLy(cauLenh("+84962117130"), thread, async () => {});
    assert.match(xem, /84962117130/);
    assert.equal(lookupInputs.at(-1), "+84962117130");
  });

  await bai("T04", "preview có người, số chuẩn hoá và nguyên văn nội dung", async () => {
    const thread = threadMoi("t04");
    const xem = await xuLy(cauLenh("0962117130"), thread, async () => {});
    assert.match(xem, new RegExp(TEN));
    assert.match(xem, /84962117130/);
    assert.ok(xem.includes(NOI_DUNG));
  });

  await bai("T05", "preview tạo zero send", async () => {
    const thread = threadMoi("t05");
    let sendCount = 0;
    await xuLy(cauLenh("0962117130"), thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
  });

  await bai("T06", "preview tạo zero thread-registration side effect", async () => {
    const thread = threadMoi("t06");
    assert.equal(await db.getThread(OWNER_A, UID), null);
    await xuLy(cauLenh("0962117130"), thread, async () => {});
    assert.equal(await db.getThread(OWNER_A, UID), null);
  });

  await bai("T07", "xác nhận sai tạo zero send và zero registration", async () => {
    const thread = threadMoi("t07");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(cauLenh("0962117130"), thread, gui);
    await xuLy("OK.", thread, gui);
    assert.equal(sendCount, 0);
    assert.equal(await db.getThread(OWNER_A, UID), null);
  });

  await bai("T08", "cancel tạo zero send và zero registration", async () => {
    const thread = threadMoi("t08");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(cauLenh("0962117130"), thread, gui);
    const huy = await xuLy("HUỶ", thread, gui);
    assert.match(huy, /Đã huỷ/);
    assert.equal(sendCount, 0);
    assert.equal(await db.getThread(OWNER_A, UID), null);
  });

  await bai("T09", "exact OK tạo đúng một send", async () => {
    const thread = threadMoi("t09");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(cauLenh("0962117130"), thread, gui);
    const xong = await xuLy("OK", thread, gui);
    assert.match(xong, /Đã gửi một tin nhắn riêng/);
    assert.equal(sendCount, 1);
  });

  await bai("T10", "Ok và ok là canonical case variants", async () => {
    for (const token of ["Ok", "ok"] ) {
      const thread = threadMoi(`t10-${token}`);
      let sendCount = 0;
      const gui = async () => { sendCount += 1; };
      await xuLy(cauLenh("0962117130"), thread, gui);
      await xuLy(token, thread, gui);
      assert.equal(sendCount, 1, `${token} không gửi đúng một lần`);
    }
  });

  await bai("T11", "pending bị consume trước khi adapter chạy", async () => {
    const thread = threadMoi("t11");
    let sendCount = 0;
    let phanHoiLanHai = "";
    const gui = async () => {
      sendCount += 1;
      phanHoiLanHai = await xuLy("OK", thread, gui);
    };
    await xuLy(cauLenh("0962117130"), thread, gui);
    await xuLy("OK", thread, gui);
    assert.equal(sendCount, 1);
    assert.match(phanHoiLanHai, /Không có thao tác nào đang chờ OK/);
  });

  await bai("T12", "OK lần hai sau thành công không gửi thêm", async () => {
    const thread = threadMoi("t12");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(cauLenh("0962117130"), thread, gui);
    await xuLy("OK", thread, gui);
    await xuLy("OK", thread, gui);
    assert.equal(sendCount, 1);
  });

  await bai("T13", "send failure vẫn consume pending và OK lần hai không retry", async () => {
    const thread = threadMoi("t13");
    let sendCount = 0;
    const guiHong = async () => {
      sendCount += 1;
      throw new Error("provider fake uncertain");
    };
    await xuLy(cauLenh("0962117130"), thread, guiHong);
    const loi = await xuLy("OK", thread, guiHong);
    assert.match(loi, /provider fake uncertain/);
    const lanHai = await xuLy("OK", thread, guiHong);
    assert.match(lanHai, /Không có thao tác nào đang chờ OK/);
    assert.equal(sendCount, 1);
  });

  await bai("T14", "lookup thiếu UID tạo zero send", async () => {
    const thread = threadMoi("t14");
    const uidCu = lookupUid;
    lookupUid = "";
    let sendCount = 0;
    const xem = await xuLy(cauLenh("0962117130"), thread, async () => { sendCount += 1; });
    lookupUid = uidCu;
    assert.match(xem, /không tìm thấy/);
    assert.equal(sendCount, 0);
  });

  await bai("T15", "confirmed UID được đăng ký dưới current owner trước canonical send", async () => {
    const uid = "900000000015";
    const thread = threadMoi("t15");
    const uidCu = lookupUid;
    lookupUid = uid;
    let sendCount = 0;
    const adapter = (payload) =>
      zaloService.sendResolvedPrivateMessage(payload, {
        ownerUid: OWNER_A,
        registerThread: db.upsertThread,
        canonicalSend: async () => {
          sendCount += 1;
          const daDangKy = await db.getThread(OWNER_A, uid);
          assert.ok(daDangKy, "canonical send chạy trước thread registration");
          assert.equal(daDangKy.threadType, 0);
          return { id: "fake-message" };
        },
      });
    await xuLy(cauLenh("0962117130"), thread, adapter);
    assert.equal(await db.getThread(OWNER_A, uid), null);
    await xuLy("OK", thread, adapter);
    lookupUid = uidCu;
    assert.equal(sendCount, 1);
    assert.ok(await db.getThread(OWNER_A, uid));
  });

  await bai("T16", "thread cùng UID của owner khác không được tái sử dụng", async () => {
    const uid = "900000000016";
    await db.upsertThread(OWNER_B, { id: uid, threadType: 0, title: "Owner B contact" });
    const thread = threadMoi("t16");
    const uidCu = lookupUid;
    lookupUid = uid;
    const adapter = (payload) =>
      zaloService.sendResolvedPrivateMessage(payload, {
        ownerUid: OWNER_A,
        registerThread: db.upsertThread,
        canonicalSend: async () => ({ id: "fake-owner-a" }),
      });
    await xuLy(cauLenh("0962117130"), thread, adapter);
    await xuLy("OK", thread, adapter);
    lookupUid = uidCu;
    const cuaA = await db.getThread(OWNER_A, uid);
    const cuaB = await db.getThread(OWNER_B, uid);
    assert.ok(cuaA, "không tạo thread owner-scoped cho owner A");
    assert.equal(cuaA.title, TEN);
    assert.equal(cuaB.title, "Owner B contact");
    assert.notEqual(db.khoaCucBo(OWNER_A, uid), db.khoaCucBo(OWNER_B, uid));
  });

  await bai("T17", "canonical wrapper nhận exact UID, User/0 và exact message", async () => {
    const uid = "900000000017";
    const noiDung = "Nội dung chính xác\nDòng thứ hai https://example.com";
    const thread = threadMoi("t17");
    const uidCu = lookupUid;
    lookupUid = uid;
    let daNhan = null;
    const adapter = (payload) =>
      zaloService.sendResolvedPrivateMessage(payload, {
        ownerUid: OWNER_A,
        registerThread: db.upsertThread,
        canonicalSend: async (p) => {
          daNhan = p;
          return { id: "fake-exact" };
        },
      });
    await xuLy(cauLenh("0962117130", noiDung), thread, adapter);
    await xuLy("OK", thread, adapter);
    lookupUid = uidCu;
    assert.deepEqual(daNhan, { threadId: uid, threadType: 0, text: noiDung });
  });

  await bai("T18", "một preview gọi lookup đúng một lần", async () => {
    const thread = threadMoi("t18");
    const truoc = lookupCount;
    await xuLy(cauLenh("0962117130"), thread, async () => {});
    assert.equal(lookupCount - truoc, 1);
  });

  await bai("T19", "confirmation không lookup lần hai", async () => {
    const thread = threadMoi("t19");
    const truoc = lookupCount;
    await xuLy(cauLenh("0962117130"), thread, async () => {});
    assert.equal(lookupCount, truoc + 1);
    await xuLy("OK", thread, async () => {});
    assert.equal(lookupCount, truoc + 1);
  });

  await bai("T20", "admin-command không direct provider send", async () => {
    const source = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
    assert.ok(!source.includes("api.sendMessage"));
    assert.ok(!source.includes(".sendMessage("));
    assert.ok(source.includes("guiRiengDaTim"));
  });

  const NOI_DUNG_PO = "em là trợ lý của chị Ngọc ạ, em sẽ hỗ trợ chị đăng ký lớp masterclass";
  const CAU_PO = `em nhắn cho bạn số điện thoại 0767722789: ${NOI_DUNG_PO}`;
  const NOI_DUNG_THAO = "em là trợ lý của Coach Mai Anh, bạn ấy đăng ký Masterclass thì em hỗ trợ bạn nhé";

  await bai("NL01", "câu UAT thật của PO route vào preview PHONE_USER_DIRECT_MESSAGE", async () => {
    const thread = threadMoi("nl01");
    const truoc = lookupCount;
    let sendCount = 0;
    const xem = await xuLy(CAU_PO, thread, async () => { sendCount += 1; });
    assert.equal(lookupCount, truoc + 1);
    assert.equal(lookupInputs.at(-1), "0767722789");
    assert.match(xem, new RegExp(TEN));
    assert.match(xem, /84767722789/);
    assert.ok(xem.includes(NOI_DUNG_PO));
    assert.ok(!xem.includes("em nhắn cho bạn số điện thoại"));
    assert.match(xem, /Trả lời OK để gửi\./);
    assert.equal(sendCount, 0);
    await xuLy("HUỶ", thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
  });

  await bai("NL02", "câu qua số điện thoại bỏ tên ngữ cảnh và em bảo khỏi message", async () => {
    const thread = threadMoi("nl02");
    const cau = `em nhắn cho bạn Thảo qua số điện thoại 0962117130, em bảo ${NOI_DUNG_THAO}`;
    const xem = await xuLy(cau, thread, async () => {});
    assert.equal(lookupInputs.at(-1), "0962117130");
    assert.ok(xem.includes(NOI_DUNG_THAO));
    assert.ok(!xem.includes("bạn Thảo qua số điện thoại"));
    assert.ok(!xem.includes("em bảo em là"));
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("NL03", "nhắn cho số với từ nội dung vẫn hoạt động", async () => {
    const thread = threadMoi("nl03");
    const noiDung = "Chào Thảo, mình hỗ trợ bạn đăng ký lớp nhé";
    const xem = await xuLy(`nhắn cho số 0962117130 nội dung ${noiDung}`, thread, async () => {});
    assert.ok(xem.includes(noiDung));
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("NL04", "gửi cho số rằng trích đúng nội dung", async () => {
    const thread = threadMoi("nl04");
    const noiDung = "Chào Thảo, mình là trợ lý của chị Ngọc";
    const xem = await xuLy(`gửi cho số 0962117130 rằng ${noiDung}`, thread, async () => {});
    assert.ok(xem.includes(noiDung));
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("NL05", "gửi tin cho số điện thoại với dấu hai chấm hoạt động", async () => {
    const thread = threadMoi("nl05");
    const noiDung = "Chào Thảo";
    const xem = await xuLy(`gửi tin cho số điện thoại 0962117130: ${noiDung}`, thread, async () => {});
    assert.ok(xem.includes(noiDung));
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("NL06", "câu tự nhiên chuẩn hoá số đầu 0", async () => {
    const thread = threadMoi("nl06");
    const xem = await xuLy(`gửi tin cho số điện thoại 0962117130: ${NOI_DUNG}`, thread, async () => {});
    assert.match(xem, /84962117130/);
    assert.equal(lookupInputs.at(-1), "0962117130");
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("NL07", "câu tự nhiên chuẩn hoá số +84", async () => {
    const thread = threadMoi("nl07");
    const xem = await xuLy(`gửi tin cho số điện thoại +84962117130: ${NOI_DUNG}`, thread, async () => {});
    assert.match(xem, /84962117130/);
    assert.equal(lookupInputs.at(-1), "+84962117130");
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("NL08", "câu tự nhiên chuẩn hoá số 84", async () => {
    const thread = threadMoi("nl08");
    const xem = await xuLy(`gửi tin cho số điện thoại 84962117130: ${NOI_DUNG}`, thread, async () => {});
    assert.match(xem, /84962117130/);
    assert.equal(lookupInputs.at(-1), "84962117130");
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("NL09", "message extraction loại command prefix và phone", async () => {
    assert.deepEqual(adminCmd.phanTichLenhNhanQuaSo(CAU_PO), {
      so: "0767722789",
      noiDung: NOI_DUNG_PO,
    });
  });

  await bai("NL10", "message text không bị viết lại", async () => {
    const noiDung = "Chào Thảo, MÌNH hỗ trợ bạn nhé!\nDòng 2: giữ nguyên dấu, link https://example.com/a?b=1.";
    assert.deepEqual(
      adminCmd.phanTichLenhNhanQuaSo(`gửi tin cho số điện thoại 0962117130: ${noiDung}`),
      { so: "0962117130", noiDung }
    );
  });

  await bai("NL11", "send intent có phone nhưng thiếu content tạo zero side effect", async () => {
    const thread = threadMoi("nl11");
    const truoc = lookupCount;
    let sendCount = 0;
    const hoi = await xuLy("nhắn cho số 0962117130", thread, async () => { sendCount += 1; });
    assert.match(hoi, /gửi nội dung gì/);
    assert.equal(lookupCount, truoc);
    await xuLy("OK", thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
  });

  await bai("NL12", "văn bản thường chứa phone không thành phone action", async () => {
    const thread = threadMoi("nl12");
    const truoc = lookupCount;
    let sendCount = 0;
    const phanHoi = await xuLy("số điện thoại của Thảo là 0962117130", thread, async () => { sendCount += 1; });
    assert.match(phanHoi, /chưa thấy yêu cầu gửi tin nhắn/);
    assert.equal(lookupCount, truoc);
    await xuLy("OK", thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
  });

  await bai("NL13", "nhiều phone tạo zero lookup, zero pending, zero send", async () => {
    const thread = threadMoi("nl13");
    const truoc = lookupCount;
    let sendCount = 0;
    const phanHoi = await xuLy(
      "gửi tin cho số điện thoại 0962117130: gọi lại số 0767722789",
      thread,
      async () => { sendCount += 1; }
    );
    assert.match(phanHoi, /nhiều số điện thoại/);
    assert.equal(lookupCount, truoc);
    await xuLy("OK", thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
  });

  await bai("NL14", "phone sai định dạng tạo zero provider mutation", async () => {
    const thread = threadMoi("nl14");
    const truoc = lookupCount;
    let sendCount = 0;
    const phanHoi = await xuLy("nhắn cho số 09621171300 nội dung Chào Thảo", thread, async () => { sendCount += 1; });
    assert.match(phanHoi, /chưa đúng định dạng/);
    assert.equal(lookupCount, truoc);
    await xuLy("OK", thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
  });

  await bai("NL15", "natural preview gọi lookup đúng một lần", async () => {
    const thread = threadMoi("nl15");
    const truoc = lookupCount;
    await xuLy(CAU_PO, thread, async () => {});
    assert.equal(lookupCount - truoc, 1);
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("NL16", "natural preview tạo zero send", async () => {
    const thread = threadMoi("nl16");
    let sendCount = 0;
    await xuLy(CAU_PO, thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
    await xuLy("HUỶ", thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
  });

  await bai("NL17", "OK sau natural preview tạo đúng một send với exact message", async () => {
    const thread = threadMoi("nl17");
    const payloads = [];
    const gui = async (payload) => { payloads.push(payload); };
    await xuLy(CAU_PO, thread, gui);
    await xuLy("OK", thread, gui);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].text, NOI_DUNG_PO);
  });

  await bai("NL18", "OK lần hai không gửi thêm", async () => {
    const thread = threadMoi("nl18");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(CAU_PO, thread, gui);
    await xuLy("OK", thread, gui);
    await xuLy("OK", thread, gui);
    assert.equal(sendCount, 1);
  });

  await bai("NL19", "OK. không xác nhận và tạo zero send", async () => {
    const thread = threadMoi("nl19");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(CAU_PO, thread, gui);
    await xuLy("OK.", thread, gui);
    assert.equal(sendCount, 0);
    await xuLy("HUỶ", thread, gui);
    assert.equal(sendCount, 0);
  });

  await bai("NL20", "cancel xoá pending và tạo zero send", async () => {
    const thread = threadMoi("nl20");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(CAU_PO, thread, gui);
    await xuLy("HUỶ", thread, gui);
    const sauHuy = await xuLy("OK", thread, gui);
    assert.match(sauHuy, /Không có thao tác nào đang chờ OK/);
    assert.equal(sendCount, 0);
  });

  await bai("NL21", "lookup không tìm thấy tạo zero pending và zero send", async () => {
    const thread = threadMoi("nl21");
    const uidCu = lookupUid;
    lookupUid = "";
    let sendCount = 0;
    try {
      const phanHoi = await xuLy(CAU_PO, thread, async () => { sendCount += 1; });
      assert.match(phanHoi, /không tìm thấy/);
      await xuLy("OK", thread, async () => { sendCount += 1; });
    } finally {
      lookupUid = uidCu;
    }
    assert.equal(sendCount, 0);
  });

  await bai("NL22", "lookup provider failure tạo zero pending và zero send", async () => {
    const thread = threadMoi("nl22");
    lookupError = new Error("lookup fake failed");
    let sendCount = 0;
    try {
      const phanHoi = await xuLy(CAU_PO, thread, async () => { sendCount += 1; });
      assert.match(phanHoi, /lookup fake failed/);
      await xuLy("OK", thread, async () => { sendCount += 1; });
    } finally {
      lookupError = null;
    }
    assert.equal(sendCount, 0);
  });

  const GROUP_ID = "group-phone-routing-collision";
  await db.upsertThread(OWNER_A, {
    id: GROUP_ID,
    threadType: 1,
    title: "Nhóm Masterclass",
    lastMessage: "fixture gần đây",
    lastMessageAt: Math.floor(Date.now() / 1000),
  });

  await bai("NL23", "existing group-send command đi nguyên vào generic route", async () => {
    const thread = threadMoi("nl23");
    const truoc = lookupCount;
    let genericCalls = 0;
    adminCmd.capHinhPhanTichLenh(async () => {
      genericCalls += 1;
      return { hanhDong: "gui_tin", dichIds: [GROUP_ID], noiDung: "Hotline lớp là 0962117130" };
    });
    try {
      const xem = await xuLy("nhắn vào nhóm Masterclass: Hotline lớp là 0962117130", thread, async () => {});
      assert.match(xem, /gửi vào nhóm/);
      assert.equal(genericCalls, 1);
      assert.equal(lookupCount, truoc);
      await xuLy("HUỶ", thread, async () => {});
    } finally {
      adminCmd.capHinhPhanTichLenh(null);
    }
  });

  await bai("NL24", "existing scheduled group-send command đi nguyên vào generic route", async () => {
    const thread = threadMoi("nl24");
    const truoc = lookupCount;
    let genericCalls = 0;
    adminCmd.capHinhPhanTichLenh(async () => {
      genericCalls += 1;
      return {
        hanhDong: "dat_lich",
        lich: [{ dichId: GROUP_ID, dichTen: "Nhóm Masterclass", noiDung: "Hotline 0962117130", luc: "2099-01-01 08:00", lapLai: "" }],
      };
    });
    try {
      const xem = await xuLy("8h sáng 1/1/2099 gửi nhóm Masterclass: Hotline 0962117130", thread, async () => {});
      assert.match(xem, /Em ghi 1 lịch hẹn/);
      assert.equal(genericCalls, 1);
      assert.equal(lookupCount, truoc);
      await xuLy("HUỶ", thread, async () => {});
    } finally {
      adminCmd.capHinhPhanTichLenh(null);
    }
  });

  await bai("NL25", "existing Zoom command không bị phone routing lấy mất", async () => {
    const thread = threadMoi("nl25");
    const truoc = lookupCount;
    const xem = await xuLy("Tạo Zoom lớp 0962117130 lúc 8 giờ tối ngày mai trong 30 phút", thread, async () => {});
    assert.match(xem, /Em hiểu bạn muốn tạo:/);
    assert.equal(lookupCount, truoc);
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("NL26", "mail command không bị phone routing lấy mất", async () => {
    const thread = threadMoi("nl26");
    let genericCalls = 0;
    adminCmd.capHinhPhanTichLenh(async () => {
      genericCalls += 1;
      return { hanhDong: "khong_hieu", lyDo: "mail collision sentinel" };
    });
    try {
      const phanHoi = await xuLy("tra xem mail test@example.com về số 0962117130 chưa", thread, async () => {});
      assert.match(phanHoi, /mail collision sentinel/);
      assert.equal(genericCalls, 1);
    } finally {
      adminCmd.capHinhPhanTichLenh(null);
    }
  });

  await bai("NL27", "Google Meet placeholder không bị phone routing lấy mất", async () => {
    const thread = threadMoi("nl27");
    let genericCalls = 0;
    adminCmd.capHinhPhanTichLenh(async () => {
      genericCalls += 1;
      return { hanhDong: "khong_hieu", lyDo: "meet collision sentinel" };
    });
    try {
      const phanHoi = await xuLy("tạo Google Meet lớp 0962117130 ngày mai", thread, async () => {});
      assert.match(phanHoi, /meet collision sentinel/);
      assert.equal(genericCalls, 1);
    } finally {
      adminCmd.capHinhPhanTichLenh(null);
    }
  });

  const DONG_HELP_PHONE = "• Tìm & nhắn theo SĐT — “nhắn cho số ........: nội dung muốn nhắn”";
  const taoRawTinAdmin = (content, threadId, msgId) => ({
    type: 0,
    threadId,
    isSelf: false,
    data: {
      msgId,
      cliMsgId: `cli-${msgId}`,
      idTo: OWNER_A,
      uidFrom: "admin-phone",
      dName: "Chủ shop",
      msgType: "chat.text",
      ts: 1787589505000,
      content,
    },
  });
  const taoRawChatRecommended = (threadId, title, msgId) => ({
    type: 0,
    threadId,
    isSelf: false,
    data: {
      msgId,
      cliMsgId: `cli-${msgId}`,
      idTo: OWNER_A,
      uidFrom: "admin-phone",
      dName: "Chủ shop",
      msgType: "chat.recommended",
      ts: 1787589506000,
      content: {
        action: "recommend",
        childnumber: 0,
        description: "",
        href: "https://chat.zalo.me/recommended-user",
        params: "{}",
        thumb: "https://example.com/avatar.jpg",
        title,
        type: "user",
      },
    },
  });
  const chayQuaRanhGioiHeThong = async (
    rawMessage,
    { xuLyAdmin = async () => null, guiPhanHoi = async () => {} } = {}
  ) => {
    const normalized = messageUtils.normalizeIncomingMessage(rawMessage);
    if (tinHeThong.laTinHeThong(normalized)) {
      return { normalized, system: true, response: null };
    }
    const response = await xuLyAdmin(normalized);
    if (response) await guiPhanHoi(response);
    return { normalized, system: false, response };
  };
  const layHelpFallback = async (nhan) => {
    const thread = threadMoi(nhan);
    let genericCalls = 0;
    adminCmd.capHinhPhanTichLenh(async () => {
      genericCalls += 1;
      return { hanhDong: "khong_hieu", lyDo: "fallback MR sentinel" };
    });
    try {
      const text = await xuLy("một lệnh hoàn toàn chưa được nhận diện", thread, async () => {});
      return { text, genericCalls };
    } finally {
      adminCmd.capHinhPhanTichLenh(null);
    }
  };

  await bai("SE01", "chat.recommended được phân loại system/non-user sau normalization", async () => {
    const raw = taoRawChatRecommended("admin-se01", TEN, "provider-recommended-se01");
    const normalized = messageUtils.normalizeIncomingMessage(raw);
    assert.equal(normalized.msgType, "chat.recommended");
    assert.equal(normalized.content, TEN);
    assert.equal(tinHeThong.laTinHeThong(normalized), true);
  });

  await bai("SE02", "production gate dừng chat.recommended trước admin-command", async () => {
    const source = fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8");
    const batDau = source.indexOf("async function handleNewIncomingMessage(normalizedMsg)");
    const handler = source.slice(batDau, source.indexOf("\nasync function ", batDau + 1));
    const systemGate = handler.indexOf("if (laTinHeThong(normalizedMsg))");
    const returnSauSystemGate = handler.indexOf("return;", systemGate);
    const adminGate = handler.indexOf("if (await laLenhAdmin(normalizedMsg))");
    assert.ok(batDau >= 0);
    assert.ok(systemGate >= 0);
    assert.ok(returnSauSystemGate > systemGate);
    assert.ok(adminGate > returnSauSystemGate);

    let adminCalls = 0;
    await chayQuaRanhGioiHeThong(
      taoRawChatRecommended("admin-se02", TEN, "provider-recommended-se02"),
      { xuLyAdmin: async () => { adminCalls += 1; return "fallback"; } }
    );
    assert.equal(adminCalls, 0);
  });

  await bai("SE03", "chat.recommended tạo zero bot reply", async () => {
    let replyCount = 0;
    await chayQuaRanhGioiHeThong(
      taoRawChatRecommended("admin-se03", TEN, "provider-recommended-se03"),
      {
        xuLyAdmin: async () => "Em chưa hiểu ạ",
        guiPhanHoi: async () => { replyCount += 1; },
      }
    );
    assert.equal(replyCount, 0);
  });

  await bai("SE04", "chat.recommended tạo zero pending action", async () => {
    let pendingCount = 0;
    await chayQuaRanhGioiHeThong(
      taoRawChatRecommended("admin-se04", TEN, "provider-recommended-se04"),
      { xuLyAdmin: async () => { pendingCount += 1; return null; } }
    );
    assert.equal(pendingCount, 0);
  });

  await bai("SE05", "chat.recommended tạo zero phone lookup", async () => {
    let phoneLookupCount = 0;
    await chayQuaRanhGioiHeThong(
      taoRawChatRecommended("admin-se05", TEN, "provider-recommended-se05"),
      { xuLyAdmin: async () => { phoneLookupCount += 1; return null; } }
    );
    assert.equal(phoneLookupCount, 0);
  });

  await bai("SE06", "chat.recommended tạo zero Zalo send", async () => {
    let zaloSendCount = 0;
    await chayQuaRanhGioiHeThong(
      taoRawChatRecommended("admin-se06", TEN, "provider-recommended-se06"),
      {
        xuLyAdmin: async () => "fallback",
        guiPhanHoi: async () => { zaloSendCount += 1; },
      }
    );
    assert.equal(zaloSendCount, 0);
  });

  await bai("SE07", "display name trong content.title không thành admin command", async () => {
    let adminCalls = 0;
    const ketQuaBien = await chayQuaRanhGioiHeThong(
      taoRawChatRecommended("admin-se07", TEN, "provider-recommended-se07"),
      { xuLyAdmin: async () => { adminCalls += 1; return "fallback"; } }
    );
    assert.equal(ketQuaBien.normalized.content, TEN);
    assert.equal(adminCalls, 0);
  });

  await bai("SE08", "ordinary real user text vẫn là non-system", async () => {
    const normalized = messageUtils.normalizeIncomingMessage(
      taoRawTinAdmin("Tin nhắn người dùng bình thường", "admin-se08", "provider-user-se08")
    );
    assert.equal(normalized.msgType, "chat.text");
    assert.equal(tinHeThong.laTinHeThong(normalized), false);
  });

  await bai("SE09", "existing system-event classifications giữ nguyên", async () => {
    assert.equal(tinHeThong.laTinHeThong({ msgType: "group.poll" }), true);
    assert.equal(tinHeThong.laTinHeThong({ msgType: "event.update" }), true);
    assert.equal(tinHeThong.laTinHeThong({
      msgType: "unknown.event",
      rawJson: { data: { content: { action: "create", params: "{}" } } },
    }), true);
    assert.equal(tinHeThong.laTinHeThong({
      msgType: "chat.photo",
      rawJson: { data: { content: { action: "", params: "{}", href: "https://example.com/photo.jpg" } } },
    }), false);
  });

  await bai("SE10", "phone-direct command qua boundary vẫn tạo đúng một preview", async () => {
    const thread = threadMoi("se10");
    const truoc = lookupCount;
    const replies = [];
    const ketQuaBien = await chayQuaRanhGioiHeThong(
      taoRawTinAdmin(CAU_PO, thread, "provider-phone-command-se10"),
      {
        xuLyAdmin: (message) => adminCmd.xuLyLenh(message, guiThuongKhongDuocGoi, async () => {}),
        guiPhanHoi: async (text) => { replies.push(text); },
      }
    );
    assert.equal(ketQuaBien.system, false);
    assert.equal(lookupCount - truoc, 1);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /Em sẽ gửi một tin nhắn riêng/);
    assert.ok(replies[0].includes(NOI_DUNG_PO));
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("SE11", "phone command cộng companion chỉ có một preview và zero fallback", async () => {
    const thread = threadMoi("se11");
    const replies = [];
    let genericCalls = 0;
    adminCmd.capHinhPhanTichLenh(async () => {
      genericCalls += 1;
      return { hanhDong: "khong_hieu", lyDo: "companion fallback sentinel" };
    });
    try {
      const xuLyAdmin = (message) =>
        adminCmd.xuLyLenh(message, guiThuongKhongDuocGoi, async () => {});
      const guiPhanHoi = async (text) => { replies.push(text); };
      await chayQuaRanhGioiHeThong(
        taoRawTinAdmin(CAU_PO, thread, "provider-phone-command-se11"),
        { xuLyAdmin, guiPhanHoi }
      );
      const companion = await chayQuaRanhGioiHeThong(
        taoRawChatRecommended(thread, TEN, "provider-recommended-se11"),
        { xuLyAdmin, guiPhanHoi }
      );
      assert.equal(companion.normalized.id, "provider-recommended-se11");
      assert.notEqual(companion.normalized.id, "provider-phone-command-se11");
      assert.equal(replies.length, 1);
      assert.match(replies[0], /Em sẽ gửi một tin nhắn riêng/);
      assert.equal(genericCalls, 0);
      await xuLy("HUỶ", thread, async () => {});
    } finally {
      adminCmd.capHinhPhanTichLenh(null);
    }
  });

  await bai("SE12", "canonical phone help copy giữ nguyên", async () => {
    const { text } = await layHelpFallback("se12");
    assert.ok(text.split("\n").includes(DONG_HELP_PHONE));
  });

  await bai("MR01", "phone preview tạo đúng một bot response", async () => {
    const thread = threadMoi("mr01");
    const botResponses = [];
    const response = await xuLy(CAU_PO, thread, async () => {});
    if (response) botResponses.push(response);
    assert.equal(botResponses.length, 1);
    assert.match(botResponses[0], /Em sẽ gửi một tin nhắn riêng/);
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("MR02", "phone preview không gọi generic fallback parser", async () => {
    const thread = threadMoi("mr02");
    let genericCalls = 0;
    adminCmd.capHinhPhanTichLenh(async () => {
      genericCalls += 1;
      return { hanhDong: "khong_hieu", lyDo: "không được chạy" };
    });
    try {
      const response = await xuLy(CAU_PO, thread, async () => {});
      assert.match(response, /Em sẽ gửi một tin nhắn riêng/);
      assert.doesNotMatch(response, /Em chưa hiểu/);
      assert.equal(genericCalls, 0);
      await xuLy("HUỶ", thread, async () => {});
    } finally {
      adminCmd.capHinhPhanTichLenh(null);
    }
  });

  await bai("MR03", "phone preview tạo đúng một pending action", async () => {
    const thread = threadMoi("mr03");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(CAU_PO, thread, gui);
    await xuLy("OK", thread, gui);
    const lanHai = await xuLy("OK", thread, gui);
    assert.equal(sendCount, 1);
    assert.match(lanHai, /Không có thao tác nào đang chờ OK/);
  });

  await bai("MR04", "phone preview thực hiện đúng một lookup", async () => {
    const thread = threadMoi("mr04");
    const truoc = lookupCount;
    await xuLy(CAU_PO, thread, async () => {});
    assert.equal(lookupCount - truoc, 1);
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("MR05", "phone preview tạo zero send trước OK", async () => {
    const thread = threadMoi("mr05");
    let sendCount = 0;
    await xuLy(CAU_PO, thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
    await xuLy("HUỶ", thread, async () => { sendCount += 1; });
    assert.equal(sendCount, 0);
  });

  await bai("MR06", "OK vẫn gửi đúng một lần", async () => {
    const thread = threadMoi("mr06");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(CAU_PO, thread, gui);
    await xuLy("OK", thread, gui);
    assert.equal(sendCount, 1);
  });

  await bai("MR07", "OK lần hai không gửi thêm", async () => {
    const thread = threadMoi("mr07");
    let sendCount = 0;
    const gui = async () => { sendCount += 1; };
    await xuLy(CAU_PO, thread, gui);
    await xuLy("OK", thread, gui);
    await xuLy("OK", thread, gui);
    assert.equal(sendCount, 1);
  });

  await bai("MR08", "unknown command vẫn hiển thị generic help fallback", async () => {
    const { text, genericCalls } = await layHelpFallback("mr08");
    assert.equal(genericCalls, 1);
    assert.match(text, /Em chưa hiểu ạ/);
    assert.match(text, /Em làm được mấy việc này/);
  });

  await bai("MR09", "generic help chứa canonical phone capability nguyên văn", async () => {
    const { text } = await layHelpFallback("mr09");
    assert.ok(text.split("\n").includes(DONG_HELP_PHONE));
  });

  await bai("MR09A", "phone help item không chứa số điện thoại thật", async () => {
    const { text } = await layHelpFallback("mr09a");
    const dong = text.split("\n").find((line) => line.includes("Tìm & nhắn theo SĐT"));
    assert.ok(dong);
    assert.doesNotMatch(dong, /(?:\+84|84|0)\d{9}/);
  });

  await bai("MR09B", "phone help item giữ đúng placeholder tám dấu chấm", async () => {
    const { text } = await layHelpFallback("mr09b");
    const dong = text.split("\n").find((line) => line.includes("Tìm & nhắn theo SĐT"));
    assert.equal(dong, DONG_HELP_PHONE);
    assert.equal((dong.match(/\.\.\.\.\.\.\.\./g) || []).length, 1);
  });

  await bai("MR10", "generic help giữ nguyên capability Gửi tin", async () => {
    const { text } = await layHelpFallback("mr10");
    assert.ok(text.split("\n").includes("• Gửi tin — “nhắn vào nhóm masterclass là ...”"));
  });

  await bai("MR11", "generic help giữ nguyên capability Hẹn giờ gửi", async () => {
    const { text } = await layHelpFallback("mr11");
    assert.ok(text.split("\n").includes("• Hẹn giờ gửi — “8h sáng 10/8 gửi nhóm masterclass là ...”"));
  });

  await bai("MR12", "generic help giữ nguyên capability Xem lịch / huỷ lịch", async () => {
    const { text } = await layHelpFallback("mr12");
    assert.ok(text.split("\n").includes("• Xem lịch / huỷ lịch — “xem lịch”, “huỷ lịch 3”"));
  });

  await bai("MR13", "generic help giữ nguyên capability Tra mail", async () => {
    const { text } = await layHelpFallback("mr13");
    assert.ok(text.split("\n").includes("• Tra mail — “tra xem mail gửi abc@gmail.com chưa”"));
  });

  await bai("MR14", "ordinary phone text vẫn non-actionable", async () => {
    const thread = threadMoi("mr14");
    const truoc = lookupCount;
    let sendCount = 0;
    const response = await xuLy("số điện thoại của Thảo là 0962117130", thread, async () => { sendCount += 1; });
    assert.match(response, /chưa thấy yêu cầu gửi tin nhắn/);
    assert.equal(lookupCount, truoc);
    assert.equal(sendCount, 0);
  });

  await bai("MR15", "existing group-send behavior không đổi", async () => {
    const thread = threadMoi("mr15");
    let genericCalls = 0;
    adminCmd.capHinhPhanTichLenh(async () => {
      genericCalls += 1;
      return { hanhDong: "gui_tin", dichIds: [GROUP_ID], noiDung: "Nội dung nhóm MR15" };
    });
    try {
      const response = await xuLy("nhắn vào nhóm Masterclass: Nội dung nhóm MR15", thread, async () => {});
      assert.match(response, /gửi vào nhóm/);
      assert.equal(genericCalls, 1);
      await xuLy("HUỶ", thread, async () => {});
    } finally {
      adminCmd.capHinhPhanTichLenh(null);
    }
  });

  await bai("MR16", "existing scheduled-send behavior không đổi", async () => {
    const thread = threadMoi("mr16");
    let genericCalls = 0;
    adminCmd.capHinhPhanTichLenh(async () => {
      genericCalls += 1;
      return {
        hanhDong: "dat_lich",
        lich: [{ dichId: GROUP_ID, dichTen: "Nhóm Masterclass", noiDung: "MR16", luc: "2099-01-02 08:00", lapLai: "" }],
      };
    });
    try {
      const response = await xuLy("8h sáng 2/1/2099 gửi nhóm Masterclass: MR16", thread, async () => {});
      assert.match(response, /Em ghi 1 lịch hẹn/);
      assert.equal(genericCalls, 1);
      await xuLy("HUỶ", thread, async () => {});
    } finally {
      adminCmd.capHinhPhanTichLenh(null);
    }
  });

  await bai("MR17", "existing Zoom routing không đổi", async () => {
    const thread = threadMoi("mr17");
    const response = await xuLy("Tạo Zoom lớp MR17 lúc 8 giờ tối ngày mai trong 30 phút", thread, async () => {});
    assert.match(response, /Em hiểu bạn muốn tạo:/);
    await xuLy("HUỶ", thread, async () => {});
  });

  await bai("R01", "không âm thầm nhận alias ngoài cú pháp hẹp", async () => {
    assert.equal(adminCmd.phanTichLenhNhanQuaSo(`Nhắn số 0962117130: ${NOI_DUNG}`), null);
    assert.equal(adminCmd.phanTichLenhNhanQuaSo(`Gửi qua số 0962117130 nội dung ${NOI_DUNG}`), null);
  });

  await bai("R02", "registration failure không gọi canonical send và không retry", async () => {
    let sendCount = 0;
    await assert.rejects(
      zaloService.sendResolvedPrivateMessage(
        { uid: "900000000099", displayName: TEN, text: NOI_DUNG },
        {
          ownerUid: OWNER_A,
          registerThread: async () => { throw new Error("db fake failed"); },
          canonicalSend: async () => { sendCount += 1; },
        }
      ),
      /db fake failed/
    );
    assert.equal(sendCount, 0);
  });

  const hong = ketQua.filter((x) => !x.pass);
  console.log(`\nPHONE DIRECT MESSAGE: ${ketQua.length - hong.length}/${ketQua.length} PASS`);
  if (hong.length) process.exitCode = 1;
}

if (process.env.PHONE_DIRECT_SQLITE_SHIM === "1") {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  chayTrongRuntimeTest();
}
