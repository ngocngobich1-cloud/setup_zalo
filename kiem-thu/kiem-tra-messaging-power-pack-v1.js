/**
 * BU-ZCA-MESSAGING-POWER-PACK-V1 — focused contract suite (M1..M16).
 *
 * Khong goi Zalo that mot lan nao. Bien gioi provider duoc thay bang mot doi
 * tuong ghi lai tung lan goi, nen suite nay chung minh HINH DANG loi goi va
 * LUAT nghiep vu quanh no - khong chung minh hanh vi cua Zalo. Ngu nghia
 * provider da duoc chung minh o dot UAT rieng va khong duoc chay lai o day.
 *
 * Chay: node --import ./kiem-thu/node24-arm64-test-polyfills.js \
 *            --import ./kiem-thu/sqlite3-node24-test-register.js \
 *            kiem-thu/kiem-tra-messaging-power-pack-v1.js
 * (hai --import chi can tren host Node 24 ARM64; xem sqlite3-node24-test-register.js)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";

/** Commit goc da duyet cho goi tin nay. Moc so sanh cho cac bai "khong doi". */
const BASE_SHA = "695eb7570c13d7858749858ab3873964f404d61d";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ZALO_SRC = fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8");
const DB_SRC = fs.readFileSync(path.join(REPO, "lib", "db.js"), "utf8");
const SERVER_SRC = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const APP_SRC = fs.readFileSync(path.join(REPO, "public", "app.js"), "utf8");
const HTML_SRC = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
const CSS_SRC = fs.readFileSync(path.join(REPO, "public", "style.css"), "utf8");
const CAM_XUC_SRC = fs.readFileSync(path.join(REPO, "lib", "cam-xuc.js"), "utf8");
const STICKER_SRC = fs.readFileSync(path.join(REPO, "lib", "sticker-zalo.js"), "utf8");

/** Cong danh sach trang THAT cua app - harness khong duoc thay the. */
const CAM_XUC_THAT = await import(pathToFileURL(path.join(REPO, "lib", "cam-xuc.js")).href);
const MESSAGE_UTILS_THAT = await import(pathToFileURL(path.join(REPO, "lib", "message-utils.js")).href);

