import { ThreadType } from "zca-js";
import { bumpSessionTurns, getAiChatConfig, getThread } from "./db.js";
import { buildRecentHistory } from "./conversation-context.js";
import * as customerMemory from "./customer-memory.js";
import * as emailCheck from "./email-check.js";
import * as docTep from "./doc-tep.js";
import * as knowledge from "./knowledge.js";
import * as opencode from "./opencode.js";
import { addLog } from "./activity-log.js";
import { mocHienTai } from "./moc-gio.js";

const SKIP_TOKEN = "SKIP";
const KNOWLEDGE_MAX_CHARS = 12000;

/** Nhan tu dong dan len hoi thoai khi khach gui PDF. Doi ten o day la doi ca app. */
const NHAN_PDF = "Bài test";

let configCache = null;

/** Ham gan nhan cua zalo-service, truyen tu server.js de tranh vong import. */
let ganNhanTuDong = null;
export function capHinhGanNhan(fn) {
  ganNhanTuDong = fn;
}

export async function loadConfig() {
  configCache = await getAiChatConfig();
}

export async function refreshConfig() {
  await loadConfig();
}

/**
 * Soul la BAT BUOC. Co chu y: doi engine tu Groq sang OpenCode lam mat dieu kien
 * "co Groq key", neu khong bat buoc Soul thi cau hinh cu se bong dung du dieu kien
 * va bot tu dong tra loi that vao moi cuoc tro chuyen ma chua ai kip duyet.
 */
export function isAiChatReady() {
  if (!configCache) return false;
  const { allowedTopics, soul, opencodeBaseUrl } = configCache;
  return Boolean(opencodeBaseUrl?.trim() && allowedTopics?.trim() && soul?.trim());
}

export function getConfig() {
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
export async function buildBootstrapContext(threadId, boQuaMessageId) {
  const { soul, roleTone, allowedTopics, useKnowledge, knowledgeFileIds } = configCache;

  let knowledgeSection = "";
  if (useKnowledge && Array.isArray(knowledgeFileIds) && knowledgeFileIds.length > 0) {
    try {
      knowledgeSection = await knowledge.getContentsForAi(knowledgeFileIds, KNOWLEDGE_MAX_CHARS);
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

  const thread = threadId ? await getThread(threadId).catch(() => null) : null;
  const recentHistory = await buildRecentHistory(threadId, boQuaMessageId);
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

export function shouldProcessMessage(message) {
  if (!configCache) return false;
  const { allowedGroupId, allowedSenderIds } = configCache;

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
function filterSkipReason(message) {
  const { allowedGroupId, allowedSenderIds } = configCache || {};
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
export async function generateReply(userMessage, messageObj) {
  const base = {
    reply: null, sessionId: null, sessionCreated: false, raw: null,
    skipped: false, error: null, tokens: null, model: null,
  };
  if (!isAiChatReady()) return { ...base, error: "AI Chat chưa cấu hình xong" };

  const threadId = messageObj?.threadId || "global";
  const context = await buildBootstrapContext(threadId, messageObj?.id);

  let session;
  try {
    session = await opencode.ensureSession(
      configCache,
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
            agent: configCache.opencodeAgent,
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

  const laChatRieng = String(messageObj?.threadType) === String(ThreadType.User);

  // Doc anh/PDF khach gui - CHI trong chat rieng 1-1, va chi khi chi bat.
  // Ban tom tat duoc nhet vao TIN NHAN nay thoi; tep goc khong bao gio vao
  // phien, khong thi moi luot sau deu bi tinh tien doc lai ca tep.
  let loiKhach = userMessage;
  let khoiTep = "";
  if (configCache.docTep && laChatRieng) {
    const ketQua = await docTep.xuLyTep(configCache, messageObj).catch((error) => {
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

  // Ho so khach di kem TIN NHAN chu khong nam trong bootstrap: mot phien nhom
  // co nhieu khach, moi nguoi can ho so cua rieng minh khi ho len tieng.
  let promptDayDu = await customerMemory
    .bocPrompt(session.sessionId, messageObj, loiKhach)
    .catch(() => loiKhach);
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

  await addLog({
    event: "ai_prompt",
    level: "info",
    summary: context.hasKnowledge
      ? "Bơm prompt vào session OpenCode (Soul có kèm KHO TRI THỨC)"
      : "Bơm prompt vào session OpenCode",
    detail: {
      sessionId: session.sessionId,
      agent: configCache.opencodeAgent,
      model: configCache.opencodeModel || "(mặc định của OpenCode)",
      sessionCreated: session.created,
      hasKnowledge: context.hasKnowledge,
      soTinLichSu: session.created ? context.soTinLichSu : 0,
      soLuotPhien: session.turns ?? 0,
      coHoSoKhach: promptDayDu !== userMessage && promptDayDu.startsWith("# HỒ SƠ"),
      userMessage,
    },
  });

  try {
    const result = await opencode.sendPrompt(configCache, session.sessionId, promptDayDu);
    await bumpSessionTurns(threadId);
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
  if (messageObj && !shouldProcessMessage(messageObj)) {
    await addLog({
      event: "filter_skip",
      level: "warn",
      summary: `Bỏ qua — ${filterSkipReason(messageObj)}`,
      detail: {
        ...describeMessage(messageObj),
        allowedGroupId: configCache?.allowedGroupId || "",
        allowedSenderIds: configCache?.allowedSenderIds || [],
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
        allowedGroupId: configCache?.allowedGroupId || "",
        allowedSenderIds: configCache?.allowedSenderIds || [],
      },
    });
  }

  if (!isAiChatReady()) {
    await addLog({
      event: "ai_skip",
      level: "warn",
      summary: "KHÔNG gửi trả lời — AI Chat chưa cấu hình xong (thiếu OpenCode URL / chủ đề / Soul)",
      detail: {
        coOpencodeUrl: Boolean(configCache?.opencodeBaseUrl?.trim()),
        coChuDe: Boolean(configCache?.allowedTopics?.trim()),
        coSoul: Boolean(configCache?.soul?.trim()),
        coVaiTro: Boolean(configCache?.roleTone?.trim()),
      },
    });
    return null;
  }

  await addLog({
    event: "ai_start",
    level: "info",
    summary: `Gọi OpenCode agent "${configCache.opencodeAgent}"`,
    detail: { ...describeMessage(messageObj), userMessage, baseUrl: configCache.opencodeBaseUrl },
  });

  const result = await generateReply(userMessage, messageObj);

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
      .ducKetNeuDenLuot(configCache, messageObj)
      .catch((error) => console.warn("[ho-so] Loi nen:", error.message));
  }

  return result.reply;
}
