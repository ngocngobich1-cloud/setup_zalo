import {
  deleteOpencodeSession,
  getOpencodeSessionInfo,
  saveOpencodeSession,
} from "./db.js";

const REQUEST_TIMEOUT_MS = 240000;

/**
 * Phien dai bao nhieu luot thi xoay sang phien moi.
 *
 * Moi luot bo them ~200 token vao lich su va lich su duoc gui lai TOAN BO o moi
 * cau tra loi, nen phien khong xoay se tang gia mai khong dung. Xoay het ~2900
 * token (Soul + lich su), nen xoay qua som cung phi. 30 luot giu dau vao quanh
 * 12k token - van an toan ke ca khi doi sang model chi co 32k ngu canh.
 *
 * Xoay khong lam mat tri nho: phien moi duoc nap lai Soul + tin gan nhat tu
 * SQLite + ho so khach.
 */
export const PHIEN_MAX_LUOT = 30;

/**
 * Tat sach tool cua agent. Ca hai luong deu chi can agent VIET CHU:
 *  - bot tra loi khach: khach la nguoi la, mot cau du kheo la agent chay lenh
 *    trong container OpenCode - noi dang giu key API.
 *  - xuong huan luyen: chi can doc anh va viet Soul, khong can dong toi he thong.
 * Fail closed: liet ke tat het thay vi tin vao mac dinh cua OpenCode.
 */
export const KHONG_TOOL = {
  bash: false,
  read: false,
  write: false,
  edit: false,
  glob: false,
  grep: false,
  task: false,
  apply_patch: false,
  webfetch: false,
  websearch: false,
  skill: false,
  todowrite: false,
  question: false,
};

function baseUrl(config) {
  return String(config.opencodeBaseUrl || "").replace(/\/+$/, "");
}

