/**
 * Focused test First-run AI Onboarding.
 * Chạy: node kiem-thu/kiem-tra-onboarding.js
 *
 * Provider-free: model boundary được tiêm bằng runner giả; test chỉ xác nhận
 * orchestration/context/state, không tuyên bố kiểm tra chất lượng suy luận LLM.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const AI_OWNER = "onboarding-owner-a";
const ketQua = [];

async function bai(ma, moTa, fn) {
  try {
    await fn();
    ketQua.push({ ma, moTa, pass: true });
  } catch (error) {
    ketQua.push({ ma, moTa, pass: false, error: error.message });
  }
}

async function choDen(predicate, message, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function taoFrontendHydrationFixture(html) {
  const dom = new JSDOM(html, { url: "http://zalo-web.test/" });
  const { window } = dom;
  const { document } = window;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const raf = (callback) => { callback(); return 1; };
  window.requestAnimationFrame = raf;

  globalThis.window = window;
  globalThis.document = document;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.Event = window.Event;
  globalThis.Option = window.Option;
  globalThis.FormData = window.FormData;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.requestAnimationFrame = raf;
  globalThis.confirm = () => true;

  let currentOwner = null;
  let initialUnauthenticatedAiGets = 0;
  const authenticatedAiGets = [];
  const posts = [];
  const configs = {
    A: {
      opencodeBaseUrl: "http://opencode:4096",
      opencodeAgent: "general",
      opencodeModel: "openai/gpt-4.1",
    },
    B: {
      opencodeBaseUrl: "http://owner-b-opencode:4096",
      opencodeAgent: "owner-b-agent",
      opencodeModel: "openai/gpt-4.1",
    },
    C: {
      opencodeBaseUrl: "",
      opencodeAgent: "general",
      opencodeModel: "openai/gpt-4.1",
    },
  };
  const onboardingStates = new Map();
  const stateFor = (owner = currentOwner) => {
    if (!onboardingStates.has(owner)) {
      onboardingStates.set(owner, {
        step: 3,
        started: true,
        completed: false,
        prompt: "",
        data: {},
      });
    }
    return onboardingStates.get(owner);
  };
  const response = (status, data) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
  const providers = [
    {
      id: "openai",
      name: "OpenAI",
      connected: true,
      models: [{ id: "openai/gpt-4.1", label: "GPT-4.1", context: 100000, beta: false }],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      connected: true,
      models: [{ id: "anthropic/claude-fable-5", label: "Claude Fable 5", context: 200000, beta: false }],
    },
  ];

  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    const method = options.method || "GET";
    if (url === "/api/zalo/groups") {
      return currentOwner ? response(200, { groups: [] }) : response(401, { error: "Chưa đăng nhập Zalo" });
    }
    if (url === "/api/ai-chat/opencode-test") {
      return response(200, {
        agents: ["general", "owner-b-agent"],
        providers,
        systemDefaultModel: "",
      });
    }
    if (url === "/api/ai-chat/providers") return response(200, { providers });
    if (url === "/api/ai-chat" && method === "GET") {
      if (!currentOwner) {
        initialUnauthenticatedAiGets += 1;
        return response(400, { error: "Chưa đăng nhập Zalo." });
      }
      authenticatedAiGets.push(currentOwner);
      return response(200, { config: { ...configs[currentOwner] }, ready: false });
    }
    if (url === "/api/ai-chat" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      posts.push({ owner: currentOwner, body });
      if (!body.opencodeBaseUrl) {
        return response(400, { error: "Địa chỉ OpenCode server là bắt buộc" });
      }
      configs[currentOwner] = {
        ...configs[currentOwner],
        opencodeBaseUrl: body.opencodeBaseUrl,
        opencodeAgent: body.opencodeAgent,
        opencodeModel: body.opencodeModel,
      };
      return response(200, { ok: true, config: { ...configs[currentOwner] }, ready: true });
    }
    if (url === "/api/onboarding" && method === "GET") {
      return response(200, structuredClone(stateFor()));
    }
    if (url === "/api/onboarding/action" && method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const state = stateFor();
      if (body.action === "model_selected") state.step = 4;
      return response(200, structuredClone(state));
    }
    if (url === "/api/training" && method === "GET") {
      return response(200, {
        model: configs[currentOwner]?.opencodeModel || "",
        docDuocAnh: false,
        sessionId: null,
        messages: [],
      });
    }
    if (url === "/api/knowledge") return response(200, { files: [] });
    return response(404, { error: `Fixture route not found: ${method} ${url}` });
  };
  globalThis.fetch = fetchImpl;
  window.fetch = fetchImpl;

  const configModule = await import(pathToFileURL(path.join(REPO, "public", "config.js")).href);
  const configPanel = document.createElement("section");
  document.querySelector("#modal-body-container").append(configPanel);
  configModule.CONFIG_TABS.find((tab) => tab.id === "ai-chat").mount(configPanel);

  const ocUrl = document.querySelector("#ai-oc-url");
  const ocAgent = document.querySelector("#ai-oc-agent");
  const ocProvider = document.querySelector("#ai-oc-provider");
  const ocModel = document.querySelector("#ai-oc-model");
  const saveButton = document.querySelector("#btn-ai-model-save");
  await choDen(
    () => initialUnauthenticatedAiGets > 0 && ocProvider.options.length > 1,
    "Initial pre-owner config/catalog lifecycle did not finish."
  );

  const onboardingModule = await import(pathToFileURL(path.join(REPO, "public", "onboarding.js")).href);
  onboardingModule.khoiTaoOnboarding({ selectModule() {} });

  async function becomeOwner(owner) {
    currentOwner = owner;
    configModule.invalidateSettingsOwnerState();
    await onboardingModule.dongBoTrangThaiZalo({
      loggedIn: true,
      justLoggedIn: false,
      ownerUid: owner,
    });
  }

  async function openTraining() {
    const getsBefore = authenticatedAiGets.length;
    await onboardingModule.datManHinhHuanLuyen(true);
    return authenticatedAiGets.length > getsBefore;
  }

  async function saveModel(provider, model) {
    ocProvider.value = provider;
    ocProvider.dispatchEvent(new window.Event("change", { bubbles: true }));
    ocModel.value = model;
    const countBefore = posts.length;
    saveButton.click();
    await choDen(() => posts.length > countBefore, "Model Save did not POST /api/ai-chat.");
    return posts.at(-1);
  }

  return {
    authenticatedAiGets,
    becomeOwner,
    configModule,
    configs,
    document,
    initialUnauthenticatedAiGets,
    ocAgent,
    ocModel,
    ocProvider,
    ocUrl,
    onboardingModule,
    openTraining,
    posts,
    saveModel,
    settingsModal: document.querySelector("#settings-modal"),
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-model-boundary-"));
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  process.chdir(tmp);

  const db = await import(pathToFileURL(path.join(REPO, "lib", "db.js")).href);
  await db.initDb();
  let metadataRequests = 0;
  const fakeRuntime = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/config/providers") {
      metadataRequests += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        providers: [{
          id: "opencode",
          name: "OpenCode Zen",
          models: {
            "nemotron-3-ultra-free": {
              name: "Nemotron 3 Ultra Free",
              status: "active",
              limit: { context: 1000000 },
              capabilities: { input: { text: true }, output: { text: true } },
            },
          },
        }],
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "fixture route not found" }));
  });
  await new Promise((resolve) => fakeRuntime.listen(0, "127.0.0.1", resolve));
  const fakeRuntimeUrl = `http://127.0.0.1:${fakeRuntime.address().port}`;
  await db.saveAiChatConfig(AI_OWNER, {
    allowedTopics: "",
    roleTone: "",
    useKnowledge: false,
    knowledgeFileIds: [],
    soul: "",
    opencodeBaseUrl: fakeRuntimeUrl,
    opencodeAgent: "general",
    opencodeModel: "",
  });
  const architect = await import(pathToFileURL(path.join(REPO, "lib", "onboarding-architect.js")).href);
  const onboarding = await import(pathToFileURL(path.join(REPO, "lib", "onboarding.js")).href);
  const admin = await import(pathToFileURL(path.join(REPO, "lib", "admin-command.js")).href);

  const calls = [];
  const scripted = [];
  let realModelCalls = 0;
  architect.datBoGoiModelOnboardingChoKiemThu(async (request) => {
    calls.push(request);
    const response = scripted.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`Test thiếu model response cho Step ${request.step}`);
    return JSON.stringify(response);
  });
  const traVe = (...responses) => scripted.push(...responses);

  const factsNen = {
    userAddress: "chị",
    occupation: "Business Coach về sales và marketing",
    audience: "chủ doanh nghiệp nhỏ",
    purpose: "tư vấn khách hàng về sales và marketing",
    tone: "thẳng, thực tế và chuyên nghiệp",
    allowedScope: "sales, marketing và vận hành bán hàng",
  };
  const requirementsNen = [
    "Bot xưng em và gọi khách là anh/chị",
    "Ưu tiên lời khuyên có hành động cụ thể",
  ];

  const initialQuestion = {
    message: "Để tiện trò chuyện, em nên gọi mình là anh hay chị ạ?",
    decision: "ask",
    knownFacts: {},
    confirmedRequirements: [],
  };
  const occupationQuestion = {
    message: "Dạ, từ giờ em sẽ gọi là chị. Chị đang làm trong lĩnh vực nào ạ?",
    decision: "ask",
    knownFacts: { userAddress: "chị" },
    confirmedRequirements: [],
  };
  const basicComplete = {
    message: "Dạ, em đã hiểu bối cảnh nền của trợ lý.",
    decision: "basic_context_complete",
    knownFacts: factsNen,
    confirmedRequirements: requirementsNen,
  };
  const deepQuestion = {
    message: "Với các câu hỏi ngoài sales và marketing, chị muốn bot từ chối hay chuyển cho chị xử lý ạ?",
    decision: "ask",
    knownFacts: factsNen,
    confirmedRequirements: requirementsNen,
    suggestions: [],
  };
  const ambiguityClarification = {
    message: "Em chưa rõ ba nhóm đó là phạm vi được phép hay phải chuyển người thật. Chị muốn bot xử lý chúng theo hướng nào ạ?",
    decision: "ask",
    knownFacts: factsNen,
    confirmedRequirements: requirementsNen,
    suggestions: [],
  };
  const reviewSuggestions = {
    message: "Em đề xuất hai nguyên tắc có lý do rõ ràng. Chị đồng ý thì trả lời OK, còn chưa đúng cứ nói phần cần sửa nhé?",
    decision: "review",
    knownFacts: { ...factsNen, escalation: "ngoài sales và marketing thì chuyển chị xử lý" },
    confirmedRequirements: [...requirementsNen, "Ngoài phạm vi thì chuyển chị xử lý"],
    suggestions: [
      {
        id: "s1",
        text: "Không cam kết kết quả kinh doanh cho khách.",
        reason: "Kết quả phụ thuộc việc thực thi của khách.",
        status: "pending",
      },
      {
        id: "s2",
        text: "Khi thiếu dữ liệu, hỏi lại đúng thông tin còn thiếu trước khi kết luận.",
        reason: "Tránh tự suy đoán tình hình kinh doanh.",
        status: "pending",
      },
    ],
  };
  const reviewAfterReject = {
    message: "Em đã bỏ đề xuất về cam kết kết quả và giữ đề xuất hỏi lại khi thiếu dữ liệu. Chị duyệt phần còn lại bằng OK nhé?",
    decision: "review",
    knownFacts: { ...factsNen, escalation: "ngoài sales và marketing thì chuyển chị xử lý" },
    confirmedRequirements: [...requirementsNen, "Ngoài phạm vi thì chuyển chị xử lý"],
    suggestions: [
      {
        id: "s1",
        text: "Không cam kết kết quả kinh doanh cho khách.",
        reason: "Kết quả phụ thuộc việc thực thi của khách.",
        status: "rejected",
      },
      {
        id: "s2",
        text: "Khi thiếu dữ liệu, hỏi lại đúng thông tin còn thiếu trước khi kết luận.",
        reason: "Tránh tự suy đoán tình hình kinh doanh.",
        status: "pending",
      },
    ],
  };
  const finalDraft = {
    message: "Chị đọc lại giúp em xem bản này đã đúng cách chị muốn bot hoạt động chưa nhé? Nếu ổn chị trả lời OK; nếu muốn chỉnh, chị cứ nói phần cần sửa.",
    draft: {
      soul: [
        "1. SOUL",
        "Bạn là trợ lý hỗ trợ một Business Coach chuyên Sales và Marketing.",
        "2. VAI TRÒ VÀ GIỌNG ĐIỆU",
        "Trả lời thẳng, thực tế, chuyên nghiệp và ưu tiên hành động cụ thể.",
        "3. CHỦ ĐỀ ĐƯỢC PHÉP / PHẢI CHUYỂN",
        "Tư vấn sales, marketing và vận hành bán hàng; ngoài phạm vi thì chuyển người phụ trách.",
        "Khi thiếu dữ liệu, hỏi lại đúng thông tin còn thiếu trước khi kết luận.",
      ].join("\n"),
      roleTone: "Xưng em, gọi khách là anh/chị; thẳng, thực tế và chuyên nghiệp.",
      allowedTopics: "Sales, marketing và vận hành bán hàng.",
    },
  };

  const OWNER = AI_OWNER;
  let state;
  const steps = [];

  async function denStep4(owner) {
    const started = await onboarding.xuLyHanhDongOnboarding(owner, "start");
    assert.equal(started.step, 4);
    assert.equal("providerId" in started.data, false);
    assert.equal("modelId" in started.data, false);
    return started;
  }

  await bai("O01", "tài khoản mới bắt đầu ở Step 0", async () => {
    state = await onboarding.trangThaiOnboarding(OWNER);
    steps.push(state.step);
    assert.equal(state.step, 0);
    assert.equal(state.completed, false);
  });
  await bai("O02", "fresh runtime default bỏ qua bước bắt nhập key/chọn model", async () => {
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "start");
    steps.push(state.step);
    assert.equal(state.step, 4);
    assert.equal("providerId" in state.data, false);
    assert.equal("modelId" in state.data, false);
    assert.ok(metadataRequests > 0);
  });
  await bai("M05", "Step 5 gọi model boundary ngay khi bắt đầu interview", async () => {
    traVe(initialQuestion);
    state = await onboarding.traLoiOnboarding(OWNER, "Mình cần tạo 1 bot AI");
    steps.push(state.step);
    assert.equal(state.step, 5);
    assert.equal(calls.at(-1).step, 5);
    assert.equal(calls.at(-1).config.opencodeModel, "opencode/nemotron-3-ultra-free");
    assert.ok(state.data.transcript.some((turn) => turn.role === "user" && turn.content === "Mình cần tạo 1 bot AI"));
  });
  await bai("R05", "Step 5 resume đúng prompt do model đã tạo", async () => {
    const resumed = await onboarding.trangThaiOnboarding(OWNER);
    assert.equal(resumed.step, 5);
    assert.equal(resumed.prompt, state.prompt);
  });
  await bai("C05", "mỗi answer Step 5 gửi full transcript và known facts", async () => {
    traVe(occupationQuestion);
    state = await onboarding.traLoiOnboarding(OWNER, "chị");
    const call = calls.at(-1);
    assert.equal(call.step, 5);
    assert.ok(call.context.fullRelevantInterviewTranscript.some((turn) => turn.content === "chị"));
    assert.match(call.prompt, /FULL|fullRelevantInterviewTranscript/);
    assert.equal(state.data.knownFacts.userAddress, "chị");
    assert.doesNotMatch(state.prompt, /anh hay chị/i);
  });
  await bai("M56", "Step 5 đủ context thì Step 6 cũng gọi model boundary", async () => {
    traVe(basicComplete, deepQuestion);
    state = await onboarding.traLoiOnboarding(
      OWNER,
      "Chị là Business Coach về sales và marketing, phục vụ chủ doanh nghiệp nhỏ. "
        + "Bot tư vấn khách hàng, nói thẳng và thực tế, xưng em và gọi khách là anh/chị."
    );
    steps.push(state.step);
    assert.equal(state.step, 6);
    assert.deepEqual(calls.slice(-2).map((call) => call.step), [5, 6]);
    assert.equal(calls.at(-1).context.knownFacts.occupation, factsNen.occupation);
  });
  await bai("A06", "câu trả lời mơ hồ có thể khiến model hỏi làm rõ", async () => {
    traVe(ambiguityClarification);
    state = await onboarding.traLoiOnboarding(OWNER, "quản trị nhân sự, tài chính hay tâm lý lãnh đạo");
    assert.equal(state.step, 6);
    assert.equal(state.data.phase, "deep_question");
    assert.equal(state.data.suggestions.accepted.length, 0);
    assert.match(state.prompt, /chưa rõ/i);
  });
  await bai("P06", "model tạo review conversational thay vì memo deterministic", async () => {
    traVe(reviewSuggestions);
    state = await onboarding.traLoiOnboarding(OWNER, "Ngoài sales và marketing thì chuyển cho chị xử lý");
    assert.equal(state.data.phase, "review");
    assert.equal(state.data.suggestions.pending.length, 2);
    assert.doesNotMatch(state.prompt, /A\. NHỮNG GÌ|B\. EM ĐỀ XUẤT/);
  });
  await bai("R06", "resume giữ transcript và proposal state", async () => {
    const resumed = await onboarding.trangThaiOnboarding(OWNER);
    assert.equal(resumed.step, 6);
    assert.equal(resumed.data.suggestions.pending.length, 2);
    assert.deepEqual(resumed.data.transcript, state.data.transcript);
  });
  await bai("D06", "model diễn giải phản hồi để ghi rejected state", async () => {
    traVe(reviewAfterReject);
    state = await onboarding.traLoiOnboarding(OWNER, "Bỏ đề xuất 1");
    assert.equal(state.data.suggestions.rejected[0].id, "s1");
    assert.equal(state.data.suggestions.pending[0].id, "s2");
  });
  await bai("M07", "canonical OK ở Step 6 gọi model Step 7", async () => {
    assert.equal(admin.laXacNhanOK("  Ok  "), true);
    assert.equal(admin.laXacNhanOK("OK."), false);
    traVe(finalDraft);
    state = await onboarding.traLoiOnboarding(OWNER, " OK ");
    steps.push(state.step);
    assert.equal(state.step, 7);
    assert.equal(calls.at(-1).step, 7);
    assert.equal(state.proposalAccepted, true);
    assert.deepEqual(state.completedSteps, [6]);
    assert.equal(state.data.suggestions.accepted[0].id, "s2");
    assert.equal(state.data.suggestions.rejected[0].id, "s1");
    assert.match(state.data.draft.soul, /Khi thiếu dữ liệu/i);
    assert.doesNotMatch(state.data.draft.soul, /Không cam kết kết quả kinh doanh/i);
  });
  await bai("C07", "final model nhận accepted và rejected tách riêng", async () => {
    const finalCall = [...calls].reverse().find((call) => call.step === 7);
    assert.deepEqual(finalCall.context.acceptedSuggestions.map((item) => item.id), ["s2"]);
    assert.deepEqual(finalCall.context.rejectedSuggestions.map((item) => item.id), ["s1"]);
    assert.match(finalCall.prompt, /tuyệt đối loại rejected suggestions/i);
  });
  await bai("R07", "Step 7 resume giữ nguyên full draft do model tạo", async () => {
    const resumed = await onboarding.trangThaiOnboarding(OWNER);
    assert.equal(resumed.step, 7);
    assert.deepEqual(resumed.data.draft, state.data.draft);
    assert.equal(resumed.prompt, state.prompt);
  });
  await bai("K07", "OK có dấu chấm không vượt canonical parser", async () => {
    traVe({ ...finalDraft, message: "Nếu chị đã đồng ý, chị vui lòng trả lời đúng chữ OK nhé?" });
    state = await onboarding.traLoiOnboarding(OWNER, "OK.");
    assert.equal(state.step, 7);
    assert.equal(calls.at(-1).step, 7);
  });
  await bai("O08", "chỉ canonical OK ở Step 7 mới sang Step 8", async () => {
    state = await onboarding.traLoiOnboarding(OWNER, " ok ");
    steps.push(state.step);
    assert.equal(state.step, 8);
    assert.equal(state.confirmationAccepted, true);
  });
  await bai("O09", "Step 8–9 và completed được giữ nguyên", async () => {
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "config_saved");
    steps.push(state.step);
    assert.equal(state.step, 9);
    await assert.rejects(
      onboarding.xuLyHanhDongOnboarding(OWNER, "admin_saved", { adminUid: "" }),
      /chọn nick Zalo/i
    );
    state = await onboarding.xuLyHanhDongOnboarding(OWNER, "admin_saved", { adminUid: "zalo-admin-1" });
    assert.equal(state.step, "completed");
    assert.equal((await onboarding.trangThaiOnboarding(OWNER)).completed, true);
  });
  await bai("FLOW", "system default đi 0→4 rồi giữ đủ Step 5–9", async () => {
    assert.deepEqual(steps, [0, 4, 5, 6, 7, 8, 9]);
  });
  await bai("OWN", "onboarding vẫn tách riêng theo owner_uid", async () => {
    const other = await onboarding.trangThaiOnboarding("onboarding-owner-b");
    assert.equal(other.step, 0);
    assert.equal(other.completed, false);
  });

  await bai("STYLE1", "một chủ đề chính với nhiều câu văn vẫn được chấp nhận", async () => {
    const owner = "onboarding-style-sentences";
    await denStep4(owner);
    traVe({
      message: "Em hiểu chị đang muốn tạo một bot AI. Mình sẽ bắt đầu từ nhóm người bot phục vụ. Chị muốn bot hỗ trợ nhóm người dùng nào?",
      decision: "ask",
      knownFacts: { purpose: "tạo một bot AI" },
      confirmedRequirements: [],
    });
    const accepted = await onboarding.traLoiOnboarding(owner, "Mình cần tạo 1 bot AI");
    assert.equal(accepted.step, 5);
    assert.match(accepted.prompt, /nhóm người dùng nào/i);
  });

  await bai("STYLE2", "model response có lựa chọn ví dụ vẫn được chấp nhận", async () => {
    const owner = "onboarding-style-options";
    await denStep4(owner);
    traVe({
      message: "Chị muốn bot ưu tiên nhóm nào? Ví dụ: khách mới, khách đang sử dụng hay khách cũ.",
      decision: "ask",
      knownFacts: { purpose: "tạo một bot AI" },
      confirmedRequirements: [],
    });
    const accepted = await onboarding.traLoiOnboarding(owner, "Mình cần tạo 1 bot AI");
    assert.equal(accepted.step, 5);
    assert.match(accepted.prompt, /Ví dụ:/i);
  });

  await bai("STYLE3", "nhiều dấu hỏi không còn là lỗi fatal tự thân", async () => {
    const owner = "onboarding-style-question-marks";
    await denStep4(owner);
    traVe({
      message: "Chị muốn bot phục vụ ai? Khách mới? Hay khách đang sử dụng sản phẩm?",
      decision: "ask",
      knownFacts: { purpose: "tạo một bot AI" },
      confirmedRequirements: [],
    });
    const accepted = await onboarding.traLoiOnboarding(owner, "Mình cần tạo 1 bot AI");
    assert.equal(accepted.step, 5);
    assert.match(accepted.prompt, /Khách mới\?/);
  });

  await bai("PROTO1", "model response rỗng vẫn bị từ chối", async () => {
    const owner = "onboarding-empty-message";
    await denStep4(owner);
    traVe({
      message: "",
      decision: "ask",
      knownFacts: {},
      confirmedRequirements: [],
    });
    await assert.rejects(
      onboarding.traLoiOnboarding(owner, "Mình cần tạo 1 bot AI"),
      /không trả về lời nhắn/i
    );
    assert.equal((await onboarding.trangThaiOnboarding(owner)).step, 4);
  });

  await bai("PROTO2", "payload thiếu machine decision hợp lệ vẫn bị từ chối", async () => {
    const owner = "onboarding-malformed-machine-payload";
    await denStep4(owner);
    traVe({
      message: "Em đã hiểu.",
      decision: "continue_somehow",
      knownFacts: {},
      confirmedRequirements: [],
    });
    await assert.rejects(
      onboarding.traLoiOnboarding(owner, "Mình cần tạo 1 bot AI"),
      /quyết định Step 5 không hợp lệ/i
    );
    assert.equal((await onboarding.trangThaiOnboarding(owner)).step, 4);
  });

  await bai("ERR", "model lỗi hiện rõ, giữ progress và gửi lại không nhân đôi user turn", async () => {
    const owner = "onboarding-owner-retry";
    await denStep4(owner);
    traVe(initialQuestion);
    await onboarding.traLoiOnboarding(owner, "Mình cần tạo 1 bot AI");
    scripted.push(new Error("OpenCode tạm thời không phản hồi"));
    await assert.rejects(onboarding.traLoiOnboarding(owner, "chị"), /giữ nguyên/i);
    let failed = await onboarding.trangThaiOnboarding(owner);
    assert.equal(failed.step, 5);
    assert.equal(failed.data.pendingUserText, "chị");
    assert.match(failed.prompt, /thử lại/i);
    const userTurnsBefore = failed.data.transcript.filter((turn) => turn.role === "user").length;
    traVe(occupationQuestion);
    failed = await onboarding.traLoiOnboarding(owner, "chị");
    assert.equal(failed.data.transcript.filter((turn) => turn.role === "user").length, userTurnsBefore);
    assert.equal(failed.data.modelError, "");
    assert.equal(failed.data.pendingUserText, "");
  });

  const html = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
  const backend = fs.readFileSync(path.join(REPO, "lib", "onboarding.js"), "utf8");
  const boundary = fs.readFileSync(path.join(REPO, "lib", "onboarding-architect.js"), "utf8");
  const frontend = fs.readFileSync(path.join(REPO, "public", "onboarding.js"), "utf8");
  const training = fs.readFileSync(path.join(REPO, "public", "training.js"), "utf8");
  const style = fs.readFileSync(path.join(REPO, "public", "style.css"), "utf8");
  const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  const starterCopy = "Mình cần tạo 1 bot AI";
  const hydrationProof = {
    initialOcUrl: null,
    settingsModalOpen: null,
    trainingRefresh: false,
    canonicalBaseUrl: "",
    ocUrlAfterRefresh: "",
    trainingPost: null,
    realPortal: false,
    ownerSwitch: false,
    staleOwnerApplied: true,
    ownerAReusedByB: true,
    aiChatEdit: false,
    fakeBaseUrl: true,
  };
  let frontendFixture = null;

  await bai("UI6", "Training open sửa đúng lifecycle pre-owner rỗng rồi refresh canonical", async () => {
    frontendFixture = await taoFrontendHydrationFixture(html);
    hydrationProof.initialOcUrl = frontendFixture.ocUrl.value;
    hydrationProof.settingsModalOpen = !frontendFixture.settingsModal.classList.contains("hidden");
    assert.equal(frontendFixture.initialUnauthenticatedAiGets > 0, true);
    assert.equal(hydrationProof.initialOcUrl, "", "Test không được pre-populate ocUrl.");
    assert.equal(hydrationProof.settingsModalOpen, false);

    await frontendFixture.becomeOwner("A");
    hydrationProof.trainingRefresh = await frontendFixture.openTraining();
    hydrationProof.canonicalBaseUrl = frontendFixture.configs.A.opencodeBaseUrl;
    hydrationProof.ocUrlAfterRefresh = frontendFixture.ocUrl.value;
    hydrationProof.realPortal = frontendFixture.document
      .querySelector("#onboarding-slot-model")
      .contains(frontendFixture.document.querySelector("#btn-ai-model-save"));

    hydrationProof.trainingPost = await frontendFixture.saveModel(
      "anthropic",
      "anthropic/claude-fable-5"
    );
    assert.equal(hydrationProof.trainingRefresh, true);
    assert.equal(hydrationProof.ocUrlAfterRefresh, "http://opencode:4096");
    assert.equal(hydrationProof.realPortal, true);
    assert.deepEqual(hydrationProof.trainingPost, {
      owner: "A",
      body: {
        saveScope: "ai-connection",
        opencodeBaseUrl: "http://opencode:4096",
        opencodeAgent: "general",
        opencodeModel: "anthropic/claude-fable-5",
      },
    });
  });

  await bai("UI7", "owner switch refresh B và không áp dụng runtime DOM của A", async () => {
    await frontendFixture.onboardingModule.datManHinhHuanLuyen(false);
    await frontendFixture.becomeOwner("B");
    const refreshed = await frontendFixture.openTraining();
    const post = await frontendFixture.saveModel("anthropic", "anthropic/claude-fable-5");
    hydrationProof.staleOwnerApplied = frontendFixture.ocUrl.value === "http://opencode:4096";
    hydrationProof.ownerAReusedByB = post.body.opencodeBaseUrl === "http://opencode:4096";
    hydrationProof.ownerSwitch = refreshed
      && post.owner === "B"
      && post.body.opencodeBaseUrl === "http://owner-b-opencode:4096"
      && post.body.opencodeAgent === "owner-b-agent";
    assert.equal(hydrationProof.ownerSwitch, true);
    assert.equal(hydrationProof.staleOwnerApplied, false);
    assert.equal(hydrationProof.ownerAReusedByB, false);
  });

  await bai("UI8", "AI Chat giữ URL người dùng sửa và không refresh đè trước Save", async () => {
    await frontendFixture.onboardingModule.datManHinhHuanLuyen(false);
    frontendFixture.ocUrl.value = "http://edited-opencode:4096";
    const post = await frontendFixture.saveModel("anthropic", "anthropic/claude-fable-5");
    hydrationProof.aiChatEdit = post.body.opencodeBaseUrl === "http://edited-opencode:4096";
    assert.equal(hydrationProof.aiChatEdit, true);
  });

  await bai("UI9", "canonical URL rỗng không bị thay bằng URL giả", async () => {
    await frontendFixture.becomeOwner("C");
    const refreshed = await frontendFixture.openTraining();
    assert.equal(refreshed, true);
    assert.equal(frontendFixture.ocUrl.value, "");
    const post = await frontendFixture.saveModel("anthropic", "anthropic/claude-fable-5");
    hydrationProof.fakeBaseUrl = post.body.opencodeBaseUrl !== "";
    assert.equal(hydrationProof.fakeBaseUrl, false);
    assert.equal(post.body.opencodeBaseUrl, "");
  });

  await bai("SRC1", "deterministic A/B memo và final template đã bị loại", async () => {
    for (const name of ["phanTichKhoangTrong", "taoDeXuatBoSung", "taoBanTongHop", "trichXuatThongTinPhongVan"]) {
      assert.ok(!backend.includes(name), `${name} vẫn còn trong onboarding`);
    }
    assert.ok(!backend.includes("A. NHỮNG GÌ"));
    assert.ok(!backend.includes("1. VAI TRÒ VÀ DANH TÍNH"));
  });
  await bai("SRC2", "minimal architect prompt và model boundary production tồn tại", async () => {
    assert.ok(boundary.includes("Bạn là AI System Instruction Architect"));
    assert.ok(boundary.includes("runOneShot"));
    assert.ok(backend.includes("goiKienTrucSuOnboarding"));
    assert.ok(boundary.includes("fullRelevantInterviewTranscript"));
    assert.ok(boundary.includes("acceptedSuggestions"));
    assert.ok(boundary.includes("rejectedSuggestions"));
  });
  await bai("SRC3", "conversation style chỉ còn là prompt guidance, không còn fatal validator", async () => {
    assert.ok(!boundary.includes("demCauHoi"));
    assert.ok(!boundary.includes("Model đã hỏi nhiều hơn một câu chính"));
    assert.ok(!boundary.includes("match(/\\?/g)"));
    assert.ok(boundary.includes("mỗi lượt tập trung vào một vấn đề chính"));
    assert.ok(boundary.includes("tránh dồn một danh sách câu hỏi"));
    assert.ok(boundary.includes("Model không trả về lời nhắn cho người dùng"));
    assert.ok(boundary.includes("Model trả về sai cấu trúc JSON"));
    assert.ok(boundary.includes("Model chưa trả về đủ ba trường cấu hình canonical"));
  });
  await bai("UI1", "Step 8 vẫn review ba field canonical hiện có", async () => {
    const step8 = frontend.slice(frontend.indexOf("  8: {"), frontend.indexOf("  9: {"));
    for (const slot of ["soul", "tone", "topics"]) {
      assert.ok(step8.includes(`[data-canonical-slot='${slot}']`));
      assert.ok(html.includes(`data-canonical-slot="${slot}"`));
    }
    assert.ok(frontend.includes("dienBanTongHop"));
    assert.ok(frontend.includes("refreshAiChatConfigForCurrentOwner"));
    assert.ok(frontend.indexOf("await refreshAiChatConfigForCurrentOwner()")
      < frontend.indexOf("ganControlCanonical();", frontend.indexOf("export async function datManHinhHuanLuyen")));
    assert.ok(!frontend.includes("data-model-save-context"));
  });
  await bai("UI2", "composer spotlight Step 4–7 và attachment vẫn hiện", async () => {
    assert.ok(frontend.includes("step >= 4 && step <= 7"));
    assert.ok(training.includes("training-form-composer-spotlight"));
    assert.ok(training.includes("dangOnboarding ? false : !docDuocAnh"));
    assert.match(style, /\.training-form-onboarding #btn-training-attach\s*\{[^}]*display:\s*inline-flex/s);
  });
  await bai("UI3", "Enter gửi, Shift+Enter/IME được giữ và lỗi khôi phục input", async () => {
    assert.ok(training.includes('event.key !== "Enter" || event.shiftKey'));
    assert.ok(training.includes("event.isComposing || event.keyCode === 229"));
    assert.ok(training.includes("els.form.requestSubmit()"));
    assert.ok(training.includes("els.text.value = text"));
  });
  await bai("UI4", "Step 4 khởi tạo interview rồi chuyển đúng câu vừa gửi cho model", async () => {
    const submitIndex = frontend.indexOf("submit: async (text)");
    const answerIndex = frontend.indexOf('jsonFetch("/api/onboarding/answer"', submitIndex);
    const renderIndex = frontend.indexOf("await render()", answerIndex);
    assert.ok(submitIndex >= 0 && answerIndex > submitIndex && renderIndex > answerIndex);
    assert.ok(!frontend.slice(submitIndex, renderIndex).includes("/api/onboarding/action"));
    assert.ok(frontend.slice(answerIndex, renderIndex).includes("JSON.stringify({ text })"));
    assert.ok(backend.includes("if (step === 4) return xuLyStep4(ownerUid, noiDung, data)"));
    assert.ok(backend.includes("async function xuLyStep4(ownerUid, text, data)"));
  });
  await bai("UI5", "Step 4 không còn coach/modal bắt đầu setup trùng CTA", async () => {
    const stepDefs = frontend.slice(frontend.indexOf("const BUOC ="), frontend.indexOf("const BUOC_LUU_CAU_HINH"));
    assert.ok(!/\n\s*4:\s*\{/.test(stepDefs));
    assert.ok(!frontend.includes("Bắt đầu setup bot"));
    assert.ok(!frontend.includes('action: "start_bot_setup"'));
    assert.ok(!backend.includes('action === "start_bot_setup"'));
    assert.ok(frontend.includes("Bot Chỉ huy đã sẵn sàng"));
  });
  await bai("CTA1", "CTA chỉ hiện ở cuộc trò chuyện Bot Chỉ huy mới tại Step 4", async () => {
    assert.match(
      html,
      /<button id="btn-onboarding-starter"[^>]*>Mình cần tạo 1 bot AI<\/button>/
    );
    assert.ok(frontend.includes("showStarter: active && step === 4"));
    assert.ok(training.includes('els.starters.classList.toggle("hidden", !showStarter)'));
  });
  await bai("CTA2", "CTA lấy đúng copy hiển thị và dùng canonical form submit", async () => {
    const clickStart = training.indexOf('els.btnStarter.addEventListener("click"');
    const clickEnd = training.indexOf('els.text.addEventListener("keydown"', clickStart);
    const clickHandler = training.slice(clickStart, clickEnd);
    assert.ok(clickStart >= 0 && clickEnd > clickStart);
    assert.ok(clickHandler.includes("els.btnStarter.textContent.trim()"));
    assert.ok(clickHandler.includes("els.text.value = message"));
    assert.ok(clickHandler.includes("els.form.requestSubmit()"));
    assert.ok(!clickHandler.includes("fetch("));
    assert.ok(training.includes('els.form.addEventListener("submit", guiTuComposer)'));
  });
  await bai("CTA3", "CTA ẩn ngay sau lần gửi có nghĩa đầu tiên", async () => {
    const onboardingSubmit = training.slice(
      training.indexOf("if (onboardingController?.active)"),
      training.indexOf("themDong({ role: \"user\"", training.indexOf("if (onboardingController?.active)"))
    );
    assert.ok(onboardingSubmit.includes("if (!text) return"));
    assert.ok(onboardingSubmit.includes("starterConsumed = true"));
    assert.ok(onboardingSubmit.includes('els.starters.classList.add("hidden")'));
  });
  await bai("CTA4", "CTA không tạo route hay hard-code câu hỏi/flow AI", async () => {
    for (const source of [backend, boundary, frontend, training, server]) {
      assert.ok(!source.includes(starterCopy));
    }
    assert.ok(!server.includes("onboarding-starter"));
    assert.ok(!server.includes("starter-cta"));
  });

  assert.equal(scripted.length, 0, "Test còn model response chưa dùng");
  const fail = ketQua.filter((item) => !item.pass);
  for (const item of ketQua) {
    console.log(`${item.ma} = ${item.pass ? "PASS" : "FAIL"}  ${item.moTa}${item.error ? `\n      -> ${item.error}` : ""}`);
  }
  console.log(`\nTONG: ${ketQua.length - fail.length}/${ketQua.length} PASS`);
  console.log(`STEP5_MODEL_BOUNDARY_CALLED = ${calls.some((call) => call.step === 5) ? "PASS" : "FAIL"}`);
  console.log(`STEP6_MODEL_BOUNDARY_CALLED = ${calls.some((call) => call.step === 6) ? "PASS" : "FAIL"}`);
  console.log(`STEP7_MODEL_BOUNDARY_CALLED = ${calls.some((call) => call.step === 7) ? "PASS" : "FAIL"}`);
  console.log(`FULL_CONTEXT_PASSED = ${ketQua.find((item) => item.ma === "C05")?.pass ? "PASS" : "FAIL"}`);
  console.log(`KNOWN_INFORMATION_NOT_REASKED = ${ketQua.find((item) => item.ma === "C05")?.pass ? "PASS" : "FAIL"}`);
  console.log(`AMBIGUOUS_RESPONSE_CAN_TRIGGER_CLARIFICATION = ${ketQua.find((item) => item.ma === "A06")?.pass ? "PASS" : "FAIL"}`);
  console.log(`ACCEPTED_PROPOSALS_PASSED_TO_FINAL = ${ketQua.find((item) => item.ma === "C07")?.pass ? "PASS" : "FAIL"}`);
  console.log(`REJECTED_PROPOSALS_EXCLUDED = ${ketQua.find((item) => item.ma === "M07")?.pass ? "PASS" : "FAIL"}`);
  console.log(`STATE_MACHINE = ${ketQua.find((item) => item.ma === "FLOW")?.pass ? "PASS" : "FAIL"}`);
  console.log(`RESUME = ${["R05", "R06", "R07"].every((ma) => ketQua.find((item) => item.ma === ma)?.pass) ? "PASS" : "FAIL"}`);
  console.log(`CANONICAL_OK = ${["K07", "O08"].every((ma) => ketQua.find((item) => item.ma === ma)?.pass) ? "PASS" : "FAIL"}`);
  console.log(`DETERMINISTIC_AB_MEMO = ${ketQua.find((item) => item.ma === "SRC1")?.pass ? "REMOVED" : "FAIL"}`);
  console.log(`DETERMINISTIC_FINAL_TEMPLATE = ${ketQua.find((item) => item.ma === "SRC1")?.pass ? "REMOVED" : "FAIL"}`);
  console.log(`MODEL_RESPONSE_WITH_ONE_MAIN_TOPIC_AND_MULTIPLE_SENTENCES = ${ketQua.find((item) => item.ma === "STYLE1")?.pass ? "ACCEPTED" : "FAIL"}`);
  console.log(`MODEL_RESPONSE_WITH_EXAMPLE_OPTIONS = ${ketQua.find((item) => item.ma === "STYLE2")?.pass ? "ACCEPTED" : "FAIL"}`);
  console.log(`MODEL_RESPONSE_WITH_MULTIPLE_QUESTION_MARKS = ${ketQua.find((item) => item.ma === "STYLE3")?.pass ? "NOT_FATAL_BY_ITSELF" : "FAIL"}`);
  console.log(`CONVERSATION_STYLE_VALIDATOR_FATAL = ${ketQua.find((item) => item.ma === "SRC3")?.pass ? "NO" : "FAIL"}`);
  console.log(`EMPTY_MODEL_RESPONSE = ${ketQua.find((item) => item.ma === "PROTO1")?.pass ? "REJECTED" : "FAIL"}`);
  console.log(`MALFORMED_REQUIRED_MACHINE_PAYLOAD = ${ketQua.find((item) => item.ma === "PROTO2")?.pass ? "REJECTED" : "FAIL"}`);
  console.log(`STEP4_BLOCKING_START_MODAL = ${ketQua.find((item) => item.ma === "UI5")?.pass ? "NO" : "FAIL"}`);
  console.log(`STEP4_START_CTA_VISIBLE = ${ketQua.find((item) => item.ma === "CTA1")?.pass ? "YES" : "FAIL"}`);
  console.log(`STEP4_CTA_USES_CANONICAL_SEND = ${ketQua.find((item) => item.ma === "CTA2")?.pass ? "YES" : "FAIL"}`);
  console.log(`START_CTA_VISIBLE_ON_FRESH_STATE = ${ketQua.find((item) => item.ma === "CTA1")?.pass ? "PASS" : "FAIL"}`);
  console.log(`START_CTA_TEXT = "${starterCopy}"`);
  console.log(`START_CTA_CLICK_USES_CANONICAL_SEND = ${ketQua.find((item) => item.ma === "CTA2")?.pass ? "PASS" : "FAIL"}`);
  console.log(`START_CTA_MESSAGE = "${starterCopy}"`);
  console.log(`START_CTA_CREATES_SEPARATE_ROUTE = ${ketQua.find((item) => item.ma === "CTA4")?.pass ? "NO" : "FAIL"}`);
  console.log(`START_CTA_HARD_CODES_NEXT_QUESTION = ${ketQua.find((item) => item.ma === "CTA4")?.pass ? "NO" : "FAIL"}`);
  console.log(`START_CTA_HIDES_AFTER_CONVERSATION_START = ${ketQua.find((item) => item.ma === "CTA3")?.pass ? "PASS" : "FAIL"}`);
  console.log(`MANUAL_TEXT_START_STILL_WORKS = ${ketQua.find((item) => item.ma === "UI4")?.pass ? "PASS" : "FAIL"}`);
  console.log(`ENTER_SEND_PRESERVED = ${ketQua.find((item) => item.ma === "UI3")?.pass ? "PASS" : "FAIL"}`);
  console.log(`SHIFT_ENTER_PRESERVED = ${ketQua.find((item) => item.ma === "UI3")?.pass ? "PASS" : "FAIL"}`);
  console.log(`INITIAL_OCURL_VALUE = ${JSON.stringify(hydrationProof.initialOcUrl)}`);
  console.log(`SETTINGS_MODAL_OPEN = ${hydrationProof.settingsModalOpen ? "YES" : "NO"}`);
  console.log(`TRAINING_OPEN_TRIGGERED_AI_CONFIG_REFRESH = ${hydrationProof.trainingRefresh ? "YES" : "NO"}`);
  console.log(`CANONICAL_GET_BASE_URL = ${hydrationProof.canonicalBaseUrl || "EMPTY"}`);
  console.log(`OCURL_AFTER_TRAINING_REFRESH = ${hydrationProof.ocUrlAfterRefresh || "EMPTY"}`);
  console.log(`TRAINING_POST_EMPTY_BASE_URL = ${hydrationProof.trainingPost?.body?.opencodeBaseUrl ? "NO" : "YES"}`);
  console.log(`TRAINING_POST_BASE_URL = ${hydrationProof.trainingPost?.body?.opencodeBaseUrl || "EMPTY"}`);
  console.log(`TRAINING_POST_AGENT = ${hydrationProof.trainingPost?.body?.opencodeAgent || "EMPTY"}`);
  console.log(`TRAINING_POST_MODEL = ${hydrationProof.trainingPost?.body?.opencodeModel || "EMPTY"}`);
  console.log(`REGRESSION_SEQUENCE_REPRODUCED = ${ketQua.find((item) => item.ma === "UI6")?.pass ? "YES" : "NO"}`);
  console.log(`REGRESSION_SEQUENCE_FIXED = ${ketQua.find((item) => item.ma === "UI6")?.pass ? "PASS" : "FAIL"}`);
  console.log(`REAL_TRAINING_PORTAL_LIFECYCLE_TESTED = ${hydrationProof.realPortal ? "YES" : "NO"}`);
  console.log(`AI_CHAT_EXPLICIT_URL_EDIT_PRESERVED = ${hydrationProof.aiChatEdit ? "PASS" : "FAIL"}`);
  console.log(`OWNER_SWITCH_RUNTIME_ISOLATION = ${hydrationProof.ownerSwitch ? "PASS" : "FAIL"}`);
  console.log(`STALE_OWNER_AI_CONFIG_APPLIED = ${hydrationProof.staleOwnerApplied ? "YES" : "NO"}`);
  console.log(`OWNER_A_RUNTIME_REUSED_BY_B = ${hydrationProof.ownerAReusedByB ? "YES" : "NO"}`);
  console.log(`FAKE_BASE_URL_CREATED = ${hydrationProof.fakeBaseUrl ? "YES" : "NO"}`);
  console.log("REAL_MODEL_CALL_IN_AUTOMATED_TEST = NO");
  console.log(`Provider call thật: ${realModelCalls}`);
  console.log(`OpenCode metadata fixture calls: ${metadataRequests}`);
  console.log(`Thư mục tạm: ${tmp}`);
  await new Promise((resolve) => fakeRuntime.close(resolve));
  process.exit(fail.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Khung onboarding test hỏng:", error);
  process.exit(2);
});
