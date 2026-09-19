import { ThreadType } from "zca-js";
import { bumpSessionTurns, getAccountConfig, getAiChatConfig, getThread } from "./db.js";
import { buildRecentHistory } from "./conversation-context.js";
import * as customerMemory from "./customer-memory.js";
import { scheduleDetachedBackgroundTask } from "./global-ai-limiter.js";
import * as ownerCredentials from "./owner-credentials.js";
import * as emailCheck from "./email-check.js";
import * as docTep from "./doc-tep.js";
import * as knowledge from "./knowledge.js";
import { formatKnowledge } from "./knowledge-retrieval.js";
import * as opencode from "./opencode.js";
import * as websiteEmailStatus from "./website-email-status.js";
import { addLog } from "./activity-log.js";
import { mocHienTai } from "./moc-gio.js";
import {
  CAPABILITIES,
  ROUTE_MODES,
  SURFACES,
  capabilityRoutingEnabled,
  createCallBudget,
  routeModelRequest,
} from "./ai-model-router.js";
import { FAILURE_CODES, classifyProviderFailure, ownerFacingFailureMessage } from "./provider-failure.js";
import {
  canonicalDecisionResultLog,
  openAdminClarification,
  recordDecisionProtocolOutcome,
} from "./admin-clarification.js";

const SKIP_TOKEN = "SKIP";
const KNOWLEDGE_MAX_CHARS = 12000;
const DECISION_TIMEOUT_MS = 30000;
export const MAX_AI_RETRY = 1;
export const MALFORMED_DECISION_FALLBACK = "Em chưa thể xử lý chính xác yêu cầu này lúc này. Em đã ghi nhận tin nhắn của anh/chị.";
const DECISION_PREFIX = "[[VIZEN_DECISION:";
const DECISION_INSTRUCTION = [
  "# VIZENBOT DECISION PROTOCOL — BẮT BUỘC CHO TIN NÀY",
  "Dòng đầu tiên của câu trả lời phải là CHÍNH XÁC một trong ba token:",
  "[[VIZEN_DECISION:ANSWERABLE]]",
  "[[VIZEN_DECISION:NEED_ADMIN]]",
  "[[VIZEN_DECISION:OUT_OF_SCOPE]]",
  "ANSWERABLE khi đủ dữ liệu chắc chắn; phần sau token là câu trả lời cho khách và không được rỗng.",
  "NEED_ADMIN khi câu hỏi liên quan doanh nghiệp nhưng thiếu dữ liệu/chưa chắc chắn; không viết câu trả lời business sau token.",
  "OUT_OF_SCOPE khi ngoài phạm vi; phần sau token có thể rỗng.",
  "Protocol này ghi đè mọi chỉ dẫn 'không thêm lời dẫn' và chỉ dẫn SKIP cũ trong lượt này.",
  "Không được bịa dữ kiện doanh nghiệp. Không thêm bất kỳ chữ nào trước token.",
].join("\n");
const CORRECTIVE_DECISION_REASONS = Object.freeze({
  MISSING_OR_INVALID_TOKEN: "Lỗi: câu trả lời trước thiếu token quyết định ở dòng đầu tiên.",
  EXTRA_DECISION_MARKER_IN_BODY: "Lỗi: câu trả lời trước có thêm token quyết định nằm trong phần nội dung.",
  ANSWERABLE_BODY_EMPTY: "Lỗi: câu trả lời trước chọn ANSWERABLE nhưng không có nội dung trả lời cho khách.",
});
const GENERIC_CORRECTIVE_DECISION_REASON = "Lỗi: câu trả lời trước không đúng khuôn dạng quyết định bắt buộc.";

function buildCorrectiveRetryInstruction(reason) {
  const reasonSentence = Object.hasOwn(CORRECTIVE_DECISION_REASONS, reason)
    ? CORRECTIVE_DECISION_REASONS[reason]
    : GENERIC_CORRECTIVE_DECISION_REASON;
  return [
    "# SỬA ĐỊNH DẠNG — CÂU TRẢ LỜI TRƯỚC TRONG LƯỢT NÀY ĐÃ SAI GIAO THỨC",
    "Câu trả lời trước của bạn cho tin này KHÔNG đúng giao thức quyết định và đã bị hệ thống loại bỏ. Khách CHƯA nhận được gì.",
    reasonSentence,
    "1. Dòng đầu tiên phải là CHÍNH XÁC một token quyết định, không có ký tự nào đứng trước.",
    "2. Toàn bộ câu trả lời chỉ được có ĐÚNG MỘT token quyết định; không đặt token trong phần nội dung.",
    "3. Nếu chọn ANSWERABLE, phần sau token phải có nội dung trả lời cho khách, không được rỗng.",
    "4. Nếu chọn NEED_ADMIN, không viết câu trả lời business sau token.",
    "5. Giữ nguyên quyết định và nội dung bạn định trả lời; CHỈ sửa lại định dạng.",
    "6. KHÔNG nhắc tới lỗi định dạng, việc thử lại hay hệ thống trong phần trả lời cho khách; không viết lời dẫn kiểu: \"Đây là bản đã sửa\".",
    "Giao thức đầy đủ được nhắc lại ngay bên dưới.",
  ].join("\n");
}

/**
 * Ket qua cua MOT luot tra loi AI. Day la kenh phu, khong thay the legacy
 * contract string|null cua tryReply: truoc Repair A, mot luot dang le phai tra
 * loi nhung that bai cung chi tra ve null, giong het "co y khong tra loi", nen
 * durable job settle DONE va khach mat luot.
 */
export const REPLY_OUTCOME_KINDS = Object.freeze({
  DELIVERABLE: "DELIVERABLE",
  TERMINAL_NO_REPLY: "TERMINAL_NO_REPLY",
  FAILED: "FAILED",
});

/**
 * Machine code ngoai taxonomy provider; provider-failure.js van la authority rieng.
 * generateReply/tryReply co ban sao literal cua nhung ma nay ngay trong than ham
 * (cac harness bien dich rieng tung ham nen khong thay module scope); kiem thu
 * Repair A khoa hai ben lai voi nhau.
 */
