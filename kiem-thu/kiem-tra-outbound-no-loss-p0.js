import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZaloApiError } from "zca-js";
import { taoDieuPhoiHoiThoai } from "../lib/conversation-inflight.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZALO = fs.readFileSync(path.join(ROOT, "lib", "zalo-service.js"), "utf8")
  .replace(/\r\n/g, "\n");

function compileNamed(source, name, dependencies) {
  const names = Object.keys(dependencies);
  return Function(...names, `"use strict";\n${source}\nreturn ${name};`)(
    ...names.map((key) => dependencies[key])
  );
}

function extract(startText, endText) {
  const start = ZALO.indexOf(startText);
  const end = ZALO.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `Khong tach duoc ${startText}`);
  return ZALO.slice(start, end);
}

const OUTBOUND_OUTCOME = Object.freeze({
  DEFINITIVE_PROVIDER_REJECTION: "DEFINITIVE_PROVIDER_REJECTION",
  DETERMINISTIC_CLIENT_ERROR: "DETERMINISTIC_CLIENT_ERROR",
  SEND_UNKNOWN: "SEND_UNKNOWN",
});
const loiClientZcaChacChan = [
  "Missing message content",
  "Invalid mentions:",
  "Missing attachments",
  "This kind of `webchat` quote type is not available",
  "The `group.poll` quote type is not available",
  "Failed to encrypt message",
];
const OUTBOUND_OUTCOME_FIELD = "vizenOutboundOutcome";

const classifierSource = extract(
  "export function phanLoaiLoiGuiProvider(",
  "\nfunction ganOutcomeChoLoi"
).replace("export function", "function");
const phanLoaiLoiGuiProvider = compileNamed(
  classifierSource,
  "phanLoaiLoiGuiProvider",
  { ZaloApiError, OUTBOUND_OUTCOME, loiClientZcaChacChan }
);
function ganOutcomeChoLoi(error, outcome) {
  if (error && typeof error === "object") error[OUTBOUND_OUTCOME_FIELD] = outcome;
}

function fakeGeneration() {
  const state = {
    accepted: false,
    reserved: false,
    stale: false,
    staleDeferred: false,
    sendUnknown: false,
    outboundContextAdvanced: false,
    confirms: 0,
    releases: 0,
  };
  return {
    state,
    conHieuLuc: () => !state.stale,
    giuChoOutbound() {
      if (state.stale || state.reserved) return false;
      state.reserved = true;
      return true;
    },
    xacNhanOutbound() {
      state.confirms += 1;
      state.accepted = true;
      state.reserved = false;
      state.staleDeferred = false;
      state.sendUnknown = false;
    },
    traLaiOutbound() {
      state.releases += 1;
      state.reserved = false;
      if (state.staleDeferred && !state.accepted) state.stale = true;
      state.staleDeferred = false;
    },
    danhDauSendUnknown() {
      state.reserved = false;
      state.sendUnknown = true;
      state.staleDeferred = false;
    },
    outboundContextDaTienLen() {
      return state.outboundContextAdvanced;
    },
  };
}

function compileSend(api, providerCalls) {
  const source = extract(
    "export async function sendChatMessage(",
    "\n/**\n * Gui dung mot tin rieng"
  ).replace("export async function", "async function");
  return compileNamed(source, "sendChatMessage", {
    api,
    appState: { loggedIn: true, uid: "OWNER", displayName: "Bot", myAvatar: null },
    ThreadType: { User: 0, Group: 1 },
    originConHieuLuc: () => true,
    botEligibilityConHieuLuc: () => true,
    threadEligibilityConHieuLuc: () => true,
    chuHienTai: () => "OWNER",
    getThread: async () => ({ id: "THREAD" }),
    locTruocKhiGui: async (text) => text,
    taoNguonDinhKemZalo: (attachment) => attachment,
    timLinkChinh: (text) => text.startsWith("https://")
      ? { duongDan: text, loiNhan: "" }
      : null,
    CONFIRMED_OUTBOUND_AUTHORITY: Symbol("confirmed"),
    SEND_REJECTED_BEFORE_PROVIDER: Object.freeze({ authorityRejectedBeforeProvider: true }),
    phanLoaiLoiGuiProvider,
    ganOutcomeChoLoi,
    OUTBOUND_OUTCOME,
    layMsgIdTuKetQuaGui: (result) => result?.msgId ?? result?.message?.msgId ?? null,
    addLog: async () => {},
    normalizeTs: (value) => value,
    persistAndBroadcastMessage: async (message) => message,
    providerCalls,
  });
}

