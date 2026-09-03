import {
  addTrainingMessage,
  getAiChatConfig,
  getTrainingMessages,
  getTrainingSessionId,
  saveTrainingSessionId,
} from "./db.js";
import {
  call,
  extractReply,
  resolveEffectiveModelConfig,
  splitModel,
  KHONG_TOOL,
  TOOL_WEB,
  loadChatProviders,
  observedWebToolEvidence,
  providerResponseError,
  runOneShot,
} from "./opencode.js";
import { buildAppContext, renderAppContext } from "./app-context.js";
import {
  CAPABILITIES,
  ROUTE_MODES,
  SURFACES,
  WEB_PROBE_STATES,
  capabilityRoutingEnabled,
  createCallBudget,
  detectExplicitWebIntent,
  modelCapabilitySet,
  routeModelRequest,
} from "./ai-model-router.js";
import { classifyProviderFailure, ownerFacingFailureMessage } from "./provider-failure.js";
import { withCurrentOwnerPlaneRead, withOwnerCredentialReadSet } from "./owner-credentials.js";
import { addLog } from "./activity-log.js";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 6;
const ANH_HOP_LE = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const FILE_HOP_LE = ["application/pdf", "text/plain", "text/markdown", "text/csv"];

export function isSupportedUpload(mime) {
  return ANH_HOP_LE.includes(mime) || FILE_HOP_LE.includes(mime);
}

/** Bot Chi huy Normal: huong dan dung app; Soul la nang luc phu van duoc giu lai. */
function bootstrapHuanLuyen(config) {
  return [
    "# VAI TRÒ CỦA BẠN Ở PHIÊN NÀY",
    "Bạn là Bot Chỉ huy — NGƯỜI HƯỚNG DẪN SỬ DỤNG APP cho chủ app. Bạn KHÔNG phải trợ lý trả lời khách.",
    "Vai trò chính: hiểu mục tiêu, đối chiếu trạng thái app được gửi mới ở từng lượt, rồi giải thích bằng tiếng Việt đời thường: app đang có gì, chị làm được đến đâu, cần vào đâu hoặc nhắn thế nào, và phần nào còn thiếu.",
    "Bạn chỉ hướng dẫn. Không tự nhận đã kết nối, tạo, gửi, lưu, bật hoặc thay đổi bất kỳ cấu hình/hành động nào.",
    "",
    "# CÁCH TRẢ LỜI NGƯỜI DÙNG",
    "Hãy nói như một người rất hiểu app đang hướng dẫn chủ app, không nói như debugger, bảng trạng thái kỹ thuật hay người review source code.",
    "Bắt đầu bằng phần app hiện có liên quan đến mục tiêu; sau đó mới nói trạng thái thiết lập, phần làm được, nơi cần vào hoặc câu cần nhắn, rồi phần còn thiếu và cách gần nhất nếu có.",
    "Không đọc nguyên mã nội bộ, enum, tên module, route, bảng dữ liệu hay thuật ngữ kiến trúc ra câu trả lời. Chỉ nói kỹ thuật khi người dùng chủ động hỏi về triển khai kỹ thuật.",
    "Không suy diễn các chức năng riêng lẻ thành một luồng tự động hoàn chỉnh nếu trạng thái app không xác nhận chúng đã được nối với nhau.",
    "Chỉ nêu những gì giúp trả lời: có làm được không, cần làm gì, vào đâu, gõ gì hoặc còn thiếu gì; câu hỏi đơn giản phải có câu trả lời ngắn và hữu ích.",
    "Khi yêu cầu thật sự nói về hành vi, cách xưng hô, giọng điệu, giới hạn hoặc quy tắc của trợ lý, hãy giúp chủ app soạn/sửa Soul như trước.",
    "Chủ app có thể gửi ảnh chat mẫu, tài liệu và lời dặn rời rạc; hãy đọc kỹ và rút ra cách xưng hô, giọng điệu, nhịp trả lời, điều nên/không nên.",
    "Khi được yêu cầu tổng hợp Soul, hãy viết một đoạn Soul hoàn chỉnh, mạch lạc, dùng ngay được.",
    "",
    "# QUY TẮC",
    "Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào việc.",
    "Khi thiếu một lựa chọn làm thay đổi đáng kể cách thực hiện, chỉ hỏi một câu làm rõ ngắn gọn.",
    "Chỉ dùng màn hình, cú pháp và ví dụ đã có trong App Context; không tự bịa chức năng hoặc đường dẫn.",
    "Khi viết Soul, chỉ xuất ra nội dung Soul — không thêm lời dẫn kiểu 'Đây là Soul của bạn'.",
    "",
    "# SOUL HIỆN TẠI CỦA BOT (để bạn biết đang có gì)",
    config.soul?.trim() || "(chưa có)",
    "",
    "Nếu đã nắm, trả lời đúng một câu ngắn xác nhận và mời chủ shop bắt đầu.",
  ].join("\n");
}

