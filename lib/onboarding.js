import { getAccountConfig, getAiChatConfig, saveAccountConfig } from "./db.js";
import { laXacNhanOK } from "./admin-command.js";
import { goiKienTrucSuOnboarding } from "./onboarding-architect.js";
import { resolveEffectiveModelConfig } from "./opencode.js";

const CAC_PHA = new Set(["", "interview", "deep_question", "review", "final_review"]);

function gon(value, max = 4000) {
  return String(value || "").trim().replace(/\r\n/g, "\n").slice(0, max);
}

function mangChuoi(value, maxItems = 60, maxChars = 1600) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => gon(item, maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

function factsAnToan(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(source)
    .slice(0, 40)
    .map(([key, fact]) => [gon(key, 80), gon(
      typeof fact === "string" ? fact : JSON.stringify(fact),
      2400
    )])
    .filter(([key, fact]) => key && fact));
}

function transcriptAnToan(value) {
  return (Array.isArray(value) ? value : []).slice(-80).map((turn) => ({
    role: turn?.role === "assistant" ? "assistant" : "user",
    content: gon(turn?.content, 10000),
  })).filter((turn) => turn.content);
}

function deXuatAnToan(value, status) {
  return (Array.isArray(value) ? value : []).slice(0, 16).map((item, index) => ({
    id: gon(item?.id, 80) || `${status}_${index + 1}`,
    text: gon(item?.text, 1800),
    reason: gon(item?.reason, 1200),
  })).filter((item) => item.text && item.reason);
}

function deXuatTuData(data) {
  if (data?.suggestions && typeof data.suggestions === "object") {
    return {
      pending: deXuatAnToan(data.suggestions.pending, "pending"),
      accepted: deXuatAnToan(data.suggestions.accepted, "accepted"),
      rejected: deXuatAnToan(data.suggestions.rejected, "rejected"),
    };
  }

  // Tương thích dữ liệu onboarding cũ trong lúc nâng cấp; không dùng lại prose
  // deterministic. Sau khi model chạy, state sẽ được ghi theo cấu trúc mới.
  const old = data?.deepSetup && typeof data.deepSetup === "object" ? data.deepSetup : {};
  const proposals = deXuatAnToan(old.proposals, "legacy");
  return {
    pending: old.proposalApproved ? [] : proposals,
    accepted: old.proposalApproved ? proposals : [],
    rejected: [],
  };
}

function duLieuAnToan(value) {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const draft = data.draft && typeof data.draft === "object" ? data.draft : {};
  const oldAnswers = data.answers && typeof data.answers === "object" ? data.answers : {};
  const oldRevisionNotes = Array.isArray(data.deepSetup?.revisionNotes) ? data.deepSetup.revisionNotes : [];
  const phase = gon(data.phase, 40);
  return {
    transcript: transcriptAnToan(data.transcript),
    knownFacts: factsAnToan(Object.keys(data.knownFacts || {}).length ? data.knownFacts : oldAnswers),
    confirmedRequirements: mangChuoi(
      Array.isArray(data.confirmedRequirements) ? data.confirmedRequirements : oldRevisionNotes
    ),
    suggestions: deXuatTuData(data),
    phase: CAC_PHA.has(phase) ? phase : "",
    lastAssistantMessage: gon(data.lastAssistantMessage, 10000),
    modelError: gon(data.modelError, 2000),
    pendingUserText: gon(data.pendingUserText, 10000),
    draft: {
      soul: gon(draft.soul, 16000),
      roleTone: gon(draft.roleTone, 5000),
      allowedTopics: gon(draft.allowedTopics, 5000),
    },
  };
}