async function testProviderBoundary() {
  const branches = [
    { payload: { text: "plain" }, expected: "plain" },
    { payload: { text: "https://example.com" }, expected: "link" },
    { payload: { text: "mention", mentions: [{ pos: 0, uid: "U", len: 1 }] }, expected: "rich" },
    { payload: { text: "media", attachment: { filename: "a.pdf" } }, expected: "media" },
  ];
  for (const branch of branches) {
    const calls = [];
    const generation = fakeGeneration();
    const api = {
      sendLink: async () => {
        calls.push("link");
        assert.equal(generation.state.accepted, false);
        return { msgId: "L" };
      },
      sendMessage: async (message) => {
        const kind = typeof message === "string"
          ? "plain"
          : message.attachments ? "media" : "rich";
        calls.push(kind);
        assert.equal(generation.state.accepted, false);
        return { message: { msgId: kind } };
      },
    };
    const send = compileSend(api, calls);
    await send({ threadId: "THREAD", threadType: 0, ...branch.payload }, {
      conversationGeneration: generation,
      reportAuthorityRejectionBeforeProvider: true,
    });
    assert.deepEqual(calls, [branch.expected]);
    assert.equal(generation.state.accepted, true);
    assert.equal(generation.state.confirms, 1);
  }

  const nullCalls = [];
  const nullGeneration = fakeGeneration();
  const nullSend = compileSend({
    sendMessage: async () => {
      nullCalls.push("provider");
      return { message: null };
    },
    sendLink: async () => assert.fail("wrong branch"),
  }, nullCalls);
  const result = await nullSend({ threadId: "THREAD", text: "null-success", threadType: 0 }, {
    conversationGeneration: nullGeneration,
    reportAuthorityRejectionBeforeProvider: true,
  });
  assert.equal(result, null);
  assert.equal(nullCalls.length, 1);
  assert.equal(nullGeneration.state.accepted, true);

  const rejectedGeneration = fakeGeneration();
  rejectedGeneration.state.stale = true;
  let rejectedCalls = 0;
  const rejectedSend = compileSend({
    sendMessage: async () => { rejectedCalls += 1; },
    sendLink: async () => { rejectedCalls += 1; },
  }, []);
  const rejected = await rejectedSend({ threadId: "THREAD", text: "stale", threadType: 0 }, {
    conversationGeneration: rejectedGeneration,
    reportAuthorityRejectionBeforeProvider: true,
  });
  assert.equal(rejected.authorityRejectedBeforeProvider, true);
  assert.equal(rejectedCalls, 0);
  assert.equal(rejectedGeneration.state.accepted, false);

  const advancedGeneration = fakeGeneration();
  advancedGeneration.state.accepted = true;
  advancedGeneration.state.outboundContextAdvanced = true;
  let advancedCalls = 0;
  const guardedRetrySend = compileSend({
    sendMessage: async () => { advancedCalls += 1; },
    sendLink: async () => { advancedCalls += 1; },
  }, []);
  const guardedRetry = await guardedRetrySend({ threadId: "THREAD", text: "old-retry", threadType: 0 }, {
    conversationGeneration: advancedGeneration,
    requireUnadvancedOutboundContext: true,
    reportAuthorityRejectionBeforeProvider: true,
  });
  assert.equal(guardedRetry.authorityRejectedBeforeProvider, true);
  assert.equal(advancedCalls, 0);
}

async function testFailureClassificationAndRelease() {
  assert.equal(
    phanLoaiLoiGuiProvider(new ZaloApiError("provider reject", 127)),
    OUTBOUND_OUTCOME.DEFINITIVE_PROVIDER_REJECTION
  );
  assert.equal(
    phanLoaiLoiGuiProvider(Object.assign(new Error("socket"), { code: 127 })),
    OUTBOUND_OUTCOME.SEND_UNKNOWN
  );
  assert.equal(
    phanLoaiLoiGuiProvider(new ZaloApiError("Invalid mentions: bad")),
    OUTBOUND_OUTCOME.DETERMINISTIC_CLIENT_ERROR
  );
  assert.equal(
    phanLoaiLoiGuiProvider(new TypeError("fetch failed")),
    OUTBOUND_OUTCOME.SEND_UNKNOWN
  );

  for (const [error, expectedState] of [
    [new ZaloApiError("reject", 127), "released"],
    [Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }), "unknown"],
  ]) {
    const generation = fakeGeneration();
    const send = compileSend({
      sendMessage: async () => { throw error; },
      sendLink: async () => assert.fail("wrong branch"),
    }, []);
    await assert.rejects(send(
      { threadId: "THREAD", text: "x", threadType: 0 },
      { conversationGeneration: generation }
    ));
    if (expectedState === "released") {
      assert.equal(generation.state.releases, 1);
      assert.equal(error.vizenOutboundOutcome, "DEFINITIVE_PROVIDER_REJECTION");
    } else {
      assert.equal(generation.state.sendUnknown, true);
      assert.equal(error.vizenOutboundOutcome, "SEND_UNKNOWN");
    }
    assert.equal(generation.state.accepted, false);
  }
}

function compileReply(sendChatMessage, bubbles, logs, counters, overrides = {}) {
  const source = extract(
    "async function traLoiCumTin(",
    "\nasync function handleNewIncomingMessage"
  );
  return compileNamed(source, "traLoiCumTin", {
    automaticWorkConHieuLuc: () => true,
    tuyChonGuiTuDong: (work) => work || {},
    addLog: async (entry) => { logs.push(entry); },
    originConHieuLuc: () => true,
    gopThanhMotTin: (messages) => ({ ...messages.at(-1), content: messages.map((m) => m.content).join("\n") }),
    guiDaXemChoTins: () => {},
    thuThaCamXuc: async () => false,
    batDauGoPhim: () => () => {},
    aiChat: {
      getConfig: () => ({ botEnabled: true }),
      tryReply: async () => { counters.llm += 1; return "AI"; },
    },
    ownerCredentials: { withCurrentOwnerCredentialRead: async (_owner, _config, work) => work() },
    chuHienTai: () => "OWNER",
    ThreadType: { User: 0, Group: 1 },
    splitIntoBubbles: () => bubbles,
    doi: async () => {},
    nghiTruocBubble: () => 0,
    dungTrichDan: () => null,
    dungTheNhacTen: async (text) => ({ text, mentions: [] }),
    sendChatMessage,
    completeAdminClarificationAck: async () => {},
    thuGuiSticker: async () => {},
    thongBaoAdminLoiOutbound: async () => { counters.notifications += 1; },
    io: null,
    NHAC_GO_PHIM_MS: 3000,
    console: { error: () => {} },
    BO_LICH_SU_STALE: "STALE",
    ...overrides,
  });
}

