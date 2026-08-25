import { getAccountConfig, saveAccountConfig } from "./db.js";
import { laXacNhanOK } from "./admin-command.js";

const CAC_CAU_HOI = [
  ["purpose", "Trợ lý sẽ hỗ trợ chị trong công việc gì?"],
  ["audience", "Trợ lý sẽ trò chuyện chủ yếu với những ai?"],
  ["address", "Chị muốn trợ lý xưng hô với chị và với khách như thế nào?"],
  ["tone", "Chị muốn phong cách và giọng điệu của trợ lý ra sao?"],
  ["topics", "Trợ lý được phép trả lời những chủ đề nào?"],
  ["avoid", "Có nội dung nào trợ lý không nên tự trả lời không?"],
];

const CAU_HOI_THEO_DOI = {
  purpose_detail: {
    question: "Chị mô tả thêm một tình huống thực tế mà trợ lý cần xử lý tốt nhất được không?",
    reason: "vai trò hiện vẫn hơi rộng nên chưa đủ cụ thể để viết instruction vận hành",
  },
  tone_example: {
    question: "Chị cho em một ví dụ ngắn về kiểu câu trả lời đúng giọng chị muốn nhé?",
    reason: "mô tả giọng điệu chưa đủ cụ thể để bot bắt chước nhất quán",
  },
  topics_detail: {
    question: "Trong phạm vi đó, ba nhóm câu hỏi quan trọng nhất mà bot được phép trả lời là gì?",
    reason: "phạm vi chủ đề còn rộng hoặc mơ hồ, dễ làm bot trả lời quá quyền",
  },
  uncertainty: {
    question: "Khi thiếu dữ liệu để kết luận, chị muốn bot hỏi lại khách hay xử lý theo cách nào?",
    reason: "chưa rõ bot phải làm gì khi thiếu thông tin thay vì tự suy đoán",
  },
  escalation: {
    question: "Có trường hợp nào bot bắt buộc phải chuyển lại cho chị hoặc Admin không?",
    reason: "chưa có điều kiện chuyển người thật xử lý",
  },
  boundaries: {
    question: "Có cam kết, quyết định hoặc thông tin nhạy cảm nào bot tuyệt đối không được tự đưa ra không?",
    reason: "chưa đủ boundary để ngăn bot đi quá quyền",
  },
};

const CAC_PHA_DEEP_SETUP = new Set(["", "followup", "proposal", "approved"]);

