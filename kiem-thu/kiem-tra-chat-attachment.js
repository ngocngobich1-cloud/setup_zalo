import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dinhDangDungLuong,
  laAnhZalo,
  phanLoaiMediaTinNhan,
} from "../public/chat-media.js";
import { taoNguonDinhKemZalo } from "../lib/zalo-media.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = (file) => fs.readFileSync(path.join(REPO, file), "utf8");
const ketQua = [];

async function bai(ma, moTa, fn) {
  try {
    await fn();
    ketQua.push({ ma, ok: true });
    console.log(`PASS ${ma} - ${moTa}`);
  } catch (error) {
    ketQua.push({ ma, ok: false });
    console.error(`FAIL ${ma} - ${moTa}`);
    console.error(error.stack || error.message);
  }
}

function extractFunction(moduleSource, signature) {
  const start = moduleSource.indexOf(signature);
  assert.ok(start >= 0, `Khong tim thay function: ${signature}`);
  const bodyStart = moduleSource.indexOf("{", start + signature.length);
  assert.ok(bodyStart >= 0, `Khong tim thay function body: ${signature}`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < moduleSource.length; index += 1) {
    const char = moduleSource[index];
    const next = moduleSource[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return moduleSource.slice(start, index + 1);
    }
  }
  assert.fail(`Function body khong dong: ${signature}`);
}

function compileFunction(moduleSource, signature, dependencies) {
  const functionSource = extractFunction(moduleSource, signature).replace(/^export\s+/, "");
  const name = functionSource.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1];
  assert.ok(name, `Khong doc duoc ten function: ${signature}`);
  const names = Object.keys(dependencies);
  const factory = Function(...names, `"use strict";\n${functionSource}\nreturn ${name};`);
  return factory(...names.map((key) => dependencies[key]));
}

const APP = source("public/app.js");
const TRAINING = source("public/training.js");
const HTML = source("public/index.html");
const CSS = source("public/style.css");
const SERVER = source("server.js");
const ZALO = source("lib/zalo-service.js");
const UNICODE_PDF_NAME = "Mô tả AI Business OS.pdf";
const SEND_ROUTE = SERVER.slice(SERVER.indexOf('app.post("/api/send"'), SERVER.indexOf('app.post("/api/threads/refresh"'));
const bug02Evidence = {
  selfShareFileHandleCalls: 0,
  persistAndBroadcastCalls: 0,
  broadcastSeparatelyStubbed: false,
};

async function runSetupListenerMessage(normalizedMsg) {
  const handlers = new Map();
  const handled = [];
  let startOptions = null;
  const setupListener = compileFunction(ZALO, "function setupListener", {
    listenerAttached: false,
    api: {
      listener: {
        on: (event, handler) => handlers.set(event, handler),
        start: (options) => { startOptions = options; },
      },
    },
    attachOldMessagesListener: () => undefined,
    chuHienTai: () => "owner-test",
    rebuildThreadsFromMessages: async () => undefined,
    emitThreads: async () => undefined,
    normalizeIncomingMessage: () => normalizedMsg,
    handleNewIncomingMessage: async (message) => { handled.push(message); },
    datTrangThaiKetNoi: () => undefined,
    console: { error: () => undefined },
    addLog: async () => undefined,
  });
  setupListener();
  assert.deepEqual(startOptions, { retryOnClose: true });
  assert.equal(typeof handlers.get("message"), "function");
  await handlers.get("message")({ raw: "fixture" });
  return handled;
}

async function runCanonicalSelfFile(normalizedMsg) {
  const counters = {
    persistAndBroadcast: 0,
    adminCommand: 0,
    autoReply: 0,
    aggregation: 0,
    ai: 0,
    outbound: 0,
  };
  let persisted = null;
  const handleNewIncomingMessage = compileFunction(ZALO, "async function handleNewIncomingMessage", {
    persistAndBroadcastMessage: async (message) => {
      counters.persistAndBroadcast += 1;
      persisted = message;
      return message;
    },
    sendChatMessage: async () => { counters.outbound += 1; },
    sendResolvedPrivateMessage: async () => { counters.outbound += 1; },
    laLenhAdmin: async () => { counters.adminCommand += 1; return false; },
    getAutoReplyRules: async () => { counters.autoReply += 1; return []; },
    boGom: { them: () => { counters.aggregation += 1; } },
    aiChat: { getConfig: () => { counters.ai += 1; return { botEnabled: true }; } },
  });
  await handleNewIncomingMessage(normalizedMsg);
  return { counters, persisted };
}

await bai("M01", "tin text thường được phân loại TEXT", () => {
  assert.equal(phanLoaiMediaTinNhan({ msgType: "chat.text", content: "xin chào" }), null);
});

