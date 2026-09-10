/** Real history/service/cache functions; only DB transport and provider boundaries are isolated.
 * Local reads execute the unchanged production SQL/mappers against in-memory SQLite.
 * No account login, filesystem DB, dependency install, or live provider calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizeIncomingMessage } from '../lib/message-utils.js';
const source = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url),'utf8');
let serial=0;
async function moduleFrom(body, deps={}) {
  const key=`__history_test_${++serial}`;
  globalThis[key]=deps;
  return import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis[${JSON.stringify(key)}];\n${body}`).toString('base64')}#${serial}`);
}
function withoutImports(body) { return body.replace(/^import\s+[\s\S]*?\sfrom\s+["'][^"']+["'];\s*/gm,''); }
const database = new DatabaseSync(':memory:');
database.exec(`CREATE TABLE threads (local_id TEXT PRIMARY KEY, owner_uid TEXT, remote_thread_id TEXT, thread_type INTEGER, title TEXT, avatar TEXT, bot_enabled INTEGER, last_message TEXT, last_message_at INTEGER, updated_at INTEGER);
CREATE TABLE messages (id TEXT, thread_id TEXT, content TEXT, is_self INTEGER, sender_id TEXT, sender_name TEXT, sender_avatar TEXT, msg_type TEXT, ts INTEGER, raw_json TEXT, PRIMARY KEY(thread_id,id));`);
const dbSource=source('lib/db.js');
function productionFunction(name) {
  const match=dbSource.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match,`production function ${name} exists`);
  return match[0];
}
const readDb=await moduleFrom(['getThread','getThreadMessages','mapThread','mapMessage','safeJson'].map(productionFunction).join('\n'),{
  get:async(sql,args)=>database.prepare(sql).get(...args), all:async(sql,args)=>database.prepare(sql).all(...args),
});
let writes=0, onWrite=null;
const db={ ...readDb,
  insertMessage:async(owner,m)=>{
    writes++; const key=`${owner}:${m.threadId}`;
    database.prepare('INSERT OR IGNORE INTO threads (local_id,owner_uid,remote_thread_id,thread_type) VALUES (?,?,?,?)').run(key,owner,m.threadId,m.threadType);
    const result=database.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)').run(String(m.id),key,m.content,Number(m.isSelf),m.senderId,m.senderName,m.senderAvatar,m.msgType,m.ts,null);
    onWrite?.(); return result;
  },
  upsertThread:async()=>{writes++; onWrite?.();},
  listThreads:async()=>[],
};
const sticker=await moduleFrom(withoutImports(source('lib/sticker.js')));
const meta=await moduleFrom(withoutImports(source('lib/thread-meta.js')),{...db,...sticker});
const history=await moduleFrom(withoutImports(source('lib/chat-history.js')),{...db,ThreadType:{User:0,Group:1},normalizeIncomingMessage});
const zaloSource=source('lib/zalo-service.js');
const names=[];
for (const m of zaloSource.slice(0,zaloSource.indexOf('const USER_AGENT')).matchAll(/import\s+(?:(\*\s+as\s+\w+)|\{([^}]*)\}|(\w+))\s+from/g)) {
  if(m[1]) names.push(m[1].replace(/\*\s+as\s+/,''));
  else if(m[2]) names.push(...m[2].split(',').map(s=>s.trim()).filter(Boolean).map(s=>s.includes(' as ')?s.split(' as ')[1].trim():s));
  else names.push(m[3]);
}
const deps=Object.fromEntries(names.map(name=>[name,()=>undefined]));
Object.assign(deps,db,meta,history,sticker,{createHash, Zalo:class{}, ThreadType:{User:0,Group:1},
  taoBoGom:()=>({them(){},huyTatCa(){},dangMo(){return false;}}), createPdfAutomationHandler:()=>async()=>{},
});
const service=await moduleFrom(zaloSource.slice(zaloSource.indexOf('const USER_AGENT'))+`
export function __runtime(provider,owner,socket) { runtimeGeneration++; api=provider; appState.uid=owner; appState.loggedIn=Boolean(owner); appState.myAvatar='self-avatar'; io=socket; }
`,deps);
const events=[], logs=[];
const originalLog=console.log;
console.log=(...args)=>{ if(args[0]==='[history-load]') logs.push(JSON.parse(args[1])); else originalLog(...args); };
let owner,threadId,api;
const socket={emit:(name,payload)=>events.push({name,...payload})};
function fixture(count=1,type=1,overrides={}) {
  history.resetHistorySyncState(); events.length=0; logs.length=0; writes=0; onWrite=null;
  owner=`owner-${++serial}`; threadId=`thread-${serial}`;
  api={getGroupChatHistory:async()=>({groupMsgs:[]}),getUserInfo:async()=>({avatar:null}),getStickersDetail:async()=>[],...overrides};
  service.__runtime(api,owner,socket);
  database.prepare('INSERT INTO threads(local_id,owner_uid,remote_thread_id,thread_type,avatar) VALUES(?,?,?,?,?)').run(`${owner}:${threadId}`,owner,threadId,type,'thread-avatar');
  const insert=database.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<count;i++) insert.run(String(i),`${owner}:${threadId}`,`local-${i}`,0,`sender-${serial}-${i%60}`,null,null,'text',1800000000000+i,null);
  return {owner,threadId};
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const never=()=>new Promise(()=>{});
async function fast(promise) {
  let timer; try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Local history blocked >300ms')),300);})]); }
  finally{clearTimeout(timer);}
}
const state=()=>history.getGroupHistorySyncStatus(api,owner,threadId,1);
const eligible=()=>history.shouldSyncGroupHistory(api,owner,threadId,1);
const raw=(id='imported')=>({threadId,id,content:'historical fixture',threadType:1,ts:1800000000500});
const terminal=(reason)=>events.filter(e=>e.reason===reason);
let tests=0,passed=0,p95=null;
async function test(name,fn){tests++;try{await fn();passed++;console.log(`PASS ${name}`);}catch(error){console.error(`FAIL ${name}`,error.stack);}}
await test('H1 local SQLite payload and owner-scoped production query',async()=>{fixture(3,0);const data=await fast(service.getMessagesForThread(threadId));assert.deepEqual(data.messages.map(m=>m.content),['local-0','local-1','local-2']);assert.equal(data.myAvatar,'self-avatar');assert.deepEqual(await readDb.getThreadMessages('wrong-owner',threadId),[]);assert.deepEqual((await service.getMessagesForThread('unowned')).messages,[]);assert.equal(logs[0].thread,createHash('sha256').update(owner+threadId).digest('hex').slice(0,12));assert.deepEqual(Object.keys(logs[0]).sort(),['thread','dbMs','count','buildMs','syncScheduled','syncInFlight','syncRetryAfterMs','enrichHit','enrichMiss'].sort());});
await test('H2 hung group sync cannot block local response',async()=>{fixture(1,1,{getGroupChatHistory:never});const data=await fast(service.getMessagesForThread(threadId));assert.equal(data.messages.length,1);await flush();assert.equal(state().inFlight,true);});
await test('H3 hung/rejected avatar cannot block text',async()=>{for(const lookup of [never,async()=>{throw Error('fixture');}]){fixture(1,1,{getUserInfo:lookup});const data=await fast(service.getMessagesForThread(threadId));assert.equal(data.messages[0].content,'local-0');assert.equal(data.messages[0].senderAvatar,null);await flush();}});
await test('H4 hung/rejected sticker cannot block history',async()=>{for(const lookup of [never,async()=>{throw Error('fixture');}]){fixture(1,0,{getStickersDetail:lookup});database.prepare('UPDATE messages SET content=?,msg_type=? WHERE thread_id=?').run(JSON.stringify({id:++serial}),'chat.sticker',`${owner}:${threadId}`);const data=await fast(service.getMessagesForThread(threadId));assert.equal(data.messages.length,1);assert.equal(data.messages[0].isSticker,true);await flush();}});
await test('H5 all external work starts after local payload yields',async()=>{let external=0;fixture(2,1,{getGroupChatHistory:()=>{external++;return never();},getUserInfo:()=>{external++;return never();},getStickersDetail:()=>{external++;return never();}});database.prepare('UPDATE messages SET content=?,msg_type=? WHERE thread_id=? AND id=?').run(JSON.stringify({id:++serial}),'chat.sticker',`${owner}:${threadId}`,'0');const data=await fast(service.getMessagesForThread(threadId));assert.equal(external,0);assert.equal(data.messages.length,2);await flush();assert.equal(external,4);});
await test('H6 empty ineligible returns no scheduled sync',async()=>{fixture(0,0);const data=await service.getMessagesForThread(threadId);assert.equal(data.syncScheduled,false);assert.equal(data.syncInFlight,false);assert.equal(data.syncRetryAfterMs,0);assert.equal(history.shouldSyncGroupHistory(api,null,threadId,1),false);assert.equal(history.shouldSyncGroupHistory({},owner,threadId,1),false);assert.equal(history.shouldSyncGroupHistory({getGroupChatHistory:true},owner,threadId,1),false);});
await test('H7 empty eligible schedules sync',async()=>{fixture(0,1,{getGroupChatHistory:never});const data=await service.getMessagesForThread(threadId);assert.equal(data.syncScheduled,true);assert.equal(data.messages.length,0);});
await test('H8 inflight reservation prevents duplicate attempts',async()=>{let count=0;fixture(0,1,{getGroupChatHistory:()=>{count++;return never();}});const data=await service.getMessagesForThread(threadId);assert.equal(data.syncInFlight,true);assert.equal(state().inFlight,true);assert.equal(eligible(),false);await service.getMessagesForThread(threadId);await flush();assert.equal(count,1);});
await test('H9 successful import emits exactly one terminal event',async()=>{fixture(0);api.getGroupChatHistory=async()=>({groupMsgs:[raw()]});await service.getMessagesForThread(threadId);await flush();assert.equal(terminal('sync_complete').length,1);assert.equal(terminal('sync_complete')[0].changedCount,1);assert.equal((await readDb.getThreadMessages(owner,threadId)).length,1);assert.ok(events.every(e=>e.name==='thread-history-updated'));});
await test('H10 zero-row success still emits completion exactly once', async () => {
  for (const alreadyStored of [false, true]) {
    fixture(alreadyStored ? 1 : 0);
    api.getGroupChatHistory = async () => ({ groupMsgs: alreadyStored ? [raw('0')] : [] });
    await service.getMessagesForThread(threadId);
    await flush();
    assert.equal(terminal('sync_complete').length, 1);
    assert.equal(terminal('sync_complete')[0].changedCount, 0);
  }
});
await test('H11 successful sync releases inflight and TTL disallows retry',async()=>{fixture(0);await service.getMessagesForThread(threadId);await flush();assert.deepEqual(state(),{inFlight:false,retryAfterMs:0});assert.equal(eligible(),false);const next=await service.getMessagesForThread(threadId);assert.equal(next.syncScheduled,false);assert.equal(next.syncInFlight,false);assert.equal(next.syncRetryAfterMs,0);});
await test('H12 failed sync emits exactly one safe failure',async()=>{fixture(0,1,{getGroupChatHistory:async()=>{throw Error('private-error-fixture');}});await service.getMessagesForThread(threadId);await flush();assert.equal(terminal('sync_failed').length,1);assert.equal(terminal('sync_failed')[0].retryAfterMs,30000);assert.doesNotMatch(JSON.stringify(events),/private-error-fixture/);});
await test('H13 exact 30 second failure retry eligibility and pure reads',async()=>{const real=Date.now;let now=1800000000000;Date.now=()=>now;try{fixture(0,1,{getGroupChatHistory:async()=>{throw Error();}});await service.getMessagesForThread(threadId);await flush();assert.deepEqual(state(),{inFlight:false,retryAfterMs:30000});for(let i=0;i<5;i++)assert.equal(eligible(),false);now+=29999;assert.equal(state().retryAfterMs,1);assert.equal(eligible(),false);now++;assert.equal(eligible(),true);assert.equal(state().retryAfterMs,0);api.getGroupChatHistory=async()=>({groupMsgs:[]});assert.equal((await service.getMessagesForThread(threadId)).syncScheduled,true);await flush();assert.equal(terminal('sync_complete').length,1);}finally{Date.now=real;}});
await test('H14 failed gate is retained with TTL-offset backoff',()=>{const body=source('lib/chat-history.js');assert.doesNotMatch(body,/historySyncAt\.delete\s*\(/);assert.match(body,/historySyncAt\.set\(key, now - HISTORY_SYNC_TTL_MS \+ HISTORY_SYNC_FAILURE_BACKOFF_MS\)/);});
await test('H15 stale origin prevents writes before and between DB boundaries',async()=>{const d=deferred();fixture(0,1,{getGroupChatHistory:()=>d.promise});await service.getMessagesForThread(threadId);await flush();service.__runtime({},'other-owner',socket);d.resolve({groupMsgs:[raw()]});await flush();assert.equal(writes,0);assert.equal(events.length,0);fixture(0);api.getGroupChatHistory=async()=>({groupMsgs:[raw('a'),raw('b')]});onWrite=()=>service.__runtime({},'changed',socket);await service.getMessagesForThread(threadId);await flush();assert.equal(writes,1);assert.equal(events.length,0);});
await test('H16 origin rechecked immediately before terminal emit',async()=>{fixture(0);let wasInflight=false;await history.syncHistoryForThread(api,owner,threadId,1,{isCurrent:()=>{const inflight=state().inFlight;if(inflight)wasInflight=true;return !wasInflight||inflight;},onTerminal:e=>events.push(e)});assert.equal(events.length,0);assert.equal(wasInflight,true);});
await test('H17 reset clears gates/backoff/inflight and fences old attempts',async()=>{fixture(0,1,{getGroupChatHistory:async()=>{throw Error();}});await service.getMessagesForThread(threadId);await flush();history.resetHistorySyncState();assert.equal(eligible(),true);assert.deepEqual(state(),{inFlight:false,retryAfterMs:0});const d=deferred();api.getGroupChatHistory=()=>d.promise;const pending=history.syncHistoryForThread(api,owner,threadId,1,{onTerminal:e=>events.push(e)});await flush();assert.equal(state().inFlight,true);history.resetHistorySyncState();assert.deepEqual(state(),{inFlight:false,retryAfterMs:0});assert.equal(eligible(),true);events.length=0;d.resolve({groupMsgs:[raw()]});await pending;assert.equal(writes,0);assert.equal(events.length,0);});
await test('H18 warm fill batches sender/sticker and emits once',async()=>{fixture(2,1,{getUserInfo:async()=>({avatar:'warm-avatar'}),getStickersDetail:async()=>[{stickerWebpUrl:'warm-sticker'}]});database.prepare('UPDATE messages SET content=?,msg_type=? WHERE thread_id=? AND id=?').run(JSON.stringify({id:++serial}),'chat.sticker',`${owner}:${threadId}`,'0');await service.getMessagesForThread(threadId);await flush();assert.equal(terminal('enrichment_updated').length,1);const data=await service.getMessagesForThread(threadId);assert.equal(data.messages[0].stickerUrl,'warm-sticker');assert.ok(data.messages.every(m=>m.senderAvatar==='warm-avatar'));await flush();assert.equal(terminal('enrichment_updated').length,1);});
await test('H19 zero fill is silent; stale warm cannot fill or emit',async()=>{fixture(1);await service.getMessagesForThread(threadId);await flush();assert.equal(terminal('enrichment_updated').length,0);const d=deferred();fixture(1,1,{getUserInfo:()=>d.promise});const savedOwner=owner,savedThread=await readDb.getThread(owner,threadId),savedMessages=await readDb.getThreadMessages(owner,threadId);await service.getMessagesForThread(threadId);await flush();service.__runtime({},'replacement',socket);d.resolve({avatar:'stale-avatar'});await flush();assert.equal(terminal('enrichment_updated').length,0);assert.equal(meta.enrichHistoryFromCache(savedOwner,savedMessages,savedThread,null).messages[0].senderAvatar,null);});
await test('H20 negative cooldown lasts 60s and is owner scoped', async () => {
  const real = Date.now;
  let now = 1800000000000;
  Date.now = () => now;
  try {
    for (const type of ['sender', 'sticker']) {
      let count = 0;
      fixture(0);
      const candidate = [{ type, id: type === 'sender' ? `failed-${serial}` : ++serial }];
      const fail = async () => { count++; throw Error('fixture'); };
      const failing = { getUserInfo: fail, getStickersDetail: fail };
      await meta.warmHistoryEnrichment(failing, owner, threadId, candidate);
      await meta.warmHistoryEnrichment(failing, owner, 'other-thread', candidate);
      assert.equal(count, 1);
      now += 59999;
      await meta.warmHistoryEnrichment(failing, owner, threadId, candidate);
      assert.equal(count, 1);
      await meta.warmHistoryEnrichment(failing, 'other-owner', threadId, candidate);
      assert.equal(count, 2);
      now++;
      await meta.warmHistoryEnrichment(failing, owner, threadId, candidate);
      assert.equal(count, 3);
    }
  } finally { Date.now = real; }
});
await test('H21 concurrent same-thread warm dedupes, caps lookups at 60',async()=>{fixture(0);const d=deferred();let calls=0;const provider={getUserInfo:async()=>{calls++;return d.promise;}};const candidates=Array.from({length:80},(_,i)=>({type:'sender',id:`batch-${serial}-${i}`}));const a=meta.warmHistoryEnrichment(provider,owner,threadId,[...candidates,...candidates]);const b=meta.warmHistoryEnrichment(provider,owner,threadId,candidates);assert.equal(a,b);await flush();assert.equal(calls,6);d.resolve({avatar:'batch-avatar'});await a;assert.equal(calls,60);});
await test('H22 repeated refresh sequence converges without event loop',async()=>{let syncCalls=0,avatarCalls=0;fixture(4,1,{getGroupChatHistory:async()=>{syncCalls++;return {groupMsgs:[]};},getUserInfo:async()=>{avatarCalls++;return{avatar:'cache-avatar'};}});await service.getMessagesForThread(threadId);await flush();for(let i=0;i<10;i++){await service.getMessagesForThread(threadId);await flush();}assert.equal(syncCalls,1);assert.equal(avatarCalls,4);assert.equal(terminal('sync_complete').length,1);assert.equal(terminal('enrichment_updated').length,1);});
await test('H23 500 messages / 60 senders P95 under 300ms with 2s providers',async()=>{const delays=[];const delayed=(value)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(value),2000);delays.push(timer);});let external=0;fixture(500,1,{getGroupChatHistory:()=>{external++;return delayed({groupMsgs:[]});},getUserInfo:()=>{external++;return delayed({avatar:'perf-avatar'});}});try{for(let i=0;i<5;i++)await fast(service.getMessagesForThread(threadId));await flush();assert.ok(external>=2);const samples=[];for(let i=0;i<40;i++){const start=performance.now();const data=await fast(service.getMessagesForThread(threadId));samples.push(performance.now()-start);assert.equal(data.messages.length,500);assert.equal(new Set(data.messages.map(m=>m.senderId)).size,60);}samples.sort((a,b)=>a-b);p95=samples[Math.ceil(samples.length*.95)-1];assert.ok(p95<300,`P95 ${p95}ms`);await flush();assert.ok(external>=2);}finally{service.__runtime(null,null,socket);for(const timer of delays)clearTimeout(timer);}});
console.log=originalLog;
database.close();
console.log(`BACKEND HISTORY: ${passed}/${tests} PASS; PERFORMANCE_P95_MS=${p95?.toFixed(3)}`);
process.exitCode=passed===tests?0:1;
