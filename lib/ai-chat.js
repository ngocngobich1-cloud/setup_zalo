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
    ? { ...hieuLuc, botEnabled: rieng.botEnabled, allowedGroupId: rieng.allowedGroupId, allowedSenderIds: rieng.allowedSenderIds }
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

  const threadId = messageObj?.threadId || "global";
  const context = await buildBootstrapContext(threadId, messageObj?.id, config, ownerUid);

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

  const laChatRieng = String(messageObj?.threadType) === String(ThreadType.User);

  // Doc anh/PDF khach gui - CHI trong chat rieng 1-1, va chi khi chi bat.
  // Ban tom tat duoc nhet vao TIN NHAN nay thoi; tep goc khong bao gio vao
  // phien, khong thi moi luot sau deu bi tinh tien doc lai ca tep.
  let loiKhach = userMessage;
  let khoiTep = "";
  if (config.docTep && laChatRieng) {
    const ketQua = await docTep.xuLyTep(config, messageObj).catch((error) => {
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

  try {
    const result = await opencode.sendPrompt(config, session.sessionId, promptDayDu);
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
        soTinLichSu: session.created ? context.soTinLichSu : 0,
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