function gon(value, max = 2000) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function khongDau(value) {
  return gon(value, 4000)
    .toLocaleLowerCase("vi")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

function duLieuAnToan(value) {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const answers = data.answers && typeof data.answers === "object" ? data.answers : {};
  const draft = data.draft && typeof data.draft === "object" ? data.draft : {};
  const rawDeep = data.deepSetup && typeof data.deepSetup === "object" ? data.deepSetup : {};
  const followUpKeys = [...new Set((Array.isArray(rawDeep.followUpKeys) ? rawDeep.followUpKeys : [])
    .map((key) => gon(key, 80))
    .filter((key) => CAU_HOI_THEO_DOI[key]))].slice(0, 8);
  const rawFollowAnswers = rawDeep.followUpAnswers && typeof rawDeep.followUpAnswers === "object"
    ? rawDeep.followUpAnswers
    : {};
  const phase = gon(rawDeep.phase, 24);

  return {
    providerId: gon(data.providerId, 120),
    modelId: gon(data.modelId, 240),
    answers: Object.fromEntries(CAC_CAU_HOI
      .map(([key]) => [key, gon(answers[key])])
      .filter(([, answer]) => answer)),
    deepSetup: {
      phase: CAC_PHA_DEEP_SETUP.has(phase) ? phase : "",
      followUpKeys,
      followUpAnswers: Object.fromEntries(followUpKeys
        .map((key) => [key, gon(rawFollowAnswers[key])])
        .filter(([, answer]) => answer)),
      proposals: (Array.isArray(rawDeep.proposals) ? rawDeep.proposals : []).slice(0, 6).map((item) => ({
        text: gon(item?.text, 1200),
        reason: gon(item?.reason, 1200),
      })).filter((item) => item.text && item.reason),
      revisionNotes: (Array.isArray(rawDeep.revisionNotes) ? rawDeep.revisionNotes : [])
        .map((item) => gon(item, 1200))
        .filter(Boolean)
        .slice(0, 8),
      proposalApproved: Boolean(rawDeep.proposalApproved),
    },
    draft: {
      soul: gon(draft.soul, 8000),
      roleTone: gon(draft.roleTone, 3000),
      allowedTopics: gon(draft.allowedTopics, 3000),
    },
  };
}

export function phanTichKhoangTrong(answers = {}) {
  const keys = [];
  const purpose = gon(answers.purpose);
  const tone = gon(answers.tone);
  const topics = gon(answers.topics);
  const topicsKhongDau = khongDau(topics);

  if (purpose.length < 28) keys.push("purpose_detail");
  if (tone.length < 18) keys.push("tone_example");
  if (topics.length < 18 || /\b(moi|tat ca|bat ky|tuy y)\b/.test(topicsKhongDau)) keys.push("topics_detail");
  keys.push("uncertainty", "escalation", "boundaries");
  return keys;
}

export function taoDeXuatBoSung(answers = {}, followUpAnswers = {}) {
  const purpose = gon(answers.purpose);
  const topics = gon(answers.topics);
  const avoid = gon(answers.avoid);
  const escalation = gon(followUpAnswers.escalation);
  const context = topics || purpose || "phạm vi công việc đã thống nhất";
  const business = khongDau(`${purpose} ${topics}`);
  const proposals = [];

  if (/khoa hoc|dao tao|hoc vien|hoc phi|lop hoc/.test(business)) {
    proposals.push({
      text: `Khi tư vấn ${context}, bot không cam kết kết quả học tập hoặc quyền lợi chưa được xác nhận.`,
      reason: "tránh biến tư vấn khóa học thành một cam kết vượt quá dữ liệu thực tế",
    });
  } else if (/shop|san pham|ban hang|gia|don hang|giao hang/.test(business)) {
    proposals.push({
      text: `Với giá, tồn kho, khuyến mãi hoặc tiến độ liên quan đến ${context}, bot chỉ trả lời từ dữ liệu đã được cung cấp.`,
      reason: "các thông tin bán hàng thay đổi nhanh nên bot không nên tự suy đoán",
    });
  } else if (/dat lich|cuoc hen|lich hen|booking/.test(business)) {
    proposals.push({
      text: `Bot chỉ xác nhận lịch thuộc ${context} sau khi có đủ thời gian, người tham gia và trạng thái lịch hiện tại.`,
      reason: "tránh xác nhận một cuộc hẹn khi dữ liệu lịch chưa đầy đủ",
    });
  } else {
    proposals.push({
      text: `Khi câu hỏi về ${context} cần dữ liệu chưa được cung cấp, bot phải hỏi lại trước khi kết luận.`,
      reason: "giữ câu trả lời hữu ích nhưng không bịa hoặc suy đoán",
    });
  }

  proposals.push({
    text: `Nếu câu hỏi nằm ngoài ${context}, bot nói rõ giới hạn và chuyển sang hướng xử lý đã được chị phê duyệt.`,
    reason: "giữ bot trong đúng phạm vi chủ đề được phép trả lời",
  });

  if (avoid || escalation) {
    proposals.push({
      text: `Khi gặp ${avoid || "tình huống vượt quyền"}, bot dừng kết luận và thực hiện cách chuyển tiếp: ${escalation || "chuyển lại Admin"}.`,
      reason: "biến giới hạn và điều kiện chuyển Admin thành hành vi có thể làm theo",
    });
  }

  return proposals;
}

export function taoBanTongHop(answers = {}, deepSetup = {}) {
  const purpose = gon(answers.purpose);
  const audience = gon(answers.audience);
  const address = gon(answers.address);
  const tone = gon(answers.tone);
  const topics = gon(answers.topics);
  const avoid = gon(answers.avoid);
  const follow = deepSetup.followUpAnswers || {};
  const approvedProposals = deepSetup.proposalApproved ? (deepSetup.proposals || []) : [];
  const approvedLines = approvedProposals.map((item) => `Nguyên tắc đã được chị duyệt: ${gon(item.text, 1200)}`);
  const revisionLines = (deepSetup.revisionNotes || []).map((item) => `Điều chỉnh chị yêu cầu: ${gon(item, 1200)}`);

  return {
    soul: [
      `Vai trò: ${purpose}.`,
      audience ? `Đối tượng trò chuyện chính: ${audience}.` : "",
      `Xưng hô: ${address}.`,
      `Phong cách: ${tone}.`,
      follow.purpose_detail ? `Tình huống trọng tâm: ${follow.purpose_detail}.` : "",
      follow.tone_example ? `Mẫu giọng điệu tham chiếu: ${follow.tone_example}.` : "",
      avoid ? `Giới hạn do chị đặt ra: Không tự trả lời ${avoid}.` : "",
      follow.uncertainty ? `Khi thiếu dữ liệu: ${follow.uncertainty}.` : "",
      follow.escalation ? `Điều kiện chuyển Admin: ${follow.escalation}.` : "",
      follow.boundaries ? `Boundary bắt buộc: ${follow.boundaries}.` : "",
      ...revisionLines,
      ...approvedLines,
    ].filter(Boolean).join("\n"),
    roleTone: [address, tone, follow.tone_example].filter(Boolean).join(". "),
    allowedTopics: [topics, follow.topics_detail].filter(Boolean).join("; "),
  };
}

function tomTatYeuCau(data) {
  const labels = {
    purpose: "Vai trò",
    audience: "Đối tượng",
    address: "Xưng hô",
    tone: "Giọng điệu",
    topics: "Chủ đề",
    avoid: "Nội dung không tự trả lời",
  };
  const lines = CAC_CAU_HOI
    .map(([key]) => data.answers[key] ? `- ${labels[key]}: ${data.answers[key]}` : "")
    .filter(Boolean);
  for (const note of data.deepSetup.revisionNotes) lines.push(`- Điều chỉnh: ${note}`);
  return lines;
}

function promptDeXuat(data) {
  const proposals = data.deepSetup.proposals;
  return [
    "Em đã phân tích phần chị chia sẻ và tách rõ hai nhóm để chị quyết định:",
    "",
    "A. NHỮNG GÌ CHỊ ĐÃ YÊU CẦU",
    ...tomTatYeuCau(data),
    "",
    "B. EM ĐỀ XUẤT BỔ SUNG",
    ...(proposals.length
      ? proposals.flatMap((item, index) => [
          `${index + 1}. ${item.text}`,
          `   Lý do: ${item.reason}`,
        ])
      : ["- Không bổ sung đề xuất nào theo phản hồi gần nhất của chị."]),
    "",
    "Chị trả lời OK nếu đồng ý dùng các đề xuất này để tạo cấu hình cuối.",
    "Nếu chưa đúng, chị có thể nói “Bỏ đề xuất 1”, “Sửa đề xuất 2: ...”, “Bỏ hết đề xuất” hoặc nêu điều chỉnh khác.",
  ].join("\n");
}

function promptCho(state) {
  if (state.completed) return "Trợ lý AI của chị đã được thiết lập xong và sẵn sàng hoạt động.";
  if (state.step === 5) {
    const index = CAC_CAU_HOI.findIndex(([key]) => !state.data.answers[key]);
    return CAC_CAU_HOI[Math.max(0, index)]?.[1] || "Em đã có đủ thông tin ban đầu để phân tích.";
  }
  if (state.step === 6) {
    const deep = state.data.deepSetup;
    const key = deep.followUpKeys.find((item) => !deep.followUpAnswers[item]);
    const item = CAU_HOI_THEO_DOI[key];
    return item
      ? `Em đã phân tích câu trả lời của chị và thấy còn một điểm cần làm rõ: ${item.reason}.\n\n${item.question}`
      : "Em đã đủ thông tin để chuẩn bị đề xuất.";
  }
  if (state.step === 7) return promptDeXuat(state.data);
  return "";
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

export async function xuLyHanhDongOnboarding(ownerUid, action, payload = {}) {
  if (!ownerUid) throw new Error("Chưa đăng nhập Zalo.");
  const state = await trangThaiOnboarding(ownerUid);
  if (state.completed) return state;
  const step = Number(state.step) || 0;
  const data = duLieuAnToan(state.data);

  if (action === "start" && step === 0) return luu(ownerUid, 1, data);
  if (action === "key_link_clicked" && step === 1) return luu(ownerUid, 2, data);
  if (action === "key_saved" && (step === 1 || step === 2)) return luu(ownerUid, 3, data);
  if (action === "model_selected" && step === 3) {
    const providerId = gon(payload.providerId, 120);
    const modelId = gon(payload.modelId, 240);
    if (!providerId || !modelId) throw new Error("Hãy chọn đủ hãng AI và model trước khi tiếp tục.");
    return luu(ownerUid, 4, { ...data, providerId, modelId });
  }
  if (action === "start_bot_setup" && step === 4) return luu(ownerUid, 5, data);
  if (action === "config_saved" && step === 8) return luu(ownerUid, 9, data);
  if (action === "admin_saved" && step === 9) {
    if (!gon(payload.adminUid, 120)) throw new Error("Hãy chọn nick Zalo được phép ra lệnh cho bot.");
    return luu(ownerUid, 9, data, true);
  }
  throw new Error(`Thao tác không hợp lệ ở bước ${step}.`);
}

function dieuChinhDeXuat(data, text) {
  const raw = gon(text, 1200);
  const normalized = khongDau(raw);
  const deep = data.deepSetup;
  const removeAll = /^(bo het de xuat|khong dong y|khong dung de xuat)/.test(normalized);
  const removeMatch = normalized.match(/^(?:bo|xoa) de xuat\s+(\d+)/);
  const editMatch = normalized.match(/^sua de xuat\s+(\d+)\s*:/);

  if (removeAll) {
    deep.proposals = [];
    deep.revisionNotes.push(raw);
    return;
  }
  if (removeMatch) {
    const index = Number(removeMatch[1]) - 1;
    if (deep.proposals[index]) deep.proposals.splice(index, 1);
    deep.revisionNotes.push(raw);
    return;
  }
  if (editMatch) {
    const index = Number(editMatch[1]) - 1;
    const replacement = gon(raw.slice(raw.indexOf(":") + 1), 1200);
    if (deep.proposals[index] && replacement) {
      deep.proposals[index] = {
        text: replacement,
        reason: "Điều chỉnh theo phản hồi trực tiếp của chị.",
      };
    }
    return;
  }
  deep.revisionNotes.push(raw);
}

export async function traLoiOnboarding(ownerUid, text) {
  if (!ownerUid) throw new Error("Chưa đăng nhập Zalo.");
  const state = await trangThaiOnboarding(ownerUid);
  const step = Number(state.step) || 0;
  const noiDung = gon(text);
  if (!noiDung) throw new Error("Chị hãy nhập câu trả lời trước khi gửi.");
  const data = duLieuAnToan(state.data);

  if (step === 5) {
    const next = CAC_CAU_HOI.find(([key]) => !data.answers[key]);
    if (!next) throw new Error("Phần phỏng vấn ban đầu đã hoàn tất.");
    data.answers[next[0]] = noiDung;
    if (CAC_CAU_HOI.every(([key]) => data.answers[key])) {
      data.deepSetup = {
        phase: "followup",
        followUpKeys: phanTichKhoangTrong(data.answers),
        followUpAnswers: {},
        proposals: [],
        revisionNotes: [],
        proposalApproved: false,
      };
      return luu(ownerUid, 6, data);
    }
    return luu(ownerUid, 5, data);
  }

  if (step === 6) {
    const deep = data.deepSetup;
    const key = deep.followUpKeys.find((item) => !deep.followUpAnswers[item]);
    if (!key) throw new Error("Phần phân tích sâu đã đủ thông tin.");
    deep.followUpAnswers[key] = noiDung;
    const remaining = deep.followUpKeys.find((item) => !deep.followUpAnswers[item]);
    if (remaining) return luu(ownerUid, 6, data);
    deep.phase = "proposal";
    deep.proposals = taoDeXuatBoSung(data.answers, deep.followUpAnswers);
    return luu(ownerUid, 7, data);
  }

  if (step === 7) {
    const deep = data.deepSetup;
    if (laXacNhanOK(noiDung)) {
      deep.phase = "approved";
      deep.proposalApproved = true;
      data.draft = taoBanTongHop(data.answers, deep);
      const next = await luu(ownerUid, 8, data);
      return { ...next, confirmationAccepted: true, completedSteps: [6, 7] };
    }
    dieuChinhDeXuat(data, noiDung);
    return luu(ownerUid, 7, data);
  }

  throw new Error("Bước hiện tại không chờ câu trả lời trong Bot Chỉ huy.");
}