export const REPLY_FAILURE_CODES = Object.freeze({
  AI_NOT_CONFIGURED: "AI_NOT_CONFIGURED",
  EMPTY_AI_REPLY: "EMPTY_AI_REPLY",
  EMPTY_BUBBLES_AFTER_FILTER: "EMPTY_BUBBLES_AFTER_FILTER",
  MALFORMED_DECISION_OUTPUT: "MALFORMED_DECISION_OUTPUT",
  UNCLASSIFIED_REPLY_OUTCOME: "UNCLASSIFIED_REPLY_OUTCOME",
  // Fail-closed cho moi thu khong classify duoc: canonical, khong tu che taxonomy.
  UNKNOWN: FAILURE_CODES.UNKNOWN_PROVIDER_ERROR,
});

export const TERMINAL_NO_REPLY_REASONS = Object.freeze({
  FILTER_SKIP: "FILTER_SKIP",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  SKIP: "SKIP",
});

/** Nhan tu dong dan len hoi thoai khi khach gui PDF. Doi ten o day la doi ca app. */
const NHAN_PDF = "Bài test";

let configCache = null;
let configCacheOwnerUid = null;
let productionDecisionModeEnabled = false;

/** Production bootstrap owns this switch; isolated legacy harnesses omit it. */
export function enableAdminClarificationDecisionMode() {
  productionDecisionModeEnabled = true;
}

/** Ham gan nhan cua zalo-service, truyen tu server.js de tranh vong import. */
let ganNhanTuDong = null;
export function capHinhGanNhan(fn) {
  ganNhanTuDong = fn;
}

/** zalo-service tiem ham lay uid tai khoan dang dang nhap vao day (tranh vong import). */
let layChuTaiKhoan = () => null;
export function capHinhChuTaiKhoan(fn) {
  layChuTaiKhoan = fn;
  // Chuyen tiep cho kho ho so khach va lich su tra cuu email: chung cung phai
  // biet dang lam viec cho tai khoan Zalo nao.
  customerMemory.capHinhChuTaiKhoan(fn);
  emailCheck.capHinhChuTaiKhoan(fn);
}

/**
 * Gop cau hinh CHUNG (giong dieu, tri thuc, OpenCode...) voi cau hinh RIENG cua
 * tai khoan Zalo dang dang nhap (cong tac bot, nhom/nick duoc phep).
 * Tai khoan chua tung luu gi -> mac dinh TAT, khong thua huong cua tai khoan khac.
 */
export async function loadConfig() {
  const ownerUid = layChuTaiKhoan();
  if (!ownerUid) {
    configCache = null;
    configCacheOwnerUid = null;
    return;
  }
  const ownerKey = String(ownerUid);
  const chung = await getAiChatConfig(ownerKey);
  const rieng = await getAccountConfig(ownerKey);
  const hieuLuc = chung ? await opencode.resolveEffectiveModelConfig(chung) : null;
  // UID co the doi trong luc dang cho DB/catalog. Ket qua owner cu khong duoc
  // ghi vao cache cua owner moi.
  if (String(layChuTaiKhoan() || "") !== ownerKey) {
    configCache = null;
    configCacheOwnerUid = null;
    return;
  }
  configCache = hieuLuc
    ? {
        ...hieuLuc,
        capabilityRoutingEnabled: capabilityRoutingEnabled(),
        ...(productionDecisionModeEnabled ? { adminClarificationDecisionEnabled: true } : {}),
        botEnabled: rieng.botEnabled,
        allowedGroupId: rieng.allowedGroupId,
        allowedSenderIds: rieng.allowedSenderIds,
      }
    : null;
  configCacheOwnerUid = configCache ? ownerKey : null;
}

export async function refreshConfig() {
  await loadConfig();
}

/**
 * Soul la BAT BUOC. Co chu y: doi engine tu Groq sang OpenCode lam mat dieu kien
 * "co Groq key", neu khong bat buoc Soul thi cau hinh cu se bong dung du dieu kien
 * va bot tu dong tra loi that vao moi cuoc tro chuyen ma chua ai kip duyet.
 */
export function isAiChatReady(config = getConfig()) {
  if (!config) return false;
  const { allowedTopics, soul, opencodeBaseUrl, opencodeModel } = config;
  return Boolean(
    opencodeBaseUrl?.trim()
    && opencodeModel?.trim()
    && allowedTopics?.trim()
    && soul?.trim()
  );
}

export function getConfig(ownerUid = layChuTaiKhoan()) {
  if (!ownerUid || String(ownerUid) !== configCacheOwnerUid) return null;
  return configCache;
}

function describeMessage(message) {
  return {
    threadId: message?.threadId ?? null,
    threadType: message?.threadType ?? null,
    senderId: message?.senderId ?? null,
    senderName: message?.senderName ?? null,
  };
}

/** Gom Soul + vai tro + chu de + lich su gan day de nap vao session moi. */
export async function buildBootstrapContext(threadId, boQuaMessageId, config = getConfig(), ownerUid = layChuTaiKhoan()) {
  if (!config || !ownerUid) throw new Error("Không có AI profile của Zalo UID hiện tại.");
  const { soul, roleTone, allowedTopics } = config;

  const thread = threadId
    ? await getThread(ownerUid, threadId).catch((error) => {
      console.warn("[ai-chat] Thread lookup failed; continuing without thread context:", error.message);
      return null;
    })
    : null;
  const recentHistory = await buildRecentHistory(ownerUid, threadId, boQuaMessageId);
  return {
    soul,
    roleTone,
    allowedTopics,
    recentHistory,
    threadTitle: thread?.title || threadId,
    soTinLichSu: recentHistory ? recentHistory.split("\n").length : 0,
  };
}

export function shouldProcessMessage(message, config = getConfig()) {
  if (!config) return false;
  const { allowedGroupId, allowedSenderIds } = config;

  if (allowedGroupId && allowedGroupId.trim() !== "") {
    if (String(message.threadType) !== String(ThreadType.Group) || String(message.threadId) !== String(allowedGroupId)) {
      return false;
    }
  }

  if (Array.isArray(allowedSenderIds) && allowedSenderIds.length > 0) {
    if (!allowedSenderIds.includes(String(message.senderId))) {
      return false;
    }
  }

  return true;
}

/** Ly do truot loc, chi de hien trong LOG cho de hieu. */
function filterSkipReason(message, config = getConfig()) {
  const { allowedGroupId, allowedSenderIds } = config || {};
  if (allowedGroupId && allowedGroupId.trim() !== "") {
    if (String(message.threadType) !== String(ThreadType.Group)) {
      return "Tin nhắn cá nhân, nhưng cấu hình chỉ cho phép 1 nhóm";
    }
    if (String(message.threadId) !== String(allowedGroupId)) {
      return `Sai nhóm: tin ở ${message.threadId}, cấu hình cho phép ${allowedGroupId}`;
    }
  }
  if (Array.isArray(allowedSenderIds) && allowedSenderIds.length > 0) {
    return `Nick ${message.senderName || message.senderId} không nằm trong danh sách được phép`;
  }
  return "Không qua bộ lọc";
}

