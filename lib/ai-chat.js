import { ThreadType } from "zca-js";
import { bumpSessionTurns, getAccountConfig, getAiChatConfig, getThread } from "./db.js";
import { buildRecentHistory } from "./conversation-context.js";
import * as customerMemory from "./customer-memory.js";
import * as emailCheck from "./email-check.js";
import * as docTep from "./doc-tep.js";
import * as knowledge from "./knowledge.js";
import * as opencode from "./opencode.js";
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
import { classifyProviderFailure, ownerFacingFailureMessage } from "./provider-failure.js";

const SKIP_TOKEN = "SKIP";
const KNOWLEDGE_MAX_CHARS = 12000;

/** Nhan tu dong dan len hoi thoai khi khach gui PDF. Doi ten o day la doi ca app. */
const NHAN_PDF = "Bài test";

let configCache = null;
let configCacheOwnerUid = null;

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

/** Gom Soul + vai tro + chu de + tri thuc + lich su gan day de nap vao session moi. */
export async function buildBootstrapContext(threadId, boQuaMessageId, config = getConfig(), ownerUid = layChuTaiKhoan()) {
  if (!config || !ownerUid) throw new Error("Không có AI profile của Zalo UID hiện tại.");
  const { soul, roleTone, allowedTopics, useKnowledge, knowledgeFileIds } = config;

  let knowledgeSection = "";
  if (useKnowledge && Array.isArray(knowledgeFileIds) && knowledgeFileIds.length > 0) {
    try {
      knowledgeSection = await knowledge.getContentsForAi(ownerUid, knowledgeFileIds, KNOWLEDGE_MAX_CHARS);
    } catch (error) {
      console.warn("[ai-chat] Khong lay duoc tri thuc:", error.message);
      await addLog({
        event: "ai_error",
        level: "error",
        summary: "Không đọc được kho tri thức, vẫn nạp Soul không kèm tài liệu",
        detail: { error: error.message, knowledgeFileIds },
      });
    }
  }

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
    knowledgeSection,
    recentHistory,
    threadTitle: thread?.title || threadId,
    hasKnowledge: Boolean(knowledgeSection),
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
 * @returns {{ reply: string|null, sessionId: string|null, sessionCreated: boolean, raw: string|null, skipped: boolean, error: string|null, tokens: object|null, model: string|null }}
 */
function customerRequiredCapabilities(messageObj) {
  const required = [CAPABILITIES.TEXT];
  if (String(messageObj?.msgType || "") === "chat.photo") required.push(CAPABILITIES.IMAGE_INPUT);
  if (String(messageObj?.msgType || "") === "share.file") required.push(CAPABILITIES.FILE_INPUT);
  return required;
}

export async function generateReply(
  userMessage,
  messageObj,
  ownerUid = layChuTaiKhoan(),
  config = getConfig(ownerUid)
) {
  const base = {
    reply: null, sessionId: null, sessionCreated: false, raw: null,
    skipped: false, error: null, tokens: null, model: null,
  };
  if (!config || !ownerUid || !isAiChatReady(config)) return { ...base, error: "AI Chat chưa cấu hình xong" };

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
      return { ...base, error: `Không tải được capability catalog: ${error.message}` };
    }
  }

  const threadId = messageObj?.threadId || "global";
  const excludedMessageIds = messageObj?.sourceIds ?? messageObj?.id;
  const context = await buildBootstrapContext(threadId, excludedMessageIds, config, ownerUid);

  const laChatRieng = String(messageObj?.threadType) === String(ThreadType.User);

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
    return { ...base, error: error.message };
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
  promptDayDu =
    `# BÂY GIỜ\n${mocHienTai()}\n` +
    `(Dùng mốc này để chào đúng buổi và biết khách vừa nghỉ hay đang nói liên tục. ` +
    `Đừng đọc giờ ra thành lời, trừ khi khách hỏi.)\n\n` +
    promptDayDu;

  // Tra cuu email - CHI trong chat rieng 1-1. Trong nhom thi ca lop se nhin
  // thay dia chi email cua nguoi khac.
  if (laChatRieng) {
    const email = emailCheck.timEmailTrongTin(userMessage);
    if (email) {
      const ketQua = await emailCheck
        .traCuu({
          email,
          nguon: "bot",
          nguoiHoiTen: messageObj?.senderName || "",
          nguoiHoiUid: messageObj?.senderId || "",
        })
        .catch((error) => {
          console.warn("[email] Tra cuu that bai:", error.message);
          return null;
        });
      if (ketQua) promptDayDu = emailCheck.moTaChoAgent(ketQua) + promptDayDu;
    }
  }

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
      "# TIN KHÁCH HIỆN TẠI — YÊU CẦU DUY NHẤT CẦN TRẢ LỜI",
      promptDayDu,
    ].join("\n");
  }

  try {
    callBudget.consume();
    let result;
    try {
      result = await opencode.sendPrompt(config, session.sessionId, promptDayDu);
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
        return {
          ...base,
          sessionId: session.sessionId,
          sessionCreated: session.created,
          error: ownerFacingFailureMessage(classifiedReason),
        };
      }
      const secondaryConfig = { ...config, opencodeModel: failover.secondaryModel };
      callBudget.consume({ secondary: true });
      try {
        result = await opencode.sendPrompt(secondaryConfig, session.sessionId, promptDayDu);
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
            outcome: "FAILED",
          },
        }).catch(() => {});
        return {
          ...base,
          sessionId: session.sessionId,
          sessionCreated: session.created,
          error: "AI chưa hoàn tất được yêu cầu. Hệ thống đã giữ lại tin để người phụ trách trả lời.",
        };
      }
    }
    await addLog({
      event: "ai_prompt",
      level: "info",
      summary: context.hasKnowledge
        ? "Bơm prompt vào session OpenCode (Soul có kèm KHO TRI THỨC)"
        : "Bơm prompt vào session OpenCode",
      detail: {
        sessionId: session.sessionId,
        agent: config.opencodeAgent,
        model: config.opencodeModel || "(chưa chọn model)",
        sessionCreated: session.created,
        hasKnowledge: context.hasKnowledge,
        soTinLichSu: context.soTinLichSu,
        soLuotPhien: session.turns ?? 0,
        coHoSoKhach: promptDayDu !== userMessage && promptDayDu.startsWith("# HỒ SƠ"),
        userMessage,
      },
    });
    await bumpSessionTurns(ownerUid, threadId);
    const raw = result.reply;
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
    return { ...base, sessionId: session.sessionId, sessionCreated: session.created, error: error.message };
  }
}

