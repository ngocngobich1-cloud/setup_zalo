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
} from "./opencode.js";
import { buildAppContext, renderAppContext } from "./app-context.js";

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

async function guiVaLuu(ownerUid, config, sessionId, text, files = []) {
  const userText = text.trim();
  if (!userText && files.length === 0) throw new Error("Chưa có nội dung để gửi.");

  // Moi inference Normal nhan snapshot moi. Snapshot la text part rieng va
  // khong duoc dua vao training_messages ben duoi.
  const appContext = await buildAppContext(ownerUid);
  const parts = [{ type: "text", text: renderAppContext(appContext) }];
  if (userText) parts.push({ type: "text", text: userText });
  parts.push(...files.map(toFilePart));

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
  await addTrainingMessage(ownerUid, {
    role: "user",
    content: userText,
    files: files.map((f) => ({ filename: f.originalname, mime: f.mimetype, size: f.size })),
  });
  await addTrainingMessage(ownerUid, { role: "assistant", content: reply, files: [] });
  return reply;
}

export async function guiTinHuanLuyen(ownerUid, text, files = []) {
  const config = await layCauHinhHieuLuc(ownerUid);
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

  const { sessionId } = await ensureSession(ownerUid, config);
  return guiVaLuu(ownerUid, config, sessionId, text, files);
}

const LENH_TONG_HOP = [
  "Dựa trên toàn bộ những gì tôi đã chia sẻ trong phiên này (ảnh chat mẫu, tài liệu, các lời dặn về giọng điệu),",
  "hãy viết ra một đoạn Soul hoàn chỉnh cho bot Zalo.",
  "Yêu cầu: mạch lạc, dùng được ngay, nêu rõ vai trò, cách xưng hô, giọng điệu, nhịp trả lời, những điều nên và không nên.",
  "Chỉ xuất ra nội dung Soul, không thêm lời dẫn hay giải thích.",
].join(" ");

export async function tongHopSoul(ownerUid) {
  const config = await layCauHinhHieuLuc(ownerUid);
  const { sessionId } = await ensureSession(ownerUid, config);
  return guiVaLuu(ownerUid, config, sessionId, LENH_TONG_HOP, []);
}

export async function trangThai(ownerUid) {
  const config = await layCauHinhHieuLuc(ownerUid, { batBuocModel: false });
  return {
    messages: await getTrainingMessages(ownerUid),
    sessionId: await getTrainingSessionId(ownerUid),
    model: config?.opencodeModel || "(chưa chọn model)",
    docDuocAnh: await modelDocDuocAnh(config),
  };
}
