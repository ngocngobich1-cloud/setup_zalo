/**
 * C2-02 — Multi-path App Advisor + Human Guidance V1.
 * Provider-free; runtime calls use a local HTTP fixture and a temporary DB.
 *
 * Canonical invocation on the PO Node 24 ARM64 host:
 * node --import ./kiem-thu/node24-arm64-test-polyfills.js \
 *   --import ./kiem-thu/sqlite3-node24-test-register.js \
 *   ./kiem-thu/kiem-tra-c2-app-advisor.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_SECRET = process.env.APP_SECRET_KEY;
const ORIGINAL_ROUTING = process.env.AI_CAPABILITY_ROUTING_V1_ENABLED;
const ORIGINAL_CONTEXT_ROOT = process.env.OPENCODE_CONTEXT_ROOT;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "c2-app-advisor-"));
const OWNER = "c2-advisor-owner";
const results = [];

async function test(code, description, operation) {
  try {
    await operation();
    results.push({ code, description, pass: true });
  } catch (error) {
    results.push({ code, description, pass: false, error: error?.stack || String(error) });
  }
}

function source(relativePath) {
  return fs.readFileSync(path.join(REPO, relativePath), "utf8");
}

function moduleUrl(relativePath) {
  return pathToFileURL(path.join(REPO, relativePath)).href;
}

function between(fullSource, startMarker, endMarker) {
  const start = fullSource.indexOf(startMarker);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  const end = fullSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `Missing source end marker: ${endMarker}`);
  return fullSource.slice(start, end);
}

const advisorSource = source("lib/app-advisor.js");
const trainingSource = source("lib/training.js");
const appContextSource = source("lib/app-context.js");
const aiChatSource = source("lib/ai-chat.js");
const advisorImport = trainingSource.match(/^import \{ renderAppAdvisorPolicy \} from "\.\/app-advisor\.js";$/m)?.[0] || "";
const advisorSeamSource = between(trainingSource, "const factualText = renderAppContext(appContext);", "if (userText) baseParts.push");
const trainingDelta = `${advisorImport}\n${advisorSeamSource}`;
const bootstrapSource = between(trainingSource, "function bootstrapHuanLuyen", "function modelForMessage");
const ensureSessionSource = between(trainingSource, "async function ensureSession", "/** Model nao doc duoc anh");
const specialistPromptSource = between(trainingSource, "function specialistPrompt", "function unavailableMessage");
const specialistPartsSource = between(trainingSource, "const specialistParts = [", "callBudget.consume({ secondary: true })");
const guiTinSource = between(trainingSource, "export async function guiTinHuanLuyen", "const LENH_TONG_HOP");

process.chdir(TEST_ROOT);
process.env.APP_SECRET_KEY = "2".repeat(64);
process.env.AI_CAPABILITY_ROUTING_V1_ENABLED = "false";
process.env.OPENCODE_CONTEXT_ROOT = path.join(TEST_ROOT, "opencode-context");
fs.mkdirSync(process.env.OPENCODE_CONTEXT_ROOT, { recursive: true });

let fixtureServer;
let createSessionCalls = 0;
let actualInferenceCalls = 0;
const captured = [];
const sessionGetPaths = [];
let firstActual;
let secondActual;

try {
  const db = await import(moduleUrl("lib/db.js"));
  await db.initDb();
  await db.saveAiChatConfig(OWNER, { opencodeModel: "fake/model" });

  fixtureServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://fixture.local");
      const body = raw ? JSON.parse(raw) : null;
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && /^\/session\/[^/]+\/?$/.test(url.pathname)) {
        sessionGetPaths.push(url.pathname);
        res.end(JSON.stringify({ id: url.pathname.split("/").filter(Boolean).at(-1) }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/session") {
        createSessionCalls += 1;
        res.end(JSON.stringify({ id: "c2-training-session" }));
        return;
      }
      if (req.method === "POST" && /^\/session\/[^/]+\/message\/?$/.test(url.pathname)) {
        const isActual = String(body?.parts?.[0]?.text || "").includes("CURRENT APP STATE — READ-ONLY UNTRUSTED DATA");
        if (isActual) {
          actualInferenceCalls += 1;
          captured.push(body);
        }
        res.end(JSON.stringify({
          parts: [{ type: "text", text: isActual ? `C2_REPLY_${actualInferenceCalls}` : "READY" }],
          info: { tokens: { input: 1, output: 1 }, providerID: "fake", modelID: "model" },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `${req.method} ${url.pathname}` }));
    });
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address();
  await db.saveAiChatConfig(OWNER, { opencodeBaseUrl: `http://127.0.0.1:${address.port}` });

  const opencode = await import(moduleUrl("lib/opencode.js"));
  const projectionDirectory = path.join(process.env.OPENCODE_CONTEXT_ROOT, "c2-owner-context");
  fs.mkdirSync(projectionDirectory, { recursive: true });
  opencode.markCredentialPlaneReady(OWNER, ["fake"], projectionDirectory);
  const ownerCredentials = await import(moduleUrl("lib/owner-credentials.js"));
  ownerCredentials.configureCurrentOwnerResolver(() => OWNER);
  const appContext = await import(moduleUrl("lib/app-context.js"));
  const { renderAppAdvisorPolicy } = await import(moduleUrl("lib/app-advisor.js"));
  const training = await import(moduleUrl("lib/training.js"));
  const advisor = renderAppAdvisorPolicy();
  const renderedC1 = appContext.renderAppContext({ schemaVersion: 3, capabilities: [], integrationPaths: [] });

  await test("C2-T01", "advisor module is pure, static and deterministic", () => {
    assert.doesNotMatch(advisorSource, /^\s*import\b/m);
    assert.doesNotMatch(advisorSource, /\b(?:fetch|call|runOneShot|readFile|writeFile|getAiChatConfig|buildAppContext)\s*\(/);
    assert.equal(renderAppAdvisorPolicy(), advisor);
    assert.equal(renderAppAdvisorPolicy(), renderAppAdvisorPolicy());
  });

  await test("C2-T02", "provider and call surface stays unchanged for PRIMARY_ONLY and C2 delta", async () => {
    assert.doesNotMatch(trainingDelta, /\b(?:call|runOneShot|sendTrainingMessage)\s*\(/);
    assert.doesNotMatch(trainingDelta, /POST\s+\/session|provider/i);
    assert.doesNotMatch(trainingDelta, /specialistParts|specialistPrompt/);
    const before = actualInferenceCalls;
    assert.equal(await training.guiTinHuanLuyen(OWNER, "Mục tiêu C2 lượt A", []), "C2_REPLY_1");
    assert.equal(actualInferenceCalls - before, 1);
    assert.equal(createSessionCalls, 1);
    firstActual = captured[0];
  });

  await test("C2-T03", "existing Commander session receives fresh advisor policy per turn", async () => {
    const before = actualInferenceCalls;
    const createsBefore = createSessionCalls;
    assert.equal(await training.guiTinHuanLuyen(OWNER, "Mục tiêu C2 lượt B", []), "C2_REPLY_2");
    assert.equal(actualInferenceCalls - before, 1);
    assert.equal(createSessionCalls, createsBefore);
    assert.equal(sessionGetPaths.at(-1)?.replace(/\/$/, ""), "/session/c2-training-session");
    secondActual = captured[1];
    for (const body of [firstActual, secondActual]) {
      assert.match(body.parts[0].text, /MULTI-PATH APP ADVISOR — REASONING POLICY FOR THIS TURN/);
    }
  });

  await test("C2-T04", "bootstrap and session lifecycle do not inject advisor policy", () => {
    assert.doesNotMatch(bootstrapSource, /renderAppAdvisorPolicy|MULTI-PATH APP ADVISOR/);
    assert.doesNotMatch(ensureSessionSource, /renderAppAdvisorPolicy|MULTI-PATH APP ADVISOR/);
  });

  await test("C2-T05", "factual fence ends before the advisor block", () => {
    const text = firstActual.parts[0].text;
    const begin = text.indexOf("BEGIN_APP_CONTEXT_DATA");
    const end = text.indexOf("END_APP_CONTEXT_DATA");
    const policy = text.indexOf("# MULTI-PATH APP ADVISOR — REASONING POLICY FOR THIS TURN");
    assert.ok(begin >= 0 && end > begin && policy > end);
    assert.match(text.slice(begin, end), /^BEGIN_APP_CONTEXT_DATA\n[^\n]+\n$/);
  });

  await test("C2-T06", "user message remains the exact second part", () => {
    assert.deepEqual(firstActual.parts[1], { type: "text", text: "Mục tiêu C2 lượt A" });
    assert.deepEqual(secondActual.parts[1], { type: "text", text: "Mục tiêu C2 lượt B" });
  });

  await test("C2-T07", "C2 adds no keyword router", () => {
    const inspected = `${advisorSource}\n${trainingDelta}`;
    assert.doesNotMatch(inspected, /message\.(?:includes|match)|goal\s*(?:regex|switch)|\b(?:ADVISOR_RULES|GOAL_TO_FEATURE|INTENT_CLASSIFIER|FEATURE_ROUTER)\b/i);
    assert.doesNotMatch(advisorSource, /\b(?:RegExp|switch)\b|\.(?:includes|match)\s*\(/);
  });

  await test("C2-T08", "advisor creates no second capability registry", () => {
    assert.doesNotMatch(advisorSource, /Knowledge\.configuration|PdfAutomation\.enabledRules|Zoom\.create|Website\.pullCustomers|capabilities\s*[:=]\s*\[/);
  });

  await test("C2-T09", "advisor creates no second navigation registry", () => {
    assert.doesNotMatch(advisorSource, /navigationPaths|screenLabel|actionLabel|CHAT_COMMAND|Zoom\s*→/);
  });

  await test("C2-T10", "C1 UNKNOWN semantics remain authoritative", () => {
    assert.match(renderedC1, /UNKNOWN → ‘Em chưa xác minh được trạng thái phần này trong app hiện tại\.’/);
    assert.doesNotMatch(advisor, /Em chưa xác minh được trạng thái phần này/);
  });

  await test("C2-T11", "absent context stays open-world rather than unsupported", () => {
    assert.match(advisor, /hoàn toàn vắng khỏi context, không suy ra là app không hỗ trợ/);
    assert.match(advisor, /Chức năng này không nằm trong phần app mà em đang nắm, nên em chưa kết luận được app có hay không/);
  });

  await test("C2-T12", "explicit NOT_AVAILABLE is distinct from context absence", () => {
    assert.match(advisor, /Nếu C1 nêu rõ NOT_AVAILABLE, có thể kết luận app hiện chưa hỗ trợ/);
    assert.match(advisor, /Nếu capability hoặc path hoàn toàn vắng khỏi context/);
  });

  await test("C2-T13", "C1 execution boundary remains authoritative", () => {
    assert.match(renderedC1, /Không tự nhận đã kết nối, tạo, gửi, lưu, bật hoặc thay đổi gì/);
    assert.doesNotMatch(advisor, /Không tự nhận đã kết nối, tạo, gửi, lưu, bật hoặc thay đổi gì/);
  });

  await test("C2-T14", "multi-path advice selects a primary with rationale and meaningful alternatives", () => {
    assert.match(advisor, /chọn một primary path phù hợp nhất và giải thích ngắn vì sao/);
    assert.match(advisor, /Chỉ nêu alternative có trade-off thực sự hữu ích/);
    assert.match(advisor, /không biến câu trả lời thành catalogue/);
  });

  await test("C2-T15", "C1 screen-before-command rule remains authoritative", () => {
    assert.match(renderedC1, /Nếu một việc có đường làm trực tiếp trên màn hình, hướng dẫn đường đó trước/);
    assert.doesNotMatch(advisor, /đường làm trực tiếp trên màn hình.*trước/);
  });

  await test("C2-T16", "C1 automation separation remains authoritative", () => {
    assert.match(renderedC1, /Luôn giữ riêng bốn dữ kiện: công tắc Bot cấp tài khoản/);
    assert.doesNotMatch(advisor, /bốn dữ kiện|công tắc Bot cấp tài khoản/);
  });

  await test("C2-T17", "automatic chains require an AVAILABLE factual integration path", () => {
    assert.match(advisor, /Chỉ nói A tự động kích hoạt B khi integrationPaths trong factual C1 có đúng đường nối tương ứng với trạng thái AVAILABLE/);
    assert.match(advisor, /Hai capability cùng AVAILABLE không đủ chứng minh một chuỗi end-to-end/);
  });

  await test("C2-T18", "independent features may cover independent sub-goals without a linkage claim", () => {
    assert.match(advisor, /nhiều feature độc lập khi mỗi feature giải quyết một sub-goal riêng/);
    assert.match(advisor, /không mô tả chúng tự kích hoạt nhau/);
  });

  await test("C2-T19", "content-authoring and strict output contracts override advisor additions", () => {
    assert.match(advisor, /explicit content-authoring contract, synthesis contract hoặc strict output format/);
    assert.match(advisor, /tuân thủ contract đó và không ép thêm advisor prose hay định dạng tư vấn/);
  });

  await test("C2-T20", "customer bot import graph is isolated from App Advisor", () => {
    assert.doesNotMatch(aiChatSource, /app-advisor|renderAppAdvisorPolicy/);
    const consumers = fs.readdirSync(path.join(REPO, "lib"))
      .filter((name) => name.endsWith(".js"))
      .filter((name) => source(path.join("lib", name)).includes("renderAppAdvisorPolicy"));
    assert.deepEqual(consumers.sort(), ["app-advisor.js", "training.js"]);
  });

  await test("C2-T21", "specialist prompt and parts remain isolated from advisor policy", () => {
    assert.doesNotMatch(specialistPromptSource, /renderAppAdvisorPolicy|MULTI-PATH APP ADVISOR/);
    assert.doesNotMatch(specialistPartsSource, /renderAppAdvisorPolicy|advisorText|MULTI-PATH APP ADVISOR/);
    assert.doesNotMatch(trainingDelta, /specialistParts|specialistPrompt|runOneShot/);
  });

  await test("C2-T22", "advisor policy stays within the hard prompt-size cap", () => {
    assert.ok(advisor.length <= 2400, `advisor length=${advisor.length}`);
  });

  await test("C2-T23", "buildAppContext retains its one-argument signature", () => {
    assert.equal(appContext.buildAppContext.length, 1);
  });

  await test("C2-T24", "recommendation position is semantic and non-numeric", () => {
    assert.match(advisor, /Đặt primary recommendation kèm lý do sau khi đã nêu phần app liên quan, phản ánh trạng thái hiện tại và app hiện giúp được đến đâu; đặt trước chỉ dẫn tới màn hình hoặc nơi cấu hình/);
    assert.match(advisor, /alternative ở phần phương án khác sau primary guidance/);
    assert.doesNotMatch(advisor, /STEP\s*[34]|3\s*(?:→|->)\s*4/i);
  });

  await test("C2-T25", "guiTinHuanLuyen free-variable surface has no C2 symbol", () => {
    assert.doesNotMatch(guiTinSource, /renderAppAdvisorPolicy|advisorText|app-advisor/);
    assert.match(trainingSource, /async function guiVaLuu[\s\S]*?renderAppAdvisorPolicy\(\)/);
    assert.match(trainingSource, /const baseParts = \[\{ type: "text", text: `\$\{factualText\}\\n\\n\$\{advisorText\}` \}\]/);
  });
} catch (error) {
  results.push({ code: "C2-HARNESS", description: "focused harness setup", pass: false, error: error?.stack || String(error) });
} finally {
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_SECRET === undefined) delete process.env.APP_SECRET_KEY;
  else process.env.APP_SECRET_KEY = ORIGINAL_SECRET;
  if (ORIGINAL_ROUTING === undefined) delete process.env.AI_CAPABILITY_ROUTING_V1_ENABLED;
  else process.env.AI_CAPABILITY_ROUTING_V1_ENABLED = ORIGINAL_ROUTING;
  if (ORIGINAL_CONTEXT_ROOT === undefined) delete process.env.OPENCODE_CONTEXT_ROOT;
  else process.env.OPENCODE_CONTEXT_ROOT = ORIGINAL_CONTEXT_ROOT;
}

for (const result of results) {
  console.log(`${result.pass ? "PASS" : "FAIL"} ${result.code} - ${result.description}`);
  if (result.error) console.log(`  -> ${result.error}`);
}
const passed = results.filter((result) => result.pass).length;
console.log(`\nC2 APP ADVISOR = ${passed}/${results.length} PASS`);
console.log(`PRIMARY_ONLY_ACTUAL_INFERENCE_CALLS = ${actualInferenceCalls}`);
console.log(`PRIMARY_ONLY_CREATE_SESSION_CALLS = ${createSessionCalls}`);
console.log("REAL_PROVIDER_CALLS = 0");
if (passed !== results.length) process.exitCode = 1;