await bai("M02", "text chứa URL .jpg vẫn là TEXT", () => {
  assert.equal(
    phanLoaiMediaTinNhan({ msgType: "chat.text", content: "Xem ảnh tại https://example.com/a.jpg" }),
    null
  );
});

await bai("M03", "chat.photo dùng metadata canonical thành IMAGE", () => {
  const media = phanLoaiMediaTinNhan({
    msgType: "chat.photo",
    rawJson: { data: { content: { href: "https://example.com/a.jpg", thumb: "https://example.com/t.jpg" } } },
  });
  assert.equal(media.kind, "image");
  assert.equal(media.url, "https://example.com/a.jpg");
  assert.equal(media.thumbnailUrl, "https://example.com/t.jpg");
});

await bai("M04", "share.file dùng metadata canonical thành FILE", () => {
  const media = phanLoaiMediaTinNhan({
    msgType: "share.file",
    rawJson: { data: { content: { href: "https://example.com/a.pdf", title: "bao-cao.pdf", fileSize: 2048 } } },
  });
  assert.equal(media.kind, "file");
  assert.equal(media.filename, "bao-cao.pdf");
  assert.equal(media.size, 2048);
});

await bai("M05", "metadata size trong params được tái sử dụng", () => {
  const media = phanLoaiMediaTinNhan({
    msgType: "share.file",
    rawJson: { content: { href: "https://example.com/a.zip", params: '{"fileSize":"4096"}' } },
  });
  assert.equal(media.size, 4096);
});

await bai("M06", "URL không phải HTTP/HTTPS không được render", () => {
  assert.equal(
    phanLoaiMediaTinNhan({ msgType: "chat.photo", rawJson: { data: { content: { href: "javascript:alert(1)" } } } }),
    null
  );
});

await bai("M07", "định dạng dung lượng chỉ hiển thị dữ liệu có thật", () => {
  assert.equal(dinhDangDungLuong(null), "");
  assert.equal(dinhDangDungLuong(2048), "2 KB");
});

await bai("M08", "chỉ đuôi ảnh provider hỗ trợ được xem là ảnh", () => {
  assert.equal(laAnhZalo({ name: "a.webp" }), true);
  assert.equal(laAnhZalo({ name: "a.pdf" }), false);
  assert.equal(laAnhZalo({ name: "a.heic" }), false);
});

await bai("B01", "buffer upload tạo đúng AttachmentSource", () => {
  const buffer = Buffer.from("abc");
  const attachment = taoNguonDinhKemZalo({ buffer, filename: "bao-cao.pdf" });
  assert.equal(attachment.data, buffer);
  assert.equal(attachment.filename, "bao-cao.pdf");
  assert.equal(attachment.metadata.totalSize, 3);
});

await bai("B02", "filename bị bóc local path trước khi sang provider", () => {
  const attachment = taoNguonDinhKemZalo({ buffer: Buffer.from("abc"), filename: "C:\\Users\\PO\\anh.jpg", width: 10, height: 20 });
  assert.equal(attachment.filename, "anh.jpg");
  assert.equal(attachment.metadata.width, 10);
  assert.equal(attachment.metadata.height, 20);
});

await bai("B03", "ảnh thiếu kích thước bị chặn trước provider", () => {
  assert.throws(
    () => taoNguonDinhKemZalo({ buffer: Buffer.from("abc"), filename: "anh.png" }),
    /kích thước ảnh/i
  );
});

await bai("B04", "tệp trống bị chặn", () => {
  assert.throws(() => taoNguonDinhKemZalo({ buffer: Buffer.alloc(0), filename: "a.pdf" }), /trống/i);
});