async function runReplyPlan(bubbles, plan) {
  const calls = [];
  const logs = [];
  const counters = { llm: 0, notifications: 0 };
  let cursor = 0;
  const send = async ({ text }) => {
    calls.push(text);
    const outcome = plan[cursor++];
    if (outcome === "definitive" || outcome === "unknown") {
      const error = new Error(outcome);
      error.vizenOutboundOutcome = outcome === "definitive"
        ? "DEFINITIVE_PROVIDER_REJECTION"
        : "SEND_UNKNOWN";
      if (outcome === "definitive") error.code = 127;
      throw error;
    }
    if (outcome === "sentinel") return { authorityRejectedBeforeProvider: true };
    if (outcome === "null") return null;
    return { id: `M-${cursor}` };
  };
  const reply = compileReply(send, bubbles, logs, counters);
  await reply([{ id: "IN", senderId: "C", threadId: "T", threadType: 0, content: "hello" }]);
  return { calls, logs, counters };
}

async function testBubbleRetry() {
  const retry = await runReplyPlan(["same"], ["definitive", "success"]);
  assert.deepEqual(retry.calls, ["same", "same"]);
  assert.equal(retry.counters.llm, 1);
  assert.equal(retry.counters.notifications, 0);

  const exhausted = await runReplyPlan(["same"], ["definitive", "definitive"]);
  assert.deepEqual(exhausted.calls, ["same", "same"]);
  assert.equal(exhausted.counters.notifications, 1);
  assert.equal(exhausted.logs.filter((entry) => entry.event === "outbound_terminal_failure").length, 1);

  const unknown = await runReplyPlan(["same"], ["unknown", "success"]);
  assert.deepEqual(unknown.calls, ["same"]);
  assert.equal(unknown.counters.notifications, 1);

  const nullSuccess = await runReplyPlan(["same"], ["null"]);
  assert.deepEqual(nullSuccess.calls, ["same"]);
  assert.equal(nullSuccess.logs.filter((entry) => entry.event === "send_ok").length, 1);

  const multi = await runReplyPlan(["b0", "b1", "b2"], ["success", "success", "definitive", "success"]);
  assert.deepEqual(multi.calls, ["b0", "b1", "b2", "b2"]);
  assert.equal(multi.counters.llm, 1);
}

function msg(id, threadId = "T") {
  return { id, senderId: "C", threadId, content: id };
}

async function testDeferredStale() {
  const runScenario = async (outcome) => {
    const runs = [];
    let coordinator;
    coordinator = taoDieuPhoiHoiThoai({
      chay: async (work, generation) => {
        const ids = work.tins.map((item) => item.id);
        runs.push(ids);
        if (ids.length !== 1 || ids[0] !== "A") {
          generation.chapNhanOutbound();
          return;
        }
        assert.equal(generation.giuChoOutbound(), true);
        const pending = coordinator.them({ ownerUid: "O", threadId: "T", tins: [msg("B")] });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(generation.staleDeferred, true);
        if (outcome === "success") generation.xacNhanOutbound();
        if (outcome === "reject") generation.traLaiOutbound();
        if (outcome === "unknown") generation.danhDauSendUnknown();
        void pending;
      },
    });
    await coordinator.them({ ownerUid: "O", threadId: "T", tins: [msg("A")] });
    return runs;
  };

  assert.deepEqual(await runScenario("success"), [["A"], ["B"]]);
  assert.deepEqual(await runScenario("reject"), [["A"], ["A", "B"]]);
  assert.deepEqual(await runScenario("unknown"), [["A"], ["B"]]);
}

