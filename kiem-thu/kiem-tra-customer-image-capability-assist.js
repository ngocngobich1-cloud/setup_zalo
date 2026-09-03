/**
 * UAT regression: Zalo Customer image -> docTep Evidence -> Primary final.
 * Tat ca provider/Zalo boundary deu la fixture; khong co network call that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeIncomingMessage } from "../lib/message-utils.js";
import {
  CAPABILITIES,
  ROUTE_MODES,
  SURFACES,
  createCallBudget,
  routeModelRequest,
} from "../lib/ai-model-router.js";
import { classifyProviderFailure } from "../lib/provider-failure.js";
import * as docTep from "../lib/doc-tep.js";
import * as opencode from "../lib/opencode.js";
import * as ownerCredentials from "../lib/owner-credentials.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const results = [];
const OWNER = "owner-uat-image";
ownerCredentials.configureCurrentOwnerResolver(() => OWNER);

const catalog = [
  {
    id: "primary",
    models: [
      {
        id: "primary/text",
        capabilities: { text: true, image: false, file: false, web: false, toolcall: false },
      },
      {
        id: "primary/vision",
        capabilities: { text: true, image: true, file: true, web: false, toolcall: false },
      },
    ],
  },
  {
    id: "secondary",
    models: [{
      id: "secondary/vision",
      capabilities: { text: true, image: true, file: true, web: false, toolcall: false },
    }],
  },
];

function extractFunction(moduleSource, signature) {
  const start = moduleSource.indexOf(signature);
  assert.ok(start >= 0, `Khong tim thay function: ${signature}`);
  const bodyStart = moduleSource.indexOf("{", start + signature.length);
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
    if (char === "}" && --depth === 0) return moduleSource.slice(start, index + 1);
  }
  assert.fail(`Function body khong dong: ${signature}`);
}

function compileFunction(moduleSource, signature, dependencies) {
  const functionSource = extractFunction(moduleSource, signature).replace(/^export\s+/, "");
  const name = functionSource.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1];
  const names = Object.keys(dependencies);
  const factory = Function(...names, `"use strict";\n${functionSource}\nreturn ${name};`);
  return factory(...names.map((key) => dependencies[key]));
}

async function test(id, name, operation) {
  try {
    await operation();
    results.push({ id, pass: true });
    console.log(`PASS ${id} - ${name}`);
  } catch (error) {
    results.push({ id, pass: false, error: error.message });
    console.error(`FAIL ${id} - ${name}: ${error.stack || error.message}`);
  }
}

const aiSource = fs.readFileSync(path.join(REPO, "lib", "ai-chat.js"), "utf8");
const zaloSource = fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8");
const customerRequiredCapabilities = compileFunction(
  aiSource,
  "function customerRequiredCapabilities",
  { CAPABILITIES }
);
const gopThanhMotTin = compileFunction(zaloSource, "function gopThanhMotTin", {});

function uatTurn() {
  // Sanitized 1:1 shape from DB rows 8222270212287 (chat.photo, 17:11:55)
  // and 8222270695143 (webchat, 17:12:03). Only IDs, name, host/path and
  // preview bytes are replaced; every field and nesting level is preserved.
  const photoRaw = {
    type: 0,
    threadId: "uat-private-thread",
    isSelf: false,
    data: {
      actionId: "sanitized-photo-action",
      msgId: "sanitized-photo-message",
      cliMsgId: "sanitized-photo-client-message",
      msgType: "chat.photo",
      uidFrom: "customer-1",
      idTo: OWNER,
      dName: "Khách UAT",
      ts: "1788430315675",
      status: 1,
      content: {
        title: "",
        description: "",
        href: "https://fixture.local/gr/jpg/sanitized/agribank-receipt.jpg",
        thumb: "https://fixture.local/gr/jpg/sanitized/agribank-receipt.jpg",
        childnumber: 0,
        action: "",
        params: JSON.stringify({
          height: 2250,
          thumb_width: 360,
          thumb_height: 614,
          tracking: { subsource: "0", source: 0 },
          hd: "https://fixture.local/gr/jpg/sanitized/agribank-receipt.jpg",
          width: 1320,
          convertible: "jxl",
        }),
        type: "",
      },
      notify: "1",
      ttl: 0,
      userId: "0",
      uin: "0",
      topOut: "0",
      topOutTimeOut: "0",
      topOutImprTimeOut: "0",
      propertyExt: {
        color: -1,
        size: -1,
        type: 1,
        subType: 0,
        ext: JSON.stringify({ shouldParseLinkOrContact: 0 }),
      },
      paramsExt: { countUnread: 1, containType: 0, platformType: 0 },
      previewThumb: "sanitized-preview-base64",
      cmd: 501,
      st: 3,
      at: 0,
      realMsgId: "0",
    },
  };
  const questionRaw = {
    type: 0,
    threadId: "uat-private-thread",
    isSelf: false,
    data: {
      actionId: "sanitized-text-action",
      msgId: "sanitized-text-message",
      cliMsgId: "sanitized-text-client-message",
      msgType: "webchat",
      uidFrom: "customer-1",
      idTo: OWNER,
      dName: "Khách UAT",
      ts: "1788430323193",
      status: 1,
      content: "Po đọc ảnh này nhé",
      notify: "1",
      ttl: 0,
      userId: "0",
      uin: "0",
      topOut: "0",
      topOutTimeOut: "0",
      topOutImprTimeOut: "0",
      propertyExt: {
        color: -1,
        size: -1,
        type: 1,
        subType: 0,
        ext: JSON.stringify({ emoji: { content: 0 }, shouldParseLinkOrContact: 1 }),
      },
      paramsExt: { countUnread: 1, containType: 0, platformType: 0 },
      cmd: 501,
      st: 3,
      at: 0,
      realMsgId: "0",
    },
  };
  return gopThanhMotTin([
    normalizeIncomingMessage(photoRaw),
    normalizeIncomingMessage(questionRaw),
  ]);
}

function pngBytes(size = 24 * 1024) {
  const bytes = Buffer.alloc(size, 0x61);
  bytes[0] = 0x89;
  bytes.write("PNG", 1, "ascii");
  return bytes;
}

function installProviderFixture({ imageSize = 24 * 1024, evidence = "Biên lai hiển thị giao dịch 500.000 đồng." } = {}) {
  const specialistCalls = [];
  let sessionCounter = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "fixture.local") {
      return new Response(pngBytes(imageSize), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (parsed.pathname === "/session" && options.method === "POST") {
      return Response.json({ id: `image-specialist-${++sessionCounter}` });
    }
    if (/^\/session\/image-specialist-\d+\/message$/.test(parsed.pathname)) {
      const body = JSON.parse(options.body);
      specialistCalls.push({
        model: `${body.model.providerID}/${body.model.modelID}`,
        hasImage: body.parts.some((part) => part.type === "file" && /^data:image\//.test(part.url)),
      });
      return Response.json({
        info: {
          providerID: body.model.providerID,
          modelID: body.model.modelID,
          tokens: { input: 7, output: 4 },
        },
        parts: [{ type: "text", text: evidence }],
      });
    }
    if (/^\/session\/image-specialist-\d+$/.test(parsed.pathname) && options.method === "DELETE") {
      return Response.json(true);
    }
    throw new Error(`Unexpected fixture request: ${options.method || "GET"} ${url}`);
  };
  return {
    specialistCalls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    opencodeBaseUrl: "http://fixture-opencode",
    opencodeAgent: "general",
    opencodeModel: "primary/text",
    opencodeFallbackModel: "secondary/vision",
    opencodeFallbackCapabilities: [CAPABILITIES.IMAGE_INPUT],
    opencodeFailoverEnabled: true,
    capabilityRoutingEnabled: true,
    // Exact UAT runtime state: legacy global switch was OFF.
    docTep: false,
    ...overrides,
  };
}

function compileGenerateReply(finalCalls) {
  return compileFunction(aiSource, "export async function generateReply", {
    layChuTaiKhoan: () => OWNER,
    getConfig: () => null,
    isAiChatReady: () => true,
    customerRequiredCapabilities,
    createCallBudget,
    opencode: {
      loadChatProviders: async () => catalog,
      ensureSession: async () => ({ sessionId: "primary-final-session", created: true, turns: 0 }),
      sendPrompt: async (config, sessionId, prompt) => {
        finalCalls.push({ model: config.opencodeModel, sessionId, prompt });
        return {
          reply: "Đã đọc biên lai từ Evidence.",
          tokens: { input: 3, output: 2 },
          model: config.opencodeModel,
        };
      },
    },
    buildBootstrapContext: async () => ({
      recentHistory: "", threadTitle: "UAT", hasKnowledge: false, soTinLichSu: 0,
    }),
    ThreadType: { User: 0 },
    docTep,
    ganNhanTuDong: null,
    NHAN_PDF: "pdf",
    customerMemory: { bocPrompt: async (_sessionId, _message, text) => text, quenPhien: () => undefined },
    mocHienTai: () => "03/09/2026 17:00",
    emailCheck: { timEmailTrongTin: () => null },
    addLog: async () => undefined,
    bumpSessionTurns: async () => undefined,
    classifyProviderFailure,
    routeModelRequest,
    SURFACES,
    ROUTE_MODES,
    ownerFacingFailureMessage: () => "AI chưa sẵn sàng.",
    SKIP_TOKEN: "SKIP",
    console: { warn: () => undefined },
  });
}

async function withCredentialFixture(providerIds, operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "customer-image-uat-"));
  opencode.markCredentialPlaneReady(OWNER, providerIds, directory);
  try {
    return await operation();
  } finally {
    opencode.markCredentialPlaneFailed();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

await test("CASE-1", "real UAT shape with doc_tep OFF uses one Secondary image Evidence call then one Primary final call", async () => {
  const turn = uatTurn();
  assert.equal(turn.msgType, "chat.photo");
  assert.equal(turn.rawJson.data.msgType, "chat.photo");
  assert.equal(turn.rawJson.data.content.title, "");
  assert.equal(turn.rawJson.data.content.href, turn.rawJson.data.content.thumb);
  assert.deepEqual(Object.keys(turn.rawJson.data.content), [
    "title", "description", "href", "thumb", "childnumber", "action", "params", "type",
  ]);
  assert.deepEqual(Object.keys(JSON.parse(turn.rawJson.data.content.params)), [
    "height", "thumb_width", "thumb_height", "tracking", "hd", "width", "convertible",
  ]);
  assert.equal(turn.rawJson.data.previewThumb, "sanitized-preview-base64");
  assert.match(turn.content, /Po đọc ảnh này nhé/);
  assert.deepEqual(customerRequiredCapabilities(turn), [CAPABILITIES.TEXT, CAPABILITIES.IMAGE_INPUT]);

  const provider = installProviderFixture();
  const finalCalls = [];
  try {
    await withCredentialFixture(["primary", "secondary"], async () => {
      const result = await compileGenerateReply(finalCalls)(turn.content, turn, OWNER, baseConfig());
      assert.equal(result.error, null);
      assert.equal(result.reply, "Đã đọc biên lai từ Evidence.");
    });
    assert.deepEqual(provider.specialistCalls, [{ model: "secondary/vision", hasImage: true }]);
    assert.equal(finalCalls.length, 1);
    assert.equal(finalCalls[0].model, "primary/text");
    assert.match(finalCalls[0].prompt, /Biên lai hiển thị giao dịch 500\.000 đồng/);
    assert.match(finalCalls[0].prompt, /NỘI DUNG TỆP KHÁCH VỪA GỬI/);
    assert.equal(provider.specialistCalls.length + finalCalls.length, 2);
  } finally {
    provider.restore();
  }
});

await test("CASE-2", "Secondary IMAGE permission OFF does not call Secondary and gives Primary a customer-safe fallback", async () => {
  const provider = installProviderFixture();
  const finalCalls = [];
  try {
    await withCredentialFixture(["primary", "secondary"], async () => {
      const turn = uatTurn();
      const result = await compileGenerateReply(finalCalls)(turn.content, turn, OWNER, baseConfig({
        opencodeFallbackCapabilities: [],
      }));
      assert.equal(result.error, null);
    });
    assert.equal(provider.specialistCalls.length, 0);
    assert.equal(finalCalls.length, 1);
    assert.match(finalCalls[0].prompt, /GHI CHÚ HỆ THỐNG/);
    assert.match(finalCalls[0].prompt, /chưa xác định chính xác nội dung/);
  } finally {
    provider.restore();
  }
});

await test("CASE-3", "missing Secondary owner credential fails closed without a global fallback", async () => {
  const provider = installProviderFixture();
  const finalCalls = [];
  try {
    await withCredentialFixture(["primary"], async () => {
      const turn = uatTurn();
      const result = await compileGenerateReply(finalCalls)(turn.content, turn, OWNER, baseConfig());
      assert.equal(result.error, null);
    });
    assert.equal(provider.specialistCalls.length, 0);
    assert.equal(finalCalls.length, 1);
    assert.equal(finalCalls[0].model, "primary/text");
    assert.match(finalCalls[0].prompt, /GHI CHÚ HỆ THỐNG/);
  } finally {
    provider.restore();
  }
});

await test("CASE-4", "image-capable Primary reads the image and Secondary is not called", async () => {
  const provider = installProviderFixture();
  const finalCalls = [];
  try {
    await withCredentialFixture(["primary", "secondary"], async () => {
      const turn = uatTurn();
      const result = await compileGenerateReply(finalCalls)(turn.content, turn, OWNER, baseConfig({
        opencodeModel: "primary/vision",
      }));
      assert.equal(result.error, null);
    });
    assert.deepEqual(provider.specialistCalls, [{ model: "primary/vision", hasImage: true }]);
    assert.equal(finalCalls.length, 1);
    assert.equal(finalCalls[0].model, "primary/vision");
    assert.equal(provider.specialistCalls.some((call) => call.model === "secondary/vision"), false);
  } finally {
    provider.restore();
  }
});

await test("CASE-5", "image smaller than 20KB is skipped before routing", async () => {
  const provider = installProviderFixture({ imageSize: 19 * 1024 });
  const finalCalls = [];
  try {
    await withCredentialFixture(["primary", "secondary"], async () => {
      const turn = uatTurn();
      const result = await compileGenerateReply(finalCalls)(turn.content, turn, OWNER, baseConfig());
      assert.equal(result.error, null);
    });
    assert.equal(provider.specialistCalls.length, 0);
    assert.equal(finalCalls.length, 1);
    assert.doesNotMatch(finalCalls[0].prompt, /NỘI DUNG TỆP KHÁCH VỪA GỬI/);
    assert.doesNotMatch(finalCalls[0].prompt, /GHI CHÚ HỆ THỐNG/);
  } finally {
    provider.restore();
  }
});

await test("CASE-6", "Secondary output becomes the existing khoiChoAgent Evidence in Primary context", async () => {
  const evidence = "EVIDENCE-UAT-UNIQUE: mã giao dịch ABC123";
  const provider = installProviderFixture({ evidence });
  const finalCalls = [];
  try {
    await withCredentialFixture(["primary", "secondary"], async () => {
      const turn = uatTurn();
      await compileGenerateReply(finalCalls)(turn.content, turn, OWNER, baseConfig());
    });
    assert.equal(provider.specialistCalls.length, 1);
    assert.equal(finalCalls.length, 1);
    assert.match(finalCalls[0].prompt, /EVIDENCE-UAT-UNIQUE: mã giao dịch ABC123/);
    assert.match(finalCalls[0].prompt, /Hệ thống đã đọc hộ/);
  } finally {
    provider.restore();
  }
});

const failed = results.filter((result) => !result.pass);
console.log(`\nCUSTOMER_IMAGE_UAT_SUMMARY ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
