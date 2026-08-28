/**
 * PDF Automation V1 acceptance: fixture local + SQLite tam, zero Zalo/provider.
 * Suite nay co chu dich import lib/db.js nen canonical runner phai danh dau
 * requiresNativeSqlite thay vi silently skip persistence acceptance.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import multer from "multer";
import {
  clearAllPendingPdfConfirmations,
  createPdfAutomationHandler,
  getPendingPdfConfirmation,
  hasExactPdfConfirmation,
  normalizePdfKeyword,
  PDF_AUTOMATION_CONTINUE,
  PDF_AUTOMATION_HANDLED,
  PDF_AUTOMATION_MAX_BYTES,
  preparePdfKeyword,
  selectPdfAutomationRule,
  validatePdfUpload,
} from "../lib/pdf-automation.js";
import { PDF_AUTOMATION_MULTER_OPTIONS } from "../lib/pdf-upload-options.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const OWNER_A = "pdf-owner-a";
const OWNER_B = "pdf-owner-b";
const OWNER_UNICODE = "pdf-owner-unicode";
const OWNER_REPLACE = "pdf-owner-replace";
const THREAD = "customer-thread";
const PDF_A = Buffer.from("%PDF-1.7\nfixture-a");
const PDF_B = Buffer.from("%PDF-1.7\nfixture-b");
const UNICODE_PDF_NAME = "Mô tả AI Business OS.pdf";
const results = [];

async function parseRealPdfMultipart({ filename = UNICODE_PDF_NAME, data = PDF_A } = {}) {
  const form = new FormData();
  form.append("file", new Blob([data], { type: "application/pdf" }), filename);
  const request = new Request("http://pdf-upload.test/upload", { method: "POST", body: form });
  const requestBody = Buffer.from(await request.arrayBuffer());
  const req = Readable.from([requestBody]);
  req.headers = Object.fromEntries(request.headers.entries());
  req.headers["content-length"] = String(requestBody.length);
  req.method = "POST";
  req.url = "/upload";

  await new Promise((resolve, reject) => {
    multer(PDF_AUTOMATION_MULTER_OPTIONS).single("file")(req, {}, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return req.file;
}

async function test(code, description, run) {
  clearAllPendingPdfConfirmations();
  try {
    await run();
    results.push({ code, description, pass: true });
  } catch (error) {
    results.push({ code, description, pass: false, error: error.stack || error.message });
  }
}

function makeRule(id = 1, keyword = "template", data = PDF_A) {
  return {
    id,
    keyword,
    keywordNorm: normalizePdfKeyword(keyword),
    pdfName: `${keyword}.pdf`,
    pdfMime: "application/pdf",
    pdfSize: data.length,
    pdfData: data,
    enabled: true,
  };
}

function makeRuntime({ rules = [makeRule()], failConfirmation = false, failPdf = false } = {}) {
  let ownerUid = OWNER_A;
  let generation = 1;
  let apiIdentity = {};
  const sends = [];
  const logs = [];
  let listEnabledRules = async (owner) => owner === ownerUid ? rules.filter((rule) => rule.enabled) : [];
  const getRuleWithBlob = async (owner, id) => (
    owner === ownerUid ? rules.find((rule) => rule.id === Number(id)) || null : null
  );
  const isOriginCurrent = (origin) => origin.originOwnerUid === ownerUid
    && origin.originRuntimeGeneration === generation
    && origin.originApiIdentity === apiIdentity;
  const sendMessage = async (payload) => {
    if (payload.attachment && failPdf) throw new Error("fixture pdf transport failed");
    if (!payload.attachment && failConfirmation) throw new Error("fixture confirmation transport failed");
    sends.push(payload);
    return { ok: true };
  };
  const handler = createPdfAutomationHandler({
    listEnabledRules: (...args) => listEnabledRules(...args),
    getRuleWithBlob,
    sendMessage,
    isOriginCurrent,
    getOwnerUid: () => ownerUid,
    getRuntimeGeneration: () => generation,
    log: async (entry) => logs.push(entry),
  });
  const origin = () => ({
    originOwnerUid: ownerUid,
    originRuntimeGeneration: generation,
    originApiIdentity: apiIdentity,
  });
  const run = (contents, token = origin()) => {
    const tins = contents.map((content, index) => ({
      id: String(index + 1), content, threadId: THREAD, threadType: 0,
    }));
    return handler({
      tins,
      tin: { ...tins[tins.length - 1], content: contents.join("\n") },
      originToken: token,
    });
  };
  return {
    sends, logs, run, origin,
    setListEnabledRules(fn) { listEnabledRules = fn; },
    switchRuntime(nextOwner = ownerUid) {
      ownerUid = nextOwner;
      generation += 1;
      apiIdentity = {};
    },
  };
}

async function trigger(runtime, text = "Cho chị xin template nhé") {
  assert.equal(await runtime.run([text]), PDF_AUTOMATION_HANDLED);
  assert.equal(runtime.sends.length, 1);
  assert.equal(Boolean(runtime.sends[0].attachment), false);
  assert.match(runtime.sends[0].text, /trả lời OK/);
}

async function main() {
  await test("PDF01", "khong keyword thi CONTINUE, zero side effect", async () => {
    const runtime = makeRuntime();
    assert.equal(await runtime.run(["Chào em"]), PDF_AUTOMATION_CONTINUE);
    assert.equal(runtime.sends.length, 0);
  });

  await test("PDF02", "keyword trigger chi gui mot confirmation va tao pending", async () => {
    const runtime = makeRuntime();
    await trigger(runtime);
    assert.equal(getPendingPdfConfirmation(OWNER_A, THREAD)?.ruleId, 1);
  });

  await test("PDF03A", "single exact OK gui dung mot PDF va HANDLED", async () => {
    const runtime = makeRuntime();
    await trigger(runtime);
    assert.equal(await runtime.run(["OK"]), PDF_AUTOMATION_HANDLED);
    assert.equal(runtime.sends.filter((item) => item.attachment).length, 1);
    assert.equal(runtime.sends[1].attachment.filename, "template.pdf");
    assert.equal(getPendingPdfConfirmation(OWNER_A, THREAD), null);
  });

  await test("PDF03B", "OK + fragment trong cung batch van xac nhan ca batch", async () => {
    const runtime = makeRuntime();
    await trigger(runtime);
    assert.equal(await runtime.run(["OK", "dạ em"]), PDF_AUTOMATION_HANDLED);
    assert.equal(runtime.sends.filter((item) => item.attachment).length, 1);
    assert.equal(hasExactPdfConfirmation([{ content: "OK" }, { content: "dạ em" }]), true);
  });

  await test("PDF03C", "exact OK trim va khong phan biet hoa thuong", async () => {
    const runtime = makeRuntime();
    await trigger(runtime);
    assert.equal(await runtime.run(["  Ok  "]), PDF_AUTOMATION_HANDLED);
    assert.equal(runtime.sends.filter((item) => item.attachment).length, 1);
  });

  await test("PDF04", "non-OK huy pending va batch tiep tuc binh thuong", async () => {
    const runtime = makeRuntime();
    await trigger(runtime);
    assert.equal(await runtime.run(["ok em"]), PDF_AUTOMATION_CONTINUE);
    assert.equal(runtime.sends.filter((item) => item.attachment).length, 0);
    assert.equal(getPendingPdfConfirmation(OWNER_A, THREAD), null);
    assert.equal(hasExactPdfConfirmation([{ content: "O" }, { content: "K" }]), false);
  });

  await test("PDF05", "confirmation send failure khong tao pending va CONTINUE", async () => {
    const runtime = makeRuntime({ failConfirmation: true });
    assert.equal(await runtime.run(["template"]), PDF_AUTOMATION_CONTINUE);
    assert.equal(getPendingPdfConfirmation(OWNER_A, THREAD), null);
    assert.equal(runtime.sends.length, 0);
  });

  await test("PDF06", "PDF send failure consume pending, khong retry, khong AI fallback", async () => {
    const runtime = makeRuntime({ failPdf: true });
    await trigger(runtime);
    assert.equal(await runtime.run(["OK"]), PDF_AUTOMATION_HANDLED);
    assert.equal(getPendingPdfConfirmation(OWNER_A, THREAD), null);
    assert.equal(runtime.sends.length, 1, "chi co confirmation da gui thanh cong");
    assert.ok(runtime.logs.some((entry) => entry.detail?.outcome === "pdf_send_failed"));
  });

  await test("PDF09", "stale A1 -> B -> A2 khong gui confirmation hay resurrect pending", async () => {
    const runtime = makeRuntime();
    let release;
    runtime.setListEnabledRules(() => new Promise((resolve) => { release = resolve; }));
    const tokenA1 = runtime.origin();
    const pending = runtime.run(["template"], tokenA1);
    assert.equal(typeof release, "function");
    runtime.switchRuntime(OWNER_B);
    runtime.switchRuntime(OWNER_A);
    release([makeRule()]);
    assert.equal(await pending, PDF_AUTOMATION_HANDLED);
    assert.equal(runtime.sends.length, 0);
    assert.equal(getPendingPdfConfirmation(OWNER_A, THREAD), null);
  });

  await test("PDF11", "longest keyword va id nho hon thang deterministic", async () => {
    const long = selectPdfAutomationRule([
      makeRule(1, "template"), makeRule(2, "template sale"),
    ], "Cho chị template sale nhé");
    assert.equal(long.id, 2);
    const tie = selectPdfAutomationRule([
      makeRule(9, "Mẫu sale"), makeRule(4, "mẫu SALE"),
    ], "xin MẪU SALE");
    assert.equal(tie.id, 4);
  });

  await test("PDF14", "validation bat extension, MIME, signature, empty va oversize", async () => {
    const valid = validatePdfUpload({ originalname: "template.PDF", mimetype: "application/pdf", buffer: PDF_A });
    assert.equal(valid.pdfSize, PDF_A.length);
    assert.throws(() => validatePdfUpload({ originalname: "a.txt", mimetype: "application/pdf", buffer: PDF_A }), /\.pdf/i);
    assert.throws(() => validatePdfUpload({ originalname: "a.pdf", mimetype: "text/plain", buffer: PDF_A }), /MIME/i);
    assert.throws(() => validatePdfUpload({ originalname: "a.pdf", mimetype: "application/pdf", buffer: Buffer.from("fake") }), /chữ ký/i);
    assert.throws(() => validatePdfUpload({ originalname: "a.pdf", mimetype: "application/pdf", buffer: Buffer.alloc(0) }), /trống/i);
    const huge = Buffer.alloc(PDF_AUTOMATION_MAX_BYTES + 1);
    huge.write("%PDF");
    assert.throws(() => validatePdfUpload({ originalname: "a.pdf", mimetype: "application/pdf", buffer: huge }), /10 MB/i);
    assert.deepEqual(preparePdfKeyword("  Te\u0301mplate  "), {
      keyword: "Témplate",
      keywordNorm: "témplate",
    });
  });

  await test("PDF16", "multipart that giu nguyen filename Unicode qua Multer/Busboy", async () => {
    const parsed = await parseRealPdfMultipart();
    assert.equal(parsed.originalname, UNICODE_PDF_NAME);
    assert.equal(parsed.mimetype, "application/pdf");
    assert.deepEqual(parsed.buffer, PDF_A);
    assert.equal(validatePdfUpload(parsed).pdfName, UNICODE_PDF_NAME);
  });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-automation-v1-"));
  fs.mkdirSync(path.join(temp, "data"), { recursive: true });
  process.chdir(temp);
  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  await db.initDb();

  await test("PDF19", "startup tao bang PDF tren DB moi va init lai idempotent", async () => {
    assert.deepEqual(await db.listPdfAutomationRules("fresh-owner"), []);
    await db.initDb();
    assert.deepEqual(await db.listPdfAutomationRules("fresh-owner"), []);
  });

  await test("PDF17", "Unicode multipart persist va metadata readback khong mojibake", async () => {
    const parsed = await parseRealPdfMultipart();
    const validated = validatePdfUpload(parsed);
    const created = await db.insertPdfAutomationRule(OWNER_UNICODE, {
      ...preparePdfKeyword("unicode-pdf"),
      ...validated,
      enabled: true,
    });
    assert.equal(created.pdfName, UNICODE_PDF_NAME);
    const metadata = await db.listPdfAutomationRules(OWNER_UNICODE);
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].pdfName, UNICODE_PDF_NAME);
    assert.deepEqual(
      Buffer.from((await db.getPdfAutomationRuleWithBlob(OWNER_UNICODE, created.id)).pdfData),
      PDF_A
    );
  });

  await test("PDF18", "replacement Unicode atomic va invalid replacement giu PDF cu", async () => {
    const created = await db.insertPdfAutomationRule(OWNER_REPLACE, {
      ...preparePdfKeyword("replace-pdf"),
      pdfName: "old.pdf",
      pdfMime: "application/pdf",
      pdfSize: PDF_A.length,
      pdfData: PDF_A,
      enabled: true,
    });
    const replacement = validatePdfUpload(await parseRealPdfMultipart({ data: PDF_B }));
    const updated = await db.updatePdfAutomationRule(OWNER_REPLACE, created.id, replacement);
    assert.equal(updated.pdfName, UNICODE_PDF_NAME);
    assert.deepEqual(
      Buffer.from((await db.getPdfAutomationRuleWithBlob(OWNER_REPLACE, created.id)).pdfData),
      PDF_B
    );

    const invalid = await parseRealPdfMultipart({ data: Buffer.from("not-a-pdf") });
    assert.throws(() => validatePdfUpload(invalid), /chữ ký/i);
    const afterFailure = await db.getPdfAutomationRuleWithBlob(OWNER_REPLACE, created.id);
    assert.equal(afterFailure.pdfName, UNICODE_PDF_NAME);
    assert.deepEqual(Buffer.from(afterFailure.pdfData), PDF_B);
  });

  await test("PDF07", "CRUD va BLOB cach ly owner A/B", async () => {
    const keyword = preparePdfKeyword("template");
    const created = await db.insertPdfAutomationRule(OWNER_A, {
      ...keyword,
      pdfName: "template.pdf",
      pdfMime: "application/pdf",
      pdfSize: PDF_A.length,
      pdfData: PDF_A,
      enabled: true,
    });
    assert.equal((await db.listPdfAutomationRules(OWNER_A)).length, 1);
    assert.equal((await db.listPdfAutomationRules(OWNER_B)).length, 0);
    assert.equal(await db.getPdfAutomationRuleWithBlob(OWNER_B, created.id), null);
    assert.equal(await db.updatePdfAutomationRule(OWNER_B, created.id, { enabled: false }), null);
    assert.equal(await db.deletePdfAutomationRule(OWNER_B, created.id), false);
    assert.deepEqual(Buffer.from((await db.getPdfAutomationRuleWithBlob(OWNER_A, created.id)).pdfData), PDF_A);
  });

  await test("PDF08_PDF10", "metadata/BLOB persist trong SQLite va pending khong persist", async () => {
    const metadata = await db.listPdfAutomationRules(OWNER_A);
    assert.equal(Object.hasOwn(metadata[0], "pdfData"), false);
    const stored = await db.getPdfAutomationRuleWithBlob(OWNER_A, metadata[0].id);
    assert.deepEqual(Buffer.from(stored.pdfData), PDF_A);
    assert.equal(getPendingPdfConfirmation(OWNER_A, THREAD), null);
  });

  await test("PDF13", "normalized keyword trung trong cung owner bi DB tu choi", async () => {
    await assert.rejects(() => db.insertPdfAutomationRule(OWNER_A, {
      ...preparePdfKeyword(" TEMPLATE "),
      pdfName: "other.pdf",
      pdfMime: "application/pdf",
      pdfSize: PDF_B.length,
      pdfData: PDF_B,
      enabled: true,
    }), /UNIQUE constraint failed/i);
    await db.insertPdfAutomationRule(OWNER_B, {
      ...preparePdfKeyword("template"),
      pdfName: "b.pdf",
      pdfMime: "application/pdf",
      pdfSize: PDF_B.length,
      pdfData: PDF_B,
      enabled: true,
    });
    assert.equal((await db.listPdfAutomationRules(OWNER_B)).length, 1);
  });

  await test("PDF12_PDF15", "canonical insertion, dedupe, UI isolation va marker locks", async () => {
    const zalo = fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8");
    const config = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
    const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
    const incoming = zalo.slice(zalo.indexOf("async function handleNewIncomingMessage"), zalo.indexOf("export function chuHienTai"));
    assert.ok(incoming.indexOf("persistAndBroadcastMessage") < incoming.indexOf("boGom.them"));
    assert.match(incoming, /if \(!processedMsg\) return/);
    const aggregate = zalo.slice(zalo.indexOf("async function traLoiCumTin"), zalo.indexOf("async function handleNewIncomingMessage"));
    assert.match(aggregate, /handlePdfAutomation\(\{ tins, tin, originToken \}\)/);
    assert.ok(aggregate.indexOf("handlePdfAutomation") < aggregate.indexOf("aiChat.tryReply"));

    const aiStart = config.indexOf('id: "ai-chat"');
    const aiEnd = config.indexOf('id: "knowledge"', aiStart);
    assert.doesNotMatch(config.slice(aiStart, aiEnd), /pdf-automation|pdfAutomation|\/api\/pdf-automation-rules/i);
    assert.match(config, /id: "account"[\s\S]*id: "pdf-automation"/);
    assert.match(config, /pdfForm\.addEventListener\("submit"/);
    assert.equal((config.match(/form\.addEventListener\("submit"/g) || []).length, 2);
    assert.match(server, /app\.get\("\/api\/pdf-automation-rules"/);
    assert.doesNotMatch(server, /app\.get\("\/api\/pdf-automation-rules\/:id\/file"/);
    assert.match(server, /import \{ PDF_AUTOMATION_MULTER_OPTIONS \} from "\.\/lib\/pdf-upload-options\.js"/);
    assert.match(server, /const pdfAutomationUpload = multer\(PDF_AUTOMATION_MULTER_OPTIONS\)/);
  });

  const failed = results.filter((item) => !item.pass);
  for (const item of results) {
    console.log(`${item.code} = ${item.pass ? "PASS" : "FAIL"}  ${item.description}${item.error ? `\n      -> ${item.error}` : ""}`);
  }
  console.log(`\nPDF AUTOMATION: ${results.length - failed.length}/${results.length} PASS`);
  console.log("REAL_ZALO_SEND = 0");
  console.log("REAL_PROVIDER_CALL = 0");
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Khung PDF automation test hong:", error);
  process.exit(2);
});