async function testDeferredStaleThroughBubbleLoop() {
  const runScenario = async (outcome) => {
    const sends = [];
    const runs = [];
    const logs = [];
    const counters = { llm: 0, notifications: 0 };
    let injected = false;
    let coordinator;
    const send = async (_payload, options) => {
      const generation = options.conversationGeneration;
      assert.equal(generation.giuChoOutbound(), true);
      sends.push(generation.id);
      if (!injected) {
        injected = true;
        void coordinator.them({
          ownerUid: "O",
          threadId: "T",
          tins: [msg("B")],
          automaticWork: { originToken: null },
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(generation.staleDeferred, true);
        if (outcome === "success") {
          generation.xacNhanOutbound();
          return { id: "A" };
        }
        if (outcome === "reject") {
          generation.traLaiOutbound();
          const error = new Error("reject");
          error.code = 127;
          error.vizenOutboundOutcome = "DEFINITIVE_PROVIDER_REJECTION";
          throw error;
        }
        generation.danhDauSendUnknown();
        const error = new Error("unknown");
        error.vizenOutboundOutcome = "SEND_UNKNOWN";
        throw error;
      }
      generation.xacNhanOutbound();
      return { id: `M-${generation.id}` };
    };
    const reply = compileReply(send, ["bubble"], logs, counters);
    coordinator = taoDieuPhoiHoiThoai({
      chay: async (work, generation) => {
        runs.push(work.tins.map((item) => item.id));
        await reply(work, work.segments[0]?.automaticWork || null, generation);
      },
    });
    await coordinator.them({
      ownerUid: "O",
      threadId: "T",
      tins: [msg("A")],
      automaticWork: { originToken: null },
    });
    return { sends, runs, counters };
  };

  const success = await runScenario("success");
  assert.deepEqual(success.sends, [1, 2]);
  assert.deepEqual(success.runs, [["A"], ["B"]]);

  const reject = await runScenario("reject");
  assert.deepEqual(reject.sends, [1, 2], "reply cu khong duoc provider retry");
  assert.deepEqual(reject.runs, [["A"], ["A", "B"]]);
  assert.equal(reject.counters.notifications, 0);

  const unknown = await runScenario("unknown");
  assert.deepEqual(unknown.sends, [1, 2], "SEND_UNKNOWN khong replay current work");
  assert.deepEqual(unknown.runs, [["A"], ["B"]]);
  assert.equal(unknown.counters.notifications, 1);
}

async function runPartialReplyScenario({ bubbles, injectAt = null, oldOutcomes }) {
  const calls = [];
  const runs = [];
  const logs = [];
  const counters = { llm: 0, notifications: 0 };
  const attempts = new Map();
  let injected = false;
  let firstGeneration = null;
  let coordinator;

  const enqueueNewInbound = async (generation) => {
    if (injected) return;
    injected = true;
    void coordinator.them({
      ownerUid: "O",
      threadId: "T",
      tins: [msg("B")],
      automaticWork: { originToken: null },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(generation.outboundContextDaTienLen(), true);
  };

  const send = async ({ text }, options) => {
    const generation = options.conversationGeneration;
    if (generation.id === 1) firstGeneration = generation;
    if (options.requireUnadvancedOutboundContext === true
      && generation.outboundContextDaTienLen() === true) {
      return { authorityRejectedBeforeProvider: true };
    }
    assert.equal(generation.giuChoOutbound(), true);
    const key = `${generation.id}:${text}`;
    const attempt = (attempts.get(key) || 0) + 1;
    attempts.set(key, attempt);
    calls.push({ generationId: generation.id, text, attempt });

    if (generation.id === 1 && injectAt === "during-b1"
      && text === "b1" && attempt === 1) {
      await enqueueNewInbound(generation);
    }

    const outcome = generation.id === 1
      ? (oldOutcomes[text]?.[attempt - 1] || "success")
      : "success";
    if (outcome === "success") {
      generation.xacNhanOutbound();
      if (generation.id === 1 && injectAt === "between-b0-b1"
        && text === "b0" && attempt === 1) {
        await enqueueNewInbound(generation);
      }
      return { id: `M-${generation.id}-${text}-${attempt}` };
    }
    if (outcome === "definitive") {
      generation.traLaiOutbound();
      const error = new Error("definitive");
      error.code = 127;
      error.vizenOutboundOutcome = "DEFINITIVE_PROVIDER_REJECTION";
      throw error;
    }
    generation.danhDauSendUnknown();
    const error = new Error("unknown");
    error.vizenOutboundOutcome = "SEND_UNKNOWN";
    throw error;
  };

  const addLog = async (entry) => {
    logs.push(entry);
    if (injectAt === "during-retry-log" && entry.event === "outbound_provider_retry") {
      await enqueueNewInbound(firstGeneration);
    }
  };
  const reply = compileReply(send, bubbles, logs, counters, { addLog });
  coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      runs.push({
        generationId: generation.id,
        ids: work.tins.map((item) => item.id),
      });
      await reply(work, work.segments[0]?.automaticWork || null, generation);
    },
  });
  await coordinator.them({
    ownerUid: "O",
    threadId: "T",
    tins: [msg("A")],
    automaticWork: { originToken: null },
  });
  return { calls, runs, logs, counters };
}

async function testP1APartialInboundDuringLaterReject() {
  const result = await runPartialReplyScenario({
    bubbles: ["b0", "b1", "b2"],
    injectAt: "during-b1",
    oldOutcomes: { b0: ["success"], b1: ["definitive"] },
  });
  assert.deepEqual(
    result.calls.filter((call) => call.generationId === 1).map((call) => call.text),
    ["b0", "b1"]
  );
  assert.equal(result.calls.filter((call) => call.generationId === 1 && call.text === "b1").length, 1);
  assert.deepEqual(result.runs.map((run) => run.ids), [["A"], ["B"]]);
  assert.equal(result.counters.llm, 2, "chi AI cho old A va pending B, khong regenerate old work");
  assert.equal(result.logs.filter((entry) => entry.event === "outbound_partial_stopped_context_advanced").length, 1);
}

async function testP1BInboundBetweenBubbles() {
  const result = await runPartialReplyScenario({
    bubbles: ["b0", "b1"],
    injectAt: "between-b0-b1",
    oldOutcomes: { b0: ["success"], b1: ["definitive"] },
  });
  assert.equal(result.calls.filter((call) => call.generationId === 1 && call.text === "b0").length, 1);
  assert.equal(result.calls.filter((call) => call.generationId === 1 && call.text === "b1").length, 1);
  assert.deepEqual(result.runs.map((run) => run.ids), [["A"], ["B"]]);
}

async function testP1CFlagPersistsAcrossLaterSuccess() {
  const result = await runPartialReplyScenario({
    bubbles: ["b0", "b1", "b2"],
    injectAt: "between-b0-b1",
    oldOutcomes: { b0: ["success"], b1: ["success"], b2: ["definitive"] },
  });
  assert.deepEqual(
    result.calls.filter((call) => call.generationId === 1).map((call) => call.text),
    ["b0", "b1", "b2"]
  );
  assert.equal(result.calls.filter((call) => call.generationId === 1 && call.text === "b2").length, 1);
  assert.deepEqual(result.runs.map((run) => run.ids), [["A"], ["B"]]);
  assert.equal(result.logs.filter((entry) => entry.event === "outbound_partial_stopped_context_advanced").length, 1);
}

async function testP1DUnchangedContextStillRetries() {
  const result = await runPartialReplyScenario({
    bubbles: ["b0", "b1"],
    oldOutcomes: { b0: ["success"], b1: ["definitive", "success"] },
  });
  assert.deepEqual(
    result.calls.filter((call) => call.generationId === 1).map((call) => call.text),
    ["b0", "b1", "b1"]
  );
  assert.deepEqual(result.runs.map((run) => run.ids), [["A"]]);
  assert.equal(result.counters.llm, 1);
}

async function testP1EPartialContextAdvancedSendUnknown() {
  const result = await runPartialReplyScenario({
    bubbles: ["b0", "b1", "b2"],
    injectAt: "during-b1",
    oldOutcomes: { b0: ["success"], b1: ["unknown"] },
  });
  assert.deepEqual(
    result.calls.filter((call) => call.generationId === 1).map((call) => call.text),
    ["b0", "b1"]
  );
  assert.deepEqual(result.runs.map((run) => run.ids), [["A"], ["B"]]);
  assert.equal(result.counters.llm, 2);
  assert.equal(result.counters.notifications, 1);
}

async function testP1FRetryGuardRechecksAfterAwait() {
  const result = await runPartialReplyScenario({
    bubbles: ["b0", "b1"],
    injectAt: "during-retry-log",
    oldOutcomes: { b0: ["success"], b1: ["definitive", "success"] },
  });
  assert.equal(result.calls.filter((call) => call.generationId === 1 && call.text === "b1").length, 1);
  assert.deepEqual(result.runs.map((run) => run.ids), [["A"], ["B"]]);
  assert.equal(result.logs.filter((entry) => entry.event === "outbound_partial_stopped_context_advanced").length, 1);
}

function compileReaction(reactToMessage) {
  const source = extract(
    "async function thuThaCamXuc(",
    "\n/* --- STICKER --- */"
  );
  return compileNamed(source, "thuThaCamXuc", {
    automaticWorkConHieuLuc: (work) => (
      !work?.conversationGeneration || work.conversationGeneration.conHieuLuc()
    ),
    originConHieuLuc: () => true,
    chonCamXuc: () => "HEART",
    layBieuTuong: () => "HEART_ICON",
    addLog: async () => {},
    danhSachChoPhep: () => ["HEART", "LIKE"],
    layMaTin: () => ({ msgId: "MESSAGE_ID", cliMsgId: "CLIENT_MESSAGE_ID" }),
    api: { addReaction: async () => {} },
    reactToMessage,
    console: { warn: () => {} },
  });
}

function reactionMessage(id = "A") {
  return {
    id,
    senderId: "C",
    senderName: "Customer",
    threadId: "T",
    threadType: 0,
    content: "cam on em",
  };
}

async function testR1ReactionSuccess() {
  const generation = fakeGeneration();
  let providerCalls = 0;
  let textReplies = 0;
  const reaction = compileReaction(async (_payload, _origin, internalOptions) => {
    providerCalls += 1;
    assert.equal(generation.state.accepted, false, "khong accepted truoc provider");
    assert.equal(generation.state.reserved, true, "reaction phai reserve tai provider boundary");
    internalOptions.onProviderSuccess();
  });

  const handled = await reaction(reactionMessage(), null, { conversationGeneration: generation });
  if (!handled) textReplies += 1;
  assert.equal(handled, true);
  assert.equal(providerCalls, 1);
  assert.equal(generation.state.accepted, true);
  assert.equal(generation.state.reserved, false);
  assert.equal(generation.state.confirms, 1);
  assert.equal(textReplies, 0);

  const rejectedGeneration = fakeGeneration();
  rejectedGeneration.giuChoOutbound = () => false;
  let rejectedProviderCalls = 0;
  const rejectedReaction = compileReaction(async () => { rejectedProviderCalls += 1; });
  assert.equal(await rejectedReaction(
    reactionMessage("REJECTED"),
    null,
    { conversationGeneration: rejectedGeneration }
  ), false);
  assert.equal(rejectedProviderCalls, 0);
  assert.equal(rejectedGeneration.state.accepted, false);
}

async function testR2ReactionFailureNoInbound() {
  const generation = fakeGeneration();
  let providerCalls = 0;
  let textReplies = 0;
  const reaction = compileReaction(async (_payload, _origin, internalOptions) => {
    providerCalls += 1;
    assert.equal(generation.state.accepted, false);
    throw new Error("reaction rejected");
  });

  const handled = await reaction(reactionMessage(), null, { conversationGeneration: generation });
  if (!handled && generation.conHieuLuc()) textReplies += 1;
  assert.equal(handled, false);
  assert.equal(providerCalls, 1);
  assert.equal(generation.state.accepted, false);
  assert.equal(generation.state.reserved, false);
  assert.equal(generation.state.releases, 1);
  assert.equal(textReplies, 1, "fallback text van duoc phep khi context khong doi");
}

async function runReactionInboundRace(outcome) {
  const runs = [];
  let coordinator;
  let activeGeneration;
  let pendingB;
  let providerCalls = 0;
  let oldTextReplies = 0;
  let firstState;
  const reaction = compileReaction(async (_payload, _origin, internalOptions) => {
    providerCalls += 1;
    assert.equal(activeGeneration.accepted, false);
    assert.equal(activeGeneration.outboundReserved, true);
    pendingB = coordinator.them({ ownerUid: "O", threadId: "T", tins: [msg("B")] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activeGeneration.staleDeferred, true);
    if (outcome === "failure") throw new Error("reaction rejected after B");
    internalOptions.onProviderSuccess();
  });

  coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      const ids = work.tins.map((item) => item.id);
      runs.push(ids);
      if (runs.length !== 1) {
        generation.chapNhanOutbound();
        return;
      }

      activeGeneration = generation;
      const handled = await reaction(reactionMessage(), null, { conversationGeneration: generation });
      firstState = {
        handled,
        accepted: generation.accepted,
        reserved: generation.outboundReserved,
        stale: generation.stale,
        staleDeferred: generation.staleDeferred,
      };
      if (!handled && generation.conHieuLuc()) {
        oldTextReplies += 1;
        generation.chapNhanOutbound();
      }
    },
  });

  await coordinator.them({ ownerUid: "O", threadId: "T", tins: [msg("A")] });
  if (pendingB) await pendingB;
  return { runs, providerCalls, oldTextReplies, firstState };
}

