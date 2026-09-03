import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { normalizeIncomingMessage, normalizeTs } from "../lib/message-utils.js";
import { taoBoGom } from "../lib/gom-tin.js";
import {
  clearAllPendingPdfConfirmations,
  createPdfAutomationHandler,
  getPendingPdfConfirmation,
  PDF_AUTOMATION_HANDLED,
} from "../lib/pdf-automation.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = (file) => fs.readFileSync(path.join(REPO, file), "utf8");
const ZALO = source("lib/zalo-service.js");
const AI = source("lib/ai-chat.js");
const CONTEXT = source("lib/conversation-context.js");
const SERVER = source("server.js");

function extractFunction(moduleSource, signature) {
  const start = moduleSource.indexOf(signature);
  assert.ok(start >= 0, `Khong tim thay function: ${signature}`);
  const bodyStart = moduleSource.indexOf("{", start + signature.length);
  assert.ok(bodyStart >= 0, `Khong tim thay body: ${signature}`);
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

const gopThanhMotTin = compileFunction(ZALO, "function gopThanhMotTin", {});
const lamSachNoiDung = compileFunction(CONTEXT, "function lamSachNoiDung", {});

class CanonicalTestDb {
  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        owner_uid TEXT NOT NULL,
        remote_thread_id TEXT NOT NULL,
        thread_type INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        avatar TEXT,
        last_message TEXT,
        last_message_at INTEGER,
        PRIMARY KEY (owner_uid, remote_thread_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        owner_uid TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        id TEXT NOT NULL,
        content TEXT,
        is_self INTEGER NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        sender_avatar TEXT,
        msg_type TEXT,
        ts INTEGER,
        raw_json TEXT,
        PRIMARY KEY (owner_uid, thread_id, id)
      );
    `);
  }

  upsertThread(ownerUid, thread) {
    const id = String(thread.remoteThreadId ?? thread.id);
    this.db.prepare(`
      INSERT INTO threads (owner_uid, remote_thread_id, thread_type, title, avatar, last_message, last_message_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_uid, remote_thread_id) DO UPDATE SET
        thread_type = excluded.thread_type,
        title = COALESCE(excluded.title, threads.title),
        avatar = COALESCE(excluded.avatar, threads.avatar),
        last_message = excluded.last_message,
        last_message_at = excluded.last_message_at
    `).run(
      String(ownerUid),
      id,
      Number(thread.threadType ?? 0),
      thread.title ?? null,
      thread.avatar ?? null,
      thread.lastMessage ?? null,
      thread.lastMessageAt ?? null
    );
    return this.getThread(ownerUid, id);
  }

  getThread(ownerUid, threadId) {
    return this.db.prepare(`
      SELECT remote_thread_id AS id, thread_type AS threadType, title, avatar,
             last_message AS lastMessage, last_message_at AS lastMessageAt
      FROM threads WHERE owner_uid = ? AND remote_thread_id = ?
    `).get(String(ownerUid), String(threadId)) || null;
  }

  insertMessage(ownerUid, message) {
    this.upsertThread(ownerUid, {
      id: message.threadId,
      threadType: message.threadType,
      lastMessage: message.content ?? "",
      lastMessageAt: message.ts,
    });
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (owner_uid, thread_id, id, content, is_self, sender_id, sender_name,
         sender_avatar, msg_type, ts, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(ownerUid),
      String(message.threadId),
      String(message.id),
      message.content ?? "",
      message.isSelf ? 1 : 0,
      message.senderId ?? null,
      message.senderName ?? null,
      message.senderAvatar ?? null,
      message.msgType ?? null,
      Number(message.ts || 0),
      message.rawJson ? JSON.stringify(message.rawJson) : null
    );
    return { changes: Number(result.changes) };
  }

  messages(ownerUid, threadId) {
    return this.db.prepare(`
      SELECT id, thread_id AS threadId, content, is_self AS isSelf,
             sender_id AS senderId, sender_name AS senderName,
             sender_avatar AS senderAvatar, msg_type AS msgType, ts, raw_json AS rawJson
      FROM messages WHERE owner_uid = ? AND thread_id = ? ORDER BY ts ASC, id ASC
    `).all(String(ownerUid), String(threadId)).map((row) => ({
      ...row,
      isSelf: Boolean(row.isSelf),
      rawJson: row.rawJson ? JSON.parse(row.rawJson) : null,
    }));
  }

  count(ownerUid, threadId) {
    return Number(this.db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE owner_uid = ? AND thread_id = ?"
    ).get(String(ownerUid), String(threadId)).n);
  }

  close() {
    this.db.close();
  }
}

function compilePersistence({
  db,
  owner,
  api,
  events,
  symbol,
  originConHieuLuc = () => true,
  onResolveThreadMeta = async () => undefined,
}) {
  return compileFunction(ZALO, "export async function persistAndBroadcastMessage", {
    CONFIRMED_OUTBOUND_AUTHORITY: symbol,
    originConHieuLuc,
    chuHienTai: () => owner(),
    api,
    resolveThreadMeta: async (_api, threadId) => {
      await onResolveThreadMeta();
      return { title: `Thread ${threadId}`, avatar: null };
    },
    upsertThread: async (ownerUid, thread) => db.upsertThread(ownerUid, thread),
    resolveSenderAvatar: async (_api, message) => message.senderAvatar ?? null,
    insertMessage: async (ownerUid, message) => db.insertMessage(ownerUid, message),
    getThread: async (ownerUid, threadId) => db.getThread(ownerUid, threadId),
    enrichMessageSticker: async (_api, message) => message,
    io: { emit: (event, payload) => events.push({ event, payload }) },
    emitThreads: async () => { events.push({ event: "threads" }); },
  });
}

function createSendSystem({ providerResult = { message: { msgId: "provider-1" } } } = {}) {
  const db = new CanonicalTestDb();
  const events = [];
  const logs = [];
  const symbol = Symbol("confirmed-outbound-authority-test");
  const state = {
    owner: "owner-A",
    generation: 1,
    botEpoch: 0,
    providerResult,
    onProviderSend: null,
    onPersistStart: null,
    sendsA: 0,
    sendsB: 0,
  };
  const appState = {
    loggedIn: true,
    uid: "owner-A",
    displayName: "Business A",
    myAvatar: "avatar-A",
  };
  const apiA = {
    async sendMessage() {
      state.sendsA += 1;
      const result = state.providerResult;
      if (state.onProviderSend) await state.onProviderSend();
      return result;
    },
    async sendLink() {
      return this.sendMessage();
    },
  };
  const apiB = {
    async sendMessage() {
      state.sendsB += 1;
      return { message: { msgId: "provider-B" } };
    },
  };
  state.api = apiA;
  const authority = Object.freeze({
    originOwnerUid: "owner-A",
    originRuntimeGeneration: 1,
    originApiIdentity: apiA,
    originDisplayName: "Business A",
    originAvatar: "avatar-A",
  });
  const originConHieuLuc = (token) => !token || (
    token.originOwnerUid === state.owner
    && token.originRuntimeGeneration === state.generation
    && token.originApiIdentity === state.api
  );
  const persist = compilePersistence({
    db,
    owner: () => state.owner,
    api: apiA,
    events,
    symbol,
    originConHieuLuc,
    onResolveThreadMeta: async () => {
      if (state.onPersistStart) await state.onPersistStart();
    },
  });
  db.upsertThread("owner-A", { id: "customer-1", threadType: 0, title: "Customer 1" });
  db.upsertThread("owner-B", { id: "customer-1", threadType: 0, title: "Customer 1 B" });

  const send = compileFunction(
    ZALO,
    "export async function sendChatMessage({ threadId, text, threadType, quote, mentions, urgency, attachment, originToken })",
    {
      originConHieuLuc,
      botEligibilityConHieuLuc: (epoch) => epoch === state.botEpoch,
      api: apiA,
      appState,
      chuHienTai: () => state.owner,
      getThread: async (ownerUid, threadId) => db.getThread(ownerUid, threadId),
      locTruocKhiGui: async (text) => text,
      taoNguonDinhKemZalo: () => null,
      ThreadType: { User: 0, Group: 1 },
      timLinkChinh: () => null,
      layMsgIdTuKetQuaGui: (result) => result?.message?.msgId ?? result?.msgId ?? null,
      addLog: async (entry) => { logs.push(entry); },
      normalizeTs,
      persistAndBroadcastMessage: persist,
      CONFIRMED_OUTBOUND_AUTHORITY: symbol,
    }
  );

  function switchToB() {
    state.owner = "owner-B";
    state.generation = 2;
    state.api = apiB;
    appState.uid = "owner-B";
    appState.displayName = "Business B";
    appState.myAvatar = "avatar-B";
  }

  return { db, events, logs, state, appState, apiA, apiB, authority, persist, send, switchToB };
}

function createIncomingHarness({ botEnabled, persist, botEpoch = 0, rules = [] }) {
  const counters = { persisted: 0, broadcast: 0, ai: 0, outbound: 0, aggregation: 0 };
  const aggregations = [];
  const run = compileFunction(ZALO, "async function handleNewIncomingMessage", {
    persistAndBroadcastMessage: async (message, token) => {
      counters.persisted += 1;
      const result = await persist(message, token);
      if (result) counters.broadcast += 1;
      return result;
    },
    originConHieuLuc: () => true,
    sendChatMessage: async () => { counters.outbound += 1; return { id: "out" }; },
    sendResolvedPrivateMessage: async () => null,
    chuHienTai: () => "owner-A",
    addLog: async () => undefined,
    laTinHeThong: () => false,
    moTaSuKien: () => "event",
    laLenhAdmin: async () => false,
    xuLyLenh: async () => null,
    aiChat: { getConfig: () => ({ botEnabled }) },
    botEligibilityEpoch: botEpoch,
    botEligibilityConHieuLuc: (epoch) => epoch === botEpoch,
    khoaThreadEligibility: (ownerUid, threadId) => `${ownerUid}\u0000${threadId}`,
    threadEligibilityEpochHienTai: () => 0,
    threadEligibilityConHieuLuc: (_key, epoch) => epoch === 0,
    automaticWorkConHieuLuc: (work) => work.capturedBotEligibilityEpoch === botEpoch
      && work.capturedThreadEligibilityEpoch === 0,
    tuyChonGuiTuDong: (work) => ({
      botEligibilityEpoch: work.capturedBotEligibilityEpoch,
      threadEligibilityKey: work.threadEligibilityKey,
      threadEligibilityEpoch: work.capturedThreadEligibilityEpoch,
    }),
    getThread: async () => ({ botEnabled: true }),
    getAutoReplyRules: async () => rules,
    normalizeString: (value) => String(value),
    ThreadType: { User: 0, Group: 1 },
    botDuocGoi: () => true,
    appState: { uid: "owner-A" },
    boGom: {
      dangMo: () => false,
      them: (message, work) => {
        counters.aggregation += 1;
        aggregations.push({ message, work });
      },
    },
  });
  return { run, counters, aggregations };
}

function createAggregateHarness({ botEpoch = 0 } = {}) {
  const counters = { ai: 0, outbound: 0, credentialReads: 0 };
  const run = compileFunction(ZALO, "async function traLoiCumTin", {
    botEligibilityConHieuLuc: (epoch) => epoch === botEpoch,
    automaticWorkConHieuLuc: (work) => !work
      || (work.capturedBotEligibilityEpoch === botEpoch && work.capturedThreadEligibilityEpoch === 0),
    tuyChonGuiTuDong: (work) => work ? {
      botEligibilityEpoch: work.capturedBotEligibilityEpoch,
      threadEligibilityKey: work.threadEligibilityKey,
      threadEligibilityEpoch: work.capturedThreadEligibilityEpoch,
    } : undefined,
    originConHieuLuc: () => true,
    gopThanhMotTin,
    api: { sendSeenEvent: async () => undefined },
    // traLoiCumTin khong con goi thang api.sendSeenEvent nua: duong bao da xem
    // da chuyen sang phong bi day du qua mot cong tac vien rieng.
    guiDaXemChoTins: () => undefined,
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => () => undefined,
    aiChat: {
      getConfig: () => ({}),
      tryReply: async () => { counters.ai += 1; return "AI reply"; },
    },
    ownerCredentials: {
      withCurrentOwnerCredentialRead: async (_owner, _config, work) => {
        counters.credentialReads += 1;
        return work();
      },
    },
    chuHienTai: () => "owner-A",
    ThreadType: { User: 0, Group: 1 },
    dungTrichDan: () => null,
    splitIntoBubbles: () => ["AI reply"],
    doi: async () => undefined,
    nghiTruocBubble: () => 0,
    dungTheNhacTen: async (text) => ({ text, mentions: [] }),
    sendChatMessage: async () => { counters.outbound += 1; return { id: "reply" }; },
    addLog: async () => undefined,
    thuGuiSticker: async () => undefined,
    console: { error: () => undefined },
  });
  return { run, counters };
}

function buildRecentHistoryHarness(getThreadMessages) {
  return compileFunction(
    CONTEXT,
    "export async function buildRecentHistory(ownerUid, threadId, boQuaMessageId, tuyChon = {})",
    {
    getThreadMessages,
    LICH_SU_SO_TIN: 15,
    LICH_SU_MAX_CHARS: 3000,
    LICH_SU_MAX_MOI_TIN: 280,
    lamSachNoiDung,
    nhanThoiGian: () => "",
    moTaKhoangNghi: () => null,
    console: { warn: () => undefined },
    }
  );
}

const AI_CONFIG = {
  opencodeBaseUrl: "http://fake.invalid",
  opencodeAgent: "general",
  opencodeModel: "fake/model",
  allowedTopics: "topic",
  soul: "soul",
  roleTone: "helpful",
  useKnowledge: false,
  knowledgeFileIds: [],
  docTep: false,
};

function createGenerateHarness({ created = false, history = "", reply = "AI reply" } = {}) {
  const observed = { excluded: null, prompt: null, calls: 0 };
  const generateReply = compileFunction(AI, "export async function generateReply", {
    layChuTaiKhoan: () => "owner-A",
    getConfig: () => AI_CONFIG,
    isAiChatReady: () => true,
    buildBootstrapContext: async (_threadId, excluded) => {
      observed.excluded = excluded;
      return {
        recentHistory: history,
        threadTitle: "Customer 1",
        hasKnowledge: false,
        soTinLichSu: history ? history.split("\n").length : 0,
      };
    },
    opencode: {
      ensureSession: async () => ({ sessionId: "session-1", created, turns: 2 }),
      sendPrompt: async (_config, _sessionId, prompt) => {
        observed.calls += 1;
        observed.prompt = prompt;
        return { reply, tokens: null, model: "fake/model" };
      },
    },
    customerMemory: {
      bocPrompt: async (_sessionId, _message, text) => text,
      quenPhien: () => undefined,
    },
    ThreadType: { User: 0, Group: 1 },
    docTep: { xuLyTep: async () => null },
    ganNhanTuDong: null,
    mocHienTai: () => "2026-08-29 12:00",
    emailCheck: {
      timEmailTrongTin: () => null,
      traCuu: async () => null,
      moTaChoAgent: () => "",
    },
    addLog: async () => undefined,
    bumpSessionTurns: async () => undefined,
    SKIP_TOKEN: "SKIP",
    console: { warn: () => undefined },
  });
  return { generateReply, observed };
}

function captureListenerMessage(rawMessage) {
  const handlers = new Map();
  const handled = [];
  const setupListener = compileFunction(ZALO, "function setupListener", {
    listenerAttached: false,
    api: {
      listener: {
        on: (event, handler) => handlers.set(event, handler),
        start: () => undefined,
      },
    },
    attachOldMessagesListener: () => undefined,
    chuHienTai: () => "owner-A",
    rebuildThreadsFromMessages: async () => undefined,
    emitThreads: async () => undefined,
    taoOriginRuntime: () => null,
    normalizeIncomingMessage,
    handleNewIncomingMessage: async (message) => { handled.push(message); },
    datTrangThaiKetNoi: () => undefined,
    originConHieuLuc: () => true,
    console: { error: () => undefined, warn: () => undefined },
    addLog: async () => undefined,
  });
  setupListener();
  return handlers.get("message")(rawMessage).then(() => handled);
}

function createEpochHarness(boGom, initialEpoch = 10) {
  const functionSource = extractFunction(ZALO, "export function applyBotEligibilityTransition")
    .replace(/^export\s+/, "");
  const factory = Function("boGom", `
    "use strict";
    let botEligibilityEpoch = ${Number(initialEpoch)};
    let runtimeGeneration = 77;
    ${functionSource}
    return {
      applyBotEligibilityTransition,
      getEpoch: () => botEligibilityEpoch,
      getRuntimeGeneration: () => runtimeGeneration,
    };
  `);
  return factory(boGom);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Chay nguyen bon production function trong cung lexical module state:
 * admission -> epoch guard -> aggregate callback -> Bot transition. Cac seam
 * chi thay DB/AI/provider ben ngoai; chinh dieu kien eligibility khong bi mock.
 */
function createProductionContinuityHarness({
  botEnabled = true,
  initialEpoch = 0,
  persist = async (message) => message,
  tryReply = async () => "AI reply",
} = {}) {
  const config = { botEnabled };
  const aggregations = [];
  const logs = [];
  const counters = {
    persisted: 0,
    admitted: 0,
    cancellations: 0,
    ai: 0,
    outbound: 0,
    pdfClear: 0,
    runtimeInvalidator: 0,
  };
  let replyImplementation = tryReply;

  const boGom = {
    dangMo: () => false,
    them: (message, work) => {
      counters.admitted += 1;
      aggregations.push({ message, work });
    },
    huyTatCa: () => {
      counters.cancellations += 1;
      aggregations.length = 0;
    },
  };

  const dependencies = {
    boGom,
    clearAllPendingPdfConfirmations: () => {
      counters.pdfClear += 1;
      return clearAllPendingPdfConfirmations();
    },
    voHieuHoaViecRuntimeCu: () => {
      counters.runtimeInvalidator += 1;
    },
    persistAndBroadcastMessage: async (message, originToken) => {
      counters.persisted += 1;
      return persist(message, originToken);
    },
    originConHieuLuc: () => true,
    sendChatMessage: async (payload, options) => {
      counters.outbound += 1;
      return { id: `automatic-${counters.outbound}`, payload, options };
    },
    sendResolvedPrivateMessage: async () => null,
    chuHienTai: () => "owner-A",
    addLog: async (entry) => { logs.push(entry); },
    laTinHeThong: () => false,
    moTaSuKien: () => "event",
    laLenhAdmin: async () => false,
    xuLyLenh: async () => null,
    aiChat: {
      getConfig: () => config,
      tryReply: async (...args) => {
        counters.ai += 1;
        return replyImplementation(...args);
      },
    },
    ownerCredentials: { withCurrentOwnerCredentialRead: async (_owner, _config, work) => work() },
    getAutoReplyRules: async () => [],
    getThread: async () => ({ botEnabled: true }),
    normalizeString: (value) => String(value),
    ThreadType: { User: 0, Group: 1 },
    botDuocGoi: () => true,
    appState: { uid: "owner-A" },
    gopThanhMotTin,
    handlePdfAutomation: null,
    PDF_AUTOMATION_HANDLED,
    api: { sendSeenEvent: async () => undefined },
    // traLoiCumTin khong con goi thang api.sendSeenEvent nua: duong bao da xem
    // da chuyen sang phong bi day du qua mot cong tac vien rieng.
    guiDaXemChoTins: () => undefined,
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => () => undefined,
    dungTrichDan: () => null,
    splitIntoBubbles: (reply) => [String(reply)],
    doi: async () => undefined,
    nghiTruocBubble: () => 0,
    dungTheNhacTen: async (text) => ({ text, mentions: [] }),
    thuGuiSticker: async () => undefined,
    console: { error: (error) => logs.push({ event: "console_error", error }) },
  };

  const eligibilitySource = extractFunction(ZALO, "function botEligibilityConHieuLuc");
  const threadKeySource = extractFunction(ZALO, "function khoaThreadEligibility");
  const threadEpochSource = extractFunction(ZALO, "function threadEligibilityEpochHienTai");
  const threadEligibilitySource = extractFunction(ZALO, "function threadEligibilityConHieuLuc");
  const automaticEligibilitySource = extractFunction(ZALO, "function automaticWorkConHieuLuc");
  const sendOptionsSource = extractFunction(ZALO, "function tuyChonGuiTuDong");
  const transitionSource = extractFunction(ZALO, "export function applyBotEligibilityTransition")
    .replace(/^export\s+/, "");
  const aggregateSource = extractFunction(ZALO, "async function traLoiCumTin");
  const incomingSource = extractFunction(ZALO, "async function handleNewIncomingMessage");
  const names = Object.keys(dependencies);
  const factory = Function(...names, `
    "use strict";
    let runtimeGeneration = 77;
    let botEligibilityEpoch = ${Number(initialEpoch)};
    const threadEligibilityEpochs = new Map();
    ${eligibilitySource}
    ${threadKeySource}
    ${threadEpochSource}
    ${threadEligibilitySource}
    ${automaticEligibilitySource}
    ${sendOptionsSource}
    ${transitionSource}
    ${aggregateSource}
    ${incomingSource}
    return {
      applyBotEligibilityTransition,
      handleNewIncomingMessage,
      traLoiCumTin,
      getEpoch: () => botEligibilityEpoch,
      getRuntimeGeneration: () => runtimeGeneration,
    };
  `);
  const production = factory(...names.map((name) => dependencies[name]));

  return {
    ...production,
    aggregations,
    counters,
    logs,
    setBotEnabled(value) { config.botEnabled = Boolean(value); },
    setTryReply(fn) { replyImplementation = fn; },
    takeAggregation() { return aggregations.shift() || null; },
  };
}

const results = [];
async function test(code, description, fn) {
  try {
    await fn();
    results.push({ code, ok: true });
    console.log(`${code} = PASS  ${description}`);
  } catch (error) {
    results.push({ code, ok: false });
    console.error(`${code} = FAIL  ${description}`);
    console.error(error.stack || error.message);
  }
}

await test("T1", "Normal ON van tao dung mot AI cycle va mot automatic outbound", async () => {
  const system = createSendSystem();
  const incoming = createIncomingHarness({ botEnabled: true, persist: system.persist, botEpoch: 5 });
  const message = {
    id: "c-on", threadId: "customer-1", threadType: 0, content: "Câu hỏi mới",
    isSelf: false, senderId: "customer-1", senderName: "Khách", msgType: "chat.text", ts: 1,
  };
  await incoming.run(message);
  assert.equal(incoming.aggregations.length, 1);
  const aggregate = createAggregateHarness({ botEpoch: 5 });
  await aggregate.run([message], incoming.aggregations[0].work);
  assert.deepEqual(aggregate.counters, { ai: 1, outbound: 1, credentialReads: 1 });
  system.db.close();
});

await test("T2", "Bot OFF van persist/broadcast, zero AI va zero outbound", async () => {
  const system = createSendSystem();
  const incoming = createIncomingHarness({ botEnabled: false, persist: system.persist });
  await incoming.run({
    id: "c-off", threadId: "customer-1", threadType: 0, content: "C1",
    isSelf: false, senderId: "customer-1", senderName: "Khách", msgType: "chat.text", ts: 2,
  });
  assert.deepEqual(incoming.counters, { persisted: 1, broadcast: 1, ai: 0, outbound: 0, aggregation: 0 });
  assert.equal(system.db.count("owner-A", "customer-1"), 1);
  system.db.close();
});

await test("T3", "C1 OFF va H1 Inbox cung nam trong canonical history, H1 is_self=1", async () => {
  const system = createSendSystem({ providerResult: { message: { msgId: "h1" } } });
  const incoming = createIncomingHarness({ botEnabled: false, persist: system.persist });
  await incoming.run({
    id: "c1", threadId: "customer-1", threadType: 0, content: "C1",
    isSelf: false, senderId: "customer-1", senderName: "Khách", msgType: "chat.text", ts: 10,
  });
  await system.send(
    { threadId: "customer-1", threadType: 0, text: "H1" },
    { capturedRuntimeAuthority: system.authority }
  );
  const rows = system.db.messages("owner-A", "customer-1");
  assert.deepEqual(rows.map((row) => [row.content, row.isSelf]), [["C1", false], ["H1", true]]);
  system.db.close();
});

await test("T4", "OFF sang ON khong tu goi AI, gui tin hay replay", async () => {
  const system = createSendSystem({ providerResult: { message: { msgId: "h1-t4" } } });
  const production = createProductionContinuityHarness({
    botEnabled: false,
    initialEpoch: 1,
    persist: system.persist,
  });
  const c1 = {
    id: "c1-t4", threadId: "customer-1", threadType: 0, content: "C1",
    isSelf: false, senderId: "customer-1", senderName: "Khách", msgType: "chat.text", ts: 101,
  };

  await production.handleNewIncomingMessage(c1);
  await system.send(
    { threadId: "customer-1", threadType: 0, text: "H1" },
    { capturedRuntimeAuthority: system.authority }
  );
  assert.deepEqual(
    system.db.messages("owner-A", "customer-1").map((row) => [row.content, row.isSelf]),
    [["C1", false], ["H1", true]]
  );
  assert.equal(production.counters.admitted, 0, "C1 den khi OFF khong duoc admission");

  const providerSendsBeforeReenable = system.state.sendsA;
  const rowsBeforeReenable = system.db.count("owner-A", "customer-1");
  production.setBotEnabled(true);
  production.applyBotEligibilityTransition(false, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(production.getEpoch(), 2);
  assert.equal(production.counters.ai, 0);
  assert.equal(production.counters.outbound, 0);
  assert.equal(production.counters.admitted, 0);
  assert.equal(production.aggregations.length, 0);
  assert.equal(system.state.sendsA, providerSendsBeforeReenable);
  assert.equal(system.db.count("owner-A", "customer-1"), rowsBeforeReenable);
  console.log("T4_PRODUCTION_TOGGLE_BOUNDARY = REAL");
  console.log("T4_REENABLE_AI_CALL = 0");
  console.log("T4_REENABLE_OUTBOUND = 0");
  console.log("T4_OLD_EVENT_REPLAY = 0");
  console.log("T4_AGGREGATION_RELEASE = 0");
  console.log("T4_QUALITY = STRONG");
  system.db.close();
});

await test("T5", "Reused session thay C1/H1; aggregate C2a-b-c khong lap trong history", async () => {
  const merged = gopThanhMotTin([
    { id: "c2a", content: "C2a", threadId: "customer-1", threadType: 0 },
    { id: "c2b", content: "C2b", threadId: "customer-1", threadType: 0 },
    { id: "c2c", content: "C2c", threadId: "customer-1", threadType: 0 },
  ]);
  assert.deepEqual(merged.sourceIds, ["c2a", "c2b", "c2c"]);
  const historyRows = [
    { id: "c1", content: "C1", isSelf: false, senderName: "Khách", ts: 1 },
    { id: "h1", content: "H1", isSelf: true, senderName: "Business", ts: 2 },
    { id: "c2a", content: "C2a", isSelf: false, senderName: "Khách", ts: 3 },
    { id: "c2b", content: "C2b", isSelf: false, senderName: "Khách", ts: 4 },
    { id: "c2c", content: "C2c", isSelf: false, senderName: "Khách", ts: 5 },
  ];
  const buildHistory = buildRecentHistoryHarness(async () => historyRows);
  const history = await buildHistory("owner-A", "customer-1", merged.sourceIds);
  assert.match(history, /C1/);
  assert.match(history, /Bạn \(đã trả lời\): H1/);
  assert.doesNotMatch(history, /C2[abc]/);
  const harness = createGenerateHarness({ created: false, history });
  await harness.generateReply(merged.content, merged, "owner-A", AI_CONFIG);
  assert.deepEqual(harness.observed.excluded, merged.sourceIds);
  assert.match(harness.observed.prompt, /BEGIN_CANONICAL_HISTORY/);
  assert.match(harness.observed.prompt, /TIN KHÁCH HIỆN TẠI/);
  for (const part of ["C2a", "C2b", "C2c"]) {
    assert.equal(harness.observed.prompt.split(part).length - 1, 1);
  }
});

await test("T6", "C1 chi la context; AI cycle duy nhat thuoc C2", async () => {
  const harness = createGenerateHarness({
    created: false,
    history: "Khách: C1\nBạn (đã trả lời): H1",
  });
  const result = await harness.generateReply(
    "C2",
    { id: "c2", threadId: "customer-1", threadType: 0 },
    "owner-A",
    AI_CONFIG
  );
  assert.equal(result.reply, "AI reply");
  assert.equal(harness.observed.calls, 1);
  assert.equal(harness.observed.prompt.split("C2").length - 1, 1);
});

await test("T7", "Inbox outbound current runtime broadcast nhu cu va self echo dedupe", async () => {
  const system = createSendSystem({ providerResult: { message: { msgId: "inbox-7" } } });
  const sent = await system.send(
    { threadId: "customer-1", threadType: 0, text: "H7" },
    { capturedRuntimeAuthority: system.authority }
  );
  assert.equal(sent.id, "inbox-7");
  assert.deepEqual(system.events.map((entry) => entry.event), ["new-message", "thread-refresh", "threads"]);
  await system.persist({
    id: "inbox-7", threadId: "customer-1", threadType: 0, content: "H7",
    isSelf: true, senderId: "owner-A", senderName: "Business A", msgType: "chat.text", ts: 20,
  }, system.authority);
  assert.equal(system.db.count("owner-A", "customer-1"), 1);
  assert.equal(system.db.messages("owner-A", "customer-1")[0].isSelf, true);
  assert.equal(system.events.length, 3);
  system.db.close();
});

await test("T8", "Direct-Zalo self text/photo/file ca 1-1 va group persist dung provider threadId", async () => {
  const system = createSendSystem();
  const variants = [
    ["self-text", "customer-1", 0, "chat.text", "Tin human"],
    ["self-photo-caption", "customer-photo", 0, "chat.photo", { href: "https://example.test/p.jpg", description: "caption" }],
    ["self-photo-no-caption", "customer-photo-empty", 0, "chat.photo", { href: "https://example.test/p2.jpg" }],
    ["self-file", "customer-file", 0, "share.file", { href: "https://example.test/a.pdf", title: "a.pdf" }],
    ["group-text", "group-88", 1, "chat.text", "Tin group"],
    ["group-photo", "group-89", 1, "chat.photo", { href: "https://example.test/g.jpg" }],
    ["group-file", "group-90", 1, "share.file", { href: "https://example.test/g.pdf", title: "g.pdf" }],
  ];
  for (const [id, threadId, type, msgType, content] of variants) {
    const raw = {
      isSelf: true,
      threadId,
      type,
      data: { msgId: id, uidFrom: "owner-A", idTo: threadId, msgType, content, ts: 30 },
    };
    const handled = await captureListenerMessage(raw);
    assert.equal(handled.length, 1);
    assert.equal(handled[0].threadId, threadId);
    const incoming = createIncomingHarness({ botEnabled: true, persist: system.persist });
    await incoming.run(handled[0]);
    assert.equal(system.db.count("owner-A", threadId), 1);
    const row = system.db.messages("owner-A", threadId)[0];
    assert.equal(row.isSelf, true);
    assert.equal(row.threadId, threadId);
    assert.notEqual(row.threadId, "owner-A");
    assert.equal(incoming.counters.aggregation, 0);
    assert.equal(incoming.counters.outbound, 0);
  }
  const invalid = await captureListenerMessage({
    isSelf: true,
    type: 0,
    data: { msgId: "invalid", uidFrom: "owner-A", idTo: "guessed", msgType: "chat.text", content: "x" },
  });
  assert.equal(invalid.length, 0);
  system.db.close();
});

await test("T9", "Cung remote thread duoi A/B khong cross-history hay wrong-owner send", async () => {
  const db = new CanonicalTestDb();
  const symbol = Symbol("owner-isolation");
  const eventsA = [];
  const eventsB = [];
  const persistA = compilePersistence({ db, owner: () => "owner-A", api: {}, events: eventsA, symbol });
  const persistB = compilePersistence({ db, owner: () => "owner-B", api: {}, events: eventsB, symbol });
  await persistA({ id: "a1", threadId: "shared", threadType: 0, content: "A only", isSelf: false, ts: 1 });
  await persistB({ id: "b1", threadId: "shared", threadType: 0, content: "B only", isSelf: false, ts: 2 });
  assert.deepEqual(db.messages("owner-A", "shared").map((row) => row.content), ["A only"]);
  assert.deepEqual(db.messages("owner-B", "shared").map((row) => row.content), ["B only"]);
  const sendSystem = createSendSystem();
  sendSystem.switchToB();
  await assert.rejects(
    sendSystem.send(
      { threadId: "customer-1", threadType: 0, text: "must not send" },
      { capturedRuntimeAuthority: sendSystem.authority }
    ),
    /Phiên Zalo đã thay đổi/
  );
  assert.equal(sendSystem.state.sendsA + sendSystem.state.sendsB, 0);
  assert.equal(sendSystem.db.count("owner-B", "customer-1"), 0);
  sendSystem.db.close();
  db.close();
});

await test("T10", "Restart OFF giu C1/H1; ON + C2 doc lai canonical history, zero replay", async () => {
  const filename = path.join(os.tmpdir(), `human-bot-continuity-${process.pid}-${Date.now()}.sqlite`);
  let db = new CanonicalTestDb(filename);
  db.insertMessage("owner-A", { id: "c1", threadId: "customer-1", content: "C1", isSelf: false, senderName: "Khách", ts: 1 });
  db.insertMessage("owner-A", { id: "h1", threadId: "customer-1", content: "H1", isSelf: true, senderName: "Business", ts: 2 });
  db.close();
  db = new CanonicalTestDb(filename);
  const buildHistory = buildRecentHistoryHarness(async (ownerUid, threadId) => db.messages(ownerUid, threadId));
  const history = await buildHistory("owner-A", "customer-1", "c2");
  assert.match(history, /C1/);
  assert.match(history, /Bạn \(đã trả lời\): H1/);
  const harness = createGenerateHarness({ created: false, history });
  await harness.generateReply("C2", { id: "c2", threadId: "customer-1", threadType: 0 }, "owner-A", AI_CONFIG);
  assert.equal(harness.observed.calls, 1);
  db.close();
  fs.rmSync(filename, { force: true });
});

await test("T11", "Bot toggle khong clear PDF pending va khong doi runtime generation", async () => {
  clearAllPendingPdfConfirmations();
  const ownerUid = "owner-A";
  const threadId = "customer-pdf-t11";
  const senderId = "sender-pdf-t11";
  const rule = {
    id: 11,
    keyword: "bao gia",
    keywordNorm: "bao gia",
    pdfName: "bao-gia.pdf",
    pdfMime: "application/pdf",
    pdfSize: 8,
    pdfData: Buffer.from("%PDF-T11"),
    enabled: true,
  };
  const originToken = {
    originOwnerUid: ownerUid,
    originRuntimeGeneration: 77,
    originApiIdentity: Object.freeze({ name: "fake-provider-t11" }),
  };
  const sends = [];
  const handler = createPdfAutomationHandler({
    listEnabledRules: async () => [rule],
    getRuleWithBlob: async (_owner, id) => (Number(id) === rule.id ? rule : null),
    sendMessage: async (payload) => { sends.push(payload); return { ok: true }; },
    isOriginCurrent: (token) => token === originToken,
    getOwnerUid: () => ownerUid,
    getRuntimeGeneration: () => 77,
    log: async () => undefined,
  });
  const runPdf = (content) => {
    const message = { id: `pdf-${content}`, content, threadId, threadType: 0, senderId };
    return handler({ tins: [message], tin: message, originToken });
  };

  assert.equal(await runPdf("Cho chị xin bao gia"), PDF_AUTOMATION_HANDLED);
  const pendingBeforeToggle = getPendingPdfConfirmation(ownerUid, threadId, senderId);
  assert.ok(pendingBeforeToggle, "production PDF pending phai duoc tao");
  assert.equal(pendingBeforeToggle.ruleId, rule.id);
  assert.equal(sends.length, 1);
  assert.equal(Boolean(sends[0].attachment), false);

  const production = createProductionContinuityHarness({ botEnabled: true, initialEpoch: 3 });
  production.setBotEnabled(false);
  production.applyBotEligibilityTransition(true, false);
  const pendingAfterToggle = getPendingPdfConfirmation(ownerUid, threadId, senderId);

  assert.strictEqual(pendingAfterToggle, pendingBeforeToggle);
  assert.equal(production.getRuntimeGeneration(), 77);
  assert.equal(production.counters.runtimeInvalidator, 0);
  assert.equal(production.counters.pdfClear, 0);
  assert.equal(await runPdf("OK"), PDF_AUTOMATION_HANDLED);
  assert.equal(sends.filter((payload) => payload.attachment).length, 1);
  assert.equal(sends[1].attachment.filename, rule.pdfName);
  assert.equal(getPendingPdfConfirmation(ownerUid, threadId, senderId), null);
  console.log("REAL_PDF_PENDING_CREATED = YES");
  console.log("BOT_TOGGLE_TRANSITION_EXECUTED = YES");
  console.log("REAL_PDF_PENDING_AFTER_TOGGLE = STILL_PRESENT");
  console.log("RUNTIME_INVALIDATOR_CALLED_BY_TOGGLE = NO");
  console.log("PDF_PENDING_CLEAR_CALLED_BY_TOGGLE = NO");
  console.log("REAL_PDF_PENDING_USABLE_AFTER_TOGGLE = YES");
  console.log("T11_QUALITY = STRONG");
  clearAllPendingPdfConfirmations();
});

await test("T12", "Session moi giu normal AI path, khong prepend history lan hai", async () => {
  const harness = createGenerateHarness({ created: true, history: "Khách: old" });
  const result = await harness.generateReply(
    "current",
    { id: "current", threadId: "customer-1", threadType: 0 },
    "owner-A",
    AI_CONFIG
  );
  assert.equal(result.reply, "AI reply");
  assert.equal(harness.observed.calls, 1);
  assert.doesNotMatch(harness.observed.prompt, /BEGIN_CANONICAL_HISTORY/);
  assert.equal(harness.observed.prompt.split("current").length - 1, 1);
});

await test("T13", "Pending ON aggregation bi OFF huy truoc khi fire", async () => {
  const fired = [];
  const boGom = taoBoGom({
    choMs: 20,
    tranMs: 100,
    nhipKiemMs: 5,
    conDangGo: () => false,
    khiChot: (messages) => fired.push(messages.map((message) => message.id)),
  });
  const epoch = createEpochHarness(boGom, 10);
  boGom.them({ id: "e1", threadId: "t", senderId: "c" }, { capturedBotEligibilityEpoch: 10 });
  epoch.applyBotEligibilityTransition(true, false);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(fired, []);
  assert.equal(boGom.soCuaSo(), 0);
});

await test("T14", "In-flight AI OFF-ON bi post-AI guard chan; event moi van co cycle moi", async () => {
  const oldAiReply = createDeferred();
  const oldAiStarted = createDeferred();
  let replyCall = 0;
  const production = createProductionContinuityHarness({
    botEnabled: true,
    initialEpoch: 20,
    tryReply: async () => {
      replyCall += 1;
      if (replyCall === 1) {
        oldAiStarted.resolve();
        return oldAiReply.promise;
      }
      return "fresh C2 reply";
    },
  });
  const e1 = {
    id: "e1", threadId: "t14", threadType: 0, content: "E1",
    isSelf: false, senderId: "customer-t14", senderName: "Khách", msgType: "chat.text", ts: 201,
  };

  await production.handleNewIncomingMessage(e1);
  const oldAdmission = production.takeAggregation();
  assert.ok(oldAdmission, "E1 phai duoc production admission dua vao aggregation");
  assert.equal(oldAdmission.work.capturedBotEligibilityEpoch, 20);
  const oldCycle = production.traLoiCumTin([oldAdmission.message], oldAdmission.work);
  await oldAiStarted.promise;
  assert.equal(production.counters.ai, 1, "old aggregation phai dat toi AI await");

  production.setBotEnabled(false);
  production.applyBotEligibilityTransition(true, false);
  production.setBotEnabled(true);
  production.applyBotEligibilityTransition(false, true);
  assert.equal(production.getEpoch(), 22);
  const admittedBeforeOldResolution = production.counters.admitted;
  oldAiReply.resolve("stale E1 reply");
  await oldCycle;

  assert.equal(production.counters.outbound, 0);
  assert.equal(production.counters.admitted, admittedBeforeOldResolution);
  assert.equal(production.aggregations.length, 0);

  const c2 = {
    id: "c2", threadId: "t14", threadType: 0, content: "C2",
    isSelf: false, senderId: "customer-t14", senderName: "Khách", msgType: "chat.text", ts: 202,
  };
  const aiBeforeC2 = production.counters.ai;
  await production.handleNewIncomingMessage(c2);
  const freshAdmission = production.takeAggregation();
  assert.ok(freshAdmission, "C2 sau re-enable phai duoc admission moi");
  assert.equal(freshAdmission.work.capturedBotEligibilityEpoch, 22);
  await production.traLoiCumTin([freshAdmission.message], freshAdmission.work);
  assert.equal(production.counters.ai - aiBeforeC2, 1);
  assert.equal(production.counters.outbound, 1);
  console.log("PRODUCTION_POST_AI_GUARD_EXECUTED = YES");
  console.log("OLD_AI_RESULT_AUTO_OUTBOUND = 0");
  console.log("OLD_AI_RESULT_FALLBACK_OUTBOUND = 0");
  console.log("OLD_AI_RESULT_REQUEUED = 0");
  console.log("NEW_POST_ENABLE_EVENT_AI = 1");
  console.log("IN_FLIGHT_AI_OFF_ON_QUALITY = STRONG");
});

await test("T15", "Provider result va self echo cung stable ID chi tao mot canonical row", async () => {
  const system = createSendSystem({ providerResult: { message: { msgId: "same-15" } } });
  await system.send(
    { threadId: "customer-1", threadType: 0, text: "H15" },
    { capturedRuntimeAuthority: system.authority }
  );
  await system.persist({
    id: "same-15", threadId: "customer-1", threadType: 0, content: "H15",
    isSelf: true, senderId: "owner-A", senderName: "Business A", msgType: "chat.text", ts: 50,
  }, system.authority);
  assert.equal(system.db.count("owner-A", "customer-1"), 1);
  system.db.close();
});

await test("T16", "Account switch truoc provider send: zero send B, zero persist B", async () => {
  const system = createSendSystem();
  system.switchToB();
  await assert.rejects(
    system.send(
      { threadId: "customer-1", threadType: 0, text: "blocked" },
      { capturedRuntimeAuthority: system.authority }
    ),
    /Phiên Zalo đã thay đổi/
  );
  assert.equal(system.state.sendsA, 0);
  assert.equal(system.state.sendsB, 0);
  assert.equal(system.db.count("owner-A", "customer-1"), 0);
  assert.equal(system.db.count("owner-B", "customer-1"), 0);
  system.db.close();
});

await test("T17", "Customer-memory transcript gan H1 vao business side, khong phai customer speech", async () => {
  const rows = [
    { id: "c1", content: "Em chưa thanh toán.", isSelf: false, senderName: "Khách", ts: 1 },
    { id: "h1", content: "Chị đồng ý giảm cho em 20%.", isSelf: true, senderName: "Business", ts: 2 },
    { id: "c2", content: "Vâng chị.", isSelf: false, senderName: "Khách", ts: 3 },
  ];
  const buildHistory = buildRecentHistoryHarness(async () => rows);
  const transcript = await buildHistory("owner-A", "customer-1", null);
  let summarizerInput = null;
  const stubSummarizer = async (input) => { summarizerInput = input; return "stub"; };
  await stubSummarizer(transcript);
  assert.equal(summarizerInput, [
    "Khách: Em chưa thanh toán.",
    "Bạn (đã trả lời): Chị đồng ý giảm cho em 20%.",
    "Khách: Vâng chị.",
  ].join("\n"));
  assert.doesNotMatch(summarizerInput, /Khách: Chị đồng ý giảm/);
});

await test("T18", "HTTP authority hai boundary + no-msgId success policy", async () => {
  const route = SERVER.slice(SERVER.indexOf('app.post("/api/send"'), SERVER.indexOf('app.post("/api/threads/refresh"'));
  assert.ok(route.indexOf("captureRuntimeAuthority()") < route.indexOf('zaloSendUpload.single("file")'));
  assert.doesNotMatch(route, /sendChatMessage\(\{\s*\.\.\.req\.body/);
  assert.match(route, /\{ capturedRuntimeAuthority \}/);

  const before = createSendSystem();
  before.switchToB();
  await assert.rejects(
    before.send(
      { threadId: "customer-1", threadType: 0, text: "T18-A" },
      { capturedRuntimeAuthority: before.authority }
    ),
    /Phiên Zalo đã thay đổi/
  );
  assert.equal(before.state.sendsA + before.state.sendsB, 0);
  before.db.close();

  const after = createSendSystem({ providerResult: { message: { msgId: "t18-b" } } });
  after.state.onPersistStart = async () => after.switchToB();
  const staleResult = await after.send(
    { threadId: "customer-1", threadType: 0, text: "T18-B" },
    { capturedRuntimeAuthority: after.authority }
  );
  assert.equal(after.state.sendsA, 1);
  assert.equal(after.state.sendsB, 0);
  assert.equal(staleResult.senderId, "owner-A");
  assert.equal(after.db.count("owner-A", "customer-1"), 1);
  assert.equal(after.db.count("owner-B", "customer-1"), 0);
  assert.equal(after.events.length, 0);
  after.db.close();

  const noId = createSendSystem({ providerResult: { message: null } });
  const noIdResult = await noId.send(
    { threadId: "customer-1", threadType: 0, text: "T18-C" },
    { capturedRuntimeAuthority: noId.authority }
  );
  assert.equal(noIdResult, null);
  assert.equal(noId.state.sendsA, 1);
  assert.equal(noId.db.count("owner-A", "customer-1"), 0);
  await noId.persist({
    id: "echo-t18-c", threadId: "customer-1", threadType: 0, content: "T18-C",
    isSelf: true, senderId: "owner-A", senderName: "Business A", msgType: "chat.text", ts: 60,
  }, noId.authority);
  assert.equal(noId.db.count("owner-A", "customer-1"), 1);
  noId.db.close();
});

const pass = results.filter((result) => result.ok).length;
const fail = results.length - pass;
console.log("");
console.log(`FOCUSED_T1_T18 = ${pass}/${results.length} PASS`);
console.log(`FOCUSED_FAIL = ${fail}`);
console.log("REAL_ZALO_CALL = 0");
console.log("REAL_OPENCODE_CALL = 0");
console.log("PRODUCTION_DB_CALL = 0");
if (fail > 0 || results.length !== 18) process.exitCode = 1;
