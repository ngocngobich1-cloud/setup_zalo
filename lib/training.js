import {
  addTrainingMessage,
  getAiChatConfig,
  getTrainingMessages,
  getTrainingSessionId,
  saveTrainingSessionId,
} from "./db.js";
import { call, extractReply, splitModel, KHONG_TOOL } from "./opencode.js";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 6;
const ANH_HOP_LE = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const FILE_HOP_LE = ["application/pdf", "text/plain", "text/markdown", "text/csv"];

export function isSupportedUpload(mime) {
  return ANH_HOP_LE.includes(mime) || FILE_HOP_LE.includes(mime);
}

/**
 * Xuong huan luyen co nhiem vu KHAC HAN bot tra loi khach: o day agent giup chu
 * shop soan Soul, khong dong vai tro ly tra loi khach.
 */
function bootstrapHuanLuyen(config) {
  return [
    "# VAI TRÒ CỦA BẠN Ở PHIÊN NÀY",
    "Bạn KHÔNG phải trợ lý trả lời khách. Bạn đang giúp chủ shop soạn phần 'Soul' — bản mô tả nhân cách và cách nói chuyện cho một bot Zalo.",
    "",
    "# CÁCH LÀM VIỆC",
    "Chủ shop sẽ gửi ảnh chụp các đoạn chat mẫu, file tài liệu, và những lời dặn rời rạc về giọng điệu.",
    "Nhiệm vụ của bạn: đọc kỹ, rút ra cách xưng hô, giọng điệu, nhịp trả lời, những điều nên và không nên.",
    "Khi được yêu cầu tổng hợp, hãy viết ra một đoạn Soul hoàn chỉnh, mạch lạc, dùng ngay được.",
    "",
    "# QUY TẮC",
    "Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào việc.",
    "Khi chưa đủ thông tin, hãy hỏi lại chủ shop thay vì tự bịa ra phong cách.",
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

async function ensureSession(config) {
  const daCo = await getTrainingSessionId();
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
  await saveTrainingSessionId(session.id);

  await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
    method: "POST",
    body: JSON.stringify({
      agent: config.opencodeAgent || "general",
      ...modelForMessage(config),
      tools: KHONG_TOOL,
      parts: [{ type: "text", text: bootstrapHuanLuyen(config) }],
    }),
  });
  return { sessionId: session.id, created: true };
}

/** Model nao doc duoc anh - de UI khong cho dan anh vao model mu. */
export async function modelDocDuocAnh(config) {
  const model = splitModel(config.opencodeModel);
  try {
    const providers = await call(config, "/config/providers", { method: "GET" });
    if (!model) {
      // Dung model mac dinh cua OpenCode: khong biet chac la con nao, bao khong ho tro
      // con hon hua bua roi anh gui di khong ai doc.
      return false;
    }
    const found = (providers.providers || []).find((p) => p.id === model.providerID);
    return Boolean(found?.models?.[model.modelID]?.capabilities?.input?.image);
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

async function guiVaLuu(config, sessionId, text, files = []) {
  const parts = [...files.map(toFilePart)];
  if (text.trim()) parts.push({ type: "text", text: text.trim() });
  if (parts.length === 0) throw new Error("Chưa có nội dung để gửi.");

  const response = await call(config, `/session/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    body: JSON.stringify({
      agent: config.opencodeAgent || "general",
      ...modelForMessage(config),
      tools: KHONG_TOOL,
      parts,
    }),
  });
  if (response?.info?.error) {
    throw new Error(response.info.error?.data?.message || response.info.error?.name || "OpenCode lỗi");
  }

  const reply = extractReply(response);
  await addTrainingMessage({
    role: "user",
    content: text.trim(),
    files: files.map((f) => ({ filename: f.originalname, mime: f.mimetype, size: f.size })),
  });
  await addTrainingMessage({ role: "assistant", content: reply, files: [] });
  return reply;
}

export async function guiTinHuanLuyen(text, files = []) {
  const config = await getAiChatConfig();
  if (!config?.opencodeBaseUrl?.trim()) throw new Error("Chưa cấu hình địa chỉ OpenCode.");

  for (const file of files) {
    if (!isSupportedUpload(file.mimetype)) throw new Error(`Không nhận định dạng ${file.mimetype}.`);
  }
  if (files.length > MAX_FILES_PER_MESSAGE) {
    throw new Error(`Tối đa ${MAX_FILES_PER_MESSAGE} tệp mỗi lần gửi.`);
  }
  if (files.some((f) => ANH_HOP_LE.includes(f.mimetype)) && !(await modelDocDuocAnh(config))) {
    throw new Error("Model đang chọn không đọc được ảnh. Hãy đổi sang model có hỗ trợ ảnh trước khi gửi.");
  }

  const { sessionId } = await ensureSession(config);
  return guiVaLuu(config, sessionId, text, files);
}

const LENH_TONG_HOP = [
  "Dựa trên toàn bộ những gì tôi đã chia sẻ trong phiên này (ảnh chat mẫu, tài liệu, các lời dặn về giọng điệu),",
  "hãy viết ra một đoạn Soul hoàn chỉnh cho bot Zalo.",
  "Yêu cầu: mạch lạc, dùng được ngay, nêu rõ vai trò, cách xưng hô, giọng điệu, nhịp trả lời, những điều nên và không nên.",
  "Chỉ xuất ra nội dung Soul, không thêm lời dẫn hay giải thích.",
].join(" ");

export async function tongHopSoul() {
  const config = await getAiChatConfig();
  const { sessionId } = await ensureSession(config);
  return guiVaLuu(config, sessionId, LENH_TONG_HOP, []);
}

export async function trangThai() {
  const config = await getAiChatConfig();
  return {
    messages: await getTrainingMessages(),
    sessionId: await getTrainingSessionId(),
    model: config?.opencodeModel || "(mặc định của OpenCode)",
    docDuocAnh: await modelDocDuocAnh(config),
  };
}