async function testR3ReactionFailureWithNewInbound() {
  const result = await runReactionInboundRace("failure");
  assert.deepEqual(result.runs, [["A"], ["A", "B"]]);
  assert.equal(result.providerCalls, 1);
  assert.equal(result.oldTextReplies, 0);
  assert.deepEqual(result.firstState, {
    handled: false,
    accepted: false,
    reserved: false,
    stale: true,
    staleDeferred: false,
  });
}

async function testR4ReactionSuccessWithNewInbound() {
  const result = await runReactionInboundRace("success");
  assert.deepEqual(result.runs, [["A"], ["B"]]);
  assert.equal(result.providerCalls, 1, "reaction thanh cong khong duoc lap lai");
  assert.equal(result.oldTextReplies, 0);
  assert.deepEqual(result.firstState, {
    handled: true,
    accepted: true,
    reserved: false,
    stale: false,
    staleDeferred: false,
  });
}

function testR5ReactionUsesThreePhaseOnly() {
  const source = extract(
    "async function thuThaCamXuc(",
    "\n/* --- STICKER --- */"
  );
  assert.doesNotMatch(source, /chapNhanOutbound\s*\(/);
  assert.match(source, /conversationGeneration && !conversationGeneration\.giuChoOutbound\(\)/);
  assert.match(source, /await reactToMessage\(/);
  assert.match(source, /conversationGeneration\?\.xacNhanOutbound\(\)/);
  assert.match(source, /catch \(error\) \{[\s\S]*conversationGeneration\?\.traLaiOutbound\(\)/);
  assert.ok(source.indexOf("giuChoOutbound()") < source.indexOf("await reactToMessage("));
  assert.ok(source.indexOf("await reactToMessage(") < source.indexOf("xacNhanOutbound()"));
}

function compileProviderReaction({
  addReaction,
  chotQuyenRuntime = () => {},
  chotApiSan = () => ({ addReaction }),
}) {
  const source = extract(
    "export async function reactToMessage(",
    "\n/** Danh muc sticker"
  ).replace("export async function", "async function");
  return compileNamed(source, "reactToMessage", {
    loiCoMa: (code, message) => Object.assign(new Error(message), { code }),
    chotThreadType: (value) => value,
    chotDanhTinh: (value) => value,
    chotApiSan,
    nemLoiProvider: (error) => { throw error; },
    chotQuyenRuntime,
  });
}

async function testQ1PhysicalBoundaryNormalSuccess() {
  const generation = fakeGeneration();
  let providerCalls = 0;
  let postChecks = 0;
  let textFallbacks = 0;
  const providerReaction = compileProviderReaction({
    addReaction: async () => {
      providerCalls += 1;
      assert.equal(generation.state.reserved, true);
      assert.equal(generation.state.accepted, false);
      return { ok: true };
    },
    chotQuyenRuntime: () => {
      postChecks += 1;
      assert.equal(generation.state.accepted, true, "phai confirm truoc post-check");
      assert.equal(generation.state.reserved, false);
      assert.equal(generation.state.confirms, 1);
    },
  });
  const reaction = compileReaction(providerReaction);

  const handled = await reaction(reactionMessage(), null, { conversationGeneration: generation });
  if (!handled) textFallbacks += 1;
  assert.equal(handled, true);
  assert.equal(providerCalls, 1);
  assert.equal(postChecks, 1);
  assert.equal(generation.state.confirms, 1);
  assert.equal(generation.state.releases, 0);
  assert.equal(textFallbacks, 0);
}

async function testQ2PhysicalProviderFailure() {
  const generation = fakeGeneration();
  let providerCalls = 0;
  const providerReaction = compileProviderReaction({
    addReaction: async () => {
      providerCalls += 1;
      throw new Error("provider rejected");
    },
  });
  const reaction = compileReaction(providerReaction);

  assert.equal(await reaction(reactionMessage(), null, { conversationGeneration: generation }), false);
  assert.equal(providerCalls, 1);
  assert.equal(generation.state.confirms, 0);
  assert.equal(generation.state.releases, 1);
  assert.equal(generation.state.accepted, false);
  assert.equal(generation.state.reserved, false);
}

async function testQ3PreProviderRuntimeFailure() {
  const generation = fakeGeneration();
  let providerCalls = 0;
  const providerReaction = compileProviderReaction({
    addReaction: async () => { providerCalls += 1; },
    chotApiSan: () => { throw new Error("runtime invalid before provider"); },
  });
  const reaction = compileReaction(providerReaction);

  assert.equal(await reaction(reactionMessage(), null, { conversationGeneration: generation }), false);
  assert.equal(providerCalls, 0);
  assert.equal(generation.state.confirms, 0);
  assert.equal(generation.state.releases, 1);
  assert.equal(generation.state.accepted, false);
  assert.equal(generation.state.reserved, false);
}

async function testQ4SuccessThenPostRuntimeThrow() {
  const generation = fakeGeneration();
  let providerCalls = 0;
  let postChecks = 0;
  let textFallbacks = 0;
  const providerReaction = compileProviderReaction({
    addReaction: async () => {
      providerCalls += 1;
      assert.equal(generation.state.accepted, false);
      return { ok: true };
    },
    chotQuyenRuntime: () => {
      postChecks += 1;
      assert.equal(generation.state.accepted, true);
      throw Object.assign(new Error("runtime changed after provider"), { code: "ZALO_RUNTIME_CHANGED" });
    },
  });
  const reaction = compileReaction(providerReaction);

  const handled = await reaction(reactionMessage(), null, { conversationGeneration: generation });
  if (!handled) textFallbacks += 1;
  assert.equal(handled, true);
  assert.equal(providerCalls, 1);
  assert.equal(postChecks, 1);
  assert.equal(generation.state.confirms, 1);
  assert.equal(generation.state.releases, 0);
  assert.equal(generation.state.accepted, true);
  assert.equal(generation.state.reserved, false);
  assert.equal(textFallbacks, 0);
}

async function testQ5NewInboundSuccessThenPostRuntimeThrow() {
  const runs = [];
  let coordinator;
  let activeGeneration;
  let pendingB;
  let providerCalls = 0;
  let oldTextFallbacks = 0;
  let firstState;
  const providerReaction = compileProviderReaction({
    addReaction: async () => {
      providerCalls += 1;
      assert.equal(activeGeneration.accepted, false);
      assert.equal(activeGeneration.outboundReserved, true);
      pendingB = coordinator.them({ ownerUid: "O", threadId: "T", tins: [msg("B")] });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(activeGeneration.staleDeferred, true);
      return { ok: true };
    },
    chotQuyenRuntime: () => {
      assert.equal(activeGeneration.accepted, true);
      assert.equal(activeGeneration.outboundReserved, false);
      assert.equal(activeGeneration.staleDeferred, false);
      throw Object.assign(new Error("runtime changed after provider"), { code: "ZALO_RUNTIME_CHANGED" });
    },
  });
  const reaction = compileReaction(providerReaction);

  coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      const ids = work.tins.map((item) => item.id);
      runs.push(ids);
      if (runs.length !== 1) {
        generation.chapNhanOutbound();
        return;
      }
      activeGeneration = generation;
      const handled = await reaction(reactionMessage(), null, { conversationGeneration: generation });
      firstState = {
        handled,
        accepted: generation.accepted,
        reserved: generation.outboundReserved,
        stale: generation.stale,
        staleDeferred: generation.staleDeferred,
      };
      if (!handled) oldTextFallbacks += 1;
    },
  });

  await coordinator.them({ ownerUid: "O", threadId: "T", tins: [msg("A")] });
  if (pendingB) await pendingB;
  assert.deepEqual(runs, [["A"], ["B"]]);
  assert.equal(providerCalls, 1);
  assert.equal(oldTextFallbacks, 0);
  assert.deepEqual(firstState, {
    handled: true,
    accepted: true,
    reserved: false,
    stale: false,
    staleDeferred: false,
  });
}

