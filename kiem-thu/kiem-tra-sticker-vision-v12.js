/** Offline Sticker Vision V1.2 checks. Real function bodies, fake I/O only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as router from "../lib/ai-model-router.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const ZALO = source("lib/zalo-service.js");
const AI = source("lib/ai-chat.js");
const PLACEHOLDER = "(Khách vừa gửi một Sticker.)";
const SECRET_ID = "STICKER_SECRET_123";
const SECRET_CAT = "CAT_SECRET_456";
const SECRET_URL = `https://fake/sticker/${SECRET_ID}.webp`;
const results = [];

function loadBody(file, dependencies, exports) {
  const body = source(file).replace(/^import\s[\s\S]*?;\r?\n/gm, "").replace(/^export\s+/gm, "");
  return Function(...Object.keys(dependencies), `"use strict";\n${body}\nreturn { ${exports.join(",")} };`)(
    ...Object.values(dependencies)
  );
}

function extractFunction(moduleSource, signature) {
  const start = moduleSource.indexOf(signature);
  assert.ok(start >= 0, `Missing ${signature}`);
  const bodyStart = moduleSource.indexOf("{", start + signature.length);
  let depth = 0, quote = null, escaped = false, lineComment = false, blockComment = false;
  for (let i = bodyStart; i < moduleSource.length; i += 1) {
    const c = moduleSource[i], next = moduleSource[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (blockComment) { if (c === "*" && next === "/") { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { lineComment = true; i += 1; continue; }
    if (c === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth += 1;
    if (c === "}" && --depth === 0) return moduleSource.slice(start, i + 1);
  }
  assert.fail(`Unclosed ${signature}`);
}

function compileFunction(moduleSource, signature, dependencies) {
  const code = extractFunction(moduleSource, signature).replace(/^export\s+/, "");
  const name = code.match(/(?:async\s+)?function\s+([\w$]+)/)?.[1];
  return Function(...Object.keys(dependencies), `"use strict";\n${code}\nreturn ${name};`)(
    ...Object.values(dependencies)
  );
}

function sticker(id = 45348, threadType = 0) {
  const raw = { id, catId: SECRET_CAT, type: 7 };
  return {
    id: `sticker-${id}`, threadId: "thread-a", threadType, senderId: "customer-a",
    senderName: "Khách", msgType: "chat.sticker", content: JSON.stringify(raw),
    rawJson: { data: { msgType: "chat.sticker", content: raw } },
  };
}

function words(content = "Cho mình hỏi lịch học", threadType = 0) {
  return {
    id: "text-1", threadId: "thread-a", threadType, senderId: "customer-a",
    senderName: "Khách", msgType: "webchat", content, rawJson: { data: { content } },
  };
}

function photo(threadType = 0) {
  return {
    id: "photo-1", threadId: "thread-a", threadType, senderId: "customer-a",
    senderName: "Khách", msgType: "chat.photo", content: "https://fake/photo.webp",
    rawJson: { data: { content: { href: "https://fake/photo.webp" } } },
  };
}

function webp(size = 1024) {
  const bytes = Buffer.alloc(size);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  return bytes;
}

function fixture({ routing = true, imageCapable = true, secondaryVision = false,
  docTep = false, useKnowledge = false,
  detail = async () => ({ stickerWebpUrl: SECRET_URL }), fetchImage = async () => new Response(webp()),
  probeError = false, finalReplies = ["Phản hồi theo Sticker."] } = {}) {
  const calls = { detail: [], fetch: [], vision: [], final: [], retrieval: [], email: [], logs: [] };
  const stickerApi = loadBody("lib/sticker.js", { console: { warn: () => {} } }, [
    "stickerIdFromMessage", "getCachedStickerUrl", "resolveStickerUrl", "refreshStickerUrl",
  ]);
  const runtimeApi = { getStickersDetail: async (id) => { calls.detail.push(id); return detail(id, calls.detail.length); } };
  const merge = compileFunction(ZALO, "function gopThanhMotTin", {});
  const prepareVision = compileFunction(ZALO, "async function chuanBiStickerVisionChoAi", {
    ThreadType: { User: 0 }, getCachedStickerUrl: stickerApi.getCachedStickerUrl,
    resolveStickerUrl: stickerApi.resolveStickerUrl, refreshStickerUrl: stickerApi.refreshStickerUrl,
  });
  const catalog = [{ id: "primary", models: [{ id: "primary/model", capabilities: {
    text: true, image: imageCapable, file: false, web: false,
  } }] }, ...(secondaryVision ? [{ id: "secondary", models: [{ id: "secondary/vision",
    capabilities: { text: true, image: true, file: false, web: false } }] }] : [])];
  const loadChatProviders = async () => { if (probeError) throw Error("catalog unavailable"); return catalog; };
  const media = loadBody("lib/doc-tep.js", {
    fetch: async (url, options) => { calls.fetch.push({ url, options }); return fetchImage(url, calls.fetch.length); },
    loadChatProviders,
    runOneShot: async (config, title, parts) => {
      calls.vision.push({ model: config.opencodeModel, title, parts });
      return { text: "Nhân vật đang mỉm cười và vẫy tay.", tokens: { input: 1 } };
    },
    splitModel: (model) => ({ providerID: String(model).split("/")[0] }),
    addLog: async (entry) => { calls.logs.push(entry); },
    CAPABILITIES: router.CAPABILITIES, ROUTE_MODES: router.ROUTE_MODES,
    SURFACES: router.SURFACES, capabilityRoutingEnabled: router.capabilityRoutingEnabled,
    routeModelRequest: router.routeModelRequest,
    classifyProviderFailure: () => "fixture",
    withOwnerCredentialReadSet: async (_owner, _providers, operation) => operation(),
  }, ["layTepTuTin", "taiTep", "docVaTomTat", "xuLyTep", "STICKER_VISION_FAILURE_MARKER"]);
  const config = {
    opencodeBaseUrl: "http://fixture", opencodeModel: "primary/model", opencodeAgent: "general",
    opencodeFallbackModel: secondaryVision ? "secondary/vision" : "",
    opencodeFallbackCapabilities: secondaryVision ? [router.CAPABILITIES.IMAGE_INPUT] : [],
    opencodeFailoverEnabled: false,
    capabilityRoutingEnabled: routing, docTep, useKnowledge,
    knowledgeFileIds: [1], soul: "Giọng Vizen", allowedTopics: "Lịch học",
  };
  const opencode = {
    loadChatProviders,
    ensureSession: async (_config, _owner, _thread, context) => {
      calls.bootstrap = context;
      return { sessionId: "final-session", created: true, turns: 0 };
    },
    sendPrompt: async (_config, _session, prompt) => {
      calls.final.push(prompt);
      return { reply: finalReplies[Math.min(calls.final.length - 1, finalReplies.length - 1)],
        tokens: { input: 1 }, model: "primary/model" };
    },
    knowledgeLedger: { has: () => false, add: () => {}, cumulative: () => 0 },
  };
  const required = compileFunction(AI, "function customerRequiredCapabilities", { CAPABILITIES: router.CAPABILITIES });
  const generateReply = compileFunction(AI, "export async function generateReply", {
    layChuTaiKhoan: () => "owner-a", getConfig: () => config, isAiChatReady: () => true,
    customerRequiredCapabilities: required, createCallBudget: router.createCallBudget,
    opencode, buildBootstrapContext: async () => ({ soul: config.soul, recentHistory: "Khách: chào",
      threadTitle: "Khách", soTinLichSu: 1 }), ThreadType: { User: 0 }, docTep: media,
    ganNhanTuDong: null, NHAN_PDF: "pdf",
    customerMemory: { bocPrompt: async (_session, _message, text) => text, quenPhien: () => {} },
    mocHienTai: () => "16/09/2026 10:00", emailCheck: {
      timEmailTrongTin: (value) => { calls.email.push(value); return null; },
    },
    addLog: async (entry) => { calls.logs.push(entry); }, bumpSessionTurns: async () => {},
    classifyProviderFailure: () => "fixture", routeModelRequest: router.routeModelRequest,
    CAPABILITIES: router.CAPABILITIES, SURFACES: router.SURFACES, ROUTE_MODES: router.ROUTE_MODES,
    ownerFacingFailureMessage: () => "fixture failure", SKIP_TOKEN: "SKIP",
    knowledge: { retrieveForAi: async (_owner, _ids, query) => {
      calls.retrieval.push(query); return { units: [], stats: { selectedCharCount: 0 } };
    } }, KNOWLEDGE_MAX_CHARS: 12000, formatKnowledge: () => "",
    performance, DECISION_INSTRUCTION: "", buildCorrectiveRetryInstruction: () => "",
    parseDecisionReply: () => ({ valid: true, decision: "ANSWERABLE", body: "Đã rõ." }),
    recordDecisionProtocolOutcome: async () => {}, console: { warn: () => {} },
  });
  async function turn(events) {
    const merged = merge(events);
    const prepared = await prepareVision(merged, runtimeApi);
    const result = await generateReply(prepared.content, prepared, "owner-a", config);
    return { merged: prepared, result };
  }
  return { calls, stickerApi, runtimeApi, merge, prepareVision, media, config, generateReply, turn };
}

async function test(id, name, run) {
  try { await run(); results.push({ id, pass: true }); console.log(`PASS ${id} - ${name}`); }
  catch (error) { results.push({ id, pass: false }); console.error(`FAIL ${id} - ${name}\n${error.stack}`); }
}

await test("S01", "private Sticker-only uses one specialist and one final call", async () => {
  const f = fixture(); const { merged, result } = await f.turn([sticker()]);
  assert.equal(merged.content, PLACEHOLDER);
  assert.equal(result.reply, "Phản hồi theo Sticker.");
  assert.equal(f.calls.vision.length, 1); assert.equal(f.calls.final.length, 1);
  assert.equal(f.calls.vision[0].parts[0].type, "file");
  assert.match(f.calls.vision[0].parts[0].url, /^data:image\/webp;base64,/);
  assert.match(f.calls.final[0], /# STICKER KHÁCH VỪA GỬI/);
  assert.match(f.calls.final[0], /Nhân vật đang mỉm cười/);
  const assist = fixture({ imageCapable: false, secondaryVision: true });
  await assist.turn([sticker()]);
  assert.equal(assist.calls.vision[0].model, "secondary/vision");
  assert.equal(assist.calls.vision.length + assist.calls.final.length, 2);
});

await test("S02", "small verified Sticker bypasses unchanged normal-image threshold", async () => {
  const f = fixture(); await f.turn([sticker()]); assert.equal(f.calls.vision.length, 1);
  await assert.rejects(() => f.media.taiTep({ href: SECRET_URL, ten: "normal.webp" }),
    (error) => error.quaNho === true);
  assert.match(source("lib/doc-tep.js"), /const NHO_NHAT_BYTE = 20 \* 1024/);
  const gif = fixture({ fetchImage: async () => new Response(Buffer.from("GIF89a")) });
  await gif.turn([sticker()]);
  assert.match(gif.calls.vision[0].parts[0].url, /^data:image\/gif;base64,/);
});

await test("S03", "TEXT then Sticker keeps real text", async () => {
  const f = fixture(); const { merged } = await f.turn([words(), sticker()]);
  assert.equal(merged.content, "Cho mình hỏi lịch học"); assert.equal(f.calls.vision.length, 1);
  assert.match(f.calls.final[0], /Cho mình hỏi lịch học/);
});

await test("S04", "first Sticker in event order wins and vision runs once", async () => {
  const f = fixture(); await f.turn([sticker(111), sticker(222)]);
  assert.deepEqual(f.calls.detail, [111]); assert.equal(f.calls.vision.length, 1);
  const failed = fixture({ detail: async () => { throw Error("first unavailable"); } });
  await failed.turn([sticker(111), sticker(222)]);
  assert.deepEqual(failed.calls.detail, [111]); assert.equal(failed.calls.vision.length, 0);
});

await test("S05", "normal photo wins over Sticker", async () => {
  const f = fixture({ fetchImage: async () => new Response(webp(24 * 1024)) });
  await f.turn([sticker(), photo()]);
  assert.equal(f.calls.detail.length, 0); assert.equal(f.calls.vision.length, 1);
  assert.equal(f.calls.fetch[0].url, "https://fake/photo.webp");
});

await test("S06", "Sticker metadata never reaches textual AI boundaries", async () => {
  const f = fixture({ useKnowledge: true });
  const event = sticker();
  event.rawJson.data.content.marker = SECRET_ID;
  event.content = JSON.stringify(event.rawJson.data.content);
  const { merged } = await f.turn([words(), event]);
  assert.equal(f.calls.vision.length, 1);
  assert.equal(merged.content, "Cho mình hỏi lịch học");
  const aggregate = await captureAggregateAiInput(f, [words(), event]);
  assert.equal(aggregate.aiInputs.length, 1);
  assert.equal(aggregate.aiInputs[0], "Cho mình hỏi lịch học");
  const aiText = [merged.content, ...f.calls.final, ...f.calls.retrieval, ...f.calls.email,
    ...aggregate.aiInputs,
    ...f.calls.logs.filter((entry) => entry.event === "ai_prompt").map((entry) => entry.detail.userMessage)].join("\n");
  for (const secret of [SECRET_ID, SECRET_CAT, SECRET_URL, "catId", "sticker.webp"]) {
    assert.equal(aiText.includes(secret), false, secret);
  }
  assert.equal(f.calls.vision[0].parts[0].filename, "sticker");
});

await test("S07", "detail failure gives generic marker and final continues", async () => {
  const f = fixture({ detail: async () => { throw Error("detail unavailable"); } });
  await f.turn([sticker()]); assert.equal(f.calls.vision.length, 0);
  assert.match(f.calls.final[0], /không đọc được nội dung hình ảnh/);
});

await test("S08", "image fetch failure gives generic marker", async () => {
  const f = fixture({ fetchImage: async () => { throw Error("fetch unavailable"); } });
  await f.turn([sticker(111), sticker(222)]); assert.equal(f.calls.vision.length, 0);
  assert.deepEqual(f.calls.detail, [111]);
  assert.match(f.calls.final[0], /không đọc được nội dung hình ảnh/);
});

await test("S09", "stale URL refreshes once; same URL is not fetched twice", async () => {
  const old = "https://fake/old.webp", newer = "https://fake/new.webp";
  const f = fixture({ detail: async (_id, count) => ({ stickerWebpUrl: count === 1 ? old : newer }),
    fetchImage: async (url) => { if (url === old) throw Error("expired"); return new Response(webp()); } });
  await f.stickerApi.resolveStickerUrl(f.runtimeApi, 45348);
  await f.turn([sticker()]);
  assert.deepEqual(f.calls.fetch.map((call) => call.url), [old, newer]);
  assert.equal(f.calls.detail.length, 2); assert.equal(f.calls.vision.length, 1);
  const same = fixture({ detail: async () => ({ stickerWebpUrl: old }),
    fetchImage: async () => { throw Error("expired"); } });
  await same.stickerApi.resolveStickerUrl(same.runtimeApi, 45348);
  await same.turn([sticker()]);
  assert.deepEqual(same.calls.fetch.map((call) => call.url), [old]);
  assert.equal(same.calls.detail.length, 2);
});

await test("S10", "routing OFF rejects non-vision primary but final continues", async () => {
  const f = fixture({ routing: false, imageCapable: false }); await f.turn([sticker()]);
  assert.equal(f.calls.vision.length, 0); assert.equal(f.calls.final.length, 1);
  assert.match(f.calls.final[0], /không đọc được nội dung hình ảnh/);
  const capable = fixture({ routing: false, imageCapable: true });
  await capable.turn([sticker()]);
  assert.equal(capable.calls.vision.length, 1);
});

await test("S11", "durable replay needs only persisted raw payload", async () => {
  const persisted = JSON.parse(JSON.stringify(sticker()));
  const before = JSON.stringify(persisted);
  const f = fixture(); await f.turn([persisted]);
  assert.deepEqual(f.calls.detail, [45348]); assert.equal(f.calls.vision.length, 1);
  assert.equal(persisted.__stickerVision, undefined);
  assert.equal(JSON.stringify(persisted), before);
});

await test("S12", "canonical outbox remains downstream of the AI slot", () => {
  assert.ok(ZALO.indexOf("withGlobalAiSlot({", ZALO.indexOf("const noiDungChoAi"))
    < ZALO.indexOf("chuanBiDurableOutbox(", ZALO.indexOf("const noiDungChoAi")));
  assert.match(ZALO, /guiDurableOutbound\(\{/);
});

await test("S13", "all Zalo detail calls use fixture API", async () => {
  const f = fixture(); await f.turn([sticker()]); assert.equal(f.calls.detail.length, 1);
  assert.equal(typeof f.runtimeApi.getStickersDetail, "function");
});

await test("S14", "all LLM calls use fixture functions", async () => {
  const f = fixture(); await f.turn([sticker()]);
  assert.equal(f.calls.vision.length, 1); assert.equal(f.calls.final.length, 1);
  assert.equal((source("lib/doc-tep.js").match(/export async function docVaTomTat/g) || []).length, 1);
  assert.doesNotMatch(AI, /runOneShot[\s\S]*type:\s*"file"/);
});

await test("S15", "Sticker then TEXT still triggers vision", async () => {
  const f = fixture(); const { merged } = await f.turn([sticker(), words()]);
  assert.equal(merged.msgType, "webchat"); assert.equal(merged.content, "Cho mình hỏi lịch học");
  assert.equal(f.calls.vision.length, 1);
});

await test("S16", "real tryReply corrective retry reuses one visual result", async () => {
  const f = fixture(); const merged = await f.prepareVision(f.merge([sticker()]), f.runtimeApi);
  let generationCount = 0;
  const tryReply = compileFunction(AI, "export async function tryReply", {
    layChuTaiKhoan: () => "owner-a", getConfig: () => f.config,
    shouldProcessMessage: () => true, isAiChatReady: () => true,
    describeMessage: () => ({}), addLog: async (entry) => { f.calls.logs.push(entry); },
    websiteEmailStatus: { lookupCustomerEmailStatus: async () => ({ outcome: "NO_MATCH", reason: "DEFERRED" }) },
    generateReply: async (...args) => {
      const result = await f.generateReply(...args);
      generationCount += 1;
      return generationCount === 1
        ? { ...result, malformedDecision: true, decisionReason: "fixture", error: "malformed" }
        : result;
    },
    recordDecisionProtocolOutcome: async () => {},
    MAX_AI_RETRY: 1, MALFORMED_DECISION_FALLBACK: "fixture fallback",
  });
  const reply = await tryReply(merged.content, merged);
  assert.equal(reply, "Phản hồi theo Sticker.");
  assert.equal(generationCount, 2);
  assert.equal(f.calls.vision.length, 1); assert.equal(f.calls.final.length, 2);
});

await test("S17", "docTep=false does not disable Sticker vision", async () => {
  const f = fixture({ docTep: false }); await f.turn([sticker()]); assert.equal(f.calls.vision.length, 1);
});

await test("S18", "private Sticker vision and group Sticker no vision", async () => {
  const f = fixture(); await f.turn([sticker()]);
  const group = f.merge([sticker(555, 1)]);
  assert.equal(group.content, "");
  await f.prepareVision(group, f.runtimeApi);
  assert.equal(f.calls.vision.length, 1); assert.deepEqual(f.calls.detail, [45348]);
});

// Execute the actual segment-loop source, including both real production calls
// to gopThanhMotTin. No merge stub is accepted here.
function segmentFlow(f, segment) {
  const start = ZALO.indexOf("  for (const segment of segments) {", ZALO.indexOf("// Moi segment la mot bucket arrival goc"));
  const end = ZALO.indexOf("  // Reaction la customer outbound", start);
  assert.ok(start > 0 && end > start);
  const body = ZALO.slice(start, end);
  const seen = [];
  const deps = {
    gopThanhMotTin: f.merge,
    automaticWork: null, conversationGeneration: null, originToken: null,
    handlePdfAutomation: undefined, originConHieuLuc: () => true,
    botWorkConHieuLuc: () => true,
    guiDaXemChoTinsTrongCum: (...args) => seen.push(args),
    thuThaCamXuc: async () => false, automaticContext: null,
  };
  const run = Function(...Object.keys(deps), `return async function(segments) {\n${body}\nreturn { aggregateReached: true, tin };\n}`)(
    ...Object.values(deps)
  );
  return run([segment]).then((result) => ({ result, seen }));
}

async function captureAggregateAiInput(f, events, options = {}) {
  const aiInputs = [];
  const logs = [], errors = [];
  let typing = 0, seen = 0, outbound = 0, preparedResult;
  const run = compileFunction(ZALO, "async function traLoiCumTin", {
    automaticWorkConHieuLuc: () => true, tuyChonGuiTuDong: () => undefined,
    originConHieuLuc: options.originConHieuLuc || (() => true), gopThanhMotTin: f.merge,
    handlePdfAutomation: undefined, guiDaXemChoTins: () => { seen += 1; },
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => { typing += 1; return () => {}; },
    batDauWebTyping: () => Object.assign(() => {}, { setPhase: () => {} }),
    durableIds: () => [], giaHanLeaseDurableGeneration: async () => true,
    cancelGlobalAiWaiter: () => false, withGlobalAiSlot: async (_options, operation) => operation(),
    aiChat: { getConfig: () => ({ botEnabled: true }), tryReply: async (text) => {
      aiInputs.push(text); return null;
    } },
    ownerCredentials: { withCurrentOwnerCredentialRead: async (_owner, _config, operation) => operation() },
    chuanBiStickerVisionChoAi: async (...args) => {
      preparedResult = await f.prepareVision(...args);
      return preparedResult;
    },
    chuHienTai: () => "owner-a", ThreadType: { User: 0, Group: 1 }, api: f.runtimeApi,
    sendChatMessage: async () => { outbound += 1; },
    addLog: async (entry) => { logs.push(entry); },
    console: { error: (error) => { errors.push(error); } },
  });
  await run(events, options.automaticWork || null, options.generation || null);
  return { aiInputs, typing, seen, outbound, logs, errors, preparedResult };
}

await test("S19", "real segment flow keeps private Sticker-only eligible", async () => {
  const f = fixture(); const segment = { tins: [sticker()] };
  const { result } = await segmentFlow(f, segment);
  assert.notEqual(segment.aiEligible, false); assert.equal(result.aggregateReached, true);
  assert.equal(result.tin.content, PLACEHOLDER);
  const full = await captureAggregateAiInput(f, [sticker()]);
  assert.equal(full.aiInputs.length, 1);
  assert.equal(full.aiInputs[0], PLACEHOLDER);
  const reactions = loadBody("lib/cam-xuc.js", { Reactions: { HEART: "heart", LIKE: "like" } }, ["chonCamXuc"]);
  assert.equal(reactions.chonCamXuc(PLACEHOLDER), null);
});

await test("S20", "routing OFF catalog failure fails soft", async () => {
  const f = fixture({ routing: false, probeError: true }); await f.turn([sticker()]);
  assert.equal(f.calls.vision.length, 0); assert.equal(f.calls.final.length, 1);
  assert.match(f.calls.final[0], /không đọc được nội dung hình ảnh/);
  assert.equal(f.calls.final[0].includes(SECRET_URL), false);
});

await test("S21", "real segment flow excludes group Sticker-only before aggregate", async () => {
  const f = fixture(); const segment = { tins: [sticker(555, 1)] };
  const { result, seen } = await segmentFlow(f, segment);
  assert.equal(segment.aiEligible, false); assert.equal(result, undefined);
  assert.equal(seen.length, 0); assert.equal(f.calls.vision.length, 0);
  assert.equal(f.calls.final.length, 0); assert.equal(f.calls.detail.length, 0);
  const full = await captureAggregateAiInput(f, [sticker(555, 1)]);
  assert.equal(full.aiInputs.length, 0); assert.equal(full.typing, 0); assert.equal(full.seen, 0);
  assert.ok(ZALO.indexOf("if (!tins.length) return;", ZALO.indexOf("// Moi segment la mot bucket arrival goc"))
    < ZALO.indexOf("batDauGoPhim(tin.threadId", ZALO.indexOf("// Moi segment la mot bucket arrival goc")));
});

await test("S22", "group text plus Sticker keeps text and skips Sticker vision", async () => {
  const f = fixture(); const group = f.merge([words("Lịch học?", 1), sticker(555, 1)]);
  const prepared = await f.prepareVision(group, f.runtimeApi);
  assert.equal(prepared.content, "Lịch học?"); assert.equal(prepared.__stickerVision, undefined);
  assert.equal(f.calls.detail.length, 0);
});

await test("S23", "retrieval receives real customer text only", async () => {
  const only = fixture({ useKnowledge: true }); await only.turn([sticker()]);
  assert.deepEqual(only.calls.retrieval, []);
  const mixed = fixture({ useKnowledge: true }); await mixed.turn([sticker(), words()]);
  assert.deepEqual(mixed.calls.retrieval, ["Cho mình hỏi lịch học"]);
});

await test("S24", "stale authority during real Sticker resolve exits without false AI failure", async () => {
  let current = true;
  const f = fixture({ detail: async () => {
    await Promise.resolve();
    current = false;
    return { stickerWebpUrl: SECRET_URL };
  } });
  const generation = {
    durableFailure: null, durableAuthorityLost: false,
    conHieuLuc: () => true, danhDauProviderHistory: () => {},
  };
  const automaticWork = { originOwnerUid: "owner-a", originApiIdentity: f.runtimeApi };
  const observed = await captureAggregateAiInput(f, [sticker()], {
    automaticWork, generation, originConHieuLuc: () => current,
  });
  assert.equal(observed.preparedResult, null);
  assert.equal(observed.errors.length, 0);
  assert.equal(observed.logs.some((entry) => entry.event === "ai_error"), false);
  assert.equal(observed.aiInputs.length, 0);
  assert.equal(f.calls.vision.length, 0);
  assert.equal(observed.outbound, 0);
  assert.equal(generation.durableFailure, null);
});

await test("S25", "non-Sticker URL filter matches baseline and Sticker controls survive", async () => {
  const f = fixture();
  const plain = f.merge([words("xem cái này"), words("https://shop.vn/abc")]);
  assert.equal(plain.content, "xem cái này");
  const privateSticker = f.merge([sticker()]);
  assert.equal(privateSticker.content, PLACEHOLDER);
  assert.equal(privateSticker.content.includes("catId"), false);
  const groupSticker = f.merge([sticker(555, 1)]);
  assert.equal(groupSticker.content, "");
  const segment = { tins: [sticker(555, 1)] };
  await segmentFlow(f, segment);
  assert.equal(segment.aiEligible, false);
});

const failed = results.filter((entry) => !entry.pass);
console.log(`Sticker Vision V1.2: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) process.exitCode = 1;