export async function tryReply(userMessage, messageObj) {
  const ownerUid = layChuTaiKhoan();
  const config = getConfig(ownerUid);
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
    return null;
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
    return null;
  }

  await addLog({
    event: "ai_start",
    level: "info",
    summary: `Gọi OpenCode agent "${config?.opencodeAgent || "general"}"`,
    detail: { ...describeMessage(messageObj), userMessage, baseUrl: config?.opencodeBaseUrl || "" },
  });

  const result = await generateReply(userMessage, messageObj, ownerUid, config);

  if (result.error) {
    await addLog({
      event: "ai_error",
      level: "error",
      summary: `KHÔNG gửi trả lời — ${result.error}`,
      detail: { error: result.error, sessionId: result.sessionId },
    });
    return null;
  }

  if (result.skipped) {
    await addLog({
      event: "ai_skip",
      level: "warn",
      summary: "KHÔNG gửi trả lời — agent trả về SKIP (tin không thuộc chủ đề cho phép)",
      detail: { raw: result.raw, sessionId: result.sessionId },
    });
    return null;
  }

  if (!result.reply) {
    await addLog({
      event: "ai_skip",
      level: "warn",
      summary: "KHÔNG gửi trả lời — agent trả về nội dung rỗng",
      detail: { raw: result.raw, sessionId: result.sessionId },
    });
    return null;
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

  // Chay nen. Khach da co cau tra loi roi, khong bat ho cho them mot luot goi
  // model nua chi de he thong ghi chep.
  if (messageObj?.senderId) {
    customerMemory
      .ducKetNeuDenLuot(config, messageObj, ownerUid)
      .catch((error) => console.warn("[ho-so] Loi nen:", error.message));
  }

  return result.reply;
}
