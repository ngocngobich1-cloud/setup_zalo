/**
 * STAB-06 Lane 2: deterministic owner-scoped runtime state isolation.
 * No live database, Zalo login, provider, network, or account switching.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taoBoGom, khoaGom } from "../lib/gom-tin.js";
import { resolveStickerUrl } from "../lib/sticker.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const zaloSource = fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8");
const threadMetaSource = fs.readFileSync(path.join(REPO, "lib", "thread-meta.js"), "utf8");
const customerSource = fs.readFileSync(path.join(REPO, "lib", "customer-memory.js"), "utf8");
let harnessSerial = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function withFakeNow(start, run) {
  const originalNow = Date.now;
  let now = start;
  Date.now = () => now;
  try {
    return await run({
      get: () => now,
      set: (value) => { now = value; },
      add: (value) => { now += value; },
    });
  } finally {
    Date.now = originalNow;
  }
}

async function createZaloHarness() {
  const control = { logs: [] };

  class FakeZalo {
    async login() { throw new Error("login khong duoc goi trong Lane 2"); }
    async loginQR() { throw new Error("login QR khong duoc goi trong Lane 2"); }
  }

  const deps = {
    Zalo: FakeZalo,
    LoginQRCallbackEventType: {},
    ThreadType: { User: 0, Group: 1 },
    AvatarSize: { Large: "large" },
    chonCamXuc: () => null,
    danhSachChoPhep: () => [],
    layBieuTuong: () => null,
    layMaTin: () => null,
    laTinHeThong: () => false,
    moTaSuKien: () => "su kien",
    botDuocGoi: () => true,
    taoBoGom,
    khoaGom,
    locRuotGan: (text) => ({ sach: String(text), daCat: false, soDongCat: 0 }),
    chonTinhHuong: () => "chao_hoi",
    layStickerHopLe: () => ({ id: 1, cateId: 2, type: 7, moTa: "fake" }),
    loadCredentials: async () => null,
    saveCredentials: async () => undefined,
    xoaCredentials: async () => undefined,
    getThread: async (ownerUid, threadId) => ({ ownerUid, id: threadId, threadType: 0 }),
    getThreadMessages: async () => [],
    insertMessage: async () => ({ changes: 1 }),
    listThreads: async () => [],
    rebuildThreadsFromMessages: async () => undefined,
    upsertThread: async (_ownerUid, thread) => thread,
    getAutoReplyRules: async () => [],
    normalizeIncomingMessage: (message) => message,
    normalizeTs: Number,
    splitIntoBubbles: (text) => [String(text)],
    taoNguonDinhKemZalo: () => null,
    listEnabledPdfAutomationRules: async () => [],
    getPdfAutomationRuleWithBlob: async () => null,
    clearAllPendingPdfConfirmations: () => 0,
    PDF_AUTOMATION_HANDLED: "HANDLED",
    createPdfAutomationHandler: () => async () => undefined,
    enrichExistingThread: async () => null,
    enrichMessagesForDisplay: async (_api, messages) => messages,
    resolveSenderAvatar: async () => null,
    resolveThreadMeta: async () => ({ title: null, avatar: null }),
    syncThreadCatalog: async () => undefined,
    attachOldMessagesListener: () => undefined,
    requestInitialHistorySync: () => undefined,
    resetHistorySyncState: () => undefined,
    syncHistoryForThread: async () => undefined,
    enrichMessageSticker: async (_api, message) => message,
    addLog: async (entry) => { control.logs.push(entry); },
    capHinhChuTaiKhoanLog: () => undefined,
    capHinhChuTaiKhoanAdmin: () => undefined,
    laLenhAdmin: async () => false,
    xuLyLenh: async () => null,
    aiChat: {
      capHinhChuTaiKhoan: () => undefined,
      refreshConfig: async () => undefined,
      getConfig: () => ({ botEnabled: false }),
      tryReply: async () => null,
    },
  };

  const importsEnd = zaloSource.indexOf("const USER_AGENT");
  assert.ok(importsEnd > 0, "Khong tim thay diem ket thuc imports zalo-service");
  const waitLine = "const doi = (ms) => new Promise((r) => setTimeout(r, ms));";
  assert.equal(zaloSource.includes(waitLine), true, "Khong tim thay seam doi sticker");
  const key = `__stab06_lane2_zalo_${process.pid}_${++harnessSerial}`;
  globalThis[key] = deps;
  const injected = `const { ${Object.keys(deps).join(", ")} } = globalThis[${JSON.stringify(key)}];\n`;
  const seams = `
export {
  layThanhVien as __layThanhVien,
  ghiNhanGoPhim as __ghiNhanGoPhim,
  conDangGo as __conDangGo,
  thuGuiSticker as __thuGuiSticker,
  taoOriginRuntime as __taoOriginRuntime,
  originConHieuLuc as __originConHieuLuc,
  voHieuHoaViecRuntimeCu as __voHieuHoaViecRuntimeCu
};
export function __setDirectRuntime(testApi, ownerUid) {
  api = testApi;
  appState.loggedIn = true;
  appState.uid = ownerUid == null ? null : String(ownerUid);
}
`;
  const transformed = (injected + zaloSource.slice(importsEnd) + seams)
    .replace(waitLine, "const doi = async () => undefined;");
  try {
    const service = await import(
      `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${harnessSerial}`
    );
    return { service, control };
  } finally {
    delete globalThis[key];
  }
}

function makeOwnerApi(ownerUid, members = []) {
  const calls = { groupInfo: 0, groupMembers: 0, findUser: 0, sticker: 0 };
  const byUid = Object.fromEntries(members.map((member) => [String(member.id), member]));
  return {
    calls,
    getOwnId: () => String(ownerUid),
    getGroupInfo: async (groupId) => {
      calls.groupInfo += 1;
      return { gridInfoMap: { [String(groupId)]: { currentMems: members.map((m) => String(m.id)) } } };
    },
    getGroupMembersInfo: async (uids) => {
      calls.groupMembers += 1;
      return { profiles: Object.fromEntries(uids.map((uid) => [uid, byUid[uid]])) };
    },
    findUser: async (phone) => {
      calls.findUser += 1;
      return { uid: `${ownerUid}-${phone}`, displayName: `Nguoi ${ownerUid}` };
    },
    sendSticker: async () => { calls.sticker += 1; },
  };
}

async function createThreadMetaHarness() {
  const control = {
    threads: new Map(),
    upserts: [],
  };
  const deps = {
    getThread: async (ownerUid, threadId) => ({ ownerUid, id: threadId, title: null, avatar: null }),
    listThreads: async (ownerUid) => control.threads.get(String(ownerUid)) || [],
    upsertThread: async (ownerUid, value) => {
      const row = { ownerUid: String(ownerUid), ...value };
      control.upserts.push(row);
      return row;
    },
    enrichMessageSticker: async (_api, message) => message,
  };
  const importsEnd = threadMetaSource.indexOf("const metaCache");
  assert.ok(importsEnd > 0, "Khong tim thay diem ket thuc imports thread-meta");
  const key = `__stab06_lane2_meta_${process.pid}_${++harnessSerial}`;
  globalThis[key] = deps;
  const injected = `const { ${Object.keys(deps).join(", ")} } = globalThis[${JSON.stringify(key)}];\n`;
  try {
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(injected + threadMetaSource.slice(importsEnd)).toString("base64")}#${harnessSerial}`
    );
    return { module, control };
  } finally {
    delete globalThis[key];
  }
}

function makeMetaApi({ aliases = [], title = "Provider", avatar = null }) {
  const calls = { aliases: 0, user: 0 };
  return {
    calls,
    getAliasList: async () => { calls.aliases += 1; return aliases; },
    getUserInfo: async (uid) => {
      calls.user += 1;
      return { [String(uid)]: { displayName: title, avatar } };
    },
  };
}

async function createCustomerHarness() {
  const control = {
    bumps: [],
    histories: [],
    saves: [],
    resets: [],
    runs: [],
    runOneShot: async () => ({ text: "Ho so", tokens: 1 }),
  };
  const deps = {
    ThreadType: { User: 0, Group: 1 },
    bumpCustomerTurns: async (...args) => { control.bumps.push(args); return 6; },
    getCustomerMemory: async () => null,
    getOwnerInstruction: async () => "",
    resetCustomerTurns: async (...args) => { control.resets.push(args); },
    saveCustomerMemory: async (...args) => { control.saves.push(args); },
    buildRecentHistory: async (ownerUid, threadId) => {
      control.histories.push([String(ownerUid), String(threadId)]);
      return "Lich su hop le";
    },
    opencode: {
      runOneShot: async (...args) => {
        control.runs.push(args);
        return control.runOneShot(...args);
      },
    },
    addLog: async () => undefined,
  };
  const importsEnd = customerSource.indexOf("/** Tran do dai ho so.");
  assert.ok(importsEnd > 0, "Khong tim thay diem ket thuc imports customer-memory");
  const key = `__stab06_lane2_customer_${process.pid}_${++harnessSerial}`;
  globalThis[key] = deps;
  const injected = `const { ${Object.keys(deps).join(", ")} } = globalThis[${JSON.stringify(key)}];\n`;
  try {
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(injected + customerSource.slice(importsEnd)).toString("base64")}#${harnessSerial}`
    );
    return { module, control };
  } finally {
    delete globalThis[key];
  }
}

const tests = [];
function test(code, description, run) {
  tests.push({ code, description, run });
}

test("T1", "group-member cache is reused for the same owner", async () => {
  const { service } = await createZaloHarness();
  const apiA = makeOwnerApi("A", [
    { id: "A", displayName: "Owner Alpha" },
    { id: "C", displayName: "Customer Charlie" },
  ]);
  service.__setDirectRuntime(apiA, "A");
  const first = await service.__layThanhVien("G", "A", apiA);
  const second = await service.__layThanhVien("G", "A", apiA);
  assert.deepEqual(first, second);
  assert.equal(apiA.calls.groupInfo, 1);
  assert.equal(apiA.calls.groupMembers, 1);
});

test("T2", "same group ID has independent member semantics for A and B", async () => {
  const { service } = await createZaloHarness();
  const members = [
    { id: "A", displayName: "Owner Alpha" },
    { id: "B", displayName: "Owner Beta" },
    { id: "C", displayName: "Customer Charlie" },
  ];
  const apiA = makeOwnerApi("A", members);
  const apiB = makeOwnerApi("B", members);
  const listA = await service.__layThanhVien("G", "A", apiA);
  const listB = await service.__layThanhVien("G", "B", apiB);
  assert.deepEqual(listA.map((x) => x.uid).sort(), ["B", "C"]);
  assert.deepEqual(listB.map((x) => x.uid).sort(), ["A", "C"]);
  assert.equal(apiA.calls.groupInfo, 1);
  assert.equal(apiB.calls.groupInfo, 1);
});

test("T3", "typing freshness remains 13 seconds for the same owner", async () => {
  const { service } = await createZaloHarness();
  await withFakeNow(1000, async (clock) => {
    service.__setDirectRuntime({}, "A");
    service.__ghiNhanGoPhim({ threadId: "X", data: { uid: "Y" } }, "A");
    clock.add(12999);
    assert.equal(service.__conDangGo("X", "Y", "A"), true);
    clock.add(1);
    assert.equal(service.__conDangGo("X", "Y", "A"), false);
  });
});

test("T4", "typing marker from A is invisible to B for the same IDs", async () => {
  const { service } = await createZaloHarness();
  service.__ghiNhanGoPhim({ threadId: "X", data: { uid: "Y" } }, "A");
  assert.equal(service.__conDangGo("X", "Y", "A"), true);
  assert.equal(service.__conDangGo("X", "Y", "B"), false);
});

test("T5", "thread alias cache is reused for the same owner", async () => {
  const { module, control } = await createThreadMetaHarness();
  control.threads.set("A", [{ id: "X", threadType: 0 }]);
  const apiA = makeMetaApi({ aliases: [{ uid: "X", alias: "Alpha" }], title: "Provider A" });
  await module.syncThreadCatalog(apiA, "A");
  const again = await module.resolveThreadMeta(apiA, "X", 0, { ownerUid: "A" });
  assert.equal(again.title, "Alpha");
  assert.equal(apiA.calls.user, 1);
});

test("T6", "same target UID has independent aliases for A and B", async () => {
  const { module, control } = await createThreadMetaHarness();
  control.threads.set("A", [{ id: "X", threadType: 0 }]);
  control.threads.set("B", [{ id: "X", threadType: 0 }]);
  const apiA = makeMetaApi({ aliases: [{ uid: "X", alias: "Alpha" }], title: "Provider A" });
  const apiB = makeMetaApi({ aliases: [{ uid: "X", alias: "Beta" }], title: "Provider B" });
  await module.syncThreadCatalog(apiA, "A");
  await module.syncThreadCatalog(apiB, "B");
  assert.equal((await module.resolveThreadMeta(apiA, "X", 0, { ownerUid: "A" })).title, "Alpha");
  assert.equal((await module.resolveThreadMeta(apiB, "X", 0, { ownerUid: "B" })).title, "Beta");
});

test("T7", "A owner-local title is never offered to B persistence", async () => {
  const { module, control } = await createThreadMetaHarness();
  control.threads.set("A", [{ id: "X", threadType: 0 }]);
  control.threads.set("B", [{ id: "X", threadType: 0 }]);
  await module.syncThreadCatalog(
    makeMetaApi({ aliases: [{ uid: "X", alias: "Alpha" }], title: "Provider A" }),
    "A"
  );
  await module.syncThreadCatalog(makeMetaApi({ aliases: [], title: "Provider Beta" }), "B");
  const bWrite = control.upserts.findLast((row) => row.ownerUid === "B" && row.id === "X");
  assert.equal(bWrite.title, "Provider Beta");
  assert.notEqual(bWrite.title, "Alpha");
});

test("T8", "sender-avatar cache remains globally reusable", async () => {
  const { module } = await createThreadMetaHarness();
  const apiA = makeMetaApi({ title: "Sender", avatar: "avatar-global" });
  const apiB = makeMetaApi({ title: "Sender B", avatar: "avatar-b" });
  const message = { senderId: "S", isSelf: false, senderAvatar: null };
  const thread = { threadType: 1, avatar: null };
  assert.equal(await module.resolveSenderAvatar(apiA, message, thread), "avatar-global");
  assert.equal(await module.resolveSenderAvatar(apiB, message, thread), "avatar-global");
  assert.equal(apiA.calls.user, 1);
  assert.equal(apiB.calls.user, 0);
});

test("T9", "phone quota preserves 20 lookups and the one-hour window", async () => {
  const { service } = await createZaloHarness();
  const apiA = makeOwnerApi("A");
  service.__setDirectRuntime(apiA, "A");
  await withFakeNow(1000, async (clock) => {
    for (let i = 0; i < 20; i += 1) await service.timNguoiTheoSo("0901234567");
    assert.equal(service.conLuotTraSo("A"), 0);
    await assert.rejects(() => service.timNguoiTheoSo("0901234567"), /Đã tra 20 số trong 1 giờ/);
    clock.add(60 * 60 * 1000);
    assert.equal(service.conLuotTraSo("A"), 0);
    clock.add(1);
    assert.equal(service.conLuotTraSo("A"), 20);
  });
  assert.equal(apiA.calls.findUser, 20);
});

test("T10", "A phone-quota exhaustion does not consume B allowance", async () => {
  const { service } = await createZaloHarness();
  const apiA = makeOwnerApi("A");
  const apiB = makeOwnerApi("B");
  service.__setDirectRuntime(apiA, "A");
  for (let i = 0; i < 20; i += 1) await service.timNguoiTheoSo("0901234567");
  assert.equal(service.conLuotTraSo("A"), 0);
  service.__setDirectRuntime(apiB, "B");
  assert.equal(service.conLuotTraSo("B"), 20);
  await service.timNguoiTheoSo("0901234567");
  assert.equal(service.conLuotTraSo("B"), 19);
  assert.equal(apiB.calls.findUser, 1);
});

test("T11", "global IP limiter and email mailbox state remain globally keyed", async () => {
  const rateSource = fs.readFileSync(path.join(REPO, "lib", "rate-limit.js"), "utf8");
  const emailSource = fs.readFileSync(path.join(REPO, "lib", "email-check.js"), "utf8");
  assert.match(rateSource, /const soLieu = new Map\(\);/);
  assert.match(rateSource, /soLieu\.get\(key\)/);
  assert.match(emailSource, /const lichSuTra = new Map\(\); \/\/ nguoiHoi/);
  assert.match(emailSource, /const nhoTam = new Map\(\);/);
  assert.match(emailSource, /nhoTam\.get\(email\)/);
});

test("T12", "sticker cooldown preserves the same-owner 30-minute boundary", async () => {
  const { service } = await createZaloHarness();
  const apiA = makeOwnerApi("A");
  service.__setDirectRuntime(apiA, "A");
  const message = { threadId: "X", threadType: 0, content: "hello" };
  await withFakeNow(10 * 60 * 60 * 1000, async (clock) => {
    await service.__thuGuiSticker(message);
    clock.add(30 * 60 * 1000 - 1);
    await service.__thuGuiSticker(message);
    assert.equal(apiA.calls.sticker, 1);
    clock.add(1);
    await service.__thuGuiSticker(message);
    assert.equal(apiA.calls.sticker, 2);
  });
});

test("T13", "A sticker cooldown does not suppress B on the same thread", async () => {
  const { service } = await createZaloHarness();
  const apiA = makeOwnerApi("A");
  const apiB = makeOwnerApi("B");
  const message = { threadId: "X", threadType: 0, content: "hello" };
  service.__setDirectRuntime(apiA, "A");
  await service.__thuGuiSticker(message);
  service.__setDirectRuntime(apiB, "B");
  await service.__thuGuiSticker(message);
  assert.equal(apiA.calls.sticker, 1);
  assert.equal(apiB.calls.sticker, 1);
});

test("T14", "sticker asset URL cache remains global", async () => {
  const stickerId = 900000 + process.pid;
  let callsA = 0;
  let callsB = 0;
  const apiA = { getStickersDetail: async () => { callsA += 1; return { stickerWebpUrl: "asset-global" }; } };
  const apiB = { getStickersDetail: async () => { callsB += 1; return { stickerWebpUrl: "asset-b" }; } };
  assert.equal(await resolveStickerUrl(apiA, stickerId), "asset-global");
  assert.equal(await resolveStickerUrl(apiB, stickerId), "asset-global");
  assert.equal(callsA, 1);
  assert.equal(callsB, 0);
});

test("T15", "same-owner overlapping consolidation keeps one active lock", async () => {
  const { module, control } = await createCustomerHarness();
  const pause = deferred();
  control.runOneShot = async () => pause.promise;
  const message = { senderId: "X", senderName: "Khach", threadId: "T", isSelf: false };
  const first = module.ducKetNeuDenLuot({}, message, "A");
  while (control.runs.length < 1) await settle();
  const second = await module.ducKetNeuDenLuot({}, message, "A");
  assert.equal(second, null);
  assert.equal(control.runs.length, 1);
  pause.resolve({ text: "Ho so A", tokens: 1 });
  assert.equal(await first, "Ho so A");
  assert.equal(control.saves.length, 1);
});

test("T16", "A consolidation lock does not block B for the same customer UID", async () => {
  const { module, control } = await createCustomerHarness();
  const pauseA = deferred();
  control.runOneShot = async () => control.runs.length === 1
    ? pauseA.promise
    : { text: "Ho so B", tokens: 1 };
  const message = { senderId: "X", senderName: "Khach", threadId: "T", isSelf: false };
  const firstA = module.ducKetNeuDenLuot({}, message, "A");
  while (control.runs.length < 1) await settle();
  assert.equal(await module.ducKetNeuDenLuot({}, message, "B"), "Ho so B");
  assert.equal(control.runs.length, 2);
  pauseA.resolve({ text: "Ho so A", tokens: 1 });
  assert.equal(await firstA, "Ho so A");
  assert.deepEqual(control.saves.map(([ownerUid]) => ownerUid).sort(), ["A", "B"]);
});

test("T17", "B to A returns A's representative owner cache", async () => {
  const { service } = await createZaloHarness();
  const members = [
    { id: "A", displayName: "Owner Alpha" },
    { id: "B", displayName: "Owner Beta" },
    { id: "C", displayName: "Customer Charlie" },
  ];
  const apiA = makeOwnerApi("A", members);
  const apiB = makeOwnerApi("B", members);
  const firstA = await service.__layThanhVien("G", "A", apiA);
  await service.__layThanhVien("G", "B", apiB);
  const callsBefore = apiA.calls.groupInfo;
  const backToA = await service.__layThanhVien("G", "A", apiA);
  assert.deepEqual(backToA, firstA);
  assert.deepEqual(backToA.map((x) => x.uid).sort(), ["B", "C"]);
  assert.equal(apiA.calls.groupInfo, callsBefore);
});

test("T18", "Lane 1 generation guard still rejects stale A1 under A2", async () => {
  const { service } = await createZaloHarness();
  const apiA1 = makeOwnerApi("A");
  const apiA2 = makeOwnerApi("A");
  service.__setDirectRuntime(apiA1, "A");
  const originA1 = service.__taoOriginRuntime();
  service.__voHieuHoaViecRuntimeCu();
  service.__setDirectRuntime(apiA2, "A");
  assert.equal(service.__originConHieuLuc(originA1), false);
});

let passed = 0;
let failed = 0;
for (const { code, description, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${code} - ${description}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${code} - ${description}`);
    console.error(error?.stack || error);
  }
}

console.log(`\nSTAB06_L2_RESULT: ${passed}/${tests.length} PASS, ${failed} FAIL`);
if (failed) process.exitCode = 1;
