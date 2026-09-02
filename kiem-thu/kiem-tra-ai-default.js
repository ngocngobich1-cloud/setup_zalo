/**
 * Focused P1 test: OpenCode Zen / Nemotron system default.
 * Chi dung OpenCode metadata fixture local; khong goi model/provider that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const OWNER = "p1-ai-owner";
const ketQua = [];

async function bai(ma, moTa, fn) {
  try {
    await fn();
    ketQua.push({ ma, moTa, pass: true });
  } catch (error) {
    ketQua.push({ ma, moTa, pass: false, error: error.message });
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-default-p1-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  process.chdir(tmp);

  let defaultAvailable = true;
  let metadataCalls = 0;
  let realProviderCalls = 0;
  const runtime = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://fixture.local").pathname;
    if (req.method !== "GET") realProviderCalls += 1;
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && pathname === "/agent") {
      res.end(JSON.stringify([{ name: "general" }]));
      return;
    }
    if (req.method === "GET" && pathname === "/experimental/tool/ids") {
      res.end(JSON.stringify([]));
      return;
    }
    if (req.method === "GET" && pathname === "/config/providers") {
      metadataCalls += 1;
      res.end(JSON.stringify({
        providers: [{
          id: "opencode",
          name: "OpenCode Zen",
          models: defaultAvailable ? {
            "nemotron-3-ultra-free": {
              name: "Nemotron 3 Ultra Free",
              status: "active",
              limit: { context: 1000000 },
              capabilities: { input: { text: true }, output: { text: true } },
            },
          } : {
            "another-free-model": {
              name: "Another Free Model",
              status: "active",
              limit: { context: 100000 },
              capabilities: { input: { text: true }, output: { text: true } },
            },
          },
        }, {
          id: "google",
          name: "Google",
          models: {
            "gemini-test": {
              name: "Gemini Test",
              status: "active",
              limit: { context: 100000 },
              capabilities: { input: { text: true }, output: { text: true } },
            },
          },
        }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "fixture route not found" }));
  });
  await new Promise((resolve) => runtime.listen(0, "127.0.0.1", resolve));
  const runtimeUrl = `http://127.0.0.1:${runtime.address().port}`;

  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  await db.initDb();
  const opencode = await import(pathToFileURL(path.join(REPO, "lib", "opencode.js")).href);
  opencode.markCredentialPlaneReady(
    OWNER,
    ["opencode", "google"],
    "/tmp/test-ai-default-credential-context"
  );
  const aiChat = await import(pathToFileURL(path.join(REPO, "lib", "ai-chat.js")).href);
  aiChat.capHinhChuTaiKhoan(() => OWNER);
  const architect = await import(pathToFileURL(path.join(REPO, "lib", "onboarding-architect.js")).href);

  const saveModel = (opencodeModel) => db.saveAiChatConfig(OWNER, {
    allowedTopics: "",
    roleTone: "",
    useKnowledge: false,
    knowledgeFileIds: [],
    soul: "",
    opencodeBaseUrl: runtimeUrl,
    opencodeAgent: "general",
    opencodeModel,
  });

  await bai("T1", "fresh canonical rong co effective Nemotron default", async () => {
    defaultAvailable = true;
    await saveModel("");
    await aiChat.loadConfig();
    assert.equal(aiChat.getConfig().opencodeModel, "opencode/nemotron-3-ultra-free");
    assert.deepEqual(opencode.splitModel(aiChat.getConfig().opencodeModel), {
      providerID: "opencode",
      modelID: "nemotron-3-ultra-free",
    });
    assert.equal((await db.getAiChatConfig(OWNER)).opencodeModel, "", "default khong duoc tu persist");
  });

  await bai("T2", "catalog UI co dung label OpenCode Zen va Nemotron", async () => {
    const info = await opencode.ping({ opencodeBaseUrl: runtimeUrl });
    const provider = info.providers.find((item) => item.id === "opencode");
    assert.equal(provider.name, "OpenCode Zen");
    assert.equal(provider.models.find((item) => item.id === info.systemDefaultModel)?.label, "Nemotron 3 Ultra Free");
    assert.equal(info.systemDefaultModel, "opencode/nemotron-3-ultra-free");
  });

  await bai("T3", "user-saved canonical model thang system default", async () => {
    const callsBefore = metadataCalls;
    const resolved = await opencode.resolveEffectiveModelConfig({
      opencodeBaseUrl: runtimeUrl,
      opencodeModel: "google/gemini-test",
    });
    assert.equal(resolved.opencodeModel, "google/gemini-test");
    assert.equal(metadataCalls, callsBefore, "saved model khong can default lookup");
  });

  const configSource = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
  await bai("T4", "doi provider chi refresh model pending, khong persist", async () => {
    const line = 'ocProvider.addEventListener("change", () => veOModel(ocProvider.value, ""));';
    assert.ok(configSource.includes(line));
    assert.ok(!line.includes("fetch"));
    assert.ok(!line.includes("/api/ai-chat"));
  });

  await bai("T5", "doi model chi la pending UI state", async () => {
    assert.ok(!configSource.includes('ocModel.addEventListener("change"'));
    assert.ok(configSource.includes("Đổi Hãng AI hoặc Model chỉ thay lựa chọn đang chờ"));
  });

  await bai("T6", "nut Luu ket noi dung canonical POST va reload saved model", async () => {
    assert.ok(configSource.includes('<button type="button" id="btn-ai-model-save" class="primary-button ai-model-save">Lưu</button>'));
    assert.ok(configSource.includes('saveScope: "ai-connection"'));
    assert.ok(configSource.includes('fetch("/api/ai-chat", {'));
    await saveModel("google/gemini-test");
    await aiChat.refreshConfig();
    assert.equal(aiChat.getConfig().opencodeModel, "google/gemini-test");
    assert.equal((await db.getAiChatConfig(OWNER)).opencodeModel, "google/gemini-test");
  });

  await bai("T7", "Nemotron vang khoi catalog thi khong fake hay persist", async () => {
    defaultAvailable = false;
    await saveModel("");
    await aiChat.refreshConfig();
    assert.equal(aiChat.getConfig().opencodeModel, "");
    assert.equal((await db.getAiChatConfig(OWNER)).opencodeModel, "");
  });

  await bai("T8", "Bot Chi huy resolve default khi setup_data chua co model", async () => {
    defaultAvailable = true;
    await saveModel("");
    let request;
    architect.datBoGoiModelOnboardingChoKiemThu(async (value) => {
      request = value;
      return JSON.stringify({
        message: "Câu hỏi mở đầu",
        decision: "ask",
        knownFacts: {},
        confirmedRequirements: [],
      });
    });
    await architect.goiKienTrucSuOnboarding(OWNER, 5, { transcript: [], knownFacts: {} });
    assert.equal(request.config.opencodeModel, "opencode/nemotron-3-ultra-free");
  });

  const fail = ketQua.filter((item) => !item.pass);
  for (const item of ketQua) {
    console.log(`${item.ma} = ${item.pass ? "PASS" : "FAIL"}  ${item.moTa}${item.error ? `\n      -> ${item.error}` : ""}`);
  }
  console.log(`\nTONG: ${ketQua.length - fail.length}/${ketQua.length} PASS`);
  console.log(`OPENCODE_METADATA_FIXTURE_CALLS = ${metadataCalls}`);
  console.log(`REAL_PROVIDER_CALL = ${realProviderCalls}`);
  await new Promise((resolve) => runtime.close(resolve));
  process.exit(fail.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Khung P1 AI default test hong:", error);
  process.exit(2);
});