/**
 * Hoi OpenCode agent. Tra ve object de tang tren con log duoc chi tiet.
 * Invariant: `error` khac null thi `failureCode` luon la chuoi khong rong.
 * @returns {{ reply: string|null, sessionId: string|null, sessionCreated: boolean, raw: string|null, skipped: boolean, error: string|null, failureCode: string|null, tokens: object|null, model: string|null }}
 */
function customerRequiredCapabilities(messageObj) {
  const required = [CAPABILITIES.TEXT];
  if (String(messageObj?.msgType || "") === "chat.photo" || messageObj?.__stickerVision) {
    required.push(CAPABILITIES.IMAGE_INPUT);
  }
  if (String(messageObj?.msgType || "") === "share.file") required.push(CAPABILITIES.FILE_INPUT);
  return required;
}

export function parseDecisionReply(raw) {
  const text = String(raw ?? "");
  if (text.toUpperCase().startsWith(SKIP_TOKEN)) {
    return { valid: true, decision: "OUT_OF_SCOPE", body: "", legacySkip: true };
  }
  const match = text.match(/^\[\[VIZEN_DECISION:(ANSWERABLE|NEED_ADMIN|OUT_OF_SCOPE)\]\](?:\r?\n|$)/);
  if (!match) return { valid: false, decision: null, body: "", reason: "MISSING_OR_INVALID_TOKEN" };
  const body = text.slice(match[0].length).trim();
  if (/\[\[VIZEN_DECISION:[^\]]*\]\]/i.test(body)) {
    return { valid: false, decision: match[1], body, reason: "EXTRA_DECISION_MARKER_IN_BODY" };
  }
  if (match[1] === "ANSWERABLE" && !body) {
    return { valid: false, decision: match[1], body, reason: "ANSWERABLE_BODY_EMPTY" };
  }
  return { valid: true, decision: match[1], body, legacySkip: false };
}