/** Doc mot tep tai DUNG commit goc da duyet de cac guard khong dua vao hardcode. */
function docTepTaiBase(duongDan) {
  const ketQua = spawnSync("git", ["show", `${BASE_SHA}:${duongDan}`], {
    cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(ketQua.status, 0, `khong doc duoc ${duongDan} tai ${BASE_SHA}: ${ketQua.stderr}`);
  return ketQua.stdout;
}

const results = [];
let nhom = "";

function group(ten) {
  nhom = ten;
}

async function bai(ma, moTa, fn) {
  try {
    await fn();
    results.push({ nhom, ma, ok: true });
    console.log(`PASS ${ma} ${moTa}`);
  } catch (error) {
    results.push({ nhom, ma, ok: false });
    console.log(`FAIL ${ma} ${moTa}\n  ${error.stack || error.message}`);
  }
}

/* =====================================================================
 * HARNESS 1 — lib/zalo-service.js voi bien gioi provider gia
 * ===================================================================== */

let harnessSerial = 0;

/** Danh sach ten import duoc doc TU NGUON, khong chep tay. */
function tenImportCuaZaloService() {
  const head = ZALO_SRC.slice(0, ZALO_SRC.indexOf("const USER_AGENT"));
  const ten = [];
  for (const m of head.matchAll(/import\s+(?:(\*\s+as\s+\w+)|\{([^}]*)\}|(\w+))\s+from/g)) {
    if (m[1]) ten.push(m[1].replace(/\*\s+as\s+/, ""));
    else if (m[2]) {
      for (const phan of m[2].split(",").map((s) => s.trim()).filter(Boolean)) {
        ten.push(phan.includes(" as ") ? phan.split(" as ")[1].trim() : phan);
      }
    } else if (m[3]) ten.push(m[3]);
  }
  return ten;
}

/**
 * Provider gia: ghi lai TUNG lan goi kem nguyen van doi so.
 * Khong ham nao tu thu lai, nen so lan goi la bang chung truc tiep cho luat
 * "mot lan bam = mot lan goi".
 */
function taoProviderGia(quaTai = {}) {
  const goi = [];
  const listenerHandlers = new Map();
  const ghi = (ten, mac) => (...args) => {
    goi.push({ ten, args });
    if (quaTai[ten]) return quaTai[ten](...args);
    return Promise.resolve(mac);
  };
  return {
    goi,
    listenerHandlers,
    lanGoi: (ten) => goi.filter((g) => g.ten === ten),
    addReaction: ghi("addReaction", { msgIds: [1] }),
    sendSticker: ghi("sendSticker", { msgId: 991 }),
    sendTypingEvent: ghi("sendTypingEvent", { status: 0 }),
    sendSeenEvent: ghi("sendSeenEvent", { status: 0 }),
    undo: ghi("undo", { status: 0 }),
    deleteMessage: ghi("deleteMessage", { status: 0 }),
    forwardMessage: ghi("forwardMessage", { success: [{ clientId: "c", msgId: "m" }], fail: [] }),
    parseLink: ghi("parseLink", { data: {}, error_maps: {} }),
    sendMessage: ghi("sendMessage", { message: { msgId: 1 } }),
    sendLink: ghi("sendLink", { msgId: "1" }),
    listener: {
      on(event, handler) { listenerHandlers.set(event, handler); },
      start() {},
    },
  };
}

async function taoDichVu({ deps = {}, provider = taoProviderGia(), ownerUid = "owner-A" } = {}) {
  const tenImport = tenImportCuaZaloService();
  const suKienSocket = [];
  const nhatKy = [];

  const macDinh = {
    Zalo: class { constructor() {} async login() { throw new Error("khong dang nhap that"); } async loginQR() { throw new Error("khong quet QR"); } },
    LoginQRCallbackEventType: {},
    ThreadType: { User: 0, Group: 1 },
    AvatarSize: { Large: "large" },
    taoBoGom: () => ({ them: () => {}, huyTatCa: () => {}, dangMo: () => false }),
    khoaGom: (a, b) => `${a}|${b}`,
    locRuotGan: (text) => ({ sach: String(text), daCat: false, soDongCat: 0 }),
    createPdfAutomationHandler: () => async () => "CONTINUE",
    PDF_AUTOMATION_HANDLED: "HANDLED",
    aiChat: { capHinhChuTaiKhoan: () => {}, getConfig: () => ({ botEnabled: true }), tryReply: async () => null },
    addLog: async (entry) => { nhatKy.push(entry); return entry; },
    normalizeTs: (v) => Number(v),
    splitIntoBubbles: (t) => [String(t)],
    enrichMessageSticker: async (_api, m) => m,
    enrichMessagesForDisplay: async (_api, m) => m,
    resolveThreadMeta: async () => ({ title: "Hoi thoai", avatar: null }),
    resolveSenderAvatar: async () => null,
    normalizeIncomingMessage: (m) => m,
    insertMessage: async () => ({ changes: 1 }),
    upsertThread: async (owner, thread) => ({ ...thread, ownerUid: owner }),
    listThreads: async () => [],
    getThreadMessages: async () => [],
    getThread: async () => null,
    loadCredentials: async () => null,
    // Cong kiem tra danh sach trang phai la HANG THAT, khong phai stub: neu no
    // bi thay bang mot ham gia thi bai kiem "chan bieu tuong ngoai danh sach"
    // se dat ma khong chung minh duoc gi.
    layBieuTuongApp: CAM_XUC_THAT.layBieuTuongApp,
    tenBieuTuongApp: CAM_XUC_THAT.tenBieuTuongApp,
  };

  const bang = {};
  for (const ten of tenImport) bang[ten] = () => undefined;
  Object.assign(bang, macDinh, deps);

  const khoa = `__mppv1_${process.pid}_${++harnessSerial}`;
  globalThis[khoa] = bang;
  const tiem = `const { ${tenImport.join(", ")} } = globalThis[${JSON.stringify(khoa)}];\n`;
  const seam = `
export {
  traLoiCumTin as __traLoiCumTin,
  thuThaCamXuc as __thuThaCamXuc,
  thuGuiSticker as __thuGuiSticker,
  batDauGoPhim as __batDauGoPhim,
  ghiNhanCamXucTuProvider as __ghiNhanCamXucTuProvider,
  ghiNhanThuHoiTuProvider as __ghiNhanThuHoiTuProvider,
  capNhatCamXucCucBo as __capNhatCamXucCucBo,
  guiDaXemChoTins as __guiDaXemChoTins,
  taoOriginRuntime as __taoOriginRuntime,
  setupListener as __setupListenerForTest
};
export function __setRuntime(testApi, uid) {
  api = testApi;
  appState.loggedIn = true;
  appState.uid = String(uid);
  appState.displayName = String(uid);
}
export function __setSocket(fakeIo) { io = fakeIo; }
export function __logoutRuntime() { runtimeGeneration += 1; api = null; }
`;
  const nguon = tiem + ZALO_SRC.slice(ZALO_SRC.indexOf("const USER_AGENT")) + seam;
  const url = `data:text/javascript;base64,${Buffer.from(nguon).toString("base64")}#${harnessSerial}`;
  const service = await import(url);
  service.__setRuntime(provider, ownerUid);
  service.__setSocket({ emit: (event, payload) => suKienSocket.push({ event, payload }) });
  return { service, provider, suKienSocket, nhatKy };
}

/** Thread do MAY CHU giu, khong phai do trinh duyet khai. */
function threadGia(id, threadType) {
  return { id: String(id), threadType: Number(threadType), title: `T-${id}` };
}

function tinGia({ id = "M1", isSelf = false, msgType = "text", content = "xin chao", identity = true } = {}) {
  return {
    id: String(id),
    content,
    isSelf,
    msgType,
    ts: 1700000000000,
    rawJson: identity
      ? { data: { msgId: `g-${id}`, cliMsgId: `c-${id}`, uidFrom: "owner-A", idTo: "peer-1", msgType, st: 1, at: 2, cmd: 501, ts: "1700000000000" } }
      : null,
  };
}

/** Nguon su that phia may chu cho mot lan hanh dong. */
function depsHanhDong({ thread, message, identity = true }) {
  return {
    getThread: async (_owner, threadId) => (String(threadId) === thread.id ? thread : null),
    resolveOwnedActionMessage: async (_owner, threadId, messageId, tuyChon = {}) => {
      if (String(threadId) !== thread.id) return { ok: false, code: "NOT_FOUND" };
      if (String(messageId) !== String(message.id)) return { ok: false, code: "NOT_FOUND" };
      const dt = message.rawJson?.data || null;
      if (!dt && tuyChon.requireIdentity !== false) return { ok: false, code: "ACTION_IDENTITY_UNAVAILABLE" };
      return {
        ok: true,
        thread,
        message,
        identity: identity && dt ? { ...dt } : null,
      };
    },
    rutDanhTinhProvider: (raw) => (raw?.data ? { ...raw.data } : null),
  };
}

/** Boc ghi chu de cac bai soi ma nguon khong doi nham mot dong giai thich. */
function boGhiChu(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((d) => d.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

async function batLoi(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/* =====================================================================
 * HARNESS 2 — CSDL that tren tep tam
 * ===================================================================== */

const THU_MUC_TAM = fs.mkdtempSync(path.join(os.tmpdir(), "mppv1-"));
let dbSerial = 0;

async function moCsdlTam(goc = null) {
  // lib/database-path.js giai duong dan theo process.cwd(), KHONG theo bien moi
  // truong. Doi cwd la cach co lap duy nhat dung - dat DATA_DIR se lang le ghi
  // vao data/zalo.db that cua kho ma khong ai biet.
  const thuMuc = goc || path.join(THU_MUC_TAM, `db-${++dbSerial}`);
  fs.mkdirSync(path.join(thuMuc, "data"), { recursive: true });
  const truoc = process.cwd();
  process.chdir(thuMuc);
  try {
    const db = await import(`${pathToFileURL(path.join(REPO, "lib", "db.js")).href}?mppv1=${dbSerial}-${++harnessSerial}`);
    await db.initDb();
    return { db, thuMuc };
  } finally {
    process.chdir(truoc);
  }
}

/* =====================================================================
 * HARNESS 3 — public/app.js chay that trong JSDOM
 * ===================================================================== */

async function taoGiaoDien({ mobile = false } = {}) {
  const dom = new JSDOM(HTML_SRC, { url: "http://mppv1.test/", pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mobile ? 393 : 1280 });
  window.matchMedia = (query) => ({
    matches: mobile && query === "(max-width: 760px)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.requestAnimationFrame = (cb) => { cb(); return 1; };
  window.cancelAnimationFrame = () => {};

  const hoiXacNhan = [];
  const canhBao = [];
  let traLoiXacNhan = true;
  window.confirm = (text) => { hoiXacNhan.push(text); return traLoiXacNhan; };
  window.alert = (text) => { canhBao.push(text); };

  Object.assign(globalThis, {
    window,
    document,
    history: window.history,
    localStorage: window.localStorage,
    CustomEvent: window.CustomEvent,
    Event: window.Event,
    PopStateEvent: window.PopStateEvent,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    FormData: window.FormData,
    File: window.File,
    Option: window.Option,
    Image: window.Image,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    confirm: window.confirm,
    alert: window.alert,
  });
  if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => "blob:fixture";
  if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};

  const socketHandlers = new Map();
  globalThis.io = () => ({ on(event, handler) { socketHandlers.set(event, handler); } });
  window.io = globalThis.io;

  const goiMang = [];
  const traLoiTheoTuyen = new Map();
  async function fetchGia(input, options = {}) {
    const url = String(input);
    const method = String(options.method || "GET").toUpperCase();
    let body = null;
    if (typeof options.body === "string") { try { body = JSON.parse(options.body); } catch { body = options.body; } }
    goiMang.push({ url, method, body });
    const rieng = traLoiTheoTuyen.get(`${method} ${url}`);
    if (rieng) return rieng();
    const mac = macDinhTuyen(url, method);
    return { ok: true, status: 200, json: async () => structuredClone(mac) };
  }
  function macDinhTuyen(url, method) {
    if (url === "/api/bootstrap") {
      return {
        loggedIn: true, uid: "owner-A", displayName: "Chu", threads: [], qr: {},
        ketNoi: { trangThai: "song", lyDo: "" }, user: { username: "u" }, admins: [],
      };
    }
    if (url === "/api/onboarding") return { step: 0, started: false, completed: true, data: {} };
    if (url === "/api/bot/status") return { enabled: false, ready: true };
    if (url === "/api/messaging/stickers") {
      return { ok: true, stickers: [{ key: "chao_hoi", moTa: "Hello" }, { key: "cam_on", moTa: "Thank you" }] };
    }
    if (url.startsWith("/api/messages/")) return { messages: [] };
    if (url === "/api/auto-reply") return [];
    if (url === "/api/knowledge") return { files: [] };
    if (url === "/api/zalo/groups") return { groups: [] };
    if (url === "/api/ai-chat") return { config: {}, ready: false };
    if (url === "/api/ai-chat/providers") return { providers: [] };
    if (url === "/api/ai-chat/opencode-test") return { agents: [], providers: [], systemDefaultModel: "" };
    if (url === "/api/auth/me") return { user: { username: "u" } };
    if (url === "/api/auth/otp-settings") return { enabled: false, email: "", adminZaloUid: "", smtpConfigured: false };
    if (url === "/api/training") return { model: "", messages: [], files: [], sessionId: null };
    if (url === "/api/lich-hen") return { lich: [] };
    if (url === "/api/customer-memory") return { customers: [] };
    if (url.startsWith("/api/logs")) return { logs: [] };
    if (["POST", "PUT", "DELETE"].includes(method)) return { ok: true };
    return {};
  }
  globalThis.fetch = fetchGia;
  window.fetch = fetchGia;

  await import(`${pathToFileURL(path.join(REPO, "public", "app.js")).href}?mppv1=${++harnessSerial}`);
  await flush(14);

  return {
    window,
    document,
    socketHandlers,
    goiMang,
    hoiXacNhan,
    canhBao,
    datTraLoiXacNhan: (v) => { traLoiXacNhan = v; },
    datTuyen: (method, url, fn) => traLoiTheoTuyen.set(`${method} ${url}`, fn),
    async chonCuocTroChuyen(thread, messages, danhMuc = null) {
      traLoiTheoTuyen.set(`GET /api/messages/${encodeURIComponent(thread.id)}`, () => ({
        ok: true, status: 200, json: async () => ({ messages, myAvatar: null }),
      }));
      socketHandlers.get("threads")?.(danhMuc || [thread]);
      await flush();
      const muc = [...document.querySelectorAll(".thread-item")][0];
      muc.click();
      await flush(6);
    },
  };
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
}

/* =====================================================================
 * M1 — NEN MONG DINH DANH
 * ===================================================================== */
group("M1");

await bai("M1.1", "tin tu gui rawJson=null duoc bo sung dinh danh khi Zalo doi lai", async () => {
  const { db } = await moCsdlTam();
  await db.upsertThread("owner-A", { id: "peer-1", threadType: 0, title: "Khach" });
  await db.insertMessage("owner-A", {
    id: "555", threadId: "peer-1", threadType: 0, content: "chao ban",
    isSelf: true, senderId: "owner-A", senderName: "Chu", msgType: "text",
    ts: 1700000000000, rawJson: null,
  });

  const echo = {
    id: "555", threadId: "peer-1", threadType: 0, content: "chao ban", isSelf: true,
    senderId: "owner-A", senderName: "Chu", msgType: "chat.text", ts: 1700000009999,
    rawJson: { data: { msgId: "555", cliMsgId: "77", uidFrom: "owner-A", idTo: "peer-1", msgType: "chat.text", st: 1, at: 2, cmd: 501, ts: "1700000009999" } },
  };
  const ketQua = await db.insertMessage("owner-A", echo);

  assert.equal(ketQua.changes, 0, "ban trung KHONG duoc tao dong moi");
  assert.equal(ketQua.enriched, true, "phai bo sung duoc dinh danh");

  const rows = await db.getThreadMessages("owner-A", "peer-1", 50);
  assert.equal(rows.length, 1, "van chi mot dong");
  assert.equal(rows[0].rawJson?.data?.cliMsgId, "77");
  assert.equal(rows[0].rawJson?.data?.uidFrom, "owner-A");
});

await bai("M1.2", "bo sung KHONG ghi de noi dung/thoi diem canonical", async () => {
  const { db } = await moCsdlTam();
  await db.upsertThread("owner-A", { id: "peer-1", threadType: 0 });
  await db.insertMessage("owner-A", {
    id: "556", threadId: "peer-1", content: "ban goc", isSelf: true,
    msgType: "text", ts: 1700000000000, rawJson: null,
  });
  await db.insertMessage("owner-A", {
    id: "556", threadId: "peer-1", content: "BAN KHAC", isSelf: true,
    msgType: "chat.text", ts: 1799999999999,
    rawJson: { data: { msgId: "556", cliMsgId: "78", uidFrom: "owner-A", idTo: "peer-1" } },
  });
  const [row] = await db.getThreadMessages("owner-A", "peer-1", 50);
  assert.equal(row.content, "ban goc", "noi dung nguoi dung thay khong duoc doi");
  assert.equal(row.ts, 1700000000000, "thoi diem canonical khong duoc doi");
  assert.equal(row.msgType, "text", "msg_type da co thi khong ghi de");
  assert.equal(row.rawJson?.data?.cliMsgId, "78", "dinh danh van duoc bo sung");
});

await bai("M1.3", "cot dang trong duoc dien, cot da co duoc giu", async () => {
  const { db } = await moCsdlTam();
  await db.upsertThread("owner-A", { id: "peer-1", threadType: 0 });
  await db.insertMessage("owner-A", {
    id: "557", threadId: "peer-1", content: "x", isSelf: true,
    senderId: null, senderName: null, msgType: null, ts: 1, rawJson: null,
  });
  await db.insertMessage("owner-A", {
    id: "557", threadId: "peer-1", content: "x", isSelf: true,
    senderId: "owner-A", senderName: "Chu", msgType: "chat.text", ts: 1,
    rawJson: { data: { msgId: "557", cliMsgId: "79", uidFrom: "owner-A", idTo: "peer-1" } },
  });
  const [row] = await db.getThreadMessages("owner-A", "peer-1", 50);
  assert.equal(row.senderId, "owner-A");
  assert.equal(row.senderName, "Chu");
  assert.equal(row.msgType, "chat.text");
});

await bai("M1.4", "bo sung KHONG phat su kien tin moi (persist tra null khi changes=0)", async () => {
  const { service, suKienSocket } = await taoDichVu({
    deps: { insertMessage: async () => ({ changes: 0, enriched: true }) },
  });
  const ketQua = await service.persistAndBroadcastMessage({
    id: "1", threadId: "peer-1", threadType: 0, content: "chao", ts: 1, isSelf: true,
  });
  assert.equal(ketQua, null, "ban trung phai tra null");
  assert.equal(suKienSocket.filter((s) => s.event === "new-message").length, 0);
});

await bai("M1.5", "dong cu con thieu dinh danh thi FAIL CLOSED, khong bia cliMsgId", async () => {
  const { db } = await moCsdlTam();
  await db.upsertThread("owner-A", { id: "peer-1", threadType: 0 });
  await db.insertMessage("owner-A", {
    id: "558", threadId: "peer-1", content: "tin cu", isSelf: true, msgType: "text", ts: 1, rawJson: null,
  });
  const ketQua = await db.resolveOwnedActionMessage("owner-A", "peer-1", "558");
  assert.equal(ketQua.ok, false);
  assert.equal(ketQua.code, "ACTION_IDENTITY_UNAVAILABLE");
  assert.doesNotMatch(DB_SRC, /cliMsgId:\s*(?:Date\.now|Math\.random|`|["'](?!\s*\))[^"']*["']\s*\+)/,
    "khong duoc tu sinh cliMsgId");
});

await bai("M1.6", "mo lai CSDL: phan da bo sung van con", async () => {
  const { db, thuMuc } = await moCsdlTam();
  await db.upsertThread("owner-A", { id: "peer-1", threadType: 0 });
  await db.insertMessage("owner-A", { id: "559", threadId: "peer-1", content: "x", isSelf: true, msgType: "text", ts: 1, rawJson: null });
  await db.insertMessage("owner-A", {
    id: "559", threadId: "peer-1", content: "x", isSelf: true, msgType: "text", ts: 1,
    rawJson: { data: { msgId: "559", cliMsgId: "80", uidFrom: "owner-A", idTo: "peer-1" } },
  });
  // Mo lai CSDL nhu mot lan khoi dong lai ung dung: cung thu muc, module moi.
  const { db: db2 } = await moCsdlTam(thuMuc);
  const ketQua = await db2.resolveOwnedActionMessage("owner-A", "peer-1", "559");
  assert.equal(ketQua.ok, true, "sau khi mo lai van phai doc duoc dinh danh");
  assert.equal(ketQua.identity.cliMsgId, "80");
});

/* =====================================================================
 * M2 — CAM XUC
 * ===================================================================== */
group("M2");

await bai("M2.1", "dung sau bieu tuong cua app duoc phep, NONE la hanh dong go", async () => {
  const camXuc = await import(pathToFileURL(path.join(REPO, "lib", "cam-xuc.js")).href);
  assert.deepEqual(camXuc.danhSachChoPhepApp(), ["HEART", "LIKE", "HAHA", "WOW", "CRY", "ANGRY"]);
  for (const ten of camXuc.danhSachChoPhepApp()) {
    assert.equal(typeof camXuc.layBieuTuongApp(ten), "string");
    assert.notEqual(camXuc.layBieuTuongApp(ten), "");
  }
  assert.equal(camXuc.layBieuTuongApp("NONE"), "", "NONE = chuoi rong = go cam xuc");
});

await bai("M2.2", "bieu tuong ngoai danh sach bi tu choi truoc khi cham provider", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1" });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  for (const xau of ["KISS", "SHIT", "/-heart", "", "  ", null, 123]) {
    const loi = await batLoi(() => service.appReactToMessage({ threadId: "peer-1", messageId: "M1", reaction: xau }));
    assert.ok(loi, `phai tu choi: ${String(xau)}`);
    assert.equal(loi.code, "MALFORMED_REQUEST");
  }
  assert.equal(provider.lanGoi("addReaction").length, 0, "khong lan nao cham provider");
});

await bai("M2.3", "trinh duyet KHONG the tu cap dinh danh provider", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1" });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  await service.appReactToMessage({
    threadId: "peer-1",
    messageId: "M1",
    reaction: "HEART",
    // Ke tan cong nhet dinh danh cua tin NGUOI KHAC vao than yeu cau.
    msgId: "TIN-CUA-NGUOI-KHAC",
    cliMsgId: "GIA-MAO",
    identity: { msgId: "TIN-CUA-NGUOI-KHAC", cliMsgId: "GIA-MAO" },
    threadType: 1,
  });
  const [goi] = provider.lanGoi("addReaction");
  assert.equal(goi.args[1].data.msgId, "g-M1", "phai dung dinh danh cua may chu");
  assert.equal(goi.args[1].data.cliMsgId, "c-M1");
  assert.equal(goi.args[1].type, 0, "threadType phai lay tu thread cua may chu, khong tu than yeu cau");
});

await bai("M2.4", "hop dong doi so cho chat rieng va cho nhom", async () => {
  for (const kieu of [0, 1]) {
    const thread = threadGia("t", kieu);
    const message = tinGia({ id: "M1" });
    const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
    await service.appReactToMessage({ threadId: "t", messageId: "M1", reaction: "HAHA" });
    const [goi] = provider.lanGoi("addReaction");
    assert.equal(goi.args[0], ":>", "ma bieu tuong dung cua zca-js 2.1.2");
    assert.deepEqual(Object.keys(goi.args[1]).sort(), ["data", "threadId", "type"]);
    assert.deepEqual(Object.keys(goi.args[1].data).sort(), ["cliMsgId", "msgId"]);
    assert.equal(goi.args[1].threadId, "t");
    assert.equal(goi.args[1].type, kieu);
  }
});

await bai("M2.5", "tha lai / doi / go deu la DUNG MOT lan goi, khong thu lai", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1" });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  await service.appReactToMessage({ threadId: "peer-1", messageId: "M1", reaction: "HEART" });
  await service.appReactToMessage({ threadId: "peer-1", messageId: "M1", reaction: "HEART" });
  await service.appReactToMessage({ threadId: "peer-1", messageId: "M1", reaction: "LIKE" });
  await service.appReactToMessage({ threadId: "peer-1", messageId: "M1", reaction: "NONE" });
  const ds = provider.lanGoi("addReaction");
  assert.equal(ds.length, 4, "bon hanh dong = bon lan goi, khong hon");
  assert.equal(ds[0].args[0], ds[1].args[0], "tha lai dung bieu tuong van chuyen nguyen van cho provider");
  assert.notEqual(ds[2].args[0], ds[0].args[0]);
  assert.equal(ds[3].args[0], "", "NONE gui chuoi rong de go");
});

await bai("M2.6", "provider tu choi thi KHONG tu goi lai", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1" });
  const provider = taoProviderGia({ addReaction: () => Promise.reject(new Error("secret-cookie=abc")) });
  const { service } = await taoDichVu({ deps: depsHanhDong({ thread, message }), provider });
  const loi = await batLoi(() => service.appReactToMessage({ threadId: "peer-1", messageId: "M1", reaction: "HEART" }));
  assert.equal(loi.code, "PROVIDER_REJECTED");
  assert.doesNotMatch(loi.message, /secret-cookie/, "khong lo chi tiet provider ra ngoai");
  assert.equal(provider.lanGoi("addReaction").length, 1, "dung mot lan, khong thu lai");
});

await bai("M2.7", "HTTP thanh cong + su kien listener chi doi trang thai MOT lan", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1" });
  const { service, suKienSocket } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  await service.appReactToMessage({ threadId: "peer-1", messageId: "M1", reaction: "HEART" });
  const sauHttp = suKienSocket.filter((s) => s.event === "message-reaction").length;
  assert.equal(sauHttp, 1);

  // Zalo doi lai chinh cam xuc vua tha.
  const doiLai = service.__ghiNhanCamXucTuProvider(
    { threadId: "peer-1", data: { uidFrom: "owner-A", content: { rMsg: [{ gMsgID: "M1" }], rIcon: "/-heart" } } },
    "owner-A"
  );
  assert.equal(doiLai, false, "su kien lap lai khong duoc coi la thay doi");
  assert.equal(suKienSocket.filter((s) => s.event === "message-reaction").length, sauHttp, "khong phat them");
});

await bai("M2.8", "su kien listener cua NGUOI KHAC van duoc ghi nhan", async () => {
  const { service, suKienSocket } = await taoDichVu();
  const doi = service.__ghiNhanCamXucTuProvider(
    { threadId: "peer-1", data: { uidFrom: "peer-1", content: { rMsg: [{ gMsgID: "M9" }], rIcon: ":>" } } },
    "owner-A"
  );
  assert.equal(doi, true);
  const su = suKienSocket.find((s) => s.event === "message-reaction");
  assert.equal(su.payload.messageId, "M9");
  assert.deepEqual(su.payload.reactions, [{ ten: "HAHA", count: 1, mine: false }]);
});

await bai("M2.9", "danh sach trang cua BOT khong doi (van chi HEART/LIKE)", async () => {
  const camXuc = await import(pathToFileURL(path.join(REPO, "lib", "cam-xuc.js")).href);
  assert.deepEqual(camXuc.danhSachChoPhep(), ["HEART", "LIKE"]);
  for (const ten of ["HAHA", "WOW", "CRY", "ANGRY"]) {
    assert.equal(camXuc.layBieuTuong(ten), null, `bot KHONG duoc dung ${ten}`);
  }
  for (const cau of ["cam on em", "ok em", "buon qua", "haha vui the"]) {
    const chon = camXuc.chonCamXuc(cau);
    assert.ok(chon === null || chon === "HEART" || chon === "LIKE");
  }
});

/* =====================================================================
 * M3 — STICKER
 * ===================================================================== */
group("M3");

await bai("M3.1", "danh muc cong khai chi lo khoa va mo ta, dung 8 sticker", async () => {
  const { service } = await taoDichVu({
    deps: { danhSachSticker: (await import(pathToFileURL(path.join(REPO, "lib", "sticker-zalo.js")).href)).danhSachSticker },
  });
  const ds = service.listAppStickers();
  assert.equal(ds.length, 8, "dung tam sticker da duyet");
  for (const s of ds) {
    assert.deepEqual(Object.keys(s).sort(), ["key", "moTa"]);
    assert.equal(s.id, undefined);
    assert.equal(s.cateId, undefined);
  }
});

await bai("M3.2", "chi khoa trong danh sach duoc gui; id tho bi tu choi", async () => {
  const sticker = await import(pathToFileURL(path.join(REPO, "lib", "sticker-zalo.js")).href);
  const thread = threadGia("peer-1", 0);
  const { service, provider } = await taoDichVu({
    deps: { ...depsHanhDong({ thread, message: tinGia() }), layStickerHopLe: sticker.layStickerHopLe },
  });
  await service.appSendSticker({ threadId: "peer-1", stickerKey: "chao_hoi" });
  assert.equal(provider.lanGoi("sendSticker").length, 1);

  for (const xau of ["25826", 25826, "khong_co", "", null, "__proto__", "toString"]) {
    const loi = await batLoi(() => service.appSendSticker({ threadId: "peer-1", stickerKey: xau }));
    assert.ok(loi, `phai tu choi khoa: ${String(xau)}`);
    assert.equal(loi.code, "MALFORMED_REQUEST");
  }
  assert.equal(provider.lanGoi("sendSticker").length, 1, "khong lan nao lot qua");
});

await bai("M3.3", "hop dong doi so sendSticker cho chat rieng va nhom", async () => {
  const sticker = await import(pathToFileURL(path.join(REPO, "lib", "sticker-zalo.js")).href);
  for (const kieu of [0, 1]) {
    const thread = threadGia("t", kieu);
    const { service, provider } = await taoDichVu({
      deps: { ...depsHanhDong({ thread, message: tinGia() }), layStickerHopLe: sticker.layStickerHopLe },
    });
    await service.appSendSticker({ threadId: "t", stickerKey: "cam_on" });
    const [goi] = provider.lanGoi("sendSticker");
    assert.deepEqual(Object.keys(goi.args[0]).sort(), ["cateId", "id", "type"]);
    assert.equal(goi.args[0].id, 25709);
    assert.equal(goi.args[1], "t");
    assert.equal(goi.args[2], kieu);
  }
});

await bai("M3.4", "self echo chat.sticker duoc giu lai, khong bi loc bo", () => {
  const khoi = ZALO_SRC.slice(ZALO_SRC.indexOf("const supportedSelfTypes"), ZALO_SRC.indexOf("const supportedSelfTypes") + 400);
  assert.match(khoi, /"chat\.sticker"/, "chat.sticker phai nam trong danh sach self type duoc ho tro");
});

await bai("M3.5", "gui sticker KHONG tu ve bong bong thu hai", async () => {
  const sticker = await import(pathToFileURL(path.join(REPO, "lib", "sticker-zalo.js")).href);
  const thread = threadGia("peer-1", 0);
  let soLanGhi = 0;
  const { service, suKienSocket } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread, message: tinGia() }),
      layStickerHopLe: sticker.layStickerHopLe,
      insertMessage: async () => { soLanGhi += 1; return { changes: 1 }; },
    },
  });
  await service.appSendSticker({ threadId: "peer-1", stickerKey: "dong_y" });
  assert.equal(soLanGhi, 0, "khong ghi ban dia phuong; cho echo canonical");
  assert.equal(suKienSocket.filter((s) => s.event === "new-message").length, 0);
});

/* =====================================================================
 * M4 — DANG SOAN TIN
 * ===================================================================== */
group("M4");

await bai("M4.1", "rong -> co chu bao dung mot lan; go tiep trong 3 giay khong bao them", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, []);
  const input = ui.document.querySelector("#message-input");
  const dem = () => ui.goiMang.filter((g) => g.url === "/api/messaging/typing").length;

  input.value = "a";
  input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  await flush();
  assert.equal(dem(), 1, "lan chuyen rong->co chu bao dung mot lan");

  for (const chu of ["ab", "abc", "abcd", "abcde", "abcdef"]) {
    input.value = chu;
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  }
  await flush();
  assert.equal(dem(), 1, "go tiep trong cung nhip 3 giay khong duoc ban them lenh nao");
});

await bai("M4.2", "o soan tin trong lai thi nhip duoc dat lai", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, []);
  const input = ui.document.querySelector("#message-input");
  const dem = () => ui.goiMang.filter((g) => g.url === "/api/messaging/typing").length;

  input.value = "a";
  input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  await flush();
  input.value = "";
  input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  await flush();
  assert.equal(dem(), 1, "o rong khong ban lenh");

  input.value = "b";
  input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  await flush();
  assert.equal(dem(), 2, "rong -> co chu lan nua thi bao lai");
});

await bai("M4.3", "than yeu cau chi co threadId, khong co dinh danh provider", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, []);
  const input = ui.document.querySelector("#message-input");
  input.value = "xin chao";
  input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  await flush();
  const goi = ui.goiMang.find((g) => g.url === "/api/messaging/typing");
  assert.deepEqual(Object.keys(goi.body), ["threadId"]);
});

await bai("M4.4", "loi bao dang soan KHONG chan viec go va gui tin", async () => {
  const ui = await taoGiaoDien();
  ui.datTuyen("POST", "/api/messaging/typing", () => Promise.reject(new Error("mat mang")));
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, []);
  const input = ui.document.querySelector("#message-input");
  input.value = "van go duoc";
  input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  await flush();
  assert.equal(input.value, "van go duoc", "o soan tin khong bi dong bang");
  assert.equal(ui.canhBao.length, 0, "khong lam phien nguoi dung vi mot tin hieu phu");

  ui.document.querySelector("#send-form").dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
  await flush(6);
  assert.ok(ui.goiMang.some((g) => g.url === "/api/send"), "van gui duoc tin");
});

await bai("M4.5", "khong co nut bam thu cong nao cho dang soan tin", () => {
  assert.doesNotMatch(HTML_SRC, /id="btn-[\w-]*typing/i);
  assert.doesNotMatch(HTML_SRC, /Đang soạn|dang soan/i);
});

await bai("M4.6", "hop dong doi so sendTypingEvent cho chat rieng va nhom", async () => {
  for (const kieu of [0, 1]) {
    const thread = threadGia("t", kieu);
    const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message: tinGia() }) });
    await service.appSendTyping({ threadId: "t" });
    const [goi] = provider.lanGoi("sendTypingEvent");
    assert.equal(goi.args[0], "t");
    assert.equal(goi.args[1], kieu);
  }
});

/* =====================================================================
 * M5 — DA XEM
 * ===================================================================== */
group("M5");

await bai("M5.1", "phong bi day du chin truong dung theo zca-js 2.1.2", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: false });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  await service.appMarkSeen({ threadId: "peer-1", messageId: "M1" });
  const [goi] = provider.lanGoi("sendSeenEvent");
  assert.deepEqual(
    Object.keys(goi.args[0]).sort(),
    ["at", "cliMsgId", "cmd", "idTo", "msgId", "msgType", "st", "ts", "uidFrom"]
  );
  assert.equal(goi.args[1], 0);
});

await bai("M5.2", "hinh dang cu (threadId, threadType) KHONG con o bat cu dau", () => {
  // Ghi chu giai thich duong cu VAN duoc phep nhac lai hinh dang do; chi ma
  // chay that moi bi cam. Nen boc het ghi chu ra truoc khi soi.
  const maChay = boGhiChu(ZALO_SRC);
  const goi = [...maChay.matchAll(/sendSeenEvent\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(goi.length, 1, "phai con dung MOT cho goi provider");
  assert.doesNotMatch(goi[0], /threadId/, `sendSeenEvent(${goi[0]}) van truyen threadId`);
  assert.match(goi[0], /phongBi/, "tham so dau phai la phong bi tin nhan");
});

await bai("M5.3", "thieu truong bat buoc thi dung lai, khong bia", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: false });
  delete message.rawJson.data.idTo;
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  const loi = await batLoi(() => service.appMarkSeen({ threadId: "peer-1", messageId: "M1" }));
  assert.equal(loi.code, "ACTION_IDENTITY_UNAVAILABLE");
  assert.equal(provider.lanGoi("sendSeenEvent").length, 0);
});

await bai("M5.4", "tin cua CHINH MINH khong duoc bao da xem", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  const loi = await batLoi(() => service.appMarkSeen({ threadId: "peer-1", messageId: "M1" }));
  assert.equal(loi.code, "ACTION_NOT_APPLICABLE");
  assert.equal(provider.lanGoi("sendSeenEvent").length, 0);
});

await bai("M5.5", "chon cuoc + tab hien + da ve + o day khung -> co bao da xem", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, [
    { id: "A1", threadId: "peer-1", content: "chao", isSelf: false, ts: 1700000000000 },
  ]);
  const goi = ui.goiMang.filter((g) => g.url === "/api/messaging/seen");
  assert.equal(goi.length, 1);
  assert.deepEqual(goi[0].body, { threadId: "peer-1", messageId: "A1" });
});

await bai("M5.6", "TAI VE lich su mot minh KHONG bao da xem", async () => {
  const ui = await taoGiaoDien();
  // Tai lich su cho mot cuoc KHONG duoc chon: dung duong /api/messages/... that.
  ui.datTuyen("GET", "/api/messages/peer-9", () => ({
    ok: true, status: 200,
    json: async () => ({ messages: [{ id: "Z1", threadId: "peer-9", content: "hi", isSelf: false, ts: 1 }] }),
  }));
  await ui.window.fetch("/api/messages/peer-9");
  await flush(6);
  assert.equal(ui.goiMang.filter((g) => g.url === "/api/messaging/seen").length, 0,
    "chi tai lich su thi khong duoc coi la da xem");
});

await bai("M5.7", "tab bi an thi khong bao da xem", async () => {
  const ui = await taoGiaoDien();
  Object.defineProperty(ui.document, "visibilityState", { configurable: true, get: () => "hidden" });
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, [
    { id: "A1", threadId: "peer-1", content: "chao", isSelf: false, ts: 1 },
  ]);
  assert.equal(ui.goiMang.filter((g) => g.url === "/api/messaging/seen").length, 0);
});

await bai("M5.8", "khong o day khung thi khong bao da xem", async () => {
  const ui = await taoGiaoDien();
  const khung = ui.document.querySelector("#messages");
  Object.defineProperty(khung, "scrollHeight", { configurable: true, get: () => 2000 });
  Object.defineProperty(khung, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(khung, "scrollTop", { configurable: true, get: () => 0, set: () => {} });
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, [
    { id: "A1", threadId: "peer-1", content: "chao", isSelf: false, ts: 1 },
  ]);
  assert.equal(ui.goiMang.filter((g) => g.url === "/api/messaging/seen").length, 0,
    "dang doc doan cu o tren thi chua xem tin moi nhat");
});

await bai("M5.9", "that bai la best-effort: khong bao loi, khong thu lai", async () => {
  const ui = await taoGiaoDien();
  ui.datTuyen("POST", "/api/messaging/seen", () => Promise.reject(new Error("mat mang")));
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, [
    { id: "A1", threadId: "peer-1", content: "chao", isSelf: false, ts: 1 },
  ]);
  await flush(8);
  assert.equal(ui.canhBao.length, 0, "khong duoc lam phien nguoi dung");
  assert.equal(ui.goiMang.filter((g) => g.url === "/api/messaging/seen").length, 1, "khong thu lai");
});

await bai("M5.10", "duong BOT dung phong bi day du cho ca chat rieng va nhom", async () => {
  for (const kieu of [0, 1]) {
    const { service, provider } = await taoDichVu({
      deps: { rutDanhTinhProvider: (raw) => (raw?.data ? { ...raw.data } : null) },
    });
    service.__guiDaXemChoTins([tinGia({ id: "B1" }), { ...tinGia({ id: "B2" }), threadType: kieu }], null);
    await flush(4);
    const [goi] = provider.lanGoi("sendSeenEvent");
    assert.ok(goi, "phai co lenh bao da xem");
    assert.equal(goi.args[0].msgId, "g-B2", "lay tin MOI NHAT trong cum");
    assert.equal(goi.args[1], kieu);
  }
});

/* =====================================================================
 * M6 — CHUYEN TIEP
 * ===================================================================== */
group("M6");

await bai("M6.1", "chuyen tiep tin chu toi dung MOT cuoc dich", async () => {
  const nguon = threadGia("peer-1", 0);
  const dich = threadGia("peer-2", 1);
  const message = tinGia({ id: "M1", content: "noi dung goc" });
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_o, id) => (String(id) === "peer-1" ? nguon : String(id) === "peer-2" ? dich : null),
    },
  });
  await service.appForwardMessage({ threadId: "peer-1", messageId: "M1", targetThreadId: "peer-2" });
  const [goi] = provider.lanGoi("forwardMessage");
  assert.deepEqual(goi.args[0], { message: "noi dung goc" }, "chi noi dung chu, khong kem gi khac");
  assert.deepEqual(goi.args[1], ["peer-2"], "dung MOT dich");
  assert.equal(goi.args[2], 1, "threadType lay tu thread dich cua may chu");
  assert.equal(goi.args[0].reference, undefined, "V1 khong gan reference/attribution");
});

await bai("M6.2", "media / sticker / tin da thu hoi deu bi tu choi", async () => {
  const nguon = threadGia("peer-1", 0);
  const dich = threadGia("peer-2", 0);
  for (const kieu of ["chat.photo", "share.file", "chat.sticker", "chat.recalled"]) {
    const message = tinGia({ id: "M1", msgType: kieu, content: "co noi dung" });
    const { service, provider } = await taoDichVu({
      deps: {
        ...depsHanhDong({ thread: nguon, message }),
        getThread: async (_o, id) => (String(id) === "peer-1" ? nguon : String(id) === "peer-2" ? dich : null),
      },
    });
    const loi = await batLoi(() => service.appForwardMessage({ threadId: "peer-1", messageId: "M1", targetThreadId: "peer-2" }));
    assert.equal(loi?.code, "ACTION_NOT_APPLICABLE", `phai tu choi ${kieu}`);
    assert.equal(provider.lanGoi("forwardMessage").length, 0);
  }
});

await bai("M6.3", "nguon phai thuoc chu dang dang nhap", async () => {
  const nguon = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1" });
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async () => nguon,
    },
  });
  const loi = await batLoi(() => service.appForwardMessage({ threadId: "cuoc-cua-nguoi-khac", messageId: "M1", targetThreadId: "peer-1" }));
  assert.equal(loi.code, "NOT_FOUND");
  assert.equal(provider.lanGoi("forwardMessage").length, 0);
});

await bai("M6.4", "dich phai thuoc chu dang dang nhap", async () => {
  const nguon = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1" });
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_o, id) => (String(id) === "peer-1" ? nguon : null),
    },
  });
  const loi = await batLoi(() => service.appForwardMessage({ threadId: "peer-1", messageId: "M1", targetThreadId: "cuoc-la" }));
  assert.equal(loi.code, "NOT_FOUND");
  assert.equal(provider.lanGoi("forwardMessage").length, 0);
});

await bai("M6.5", "Zalo khong nhan tin nao thi KHONG bao thanh cong gia", async () => {
  const nguon = threadGia("peer-1", 0);
  const dich = threadGia("peer-2", 0);
  const message = tinGia({ id: "M1" });
  const provider = taoProviderGia({ forwardMessage: () => Promise.resolve({ success: [], fail: [{ clientId: "c", error_code: "114" }] }) });
  const { service } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_o, id) => (String(id) === "peer-1" ? nguon : dich),
    },
    provider,
  });
  const loi = await batLoi(() => service.appForwardMessage({ threadId: "peer-1", messageId: "M1", targetThreadId: "peer-2" }));
  assert.equal(loi.code, "PROVIDER_REJECTED");
  assert.equal(provider.lanGoi("forwardMessage").length, 1, "khong thu lai");
});

await bai("M6.6", "tin cu thieu cliMsgId van chuyen tiep duoc (V1 chi can noi dung chu)", async () => {
  const nguon = threadGia("peer-1", 0);
  const dich = threadGia("peer-2", 0);
  const message = tinGia({ id: "M1", identity: false, content: "tin cu" });
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_o, id) => (String(id) === "peer-1" ? nguon : dich),
    },
  });
  await service.appForwardMessage({ threadId: "peer-1", messageId: "M1", targetThreadId: "peer-2" });
  assert.equal(provider.lanGoi("forwardMessage").length, 1);
});

function tinCotTextNhungRawLaMedia({ id, kieuProvider, caption }) {
  const message = tinGia({ id, msgType: "text", content: caption });
  message.rawJson.data.msgType = kieuProvider;
  message.rawJson.data.content = kieuProvider === "chat.photo"
    ? { href: "https://fixture.invalid/anh.jpg", description: caption }
    : { href: "https://fixture.invalid/tep.pdf", title: "tep.pdf", description: caption };
  return message;
}

/** Noi CSDL tep tam vao service harness de thu tron vong send/echo/action. */
function depsCsdlMessaging(db) {
  return {
    normalizeIncomingMessage: MESSAGE_UTILS_THAT.normalizeIncomingMessage,
    insertMessage: db.insertMessage,
    upsertThread: db.upsertThread,
    listThreads: db.listThreads,
    getThreadMessages: db.getThreadMessages,
    getThread: db.getThread,
    resolveOwnedActionMessage: db.resolveOwnedActionMessage,
    rutDanhTinhProvider: db.rutDanhTinhProvider,
    markMessageRecalled: db.markMessageRecalled,
    recomputeThreadPreview: db.recomputeThreadPreview,
    deleteLocalMessage: db.deleteLocalMessage,
  };
}

await bai("M6.7", "F2-A text that van forward duoc: incoming direct/group va self-sent", async () => {
  for (const [nhan, threadType, isSelf] of [
    ["incoming-direct", 0, false],
    ["incoming-group", 1, false],
    ["self-text", 0, true],
  ]) {
    const nguon = threadGia(`nguon-${nhan}`, threadType);
    const dich = threadGia(`dich-${nhan}`, threadType === 0 ? 1 : 0);
    const message = tinGia({ id: `T-${nhan}`, isSelf, msgType: "chat.text", content: `text ${nhan}` });
    const { service, provider } = await taoDichVu({
      deps: {
        ...depsHanhDong({ thread: nguon, message }),
        getThread: async (_o, id) => (String(id) === nguon.id ? nguon : String(id) === dich.id ? dich : null),
      },
    });
    await service.appForwardMessage({ threadId: nguon.id, messageId: message.id, targetThreadId: dich.id });
    assert.equal(provider.lanGoi("forwardMessage").length, 1, `${nhan} phai forward dung mot lan`);
  }
});

await bai("M6.8", "F2-B cot text nhung raw provider la image bi tu choi", async () => {
  const nguon = threadGia("peer-image", 0);
  const dich = threadGia("peer-target", 0);
  const message = tinCotTextNhungRawLaMedia({ id: "IMG1", kieuProvider: "chat.photo", caption: "caption anh" });
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_o, id) => (String(id) === nguon.id ? nguon : String(id) === dich.id ? dich : null),
    },
  });
  const loi = await batLoi(() => service.appForwardMessage({ threadId: nguon.id, messageId: message.id, targetThreadId: dich.id }));
  assert.equal(loi?.code, "ACTION_NOT_APPLICABLE");
  assert.equal(provider.lanGoi("forwardMessage").length, 0, "anh khong duoc forward caption-only");
});

await bai("M6.9", "F2-C cot text nhung raw provider la file bi tu choi", async () => {
  const nguon = threadGia("peer-file", 0);
  const dich = threadGia("peer-target", 0);
  const message = tinCotTextNhungRawLaMedia({ id: "FILE1", kieuProvider: "share.file", caption: "caption tep" });
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_o, id) => (String(id) === nguon.id ? nguon : String(id) === dich.id ? dich : null),
    },
  });
  const loi = await batLoi(() => service.appForwardMessage({ threadId: nguon.id, messageId: message.id, targetThreadId: dich.id }));
  assert.equal(loi?.code, "ACTION_NOT_APPLICABLE");
  assert.equal(provider.lanGoi("forwardMessage").length, 0, "tep khong duoc forward caption-only");
});

await bai("M6.10", "F2-D/E moi media contradiction deu chan provider du co caption", async () => {
  const provider = taoProviderGia();
  for (const [kieuProvider, id] of [["chat.photo", "IMG2"], ["share.file", "FILE2"]]) {
    const nguon = threadGia(`nguon-${id}`, 0);
    const dich = threadGia(`dich-${id}`, 1);
    const message = tinCotTextNhungRawLaMedia({ id, kieuProvider, caption: "caption khong bien media thanh text" });
    const { service } = await taoDichVu({
      provider,
      deps: {
        ...depsHanhDong({ thread: nguon, message }),
        getThread: async (_o, threadId) => (String(threadId) === nguon.id ? nguon : String(threadId) === dich.id ? dich : null),
      },
    });
    const loi = await batLoi(() => service.appForwardMessage({ threadId: nguon.id, messageId: message.id, targetThreadId: dich.id }));
    assert.equal(loi?.code, "ACTION_NOT_APPLICABLE");
  }
  assert.equal(provider.lanGoi("forwardMessage").length, 0, "B/C khong duoc cham provider");
});

await bai("M6.11", "F1 DB that co lap thread/message giua hai owner", async () => {
  const { db } = await moCsdlTam();
  const OWNER_A = "OWNER_A";
  const OWNER_B = "OWNER_B";
  await db.upsertThread(OWNER_A, { id: "thread-a", threadType: 0, title: "A" });
  await db.insertMessage(OWNER_A, {
    id: "msg-a", threadId: "thread-a", threadType: 0, content: "tin cua A",
    isSelf: false, msgType: "text", ts: 1000,
    rawJson: { data: { msgId: "msg-a", cliMsgId: "cli-a", uidFrom: "sender-a", idTo: OWNER_A, msgType: "text" } },
  });
  await db.upsertThread(OWNER_B, { id: "thread-b", threadType: 0, title: "B" });
  await db.insertMessage(OWNER_B, {
    id: "msg-b", threadId: "thread-b", threadType: 0, content: "tin cua B",
    isSelf: false, msgType: "text", ts: 1001,
    rawJson: { data: { msgId: "msg-b", cliMsgId: "cli-b", uidFrom: "sender-b", idTo: OWNER_B, msgType: "text" } },
  });

  const cuaA = await db.resolveOwnedActionMessage(OWNER_A, "thread-a", "msg-a");
  const threadNgoaiCuaB = await db.resolveOwnedActionMessage(OWNER_B, "thread-a", "msg-a");
  const messageNgoaiCuaB = await db.resolveOwnedActionMessage(OWNER_B, "thread-b", "msg-a");

  assert.equal(cuaA.ok, true, "OWNER_A doc duoc tin cua chinh minh");
  assert.deepEqual(threadNgoaiCuaB, { ok: false, code: "NOT_FOUND" }, "OWNER_B khong thay thread cua A");
  assert.deepEqual(messageNgoaiCuaB, { ok: false, code: "NOT_FOUND" }, "OWNER_B khong thay message cua A trong thread cua B");
});

/* =====================================================================
 * M7 — THU HOI
 * ===================================================================== */
group("M7");

await bai("M7.1", "chi thu hoi duoc tin CUA CHINH MINH", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: false });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  const loi = await batLoi(() => service.appUndoMessage({ threadId: "peer-1", messageId: "M1" }));
  assert.equal(loi.code, "ACTION_NOT_APPLICABLE");
  assert.equal(provider.lanGoi("undo").length, 0);
});

await bai("M7.2", "hop dong doi so undo cho chat rieng va nhom", async () => {
  for (const kieu of [0, 1]) {
    const thread = threadGia("t", kieu);
    const message = tinGia({ id: "M1", isSelf: true });
    const { service, provider } = await taoDichVu({
      deps: { ...depsHanhDong({ thread, message }), markMessageRecalled: async () => true },
    });
    await service.appUndoMessage({ threadId: "t", messageId: "M1" });
    const [goi] = provider.lanGoi("undo");
    assert.deepEqual(Object.keys(goi.args[0]).sort(), ["cliMsgId", "msgId"]);
    assert.equal(goi.args[0].msgId, "g-M1");
    assert.equal(goi.args[1], "t");
    assert.equal(goi.args[2], kieu);
  }
});

await bai("M7.3", "Zalo thanh cong -> doi trang thai cuc bo va tinh lai dong tom tat", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  const daDoi = [];
  const tinhLai = [];
  const { service, suKienSocket } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread, message }),
      markMessageRecalled: async (owner, threadId, msgId, nhan) => { daDoi.push({ owner, threadId, msgId, nhan }); return true; },
      recomputeThreadPreview: async (owner, threadId) => { tinhLai.push({ owner, threadId }); return { id: threadId }; },
    },
  });
  await service.appUndoMessage({ threadId: "peer-1", messageId: "M1" });
  assert.equal(daDoi.length, 1);
  assert.equal(daDoi[0].nhan, service.NHAN_TIN_DA_THU_HOI);
  assert.equal(tinhLai.length, 1, "dong tom tat phai duoc tinh lai");
  assert.equal(suKienSocket.filter((s) => s.event === "message-recalled").length, 1);
});

await bai("M7.4", "Zalo tu choi -> KHONG dong vao du lieu cuc bo", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  let daDoi = 0;
  const provider = taoProviderGia({ undo: () => Promise.reject(new Error("tu choi")) });
  const { service, suKienSocket } = await taoDichVu({
    deps: { ...depsHanhDong({ thread, message }), markMessageRecalled: async () => { daDoi += 1; return true; } },
    provider,
  });
  const loi = await batLoi(() => service.appUndoMessage({ threadId: "peer-1", messageId: "M1" }));
  assert.equal(loi.code, "PROVIDER_REJECTED");
  assert.equal(daDoi, 0, "khong duoc doi trang thai khi Zalo chua nhan");
  assert.equal(suKienSocket.filter((s) => s.event === "message-recalled").length, 0);
  assert.equal(provider.lanGoi("undo").length, 1, "khong thu lai");
});

await bai("M7.5", "HTTP + su kien undo cua listener chi doi trang thai MOT lan", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  let conDoiDuoc = true;
  const { service, suKienSocket } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread, message }),
      // Giong SQL that: chi doi dong CHUA o trang thai thu hoi.
      markMessageRecalled: async () => { const truoc = conDoiDuoc; conDoiDuoc = false; return truoc; },
    },
  });
  await service.appUndoMessage({ threadId: "peer-1", messageId: "M1" });
  await service.__ghiNhanThuHoiTuProvider(
    { threadId: "peer-1", data: { msgId: "undo-action", content: { globalMsgId: "M1", cliMsgId: 7 } } },
    "owner-A"
  );
  assert.equal(suKienSocket.filter((s) => s.event === "message-recalled").length, 1, "chi mot lan doi trang thai");
});

await bai("M7.6", "su kien undo lay globalMsgId (tin bi thu hoi), khong lay msgId cua hanh dong", async () => {
  const daDoi = [];
  const { service } = await taoDichVu({
    deps: { markMessageRecalled: async (_o, _t, msgId) => { daDoi.push(String(msgId)); return true; } },
  });
  await service.__ghiNhanThuHoiTuProvider(
    { threadId: "peer-1", data: { msgId: "HANH-DONG-999", content: { globalMsgId: "TIN-GOC-1", cliMsgId: 7 } } },
    "owner-A"
  );
  assert.deepEqual(daDoi, ["TIN-GOC-1"]);
});

await bai("M7.7", "tin da thu hoi thi khong thu hoi lai duoc", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true, msgType: "chat.recalled" });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  const loi = await batLoi(() => service.appUndoMessage({ threadId: "peer-1", messageId: "M1" }));
  assert.equal(loi.code, "ACTION_NOT_APPLICABLE");
  assert.equal(provider.lanGoi("undo").length, 0);
});

await bai("M7.8", "khong co duong thu lai tu dong nao trong wrapper thu hoi", () => {
  const batDau = ZALO_SRC.indexOf("export async function recallMessage");
  const than = ZALO_SRC.slice(batDau, ZALO_SRC.indexOf("\n}", batDau));
  assert.doesNotMatch(than, /for\s*\(|while\s*\(|setTimeout|retry|thuLai/i);
});

/* =====================================================================
 * M8 — XOA O PHIA TOI
 * ===================================================================== */
group("M8");

await bai("M8.1", "onlyMe=true dong cung trong ma nguon", () => {
  const maChay = boGhiChu(ZALO_SRC);
  const batDau = maChay.indexOf("export async function deleteMessageForSelf");
  const than = maChay.slice(batDau, maChay.indexOf("\nexport ", batDau + 10));
  assert.match(than, /,\s*true\s*\);/, "tham so onlyMe phai la hang true ngay tai cho goi");
  assert.doesNotMatch(than, /onlyMe/, "ma chay khong duoc nhan onlyMe tu ben ngoai");
  // Chu ky ham cung khong duoc mo mot duong nao de truyen onlyMe vao.
  assert.match(than, /deleteMessageForSelf\(\{ identity, threadId, threadType \}/);
});

await bai("M8.2", "onlyMe=false la KHONG THE, du than yeu cau co gui", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  const { service, provider } = await taoDichVu({
    deps: { ...depsHanhDong({ thread, message }), deleteLocalMessage: async () => true },
  });
  await service.appDeleteMessageForMe({ threadId: "peer-1", messageId: "M1", onlyMe: false });
  const [goi] = provider.lanGoi("deleteMessage");
  assert.equal(goi.args[1], true, "luon la true");
  assert.equal(provider.goi.filter((g) => g.ten === "deleteMessage" && g.args[1] === false).length, 0);
  // Khong route nao doc onlyMe tu than yeu cau.
  assert.doesNotMatch(SERVER_SRC, /onlyMe\s*[,}]/, "server khong duoc rut onlyMe tu req.body");
});

await bai("M8.3", "hop dong doi so deleteMessage cho chat rieng va nhom", async () => {
  for (const kieu of [0, 1]) {
    const thread = threadGia("t", kieu);
    const message = tinGia({ id: "M1", isSelf: true });
    const { service, provider } = await taoDichVu({
      deps: { ...depsHanhDong({ thread, message }), deleteLocalMessage: async () => true },
    });
    await service.appDeleteMessageForMe({ threadId: "t", messageId: "M1" });
    const [goi] = provider.lanGoi("deleteMessage");
    assert.deepEqual(Object.keys(goi.args[0]).sort(), ["data", "threadId", "type"]);
    assert.deepEqual(Object.keys(goi.args[0].data).sort(), ["cliMsgId", "msgId", "uidFrom"]);
    assert.equal(goi.args[0].type, kieu);
    assert.equal(goi.args[1], true);
  }
});

await bai("M8.4", "Zalo TRUOC, CSDL SAU", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  const thuTu = [];
  const provider = taoProviderGia({ deleteMessage: () => { thuTu.push("provider"); return Promise.resolve({ status: 0 }); } });
  const { service } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread, message }),
      deleteLocalMessage: async () => { thuTu.push("csdl"); return true; },
      recomputeThreadPreview: async () => { thuTu.push("tom-tat"); return { id: "peer-1" }; },
    },
    provider,
  });
  await service.appDeleteMessageForMe({ threadId: "peer-1", messageId: "M1" });
  assert.deepEqual(thuTu, ["provider", "csdl", "tom-tat"]);
});

await bai("M8.5", "Zalo tu choi -> dong du lieu van con nguyen", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  let daXoa = 0;
  const provider = taoProviderGia({ deleteMessage: () => Promise.reject(new Error("tu choi")) });
  const { service, suKienSocket } = await taoDichVu({
    deps: { ...depsHanhDong({ thread, message }), deleteLocalMessage: async () => { daXoa += 1; return true; } },
    provider,
  });
  const loi = await batLoi(() => service.appDeleteMessageForMe({ threadId: "peer-1", messageId: "M1" }));
  assert.equal(loi.code, "PROVIDER_REJECTED");
  assert.equal(daXoa, 0, "Zalo chua xoa thi CSDL khong duoc dong vao");
  assert.equal(suKienSocket.filter((s) => s.event === "message-deleted").length, 0);
  assert.equal(provider.lanGoi("deleteMessage").length, 1, "khong thu lai");
});

await bai("M8.6", "dong tom tat duoc tinh lai tu tin CON LAI moi nhat", async () => {
  const { db } = await moCsdlTam();
  await db.upsertThread("owner-A", { id: "peer-1", threadType: 0, lastMessage: "tin moi", lastMessageAt: 3000 });
  await db.insertMessage("owner-A", { id: "m1", threadId: "peer-1", content: "tin cu", isSelf: false, msgType: "text", ts: 1000, rawJson: null });
  await db.insertMessage("owner-A", { id: "m2", threadId: "peer-1", content: "tin moi", isSelf: true, msgType: "text", ts: 3000, rawJson: null });

  await db.deleteLocalMessage("owner-A", "peer-1", "m2");
  const thread = await db.recomputeThreadPreview("owner-A", "peer-1");
  assert.equal(thread.lastMessage, "tin cu");
  assert.equal(thread.lastMessageAt, 1000);
});

await bai("M8.7", "khong duong nao xoa ca hai dau", () => {
  assert.doesNotMatch(ZALO_SRC, /deleteMessage\([^)]*,\s*false\s*\)/);
  assert.doesNotMatch(SERVER_SRC, /deleteMessage/);
});

/* =====================================================================
 * M9 — PARSELINK
 * ===================================================================== */
group("M9");

await bai("M9.1", "khong route cong khai nao goi parseLink", () => {
  assert.doesNotMatch(SERVER_SRC, /parseLink|parseMessageLink/i);
  assert.doesNotMatch(APP_SRC, /parseLink/i);
  assert.doesNotMatch(HTML_SRC, /parse.?link/i);
});

await bai("M9.2", "wrapper chi nhan http/https", async () => {
  const { service, provider } = await taoDichVu();
  for (const xau of ["file:///etc/passwd", "ftp://a.b/c", "javascript:alert(1)", "//a.b", "a.b", ""]) {
    const loi = await batLoi(() => service.parseMessageLink(xau));
    assert.equal(loi?.code, "MALFORMED_REQUEST", `phai chan: ${xau}`);
  }
  await service.parseMessageLink("https://vizen.vn/a");
  assert.equal(provider.lanGoi("parseLink").length, 1);
});

await bai("M9.3", "hanh vi gui link cu khong doi", () => {
  assert.match(ZALO_SRC, /const link = coThemGi \? null : timLinkChinh\(cleanText\)/);
  assert.match(ZALO_SRC, /api\.sendLink\(\s*\{ link: link\.duongDan/);
  const tim = ZALO_SRC.slice(ZALO_SRC.indexOf("export function timLinkChinh"));
  assert.match(tim, /tim\.length !== 1/, "luat mot link duy nhat giu nguyen");
});

/* =====================================================================
 * M10 — MOT BIEN GIOI PROVIDER DUY NHAT
 * ===================================================================== */
group("M10");

const HAM_PROVIDER = [
  "addReaction", "sendSticker", "sendTypingEvent", "sendSeenEvent",
  "undo", "deleteMessage", "forwardMessage", "parseLink",
];

await bai("M10.1", "chi lib/zalo-service.js duoc cham cac ham provider nay", () => {
  const nguonKhac = fs.readdirSync(path.join(REPO, "lib"))
    .filter((f) => f.endsWith(".js") && f !== "zalo-service.js")
    .map((f) => ({ f, s: fs.readFileSync(path.join(REPO, "lib", f), "utf8") }));
  for (const ham of HAM_PROVIDER) {
    const mau = new RegExp(`\\.${ham}\\s*\\(`);
    assert.doesNotMatch(SERVER_SRC, mau, `server.js khong duoc goi ${ham} truc tiep`);
    assert.doesNotMatch(APP_SRC, mau, `public/app.js khong duoc goi ${ham} truc tiep`);
    for (const { f, s } of nguonKhac) assert.doesNotMatch(s, mau, `lib/${f} khong duoc goi ${ham} truc tiep`);
  }
});

await bai("M10.2", "moi ham provider duoc goi tai DUNG MOT cho trong zalo-service", () => {
  for (const ham of HAM_PROVIDER) {
    const soLan = [...ZALO_SRC.matchAll(new RegExp(`(?:ownerApi|api)\\??\\.${ham}\\s*\\(`, "g"))].length;
    assert.equal(soLan, 1, `${ham} phai co dung mot diem goi provider, dang co ${soLan}`);
  }
});

await bai("M10.3", "duong tu dong cua BOT dung chung wrapper voi duong nguoi dung", () => {
  const thaCamXuc = ZALO_SRC.slice(ZALO_SRC.indexOf("async function thuThaCamXuc"), ZALO_SRC.indexOf("/* --- STICKER --- */"));
  assert.match(thaCamXuc, /await reactToMessage\(/, "bot tha cam xuc qua wrapper");
  const guiSticker = ZALO_SRC.slice(ZALO_SRC.indexOf("async function thuGuiSticker"));
  assert.match(guiSticker.slice(0, 2000), /await sendStickerMessage\(/, "bot gui sticker qua wrapper");
  const goPhim = ZALO_SRC.slice(ZALO_SRC.indexOf("function batDauGoPhim"), ZALO_SRC.indexOf("/* --- LINK CO ANH XEM TRUOC --- */"));
  assert.match(goPhim, /sendTypingSignal\(/, "bot bao dang soan qua wrapper");
  const cumTin = ZALO_SRC.slice(ZALO_SRC.indexOf("async function traLoiCumTin"));
  assert.match(cumTin.slice(0, 3000), /guiDaXemChoTins\(tins/, "bot bao da xem qua duong phong bi day du");
});

await bai("M10.4", "chi mot the hien Zalo runtime trong ca ung dung", () => {
  const soZalo = [...ZALO_SRC.matchAll(/new Zalo\(/g)].length;
  assert.equal(soZalo, 1);
  const libs = fs.readdirSync(path.join(REPO, "lib")).filter((f) => f.endsWith(".js") && f !== "zalo-service.js");
  for (const f of libs) {
    const s = fs.readFileSync(path.join(REPO, "lib", f), "utf8");
    assert.doesNotMatch(s, /from "zca-js"[\s\S]{0,200}new Zalo\(/, `lib/${f} khong duoc tu tao runtime Zalo`);
  }
  assert.doesNotMatch(SERVER_SRC, /from "zca-js"/, "server.js khong import thang zca-js");
});

await bai("M10.5", "moi wrapper deu kiem quyen runtime va khong tu thu lai", () => {
  const wrappers = [
    "reactToMessage", "sendStickerMessage", "sendTypingSignal", "markMessageSeen",
    "recallMessage", "deleteMessageForSelf", "forwardStoredMessage", "parseMessageLink",
  ];
  for (const ten of wrappers) {
    const batDau = ZALO_SRC.indexOf(`export async function ${ten}`);
    assert.ok(batDau > 0, `thieu wrapper ${ten}`);
    const than = ZALO_SRC.slice(batDau, batDau + 2200);
    assert.match(than, /chotApiSan\(/, `${ten} phai chot runtime truoc khi goi provider`);
    assert.doesNotMatch(than.slice(0, than.indexOf("\n}\n")), /setTimeout|setInterval/, `${ten} khong duoc hen gio thu lai`);
  }
});

/* =====================================================================
 * M11 — RANH GIOI API
 * ===================================================================== */
group("M11");

await bai("M11.1", "than yeu cau sai dang bi tu choi truoc khi cham provider", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  const truong = [
    () => service.appReactToMessage({}),
    () => service.appReactToMessage({ threadId: "peer-1" }),
    () => service.appSendSticker({ threadId: "peer-1" }),
    () => service.appSendTyping({}),
    () => service.appMarkSeen({ threadId: "peer-1" }),
    () => service.appUndoMessage({ threadId: "peer-1" }),
    () => service.appDeleteMessageForMe({ threadId: "peer-1" }),
    () => service.appForwardMessage({ threadId: "peer-1", messageId: "M1" }),
  ];
  for (const goi of truong) {
    const loi = await batLoi(goi);
    assert.ok(loi, "phai nem loi");
    assert.ok(["MALFORMED_REQUEST", "NOT_FOUND", "ACTION_IDENTITY_UNAVAILABLE", "ACTION_NOT_APPLICABLE"].includes(loi.code),
      `ma loi la ${loi.code}`);
  }
  assert.equal(provider.goi.length, 0, "khong lenh nao lot xuong provider");
});

await bai("M11.2", "cuoc tro chuyen / tin cua NGUOI KHAC deu la NOT_FOUND", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  for (const goi of [
    () => service.appReactToMessage({ threadId: "cuoc-la", messageId: "M1", reaction: "HEART" }),
    () => service.appReactToMessage({ threadId: "peer-1", messageId: "tin-la", reaction: "HEART" }),
    () => service.appUndoMessage({ threadId: "peer-1", messageId: "tin-la" }),
    () => service.appDeleteMessageForMe({ threadId: "cuoc-la", messageId: "M1" }),
    () => service.appSendSticker({ threadId: "cuoc-la", stickerKey: "chao_hoi" }),
    () => service.appSendTyping({ threadId: "cuoc-la" }),
  ]) {
    const loi = await batLoi(goi);
    assert.equal(loi.code, "NOT_FOUND");
  }
  assert.equal(provider.goi.length, 0);
});

await bai("M11.3", "runtime doi giua chung -> ZALO_RUNTIME_CHANGED, khong gui nham bang tai khoan moi", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  const quyen = service.captureRuntimeAuthority();
  service.__logoutRuntime();
  const loi = await batLoi(() => service.appReactToMessage({ threadId: "peer-1", messageId: "M1", reaction: "HEART" }, quyen));
  assert.equal(loi.code, "ZALO_RUNTIME_CHANGED");
  assert.equal(provider.goi.length, 0);
});

await bai("M11.4", "loi provider duoc lam sach truoc khi ra trinh duyet", async () => {
  const thread = threadGia("peer-1", 0);
  const message = tinGia({ id: "M1", isSelf: true });
  const ban = "zpw_sek=SECRET; cookie=abc; at /app/lib/zalo-service.js:123";
  for (const [ten, goi] of [
    ["addReaction", (s) => s.appReactToMessage({ threadId: "peer-1", messageId: "M1", reaction: "HEART" })],
    ["undo", (s) => s.appUndoMessage({ threadId: "peer-1", messageId: "M1" })],
    ["deleteMessage", (s) => s.appDeleteMessageForMe({ threadId: "peer-1", messageId: "M1" })],
  ]) {
    const provider = taoProviderGia({ [ten]: () => Promise.reject(new Error(ban)) });
    const { service } = await taoDichVu({ deps: depsHanhDong({ thread, message }), provider });
    const loi = await batLoi(() => goi(service));
    assert.equal(loi.code, "PROVIDER_REJECTED");
    for (const cam of ["zpw_sek", "SECRET", "cookie", "zalo-service.js:123"]) {
      assert.ok(!String(loi.message).includes(cam), `loi lo "${cam}"`);
    }
  }
});

await bai("M11.5", "moi route messaging deu chup quyen runtime truoc ranh gioi async", () => {
  const tuyen = SERVER_SRC.slice(SERVER_SRC.indexOf("function tuyenMessaging"), SERVER_SRC.indexOf("app.get(\"/api/messaging/stickers\""));
  assert.match(tuyen, /const capturedRuntimeAuthority = captureRuntimeAuthority\(\);/);
  assert.match(tuyen, /await handler\(req\.body \|\| \{\}, capturedRuntimeAuthority\)/);
});

await bai("M11.6", "bang ma loi -> ma HTTP day du va on dinh", () => {
  for (const ma of ["MALFORMED_REQUEST", "NOT_FOUND", "ACTION_NOT_APPLICABLE",
    "ACTION_IDENTITY_UNAVAILABLE", "ZALO_RUNTIME_CHANGED", "PROVIDER_REJECTED", "INTERNAL_ERROR"]) {
    assert.match(SERVER_SRC, new RegExp(ma), `thieu ma loi ${ma}`);
  }
  const bang = SERVER_SRC.slice(SERVER_SRC.indexOf("const MA_HTTP_THEO_LOI"), SERVER_SRC.indexOf("function traLoiThatBai"));
  assert.match(bang, /NOT_FOUND:\s*404/);
  assert.match(bang, /MALFORMED_REQUEST:\s*400/);
  assert.match(bang, /PROVIDER_REJECTED:\s*502/);
});

/* =====================================================================
 * M12 — INBOX MAY TINH
 * ===================================================================== */
group("M12");

const TIN_MAU = [
  { id: "A1", threadId: "peer-1", content: "khach chao", isSelf: false, msgType: "text", ts: 1700000000000 },
  { id: "B1", threadId: "peer-1", content: "minh dap", isSelf: true, msgType: "text", ts: 1700000001000 },
];

await bai("M12.1", "moi bong bong co nut thao tac rieng, khong dung nut ba cham cua hoi thoai", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  const nut = ui.document.querySelectorAll("#messages .bubble-wrap > .msg-action-trigger");
  assert.equal(nut.length, 2, "moi tin mot nut");
  assert.equal(nut[0].getAttribute("aria-label"), "Thao tác với tin nhắn");
  assert.equal(ui.document.querySelector("#btn-chat-more").disabled, true, "ba cham hoi thoai van tro");
});

await bai("M12.2", "bang chon cam xuc co dung sau lua chon, kem nhan doc duoc", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  ui.document.querySelectorAll(".msg-action-trigger")[0].click();
  await flush();
  const chon = [...ui.document.querySelectorAll("#msg-action-reactions .msg-reaction-option")];
  assert.deepEqual(chon.map((n) => n.dataset.reaction), ["HEART", "LIKE", "HAHA", "WOW", "CRY", "ANGRY"]);
  for (const n of chon) assert.ok(n.getAttribute("aria-label"), "moi lua chon phai co nhan doc duoc");
  assert.equal(ui.document.querySelector("#msg-action-sheet").classList.contains("hidden"), false);
});

await bai("M12.3", "bam mot bieu tuong -> dung mot lenh, kem dung ba truong", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  ui.document.querySelectorAll(".msg-action-trigger")[0].click();
  await flush();
  ui.document.querySelector('[data-reaction="HAHA"]').click();
  await flush(6);
  const goi = ui.goiMang.filter((g) => g.url === "/api/messaging/reaction");
  assert.equal(goi.length, 1);
  assert.deepEqual(goi[0].body, { threadId: "peer-1", messageId: "A1", reaction: "HAHA" });
  assert.equal(ui.document.querySelector("#msg-action-sheet").classList.contains("hidden"), true);
});

await bai("M12.4", "nut Bo cam xuc chi hien khi minh dang co cam xuc", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  ui.document.querySelectorAll(".msg-action-trigger")[0].click();
  await flush();
  const nhan = () => [...ui.document.querySelectorAll(".msg-action-item")].map((n) => n.textContent);
  assert.ok(!nhan().includes("Bỏ cảm xúc"));

  ui.socketHandlers.get("message-reaction")({
    threadId: "peer-1", messageId: "A1", reactions: [{ ten: "HEART", count: 1, mine: true }],
  });
  await flush();
  ui.document.querySelectorAll(".msg-action-trigger")[0].click();
  await flush();
  assert.ok(nhan().includes("Bỏ cảm xúc"));
});

await bai("M12.5", "cam xuc tu socket duoc ve thanh chip", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  ui.socketHandlers.get("message-reaction")({
    threadId: "peer-1", messageId: "A1", reactions: [{ ten: "HAHA", count: 2, mine: false }],
  });
  await flush();
  const chip = ui.document.querySelector("#messages .msg-reactions .msg-reaction-chip");
  assert.ok(chip);
  assert.match(chip.textContent, /😂\s*2/);
});

await bai("M12.6", "sticker: bang chon dung tam sticker, gui bang KHOA", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  ui.document.querySelector("#btn-chat-sticker").click();
  await flush(6);
  const chon = [...ui.document.querySelectorAll("#sticker-picker .sticker-option")];
  assert.equal(chon.length, 2, "ve theo danh muc may chu tra ve");
  chon[0].click();
  await flush(6);
  const goi = ui.goiMang.filter((g) => g.url === "/api/messaging/sticker");
  assert.deepEqual(goi[0].body, { threadId: "peer-1", stickerKey: "chao_hoi" });
  assert.equal(ui.document.querySelector("#sticker-picker").classList.contains("hidden"), true);
});

await bai("M12.7", "chuyen tiep: chon dung MOT dich tu danh muc hien co", async () => {
  const ui = await taoGiaoDien();
  const danhMuc = [
    { id: "peer-1", threadType: 0, title: "Khach" },
    { id: "peer-2", threadType: 1, title: "Nhom Ke Toan" },
  ];
  await ui.chonCuocTroChuyen(danhMuc[0], TIN_MAU, danhMuc);
  ui.document.querySelectorAll(".msg-action-trigger")[0].click();
  await flush();
  [...ui.document.querySelectorAll(".msg-action-item")].find((n) => n.textContent === "Chuyển tiếp").click();
  await flush();
  assert.equal(ui.document.querySelector("#forward-dialog").classList.contains("hidden"), false);

  const muc = [...ui.document.querySelectorAll("#forward-list .forward-item")];
  assert.ok(muc.length >= 2);
  muc.find((n) => n.textContent === "Nhom Ke Toan").click();
  await flush(6);
  const goi = ui.goiMang.filter((g) => g.url === "/api/messaging/forward");
  assert.equal(goi.length, 1, "mot lan bam = mot dich");
  assert.deepEqual(goi[0].body, { threadId: "peer-1", messageId: "A1", targetThreadId: "peer-2" });
});

await bai("M12.8", "thu hoi va xoa deu phai xac nhan; bam Huy thi khong goi gi", async () => {
  const ui = await taoGiaoDien();
  ui.datTraLoiXacNhan(false);
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  ui.document.querySelectorAll(".msg-action-trigger")[1].click();
  await flush();
  [...ui.document.querySelectorAll(".msg-action-item")].find((n) => n.textContent === "Thu hồi").click();
  await flush(4);
  assert.equal(ui.hoiXacNhan.length, 1);
  assert.match(ui.hoiXacNhan[0], /Thu hồi/);
  assert.equal(ui.goiMang.filter((g) => g.url === "/api/messaging/undo").length, 0, "Huy thi khong goi");

  ui.document.querySelectorAll(".msg-action-trigger")[1].click();
  await flush();
  [...ui.document.querySelectorAll(".msg-action-item")].find((n) => n.textContent === "Xóa ở phía tôi").click();
  await flush(4);
  assert.equal(ui.hoiXacNhan.length, 2);
  assert.equal(ui.goiMang.filter((g) => g.url === "/api/messaging/delete").length, 0);
});

await bai("M12.9", "Thu hoi chi hien tren tin CUA MINH", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  const nhanCuaTin = async (chiSo) => {
    ui.document.querySelectorAll(".msg-action-trigger")[chiSo].click();
    await flush();
    return [...ui.document.querySelectorAll(".msg-action-item")].map((n) => n.textContent);
  };
  assert.ok(!(await nhanCuaTin(0)).includes("Thu hồi"), "tin cua khach: khong co Thu hoi");
  assert.ok((await nhanCuaTin(1)).includes("Thu hồi"), "tin cua minh: co Thu hoi");
});

await bai("M12.10", "tin da thu hoi hien dong thay the va mat cac hanh dong khong con hop le", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  ui.socketHandlers.get("message-recalled")({
    threadId: "peer-1", messageId: "B1", content: "Tin nhắn đã được thu hồi", msgType: "chat.recalled",
  });
  await flush();
  const bong = [...ui.document.querySelectorAll("#messages .bubble")];
  const daThuHoi = bong.find((n) => n.classList.contains("bubble-recalled"));
  assert.ok(daThuHoi, "phai co bong bong da thu hoi");
  assert.match(daThuHoi.textContent, /Tin nhắn đã được thu hồi/);
  assert.equal(daThuHoi.querySelector(".recalled-note").tagName, "EM");

  ui.document.querySelectorAll(".msg-action-trigger")[1].click();
  await flush();
  const nhan = [...ui.document.querySelectorAll(".msg-action-item")].map((n) => n.textContent);
  assert.ok(!nhan.includes("Thu hồi"), "khong thu hoi lai duoc");
  assert.ok(!nhan.includes("Chuyển tiếp"), "khong chuyen tiep tin da thu hoi");
  assert.equal(ui.document.querySelectorAll("#msg-action-reactions .msg-reaction-option").length, 0);
});

await bai("M12.11", "xoa o phia toi: dong bien mat khoi khung chat", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  assert.equal(ui.document.querySelectorAll("#messages .bubble-row").length, 2);
  ui.socketHandlers.get("message-deleted")({ threadId: "peer-1", messageId: "B1" });
  await flush();
  assert.equal(ui.document.querySelectorAll("#messages .bubble-row").length, 1);
});

await bai("M12.12", "hop dong UI-A cu con nguyen sau khi them thao tac tin", async () => {
  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  assert.equal(ui.document.querySelectorAll(".bubble-wrap > .bubble-time").length, 0,
    "gio tin van nam trong bubble, khong tran ra bubble-wrap");
  assert.equal(ui.document.querySelectorAll("#chat-file-input").length, 1);
  assert.ok(ui.document.querySelector("#btn-chat-image"));
  assert.ok(ui.document.querySelector("#btn-chat-attach"));
  assert.equal(ui.document.querySelector("#btn-chat-image").textContent.trim(), "");
  assert.equal(ui.document.querySelector("#btn-chat-attach").getAttribute("aria-label"), "Tệp");
  // Thanh cong cu Anh/Tep giu nguyen thu tu nguon da duyet.
  assert.match(HTML_SRC, /id="message-input"[\s\S]*?id="btn-chat-image"[\s\S]*?id="btn-chat-attach"[\s\S]*?id="btn-chat-send"/);
});

/* =====================================================================
 * M13 — INBOX DIEN THOAI
 * ===================================================================== */
group("M13");

await bai("M13.1", "dien thoai: van co nut thao tac rieng cho tung tin", async () => {
  const ui = await taoGiaoDien({ mobile: true });
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  assert.equal(ui.document.querySelectorAll("#messages .msg-action-trigger").length, 2);
});

await bai("M13.2", "mo ra la sheet duoi day, khong dat toa do kieu may tinh", async () => {
  const ui = await taoGiaoDien({ mobile: true });
  await ui.chonCuocTroChuyen({ id: "peer-1", threadType: 0, title: "Khach" }, TIN_MAU);
  ui.document.querySelectorAll(".msg-action-trigger")[0].click();
  await flush();
  const sheet = ui.document.querySelector("#msg-action-sheet");
  assert.equal(sheet.classList.contains("hidden"), false);
  assert.equal(sheet.style.top, "", "tren dien thoai vi tri do CSS lo, khong gan inline");
  assert.equal(sheet.style.left, "");
  assert.equal(ui.document.querySelector("#msg-action-backdrop").classList.contains("hidden"), false);
});

await bai("M13.3", "CSS 760 bien lop thanh sheet duoi day", () => {
  const khoi = CSS_SRC.slice(CSS_SRC.lastIndexOf("@media (max-width: 760px)"));
  assert.match(khoi, /\.msg-action-sheet\s*\{[\s\S]*?position:\s*fixed[\s\S]*?bottom:\s*0/);
  assert.match(khoi, /\.msg-action-trigger\s*\{[\s\S]*?opacity:\s*1/, "khong co hover thi nut phai hien san");
});

await bai("M13.4", "nut ba cham tren dau hoi thoai KHONG bi trung dung", () => {
  assert.doesNotMatch(APP_SRC, /btn-chat-more|chat-more-button/);
  assert.match(HTML_SRC, /id="btn-chat-more"[\s\S]{0,240}?disabled/);
});

await bai("M13.5", "diem gay 760 va hinh hoc composer da duyet giu nguyen", () => {
  assert.match(CSS_SRC, /\.send-input-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto auto/);
  assert.match(CSS_SRC, /@media \(max-width: 760px\)[\s\S]*?\.send-button\s*\{[\s\S]*?min-width:\s*64px/);
  assert.match(CSS_SRC, /\.chat-image\s*\{[\s\S]*?max-width:[\s\S]*?max-height:[\s\S]*?object-fit:\s*contain/);
  // Nut sticker de len o soan tin, KHONG them cot thu nam vao luoi composer.
  const mobile = CSS_SRC.slice(CSS_SRC.indexOf("@media (max-width: 760px)"));
  assert.match(mobile, /\.send-form\s*\{[\s\S]*?grid-template-columns:\s*44px 44px minmax\(0, 1fr\) 44px/);
});

/* =====================================================================
 * M14 — KHONG DOI LUOC DO CSDL
 * ===================================================================== */
group("M14");

/** Doc luoc do THAT tu tep, bang node:sqlite - khong can seam nao trong production. */
function docLuocDoTuTep(tep) {
  const conn = new DatabaseSync(tep, { readOnly: true });
  try {
    const bang = conn.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r) => r.name);
    const luocDo = {};
    for (const ten of bang) {
      luocDo[ten] = conn.prepare(`PRAGMA table_info(${ten})`).all().map((c) => c.name);
    }
    return luocDo;
  } finally {
    conn.close();
  }
}

/**
 * So sanh LUOC DO THAT do initDb dung len, giua ban GOC (blob cua base commit)
 * va ban hien tai. Manh hon soi ma nguon: mot cot them bang duong nao cung bi bat.
 */
async function luocDoThucTe(nguonDbJs, nhan) {
  const goc = path.join(THU_MUC_TAM, `schema-${nhan}`);
  fs.mkdirSync(path.join(goc, "data"), { recursive: true });
  fs.mkdirSync(path.join(goc, "lib", "migrations"), { recursive: true });
  for (const tep of fs.readdirSync(path.join(REPO, "lib"))) {
    const tuNguon = path.join(REPO, "lib", tep);
    if (fs.statSync(tuNguon).isDirectory()) continue;
    fs.copyFileSync(tuNguon, path.join(goc, "lib", tep));
  }
  for (const tep of fs.readdirSync(path.join(REPO, "lib", "migrations"))) {
    fs.copyFileSync(path.join(REPO, "lib", "migrations", tep), path.join(goc, "lib", "migrations", tep));
  }
  fs.writeFileSync(path.join(goc, "lib", "db.js"), nguonDbJs);

  const truoc = process.cwd();
  process.chdir(goc);
  try {
    const db = await import(`${pathToFileURL(path.join(goc, "lib", "db.js")).href}?schema=${nhan}`);
    await db.initDb();
    return docLuocDoTuTep(path.join(goc, "data", "zalo.db"));
  } finally {
    process.chdir(truoc);
  }
}

await bai("M14.1", "bang messages giu dung 10 cot va dung khoa danh tinh", async () => {
  const { thuMuc } = await moCsdlTam();
  const luocDo = docLuocDoTuTep(path.join(thuMuc, "data", "zalo.db"));
  assert.deepEqual(luocDo.messages, [
    "id", "thread_id", "content", "is_self", "sender_id", "sender_name",
    "sender_avatar", "msg_type", "ts", "raw_json",
  ]);
  assert.deepEqual(luocDo.threads, [
    "local_id", "owner_uid", "remote_thread_id", "thread_type", "title", "avatar",
    "bot_enabled", "last_message", "last_message_at", "updated_at",
  ]);
  const khoi = DB_SRC.slice(DB_SRC.indexOf("CREATE TABLE IF NOT EXISTS messages"));
  assert.match(khoi.slice(0, 900), /PRIMARY KEY \(thread_id, id\)/, "khoa danh tinh giu nguyen");
});

await bai("M14.2", "luoc do THAT chi them threads.bot_enabled, khong bang/cot nao khac", async () => {
  const nguonGoc = docTepTaiBase("lib/db.js");
  const luocDoGoc = await luocDoThucTe(nguonGoc, "goc");
  const { thuMuc } = await moCsdlTam();
  const luocDoNay = docLuocDoTuTep(path.join(thuMuc, "data", "zalo.db"));
  assert.deepEqual(
    Object.keys(luocDoNay).sort(),
    Object.keys(luocDoGoc).sort(),
    "khong duoc them hay bot bang nao"
  );
  for (const bang of Object.keys(luocDoGoc)) {
    if (bang === "threads") {
      assert.equal(
        luocDoNay.threads.filter((cot) => cot === "bot_enabled").length,
        1,
        "threads phai them dung mot cot bot_enabled"
      );
      assert.deepEqual(
        luocDoNay.threads.filter((cot) => cot !== "bot_enabled"),
        luocDoGoc.threads,
        "ngoai bot_enabled, threads phai y nguyen base"
      );
      continue;
    }
    assert.deepEqual(luocDoNay[bang], luocDoGoc[bang], `bang ${bang} bi doi cot`);
  }
  const migrationGoc = spawnSync("git", ["ls-tree", "--name-only", BASE_SHA, "lib/migrations/"], {
    cwd: REPO, encoding: "utf8",
  }).stdout.split(String.fromCharCode(10)).map((d) => d.trim()).filter(Boolean).map((d) => path.basename(d)).sort();
  const migrationNay = fs.readdirSync(path.join(REPO, "lib", "migrations")).sort();
  assert.deepEqual(migrationNay, migrationGoc, "khong duoc them hay bot tep migration nao");
});

/* =====================================================================
 * M15 — HOI QUY CUA BOT
 * ===================================================================== */
group("M15");

await bai("M15.1", "bot van chi tha HEART/LIKE va van di qua chot chan cu", async () => {
  const camXuc = await import(pathToFileURL(path.join(REPO, "lib", "cam-xuc.js")).href);
  const thread = threadGia("peer-1", 0);
  const { service, provider } = await taoDichVu({
    deps: {
      chonCamXuc: () => "HAHA",           // gia su co nguoi sua chonCamXuc
      layBieuTuong: camXuc.layBieuTuong,   // chot chan that
      layMaTin: () => ({ msgId: "g1", cliMsgId: "c1" }),
      getThread: async () => thread,
    },
  });
  const daTha = await service.__thuThaCamXuc({ content: "haha", threadId: "peer-1", threadType: 0 });
  assert.equal(daTha, false, "bieu tuong ngoai danh sach trang cua bot bi chan");
  assert.equal(provider.lanGoi("addReaction").length, 0);
});

await bai("M15.2", "bot tha HEART hop le van goi provider dung mot lan, dung hop dong", async () => {
  const camXuc = await import(pathToFileURL(path.join(REPO, "lib", "cam-xuc.js")).href);
  const thread = threadGia("peer-1", 0);
  const { service, provider } = await taoDichVu({
    deps: {
      chonCamXuc: () => "HEART",
      layBieuTuong: camXuc.layBieuTuong,
      layMaTin: () => ({ msgId: "g1", cliMsgId: "c1" }),
      getThread: async () => thread,
    },
  });
  const daTha = await service.__thuThaCamXuc({ content: "cam on em", threadId: "peer-1", threadType: 0 });
  assert.equal(daTha, true);
  const [goi] = provider.lanGoi("addReaction");
  assert.equal(goi.args[0], "/-heart");
  assert.deepEqual(goi.args[1].data, { msgId: "g1", cliMsgId: "c1" });
});

await bai("M15.3", "chinh sach sticker cua bot khong doi: chi 1-1, van qua danh sach trang", async () => {
  const sticker = await import(pathToFileURL(path.join(REPO, "lib", "sticker-zalo.js")).href);
  const thread = threadGia("nhom-1", 1);
  const { service, provider } = await taoDichVu({
    deps: {
      chonTinhHuong: () => "chao_hoi",
      layStickerHopLe: sticker.layStickerHopLe,
      getThread: async () => thread,
    },
  });
  await service.__thuGuiSticker({ content: "chao em", threadId: "nhom-1", threadType: 1 });
  assert.equal(provider.lanGoi("sendSticker").length, 0, "trong NHOM bot van khong gui sticker");
  assert.match(STICKER_SRC, /searchSticker\(\) tim trong kho/, "ghi chu chinh sach cu con nguyen");
  assert.equal(sticker.danhSachSticker().length, 8, "van dung tam sticker");
});

await bai("M15.4", "nhip bao dang soan cua bot giu nguyen 3000ms", () => {
  assert.match(ZALO_SRC, /const NHAC_GO_PHIM_MS = 3000;/);
  const goPhim = ZALO_SRC.slice(ZALO_SRC.indexOf("function batDauGoPhim"), ZALO_SRC.indexOf("/* --- LINK CO ANH XEM TRUOC --- */"));
  assert.match(goPhim, /setInterval\(nhac, NHAC_GO_PHIM_MS\)/, "van nhac lai theo dong ho cu");
});

await bai("M15.5", "khong cong cu LLM moi, va Bot khong he cham thu hoi/xoa", () => {
  const adminSrc = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
  const aiSrc = fs.readFileSync(path.join(REPO, "lib", "ai-chat.js"), "utf8");
  for (const [ten, s] of [["admin-command", adminSrc], ["ai-chat", aiSrc]]) {
    for (const cam of ["recallMessage", "deleteMessageForSelf", "appUndoMessage", "appDeleteMessageForMe",
      "forwardStoredMessage", "appForwardMessage", "undo(", "deleteMessage("]) {
      assert.ok(!s.includes(cam), `lib/${ten}.js khong duoc cham ${cam}`);
    }
  }
});

/* =====================================================================
 * M16 — PHAM VI PHU DINH
 * ===================================================================== */
group("M16");

await bai("M16.1", "khong endpoint chay ham Zalo tuy y", () => {
  assert.doesNotMatch(SERVER_SRC, /\/api\/zca/i);
  const tuyen = [...SERVER_SRC.matchAll(/app\.(get|post|put|delete)\("([^"]+)"/g)].map((m) => m[2]);
  for (const t of tuyen.filter((x) => x.startsWith("/api/messaging"))) {
    assert.ok(
      ["/api/messaging/stickers", "/api/messaging/reaction", "/api/messaging/sticker",
        "/api/messaging/typing", "/api/messaging/seen", "/api/messaging/undo",
        "/api/messaging/delete", "/api/messaging/forward"].includes(t),
      `tuyen ngoai pham vi: ${t}`
    );
  }
  // Khong tuyen nao nhan ten ham / phuong thuc provider tu than yeu cau.
  assert.doesNotMatch(SERVER_SRC, /req\.body\??\.\s*(method|fn|apiMethod|zaloMethod)/);
});

await bai("M16.2", "khong mo kho sticker: khong searchSticker / getStickers", () => {
  for (const s of [SERVER_SRC, APP_SRC, ZALO_SRC]) {
    assert.doesNotMatch(s, /searchSticker/);
    assert.doesNotMatch(s, /\bgetStickers\b/);
  }
  // getStickersDetail cu cua lib/sticker.js chi de hien anh sticker DA NHAN, giu nguyen.
  assert.match(fs.readFileSync(path.join(REPO, "lib", "sticker.js"), "utf8"), /getStickersDetail/);
});

await bai("M16.3", "khong THEM phu thuoc nao vao getGroupChatHistory (provider tra 404)", () => {
  // lib/chat-history.js da goi ham nay TU TRUOC goi tin nay va khong doi. Cam o
  // day la cam THEM cho phu thuoc moi, khong phai doi kien truc lich su cu.
  const dem = (s) => [...String(s).matchAll(/getGroupChatHistory/g)].length;
  assert.equal(
    dem(fs.readFileSync(path.join(REPO, "lib", "chat-history.js"), "utf8")),
    dem(docTepTaiBase("lib/chat-history.js")),
    "so lan dung trong chat-history.js phai y nguyen ban goc"
  );
  for (const f of fs.readdirSync(path.join(REPO, "lib")).filter((x) => x.endsWith(".js") && x !== "chat-history.js")) {
    assert.equal(dem(fs.readFileSync(path.join(REPO, "lib", f), "utf8")), 0, `lib/${f}`);
  }
  assert.equal(dem(SERVER_SRC), 0);
  assert.equal(dem(APP_SRC), 0);
  // Khong hanh dong moi nao xay quanh ham 404 do.
  const moi = ZALO_SRC.slice(ZALO_SRC.indexOf("BIEN GIOI PROVIDER CANONICAL"));
  assert.equal(dem(moi), 0);
});

await bai("M16.4", "khong khung nan / hang doi / thu lai / quyen han moi duoc them", () => {
  const moi = ZALO_SRC.slice(ZALO_SRC.indexOf("BIEN GIOI PROVIDER CANONICAL"));
  for (const cam of ["Queue", "RetryPolicy", "PermissionManager", "EventBus", "createStore"]) {
    assert.ok(!moi.includes(cam), `khong duoc them ${cam}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["zca-js"], "^2.1.2", "khong doi phien ban zca-js");
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    "bcryptjs", "express", "express-session", "markitdown-ts", "multer",
    "nodemailer", "socket.io", "sqlite3", "zca-js",
  ], "khong them phu thuoc moi");
});

await bai("M16.5", "khong lo enum cam xuc cua Zalo ra trinh duyet", () => {
  for (const ma of ["/-heart", "/-strong", ":-h", "/-shit", "/-rose", ":-*"]) {
    assert.ok(!APP_SRC.includes(ma), `public/app.js lo ma provider ${ma}`);
    assert.ok(!HTML_SRC.includes(ma), `index.html lo ma provider ${ma}`);
  }
  assert.doesNotMatch(APP_SRC, /from "zca-js"|\bReactions\.[A-Z]/);
  const camXucUi = APP_SRC.slice(APP_SRC.indexOf("const CAM_XUC_APP"), APP_SRC.indexOf("const BIEU_TUONG_THEO_TEN"));
  assert.equal([...camXucUi.matchAll(/ten:\s*"/g)].length, 6, "giao dien chi biet dung sau bieu tuong");
});

await bai("M16.6", "khong xay tinh nang xem truoc link / quan ly chua doc / ghim / luu tru", () => {
  const congKhai = ["app.js", "index.html", "style.css"]
    .map((f) => fs.readFileSync(path.join(REPO, "public", f), "utf8")).join("\n");
  assert.doesNotMatch(congKhai, /unreadCount|markAsRead|lastReadAt/);
  for (const cam of ["link-preview", "linkPreview", "pinMessage", "archiveThread", "muteThread"]) {
    assert.ok(!congKhai.includes(cam), `khong duoc xay ${cam}`);
  }
});

/* =====================================================================
 * T1..T9 — UAT BLOCKER FIX 01
 * ===================================================================== */

const SO_BAI_CU = results.length;

function echoWebchat({ id, threadId, threadType, content = "tin tu gui" }) {
  return {
    threadId: String(threadId),
    type: Number(threadType),
    isSelf: true,
    data: {
      msgId: String(id),
      cliMsgId: `cli-${id}`,
      uidFrom: "owner-A",
      idTo: String(threadId),
      msgType: "webchat",
      content,
      st: 1,
      at: 2,
      cmd: 501,
      ts: "1700000010000",
    },
  };
}

async function taoVongDoiSelf({ threadType = 0, thuTu = "local-first", khongCoMsgId = false } = {}) {
  const { db } = await moCsdlTam();
  const threadId = threadType === 1 ? "group-self" : "direct-self";
  const targetId = `${threadId}-target`;
  const messageId = `${threadType}-${thuTu}-${khongCoMsgId ? "echo-only" : "with-id"}`;
  const content = `noi dung ${messageId}`;
  await db.upsertThread("owner-A", { id: threadId, threadType, title: "Nguon" });
  await db.upsertThread("owner-A", { id: targetId, threadType: threadType === 1 ? 0 : 1, title: "Dich" });

  const echo = echoWebchat({ id: messageId, threadId, threadType, content });
  let provider;
  let groupHistoryCalls = 0;
  provider = taoProviderGia({
    sendMessage: async () => {
      if (thuTu === "echo-first") {
        await provider.listenerHandlers.get("message")(echo);
      }
      return khongCoMsgId ? { message: null } : { message: { msgId: messageId } };
    },
  });
  provider.getGroupChatHistory = async () => {
    groupHistoryCalls += 1;
    throw new Error("group history seam must stay unused");
  };

  const { service, suKienSocket } = await taoDichVu({
    provider,
    deps: depsCsdlMessaging(db),
  });
  service.__setupListenerForTest();

  const sendResult = await service.sendChatMessage({ threadId, threadType, text: content });
  const rowsAfterSend = await db.getThreadMessages("owner-A", threadId, 50);
  if (thuTu === "local-first" || khongCoMsgId) {
    await provider.listenerHandlers.get("message")(echo);
  }
  const rows = await db.getThreadMessages("owner-A", threadId, 50);
  const resolution = await db.resolveOwnedActionMessage("owner-A", threadId, messageId);
  return {
    db,
    service,
    provider,
    suKienSocket,
    threadId,
    targetId,
    messageId,
    content,
    sendResult,
    rowsAfterSend,
    rows,
    resolution,
    groupHistoryCalls: () => groupHistoryCalls,
  };
}

function ketThucKhoiNgoac(source, viTriMo) {
  let doSau = 0;
  for (let i = viTriMo; i < source.length; i += 1) {
    if (source[i] === "{") doSau += 1;
    else if (source[i] === "}") {
      doSau -= 1;
      if (doSau === 0) return i + 1;
    }
  }
  throw new Error("Khoi CSS khong dong ngoac");
}

function cacKhoiMobile760() {
  const blocks = [];
  const re = /@media\s*\(max-width:\s*760px\)\s*\{/g;
  for (const match of CSS_SRC.matchAll(re)) {
    const open = CSS_SRC.indexOf("{", match.index);
    const end = ketThucKhoiNgoac(CSS_SRC, open);
    blocks.push({ start: match.index, end, body: CSS_SRC.slice(open + 1, end - 1) });
  }
  return blocks;
}

function quyTacMessageInput() {
  return [...CSS_SRC.matchAll(/\.chat-panel #message-input\s*\{([^}]*)\}/g)]
    .map((match) => ({ index: match.index, body: match[1] }));
}

group("T1");

await bai("T1a", "webchat chu incoming direct hien Forward va goi wrapper mot lan", async () => {
  const nguon = threadGia("webchat-direct", 0);
  const dich = threadGia("webchat-direct-target", 1);
  const message = tinGia({ id: "W-D", msgType: "webchat", content: "webchat direct" });
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_owner, id) => (String(id) === nguon.id ? nguon : String(id) === dich.id ? dich : null),
    },
  });
  await service.appForwardMessage({ threadId: nguon.id, messageId: message.id, targetThreadId: dich.id });
  assert.equal(provider.lanGoi("forwardMessage").length, 1);

  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen(nguon, [{ ...message, threadId: nguon.id }]);
  ui.document.querySelector(".msg-action-trigger").click();
  assert.ok([...ui.document.querySelectorAll(".msg-action-item")].some((node) => node.textContent === "Chuyển tiếp"));
});

await bai("T1b", "webchat chu incoming group hien Forward va goi wrapper mot lan", async () => {
  const nguon = threadGia("webchat-group", 1);
  const dich = threadGia("webchat-group-target", 0);
  const message = tinGia({ id: "W-G", msgType: "webchat", content: "webchat group" });
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_owner, id) => (String(id) === nguon.id ? nguon : String(id) === dich.id ? dich : null),
    },
  });
  await service.appForwardMessage({ threadId: nguon.id, messageId: message.id, targetThreadId: dich.id });
  assert.equal(provider.lanGoi("forwardMessage").length, 1);

  const ui = await taoGiaoDien();
  await ui.chonCuocTroChuyen(nguon, [{ ...message, threadId: nguon.id }]);
  ui.document.querySelector(".msg-action-trigger").click();
  assert.ok([...ui.document.querySelectorAll(".msg-action-item")].some((node) => node.textContent === "Chuyển tiếp"));
});

await bai("T1c", "webchat co provider content object bi chan fail-closed", async () => {
  const nguon = threadGia("webchat-object", 0);
  const dich = threadGia("webchat-object-target", 0);
  const message = tinGia({ id: "W-O", msgType: "webchat", content: "caption" });
  message.rawJson.data.content = { href: "https://fixture.invalid/media.jpg", description: "caption" };
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_owner, id) => (String(id) === nguon.id ? nguon : dich),
    },
  });
  const error = await batLoi(() => service.appForwardMessage({ threadId: nguon.id, messageId: message.id, targetThreadId: dich.id }));
  assert.equal(error?.code, "ACTION_NOT_APPLICABLE");
  assert.equal(provider.lanGoi("forwardMessage").length, 0);
});

