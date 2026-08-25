import { datDieuPhoiOnboarding, hienTinOnboarding, napHuanLuyen } from "./training.js";

const els = {
  firstRun: document.querySelector("#first-run-modal"),
  btnStart: document.querySelector("#btn-onboarding-start"),
  btnLater: document.querySelector("#btn-onboarding-later"),
  coach: document.querySelector("#onboarding-coach"),
  highlight: document.querySelector("#onboarding-highlight"),
  bubble: document.querySelector("#onboarding-bubble"),
  bubbleStep: document.querySelector("#onboarding-bubble-step"),
  bubbleTitle: document.querySelector("#onboarding-bubble-title"),
  bubbleBody: document.querySelector("#onboarding-bubble-body"),
  bubbleActions: document.querySelector("#onboarding-bubble-actions"),
  dismiss: document.querySelector("#onboarding-dismiss"),
  progress: document.querySelector("#onboarding-progress"),
  keyLinks: document.querySelector("#onboarding-key-links"),
  trainingPanel: document.querySelector("#module-training"),
};

const portalSpecs = [
  ["#ai-key-provider", ".key-block", "#onboarding-slot-api-key", null],
  ["#ai-oc-provider", ".smtp-grid", "#onboarding-slot-model", "ai-chat-form"],
  ["#ai-soul", ".form-group", "#onboarding-slot-soul", "ai-chat-form"],
  ["#ai-role", ".form-group", "#onboarding-slot-tone", "ai-chat-form"],
  ["#ai-topics", ".form-group", "#onboarding-slot-topics", "ai-chat-form"],
  ["#ai-status", ".form-actions", "#onboarding-slot-ai-actions", "ai-chat-form"],
  ["#admin-zalo", ".form-group", "#onboarding-slot-admin", "otp-settings-form"],
  ["#otp-settings-status", ".form-actions", "#onboarding-slot-admin-actions", "otp-settings-form"],
];

const BUOC = {
  1: {
    target: "#onboarding-key-links",
    title: "Lấy API key",
    body: "Lấy API key miễn phí ở một trong các link bên cạnh. Link mở ở tab mới nên chị không rời khỏi ứng dụng.",
  },
  2: {
    target: "[data-canonical-slot='api-key']",
    title: "Dán và lưu API key",
    body: "Quay lại đây, chọn hãng, dán API key vào ô và bấm Lưu key. Chỉ khi lưu thành công em mới chuyển bước.",
  },
  3: {
    target: "[data-canonical-slot='model']",
    title: "Chọn hãng AI và model",
    body: "Chọn hãng AI và model chị muốn dùng. Lựa chọn được giữ trong tiến trình và sẽ lưu cùng cấu hình ở bước 8.",
    cta: "Tiếp tục",
    action: "model_selected",
  },
  4: {
    target: "#training-log",
    title: "Phần kết nối AI đã xong",
    body: "Bây giờ mình bắt đầu thiết lập trợ lý. Bot Chỉ huy sẽ hỏi từng câu, phân tích điểm còn thiếu và cùng chị duyệt đề xuất trước khi tạo cấu hình.",
    cta: "Bắt đầu setup bot",
    action: "start_bot_setup",
  },
  5: {
    target: "#training-log",
    title: "Bot Chỉ huy đang phỏng vấn",
    body: "Chị trả lời từng câu một. Em sẽ dùng câu trả lời để hiểu vai trò, đối tượng, cách xưng hô, giọng điệu, phạm vi và giới hạn của trợ lý.",
  },
  6: {
    target: "#training-log",
    title: "Phân tích sâu và làm rõ",
    body: "Em đang kiểm tra những điểm còn thiếu hoặc dễ làm bot suy đoán. Mỗi lần em chỉ hỏi thêm một câu; ô chat luôn sẵn để chị trả lời.",
  },
  7: {
    target: "#training-log",
    title: "Duyệt đề xuất trước khi tạo cấu hình",
    body: "Em tách rõ điều chị đã yêu cầu và phần em đề xuất kèm lý do. Chị có thể bỏ, sửa, bổ sung hoặc trả lời OK để duyệt.",
  },
  8: {
    target: [
      "[data-canonical-slot='soul']",
      "[data-canonical-slot='tone']",
      "[data-canonical-slot='topics']",
    ],
    title: "Đọc lại toàn bộ cấu hình",
    body: "Em đã viết lại cấu hình trợ lý dựa trên những gì chị chia sẻ và các nguyên tắc chị vừa duyệt. Chị đọc lại toàn bộ Soul, Giọng điệu và Chủ đề được phép trả lời giúp em. Nếu có điểm nào chưa đúng, chị có thể sửa trực tiếp trong các ô.",
    cta: "Đã đọc xong",
    action: "review_complete",
  },
  9: {
    target: "[data-canonical-slot='admin']",
    title: "Chọn Admin",
    body: "Bước cuối: chọn nick Zalo được phép ra lệnh cho bot qua hội thoại, rồi bấm Lưu.",
  },
};