await bai("B05", "route dùng memory multipart một tệp", () => {
  assert.match(SERVER, /const zaloSendUpload = multer\([\s\S]*?memoryStorage\(\)[\s\S]*?files:\s*1/);
  assert.match(SEND_ROUTE, /zaloSendUpload\.single\("file"\)/);
});

await bai("B06", "route không đọc browser-supplied filesystem path", () => {
  assert.doesNotMatch(SEND_ROUTE, /req\.(?:body|file)\?*\.path|readFile|createReadStream/);
  assert.match(SEND_ROUTE, /req\.file\.buffer/);
});

await bai("B07", "media tái sử dụng chính api.sendMessage", () => {
  assert.match(ZALO, /attachments:\s*nguonDinhKem/);
  assert.match(ZALO, /ketQuaGui = await api\.sendMessage/);
  assert.equal((ZALO.match(/new Zalo\(/g) || []).length, 1);
});

await bai("B08", "media thiếu URL chờ echo canonical thay vì ghi bản giả", () => {
  assert.match(ZALO, /gui_media_cho_tin_doi_lai/);
  assert.match(ZALO, /ketQuaGui\?\.message\?\.msgId \?\? null/);
});

await bai("B09", "selfListen nam tren Zalo constructor, khong nam trong listener.start", () => {
  const constructor = ZALO.match(/const zalo = new Zalo\(\{([^}]*)\}\);/);
  assert.ok(constructor, "Khong tim thay Zalo constructor");
  assert.match(constructor[1], /selfListen:\s*true/);
  const setup = extractFunction(ZALO, "function setupListener");
  assert.match(setup, /api\.listener\.start\(\{\s*retryOnClose:\s*true\s*\}\)/);
  assert.doesNotMatch(setup, /listener\.start\([^)]*selfListen/);
  assert.match(source("node_modules/zca-js/dist/apis/listen.js"), /this\.selfListen = ctx\.options\.selfListen/);
});

await bai("B10", "self share.file qua inline gate va giu nguyen canonical metadata", async () => {
  const normalized = {
    id: "self-file-1",
    threadId: "thread-file",
    threadType: 0,
    isSelf: true,
    msgType: "share.file",
    content: UNICODE_PDF_NAME,
    rawJson: {
      data: {
        content: {
          href: "https://example.test/file",
          title: "Mô tả AI Business OS.pdf",
          params: '{"fileSize":"58452"}',
        },
      },
    },
  };
  const handled = await runSetupListenerMessage(normalized);
  assert.equal(handled.length, 1);
  assert.equal(handled[0], normalized);
  bug02Evidence.selfShareFileHandleCalls = handled.length;

  const canonical = await runCanonicalSelfFile(handled[0]);
  assert.equal(canonical.counters.persistAndBroadcast, 1);
  assert.equal(canonical.persisted, normalized);
  assert.equal(canonical.persisted.msgType, "share.file");
  assert.equal(canonical.persisted.rawJson.data.content.href, "https://example.test/file");
  assert.equal(canonical.persisted.rawJson.data.content.title, "Mô tả AI Business OS.pdf");
  assert.equal(canonical.persisted.rawJson, normalized.rawJson);
  assert.deepEqual(canonical.counters, {
    persistAndBroadcast: 1,
    adminCommand: 0,
    autoReply: 0,
    aggregation: 0,
    ai: 0,
    outbound: 0,
  });
  bug02Evidence.persistAndBroadcastCalls = canonical.counters.persistAndBroadcast;
});

await bai("B11", "self text bi chan truoc canonical handler", async () => {
  assert.equal((await runSetupListenerMessage({ isSelf: true, msgType: "text" })).length, 0);
});

await bai("B12", "self chat.photo bi chan dung V1 scope", async () => {
  assert.equal((await runSetupListenerMessage({ isSelf: true, msgType: "chat.photo" })).length, 0);
});

await bai("B13", "non-self customer van den canonical handler", async () => {
  const customer = { isSelf: false, msgType: "text", id: "customer-1" };
  const handled = await runSetupListenerMessage(customer);
  assert.equal(handled.length, 1);
  assert.equal(handled[0], customer);
});

await bai("B14", "provider msgId-only khong tao fake local share.file", () => {
  const sendStart = ZALO.indexOf("export async function sendChatMessage");
  const sendEnd = ZALO.indexOf("/**\n * Gui dung mot tin rieng", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "Khong tach duoc sendChatMessage source");
  const sendChatMessage = ZALO.slice(sendStart, sendEnd);
  assert.match(sendChatMessage, /ketQuaGui\?\.message\?\.msgId \?\? null/);
  assert.doesNotMatch(sendChatMessage, /msgType:\s*["']share\.file["']/);
  assert.doesNotMatch(sendChatMessage, /href\s*:/);
});

await bai("T01", "Enter requestSubmit qua cùng form canonical", () => {
  assert.match(TRAINING, /els\.form\.addEventListener\("submit", guiTuComposer\)/);
  assert.match(TRAINING, /els\.form\.requestSubmit\(\)/);
});

await bai("T02", "Shift+Enter không bị submit", () => {
  assert.match(TRAINING, /event\.shiftKey/);
});

await bai("T03", "IME composing và keyCode 229 không submit", () => {
  assert.match(TRAINING, /event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(TRAINING, /if \(event\.key !== "Enter" \|\| event\.shiftKey \|\| dangSoanIme\) return/);
});

await bai("T04", "message rỗng không gửi", () => {
  assert.match(TRAINING, /if \(!text && dinhKem\.length === 0\) return/);
});

await bai("T05", "already sending chặn duplicate", () => {
  assert.match(TRAINING, /if \(dangGui\) return/);
  assert.match(TRAINING, /if \(!dangGui\) els\.form\.requestSubmit\(\)/);
});

await bai("T06", "nút Send vẫn submit form canonical", () => {
  assert.match(HTML, /id="training-form"[\s\S]*?<button type="submit" class="primary-button">Gửi<\/button>/);
});

await bai("T07", "Training picker nhận ảnh và file canonical hiện có", () => {
  assert.match(HTML, /id="training-file-input"[\s\S]*?image\/png[\s\S]*?application\/pdf[\s\S]*?text\/plain/);
});

await bai("T08", "ảnh bị capability check trước khi thêm", () => {
  assert.match(TRAINING, /file\.type\.startsWith\("image\/"\) && !docDuocAnh/);
});

await bai("T09", "file không phải ảnh vẫn được thêm khi model không đọc ảnh", () => {
  assert.match(TRAINING, /Các tệp không phải ảnh vẫn dùng được/);
  assert.match(TRAINING, /dinhKem\.push\(\{/);
});

await bai("T10", "selected image có thumbnail và remove", () => {
  assert.match(TRAINING, /URL\.createObjectURL\(file\)/);
  assert.match(TRAINING, /training-chip-image/);
  assert.match(TRAINING, /URL\.revokeObjectURL/);
});

await bai("T11", "Training history dùng image/file cards", () => {
  assert.match(TRAINING, /training-message-image/);
  assert.match(TRAINING, /training-media-card/);
});

await bai("C01", "chat composer có input, attachment và send", () => {
  assert.match(HTML, /id="message-input"[\s\S]*?id="btn-chat-attach"[\s\S]*?id="btn-chat-send"/);
});

await bai("C02", "chat text và attachment dùng cùng sendMessage", () => {
  assert.match(APP, /els\.form\.addEventListener\("submit", sendMessage\)/);
  assert.match(APP, /body\.append\("file", attachment\.file\)/);
  assert.match(APP, /fetch\("\/api\/send", \{ method: "POST", body \}\)/);
});

await bai("C03", "chat upload có double-submit guard", () => {
  assert.match(APP, /if \(dangGuiTin\) return/);
  assert.match(APP, /els\.btnSend\.disabled = true/);
});

await bai("C04", "selected image preview và remove có thật", () => {
  assert.match(APP, /docKichThuocAnh/);
  assert.match(APP, /chat-selected-file/);
  assert.match(APP, /remove\.addEventListener\("click", boTepChat\)/);
});

await bai("C05", "incoming image render bằng img, không phải raw URL", () => {
  assert.match(APP, /const media = phanLoaiMediaTinNhan\(message\)/);
  assert.match(APP, /image\.className = "chat-image"/);
  assert.match(APP, /bubble\.classList\.add\("bubble-media"\)/);
});

await bai("C06", "incoming file render bằng file card", () => {
  assert.match(APP, /link\.className = "chat-file-card"/);
  assert.match(APP, /action\.textContent = "Mở \/ tải"/);
});

await bai("C07", "image aspect ratio và overflow được chặn", () => {
  assert.match(CSS, /\.chat-image\s*\{[\s\S]*?max-width:[\s\S]*?max-height:[\s\S]*?object-fit:\s*contain/);
  assert.match(CSS, /\.training-message-image\s*\{[\s\S]*?max-width:[\s\S]*?max-height:[\s\S]*?object-fit:\s*contain/);
});

await bai("C08", "mobile composer giữ ba cột usable", () => {
  assert.match(CSS, /\.send-input-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto auto/);
  assert.match(CSS, /@media \(max-width: 760px\)[\s\S]*?\.send-button\s*\{[\s\S]*?min-width:\s*64px/);
});

await bai("O01", "attachment nằm trong persistent onboarding spotlight form", () => {
  assert.match(HTML, /id="training-form"[\s\S]*?id="btn-training-attach"[\s\S]*?<button type="submit"/);
  assert.match(CSS, /\.training-form-composer-spotlight\s*\{[\s\S]*?pointer-events:\s*auto/);
});

const pass = ketQua.filter((item) => item.ok).length;
console.log(`\nCHAT ATTACHMENT: ${pass}/${ketQua.length} PASS`);
console.log("REAL_ZALO_IMAGE_SEND = NO");
console.log("REAL_ZALO_FILE_SEND = NO");
console.log(`SELF_SHARE_FILE_HANDLE_CALLS = ${bug02Evidence.selfShareFileHandleCalls}`);
console.log(`PERSIST_AND_BROADCAST_CALLS = ${bug02Evidence.persistAndBroadcastCalls}`);
console.log(`BROADCAST_SEPARATELY_STUBBED = ${bug02Evidence.broadcastSeparatelyStubbed ? "YES" : "NO"}`);
if (pass !== ketQua.length) process.exitCode = 1;