await bai("T1d", "stored text nhung raw chat.photo bi chan fail-closed", async () => {
  const nguon = threadGia("raw-photo", 0);
  const dich = threadGia("raw-photo-target", 1);
  const message = tinCotTextNhungRawLaMedia({ id: "W-P", kieuProvider: "chat.photo", caption: "caption" });
  const { service, provider } = await taoDichVu({
    deps: {
      ...depsHanhDong({ thread: nguon, message }),
      getThread: async (_owner, id) => (String(id) === nguon.id ? nguon : dich),
    },
  });
  const error = await batLoi(() => service.appForwardMessage({ threadId: nguon.id, messageId: message.id, targetThreadId: dich.id }));
  assert.equal(error?.code, "ACTION_NOT_APPLICABLE");
  assert.equal(provider.lanGoi("forwardMessage").length, 0);
});

await bai("T1e", "frontend va backend dong y dung ba kieu text, unknown bi chan", async () => {
  const backend = ZALO_SRC.match(/const KIEU_TIN_CHUYEN_TIEP_DUOC = new Set\(\[([^\]]+)\]\)/);
  const frontend = APP_SRC.match(/if \(!\[([^\]]+)\]\.includes\(message\.msgType\)\) return false/);
  assert.ok(backend && frontend);
  const tach = (source) => [...source.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(tach(backend[1]), ["text", "chat.text", "webchat"]);
  assert.deepEqual(tach(frontend[1]), ["text", "chat.text", "webchat"]);

  const ui = await taoGiaoDien();
  const messages = ["text", "chat.text", "webchat", "unknown"].map((msgType, index) => ({
    id: `F-${index}`, threadId: "predicate", msgType, content: "co chu", isSelf: false, ts: 1700000000000 + index,
  }));
  await ui.chonCuocTroChuyen(threadGia("predicate", 0), messages);
  const triggers = ui.document.querySelectorAll(".msg-action-trigger");
  for (let i = 0; i < triggers.length; i += 1) {
    triggers[i].click();
    const coForward = [...ui.document.querySelectorAll(".msg-action-item")].some((node) => node.textContent === "Chuyển tiếp");
    assert.equal(coForward, i < 3, `${messages[i].msgType} co forward sai`);
  }
});