function modelForMessage(config) {
  const model = splitModel(config.opencodeModel);
  return model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {};
}

async function layCauHinhHieuLuc(ownerUid, { batBuocModel = true } = {}) {
  if (!ownerUid) throw new Error("Chưa đăng nhập Zalo.");
  const savedConfig = await getAiChatConfig(ownerUid);
  const config = await resolveEffectiveModelConfig(savedConfig || {});
  if (batBuocModel && !splitModel(config.opencodeModel)) {
    throw new Error("Chưa chọn model AI hợp lệ.");
  }
  return config;
}

async function ensureSession(ownerUid, config) {
  const daCo = await getTrainingSessionId(ownerUid);
  if (daCo) {
    try {
      await call(config, `/session/${encodeURIComponent(daCo)}`, { method: "GET" });
      return { sessionId: daCo, created: false };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  const session = await call(config, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "Huấn luyện bot Zalo", agent: config.opencodeAgent || "general" }),
  });
  await saveTrainingSessionId(ownerUid, session.id);

  await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
    method: "POST",
    body: JSON.stringify({
      agent: config.opencodeAgent || "general",
      ...modelForMessage(config),
      // Bootstrap chi nap context khi routing ON; OFF giu dung baseline.
      ...(config.capabilityRoutingEnabled === true ? { noReply: true } : {}),
      tools: KHONG_TOOL,
      parts: [{ type: "text", text: bootstrapHuanLuyen(config) }],
    }),
  });
  return { sessionId: session.id, created: true };
}

/** Model nao doc duoc anh - de UI khong cho dan anh vao model mu. */
export async function modelDocDuocAnh(config, ownerUid = null) {
  try {
    const routingEnabled = config.capabilityRoutingEnabled ?? capabilityRoutingEnabled();
    if (!routingEnabled) {
      // Kill switch OFF phai giu dung guard baseline: doc capability image tho
      // cua Primary, khong cho router PRIMARY_ONLY bo qua capability check.
      const model = splitModel(config.opencodeModel);
      if (!model) return false;
      const response = await call(config, "/config/providers", { method: "GET" });
      const provider = (response.providers || []).find((item) => item.id === model.providerID);
      return Boolean(provider?.models?.[model.modelID]?.capabilities?.input?.image === true);
    }

    const providers = await loadChatProviders(config);
    const decision = routeModelRequest({
      ownerUid,
      surface: SURFACES.COMMANDER,
      primaryModel: config.opencodeModel,
      secondaryModel: config.opencodeFallbackModel,
      enabledSecondaryCapabilities: config.opencodeFallbackCapabilities,
      failoverEnabled: config.opencodeFailoverEnabled,
      requiredCapabilities: [CAPABILITIES.TEXT, CAPABILITIES.IMAGE_INPUT],
      catalogCapabilities: providers,
      webProbeState: null,
      routingEnabled,
    });
    return decision.routeMode !== ROUTE_MODES.UNAVAILABLE;
  } catch {
    return false;
  }
}

/**
 * File gui sang OpenCode duoi dang data URI. App va OpenCode o hai container khac
 * nhau nen OpenCode khong doc duoc file tren dia cua app; nhung data URI thi di
 * thang trong body, khong can mo cong hay chia se thu muc.
 */
function toFilePart(file) {
  return {
    type: "file",
    mime: file.mimetype,
    filename: file.originalname,
    url: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
  };
}

function fileCapability(file) {
  if (ANH_HOP_LE.includes(file.mimetype)) return CAPABILITIES.IMAGE_INPUT;
  if (file.mimetype === "application/pdf") return CAPABILITIES.FILE_INPUT;
  return null;
}