const BUOC_LUU_CAU_HINH = {
  target: "#onboarding-slot-ai-actions button[type='submit']",
  title: "Lưu cấu hình đã duyệt",
  body: "Nếu cấu hình đã ổn, chị bấm Ghi nhớ giúp em nhé.",
};

let state = null;
let callbacks = null;
let portalRecords = [];
let trainingActive = false;
let currentTarget = null;
let loginTimer = null;
let lastOwnerUid = null;
let initialized = false;
let completionJustReached = false;
let deferredThisSession = false;
let reviewReadyToSave = false;

async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Không thực hiện được.");
  return data;
}

function capNhatState(next) {
  const previousStep = Number(state?.step) || 0;
  const nextStep = Number(next?.step) || 0;
  state = next;
  if (nextStep !== 8 || previousStep !== 8) reviewReadyToSave = false;
  return state;
}

async function napTrangThai() {
  return capNhatState(await jsonFetch("/api/onboarding"));
}

async function hanhDong(action, payload = {}) {
  capNhatState(await jsonFetch("/api/onboarding/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  }));
  await render();
  return state;
}

function thuThapPortal() {
  if (portalRecords.length) return;
  for (const [anchorSelector, closestSelector, slotSelector, formId] of portalSpecs) {
    const anchor = document.querySelector(anchorSelector);
    const node = anchor?.closest(closestSelector);
    const slot = document.querySelector(slotSelector);
    if (!node || !slot || portalRecords.some((record) => record.node === node)) continue;
    const marker = document.createComment(`canonical:${anchorSelector}`);
    node.parentNode.insertBefore(marker, node);
    if (formId) {
      node.querySelectorAll("input, select, textarea, button").forEach((control) => {
        if (!control.hasAttribute("form")) control.setAttribute("form", formId);
      });
    }
    portalRecords.push({ node, marker, slot });
  }
}

export function ganControlCanonical() {
  thuThapPortal();
  for (const record of portalRecords) record.slot.append(record.node);
  document.querySelector("#admin-zalo")?.closest(".form-group")?.classList.add("onboarding-admin-control");
}

export function traControlCanonical() {
  for (const record of portalRecords) {
    if (record.marker.parentNode) record.marker.parentNode.insertBefore(record.node, record.marker.nextSibling);
  }
}

function datTrainingController() {
  const step = Number(state?.step) || 0;
  const active = trainingActive && step >= 4 && step <= 7;
  datDieuPhoiOnboarding({
    active,
    spotlightComposer: active,
    submit: async (text) => {
      if (Number(state?.step) === 4) {
        capNhatState(await jsonFetch("/api/onboarding/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start_bot_setup", payload: {} }),
        }));
      }
      capNhatState(await jsonFetch("/api/onboarding/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }));
      await render();
    },
  });
}

function dienBanTongHop() {
  if (Number(state?.step) !== 8) return;
  const draft = state.data?.draft || {};
  const soul = document.querySelector("#ai-soul");
  const role = document.querySelector("#ai-role");
  const topics = document.querySelector("#ai-topics");
  if (soul) soul.value = draft.soul || "";
  if (role) role.value = draft.roleTone || "";
  if (topics) topics.value = draft.allowedTopics || "";

  const provider = document.querySelector("#ai-oc-provider");
  const model = document.querySelector("#ai-oc-model");
  if (provider && state.data?.providerId) {
    provider.value = state.data.providerId;
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    queueMicrotask(() => { if (model) model.value = state.data.modelId || model.value; });
  }
}

function anCoach() {
  els.coach.classList.add("hidden");
  currentTarget = null;
}

function taoNut(label, onClick, secondary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = secondary ? "secondary-button" : "primary-button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function xuLyCta(stepDef) {
  if (stepDef.action === "model_selected") {
    const providerId = document.querySelector("#ai-oc-provider")?.value || "";
    const modelId = document.querySelector("#ai-oc-model")?.value || "";
    await hanhDong("model_selected", { providerId, modelId });
    return;
  }
  if (stepDef.action === "start_bot_setup") await hanhDong("start_bot_setup");
  if (stepDef.action === "review_complete") {
    reviewReadyToSave = true;
    await render();
  }
}

function layTargets(targetDef) {
  const selectors = Array.isArray(targetDef) ? targetDef : [targetDef];
  return selectors.map((selector) => document.querySelector(selector)).filter(Boolean);
}

function rectBao(targets) {
  const rects = targets.map((target) => target.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function datViTriCoach(targets) {
  const activeTargets = (Array.isArray(targets) ? targets : [targets]).filter((target) => target?.isConnected);
  if (!activeTargets.length || els.coach.classList.contains("hidden")) return;
  currentTarget = activeTargets;
  const rect = rectBao(activeTargets);
  const pad = 7;
  Object.assign(els.highlight.style, {
    left: `${Math.max(4, rect.left - pad)}px`,
    top: `${Math.max(4, rect.top - pad)}px`,
    width: `${Math.max(24, rect.width + pad * 2)}px`,
    height: `${Math.max(24, rect.height + pad * 2)}px`,
  });

  const bubbleRect = els.bubble.getBoundingClientRect();
  const gap = 18;
  let left = rect.right + gap;
  let top = rect.top + rect.height / 2 - bubbleRect.height / 2;
  let side = "right";
  if (left + bubbleRect.width > window.innerWidth - 12) {
    left = rect.left - bubbleRect.width - gap;
    side = "left";
  }
  if (left < 12) {
    left = Math.min(window.innerWidth - bubbleRect.width - 12, Math.max(12, rect.left));
    top = rect.bottom + gap;
    side = "bottom";
  }
  top = Math.max(12, Math.min(top, window.innerHeight - bubbleRect.height - 12));

  const bubbleOverlaps = (otherRect) => left < otherRect.right
    && left + bubbleRect.width > otherRect.left
    && top < otherRect.bottom
    && top + bubbleRect.height > otherRect.top;
  if (bubbleOverlaps(rect)) {
    const belowTarget = rect.bottom + gap;
    const aboveTarget = rect.top - bubbleRect.height - gap;
    if (belowTarget + bubbleRect.height <= window.innerHeight - 12) {
      top = belowTarget;
      side = "bottom";
    } else if (aboveTarget >= 12) {
      top = aboveTarget;
      side = "top";
    }
  }

  const composer = document.querySelector("#training-form.training-form-composer-spotlight");
  if (composer) {
    const composerRect = composer.getBoundingClientRect();
    if (bubbleOverlaps(composerRect)) {
      const belowComposer = composerRect.bottom + 12;
      const aboveComposer = composerRect.top - bubbleRect.height - 12;
      if (belowComposer + bubbleRect.height <= window.innerHeight - 12) {
        top = belowComposer;
        side = "bottom";
      } else if (aboveComposer >= 12) {
        top = aboveComposer;
        side = "top";
      }
    }
  }
  els.bubble.style.left = `${left}px`;
  els.bubble.style.top = `${top}px`;
  els.bubble.dataset.side = side;
}

function hienCoach(step, { completion = false } = {}) {
  const stepDef = completion
    ? {
        target: "#training-log",
        title: "Thiết lập hoàn tất",
        body: "Trợ lý AI của chị đã được thiết lập xong và sẵn sàng hoạt động.",
        cta: "Về Hội thoại",
      }
    : step === 8 && reviewReadyToSave ? BUOC_LUU_CAU_HINH : BUOC[step];
  if (!stepDef || !trainingActive) return anCoach();
  const targets = layTargets(stepDef.target);
  if (!targets.length) return anCoach();

  els.bubbleStep.textContent = completion ? "Hoàn tất" : `Bước ${step}/9`;
  els.bubbleTitle.textContent = stepDef.title;
  els.bubbleBody.textContent = stepDef.body;
  els.bubbleActions.innerHTML = "";
  if (stepDef.cta) {
    const action = completion
      ? () => { anCoach(); callbacks?.selectModule("zalo"); }
      : async () => {
          try { await xuLyCta(stepDef); }
          catch (error) { els.bubbleBody.textContent = error.message; }
        };
    els.bubbleActions.append(taoNut(stepDef.cta, action));
  }
  els.coach.classList.remove("hidden");
  const targetRect = rectBao(targets);
  if (targetRect.top < 0 || targetRect.bottom > window.innerHeight) {
    targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
  }
  requestAnimationFrame(() => datViTriCoach(targets));
}

async function render() {
  if (!state) return;
  const step = Number(state.step) || 0;
  els.progress.classList.toggle("hidden", state.completed || !state.started);
  if (!state.completed && state.started) els.progress.textContent = `Bước ${step}/9`;

  if (trainingActive) {
    ganControlCanonical();
    await napHuanLuyen();
  }
  datTrainingController();

  if (step >= 5 && step <= 7) hienTinOnboarding(state.prompt);
  else if (step === 8) {
    hienTinOnboarding(reviewReadyToSave
      ? "Nếu cấu hình đã ổn, chị bấm Ghi nhớ giúp em nhé."
      : "Em đã điền cấu hình được chị duyệt. Chị đọc lại toàn bộ Soul, Giọng điệu và Chủ đề được phép trả lời giúp em.");
    dienBanTongHop();
  } else if (step === 9) {
    hienTinOnboarding("Cấu hình AI đã được lưu. Chị chọn nick Zalo được phép ra lệnh cho bot để hoàn tất nhé.");
  } else if (state.completed && completionJustReached) {
    hienTinOnboarding("Trợ lý AI của chị đã được thiết lập xong và sẵn sàng hoạt động.");
  } else {
    hienTinOnboarding("");
  }

  if (state.completed) {
    if (completionJustReached) {
      hienCoach(9, { completion: true });
      completionJustReached = false;
    } else anCoach();
    return;
  }
  if (step > 0) hienCoach(step);
  else anCoach();
}

export async function datManHinhHuanLuyen(active) {
  trainingActive = Boolean(active);
  if (!trainingActive) {
    anCoach();
    traControlCanonical();
    datDieuPhoiOnboarding(null);
    return;
  }
  ganControlCanonical();
  if (!state) {
    try { await napTrangThai(); }
    catch { return; }
  }
  await render();
}

export function truocKhiMoCauHinh() {
  anCoach();
  traControlCanonical();
}

export function sauKhiDongCauHinh() {
  if (trainingActive) {
    ganControlCanonical();
    void render();
  }
}

export async function dongBoTrangThaiZalo({ loggedIn, justLoggedIn, ownerUid }) {
  clearTimeout(loginTimer);
  if (!loggedIn || !ownerUid) {
    lastOwnerUid = null;
    deferredThisSession = false;
    state = null;
    els.firstRun.classList.add("hidden");
    anCoach();
    return;
  }
  if (lastOwnerUid !== String(ownerUid)) {
    state = null;
    deferredThisSession = false;
  }
  lastOwnerUid = String(ownerUid);
  try { await napTrangThai(); }
  catch { return; }

  if (state.completed) return;
  if (justLoggedIn) callbacks?.selectModule("zalo");
  loginTimer = setTimeout(() => {
    if (!state?.started && !deferredThisSession) {
      els.firstRun.classList.remove("hidden");
      return;
    }
    callbacks?.selectModule("training");
  }, justLoggedIn ? 700 : 350);
}

export function khoiTaoOnboarding(options) {
  if (initialized) return;
  initialized = true;
  callbacks = options;
  thuThapPortal();

  els.btnStart.addEventListener("click", async () => {
    els.btnStart.disabled = true;
    try {
      await hanhDong("start");
      els.firstRun.classList.add("hidden");
      callbacks?.selectModule("training");
    } catch (error) {
      els.firstRun.querySelector("p").textContent = error.message;
    } finally {
      els.btnStart.disabled = false;
    }
  });
  els.btnLater.addEventListener("click", () => {
    deferredThisSession = true;
    els.firstRun.classList.add("hidden");
  });
  els.dismiss.addEventListener("click", anCoach);

  els.keyLinks.addEventListener("click", (event) => {
    if (!event.target.closest("a") || Number(state?.step) !== 1) return;
    void hanhDong("key_link_clicked").catch(() => {});
  });

  window.addEventListener("zalo:canonical-save", async (event) => {
    const detail = event.detail || {};
    try {
      if (detail.section === "api-key" && [1, 2].includes(Number(state?.step))) {
        await hanhDong("key_saved");
      } else if (detail.section === "ai-config" && Number(state?.step) === 8) {
        await hanhDong("config_saved");
      } else if (detail.section === "admin" && Number(state?.step) === 9) {
        completionJustReached = true;
        await hanhDong("admin_saved", { adminUid: detail.adminUid });
      }
    } catch (error) {
      if (trainingActive) {
        els.bubbleBody.textContent = error.message;
        els.coach.classList.remove("hidden");
      }
    }
  });

  window.addEventListener("resize", () => datViTriCoach(currentTarget));
  window.addEventListener("scroll", () => datViTriCoach(currentTarget), true);
}