group("T2");

await bai("T2", "local-first direct duoc enrich webchat, mot dong va mot bong bong", async () => {
  const ctx = await taoVongDoiSelf({ threadType: 0, thuTu: "local-first" });
  assert.equal(ctx.rows.length, 1);
  assert.equal(ctx.rows[0].msgType, "text");
  assert.equal(ctx.rows[0].rawJson?.data?.msgType, "webchat");
  assert.equal(ctx.resolution.ok, true);
  assert.equal(ctx.resolution.identity.cliMsgId, `cli-${ctx.messageId}`);
  assert.equal(ctx.suKienSocket.filter((event) => event.event === "new-message").length, 1);
  await ctx.service.appForwardMessage({ threadId: ctx.threadId, messageId: ctx.messageId, targetThreadId: ctx.targetId });
  assert.equal(ctx.provider.lanGoi("forwardMessage").length, 1);
});

group("T2B");

await bai("T2B", "echo-first direct giu msg_type webchat, khong trung dong hay socket", async () => {
  const ctx = await taoVongDoiSelf({ threadType: 0, thuTu: "echo-first" });
  assert.equal(ctx.rows.length, 1);
  assert.equal(ctx.rows[0].msgType, "webchat");
  assert.equal(ctx.resolution.ok, true);
  assert.equal(ctx.suKienSocket.filter((event) => event.event === "new-message").length, 1);
  await ctx.service.appForwardMessage({ threadId: ctx.threadId, messageId: ctx.messageId, targetThreadId: ctx.targetId });
  assert.equal(ctx.provider.lanGoi("forwardMessage").length, 1);
});