function requiredCapabilitiesForCommander(text, files) {
  const required = new Set([CAPABILITIES.TEXT]);
  for (const file of files) {
    const capability = fileCapability(file);
    if (capability) required.add(capability);
  }
  if (detectExplicitWebIntent(text)) required.add(CAPABILITIES.WEB_SEARCH);
  return [...required];
}

function webProbeStateForModel(catalog, canonicalModel) {
  return (catalog || [])
    .flatMap((provider) => provider?.models || [])
    .find((model) => model.id === canonicalModel)?.webProbeState || WEB_PROBE_STATES.UNKNOWN;
}

function modelMessage(config, parts, tools = KHONG_TOOL) {
  return {
    agent: config.opencodeAgent || "general",
    ...modelForMessage(config),
    tools,
    parts,
  };
}

async function sendTrainingMessage(config, sessionId, parts, tools = KHONG_TOOL) {
  const response = await call(config, `/session/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    body: JSON.stringify(modelMessage(config, parts, tools)),
  });
  if (response?.info?.error) throw providerResponseError(response.info.error);
  return { response, reply: extractReply(response) };
}

function specialistPrompt({ text, web }) {
  const lines = [
    "Bạn là specialist bằng chứng trung tính cho Bot Chỉ huy.",
    "Chỉ mô tả điều thật sự nhìn/đọc/tìm thấy liên quan yêu cầu; trích visible text và nêu rõ điều không chắc.",
    "Không tự suy đoán business facts như giá, tồn kho, còn/hết hàng hoặc chính sách shop.",
  ];
  if (web) {
    lines.push(
      "Bắt buộc dùng websearch. Tóm tắt facts, source titles, source URLs, relevant dates và uncertainties.",
      "Không dùng tool nào ngoài websearch/webfetch."
    );
  }
  if (String(text || "").trim()) lines.push("", `Yêu cầu của chủ app: ${String(text).trim()}`);
  return lines.join("\n");
}

function unavailableMessage(decision) {
  const missing = decision?.missingCapabilities || decision?.requiredCapabilities || [];
  const label = missing.includes(CAPABILITIES.IMAGE_INPUT)
    ? "đọc hình ảnh"
    : missing.includes(CAPABILITIES.FILE_INPUT)
      ? "đọc tài liệu PDF"
      : missing.includes(CAPABILITIES.WEB_SEARCH)
        ? "tìm kiếm Web"
        : "xử lý yêu cầu này";
  return `Yêu cầu này cần AI có khả năng ${label}, nhưng AI bổ trợ hiện chưa sẵn sàng. Chị cần cấu hình model phù hợp và API credential tương ứng.`;
}

async function logSecondary({ decision, requiredCapabilities, config, reason = null, outcome }) {
  await addLog({
    event: "ai_secondary_route",
    level: outcome === "SUCCESS" ? "info" : "warn",
    summary: outcome === "SUCCESS" ? "AI bổ trợ đã xử lý lượt Bot Chỉ huy" : "AI bổ trợ không xử lý được lượt Bot Chỉ huy",
    detail: {
      routeMode: decision.routeMode,
      surface: SURFACES.COMMANDER,
      requiredCapabilities,
      primaryModel: config.opencodeModel,
      secondaryModel: decision.secondaryModel,
      ...(reason ? { classifiedReason: reason } : {}),
      outcome,
    },
  }).catch(() => {});
}

async function guiVaLuu(ownerUid, config, sessionId, text, files, routeContext) {
  const userText = text.trim();
  if (!userText && files.length === 0) throw new Error("Chưa có nội dung để gửi.");

  const appContext = await buildAppContext(ownerUid);
  const baseParts = [{ type: "text", text: renderAppContext(appContext) }];
  if (userText) baseParts.push({ type: "text", text: userText });
  const { decision, requiredCapabilities, catalogCapabilities, routingEnabled, callBudget } = routeContext;
  let reply = "";

  if (decision.routeMode === ROUTE_MODES.CAPABILITY_ASSIST) {
    const missing = new Set(decision.missingCapabilities || []);
    const specialistFiles = files.filter((file) => missing.has(fileCapability(file)));
    const web = missing.has(CAPABILITIES.WEB_SEARCH);
    const secondaryConfig = { ...config, opencodeModel: decision.secondaryModel };
    const specialistParts = [
      ...specialistFiles.map(toFilePart),
      { type: "text", text: specialistPrompt({ text: userText, web }) },
    ];
    callBudget.consume({ secondary: true });
    let evidence;
    try {
      evidence = await runOneShot(
        secondaryConfig,
        "Bot Chỉ huy - specialist evidence",
        specialistParts,
        { tools: web ? TOOL_WEB : KHONG_TOOL }
      );
      if (web && !observedWebToolEvidence(evidence.response)) {
        const error = new Error("Không quan sát được websearch execution evidence trong lượt specialist.");
        error.code = "WEB_TOOL_EVIDENCE_MISSING";
        throw error;
      }
      await logSecondary({ decision, requiredCapabilities, config, outcome: "SUCCESS" });
    } catch (error) {
      const classifiedReason = classifyProviderFailure(error);
      await logSecondary({
        decision,
        requiredCapabilities,
        config,
        reason: classifiedReason,
        outcome: "FAILED",
      });
      throw new Error(ownerFacingFailureMessage(classifiedReason, "AI bổ trợ"));
    }

    const primaryCapabilities = modelCapabilitySet(catalogCapabilities, config.opencodeModel) || new Set();
    const primaryFiles = files.filter((file) => {
      const capability = fileCapability(file);
      return capability === null || primaryCapabilities.has(capability);
    });
    const finalParts = [
      ...baseParts,
      {
        type: "text",
        text: [
          "# BẰNG CHỨNG SPECIALIST CHO LƯỢT HIỆN TẠI",
          "Chỉ dùng như context bổ sung; vẫn trả lời bằng vai trò/personality Bot Chỉ huy.",
          String(evidence.text || "").trim(),
        ].join("\n"),
      },
      ...primaryFiles.map(toFilePart),
    ];
    callBudget.consume();
    try {
      reply = (await sendTrainingMessage(config, sessionId, finalParts)).reply;
    } catch (error) {
      // Secondary da duoc dung; budget cam third call/fallback de quy.
      throw new Error(ownerFacingFailureMessage(classifyProviderFailure(error)));
    }
  } else {
    const parts = [...baseParts, ...files.map(toFilePart)];
    callBudget.consume();
    try {
      reply = (await sendTrainingMessage(config, sessionId, parts)).reply;
    } catch (primaryError) {
      const classifiedReason = classifyProviderFailure(primaryError);
      const legacyAttachment = files.some((file) => fileCapability(file) === null);
      const budget = callBudget.snapshot();
      const failover = routeModelRequest({
        ownerUid,
        surface: SURFACES.COMMANDER,
        primaryModel: config.opencodeModel,
        secondaryModel: config.opencodeFallbackModel,
        enabledSecondaryCapabilities: config.opencodeFallbackCapabilities,
        failoverEnabled: legacyAttachment ? false : config.opencodeFailoverEnabled,
        requiredCapabilities,
        catalogCapabilities,
        webProbeState: webProbeStateForModel(catalogCapabilities, config.opencodeFallbackModel),
        routingEnabled,
        phase: "FAILOVER",
        classifiedReason,
        callsUsed: budget.callsUsed,
        secondaryAlreadyUsed: budget.secondaryUsed,
      });
      if (failover.routeMode !== ROUTE_MODES.RUNTIME_FAILOVER) {
        throw new Error(ownerFacingFailureMessage(classifiedReason));
      }
      const secondaryConfig = { ...config, opencodeModel: failover.secondaryModel };
      const provider = splitModel(failover.secondaryModel)?.providerID;
      callBudget.consume({ secondary: true });
      try {
        reply = await withOwnerCredentialReadSet(ownerUid, [provider], async () =>
          (await sendTrainingMessage(secondaryConfig, sessionId, parts)).reply
        );
        await logSecondary({
          decision: failover,
          requiredCapabilities,
          config,
          reason: classifiedReason,
          outcome: "SUCCESS",
        });
      } catch (secondaryError) {
        await logSecondary({
          decision: failover,
          requiredCapabilities,
          config,
          reason: classifiedReason,
          outcome: "FAILED",
        });
        throw new Error(ownerFacingFailureMessage(classifyProviderFailure(secondaryError), "AI bổ trợ"));
      }
    }
  }

  await addTrainingMessage(ownerUid, {
    role: "user",
    content: userText,
    files: files.map((f) => ({ filename: f.originalname, mime: f.mimetype, size: f.size })),
  });
  await addTrainingMessage(ownerUid, { role: "assistant", content: reply, files: [] });
  return reply;
}

export async function guiTinHuanLuyen(ownerUid, text, files = []) {
  return withCurrentOwnerPlaneRead(ownerUid, async () => {
    const config = await layCauHinhHieuLuc(ownerUid);
    config.capabilityRoutingEnabled = capabilityRoutingEnabled();
    if (!config?.opencodeBaseUrl?.trim()) throw new Error("Chưa cấu hình địa chỉ OpenCode.");

    for (const file of files) {
      if (!isSupportedUpload(file.mimetype)) throw new Error(`Không nhận định dạng ${file.mimetype}.`);
    }
    if (files.length > MAX_FILES_PER_MESSAGE) {
      throw new Error(`Tối đa ${MAX_FILES_PER_MESSAGE} tệp mỗi lần gửi.`);
    }

    const routingEnabled = config.capabilityRoutingEnabled;
    if (
      !routingEnabled
      && files.some((file) => ANH_HOP_LE.includes(file.mimetype))
      && !(await modelDocDuocAnh(config, ownerUid))
    ) {
      throw new Error("Model đang chọn không đọc được ảnh. Hãy đổi sang model có hỗ trợ ảnh trước khi gửi.");
    }
    const catalogCapabilities = routingEnabled ? await loadChatProviders(config) : [];
    const requiredCapabilities = requiredCapabilitiesForCommander(text, files);
    const decision = routingEnabled
      ? routeModelRequest({
          ownerUid,
          surface: SURFACES.COMMANDER,
          primaryModel: config.opencodeModel,
          secondaryModel: config.opencodeFallbackModel,
          enabledSecondaryCapabilities: config.opencodeFallbackCapabilities,
          failoverEnabled: config.opencodeFailoverEnabled,
          requiredCapabilities,
          catalogCapabilities,
          webProbeState: webProbeStateForModel(catalogCapabilities, config.opencodeFallbackModel),
          routingEnabled,
        })
      : {
          routeMode: ROUTE_MODES.PRIMARY_ONLY,
          primaryModel: config.opencodeModel,
          secondaryModel: null,
          requiredCapabilities,
          reason: "ROUTING_DISABLED",
        };
    if (decision.routeMode === ROUTE_MODES.UNAVAILABLE) throw new Error(unavailableMessage(decision));

    const providers = [
      splitModel(config.opencodeModel)?.providerID,
      ...(decision.secondaryModel ? [splitModel(decision.secondaryModel)?.providerID] : []),
    ].filter(Boolean);
    return withOwnerCredentialReadSet(ownerUid, providers, async () => {
      const { sessionId } = await ensureSession(ownerUid, config);
      return guiVaLuu(ownerUid, config, sessionId, text, files, {
        decision,
        requiredCapabilities,
        catalogCapabilities,
        routingEnabled,
        callBudget: createCallBudget(),
      });
    });
  });
}

const LENH_TONG_HOP = [
  "Dựa trên toàn bộ những gì tôi đã chia sẻ trong phiên này (ảnh chat mẫu, tài liệu, các lời dặn về giọng điệu),",
  "hãy viết ra một đoạn Soul hoàn chỉnh cho bot Zalo.",
  "Yêu cầu: mạch lạc, dùng được ngay, nêu rõ vai trò, cách xưng hô, giọng điệu, nhịp trả lời, những điều nên và không nên.",
  "Chỉ xuất ra nội dung Soul, không thêm lời dẫn hay giải thích.",
].join(" ");

export async function tongHopSoul(ownerUid) {
  return guiTinHuanLuyen(ownerUid, LENH_TONG_HOP, []);
}

export async function trangThai(ownerUid) {
  const config = await layCauHinhHieuLuc(ownerUid, { batBuocModel: false });
  config.capabilityRoutingEnabled = capabilityRoutingEnabled();
  return {
    messages: await getTrainingMessages(ownerUid),
    sessionId: await getTrainingSessionId(ownerUid),
    model: config?.opencodeModel || "(chưa chọn model)",
    docDuocAnh: await modelDocDuocAnh(config, ownerUid),
  };
}