export async function generateReply(
  userMessage,
  messageObj,
  ownerUid = layChuTaiKhoan(),
  config = getConfig(ownerUid),
  options = Object()
) {
  // Invariant Repair A: MOI result co `error` deu phai kem `failureCode` khong rong.
  const base = {
    reply: null, sessionId: null, sessionCreated: false, raw: null,
    skipped: false, error: null, failureCode: null, tokens: null, model: null,
    decision: null, decisionReason: null, malformedDecision: false, needAdmin: false,
  };
  if (!config || !ownerUid || !isAiChatReady(config)) {
    return { ...base, failureCode: "AI_NOT_CONFIGURED", error: "AI Chat chưa cấu hình xong" };
  }

  // loadConfig gan kill switch vao config production. Cach viet nay con giu
  // generateReply doc lap de regression harness co the thuc thi baseline path.
  const routingEnabled = config.capabilityRoutingEnabled === true;
  const requiredCapabilities = routingEnabled ? customerRequiredCapabilities(messageObj) : [];
  const callBudget = routingEnabled
    ? createCallBudget()
    : { consume: () => undefined, snapshot: () => ({ callsUsed: 0, secondaryUsed: false }) };
  let catalogCapabilities = null;
  if (routingEnabled) {
    try {
      catalogCapabilities = await opencode.loadChatProviders(config);
    } catch (error) {
      // Classify ORIGINAL error truoc khi dich sang owner-facing text: timeout/503
      // cua catalog phai giu dung canonical code, khong bi ha thanh generic.
      const failureCode = classifyProviderFailure(error);
      return { ...base, failureCode, error: `Không tải được capability catalog: ${error.message}` };
    }
  }

  const threadId = messageObj?.threadId || "global";
  const excludedMessageIds = messageObj?.sourceIds ?? messageObj?.id;
  const context = await buildBootstrapContext(threadId, excludedMessageIds, config, ownerUid);

  const laChatRieng = String(messageObj?.threadType) === String(ThreadType.User);
  const decisionMode = laChatRieng && config.adminClarificationDecisionEnabled === true;

  // Doc anh/PDF khach gui - CHI trong chat rieng 1-1, va chi khi chi bat.
  // Ban tom tat duoc nhet vao TIN NHAN nay thoi; tep goc khong bao gio vao
  // phien, khong thi moi luot sau deu bi tinh tien doc lai ca tep.
  let loiKhach = userMessage;
  let khoiTep = "";
  // Khi routing V1 bat, chat.photo phai vao canonical docTep seam de router
  // enforce IMAGE_INPUT/owner permission va tao customer-safe Evidence/fallback.
  // Legacy docTep van la authority duy nhat cho PDF va cho routing-OFF.
  const anhCanQuaRouter = routingEnabled && String(messageObj?.msgType || "") === "chat.photo";
  if ((config.docTep || anhCanQuaRouter) && laChatRieng) {
    const ketQua = await docTep.xuLyTep(config, messageObj, {
      ownerUid,
      surface: SURFACES.CUSTOMER,
      catalogCapabilities,
      callBudget,
    }).catch((error) => {
      console.warn("[doc-tep] Loi:", error.message);
      return null;
    });
    if (ketQua?.khoiChoAgent) {
      khoiTep = ketQua.khoiChoAgent;
      // Khach gui PDF thuong la bai test gui vao nho tu van -> dan nhan cho chi
      // loc lai sau. Chay nen, hong cung khong duoc lam nghen cau tra loi khach.
      if (ketQua.laPdf && ganNhanTuDong) {
        ganNhanTuDong(NHAN_PDF, String(messageObj.threadId)).catch((error) =>
          console.warn("[nhan] Khong gan duoc nhan PDF:", error.message)
        );
      }
      // Khach gui anh khong kem loi nhan thi Zalo de nguyen duong link lam noi
      // dung tin. Dua nguyen cuc link cho agent thi no se tuong khach dang gui
      // link cho minh xem.
      if (/^https?:\/\/\S+$/.test(String(loiKhach).trim())) {
        loiKhach = "(khách gửi một tệp, không kèm lời nhắn)";
      }
    }
  }

  // Sticker media is independent of the legacy docTep switch. The transient
  // message is reused by corrective retry, so the visual result is read once.
  if (laChatRieng && messageObj?.__stickerVision) {
    if (!messageObj.__stickerVisionMemo) {
      let visionAllowed = Boolean(messageObj.__stickerVision.url);
      if (visionAllowed && !routingEnabled) {
        try {
          const probeCatalog = await opencode.loadChatProviders(config);
          const probe = routeModelRequest({
            ownerUid,
            surface: SURFACES.CUSTOMER,
            primaryModel: config.opencodeModel,
            secondaryModel: "",
            enabledSecondaryCapabilities: [],
            failoverEnabled: false,
            requiredCapabilities: [CAPABILITIES.TEXT, CAPABILITIES.IMAGE_INPUT],
            catalogCapabilities: probeCatalog,
            routingEnabled: true,
          });
          visionAllowed = probe.routeMode === ROUTE_MODES.PRIMARY_ONLY;
        } catch {
          visionAllowed = false;
        }
      }
      const visionResult = visionAllowed
        ? await docTep.xuLyTep(config, messageObj, {
          ownerUid,
          surface: SURFACES.CUSTOMER,
          catalogCapabilities,
          callBudget,
          sticker: messageObj.__stickerVision,
        }).catch(() => null)
        : null;
      messageObj.__stickerVisionMemo = {
        khoiChoAgent: visionResult?.khoiChoAgent
          || `${docTep.STICKER_VISION_FAILURE_MARKER}\n\n`,
      };
    }
    khoiTep = messageObj.__stickerVisionMemo.khoiChoAgent;
  }

  // Attachment routing/doc Evidence phai xong truoc moi Primary session/message
  // execution cua logical turn. Session sau do van la canonical final session.
  let session;
  try {
    session = await opencode.ensureSession(
      config,
      ownerUid,
      threadId,
      context,
      async ({ sessionId, bootstrap, xoayTuPhien, soLuotCu }) => {
        // Phien cu da bi bo -> quen luon danh dau "da nap ho so" cua no, khong
        // thi phien moi se khong duoc nap lai ho so khach.
        if (xoayTuPhien) customerMemory.quenPhien(xoayTuPhien);
        await addLog({
          event: "opencode_session",
          level: xoayTuPhien ? "warn" : "ok",
          summary: xoayTuPhien
            ? `Phiên của "${context.threadTitle}" đã dài ${soLuotCu} lượt — xoay sang phiên mới, nạp lại Soul kèm ${context.soTinLichSu} tin cũ`
            : context.soTinLichSu
              ? `Tạo session OpenCode mới cho "${context.threadTitle}" — nạp Soul kèm ${context.soTinLichSu} tin cũ`
              : `Tạo session OpenCode mới cho "${context.threadTitle}" và nạp Soul (chưa có tin cũ)`,
          detail: {
            sessionId,
            threadId,
            agent: config.opencodeAgent,
            soTinLichSu: context.soTinLichSu,
            xoayTuPhien,
            soLuotCu,
            bootstrap,
          },
        });
      }
    );
  } catch (error) {
    // Session creation cung la provider-like boundary: classify ORIGINAL error.
    const failureCode = classifyProviderFailure(error);
    return { ...base, failureCode, error: error.message };
  }

  let knowledgeBlock = "";
  let freshKnowledgeUnits = [];
  let knowledgeMetrics = null;
  const retrievalStartedAt = performance.now();
  const { useKnowledge, knowledgeFileIds } = config;
  const retrievalQuery = messageObj?.__stickerItems?.length
    ? String(messageObj.__customerText || "").trim().slice(0, 2000)
    : [khoiTep, loiKhach].filter(Boolean).join(" ").slice(0, 2000);
  if (retrievalQuery && useKnowledge && Array.isArray(knowledgeFileIds) && knowledgeFileIds.length > 0) {
    try {
      const retrieved = await knowledge.retrieveForAi(ownerUid, knowledgeFileIds, retrievalQuery, KNOWLEDGE_MAX_CHARS);
      freshKnowledgeUnits = retrieved.units.filter((unit) => !opencode.knowledgeLedger.has(session.sessionId, unit.contentHash));
      const injectedCharCount = freshKnowledgeUnits.reduce((sum, unit) => sum + unit.charCount, 0);
      knowledgeBlock = formatKnowledge(freshKnowledgeUnits, { pointer: retrieved.units.length > 0 && freshKnowledgeUnits.length === 0 });
      knowledgeMetrics = {
        ownerUid, sessionId: session.sessionId, threadId, ...retrieved.stats,
        ledgerSkippedUnits: retrieved.units.length - freshKnowledgeUnits.length,
        ledgerSkippedChars: retrieved.stats.selectedCharCount - injectedCharCount,
        injectedCharCount, durationMs: performance.now() - retrievalStartedAt,
      };
    } catch {
      await addLog({ event: "ai_error", level: "error",
        summary: "Không đọc được tri thức liên quan cho lượt này",
        detail: { ownerUid, sessionId: session.sessionId, threadId },
      }).catch(() => {});
    }
  }

  // Ho so khach di kem TIN NHAN chu khong nam trong bootstrap: mot phien nhom
  // co nhieu khach, moi nguoi can ho so cua rieng minh khi ho len tieng.
  let promptDayDu = await customerMemory
    .bocPrompt(session.sessionId, messageObj, loiKhach, ownerUid)
    .catch((error) => {
      console.warn("[ai-chat] Customer-context enrichment failed; using raw message:", error.message);
      return loiKhach;
    });
  if (khoiTep) promptDayDu = khoiTep + promptDayDu;

  // Bot khong tu biet bay gio la may gio. Thieu dong nay thi no chao "buoi toi"
  // luc 10h sang, va khong biet khach vua ngu day hay dang noi lien mach.
  // Phai dan them cach DUNG, khong thi no doc gio ra nhu cai may.
  const timeContext =
    `# BÂY GIỜ\n${mocHienTai()}\n` +
    `(Dùng mốc này để chào đúng buổi và biết khách vừa nghỉ hay đang nói liên tục. ` +
    `Đừng đọc giờ ra thành lời, trừ khi khách hỏi.)\n\n`;

  if (messageObj?.__emailStatusContext) {
    promptDayDu = messageObj.__emailStatusContext + promptDayDu;
  }

  promptDayDu = "# TIN KHÁCH HIỆN TẠI — YÊU CẦU DUY NHẤT CẦN TRẢ LỜI\n" + timeContext + promptDayDu;

  // Session moi da nhan lich su trong bootstrap. Session duoc tai su dung thi
  // can refresh bounded canonical history ngay trong CUNG prompt cua tin hien
  // tai, de nhung cau human tra loi trong luc Bot OFF khong bi mat khoi ngu canh.
  if (session.created === false && context.recentHistory) {
    promptDayDu = [
      "# LỊCH SỬ CANONICAL GẦN ĐÂY — CHỈ LÀ NGỮ CẢNH",
      "",
      "Nội dung giữa BEGIN/END đã xảy ra trước đây.",
      "KHÔNG trả lời riêng bất kỳ tin nào trong khối lịch sử.",
      "KHÔNG thực hiện lại yêu cầu cũ.",
      '"Bạn (đã trả lời)" là phía business/self, có thể là human hoặc AI, KHÔNG phải lời khách.',
      "Chỉ dùng lịch sử để hiểu mạch hội thoại, biết business đã nói gì, tránh hỏi lại và tránh mâu thuẫn.",
      "",
      "<BEGIN_CANONICAL_HISTORY>",
      context.recentHistory,
      "<END_CANONICAL_HISTORY>",
      "",
      promptDayDu,
    ].join("\n");
  }

  if (knowledgeBlock) promptDayDu = `${knowledgeBlock}\n\n${promptDayDu}`;
  // HTTP acceptance can precede an inference error; log once per retrieval.
  let knowledgeRecorded = false;
  const recordKnowledge = async (accepted) => {
    if (!knowledgeMetrics || knowledgeRecorded) return;
    knowledgeRecorded = true;
    accepted ||= freshKnowledgeUnits.some((unit) => opencode.knowledgeLedger.has(session.sessionId, unit.contentHash));
    if (accepted) opencode.knowledgeLedger.add(session.sessionId,
      freshKnowledgeUnits.map((unit) => unit.contentHash), knowledgeMetrics.injectedCharCount);
    await addLog({ event: "knowledge_retrieval", level: "info",
      summary: "Truy xuất tri thức liên quan cho lượt hiện tại",
      detail: { ...knowledgeMetrics,
        injectedCharCount: accepted ? knowledgeMetrics.injectedCharCount : 0,
        sessionCumulativeChars: opencode.knowledgeLedger.cumulative(session.sessionId) },
    }).catch(() => {});
  };

  // Per-message, never bootstrap: an already-open OpenCode session receives the
  // protocol on its very next customer turn without rotation.
  if (decisionMode) {
    promptDayDu = `${DECISION_INSTRUCTION}\n\n${promptDayDu}`;
    if (options.correctiveDecisionRetry) {
      promptDayDu = `${buildCorrectiveRetryInstruction(options.decisionReason)}\n\n${promptDayDu}`;
    }
  }

  try {
    callBudget.consume();
    let result;
    try {
      result = await opencode.sendPrompt(config, session.sessionId, promptDayDu, { timeoutMs: 30000, knowledgeUnits: freshKnowledgeUnits });
    } catch (primaryError) {
      const classifiedReason = classifyProviderFailure(primaryError);
      const budget = callBudget.snapshot();
      const failover = routeModelRequest({
        ownerUid,
        surface: SURFACES.CUSTOMER,
        primaryModel: config.opencodeModel,
        secondaryModel: config.opencodeFallbackModel,
        enabledSecondaryCapabilities: config.opencodeFallbackCapabilities,
        failoverEnabled: config.opencodeFailoverEnabled,
        requiredCapabilities,
        catalogCapabilities: catalogCapabilities || [],
        webProbeState: null,
        routingEnabled,
        phase: "FAILOVER",
        classifiedReason,
        callsUsed: budget.callsUsed,
        secondaryAlreadyUsed: budget.secondaryUsed,
      });
      if (failover.routeMode !== ROUTE_MODES.RUNTIME_FAILOVER) {
        await recordKnowledge(false);
        return {
          ...base,
          sessionId: session.sessionId,
          sessionCreated: session.created,
          failureCode: classifiedReason,
          error: ownerFacingFailureMessage(classifiedReason),
        };
      }
      const secondaryConfig = { ...config, opencodeModel: failover.secondaryModel };
      const alreadyInserted = freshKnowledgeUnits.length > 0
        && freshKnowledgeUnits.every((unit) => opencode.knowledgeLedger.has(session.sessionId, unit.contentHash));
      const secondaryPrompt = alreadyInserted
        ? promptDayDu.replace(knowledgeBlock, formatKnowledge([], { pointer: true }))
        : promptDayDu;
      callBudget.consume({ secondary: true });
      try {
        result = await opencode.sendPrompt(secondaryConfig, session.sessionId, secondaryPrompt, { timeoutMs: 30000, knowledgeUnits: freshKnowledgeUnits });
        await addLog({
          event: "ai_secondary_route",
          level: "info",
          summary: "AI bổ trợ đã tiếp quản Customer Bot sau lỗi tạm thời",
          detail: {
            routeMode: failover.routeMode,
            surface: SURFACES.CUSTOMER,
            requiredCapabilities,
            primaryModel: config.opencodeModel,
            secondaryModel: failover.secondaryModel,
            classifiedReason,
            outcome: "SUCCESS",
          },
        }).catch(() => {});
      } catch (secondaryError) {
        await recordKnowledge(false);
        // Secondary duoc classify de diagnostic dung; durable code VAN la primary.
        const secondaryClassifiedReason = classifyProviderFailure(secondaryError);
        await addLog({
          event: "ai_secondary_route",
          level: "warn",
          summary: "AI bổ trợ không thể tiếp quản Customer Bot",
          detail: {
            routeMode: failover.routeMode,
            surface: SURFACES.CUSTOMER,
            requiredCapabilities,
            primaryModel: config.opencodeModel,
            secondaryModel: failover.secondaryModel,
            classifiedReason,
            secondaryClassifiedReason,
            outcome: "FAILED",
          },
        }).catch(() => {});
        return {
          ...base,
          sessionId: session.sessionId,
          sessionCreated: session.created,
          failureCode: classifiedReason,
          error: "AI chưa hoàn tất được yêu cầu. Hệ thống đã giữ lại tin để người phụ trách trả lời.",
        };
      }
    }
    await recordKnowledge(true);
    await addLog({
      event: "ai_prompt",
      level: "info",
      summary: Boolean(knowledgeBlock)
        ? "Bơm prompt vào session OpenCode kèm tri thức liên quan cho lượt này"
        : "Bơm prompt vào session OpenCode",
      detail: {
        sessionId: session.sessionId,
        agent: config.opencodeAgent,
        model: config.opencodeModel || "(chưa chọn model)",
        sessionCreated: session.created,
        hasKnowledge: Boolean(knowledgeBlock),
        knowledgeChars: knowledgeMetrics?.injectedCharCount || 0,
        soTinLichSu: context.soTinLichSu,
        soLuotPhien: session.turns ?? 0,
        coHoSoKhach: promptDayDu !== userMessage && promptDayDu.startsWith("# HỒ SƠ"),
        userMessage,
      },
    });
    await bumpSessionTurns(ownerUid, threadId);
    const raw = String(result.reply ?? "");
    if (decisionMode) {
      const parsed = parseDecisionReply(raw);
      if (config.__deferDecisionProtocolOutcome !== true) {
        await recordDecisionProtocolOutcome({
          ownerUid,
          malformed: !parsed.valid,
          automaticWork: messageObj?.__adminClarificationAutomaticWork || null,
        }).catch(() => {});
      }
      if (!parsed.valid) {
        return {
          ...base,
          sessionId: session.sessionId,
          sessionCreated: session.created,
          raw,
          malformedDecision: true,
          decisionReason: parsed.reason,
          failureCode: "MALFORMED_DECISION_OUTPUT",
          error: `AI decision protocol malformed: ${parsed.reason}`,
          tokens: result.tokens,
          model: result.model,
        };
      }
      if (parsed.decision === "NEED_ADMIN") {
        if (parsed.body) {
          console.warn("[ai-chat] NEED_ADMIN body discarded");
          await addLog({
            event: "ai_decision_body_discarded",
            level: "warn",
            summary: "Agent trả NEED_ADMIN kèm business body — đã bỏ toàn bộ body",
            detail: { sessionId: session.sessionId },
          }).catch(() => {});
        }
        return {
          ...base,
          sessionId: session.sessionId,
          sessionCreated: session.created,
          raw,
          decision: "NEED_ADMIN",
          needAdmin: true,
          tokens: result.tokens,
          model: result.model,
        };
      }
      if (parsed.decision === "OUT_OF_SCOPE") {
        return {
          ...base,
          sessionId: session.sessionId,
          sessionCreated: session.created,
          raw,
          decision: "OUT_OF_SCOPE",
          skipped: !parsed.body,
          reply: parsed.body || null,
          tokens: result.tokens,
          model: result.model,
        };
      }
      return {
        ...base,
        sessionId: session.sessionId,
        sessionCreated: session.created,
        raw,
        decision: "ANSWERABLE",
        reply: parsed.body,
        tokens: result.tokens,
        model: result.model,
      };
    }
    if (raw.toUpperCase().startsWith(SKIP_TOKEN)) {
      return { ...base, sessionId: session.sessionId, sessionCreated: session.created, raw, skipped: true, tokens: result.tokens, model: result.model };
    }
    return {
      ...base,
      sessionId: session.sessionId,
      sessionCreated: session.created,
      raw,
      reply: raw || null,
      tokens: result.tokens,
      model: result.model,
    };
  } catch (error) {
    await recordKnowledge(false);
    // Outer catch cung classify ORIGINAL error truoc khi lay owner-facing text.
    const failureCode = classifyProviderFailure(error);
    return {
      ...base,
      sessionId: session.sessionId,
      sessionCreated: session.created,
      failureCode,
      error: error.message,
    };
  }
}