group("T2C");

await bai("T2C", "send khong co msgId khong ghi placeholder; self echo tao tin duy nhat", async () => {
  const ctx = await taoVongDoiSelf({ threadType: 0, thuTu: "local-first", khongCoMsgId: true });
  assert.equal(ctx.sendResult, null);
  assert.equal(ctx.rowsAfterSend.length, 0, "khong co msgId thi local path khong ghi dong");
  assert.equal(ctx.rows.length, 1);
  assert.equal(ctx.rows[0].id, ctx.messageId);
  assert.equal(ctx.rows[0].msgType, "webchat");
  assert.equal(ctx.resolution.ok, true);
  assert.equal(ctx.suKienSocket.filter((event) => event.event === "new-message").length, 1);
  await ctx.service.appForwardMessage({ threadId: ctx.threadId, messageId: ctx.messageId, targetThreadId: ctx.targetId });
  assert.equal(ctx.provider.lanGoi("forwardMessage").length, 1);
});

group("T3");

await bai("T3", "self group webchat enrich tu echo, khong can group history", async () => {
  const ctx = await taoVongDoiSelf({ threadType: 1, thuTu: "local-first" });
  assert.equal(ctx.rows.length, 1);
  assert.equal(ctx.rows[0].msgType, "text");
  assert.equal(ctx.rows[0].rawJson?.data?.msgType, "webchat");
  assert.equal(ctx.resolution.ok, true);
  assert.equal(ctx.groupHistoryCalls(), 0);
  assert.equal(ctx.suKienSocket.filter((event) => event.event === "new-message").length, 1);
  await ctx.service.appForwardMessage({ threadId: ctx.threadId, messageId: ctx.messageId, targetThreadId: ctx.targetId });
  assert.equal(ctx.provider.lanGoi("forwardMessage").length, 1);
});

