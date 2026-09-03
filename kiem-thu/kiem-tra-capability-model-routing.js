/** Focused V1 acceptance harness. Synthetic catalog/runtime only; zero provider/Zalo call. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITIES,
  ROUTE_MODES,
  SURFACES,
  capabilityRoutingEnabled,
  createCallBudget,
  detectExplicitWebIntent,
  normalizeFailoverEnabled,
  normalizeFallbackCapabilities,
  routeModelRequest,
  validateRoutingConfig,
} from "../lib/ai-model-router.js";
import { FAILURE_CODES, classifyProviderFailure } from "../lib/provider-failure.js";
import * as opencode from "../lib/opencode.js";
import * as docTep from "../lib/doc-tep.js";
import * as training from "../lib/training.js";
import * as ownerCredentials from "../lib/owner-credentials.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const results = [];
let currentOwner = "owner-a";
ownerCredentials.configureCurrentOwnerResolver(() => currentOwner);

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

function extractRegisteredHandler(moduleSource, method, route) {
  const marker = `app.${method}("${route}", `;
  const registrationStart = moduleSource.indexOf(marker);
  assert.ok(registrationStart >= 0, `Khong co ${method.toUpperCase()} ${route}`);
  assert.equal(moduleSource.indexOf(marker, registrationStart + marker.length), -1, `Route ${route} bi register trung`);
  const callbackStart = moduleSource.indexOf("async (req, res) =>", registrationStart + marker.length);
  assert.ok(callbackStart >= 0, `Route ${route} khong co async handler`);
  const bodyStart = moduleSource.indexOf("{", callbackStart);
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
    if (char === "}" && --depth === 0) return moduleSource.slice(callbackStart, index + 1);
  }
  assert.fail(`Handler ${method.toUpperCase()} ${route} khong dong`);
}

function compileArrowFunction(functionSource, dependencies) {
  const names = Object.keys(dependencies);
  const factory = Function(...names, `"use strict"; return (${functionSource});`);
  return factory(...names.map((key) => dependencies[key]));
}

async function test(code, description, operation) {
  try {
    await operation();
    results.push({ code, description, pass: true });
  } catch (error) {
    results.push({ code, description, pass: false, error: error.stack || error.message });
  }
}

const catalog = [{
  id: "primary",
  models: [{
    id: "primary/text",
    capabilities: { text: true, image: false, file: false, web: false, toolcall: false },
  }, {
    id: "primary/vision",
    capabilities: { text: true, image: true, file: true, web: false, toolcall: true },
  }],
}, {
  id: "secondary",
  models: [{
    id: "secondary/assist",
    capabilities: { text: true, image: true, file: true, web: true, toolcall: true },
  }, {
    id: "secondary/text",
    capabilities: { text: true, image: false, file: false, web: false, toolcall: false },
  }, {
    id: "secondary/web-only",
    capabilities: { text: true, image: false, file: false, web: true, toolcall: true },
  }],
}];

function route(overrides = {}) {
  return routeModelRequest({
    ownerUid: "owner-a",
    surface: SURFACES.COMMANDER,
    primaryModel: "primary/text",
    secondaryModel: "secondary/assist",
    enabledSecondaryCapabilities: [CAPABILITIES.IMAGE_INPUT, CAPABILITIES.FILE_INPUT, CAPABILITIES.WEB_SEARCH],
    failoverEnabled: true,
    requiredCapabilities: [CAPABILITIES.TEXT],
    catalogCapabilities: catalog,
    webProbeState: "SUPPORTED",
    routingEnabled: true,
    ...overrides,
  });
}

await test("A01-A06", "config defaults/normalization reject malformed values and keep canonical order", () => {
  assert.deepEqual(normalizeFallbackCapabilities("[]"), []);
  assert.deepEqual(
    normalizeFallbackCapabilities(["WEB_SEARCH", "IMAGE_INPUT", "IMAGE_INPUT", "FILE_INPUT"], { publicApi: true }),
    ["IMAGE_INPUT", "FILE_INPUT", "WEB_SEARCH"]
  );
  assert.throws(() => normalizeFallbackCapabilities("not-json"), /JSON array/);
  assert.throws(() => normalizeFallbackCapabilities(["AUDIO"], { publicApi: true }), /không hợp lệ/);
  assert.throws(() => normalizeFallbackCapabilities("[]", { publicApi: true }), /array of strings/);
  assert.equal(normalizeFailoverEnabled(0), false);
  assert.equal(normalizeFailoverEnabled(1), true);
  assert.throws(() => normalizeFailoverEnabled("true", { publicApi: true }), /boolean/);
});

await test("A07-A08", "active routing requires distinct Secondary", () => {
  assert.throws(() => validateRoutingConfig({
    primaryModel: "primary/text",
    secondaryModel: "",
    fallbackCapabilities: ["IMAGE_INPUT"],
    failoverEnabled: false,
  }), /chọn AI bổ trợ/);
  assert.throws(() => validateRoutingConfig({
    primaryModel: "primary/text",
    secondaryModel: "primary/text",
    fallbackCapabilities: [],
    failoverEnabled: true,
  }), /hai provider\/model khác nhau/);
  assert.doesNotThrow(() => validateRoutingConfig({
    primaryModel: "primary/text",
    secondaryModel: "primary/vision",
    fallbackCapabilities: ["IMAGE_INPUT"],
    failoverEnabled: false,
    catalogCapabilities: catalog,
  }));
});

await test("A11-A16", "catalog capability projection follows exact text/attachment/image/pdf/toolcall contract", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "capability-catalog-"));
  const originalFetch = globalThis.fetch;
  opencode.markCredentialPlaneReady("owner-a", ["primary"], temp);
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    assert.equal(pathname, "/config/providers");
    return Response.json({ providers: [{
      id: "primary",
      name: "Primary",
      models: {
        full: {
          name: "Full",
          limit: { context: 8192 },
          capabilities: {
            attachment: true,
            toolcall: true,
            input: { text: true, image: true, pdf: true },
            output: { text: true },
          },
        },
        noAttachment: {
          name: "No attachment",
          limit: { context: 9000 },
          capabilities: { input: { text: true, image: true, pdf: true }, output: { text: true } },
        },
        tiny: {
          name: "Tiny",
          limit: { context: 4096 },
          capabilities: { attachment: true, input: { text: true }, output: { text: true } },
        },
      },
    }] });
  };
  try {
    const projected = await opencode.loadChatProviders({ opencodeBaseUrl: "http://fixture" });
    assert.equal(projected[0].models.length, 2);
    const full = projected[0].models.find((model) => model.id === "primary/full");
    const noAttachment = projected[0].models.find((model) => model.id === "primary/noAttachment");
    assert.deepEqual(full.capabilities, {
      text: true, image: true, file: true, web: false, toolcall: true,
    });
    assert.equal(noAttachment.capabilities.image, false);
    assert.equal(noAttachment.capabilities.file, false);
  } finally {
    globalThis.fetch = originalFetch;
    opencode.markCredentialPlaneFailed();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

await test("F1-RUNTIME", "routing OFF restores the Primary image guard and never reaches Secondary", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "commander-image-off-"));
  const originalFetch = globalThis.fetch;
  let imageCapable = false;
  let catalogCalls = 0;
  currentOwner = "owner-a";
  opencode.markCredentialPlaneReady("owner-a", ["primary"], temp);
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(new URL(url).pathname, "/config/providers");
    assert.equal(options.method, "GET");
    catalogCalls += 1;
    return Response.json({
      providers: [{
        id: "primary",
        models: {
          text: { capabilities: { input: { image: imageCapable } } },
        },
      }],
    });
  };

  const config = {
    opencodeBaseUrl: "http://fixture",
    opencodeModel: "primary/text",
    opencodeFallbackModel: "secondary/assist",
    capabilityRoutingEnabled: false,
  };
  try {
    assert.equal(
      await ownerCredentials.withCurrentOwnerPlaneRead(
        "owner-a",
        () => training.modelDocDuocAnh(config, "owner-a")
      ),
      false
    );
    imageCapable = true;
    assert.equal(
      await ownerCredentials.withCurrentOwnerPlaneRead(
        "owner-a",
        () => training.modelDocDuocAnh(config, "owner-a")
      ),
      true
    );
    assert.equal(catalogCalls, 2);

    const trainingSource = fs.readFileSync(path.join(REPO, "lib", "training.js"), "utf8");
    let primaryRuns = 0;
    let readSetRuns = 0;
    let secondaryCatalogRuns = 0;
    let primarySupportsImage = false;
    const guiTinHuanLuyen = compileFunction(trainingSource, "export async function guiTinHuanLuyen", {
      withCurrentOwnerPlaneRead: async (_ownerUid, operation) => operation(),
      layCauHinhHieuLuc: async () => ({ ...config }),
      capabilityRoutingEnabled: () => false,
      isSupportedUpload: () => true,
      MAX_FILES_PER_MESSAGE: 6,
      ANH_HOP_LE: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      modelDocDuocAnh: async () => primarySupportsImage,
      loadChatProviders: async () => {
        secondaryCatalogRuns += 1;
        return catalog;
      },
      requiredCapabilitiesForCommander: () => [CAPABILITIES.TEXT, CAPABILITIES.IMAGE_INPUT],
      routeModelRequest,
      SURFACES,
      webProbeStateForModel: () => "UNKNOWN",
      ROUTE_MODES,
      unavailableMessage: () => "unavailable",
      splitModel: opencode.splitModel,
      withOwnerCredentialReadSet: async (ownerUid, providers, operation) => {
        readSetRuns += 1;
        assert.equal(ownerUid, "owner-a");
        assert.deepEqual(providers, ["primary"]);
        return operation();
      },
      ensureSession: async () => ({ sessionId: "primary-session" }),
      guiVaLuu: async (_ownerUid, usedConfig, sessionId) => {
        primaryRuns += 1;
        assert.equal(usedConfig.opencodeModel, "primary/text");
        assert.equal(sessionId, "primary-session");
        return "primary reply";
      },
      createCallBudget,
    });
    const image = { mimetype: "image/png", originalname: "fixture.png", size: 10, buffer: Buffer.from("x") };
    await assert.rejects(
      () => guiTinHuanLuyen("owner-a", "xem ảnh", [image]),
      /Model đang chọn không đọc được ảnh/
    );
    assert.equal(readSetRuns, 0);
    assert.equal(primaryRuns, 0);
    assert.equal(secondaryCatalogRuns, 0);

    primarySupportsImage = true;
    assert.equal(await guiTinHuanLuyen("owner-a", "xem ảnh", [image]), "primary reply");
    assert.equal(readSetRuns, 1);
    assert.equal(primaryRuns, 1);
    assert.equal(secondaryCatalogRuns, 0);
  } finally {
    globalThis.fetch = originalFetch;
    opencode.markCredentialPlaneFailed();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

await test("A17-A27", "Customer/Commander image/PDF routes use Primary or one Secondary Evidence path", () => {
  assert.equal(route({ requiredCapabilities: ["TEXT", "IMAGE_INPUT"] }).routeMode, ROUTE_MODES.CAPABILITY_ASSIST);
  assert.equal(route({
    primaryModel: "primary/vision",
    requiredCapabilities: ["TEXT", "IMAGE_INPUT", "FILE_INPUT"],
  }).routeMode, ROUTE_MODES.PRIMARY_ONLY);
  assert.equal(route({
    surface: SURFACES.CUSTOMER,
    requiredCapabilities: ["TEXT", "IMAGE_INPUT"],
  }).routeMode, ROUTE_MODES.CAPABILITY_ASSIST);
  assert.equal(route({
    enabledSecondaryCapabilities: [],
    requiredCapabilities: ["TEXT", "FILE_INPUT"],
  }).routeMode, ROUTE_MODES.UNAVAILABLE);
  const docSource = fs.readFileSync(path.join(REPO, "lib", "doc-tep.js"), "utf8");
  assert.match(docSource, /docVaTomTat[\s\S]*routeModelRequest/);
  assert.equal((docSource.match(/export async function docVaTomTat/g) || []).length, 1);
  const aiSource = fs.readFileSync(path.join(REPO, "lib", "ai-chat.js"), "utf8");
  assert.doesNotMatch(aiSource, /runOneShot[\s\S]*type:\s*"file"/);
  assert.doesNotMatch(docSource, /huấn luyện viên cuộc sống/);
  assert.match(docSource, /NHO_NHAT_BYTE = 20 \* 1024/);
});

await test("A17-A20-RUNTIME", "docTep canonical seam selects Primary or Secondary from mocked live capability", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-tep-route-"));
  const originalFetch = globalThis.fetch;
  const messageModels = [];
  let session = 0;
  opencode.markCredentialPlaneReady("owner-a", ["primary", "secondary"], temp);
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/session" && options.method === "POST") return Response.json({ id: `doc-${++session}` });
    if (/^\/session\/doc-\d+\/message$/.test(pathname)) {
      const body = JSON.parse(options.body);
      messageModels.push(`${body.model.providerID}/${body.model.modelID}`);
      return Response.json({
        info: { providerID: body.model.providerID, modelID: body.model.modelID, tokens: { input: 1, output: 1 } },
        parts: [{ type: "text", text: "visible evidence" }],
      });
    }
    if (/^\/session\/doc-\d+$/.test(pathname) && options.method === "DELETE") return Response.json(true);
    throw new Error(`unexpected fixture route ${pathname}`);
  };
  const baseConfig = {
    opencodeBaseUrl: "http://fixture",
    opencodeAgent: "general",
    opencodeModel: "primary/text",
    opencodeFallbackModel: "secondary/assist",
    opencodeFallbackCapabilities: ["IMAGE_INPUT", "FILE_INPUT"],
    opencodeFailoverEnabled: true,
    capabilityRoutingEnabled: true,
  };
  try {
    const imageAssist = await docTep.docVaTomTat(
      baseConfig,
      { mime: "image/png", ten: "image.png", buffer: Buffer.from("fixture") },
      { ownerUid: "owner-a", catalogCapabilities: catalog, callBudget: createCallBudget() }
    );
    assert.equal(imageAssist.routeDecision.routeMode, ROUTE_MODES.CAPABILITY_ASSIST);
    const pdfAssist = await docTep.docVaTomTat(
      baseConfig,
      { mime: "application/pdf", ten: "doc.pdf", buffer: Buffer.from("%PDF-fixture") },
      { ownerUid: "owner-a", catalogCapabilities: catalog, callBudget: createCallBudget() }
    );
    assert.equal(pdfAssist.routeDecision.routeMode, ROUTE_MODES.CAPABILITY_ASSIST);
    const primaryImage = await docTep.docVaTomTat(
      { ...baseConfig, opencodeModel: "primary/vision" },
      { mime: "image/png", ten: "image.png", buffer: Buffer.from("fixture") },
      { ownerUid: "owner-a", catalogCapabilities: catalog, callBudget: createCallBudget() }
    );
    assert.equal(primaryImage.routeDecision.routeMode, ROUTE_MODES.PRIMARY_ONLY);
    const primaryPdf = await docTep.docVaTomTat(
      { ...baseConfig, opencodeModel: "primary/vision" },
      { mime: "application/pdf", ten: "doc.pdf", buffer: Buffer.from("%PDF-fixture") },
      { ownerUid: "owner-a", catalogCapabilities: catalog, callBudget: createCallBudget() }
    );
    assert.equal(primaryPdf.routeDecision.routeMode, ROUTE_MODES.PRIMARY_ONLY);
    assert.deepEqual(messageModels, [
      "secondary/assist",
      "secondary/assist",
      "primary/vision",
      "primary/vision",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    opencode.markCredentialPlaneFailed();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

await test("A28-A36", "Web intent is explicit, Customer is blocked, and tool set is immutable/minimal", () => {
  for (const phrase of ["tìm trên web", "tìm trên mạng", "tra cứu trên mạng", "search web", "search the web", "web search"]) {
    assert.equal(detectExplicitWebIntent(`  Hãy   ${phrase.toUpperCase()} giúp chị `), true);
  }
  for (const phrase of ["mới nhất", "hiện tại", "latest", "current"]) {
    assert.equal(detectExplicitWebIntent(phrase), false);
  }
  assert.equal(route({
    surface: SURFACES.CUSTOMER,
    requiredCapabilities: ["TEXT", "WEB_SEARCH"],
  }).reason, "CUSTOMER_WEB_DISABLED_V1");
  assert.equal(route({
    requiredCapabilities: ["TEXT", "WEB_SEARCH"],
    webProbeState: "UNKNOWN",
  }).reason, "SECONDARY_CAPABILITY_MISSING");
  assert.equal(route({ requiredCapabilities: ["TEXT", "WEB_SEARCH"] }).routeMode, ROUTE_MODES.CAPABILITY_ASSIST);
  assert.equal(route({
    secondaryModel: "secondary/web-only",
    requiredCapabilities: ["TEXT", "IMAGE_INPUT", "WEB_SEARCH"],
  }).reason, "SECONDARY_CAPABILITY_MISSING");
  assert.equal(Object.isFrozen(opencode.KHONG_TOOL), true);
  assert.equal(Object.isFrozen(opencode.TOOL_WEB), true);
  assert.deepEqual(
    Object.entries(opencode.TOOL_WEB).filter(([, enabled]) => enabled).map(([name]) => name).sort(),
    ["webfetch", "websearch"]
  );
  assert.equal(opencode.KHONG_TOOL.websearch, false);
  assert.equal(opencode.KHONG_TOOL.webfetch, false);
});

await test("A33", "mocked Web probe requires observed completed websearch part", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "web-probe-"));
  const originalFetch = globalThis.fetch;
  let mode = "supported";
  let session = 0;
  const messageBodies = [];
  opencode.clearWebProbeCache();
  opencode.markCredentialPlaneReady("owner-a", ["primary"], temp);
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/session" && options.method === "POST") return Response.json({ id: `s-${++session}` });
    if (/^\/session\/s-\d+\/message$/.test(pathname)) {
      messageBodies.push(JSON.parse(options.body));
      if (mode === "supported") return Response.json({
        info: { tokens: { input: 1, output: 1 } },
        parts: [
          { type: "tool", tool: "websearch", state: { status: "completed", output: "https://opencode.ai" } },
          { type: "text", text: "OpenCode — https://opencode.ai" },
        ],
      });
      if (mode === "no-evidence") return Response.json({ info: {}, parts: [{ type: "text", text: "I searched." }] });
      if (mode === "unsupported") return Response.json({
        info: { error: { status: 400, data: { message: "permission for websearch tool not supported" } } },
        parts: [],
      });
      return Response.json({
        info: { error: { status: 402, data: { message: "billing credit quota exhausted" } } },
        parts: [],
      });
    }
    if (/^\/session\/s-\d+$/.test(pathname) && options.method === "DELETE") return Response.json(true);
    throw new Error(`unexpected fixture route ${pathname}`);
  };
  try {
    assert.deepEqual(
      await opencode.probeWebSupport({ opencodeBaseUrl: "http://fixture", opencodeModel: "primary/full" }, "primary/full"),
      { supported: true, state: "SUPPORTED" }
    );
    assert.equal(opencode.getWebProbeState("primary/full"), "SUPPORTED");
    assert.deepEqual(
      Object.entries(messageBodies.at(-1).tools).filter(([, enabled]) => enabled).map(([name]) => name).sort(),
      ["webfetch", "websearch"]
    );
    mode = "no-evidence";
    assert.equal((await opencode.probeWebSupport(
      { opencodeBaseUrl: "http://fixture", opencodeModel: "primary/no-evidence" },
      "primary/no-evidence"
    )).state, "UNKNOWN");
    assert.equal(opencode.getWebProbeState("primary/no-evidence"), "UNKNOWN");
    mode = "unsupported";
    assert.equal((await opencode.probeWebSupport(
      { opencodeBaseUrl: "http://fixture", opencodeModel: "primary/unsupported" },
      "primary/unsupported"
    )).state, "UNSUPPORTED");
    mode = "quota";
    await assert.rejects(() => opencode.probeWebSupport(
      { opencodeBaseUrl: "http://fixture", opencodeModel: "primary/quota" },
      "primary/quota"
    ));
    assert.equal(opencode.getWebProbeState("primary/quota"), "UNKNOWN");
  } finally {
    globalThis.fetch = originalFetch;
    opencode.markCredentialPlaneFailed();
    opencode.clearWebProbeCache();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

await test("A37-A43", "shared failure classifier separates failover-safe and owner/control failures", () => {
  assert.equal(classifyProviderFailure({ status: 429 }), FAILURE_CODES.RATE_LIMITED);
  assert.equal(classifyProviderFailure({ status: 402 }), FAILURE_CODES.QUOTA_EXHAUSTED);
  assert.equal(classifyProviderFailure({ status: 429, message: "billing credit rate limit" }), FAILURE_CODES.QUOTA_EXHAUSTED);
  assert.equal(classifyProviderFailure({ status: 401 }), FAILURE_CODES.INVALID_KEY);
  assert.equal(classifyProviderFailure({ status: 403 }), FAILURE_CODES.INVALID_KEY);
  assert.equal(classifyProviderFailure({ status: 503 }), FAILURE_CODES.PROVIDER_UNAVAILABLE);
  assert.equal(classifyProviderFailure(new Error("fetch failed ECONNREFUSED")), FAILURE_CODES.PROVIDER_UNAVAILABLE);
  assert.equal(classifyProviderFailure({ code: "OPENCODE_TIMEOUT" }), FAILURE_CODES.TIMEOUT);
  assert.equal(classifyProviderFailure({ code: "CREDENTIAL_OPERATION_ABORTED" }), FAILURE_CODES.CREDENTIAL_OPERATION_ABORTED);
  assert.equal(classifyProviderFailure({ infoError: { status: 400, data: { message: "model not found" } } }), FAILURE_CODES.BAD_REQUEST);
  assert.equal(classifyProviderFailure(new Error("mystery")), FAILURE_CODES.UNKNOWN_PROVIDER_ERROR);
});

await test("A44-A59", "runtime failover gates capability, reason and exact two-call budget", () => {
  assert.equal(route({
    phase: "FAILOVER", classifiedReason: "RATE_LIMITED", failoverEnabled: false, callsUsed: 1,
  }).routeMode, ROUTE_MODES.UNAVAILABLE);
  assert.equal(route({
    phase: "FAILOVER", classifiedReason: "RATE_LIMITED", callsUsed: 1,
  }).routeMode, ROUTE_MODES.RUNTIME_FAILOVER);
  for (const reason of ["INVALID_KEY", "QUOTA_EXHAUSTED", "BAD_REQUEST", "UNKNOWN_PROVIDER_ERROR", "OWNER_CONTEXT_CHANGED"]) {
    assert.equal(route({ phase: "FAILOVER", classifiedReason: reason, callsUsed: 1 }).routeMode, ROUTE_MODES.UNAVAILABLE);
  }
  assert.equal(route({
    phase: "FAILOVER",
    classifiedReason: "TIMEOUT",
    callsUsed: 1,
    requiredCapabilities: ["TEXT", "IMAGE_INPUT"],
    enabledSecondaryCapabilities: [],
  }).routeMode, ROUTE_MODES.UNAVAILABLE);
  assert.equal(route({
    phase: "FAILOVER",
    classifiedReason: "TIMEOUT",
    callsUsed: 2,
  }).reason, "CALL_BUDGET_EXHAUSTED");
  assert.equal(route({
    phase: "FAILOVER",
    classifiedReason: "TIMEOUT",
    callsUsed: 1,
    secondaryAlreadyUsed: true,
  }).reason, "CALL_BUDGET_EXHAUSTED");
  const budget = createCallBudget();
  budget.consume();
  budget.consume({ secondary: true });
  assert.deepEqual(budget.snapshot(), { callsUsed: 2, secondaryUsed: true });
  assert.throws(() => budget.consume(), /giới hạn 2/);
});

await test("A45-A53-RUNTIME", "Customer failover keeps one session, caps at two calls, never recurses, and next turn restarts Primary", async () => {
  const aiSource = fs.readFileSync(path.join(REPO, "lib", "ai-chat.js"), "utf8");
  const calls = [];
  let secondaryFails = false;
  const generateReply = compileFunction(aiSource, "export async function generateReply", {
    layChuTaiKhoan: () => "owner-a",
    getConfig: () => null,
    isAiChatReady: () => true,
    customerRequiredCapabilities: () => [CAPABILITIES.TEXT],
    createCallBudget,
    opencode: {
      loadChatProviders: async () => catalog,
      ensureSession: async () => ({ sessionId: "same-session", created: false, turns: 1 }),
      sendPrompt: async (config, sessionId) => {
        calls.push({ model: config.opencodeModel, sessionId });
        if (config.opencodeModel === "primary/text") throw Object.assign(new Error("rate limit"), { status: 429 });
        if (secondaryFails) throw Object.assign(new Error("secondary unavailable"), { status: 503 });
        return { reply: `final-${calls.length}`, tokens: null, model: config.opencodeModel };
      },
    },
    buildBootstrapContext: async () => ({
      recentHistory: "", threadTitle: "fixture", hasKnowledge: false, soTinLichSu: 0,
    }),
    ThreadType: { User: 0 },
    docTep: { xuLyTep: async () => null },
    ganNhanTuDong: null,
    customerMemory: { bocPrompt: async (_session, _message, text) => text, quenPhien: () => undefined },
    mocHienTai: () => "fixture-time",
    emailCheck: { timEmailTrongTin: () => null },
    addLog: async () => undefined,
    bumpSessionTurns: async () => undefined,
    classifyProviderFailure,
    routeModelRequest,
    SURFACES,
    ROUTE_MODES,
    ownerFacingFailureMessage: () => "safe failure",
    SKIP_TOKEN: "SKIP",
    console: { warn: () => undefined },
  });
  const config = {
    opencodeBaseUrl: "http://fixture",
    opencodeModel: "primary/text",
    opencodeFallbackModel: "secondary/assist",
    opencodeFallbackCapabilities: [],
    opencodeFailoverEnabled: true,
    capabilityRoutingEnabled: true,
    docTep: false,
  };
  const first = await generateReply("turn one", { threadId: "thread-a", threadType: 0 }, "owner-a", config);
  const second = await generateReply("turn two", { threadId: "thread-a", threadType: 0 }, "owner-a", config);
  assert.equal(first.error, null);
  assert.equal(second.error, null);
  assert.deepEqual(calls.map((item) => item.model), [
    "primary/text", "secondary/assist", "primary/text", "secondary/assist",
  ]);
  assert.ok(calls.every((item) => item.sessionId === "same-session"));

  secondaryFails = true;
  const beforeFailure = calls.length;
  const failed = await generateReply("turn three", { threadId: "thread-a", threadType: 0 }, "owner-a", config);
  const failedTurnCalls = calls.slice(beforeFailure);
  assert.notEqual(failed.error, null);
  assert.deepEqual(failedTurnCalls.map((item) => item.model), ["primary/text", "secondary/assist"]);
  assert.equal(failedTurnCalls.length, 2, "logical turn duoc goi toi da hai inference");
  assert.ok(failedTurnCalls.every((item) => item.sessionId === "same-session"));
});

await test("F2-OWNER-GUARDS", "single/read-set guards fail closed for null, mismatch, generation and missing credential", async () => {
  const tempA = fs.mkdtempSync(path.join(os.tmpdir(), "owner-guard-a-"));
  const tempB = fs.mkdtempSync(path.join(os.tmpdir(), "owner-guard-b-"));
  const primaryConfig = { opencodeModel: "primary/text", capabilityRoutingEnabled: false };
  try {
    currentOwner = "owner-a";
    opencode.markCredentialPlaneReady("owner-a", ["primary", "secondary"], tempA);
    assert.equal(
      await ownerCredentials.withCurrentOwnerCredentialRead("owner-a", primaryConfig, async () => "single-ok"),
      "single-ok"
    );
    assert.equal(
      await ownerCredentials.withOwnerCredentialReadSet("owner-a", ["primary", "secondary"], async () => "set-ok"),
      "set-ok"
    );

    for (const invalidOwner of [null, "owner-b"]) {
      currentOwner = invalidOwner;
      let singleRan = false;
      await assert.rejects(
        ownerCredentials.withCurrentOwnerCredentialRead("owner-a", primaryConfig, async () => {
          singleRan = true;
        }),
        (error) => error.code === "OWNER_CONTEXT_CHANGED"
      );
      assert.equal(singleRan, false);

      let setRan = false;
      await assert.rejects(
        ownerCredentials.withOwnerCredentialReadSet("owner-a", ["primary"], async () => {
          setRan = true;
        }),
        (error) => error.code === "OWNER_CONTEXT_CHANGED"
      );
      assert.equal(setRan, false);
    }

    currentOwner = "owner-a";
    await assert.rejects(
      ownerCredentials.withOwnerCredentialReadSet("owner-a", ["primary"], async () => {
        currentOwner = null;
        return "must-not-escape";
      }),
      (error) => error.code === "OWNER_CONTEXT_CHANGED"
    );

    currentOwner = "owner-a";
    opencode.markCredentialPlaneReady("owner-a", ["primary"], tempA);
    let missingCredentialOperationRan = false;
    await assert.rejects(
      ownerCredentials.withOwnerCredentialReadSet("owner-a", ["secondary"], async () => {
        missingCredentialOperationRan = true;
      }),
      (error) => error.code === "OWNER_PROVIDER_CREDENTIAL_MISSING"
    );
    assert.equal(missingCredentialOperationRan, false);

    opencode.markCredentialPlaneReady("owner-a", ["primary", "secondary"], tempA);
    await assert.rejects(
      ownerCredentials.withOwnerCredentialReadSet("owner-a", ["primary", "secondary"], async () => {
        opencode.markCredentialPlaneReady("owner-a", ["primary", "secondary"], tempB);
        return "stale-generation";
      }),
      (error) => error.code === "OWNER_CONTEXT_CHANGED"
    );
  } finally {
    currentOwner = "owner-a";
    opencode.markCredentialPlaneFailed();
    fs.rmSync(tempA, { recursive: true, force: true });
    fs.rmSync(tempB, { recursive: true, force: true });
  }
});

await test("F3-WEB-ENDPOINT", "the exact POST web-probe route executes owner guards and runtime evidence probe", async () => {
  const serverSource = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  let handlerSource = extractRegisteredHandler(serverSource, "post", "/api/ai-chat/web-probe");
  handlerSource = handlerSource
    .replace('const opencode = await import("./lib/opencode.js");', "const opencode = opencodeFixture;")
    .replace(
      'const config = aiChat.getConfig(ownerUid) || await (await import("./lib/db.js")).getAiChatConfig(ownerUid);',
      "const config = aiChat.getConfig(ownerUid) || await getAiChatConfigFixture(ownerUid);"
    );
  assert.equal(handlerSource.includes("await import("), false, "fixture phai thay dung hai dynamic import cua handler");

  const events = [];
  let systemEnabled = true;
  const config = { opencodeModel: "primary/web" };
  const opencodeFixture = {
    splitModel: opencode.splitModel,
    loadChatProviders: async (received) => {
      events.push("catalog");
      assert.equal(received, config);
      return [{ id: "primary", models: [{ id: "primary/web", capabilities: { toolcall: true } }] }];
    },
    probeWebSupport: async (received, model) => {
      events.push("probe");
      assert.equal(received, config);
      assert.equal(model, "primary/web");
      return { supported: true, state: "SUPPORTED" };
    },
  };
  const ownerCredentialFixture = {
    withCurrentOwnerPlaneRead: async (ownerUid, operation) => {
      events.push("owner-plane");
      assert.equal(ownerUid, "owner-a");
      return operation();
    },
    withOwnerCredentialReadSet: async (ownerUid, providers, operation) => {
      events.push("read-set");
      assert.equal(ownerUid, "owner-a");
      assert.deepEqual(providers, ["primary"]);
      return operation();
    },
    ownerCredentialHttpError: (error) => ({ status: 409, code: error.code, message: error.message }),
  };
  const handler = compileArrowFunction(handlerSource, {
    capabilityRoutingEnabled: () => systemEnabled,
    WEB_PROBE_STATES: { UNKNOWN: "UNKNOWN", UNSUPPORTED: "UNSUPPORTED" },
    chuHienTai: () => "owner-a",
    opencodeFixture,
    aiChat: { getConfig: () => config },
    getAiChatConfigFixture: async () => null,
    ownerCredentials: ownerCredentialFixture,
    classifyProviderFailure,
  });
  const response = () => ({
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return payload; },
  });

  const ok = response();
  await handler({ body: { model: "primary/web" } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.payload, { supported: true, state: "SUPPORTED" });
  assert.deepEqual(events, ["owner-plane", "catalog", "read-set", "probe"]);

  systemEnabled = false;
  events.length = 0;
  const disabled = response();
  await handler({ body: { model: "primary/web" } }, disabled);
  assert.equal(disabled.statusCode, 503);
  assert.equal(disabled.payload.code, "CAPABILITY_ROUTING_DISABLED");
  assert.deepEqual(events, []);
});

await test("F3-ADMIN-GUARD", "Admin parser executes inside the primary-provider read-set guard", async () => {
  const adminSource = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
  let insideLease = false;
  let allowCredential = true;
  let parserCalls = 0;
  let guardCalls = 0;
  const xuLyLenh = compileFunction(adminSource, "export async function xuLyLenh", {
    layChuTaiKhoan: () => "owner-a",
    khoaThaoTacCho: () => "owner-a::thread-a",
    phanLoaiLenhNhanQuaSo: () => null,
    laLenhTaoZoom: () => false,
    laLenhSuaLichZoom: () => false,
    laLenhXoaLichZoom: () => false,
    laLenhHuyZoomCu: () => false,
    xuLyBanNhapDay: async () => null,
    thaoTacChoConHan: () => null,
    laXacNhanOK: () => false,
    laThuXacNhanKhongHopLe: () => false,
    danhSachDichDen: async () => [{ id: "thread-a", loai: "nick", ten: "Fixture" }],
    getAiChatConfig: async () => ({ opencodeModel: "primary/text" }),
    resolveEffectiveModelConfig: async (saved) => saved,
    phanTichLenhAdminGia: null,
    splitModel: opencode.splitModel,
    withOwnerCredentialReadSet: async (ownerUid, providers, operation) => {
      guardCalls += 1;
      assert.equal(ownerUid, "owner-a");
      assert.deepEqual(providers, ["primary"]);
      if (!allowCredential) throw Object.assign(new Error("missing credential"), { code: "OWNER_PROVIDER_CREDENTIAL_MISSING" });
      insideLease = true;
      try {
        return await operation();
      } finally {
        insideLease = false;
      }
    },
    phanTichLenh: async () => {
      parserCalls += 1;
      assert.equal(insideLease, true);
      return { hanhDong: "khong_hieu", lyDo: "fixture" };
    },
    addLog: async () => undefined,
  });

  const message = { content: "lệnh fixture", threadId: "thread-a" };
  const first = await xuLyLenh(message, async () => undefined);
  assert.equal(guardCalls, 1);
  assert.equal(parserCalls, 1);
  assert.match(first, /Em chưa hiểu/);

  allowCredential = false;
  const second = await xuLyLenh(message, async () => undefined);
  assert.equal(guardCalls, 2);
  assert.equal(parserCalls, 1, "missing credential phai chan parser truoc AI call");
  assert.match(second, /missing credential/);
});

await test("A60-A71", "kill-switch defaults and non-runtime integration boundaries remain exact", () => {
  assert.equal(capabilityRoutingEnabled({}), false);
  assert.equal(capabilityRoutingEnabled({ AI_CAPABILITY_ROUTING_V1_ENABLED: "false" }), false);
  assert.equal(capabilityRoutingEnabled({ AI_CAPABILITY_ROUTING_V1_ENABLED: "TRUE" }), true);
  assert.equal(capabilityRoutingEnabled({ AI_CAPABILITY_ROUTING_V1_ENABLED: "1" }), true);
  assert.equal(route({ routingEnabled: false, requiredCapabilities: ["TEXT", "IMAGE_INPUT"] }).routeMode, ROUTE_MODES.PRIMARY_ONLY);

  const uiSource = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
  const p9Source = fs.readFileSync(path.join(REPO, "lib", "migrations", "p9-zalo-uid-profile.js"), "utf8");
  assert.equal(uiSource.includes("capabilityRoutingSystemEnabled = data.config.capabilityRoutingEnabled === true;"), true);
  assert.equal(uiSource.includes('model.capabilities?.image !== true'), true);
  assert.equal(uiSource.includes('webProbeState === "SUPPORTED"'), true);
  assert.equal(p9Source.includes("opencode_fallback_capabilities"), false);
  assert.equal(p9Source.includes("opencode_failover_enabled"), false);
});

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.code} = ${result.pass ? "PASS" : "FAIL"}  ${result.description}`);
  if (result.error) console.log(`      -> ${result.error}`);
}
console.log(`\nCAPABILITY_ROUTING_V1 = ${results.length - failed.length}/${results.length} PASS`);
console.log("REAL_PROVIDER_CALL = 0");
console.log("REAL_ZALO_SEND = 0");
process.exitCode = failed.length ? 1 : 0;
