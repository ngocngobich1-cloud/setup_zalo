import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";
const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const htmlSource = fs.readFileSync(path.join(REPO, "public/index.html"), "utf8");
const appSource = fs.readFileSync(path.join(REPO, "public/app.js"), "utf8");
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`PASS ${name}`); }
  catch (error) { results.push(false); console.error(`FAIL ${name}`, error.stack); }
}
// Only expose internal state in the test process. The complete production module runs.
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url.includes("/public/app.js?history-focused")) return { ...loaded,
    source: loaded.source + "\nexport { state, selectThread, applyState, fetchThreadHistory, getThreadHistoryState };" };
  return loaded;
}});
function jsonResponse(data, status = 200, { clone = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => clone ? structuredClone(data) : data,
  };
}

function deferredResponse() {
  let release;
  const promise = new Promise((resolve) => { release = (data, status = 200) => resolve(jsonResponse(data, status)); });
  return { promise, release };
}

async function flush(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const dom = new JSDOM(htmlSource, { url: "http://zalo-web.test/", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
Object.defineProperty(window, "innerWidth", { configurable: true, value: 393 });
window.matchMedia = (query) => ({
  matches: query === "(max-width: 760px)",
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.setPointerCapture = () => {};
window.requestAnimationFrame = (callback) => { callback(); return 1; };
window.cancelAnimationFrame = () => {};
window.confirm = () => true;
window.alert = () => {};

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
globalThis.io = () => ({ on(event, handler) {
  // Socket.IO invokes every listener registered for an event, in registration order.
  const previous = socketHandlers.get(event);
  socketHandlers.set(event, (...args) => { previous?.(...args); handler(...args); });
} });
window.io = globalThis.io;

const queues = new Map();
const fetchCalls = [];
function routeKey(url, method = "GET") { return `${String(method).toUpperCase()} ${String(url)}`; }
function enqueue(url, response, method = "GET") {
  const key = routeKey(url, method);
  const queue = queues.get(key) || [];
  queue.push(response);
  queues.set(key, queue);
}
function defaultPayload(url, method) {
  if (url === "/api/bootstrap") return {
    loggedIn: true, uid: "UI-A", displayName: "Tài khoản thử", threads: [], qr: {},
    ketNoi: { trangThai: "song", lyDo: "" }, user: { username: "fixture" }, admins: [],
  };
  if (url === "/api/onboarding") return { step: 0, started: false, completed: true, data: {} };
  if (url === "/api/bot/status") return { enabled: false, ready: true };
  if (url === "/api/auto-reply") return [];
  if (url === "/api/lich-hen") return { lich: [] };
  if (url === "/api/customer-memory") return { customers: [] };
  if (url.startsWith("/api/logs")) return { logs: [] };
  if (url === "/api/knowledge") return { files: [] };
  if (url === "/api/zalo/groups") return { groups: [] };
  if (url === "/api/ai-chat/providers") return { providers: [] };
  if (url === "/api/ai-chat/opencode-test") return { agents: [], providers: [], systemDefaultModel: "" };
  if (url === "/api/ai-chat") return { config: {}, ready: false };
  if (url === "/api/auth/me") return { user: { username: "fixture" } };
  if (url === "/api/auth/otp-settings") return { enabled: false, email: "", adminZaloUid: "", smtpConfigured: false };
  if (url === "/api/training") return { model: "", messages: [], files: [], sessionId: null };
  if (url.startsWith("/api/messages/")) return { messages: [] };
  if (["POST", "PUT", "DELETE"].includes(method)) return { ok: true };
  return {};
}
async function fetchFixture(input, options = {}) {
  const url = String(input);
  const method = String(options.method || "GET").toUpperCase();
  fetchCalls.push({ url, method });
  const queue = queues.get(routeKey(url, method));
  if (queue?.length) return await queue.shift();
  return jsonResponse(defaultPayload(url, method));
}
globalThis.fetch = fetchFixture;
window.fetch = fetchFixture;

const app = await import(`${pathToFileURL(path.join(REPO, "public", "app.js")).href}?history-focused`);
await flush(14);


let now = 0, timerId = 0, serial = 0;
const timers = new Map();
window.setTimeout = (fn, ms = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + Number(ms) }); return id; };
window.clearTimeout = (id) => timers.delete(id);
async function advance(ms) {
  now += ms;
  for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  await flush();
}
function reset() {
  app.applyState({ loggedIn: true, uid: `owner-${++serial}` });
  timers.clear(); queues.clear(); fetchCalls.length = 0;
}
const thread = (id = `thread-${serial}`) => ({ id, title: id, threadType: 1 });
const message = (id, ts = 1800000000000, content = `text-${id}`) => ({ id, ts, content, senderId: 'sender', msgType: 'text', isSelf: false });
const urlFor = (t) => `/api/messages/${t.id}`;
const calls = (t) => fetchCalls.filter((c) => c.url === urlFor(t)).length;
const hs = (t) => app.getThreadHistoryState(t.id);
const messages = (t) => app.state.messagesByThread.get(t.id) || [];
const text = () => document.querySelector('#messages').textContent;
const emit = (t, reason, extra = {}) => socketHandlers.get('thread-history-updated')({ ownerUid: app.state.uid, threadId: t.id, reason, ...extra });
const live = (t, m) => socketHandlers.get('new-message')({ ...m, threadId: t.id });
const respond = (t, payload, status = 200) => enqueue(urlFor(t), jsonResponse({ messages: [], ...payload }, status));
async function loaded(t, payload = {}) { respond(t, payload); await app.selectThread(t); }
const reconnect = async () => { socketHandlers.get('disconnect')(); socketHandlers.get('connect')(); await flush(); };
await test('F1 partial cache is not loaded', async () => { reset(); const t=thread(); live(t,message(1)); assert.equal(hs(t).status,'not_loaded'); });
await test('F2 partial renders immediately and fetches', async () => { reset(); const t=thread(); live(t,message(1)); const d=deferredResponse(); enqueue(urlFor(t),d.promise); const p=app.selectThread(t); assert.match(text(),/text-1/); assert.equal(calls(t),1); d.release({messages:[message(2)]}); await p; assert.equal(messages(t).length,2); });
await test('F3 realtime during fetch survives', async () => { reset(); const t=thread(), d=deferredResponse(); enqueue(urlFor(t),d.promise); const p=app.selectThread(t); live(t,message(2)); d.release({messages:[message(1)]}); await p; assert.deepEqual(messages(t).map(m=>m.id),[1,2]); });
await test('F4 cross-thread render race', async () => { reset(); const a=thread('a'), b=thread('b'), d=deferredResponse(); enqueue(urlFor(a),d.promise); const p=app.selectThread(a); await loaded(b,{messages:[message('B')]}); d.release({messages:[message('A')]}); await p; assert.match(text(),/text-B/); assert.doesNotMatch(text(),/text-A/); });
await test('F5 one request per thread in flight', async () => { reset(); const t=thread(),d=deferredResponse(); enqueue(urlFor(t),d.promise); const a=app.selectThread(t),b=app.selectThread(t); assert.equal(calls(t),1); d.release({messages:[]}); await Promise.all([a,b]); assert.equal(hs(t).inflight,null); });
await test('F6 HTTP error preserves good cache', async () => { reset(); const t=thread(); live(t,message(1)); respond(t,{},500); await app.selectThread(t); assert.equal(hs(t).status,'error'); assert.equal(hs(t).inflight,null); assert.equal(messages(t).length,1); assert.match(text(),/text-1/); });
await test('F7 HTTP retry button recovers', async () => { reset(); const t=thread(); respond(t,{},500); await app.selectThread(t); respond(t,{messages:[message(2)]}); document.querySelector('.history-notice button').click(); await flush(); assert.equal(hs(t).status,'loaded'); assert.match(text(),/text-2/); });
await test('F8 network rejection settles and retry recovers', async () => { reset(); const t=thread(); let unhandled=0; const handler=()=>unhandled++; process.on('unhandledRejection',handler); enqueue(urlFor(t),Promise.reject(new Error('network fixture'))); await app.selectThread(t); assert.equal(hs(t).status,'error'); assert.equal(hs(t).inflight,null); respond(t,{messages:[message(1)]}); document.querySelector('.history-notice button').click(); await flush(); assert.equal(hs(t).status,'loaded'); assert.equal(unhandled,0); process.off('unhandledRejection',handler); });
await test('F9 canonical string id dedupe and incoming wins', async () => { reset(); const t=thread(); live(t,message(7)); await loaded(t,{messages:[message('7',1800000000000,'updated')]}); assert.equal(messages(t).length,1); assert.equal(document.querySelectorAll('.bubble').length,1); assert.match(text(),/updated/); live(t,message(7,1800000000000,'newer')); assert.equal(messages(t).length,1); assert.match(text(),/newer/); });
await test('F10 chronological sort with deterministic id tie break', async () => { reset(); const t=thread(); live(t,message('b',1800000000002)); await loaded(t,{messages:[message('z',1800000000001),message('a',1800000000002)]}); assert.deepEqual(messages(t).map(m=>m.id),['z','a','b']); });
await test('F11 loaded reopen renders synchronously without fetch', async () => { reset(); const t=thread(); await loaded(t,{messages:[message(1)]}); await loaded(thread('other')); const n=calls(t); const p=app.selectThread(t); assert.match(text(),/text-1/); assert.doesNotMatch(text(),/Đang tải/); assert.equal(calls(t),n); await p; });
await test('F12 wrong owner ignored', async () => { reset(); const t=thread(); await loaded(t); emit(t,'sync_complete',{ownerUid:'wrong'}); await advance(300); assert.equal(calls(t),1); });
await test('F13 scheduled means pending', async () => { reset(); const t=thread(); await loaded(t,{syncScheduled:true}); assert.equal(hs(t).syncPending,true); });
await test('F14 empty pending displays sync banner', async () => { reset(); const t=thread(); await loaded(t,{syncScheduled:true}); assert.match(text(),/Đang đồng bộ lịch sử từ Zalo…/); assert.doesNotMatch(text(),/Chưa có tin/); });
await test('F15 terminal debounce merges and clears pending', async () => { reset(); const t=thread(); await loaded(t,{messages:[message(1)],syncScheduled:true}); respond(t,{messages:[message(2)],syncScheduled:false,syncInFlight:false,syncRetryAfterMs:0}); emit(t,'sync_complete'); emit(t,'sync_complete'); await advance(299); assert.equal(calls(t),1); await advance(1); assert.equal(calls(t),2); assert.equal(messages(t).length,2); assert.equal(hs(t).syncPending,false); });
await test('F16 zero-row completion clears banner', async () => { reset(); const t=thread(); await loaded(t,{syncScheduled:true}); respond(t,{}); emit(t,'sync_complete',{changedCount:0}); await advance(300); assert.equal(calls(t),2); assert.equal(hs(t).syncPending,false); assert.doesNotMatch(text(),/Đang đồng bộ/); assert.match(text(),/Chưa có tin/); });
await test('F17 failed sync retains messages and one exact retry timer', async () => { reset(); const t=thread(); await loaded(t,{messages:[message(1)],syncScheduled:true}); emit(t,'sync_failed',{retryAfterMs:30000}); emit(t,'sync_failed',{retryAfterMs:30000}); assert.equal(timers.size,1); assert.equal(hs(t).syncPending,true); assert.equal(messages(t).length,1); await advance(29999); assert.equal(calls(t),1); });
await test('F18 automatic retry starts new attempt', async () => { reset(); const t=thread(); await loaded(t,{syncScheduled:true}); emit(t,'sync_failed',{retryAfterMs:30000}); respond(t,{syncScheduled:true,syncInFlight:true}); await advance(30000); assert.equal(calls(t),2); assert.equal(hs(t).syncPending,true); assert.equal(hs(t).syncRetryTimer,null); });
await test('F19 events while loading latch exactly one follow-up', async () => {
  for (const reason of ['sync_complete', 'enrichment_updated', 'sync_failed']) {
    reset();
    const t = thread(), d = deferredResponse();
    enqueue(urlFor(t), d.promise);
    const p = app.selectThread(t);
    respond(t, { messages: [message(2)], syncRetryAfterMs: reason === 'sync_failed' ? 30000 : 0 });
    emit(t, reason, { retryAfterMs: 30000 });
    emit(t, reason, { retryAfterMs: 30000 });
    assert.equal(hs(t).refreshRequested, true);
    d.release({ messages: [message(1)], syncScheduled: true });
    await p;
    await flush();
    assert.equal(calls(t), 2);
    assert.equal(messages(t).length, 2);
    assert.equal(hs(t).refreshRequested, false);
    assert.equal(hs(t).syncPending, reason === 'sync_failed');
    if (reason === 'sync_failed') {
      assert.equal(timers.size, 1);
      await advance(29999);
    } else await advance(60000);
    assert.equal(calls(t), 2);
  }
});
await test('F20 reconnect recovers lost terminal event, including during initial load', async () => {
  reset();
  const t = thread();
  await loaded(t, { syncScheduled: true });
  respond(t, { messages: [message(1)] });
  await reconnect();
  assert.equal(calls(t), 2);
  assert.equal(messages(t).length, 1);
  assert.equal(hs(t).syncPending, false);

  reset();
  const pendingThread = thread(), d = deferredResponse();
  enqueue(urlFor(pendingThread), d.promise);
  const p = app.selectThread(pendingThread);
  respond(pendingThread, { messages: [message('recovered')] });
  await reconnect();
  assert.equal(calls(pendingThread), 1);
  assert.equal(hs(pendingThread).refreshRequested, true);
  d.release({ messages: [], syncScheduled: true });
  await p;
  await flush();
  assert.equal(calls(pendingThread), 2);
  assert.equal(hs(pendingThread).syncPending, false);
  assert.match(text(), /text-recovered/);
});
await test('F21 reconnect during inflight stays pending', async () => { reset(); const t=thread(); await loaded(t,{syncScheduled:true}); respond(t,{syncInFlight:true}); await reconnect(); assert.equal(hs(t).syncPending,true); assert.doesNotMatch(text(),/Chưa có tin/); });
await test('F22 reconnect during backoff schedules one remaining timer', async () => { reset(); const t=thread(); await loaded(t,{syncScheduled:true}); respond(t,{syncRetryAfterMs:12500}); await reconnect(); assert.equal(hs(t).syncPending,true); assert.equal(timers.size,1); await advance(12499); assert.equal(calls(t),2); respond(t,{syncScheduled:true}); await advance(1); assert.equal(calls(t),3); });
await test('F23 reconnect after completion clears pending', async () => { reset(); const t=thread(); await loaded(t,{syncScheduled:true}); respond(t,{syncScheduled:false,syncInFlight:false,syncRetryAfterMs:0,messages:[message(1)]}); await reconnect(); assert.equal(hs(t).syncPending,false); assert.match(text(),/text-1/); });
await test('F24 reconnect never fetches not_loaded', async () => { reset(); const t=thread(); live(t,message(1)); hs(t); await reconnect(); assert.equal(calls(t),0); assert.equal(hs(t).status,'not_loaded'); });
await test('F25 reconnect retries history error', async () => { reset(); const t=thread(); respond(t,{},500); await app.selectThread(t); respond(t,{messages:[message(1)]}); await reconnect(); assert.equal(hs(t).status,'loaded'); assert.equal(calls(t),2); });
await test('F26 enrichment refresh preserves backend pending state', async () => { for (const data of [{syncInFlight:true},{syncRetryAfterMs:15000}]) { reset(); const t=thread(); await loaded(t,{syncScheduled:true}); respond(t,data); emit(t,'enrichment_updated'); await advance(300); assert.equal(hs(t).syncPending,true); assert.doesNotMatch(text(),/Chưa có tin/); } });
await test('F27 convergence, owner invalidation and uncapped union', async () => { reset(); const t=thread(); await loaded(t,{messages:Array.from({length:500},(_,i)=>message(i)),syncScheduled:true}); live(t,message(500)); respond(t,{}); emit(t,'sync_complete'); await advance(300); await advance(600000); assert.equal(calls(t),2); assert.equal(messages(t).length,501); emit(t,'sync_failed',{retryAfterMs:30000}); const d=deferredResponse(); enqueue(urlFor(t),d.promise); const p=app.fetchThreadHistory(t.id); reset(); d.release({messages:[message('stale')]}); await p; await advance(30000); assert.equal(app.state.historyByThread.size,0); assert.equal(app.state.messagesByThread.size,0); assert.equal(calls(t),0); });
await test('F28 no message-cache loaded gate', () => { assert.doesNotMatch(appSource,/messagesByThread\.has\s*\(/); });
await test('F29 no page reload workaround; auth redirect allowed', () => { assert.doesNotMatch(appSource,/(?:location\.reload\s*\(|history\.go\s*\(\s*0\s*\)|location\.href\s*=\s*(?:window\.)?location\.href)/); assert.match(appSource,/window\.location\.href\s*=\s*["']\/login/); });
window.close();
console.log(`FRONTEND HISTORY: ${results.filter(Boolean).length}/${results.length} PASS`);
process.exitCode = results.every(Boolean) ? 0 : 1;