export async function tryReply(userMessage, messageObj, options = undefined) {
  // Kenh outcome toi thieu, khai bao ngay trong than ham: cac harness bien dich
  // rieng tryReply nen khong nhin thay module scope. Caller nao khong truyen
  // recorder (direct/non-durable) nhan lai dung string|null nhu truoc.
  const boGhi = typeof options?.recordOutcome === "function" ? options.recordOutcome : null;
  let daGhiKetQua = false;
  const phatKetQua = (outcome) => {
    if (!boGhi || daGhiKetQua) return;
    daGhiKetQua = true;
    try {
      boGhi(outcome);
    } catch (error) {
      console.warn("[ai-chat] Outcome recorder failed:", error?.message || error);
    }
  };
  // Customer-facing string cuoi cung LUON thang moi trang thai loi trung gian.
  const ketThucLuot = (outcome, value) => {
    phatKetQua(typeof value === "string" && value.trim() ? { kind: "DELIVERABLE" } : outcome);
    return value;
  };
  const ghiKetQua = {
    deliverable: (value) => ketThucLuot({ kind: "DELIVERABLE" }, value),
    terminal: (reason, value = null) => ketThucLuot({ kind: "TERMINAL_NO_REPLY", reason }, value),
    // Fail closed: FAILED tuyet doi khong duoc ghi kem failureCode rong.
    failed: (failureCode, ownerText = null, value = null) => ketThucLuot({
      kind: "FAILED",
      failureCode: String(failureCode || "").trim() || "UNKNOWN_PROVIDER_ERROR",
      ownerText: ownerText || null,
    }, value),
  };
  // `existing === true` MOT MINH khong chung minh handoff da duoc persist: phai
  // doc dung row.status dang co. Khong them bat ky DB lookup moi nao o day.
  const ketQuaAdminClarification = (opened) => {
    // Acknowledgement that su den khach thang moi that bai noi bo truoc do.
    if (opened?.acknowledgement) return ghiKetQua.deliverable(opened.acknowledgement);
    if (!opened) return ghiKetQua.failed("UNKNOWN_PROVIDER_ERROR");
    const reason = String(opened.reason || "");
    if (reason === "NOTIFY_CAS_LOST") return ghiKetQua.failed(reason);
    if (reason === "NOTIFY_CONFIRM_CAS_LOST" || reason === "NOTIFY_FAILURE_CAS_LOST") {
      return ghiKetQua.terminal(reason);
    }
    const status = String(opened.row?.status || "");
    if (status === "WAITING_ADMIN" || status === "ADMIN_NOTIFY_SENDING") {
      return ghiKetQua.terminal(status);
    }
    if (status === "ADMIN_NOTIFY_PENDING") return ghiKetQua.failed(status);
    if (reason === "ADMIN_NOTIFY_FAILED") return ghiKetQua.failed(reason);
    // Trang thai ngoai mapping (vi du ADMIN_NOTIFY_UNKNOWN) khong co nhanh rieng
    // va khong sinh DB lookup moi; fail-closed cua durable caller lo phan con lai.
    return null;
  };
  const ownerUid = layChuTaiKhoan();
  const loadedConfig = getConfig(ownerUid);
  const config = loadedConfig ? { ...loadedConfig } : loadedConfig;
  if (config) Object.defineProperty(config, "__deferDecisionProtocolOutcome", { value: true });
  if (messageObj && !shouldProcessMessage(messageObj, config)) {
    await addLog({
      event: "filter_skip",
      level: "warn",
      summary: `Bỏ qua — ${filterSkipReason(messageObj, config)}`,
      detail: {
        ...describeMessage(messageObj),
        allowedGroupId: config?.allowedGroupId || "",
        allowedSenderIds: config?.allowedSenderIds || [],
      },
    });
    // Business filter chay TRUOC AI readiness: truot loc la terminal hop le,
    // bat ke AI da cau hinh xong hay chua.
    return ghiKetQua.terminal("FILTER_SKIP");
  }

  if (messageObj) {
    await addLog({
      event: "filter_pass",
      level: "info",
      summary: "Qua bộ lọc nhóm/nick (chưa trả lời)",
      detail: {
        ...describeMessage(messageObj),
        allowedGroupId: config?.allowedGroupId || "",
        allowedSenderIds: config?.allowedSenderIds || [],
      },
    });
  }

  if (!isAiChatReady(config)) {
    await addLog({
      event: "ai_skip",
      level: "warn",
      summary: "KHÔNG gửi trả lời — AI Chat chưa cấu hình xong (thiếu OpenCode URL / chủ đề / Soul)",
      detail: {
        coOpencodeUrl: Boolean(config?.opencodeBaseUrl?.trim()),
        coChuDe: Boolean(config?.allowedTopics?.trim()),
        coSoul: Boolean(config?.soul?.trim()),
        coVaiTro: Boolean(config?.roleTone?.trim()),
      },
    });
    // Tin da QUA loc ma AI chua cau hinh xong: dang le phai tra loi nhung khong
    // the -> that bai, khong phai "chu dong im lang".
    return ghiKetQua.failed("AI_NOT_CONFIGURED");
  }

  const emailStatusLookup = await websiteEmailStatus.lookupCustomerEmailStatus({
    userMessage,
    messageObj,
    ownerUid,
    privateOneToOne: Number(messageObj?.threadType) === 0,
  });
  if (emailStatusLookup?.outcome === "SENT" && messageObj) {
    messageObj.__emailStatusContext = emailStatusLookup.aiContext;
  }
  if (emailStatusLookup?.outcome === "RATE_LIMITED") {
    return ghiKetQua.deliverable(
      "Hiện mình chưa thể kiểm tra thêm trạng thái email này. Bạn thử lại sau một lúc nhé."
    );
  }
  if (emailStatusLookup?.outcome === "NEEDS_ADMIN") {
    const messageChoAdmin = {
      ...messageObj,
      content: `${String(messageObj?.content || userMessage || "").trim()}\n\n[Vizen] ${emailStatusLookup.adminReasonText}`,
    };
    // Null o day chi xay ra khi openAdminClarification nem loi (da log ben duoi).
    const opened = await openAdminClarification({
      ownerUid,
      message: messageChoAdmin,
      automaticWork: messageObj?.__adminClarificationAutomaticWork || null,
    }).catch(async (error) => {
      await addLog({
        event: "admin_clarification_error",
        level: "error",
        summary: `Không mở được Admin clarification: ${error.message}`,
        detail: { ownerUid, ...describeMessage(messageObj) },
      }).catch(() => {});
      return null;
    });
    if (opened?.acknowledgement && messageObj && opened.row?.id) {
      messageObj.__adminClarificationAckId = opened.row.id;
      messageObj.__adminClarificationFallback = opened.adminClarificationFallback === true;
    }
    if (opened?.row?.id && (opened.opened || opened.existing)) {
      const needAdminLog = typeof canonicalDecisionResultLog === "function"
        ? canonicalDecisionResultLog(
            { needAdmin: true, sessionId: null, model: null },
            { clarificationAccepted: true, ownerUid, message: messageObj }
          )
        : {
            event: "ai_need_admin",
            level: "info",
            summary: "AI cần Admin xác nhận — clarification đã được tiếp nhận",
            detail: { ownerUid, ...describeMessage(messageObj) },
          };
      await addLog(needAdminLog);
    }
    return ketQuaAdminClarification(opened);
  }

  await addLog({
    event: "ai_start",
    level: "info",
    summary: `Gọi OpenCode agent "${config?.opencodeAgent || "general"}"`,
    detail: { ...describeMessage(messageObj), userMessage, baseUrl: config?.opencodeBaseUrl || "" },
  });

  const result = await generateReply(userMessage, messageObj, ownerUid, config);

  if (!result.malformedDecision && result.decision) {
    await recordDecisionProtocolOutcome({
      ownerUid,
      malformed: false,
      automaticWork: messageObj?.__adminClarificationAutomaticWork || null,
    }).catch(() => {});
  }

  if (result.malformedDecision) {
    const contractFailureLog = typeof canonicalDecisionResultLog === "function"
      ? canonicalDecisionResultLog(result, { ownerUid, message: messageObj })
      : {
          event: "ai_output_contract_failure",
          level: "error",
          summary: "AI trả về định dạng quyết định không hợp lệ — đã kích hoạt retry an toàn",
          detail: {
            ownerUid,
            sessionId: result.sessionId || null,
            model: result.model || null,
            reason: result.error || "MALFORMED_DECISION_OUTPUT",
            ...describeMessage(messageObj),
          },
        };
    await addLog(contractFailureLog);
    try {
      await addLog({
        event: "ai_output_contract_retry",
        level: "info",
        summary: "Retry AI với chỉ dẫn sửa giao thức quyết định",
        detail: {
          ownerUid,
          sessionId: result.sessionId || null,
          model: result.model || null,
          parseReason: result.decisionReason || null,
          attempt: 1,
          corrective: true,
          ...describeMessage(messageObj),
        },
      });
      const retryResult = await generateReply(userMessage, messageObj, ownerUid, config, {
        correctiveDecisionRetry: true,
        decisionReason: result.decisionReason,
      });
      if (!retryResult.malformedDecision && !retryResult.error) {
        await recordDecisionProtocolOutcome({
          ownerUid,
          malformed: false,
          automaticWork: messageObj?.__adminClarificationAutomaticWork || null,
        }).catch(() => {});
        Object.assign(result, retryResult);
      } else {
        await recordDecisionProtocolOutcome({
          ownerUid,
          malformed: true,
          automaticWork: messageObj?.__adminClarificationAutomaticWork || null,
        }).catch(() => {});
        await addLog({
          event: "ai_output_contract_fallback",
          level: "warn",
          summary: "Retry quyết định AI chưa hợp lệ — đã chọn fallback an toàn",
          detail: {
            ownerUid,
            sessionId: retryResult.sessionId || result.sessionId || null,
            model: retryResult.model || result.model || null,
            reason: retryResult.error || "MALFORMED_DECISION_OUTPUT",
            retryAttempt: MAX_AI_RETRY,
            ...describeMessage(messageObj),
          },
        });
        // Fallback nay LA cau tra loi that su den khach -> deliverable.
        return ghiKetQua.deliverable(MALFORMED_DECISION_FALLBACK);
      }
    } catch (error) {
      await recordDecisionProtocolOutcome({
        ownerUid,
        malformed: true,
        automaticWork: messageObj?.__adminClarificationAutomaticWork || null,
      }).catch(() => {});
      await addLog({
        event: "ai_output_contract_fallback",
        level: "warn",
        summary: "Retry quyết định AI gặp lỗi — đã chọn fallback an toàn",
        detail: {
          ownerUid,
          sessionId: result.sessionId || null,
          model: result.model || null,
          reason: error?.message || "AI_CONTRACT_RETRY_FAILED",
          retryAttempt: MAX_AI_RETRY,
          ...describeMessage(messageObj),
        },
      });
      return ghiKetQua.deliverable(MALFORMED_DECISION_FALLBACK);
    }
  }

  if (result.error) {
    await addLog({
      event: "ai_error",
      level: "error",
      summary: `KHÔNG gửi trả lời — ${result.error}`,
      detail: { error: result.error, failureCode: result.failureCode || null, sessionId: result.sessionId },
    });
    // failureCode la invariant cua generateReply; neu bat ngo thieu thi van fail
    // closed bang canonical unknown, tuyet doi khong tra null im lang.
    return ghiKetQua.failed(result.failureCode, result.error);
  }

  if (result.needAdmin) {
    // Null o day chi xay ra khi openAdminClarification nem loi (da log ben duoi).
    const opened = await openAdminClarification({
      ownerUid,
      message: messageObj,
      automaticWork: messageObj?.__adminClarificationAutomaticWork || null,
    }).catch(async (error) => {
      await addLog({
        event: "admin_clarification_error",
        level: "error",
        summary: `Không mở được Admin clarification: ${error.message}`,
        detail: { ownerUid, ...describeMessage(messageObj) },
      }).catch(() => {});
      return null;
    });
    if (opened?.acknowledgement && messageObj && opened.row?.id) {
      messageObj.__adminClarificationAckId = opened.row.id;
      messageObj.__adminClarificationFallback = opened.adminClarificationFallback === true;
    }
    if (opened?.row?.id && (opened.opened || opened.existing)) {
      const needAdminLog = typeof canonicalDecisionResultLog === "function"
        ? canonicalDecisionResultLog(result, {
            clarificationAccepted: true,
            ownerUid,
            message: messageObj,
          })
        : {
            event: "ai_need_admin",
            level: "info",
            summary: "AI cần Admin xác nhận — clarification đã được tiếp nhận",
            detail: {
              ownerUid,
              sessionId: result.sessionId || null,
              model: result.model || null,
              decision: "NEED_ADMIN",
              ...describeMessage(messageObj),
            },
          };
      await addLog(needAdminLog);
    }
    return ketQuaAdminClarification(opened);
  }

  if (result.skipped) {
    await addLog({
      event: "ai_skip",
      level: "warn",
      summary: result.decision === "OUT_OF_SCOPE"
        ? "KHÔNG mở clarification — câu hỏi ngoài phạm vi"
        : "KHÔNG gửi trả lời — agent trả về SKIP (tin không thuộc chủ đề cho phép)",
      detail: { raw: result.raw, sessionId: result.sessionId },
    });
    // Chu dong khong gui gi cho khach: terminal hop le, khong retry.
    return ghiKetQua.terminal(result.decision === "OUT_OF_SCOPE"
      ? "OUT_OF_SCOPE"
      : "SKIP");
  }

  if (!result.reply) {
    await addLog({
      event: "ai_skip",
      level: "warn",
      summary: "KHÔNG gửi trả lời — agent trả về nội dung rỗng",
      detail: { raw: result.raw, sessionId: result.sessionId },
    });
    // Da goi AI that su, khong co terminal co chu dinh, ma khong co gi de gui.
    return ghiKetQua.failed("EMPTY_AI_REPLY");
  }

  await addLog({
    event: "ai_response",
    level: "ok",
    summary: "Agent đã trả lời",
    detail: {
      reply: result.reply,
      sessionId: result.sessionId,
      model: result.model,
      tokens: result.tokens,
    },
  });

  return ghiKetQua.deliverable(result.reply);
}