async function testQ6PhysicalSuccessSignalOrdering() {
  const providerSource = extract(
    "export async function reactToMessage(",
    "\n/** Danh muc sticker"
  );
  const providerCall = providerSource.indexOf("ketQua = await ownerApi.addReaction(");
  const successSignal = providerSource.indexOf("internalOptions?.onProviderSuccess?.(");
  const postCheck = providerSource.indexOf("chotQuyenRuntime(capturedAuthority)");
  assert.ok(providerCall >= 0 && providerCall < successSignal);
  assert.ok(successSignal < postCheck);
  assert.doesNotMatch(providerSource.slice(providerCall, successSignal), /await(?! ownerApi\.addReaction)/);

  const callerSource = extract(
    "async function thuThaCamXuc(",
    "\n/* --- STICKER --- */"
  );
  assert.equal((callerSource.match(/xacNhanOutbound\(\)/g) || []).length, 1);
  assert.ok(callerSource.indexOf("xacNhanOutbound()") < callerSource.indexOf("reactionProviderCommitted = true"));
  assert.match(callerSource, /if \(reactionProviderCommitted\) \{[\s\S]*return true;/);

  let legacyProviderCalls = 0;
  let legacyPostChecks = 0;
  const legacyReaction = compileProviderReaction({
    addReaction: async () => { legacyProviderCalls += 1; return "LEGACY_OK"; },
    chotQuyenRuntime: () => { legacyPostChecks += 1; },
  });
  assert.equal(await legacyReaction({
    icon: "HEART",
    identity: { msgId: "M", cliMsgId: "C" },
    threadId: "T",
    threadType: 0,
  }), "LEGACY_OK");
  assert.equal(legacyProviderCalls, 1);
  assert.equal(legacyPostChecks, 1);
}

async function testOrderAndCrossConversation() {
  const starts = [];
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const coordinator = taoDieuPhoiHoiThoai({
    chay: async (work, generation) => {
      starts.push(`${work.threadId}:${work.tins.map((item) => item.id).join("+")}`);
      if (work.threadId === "A" && work.tins[0].id === "1") await gateA;
      generation.chapNhanOutbound();
    },
  });
  const a1 = coordinator.them({ ownerUid: "O", threadId: "A", tins: [msg("1", "A")] });
  const a2 = coordinator.them({ ownerUid: "O", threadId: "A", tins: [msg("2", "A")] });
  const b1 = coordinator.them({ ownerUid: "O", threadId: "B", tins: [msg("1", "B")] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(starts.includes("B:1"), "cross-conversation phai tiep tuc khi A dang cho");
  releaseA();
  await Promise.all([a1, a2, b1]);
  assert.ok(starts.indexOf("A:1") < starts.findIndex((value) => value.startsWith("A:1+2") || value === "A:2"));
}

async function testNotificationRecursionGuard() {
  const source = extract(
    "async function thongBaoAdminLoiOutbound(",
    "\n/**\n * Han gio cho lenh dang nhap"
  );
  const outboundFailureNotifications = new Set();
  let calls = 0;
  let helper;
  const sendAdminNotification = async () => {
    calls += 1;
    return helper({ ownerUid: "O", threadId: "T", failedBubbleIndex: 1, outcome: "SEND_UNKNOWN" });
  };
  helper = compileNamed(source, "thongBaoAdminLoiOutbound", {
    outboundFailureNotifications,
    sendAdminNotification,
    sendChatMessage: async () => null,
    taoOriginRuntime: () => ({}),
  });
  const result = await helper({ ownerUid: "O", threadId: "T", failedBubbleIndex: 1, outcome: "SEND_UNKNOWN" });
  assert.equal(calls, 1);
  assert.equal(result.reason, "RECURSION_GUARD");
  assert.equal(outboundFailureNotifications.size, 0);
}

const tests = [
  ["PROVIDER_BOUNDARY_ALL_BRANCHES", testProviderBoundary],
  ["FAILURE_CLASSIFICATION_RELEASE_UNKNOWN", testFailureClassificationAndRelease],
  ["BUBBLE_RETRY_RESUME_NULL_UNKNOWN", testBubbleRetry],
  ["DEFERRED_STALE_SUCCESS_REJECT_UNKNOWN", testDeferredStale],
  ["DEFERRED_STALE_BUBBLE_INTEGRATION", testDeferredStaleThroughBubbleLoop],
  ["P1_A_PARTIAL_INBOUND_DURING_LATER_REJECT", testP1APartialInboundDuringLaterReject],
  ["P1_B_INBOUND_BETWEEN_BUBBLES", testP1BInboundBetweenBubbles],
  ["P1_C_FLAG_PERSISTS_ACROSS_LATER_SUCCESS", testP1CFlagPersistsAcrossLaterSuccess],
  ["P1_D_UNCHANGED_CONTEXT_STILL_RETRIES", testP1DUnchangedContextStillRetries],
  ["P1_E_PARTIAL_CONTEXT_ADVANCED_SEND_UNKNOWN", testP1EPartialContextAdvancedSendUnknown],
  ["P1_F_RETRY_GUARD_RECHECKS_AFTER_AWAIT", testP1FRetryGuardRechecksAfterAwait],
  ["R1_REACTION_SUCCESS", testR1ReactionSuccess],
  ["R2_REACTION_FAILURE_NO_INBOUND", testR2ReactionFailureNoInbound],
  ["R3_REACTION_FAILURE_WITH_NEW_INBOUND", testR3ReactionFailureWithNewInbound],
  ["R4_REACTION_SUCCESS_WITH_NEW_INBOUND", testR4ReactionSuccessWithNewInbound],
  ["R5_REACTION_THREE_PHASE_SOURCE_GUARD", testR5ReactionUsesThreePhaseOnly],
  ["Q1_PHYSICAL_BOUNDARY_NORMAL_SUCCESS", testQ1PhysicalBoundaryNormalSuccess],
  ["Q2_PHYSICAL_PROVIDER_FAILURE", testQ2PhysicalProviderFailure],
  ["Q3_PRE_PROVIDER_RUNTIME_FAILURE", testQ3PreProviderRuntimeFailure],
  ["Q4_SUCCESS_THEN_POST_RUNTIME_THROW", testQ4SuccessThenPostRuntimeThrow],
  ["Q5_NEW_INBOUND_SUCCESS_THEN_POST_RUNTIME_THROW", testQ5NewInboundSuccessThenPostRuntimeThrow],
  ["Q6_PHYSICAL_SUCCESS_SIGNAL_ORDERING", testQ6PhysicalSuccessSignalOrdering],
  ["ORDER_AND_CROSS_CONVERSATION", testOrderAndCrossConversation],
  ["ADMIN_NOTIFICATION_RECURSION_GUARD", testNotificationRecursionGuard],
];

let failed = 0;
for (const [name, test] of tests) {
  try {
    await test();
    console.log(`${name} = PASS`);
  } catch (error) {
    failed += 1;
    console.error(`${name} = FAIL`, error);
  }
}
console.log(`OUTBOUND_NO_LOSS_P0 = ${tests.length - failed}/${tests.length} PASS`);
console.log("REAL_ZALO_CALL = 0");
console.log("REAL_LLM_CALL = 0");
console.log("PRODUCTION_DB_TOUCHED = NO");
if (failed) process.exitCode = 1;