group("T4");

for (const threadType of [0, 1]) {
  await bai(`T4${threadType === 0 ? "a" : "b"}`, `undo self ${threadType === 0 ? "direct" : "group"} sau enrich goi mot lan`, async () => {
    const ctx = await taoVongDoiSelf({ threadType, thuTu: "local-first" });
    await ctx.service.appUndoMessage({ threadId: ctx.threadId, messageId: ctx.messageId });
    assert.equal(ctx.provider.lanGoi("undo").length, 1);
  });
}

await bai("T4c", "undo thieu identity van fail-closed, provider zero", async () => {
  const thread = threadGia("undo-no-id", 0);
  const message = tinGia({ id: "UNDO-NO-ID", isSelf: true, identity: false });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  const error = await batLoi(() => service.appUndoMessage({ threadId: thread.id, messageId: message.id }));
  assert.equal(error?.code, "ACTION_IDENTITY_UNAVAILABLE");
  assert.equal(provider.lanGoi("undo").length, 0);
});

group("T5");

for (const threadType of [0, 1]) {
  await bai(`T5${threadType === 0 ? "a" : "b"}`, `delete-for-me self ${threadType === 0 ? "direct" : "group"} sau enrich chi onlyMe=true`, async () => {
    const ctx = await taoVongDoiSelf({ threadType, thuTu: "local-first" });
    await ctx.service.appDeleteMessageForMe({ threadId: ctx.threadId, messageId: ctx.messageId });
    const calls = ctx.provider.lanGoi("deleteMessage");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], true);
    assert.equal((await ctx.db.getThreadMessages("owner-A", ctx.threadId, 50)).length, 0);
  });
}