export function scheduleCustomerSummary(config, messageObj, ownerUid) {
  if (!messageObj?.senderId) return false;

  scheduleDetachedBackgroundTask(() =>
    customerMemory
      .ducKetNeuDenLuot(config, messageObj, ownerUid, {
        withCredentialRead: (operation) => ownerCredentials.withCurrentOwnerCredentialRead(
          ownerUid,
          config,
          operation
        ),
      })
      .catch((error) => console.warn("[ho-so] Loi nen:", error.message))
  );
  return true;
}

/** Final clarification generation: canonical prompt + persisted Admin answer. */
export async function generateAdminClarificationFinalReply(prompt, messageObj, ownerUid) {
  const config = getConfig(ownerUid);
  if (!config || !isAiChatReady(config)) throw new Error("AI Chat chưa cấu hình xong");
  const session = await opencode.call(config, "/session", {
    method: "POST",
    body: JSON.stringify({
      title: `Admin clarification ${messageObj?.threadId || "customer"}`,
      agent: config.opencodeAgent || "general",
    }),
  });
  if (!session?.id) throw new Error("Không tạo được final clarification session");
  try {
    // Dedicated ephemeral session: no old OpenCode transcript can contaminate
    // the frozen canonical boundary supplied by clarificationPrompt().
    const result = await opencode.sendPrompt(config, session.id, prompt, { timeoutMs: 30000 });
    const reply = String(result?.reply || "").trim();
    if (!reply) throw new Error("Final clarification generation returned no reply");
    if (messageObj?.senderId) {
      await customerMemory.ducKetNeuDenLuot(config, messageObj, ownerUid);
    }
    return reply;
  } finally {
    await opencode.call(config, `/session/${encodeURIComponent(session.id)}`, {
      method: "DELETE",
    }).catch(() => {});
  }
}
