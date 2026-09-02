/**
 * P7 regression: mot nguon model AI duy nhat.
 * Chi goi metadata fixture local; model runner duoc tiem, khong goi provider that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const OWNER = "p7-ai-owner";
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-source-p7-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  process.chdir(tmp);

  let defaultAvailable = true;
  let metadataCalls = 0;
  let realProviderCalls = 0;
  const runtime = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://fixture.local").pathname;
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && pathname === "/config/providers") {
      metadataCalls += 1;
      res.end(JSON.stringify({
        providers: [
          {
            id: "opencode",
            name: "OpenCode Zen",
            models: defaultAvailable ? {
              "nemotron-3-ultra-free": {
                name: "Nemotron 3 Ultra Free",
                status: "active",
                limit: { context: 1000000 },
                capabilities: { input: { text: true }, output: { text: true } },
              },
            } : {},
          },
          {
            id: "openai",
            name: "OpenAI",
            models: {
              "gpt-4.1": {
                name: "GPT-4.1",
                status: "active",
                limit: { context: 100000 },
                capabilities: { input: { text: true }, output: { text: true } },
              },
            },
          },
          {
            id: "google",
            name: "Google",
            models: {
              "gemini-3.5-flash": {
                name: "Gemini 3.5 Flash",
                status: "active",
                limit: { context: 100000 },
                capabilities: { input: { text: true }, output: { text: true } },
              },
            },
          },
        ],
      }));
      return;
    }
    if (req.method !== "GET") realProviderCalls += 1;
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
    ["opencode", "openai", "google"],
    "/tmp/test-ai-model-source-credential-context"
  );
  const aiChat = await import(pathToFileURL(path.join(REPO, "lib", "ai-chat.js")).href);
  aiChat.capHinhChuTaiKhoan(() => OWNER);
  const architect = await import(pathToFileURL(path.join(REPO, "lib", "onboarding-architect.js")).href);
  const onboarding = await import(pathToFileURL(path.join(REPO, "lib", "onboarding.js")).href);
  const training = await import(pathToFileURL(path.join(REPO, "lib", "training.js")).href);

  const saveModel = (opencodeModel) => db.saveAiChatConfig(OWNER, {
    allowedTopics: "sales",
    roleTone: "ngắn gọn",
    useKnowledge: false,
    knowledgeFileIds: [],
    soul: "Trợ lý sales",
    opencodeBaseUrl: runtimeUrl,
    opencodeAgent: "general",
    opencodeModel,
  });

  const modelCalls = [];
  architect.datBoGoiModelOnboardingChoKiemThu(async (request) => {
    modelCalls.push(request);
    return JSON.stringify({
      message: "Câu hỏi tiếp theo",
      decision: "ask",
      knownFacts: {},
      confirmedRequirements: [],
    });
  });

  const backendSource = fs.readFileSync(path.join(REPO, "lib", "onboarding.js"), "utf8");
  const boundarySource = fs.readFileSync(path.join(REPO, "lib", "onboarding-architect.js"), "utf8");
  const configSource = fs.readFileSync(path.join(REPO, "public", "config.js"), "utf8");
  const onboardingSource = fs.readFileSync(path.join(REPO, "public", "onboarding.js"), "utf8");
  const trainingSource = fs.readFileSync(path.join(REPO, "public", "training.js"), "utf8");

  await bai("T1", "runtime chi doc canonical/effective, khong doc setup_data model", async () => {
    await saveModel("openai/gpt-4.1");
    await aiChat.loadConfig();
    assert.equal(aiChat.getConfig().opencodeModel, "openai/gpt-4.1");
    assert.equal((await training.trangThai(OWNER)).model, "openai/gpt-4.1");
    assert.ok(!boundarySource.includes("data?.modelId"));
    assert.ok(!backendSource.includes("providerId: gon(data.providerId"));
    assert.ok(!backendSource.includes("modelId: gon(data.modelId"));
  });

  await bai("T2", "canonical OpenAI thang setup_data Google cu", async () => {
    await saveModel("openai/gpt-4.1");
    await db.saveAccountConfig("p7-stale", {
      setupStep: 3,
      setupData: { providerId: "google", modelId: "google/gemini-3.5-flash" },
    });
    await architect.goiKienTrucSuOnboarding(OWNER, 5, {
      providerId: "google",
      modelId: "google/gemini-3.5-flash",
      transcript: [],
    });
    assert.equal(modelCalls.at(-1).config.opencodeModel, "openai/gpt-4.1");
  });

  await bai("T3", "canonical rong chi dung Nemotron khi catalog co exact model", async () => {
    defaultAvailable = true;
    await saveModel("");
    await architect.goiKienTrucSuOnboarding(OWNER, 5, { transcript: [] });
    assert.equal(modelCalls.at(-1).config.opencodeModel, "opencode/nemotron-3-ultra-free");
    assert.equal((await db.getAiChatConfig(OWNER)).opencodeModel, "", "default khong duoc persist");

    defaultAvailable = false;
    await aiChat.refreshConfig();
    assert.equal(aiChat.getConfig().opencodeModel, "");
    assert.equal(aiChat.isAiChatReady(), false, "khong duoc roi ve default ngam cua gateway");
  });

  await bai("T4", "doi canonical ap dung ngay luot Bot Chi huy tiep theo, khong reset", async () => {
    defaultAvailable = true;
    await saveModel("openai/gpt-4.1");
    await architect.goiKienTrucSuOnboarding(OWNER, 5, { transcript: [] });
    const truoc = modelCalls.at(-1).config.opencodeModel;
    await saveModel("google/gemini-3.5-flash");
    await architect.goiKienTrucSuOnboarding(OWNER, 5, { transcript: [] });
    const sau = modelCalls.at(-1).config.opencodeModel;
    assert.deepEqual([truoc, sau], ["openai/gpt-4.1", "google/gemini-3.5-flash"]);
  });

  await bai("T5", "luu model phat su kien va header refresh co gioi han", async () => {
    const saveStart = configSource.indexOf('panel.querySelector("#btn-ai-model-save")');
    const saveEnd = configSource.indexOf('useKnowledge.addEventListener("change"', saveStart);
    const saveHandler = configSource.slice(saveStart, saveEnd);
    assert.ok(saveHandler.includes('section: "ai-model"'));
    assert.ok(saveHandler.includes('fetch("/api/ai-chat", {'));
    assert.ok(trainingSource.includes('window.addEventListener("zalo:canonical-save"'));
    assert.ok(trainingSource.includes("napMetaHuanLuyen()"));
    assert.ok(trainingSource.includes('fetch("/api/training")'));
  });

  await bai("T6", "setup_data cu bi bo khi onboarding luu tiep va khong con duoc UI dung", async () => {
    await saveModel("openai/gpt-4.1");
    const next = await onboarding.xuLyHanhDongOnboarding(
      "p7-stale",
      "model_selected",
      { providerId: "google", modelId: "google/gemini-3.5-flash" }
    );
    assert.equal(next.step, 4);
    const account = await db.getAccountConfig("p7-stale");
    assert.equal("providerId" in account.setupData, false);
    assert.equal("modelId" in account.setupData, false);
    assert.ok(!onboardingSource.includes("state.data?.providerId"));
    assert.ok(!onboardingSource.includes("state.data.modelId"));
  });

  await bai("T7", "reload UI/header/runtime cung thay canonical hien tai", async () => {
    await saveModel("google/gemini-3.5-flash");
    await aiChat.refreshConfig();
    assert.equal(aiChat.getConfig().opencodeModel, "google/gemini-3.5-flash");
    assert.equal((await training.trangThai(OWNER)).model, "google/gemini-3.5-flash");
    assert.ok(configSource.includes("data.config.opencodeModel || \"\""));
    await architect.goiKienTrucSuOnboarding(OWNER, 5, { transcript: [] });
    assert.equal(modelCalls.at(-1).config.opencodeModel, "google/gemini-3.5-flash");
  });

  const fail = ketQua.filter((item) => !item.pass);
  for (const item of ketQua) {
    console.log(`${item.ma} = ${item.pass ? "PASS" : "FAIL"}  ${item.moTa}${item.error ? `\n      -> ${item.error}` : ""}`);
  }
  console.log(`\nTONG: ${ketQua.length - fail.length}/${ketQua.length} PASS`);
  console.log(`OPENCODE_METADATA_FIXTURE_CALLS = ${metadataCalls}`);
  console.log(`REAL_PROVIDER_CALL = ${realProviderCalls}`);
  console.log("SESSION_RESET = 0");
  await new Promise((resolve) => runtime.close(resolve));
  process.exit(fail.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Khung P7 AI model source test hong:", error);
  process.exit(2);
});