await bai("T5c", "delete-for-me thieu identity fail-closed va khong co onlyMe=false", async () => {
  const thread = threadGia("delete-no-id", 0);
  const message = tinGia({ id: "DELETE-NO-ID", isSelf: true, identity: false });
  const { service, provider } = await taoDichVu({ deps: depsHanhDong({ thread, message }) });
  const error = await batLoi(() => service.appDeleteMessageForMe({ threadId: thread.id, messageId: message.id }));
  assert.equal(error?.code, "ACTION_IDENTITY_UNAVAILABLE");
  assert.equal(provider.lanGoi("deleteMessage").length, 0);
  assert.doesNotMatch(boGhiChu(ZALO_SRC), /deleteMessage\([^)]*,\s*false\s*\)/);
});

group("T6");

await bai("T6a", "desktop flip/clamp dung he toa do chat-panel va gioi han menu cao", async () => {
  const ui = await taoGiaoDien();
  Object.defineProperty(ui.window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(ui.window, "innerWidth", { configurable: true, value: 1280 });
  await ui.chonCuocTroChuyen(threadGia("desktop-geometry", 0), [
    { id: "G1", threadId: "desktop-geometry", msgType: "text", content: "x", isSelf: false, ts: 1 },
  ]);
  const panel = ui.document.querySelector("#chat-panel");
  const trigger = ui.document.querySelector(".msg-action-trigger");
  const sheet = ui.document.querySelector("#msg-action-sheet");
  panel.getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 100, right: 1100, width: 1000, height: 600 });
  let anchorRect = { top: 650, bottom: 674, left: 1064, right: 1088, width: 24, height: 24 };
  let naturalHeight = 300;
  trigger.getBoundingClientRect = () => anchorRect;
  sheet.getBoundingClientRect = () => {
    const max = Number.parseFloat(sheet.style.maxHeight);
    const height = Number.isFinite(max) ? Math.min(naturalHeight, max) : naturalHeight;
    return { top: 0, bottom: height, left: 0, right: 240, width: 240, height };
  };

  trigger.click();
  const flippedTop = Number.parseFloat(sheet.style.top);
  assert.ok(flippedTop < anchorRect.top - 100, "anchor sat day phai lat menu len tren");
  assert.ok(flippedTop >= 8 && flippedTop + 300 <= 592);
  assert.ok(Number.parseFloat(sheet.style.left) >= 8);
  assert.ok(Number.parseFloat(sheet.style.left) + 240 <= 992);

  anchorRect = { top: 300, bottom: 324, left: 102, right: 110, width: 8, height: 24 };
  trigger.click();
  assert.equal(Number.parseFloat(sheet.style.left), 8, "tran ngang ben trai trong he panel");

  naturalHeight = 900;
  anchorRect = { top: 650, bottom: 674, left: 500, right: 524, width: 24, height: 24 };
  trigger.click();
  assert.equal(sheet.style.maxHeight, "584px");
  assert.equal(sheet.style.overflowY, "auto");
  const tallTop = Number.parseFloat(sheet.style.top);
  assert.ok(tallTop >= 8 && tallTop + 584 <= 592);
});