export async function call(config, path, options = {}) {
  const url = `${baseUrl(config)}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(`OpenCode ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("OpenCode không phản hồi (quá thời gian chờ).");
    if (error.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(error.message)) {
      throw new Error(`Không kết nối được OpenCode tại ${baseUrl(config)}. Đã chạy "opencode serve" chưa?`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ngu canh toi thieu de chua noi Soul. Soul + chu de + vai tro da vai nghin ky tu,
 * cong kho tri thuc toi da 12000 ky tu nua; model 4096 token khong chua noi.
 */
const CHAT_MIN_CONTEXT = 8192;

/** Chi giu model chat duoc: vao chu, ra chu, va du ngu canh. */
function isChatModel(model) {
  const capabilities = model?.capabilities || {};
  return (
    capabilities.input?.text === true &&
    capabilities.output?.text === true &&
    Number(model?.limit?.context || 0) >= CHAT_MIN_CONTEXT
  );
}

/**
 * "groq/openai/gpt-oss-120b" -> { providerID: "groq", modelID: "openai/gpt-oss-120b" }
 * Cat o dau gach cheo DAU TIEN: id model cua Groq co san dau gach ben trong
 * (openai/gpt-oss-120b, groq/compound, meta-llama/...), cat het la sai.
 */
export function splitModel(value) {
  const raw = String(value || "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

/**
 * Hai endpoint doi hai dang KHAC NHAU cho cung mot thu:
 *   POST /session              -> model: { providerID, id }
 *   POST /session/{id}/message -> model: { providerID, modelID }
 * Gui sai dang thi OpenCode tra 400 truoc khi cham toi model nao.
 */
function modelForSession(config) {
  const model = splitModel(config.opencodeModel);
  return model ? { model: { providerID: model.providerID, id: model.modelID } } : {};
}

function modelForMessage(config) {
  const model = splitModel(config.opencodeModel);
  return model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {};
}

export async function ping(config) {
  const agents = await call(config, "/agent", { method: "GET" });
  const tools = await call(config, "/experimental/tool/ids", { method: "GET" }).catch(() => []);

  // Provider nao dang co credential thi OpenCode moi tra ve; khong tu bia them.
  let providers = [];
  try {
    const response = await call(config, "/config/providers", { method: "GET" });
    providers = (response.providers || [])
      .map((provider) => ({
        id: provider.id,
        name: provider.name || provider.id,
        models: Object.entries(provider.models || {})
          .filter(([, model]) => isChatModel(model))
          .map(([id, model]) => ({
            id: `${provider.id}/${id}`,
            label: model.name || id,
            context: model.limit?.context || 0,
            beta: model.status === "beta",
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .filter((provider) => provider.models.length > 0);
  } catch {
    // Khong lay duoc danh sach thi de trong, UI se giu nguyen lua chon da luu.
  }

  return {
    agents: agents.map((a) => a.name),
    tools,
    providers,
    models: providers.flatMap((p) => p.models.map((m) => m.id)),
  };
}

/**
 * Tin nhan MO DAU nap vao session moi: Soul + nhiem vu + danh sach tool.
 * Chi gui dung mot lan khi session vua duoc tao.
 */
export function buildBootstrapMessage({ soul, roleTone, allowedTopics, knowledgeSection, recentHistory }) {
  const parts = [];
  parts.push("# SOUL");
  parts.push(soul?.trim() || "(chưa cấu hình Soul)");

  if (roleTone?.trim()) {
    parts.push("", "# VAI TRÒ & GIỌNG ĐIỆU", roleTone.trim());
  }
  if (allowedTopics?.trim()) {
    parts.push("", "# CHỦ ĐỀ ĐƯỢC PHÉP TRẢ LỜI", allowedTopics.trim());
  }
  if (knowledgeSection) {
    parts.push("", "# " + knowledgeSection);
  }

  parts.push(
    "",
    "# NHIỆM VỤ",
    "Bạn đang tư vấn khách hàng qua Zalo. Mỗi tin nhắn tiếp theo tôi gửi vào phiên này là MỘT tin nhắn của khách.",
    "Với mỗi tin, hãy trả lời ĐÚNG nội dung sẽ gửi cho khách, không thêm lời dẫn, không markdown, không giải thích quá trình.",
    "Nếu tin nhắn KHÔNG liên quan đến các chủ đề được phép ở trên, trả lời ĐÚNG MỘT từ: SKIP",
    "Dùng tiếng Việt, ngắn gọn, đúng vai trò và giọng điệu đã mô tả.",
    'Tin có dạng "Tên: nội dung" thì "Tên" là người gửi (chat nhóm), không phải một phần nội dung.',
    'Nếu tin có kèm khối "# HỒ SƠ NGƯỜI ĐANG NHẮN", đó là ghi chú nội bộ để bạn hiểu ngữ cảnh — dùng để trả lời cho nhất quán, KHÔNG đọc lại cho khách.',
    "",
    "# CÁCH TÁCH TIN NHẮN (BẮT BUỘC)",
    "Không viết một đoạn dài. Tách câu trả lời thành 1, 2 hoặc 3 tin nhắn riêng biệt — nhiều hơn nếu thật sự cần — sao cho phù hợp với câu hỏi của khách.",
    "Mỗi tin chỉ từ 1 đến 2 câu ngắn.",
    "Ngăn cách các tin bằng MỘT DÒNG TRỐNG. Hệ thống sẽ cắt theo dòng trống đó và gửi thành từng tin Zalo riêng.",
    'KHÔNG tự viết nhãn "Bubble 1:", "Tin 1:" hay đánh số — khách sẽ nhìn thấy đúng những ký tự đó.',
    "Nếu có KHO TRI THỨC ở trên, ưu tiên thông tin trong tài liệu, tuyệt đối không bịa.",
    "",
    "# CÁCH TIN ĐƯỢC GỬI ĐI",
    "Hệ thống Zalo Web sẽ tự lấy phần trả lời của bạn và gửi vào đúng cuộc trò chuyện.",
    "Bạn KHÔNG cần gọi tool nào để gửi tin, và KHÔNG được tự gửi — làm vậy khách sẽ nhận trùng hai lần."
  );

  parts.push(
    "",
    "# CÔNG CỤ",
    "Phiên này KHÔNG có tool nào. Bạn chỉ trả lời bằng chữ, không chạy lệnh, không đọc/ghi tệp.",
    "Nếu cần thông tin không có sẵn, hãy nói thẳng là chưa có thay vì tìm cách tra cứu."
  );

  // Dat SAT CUOI, sau toan bo phan tinh. Soul + tri thuc giong het nhau o moi
  // cuoc tro chuyen nen duoc nha cung cap cache lai; nhet lich su (khac nhau
  // tung nguoi) vao giua se lam vo cache cua tat ca nhung gi dung sau no.
  if (recentHistory) {
    parts.push(
      "",
      "# CUỘC TRÒ CHUYỆN TRƯỚC ĐÓ",
      "Dưới đây là các tin đã trao đổi trước đây trong ĐÚNG cuộc trò chuyện này — cũ ở trên, mới ở dưới.",
      'Dòng bắt đầu bằng "Bạn (đã trả lời):" là lời của chính bạn.',
      "Hãy nhớ những gì đã nói để không hỏi lại điều đã biết, không mâu thuẫn với chính mình, không đổi giọng.",
      "KHÔNG trả lời lại các tin này — chúng chỉ để bạn nắm ngữ cảnh.",
      "",
      recentHistory
    );
  }

  parts.push("", "Nếu bạn đã nắm nhiệm vụ, trả lời đúng một từ: READY");
  return parts.join("\n");
}

/**
 * Xoa han cac session ben OpenCode. Loi cua tung session khong duoc lam hong
 * ca me: doi Soul la viec chi vua bam Luu, khong the vi mot session da chet ma
 * bao loi ve giao dien.
 */
export async function deleteSessions(config, sessionIds) {
  let daXoa = 0;
  for (const id of sessionIds || []) {
    try {
      await call(config, `/session/${encodeURIComponent(id)}`, { method: "DELETE" });
      daXoa++;
    } catch (error) {
      if (error.status !== 404) {
        console.warn("[opencode] Khong xoa duoc session", id, error.message);
      }
    }
  }
  return daXoa;
}

/**
 * Chay mot viec le bang session dung-mot-lan roi xoa ngay. Dung cho cac tac vu
 * he thong (duc ket ho so khach) - chung KHONG duoc lot vao phien dang noi
 * chuyen voi khach, neu khong cau lenh ghi chep se nam trong lich su va anh
 * huong den moi cau tra loi sau do.
 */
/** @param {string|Array} prompt chuoi chu, hoac mang part (co the kem tep). */
export async function runOneShot(config, title, prompt) {
  const session = await call(config, "/session", {
    method: "POST",
    body: JSON.stringify({
      title,
      agent: config.opencodeAgent || "general",
      ...modelForSession(config),
    }),
  });

  try {
    const response = await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
      method: "POST",
      body: JSON.stringify({
        agent: config.opencodeAgent || "general",
        ...modelForMessage(config),
        tools: KHONG_TOOL,
        parts: Array.isArray(prompt) ? prompt : [{ type: "text", text: prompt }],
      }),
    });
    if (response?.info?.error) {
      throw new Error(`OpenCode lỗi: ${JSON.stringify(response.info.error).slice(0, 300)}`);
    }
    return { text: extractReply(response), tokens: response?.info?.tokens || null };
  } finally {
    await deleteSessions(config, [session.id]);
  }
}

/** Lay session cua thread; chua co, da chet hoac qua dai thi tao moi va nap Soul. */
export async function ensureSession(config, ownerUid, threadId, bootstrapContext, onEvent) {
  if (!ownerUid) throw new Error("ensureSession: thieu ownerUid - khong dung phien cua tai khoan khac.");
  const existing = await getOpencodeSessionInfo(ownerUid, threadId);
  let xoayTuPhien = null;
  let soLuotCu = 0;

  if (existing && existing.turns >= PHIEN_MAX_LUOT) {
    // Xoay phien. An toan vi phien moi duoc nap lai Soul + lich su + ho so.
    xoayTuPhien = existing.sessionId;
    soLuotCu = existing.turns;
    await deleteSessions(config, [existing.sessionId]);
    await deleteOpencodeSession(ownerUid, threadId);
  } else if (existing) {
    try {
      await call(config, `/session/${encodeURIComponent(existing.sessionId)}`, { method: "GET" });
      return { sessionId: existing.sessionId, created: false, turns: existing.turns };
    } catch (error) {
      // Session bien mat phia OpenCode (restart, xoa...) -> bo di va tao lai.
      if (error.status !== 404) throw error;
      await deleteOpencodeSession(ownerUid, threadId);
    }
  }

  const session = await call(config, "/session", {
    method: "POST",
    body: JSON.stringify({
      title: `Zalo - ${bootstrapContext.threadTitle || threadId}`,
      agent: config.opencodeAgent || "general",
      ...modelForSession(config),
    }),
  });

  await saveOpencodeSession(ownerUid, threadId, session.id);

  const bootstrap = buildBootstrapMessage(bootstrapContext);
  await onEvent?.({ sessionId: session.id, bootstrap, xoayTuPhien, soLuotCu });

  await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
    method: "POST",
    body: JSON.stringify({
      agent: config.opencodeAgent || "general",
      ...modelForMessage(config),
      tools: KHONG_TOOL,
      parts: [{ type: "text", text: bootstrap }],
    }),
  });

  return { sessionId: session.id, created: true, turns: 0, xoayTuPhien, soLuotCu };
}

/**
 * Chi lay cac part type="text". Part "reasoning" la suy nghi noi bo cua agent,
 * gui cho khach la lo toan bo mach suy luan.
 */
export function extractReply(response) {
  return (response?.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/* --- QUAN LY KHOA API CUA CAC HANG --- */

/** Danh muc day du cac hang OpenCode ho tro + hang nao dang co key. */
export async function listAllProviders(config) {
  const response = await call(config, "/provider", { method: "GET" });
  const connected = new Set(response.connected || []);
  return (response.all || [])
    .map((provider) => ({
      id: provider.id,
      name: provider.name || provider.id,
      connected: connected.has(provider.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Nap key cho mot hang. Key di THANG sang OpenCode, app khong luu ban sao.
 * Khong nhan chuoi rong: OpenCode se dung dung chuoi rong lam key va lam hong
 * hang do, chu KHONG quay ve mac dinh.
 */
export async function setProviderKey(config, providerId, apiKey) {
  const id = String(providerId || "").trim();
  const key = String(apiKey || "").trim();
  if (!id) throw new Error("Thiếu tên hãng.");
  if (!key) throw new Error("Key trống sẽ làm hỏng hãng này. Nhập key thật hoặc để nguyên.");

  await call(config, "/global/config", {
    method: "PATCH",
    body: JSON.stringify({ provider: { [id]: { options: { apiKey: key } } } }),
  });
}

/**
 * OpenCode chi cho xoa TOAN BO khoi provider, khong xoa duoc rieng tung hang:
 *   {"provider":{"groq":null}} -> 400
 *   {"provider":{}}            -> 200 nhung khong xoa gi
 *   {"provider":null}          -> 200, xoa sach
 */
export async function clearAllProviderKeys(config) {
  await call(config, "/global/config", {
    method: "PATCH",
    body: JSON.stringify({ provider: null }),
  });
}

/**
 * Goi that mot cau bang model cua hang do. Bat buoc phai co: danh sach model van
 * hien day du ngay ca khi key da het han, nhin giao dien khong the biet key song hay chet.
 */
const TEST_MAX_MODELS = 3;

export async function testProviderKey(config, providerId) {
  const providers = await call(config, "/config/providers", { method: "GET" });
  const provider = (providers.providers || []).find((p) => p.id === providerId);
  const all = Object.entries(provider?.models || {})
    .filter(([, model]) => isChatModel(model))
    .map(([id]) => id);
  if (all.length === 0) throw new Error("Hãng này chưa có model chat được. Key đã nạp chưa?");

  // Mot model rieng le co the tu choi vi ly do khac (chua mo goi, ngung phuc vu)
  // chu khong phai key hong. Thu vai model roi moi ket luan, neu khong se bao
  // "key hong" oan cho mot key van dung tot. Uu tien model dang duoc chon.
  const dangChon = splitModel(config.opencodeModel);
  const uuTien = dangChon?.providerID === providerId ? dangChon.modelID : null;
  const danhSach = [...new Set([uuTien, ...all].filter(Boolean))].slice(0, TEST_MAX_MODELS);

  const session = await call(config, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "Kiem tra key", agent: config.opencodeAgent || "general" }),
  });

  const loi = [];
  try {
    for (const modelID of danhSach) {
      const response = await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
        method: "POST",
        body: JSON.stringify({
          agent: config.opencodeAgent || "general",
          model: { providerID: providerId, modelID },
          parts: [{ type: "text", text: "Trả lời đúng một từ: OK" }],
        }),
      }).catch((error) => ({ info: { error: { data: { message: error.message } } } }));

      if (!response?.info?.error) {
        return { model: `${providerId}/${modelID}`, reply: extractReply(response), daThu: danhSach.length };
      }
      loi.push(`${modelID}: ${response.info.error?.data?.message || response.info.error?.name || "không rõ"}`);
    }
    throw new Error(`thử ${danhSach.length} model đều lỗi — ${loi.join(" | ")}`);
  } finally {
    await call(config, `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" }).catch(() => {});
  }
}

export async function sendPrompt(config, sessionId, text) {
  const response = await call(config, `/session/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    body: JSON.stringify({
      agent: config.opencodeAgent || "general",
      ...modelForMessage(config),
      tools: KHONG_TOOL,
      parts: [{ type: "text", text }],
    }),
  });

  if (response?.info?.error) {
    throw new Error(`OpenCode lỗi: ${JSON.stringify(response.info.error).slice(0, 300)}`);
  }
  return {
    reply: extractReply(response),
    tokens: response?.info?.tokens || null,
    model: `${response?.info?.providerID || "?"}/${response?.info?.modelID || "?"}`,
  };
}