function promptCho(state) {
  if (state.completed) return "Trợ lý AI đã được thiết lập xong và sẵn sàng hoạt động.";
  if (![4, 5, 6, 7].includes(Number(state.step))) return "";
  const parts = [state.data.lastAssistantMessage];
  if (state.data.modelError) {
    parts.push(
      `Bot Chỉ huy chưa nhận được phản hồi hợp lệ từ model: ${state.data.modelError}\n\n`
      + "Tiến trình đã được giữ nguyên. Hãy gửi lại câu trả lời để thử lại."
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

function congKhai(config) {
  const data = duLieuAnToan(config.setupData);
  const state = {
    step: config.setupCompleted ? "completed" : Math.max(0, Math.min(9, Number(config.setupStep) || 0)),
    completed: Boolean(config.setupCompleted),
    started: Boolean(config.setupCompleted || Number(config.setupStep) > 0),
    data,
  };
  return { ...state, prompt: promptCho(state) };
}

export async function trangThaiOnboarding(ownerUid) {
  return congKhai(await getAccountConfig(ownerUid));
}

async function luu(ownerUid, step, data, completed = false) {
  return congKhai(await saveAccountConfig(ownerUid, {
    setupStep: completed ? 9 : step,
    setupCompleted: completed,
    setupData: duLieuAnToan(data),
  }));
}

async function coModelHieuLuc(ownerUid) {
  const savedConfig = await getAiChatConfig(ownerUid);
  const effectiveConfig = await resolveEffectiveModelConfig(savedConfig || {});
  return Boolean(gon(effectiveConfig.opencodeModel, 300));
}

function ghiUser(data, text) {
  const content = gon(text, 10000);
  const last = data.transcript[data.transcript.length - 1];
  if (data.pendingUserText && last?.role === "user") {
    last.content = content;
  } else {
    data.transcript.push({ role: "user", content });
  }
  data.transcript = transcriptAnToan(data.transcript);
  data.pendingUserText = content;
  data.modelError = "";
}

function ghiAssistant(data, message) {
  const content = gon(message, 10000);
  data.transcript.push({ role: "assistant", content });
  data.transcript = transcriptAnToan(data.transcript);
  data.lastAssistantMessage = content;
  data.pendingUserText = "";
  data.modelError = "";
}

function capNhatHieuBiet(data, result) {
  data.knownFacts = factsAnToan(result.knownFacts);
  data.confirmedRequirements = mangChuoi(result.confirmedRequirements);
}

function capNhatDeXuat(data, suggestions) {
  const next = { pending: [], accepted: [], rejected: [] };
  for (const item of Array.isArray(suggestions) ? suggestions : []) {
    const status = ["accepted", "rejected"].includes(item.status) ? item.status : "pending";
    next[status].push(item);
  }
  data.suggestions = {
    pending: deXuatAnToan(next.pending, "pending"),
    accepted: deXuatAnToan(next.accepted, "accepted"),
    rejected: deXuatAnToan(next.rejected, "rejected"),
  };
}

function chapNhanDeXuatDangCho(data) {
  const daCo = new Map(data.suggestions.accepted.map((item) => [item.id, item]));
  for (const item of data.suggestions.pending) daCo.set(item.id, item);
  data.suggestions.accepted = [...daCo.values()];
  data.suggestions.pending = [];
}

async function goiModelCoBaoToan(ownerUid, currentStep, modelStep, data) {
  try {
    return await goiKienTrucSuOnboarding(ownerUid, modelStep, data);
  } catch (error) {
    data.modelError = gon(error.message || "OpenCode/model thất bại.", 2000);
    await luu(ownerUid, currentStep, data);
    throw new Error(
      `Bot Chỉ huy chưa xử lý được câu trả lời: ${data.modelError} `
      + "Tiến trình đã được giữ nguyên; hãy thử gửi lại."
    );
  }
}

export async function xuLyHanhDongOnboarding(ownerUid, action, payload = {}) {
  if (!ownerUid) throw new Error("Chưa đăng nhập Zalo.");
  const state = await trangThaiOnboarding(ownerUid);
  if (state.completed) return state;
  const step = Number(state.step) || 0;
  const data = duLieuAnToan(state.data);

  if (action === "start" && step === 0) {
    return (await coModelHieuLuc(ownerUid)) ? luu(ownerUid, 4, data) : luu(ownerUid, 1, data);
  }
  if (action === "key_link_clicked" && step === 1) return luu(ownerUid, 2, data);
  if (action === "key_saved" && (step === 1 || step === 2)) return luu(ownerUid, 3, data);
  if (action === "model_selected" && step === 3) {
    if (!(await coModelHieuLuc(ownerUid))) {
      throw new Error("Hãy chọn đủ hãng AI và model rồi bấm Lưu trước khi tiếp tục.");
    }
    return luu(ownerUid, 4, data);
  }
  if (action === "config_saved" && step === 8) return luu(ownerUid, 9, data);
  if (action === "admin_saved" && step === 9) {
    if (!gon(payload.adminUid, 120)) throw new Error("Hãy chọn nick Zalo được phép ra lệnh cho bot.");
    return luu(ownerUid, 9, data, true);
  }
  throw new Error(`Thao tác không hợp lệ ở bước ${step}.`);
}

async function xuLyStep4(ownerUid, text, data) {
  ghiUser(data, text);
  data.phase = "interview";
  await luu(ownerUid, 4, data);
  const interview = await goiModelCoBaoToan(ownerUid, 4, 5, data);
  capNhatHieuBiet(data, interview);
  ghiAssistant(data, interview.message);
  return luu(ownerUid, 5, data);
}

async function xuLyStep5(ownerUid, text, data) {
  ghiUser(data, text);
  await luu(ownerUid, 5, data);
  const interview = await goiModelCoBaoToan(ownerUid, 5, 5, data);
  capNhatHieuBiet(data, interview);

  if (interview.decision === "ask") {
    data.phase = "interview";
    ghiAssistant(data, interview.message);
    return luu(ownerUid, 5, data);
  }

  // Không hiện một turn trung gian máy móc. Khi model xác nhận đã đủ context
  // nền, Step 6 lập tức dùng chính context đó để chọn một câu hỏi sâu hữu ích.
  const deep = await goiModelCoBaoToan(ownerUid, 5, 6, data);
  capNhatHieuBiet(data, deep);
  capNhatDeXuat(data, deep.suggestions);
  data.phase = deep.decision === "review" ? "review" : "deep_question";
  ghiAssistant(data, deep.message);
  return luu(ownerUid, 6, data);
}

async function xuLyStep6(ownerUid, text, data) {
  ghiUser(data, text);

  if (laXacNhanOK(text) && data.phase === "review") {
    chapNhanDeXuatDangCho(data);
    await luu(ownerUid, 6, data);
    const final = await goiModelCoBaoToan(ownerUid, 6, 7, data);
    data.draft = final.draft;
    data.phase = "final_review";
    ghiAssistant(data, final.message);
    const next = await luu(ownerUid, 7, data);
    return { ...next, proposalAccepted: true, completedSteps: [6] };
  }

  await luu(ownerUid, 6, data);
  const deep = await goiModelCoBaoToan(ownerUid, 6, 6, data);
  capNhatHieuBiet(data, deep);
  capNhatDeXuat(data, deep.suggestions);
  data.phase = deep.decision === "review" ? "review" : "deep_question";
  ghiAssistant(data, deep.message);
  return luu(ownerUid, 6, data);
}

async function xuLyStep7(ownerUid, text, data) {
  if (laXacNhanOK(text)) {
    ghiUser(data, text);
    data.pendingUserText = "";
    data.modelError = "";
    const next = await luu(ownerUid, 8, data);
    return { ...next, confirmationAccepted: true, completedSteps: [7] };
  }

  ghiUser(data, text);
  await luu(ownerUid, 7, data);
  const final = await goiModelCoBaoToan(ownerUid, 7, 7, data);
  data.draft = final.draft;
  data.phase = "final_review";
  ghiAssistant(data, final.message);
  return luu(ownerUid, 7, data);
}

export async function traLoiOnboarding(ownerUid, text) {
  if (!ownerUid) throw new Error("Chưa đăng nhập Zalo.");
  const state = await trangThaiOnboarding(ownerUid);
  const step = Number(state.step) || 0;
  const noiDung = gon(text, 10000);
  if (!noiDung) throw new Error("Hãy nhập câu trả lời trước khi gửi.");
  const data = duLieuAnToan(state.data);
  if (step === 4) return xuLyStep4(ownerUid, noiDung, data);
  if (step === 5) return xuLyStep5(ownerUid, noiDung, data);
  if (step === 6) return xuLyStep6(ownerUid, noiDung, data);
  if (step === 7) return xuLyStep7(ownerUid, noiDung, data);
  throw new Error("Bước hiện tại không chờ câu trả lời trong Bot Chỉ huy.");
}