await bai("T6b", "mobile khong nhan inline top/left cua desktop", async () => {
  const ui = await taoGiaoDien({ mobile: true });
  await ui.chonCuocTroChuyen(threadGia("mobile-no-inline", 0), [
    { id: "GM", threadId: "mobile-no-inline", msgType: "text", content: "x", isSelf: false, ts: 1 },
  ]);
  ui.document.querySelector(".msg-action-trigger").click();
  const sheet = ui.document.querySelector("#msg-action-sheet");
  assert.equal(sheet.style.top, "");
  assert.equal(sheet.style.left, "");
});

group("T7");

await bai("T7", "trigger absolute, touch expansion chi o mobile va binding dung message", async () => {
  const baseTrigger = CSS_SRC.match(/\.msg-action-trigger\s*\{([^}]*)\}/);
  assert.match(baseTrigger?.[1] || "", /position:\s*absolute/);
  const mobileBlocks = cacKhoiMobile760();
  const pseudoIndex = CSS_SRC.indexOf(".msg-action-trigger::before");
  assert.ok(pseudoIndex >= 0);
  const touchBlock = mobileBlocks.find((block) => pseudoIndex > block.start && pseudoIndex < block.end);
  assert.ok(touchBlock, "touch expansion phai nam trong media 760");
  assert.match(touchBlock.body, /\.msg-action-trigger::before\s*\{[\s\S]*?inset:\s*-8px/);
  assert.match(touchBlock.body, /\.msg-action-trigger\s*\{[\s\S]*?opacity:\s*1/);
  assert.equal((CSS_SRC.match(/\.msg-action-trigger::before/g) || []).length, 1);

  const ui = await taoGiaoDien({ mobile: true });
  await ui.chonCuocTroChuyen(threadGia("binding", 0), TIN_MAU.map((message) => ({ ...message, threadId: "binding" })));
  const triggers = ui.document.querySelectorAll(".msg-action-trigger");
  assert.deepEqual([...triggers].map((node) => node.dataset.messageId), ["A1", "B1"]);
  triggers[1].click();
  [...ui.document.querySelectorAll(".msg-action-item")]
    .find((node) => node.textContent === "Xóa ở phía tôi").click();
  await flush(6);
  const callsB = ui.goiMang.filter((call) => call.url === "/api/messaging/delete");
  assert.deepEqual(callsB.map((call) => call.body.messageId), ["B1"], "trigger B phai thay binding A");

  const uiA = await taoGiaoDien({ mobile: true });
  await uiA.chonCuocTroChuyen(threadGia("binding-a", 0), TIN_MAU.map((message) => ({ ...message, threadId: "binding-a" })));
  uiA.document.querySelectorAll(".msg-action-trigger")[0].click();
  [...uiA.document.querySelectorAll(".msg-action-item")]
    .find((node) => node.textContent === "Xóa ở phía tôi").click();
  await flush(6);
  const callsA = uiA.goiMang.filter((call) => call.url === "/api/messaging/delete");
  assert.deepEqual(callsA.map((call) => call.body.messageId), ["A1"]);
  assert.equal(ui.document.querySelector("#btn-chat-more").disabled, true);
  assert.doesNotMatch(APP_SRC, /btn-chat-more|chat-more-button/);
});

group("T8");

await bai("T8", "cascade composer mobile cung specificity, dung source order va khong bi de lai", () => {
  const rules = quyTacMessageInput();
  const gridRules = rules.filter((rule) => /grid-column\s*:/.test(rule.body));
  assert.equal(gridRules.length, 2, "chi base va mobile duoc khai grid-column");
  const [baseRule, mobileRule] = gridRules;
  assert.match(baseRule.body, /grid-column:\s*1\s*\/\s*4/);
  assert.match(mobileRule.body, /grid-column:\s*3(?:\s*;|\s*$)/);
  assert.ok(mobileRule.index > baseRule.index);
  const mobileBlocks = cacKhoiMobile760();
  assert.equal(mobileBlocks.length, 4, "khong tao them media 760 ngoai bon block da co");
  const containingBlock = mobileBlocks.find((block) => mobileRule.index > block.start && mobileRule.index < block.end);
  assert.ok(containingBlock, "mobile selector phai nam trong media 760 co san");
  const laterCompeting = rules.filter((rule) => rule.index > mobileRule.index && /grid-column\s*:/.test(rule.body));
  assert.equal(laterCompeting.length, 0);
  assert.match(containingBlock.body, /\.send-form\s*\{[\s\S]*?grid-template-columns:\s*44px 44px minmax\(0, 1fr\) 44px/);
  assert.match(containingBlock.body, /#btn-chat-image\s*\{[\s\S]*?grid-column:\s*1/);
  assert.match(containingBlock.body, /#btn-chat-attach\s*\{[\s\S]*?grid-column:\s*2/);
  assert.match(containingBlock.body, /\.send-button\s*\{[\s\S]*?min-width:\s*64px/);
  assert.match(CSS_SRC, /#btn-chat-sticker\s*\{[\s\S]*?grid-column:\s*3/);
  assert.match(CSS_SRC.slice(mobileRule.index), /\.chat-panel #message-input\s*\{\s*padding-right:\s*44px/);
  assert.match(containingBlock.body, /env\(safe-area-inset-bottom\)/);
});

group("T9");

await bai("T9", "copy bot per-thread khong khai dang tra loi va app.js da noi toggle scoped", () => {
  const dom = new JSDOM(HTML_SRC).window.document;
  const desktopLabels = [...dom.querySelectorAll(".thread-bot-desktop-label")];
  const mobileLabels = [...dom.querySelectorAll(".thread-bot-mobile-label")];
  assert.ok(desktopLabels.length > 0 && mobileLabels.length > 0);
  for (const node of [...desktopLabels, ...mobileLabels]) {
    assert.doesNotMatch(node.textContent, /đang trả lời/);
  }
  assert.match(APP_SRC, /threadBotStatus: document\.querySelector\("#thread-bot-status"\)/);
  assert.match(APP_SRC, /btnThreadBotToggle: document\.querySelector\("#btn-thread-bot-toggle"\)/);
  assert.match(APP_SRC, /\/api\/threads\/\$\{encodeURIComponent\(thread\.id\)\}\/bot\/toggle/);
});

/* ===================================================================== */

try {
  fs.rmSync(THU_MUC_TAM, { recursive: true, force: true });
} catch {
  // Tep tam khong xoa duoc khong phai ly do lam hong ket qua kiem thu.
}

const dat = results.filter((r) => r.ok).length;
const theoNhom = new Map();
for (const r of results) {
  const muc = theoNhom.get(r.nhom) || { dat: 0, tong: 0 };
  muc.tong += 1;
  if (r.ok) muc.dat += 1;
  theoNhom.set(r.nhom, muc);
}

console.log("\n===== MESSAGING POWER PACK V1 — FOCUSED SUITE =====");
for (const [ten, muc] of theoNhom) {
  console.log(`${ten} = ${muc.dat}/${muc.tong} PASS${muc.dat === muc.tong ? "" : "  <-- FAIL"}`);
}
console.log(`TOTAL = ${dat}/${results.length} PASS`);
const baiCuDat = results.slice(0, SO_BAI_CU).filter((r) => r.ok).length;
const baiMoiDat = results.slice(SO_BAI_CU).filter((r) => r.ok).length;
console.log(`OLD_TESTS = ${baiCuDat}/${SO_BAI_CU} PASS`);
console.log(`NEW_BLOCKER_TESTS = ${baiMoiDat}/${results.length - SO_BAI_CU} PASS`);
console.log("REAL_ZALO_CALL = 0");
console.log("REAL_PROVIDER_UAT = NOT_RERUN");
console.log("PRODUCTION_DB_TOUCHED = NO");
if (dat !== results.length) process.exitCode = 1;
