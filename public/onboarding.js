import { datDieuPhoiOnboarding, hienTinOnboarding, napHuanLuyen } from "./training.js";
import { refreshAiChatConfigForCurrentOwner } from "./config.js";

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
  progressText: document.querySelector("#onboarding-progress-text"),
  progressBar: document.querySelector("#onboarding-progress-bar"),
  keyLinks: document.querySelector("#onboarding-key-links"),
  trainingPanel: document.querySelector("#module-training"),
  trainingTitle: document.querySelector("#training-title"),
  trainingMobileTitle: document.querySelector("#training-mobile-title"),
  btnSetup: document.querySelector("#btn-training-setup"),
  btnExitSetup: document.querySelector("#btn-training-exit-setup"),
  btnSynth: document.querySelector("#btn-training-synth"),
  btnReset: document.querySelector("#btn-training-reset"),
};

const portalSpecs = [
  ["#ai-oc-provider", ".ai-model-config", "#onboarding-slot-model", "ai-chat-form"],
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
    body: "Chọn hãng AI và model chị muốn dùng, rồi bấm Lưu. Model được lưu tại cấu hình AI chính thức và sẽ áp dụng ngay cho Bot Chỉ huy.",
  },
  5: {
    target: "#training-log",
    title: "Bot Chỉ huy đang phỏng vấn",
    body: "Chị trả lời từng câu một. Em sẽ dùng câu trả lời để hiểu vai trò, đối tượng, cách xưng hô, giọng điệu, phạm vi và giới hạn của trợ lý.",
  },
  6: {
    target: "#training-log",
    title: "Phân tích sâu và duyệt nguyên tắc vận hành",
    body: "Em sẽ làm rõ từng điểm còn thiếu, sau đó trình bày các nguyên tắc đề xuất kèm lý do ngay tại bước này. Chị có thể bỏ, sửa, bổ sung hoặc trả lời OK khi phần thiết kế đã ổn.",
  },
  7: {
    target: "#training-log",
    title: "Duyệt bản hướng dẫn vận hành cuối",
    body: "Em đã chuyển câu trả lời và các nguyên tắc được duyệt thành instruction hoàn chỉnh. Chị đọc, yêu cầu sửa hoặc bổ sung từng điểm; chỉ trả lời OK khi đồng ý dùng chính bản này.",
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
  body: "Nếu cấu hình đã ổn, chị bấm Lưu cấu hình trợ lý giúp em nhé.",
};

let state = null;
let callbacks = null;
let portalRecords = [];
let trainingActive = false;
let currentTarget = null;
let lastOwnerUid = null;
let ownerGeneration = 0;
let initialized = false;
let completionJustReached = false;
let reviewReadyToSave = false;
let explicitSetupMode = false;
let coachDismissedThisSetup = false;
let inviteSeenRequest = null;
let onboardingHydrationRequest = null;
let queuedExplicitSetupIntent = false;
let explicitSetupEntryInFlight = null;
let explicitPassGeneration = 0;

async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Không thực hiện được.");
  return data;
}

function chupOnboardingOwner() {
  return { ownerUid: lastOwnerUid, ownerGeneration };
}

function onboardingOwnerConHieuLuc(owner) {
  return owner.ownerGeneration === ownerGeneration && owner.ownerUid === lastOwnerUid;
}

function capNhatState(next) {
  const previousStep = Number(state?.step) || 0;
  const nextStep = Number(next?.step) || 0;
  state = next;
  if (nextStep !== 8 || previousStep !== 8) reviewReadyToSave = false;
  return state;
}

async function napTrangThai() {
  const owner = chupOnboardingOwner();
  if (!owner.ownerUid) return null;
  if (onboardingHydrationRequest) return onboardingHydrationRequest;
  const request = (async () => {
    const next = await jsonFetch("/api/onboarding");
    if (!onboardingOwnerConHieuLuc(owner)) return null;
    return capNhatState(next);
  })();
  onboardingHydrationRequest = request;
  try {
    return await request;
  } finally {
    if (onboardingHydrationRequest === request) onboardingHydrationRequest = null;
  }
}

async function hanhDong(action, payload = {}) {
  const owner = chupOnboardingOwner();
  const next = await jsonFetch("/api/onboarding/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  if (!onboardingOwnerConHieuLuc(owner)) return null;
  capNhatState(next);
  await render(owner);
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

function explicitAnswerReady() {
  const step = Number(state?.step) || 0;
  return !state?.completed && step >= 4 && step <= 7;
}

async function phucHoiTrangThaiExplicit(owner) {
  if (!onboardingOwnerConHieuLuc(owner)) throw new Error("Tài khoản Zalo đã thay đổi.");
  if (!await napTrangThai()) throw new Error("Chưa tải được tiến trình thiết lập trợ lý.");
  if (!onboardingOwnerConHieuLuc(owner)) throw new Error("Tài khoản Zalo đã thay đổi.");
  if (state.completed || Number(state.step) === 0) {
    throw new Error("Lượt thiết lập hiện tại đã kết thúc. Hãy bấm Thiết lập trợ lý để bắt đầu lượt mới.");
  }
  if (!explicitAnswerReady()) {
    throw new Error("Tiến trình thiết lập hiện không ở bước nhận câu trả lời. Hãy làm theo hướng dẫn đang hiển thị.");
  }
}

function datTrainingController() {
  const step = Number(state?.step) || 0;
  const active = trainingActive && explicitSetupMode;
  const answerReady = active && explicitAnswerReady();
  datDieuPhoiOnboarding({
    active,
    spotlightComposer: answerReady,
    showStarter: active && step === 4,
    submit: async (text) => {
      const owner = chupOnboardingOwner();
      let recoveryAttempted = false;
      if (!answerReady) {
        recoveryAttempted = true;
        await phucHoiTrangThaiExplicit(owner);
      }
      let next;
      try {
        next = await jsonFetch("/api/onboarding/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      } catch (error) {
        if (!recoveryAttempted) {
          try { await phucHoiTrangThaiExplicit(owner); }
          catch (recoveryError) {
            throw new Error(`${error.message} ${recoveryError.message}`.trim());
          }
        }
        throw error;
      }
      if (!onboardingOwnerConHieuLuc(owner)) return;
      capNhatState(next);
      await render(owner);
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
}

function anCoach() {
  els.coach.classList.add("hidden");
  currentTarget = null;
}

function dismissCoachForThisSetup() {
  coachDismissedThisSetup = true;
  anCoach();
}

function datCheDoSetupUI() {
  const explicit = Boolean(explicitSetupMode);
  if (els.trainingPanel) els.trainingPanel.dataset.trainingMode = explicit ? "explicit" : "normal";
  const title = explicit ? "Thiết lập trợ lý" : "Huấn luyện bot";
  if (els.trainingTitle) els.trainingTitle.textContent = title;
  if (els.trainingMobileTitle) els.trainingMobileTitle.textContent = title;
  els.btnSetup?.classList.toggle("hidden", explicit);
  els.btnExitSetup?.classList.toggle("hidden", !explicit);
  els.btnSynth?.classList.toggle("hidden", explicit);
  els.btnReset?.classList.toggle("hidden", explicit);
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
  if (stepDef.action === "review_complete") {
    reviewReadyToSave = true;
    await render();
  }
}

function layTargets(targetDef) {
  const selectors = Array.isArray(targetDef) ? targetDef : [targetDef];
  return selectors.map((selector) => document.querySelector(selector)).filter(Boolean);
}

function datTrangThaiAccordion(toggle, expanded) {
  if (!toggle) return;
  const contentId = toggle.getAttribute("aria-controls");
  const content = contentId ? document.getElementById(contentId) : null;
  if (!content) return;
  toggle.setAttribute("aria-expanded", String(expanded));
  content.hidden = !expanded;
  const group = toggle.closest(".canonical-config-accordion, .provider-other-group");
  group?.classList.toggle("is-collapsed", !expanded);
  const verb = expanded ? "Thu gọn" : "Mở";
  const currentLabel = toggle.getAttribute("aria-label");
  if (currentLabel) toggle.setAttribute("aria-label", currentLabel.replace(/^(Mở|Thu gọn)/, verb));
}

function khoiTaoAccordion() {
  document.querySelectorAll(".canonical-section-toggle, .provider-other-toggle").forEach((toggle) => {
    datTrangThaiAccordion(toggle, toggle.getAttribute("aria-expanded") === "true");
    toggle.addEventListener("click", () => {
      datTrangThaiAccordion(toggle, toggle.getAttribute("aria-expanded") !== "true");
    });
  });
}

function thongBaoNoiDungSeThay() {
  const fields = [
    ["#ai-soul", "Soul"],
    ["#ai-role", "Giọng điệu và vai trò"],
    ["#ai-topics", "Chủ đề được phép trả lời"],
  ];
  const labels = fields
    .filter(([selector]) => document.querySelector(selector)?.value?.trim())
    .map(([, label]) => `- ${label}`);
  if (!labels.length) return "";
  return `Bản thiết lập mới sẽ thay nội dung hiện đang có trong editor ở:\n${labels.join("\n")}`;
}

function onboardingMessageKey(variant = "state") {
  const transcriptLength = Array.isArray(state?.data?.transcript) ? state.data.transcript.length : 0;
  return [ownerGeneration, explicitPassGeneration, String(state?.step || 0), transcriptLength, variant].join(":");
}

function hienTinOnboardingState(content, variant = "state") {
  return hienTinOnboarding(content, onboardingMessageKey(variant));
}

function moAccordionChoTargets(targets) {
  for (const target of targets) {
    const section = target.closest(".canonical-config-accordion");
    const sectionToggle = section?.querySelector(".canonical-section-toggle");
    if (sectionToggle?.getAttribute("aria-expanded") !== "true") {
      datTrangThaiAccordion(sectionToggle, true);
    }
    const otherContent = target.closest(".provider-other-content");
    const otherToggle = otherContent?.parentElement?.querySelector(".provider-other-toggle");
    if (otherToggle?.getAttribute("aria-expanded") !== "true") {
      datTrangThaiAccordion(otherToggle, true);
    }
  }
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

  els.coach.classList.add("hidden");
  moAccordionChoTargets(targets);

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
  requestAnimationFrame(() => {
    const targetRect = rectBao(targets);
    if (targetRect.top < 0 || targetRect.bottom > window.innerHeight) {
      targets[0].scrollIntoView({ behavior: "auto", block: "center" });
    }
    requestAnimationFrame(() => {
      els.coach.classList.remove("hidden");
      datViTriCoach(targets);
    });
  });
}

async function render(owner = chupOnboardingOwner()) {
  if (!state || !onboardingOwnerConHieuLuc(owner)) return;
  const step = Number(state.step) || 0;
  datCheDoSetupUI();
  if (explicitSetupMode) {
    const segment = step >= 4 && step <= 7 ? "chat" : "config";
    window.dispatchEvent(new CustomEvent("zalo:training-segment", { detail: { segment } }));
  }
  const showProgress = explicitSetupMode && !state.completed && state.started;
  els.progress.classList.toggle("hidden", !showProgress);
  els.progress.setAttribute("aria-hidden", String(!showProgress));
  if (showProgress) {
    const currentStep = Math.max(1, Math.min(9, step));
    els.progressText.textContent = `Bước ${currentStep} trên 9`;
    els.progress.setAttribute("aria-valuenow", String(currentStep));
    els.progressBar.style.width = `${(currentStep / 9) * 100}%`;
  }

  if (trainingActive) {
    ganControlCanonical();
    await napHuanLuyen();
    if (!onboardingOwnerConHieuLuc(owner)) return;
  }
  datTrainingController();

  if (!explicitSetupMode) {
    hienTinOnboardingState("");
  } else if (step === 4) {
    hienTinOnboardingState(
      state.prompt
      || "Bot Chỉ huy đã sẵn sàng. Chị chọn gợi ý bên dưới hoặc tự gõ điều chị muốn tạo nhé."
    );
  } else if (step >= 5 && step <= 6) hienTinOnboardingState(state.prompt);
  else if (step === 7) {
    const disclosure = thongBaoNoiDungSeThay();
    hienTinOnboardingState([state.prompt, disclosure].filter(Boolean).join("\n\n"));
  }
  else if (step === 8) {
    hienTinOnboardingState(reviewReadyToSave
      ? "Nếu cấu hình đã ổn, chị bấm Lưu cấu hình trợ lý giúp em nhé."
      : "Em đã điền cấu hình được chị duyệt. Chị đọc lại toàn bộ Soul, Giọng điệu và Chủ đề được phép trả lời giúp em.");
    dienBanTongHop();
  } else if (step === 9) {
    hienTinOnboardingState("Cấu hình AI đã được lưu. Chị chọn nick Zalo được phép ra lệnh cho bot để hoàn tất nhé.");
  } else if (state.completed && completionJustReached) {
    hienTinOnboardingState("Trợ lý AI của chị đã được thiết lập xong và sẵn sàng hoạt động.", "completion");
  } else {
    hienTinOnboardingState("");
  }

  if (state.completed) {
    if (completionJustReached && explicitSetupMode && !coachDismissedThisSetup) {
      hienCoach(9, { completion: true });
      completionJustReached = false;
    } else anCoach();
    return;
  }
  if (explicitSetupMode && !coachDismissedThisSetup && step > 0) hienCoach(step);
  else anCoach();
}

export async function datManHinhHuanLuyen(active, { explicitSetup = false } = {}) {
  const wasActive = trainingActive;
  trainingActive = Boolean(active);
  if (!trainingActive) {
    explicitSetupMode = false;
    coachDismissedThisSetup = false;
    datCheDoSetupUI();
    anCoach();
    traControlCanonical();
    datDieuPhoiOnboarding(null);
    return;
  }
  if (!wasActive) {
    explicitSetupMode = Boolean(explicitSetup);
    coachDismissedThisSetup = false;
  } else if (explicitSetup) {
    explicitSetupMode = true;
    coachDismissedThisSetup = false;
  }
  datCheDoSetupUI();
  // URL/agent la runtime canonical, con model thuoc owner. Moi lan mo Training
  // phai nap lai sau khi owner da co; khong dua vao request page-mount co the da
  // chay truoc dang nhap. Trong luc nap, dua controls ve Settings de Save cu
  // khong the dung state rong/stale.
  traControlCanonical();
  const configDaNap = await refreshAiChatConfigForCurrentOwner();
  if (!trainingActive || !configDaNap) return;
  ganControlCanonical();
  if (!state) {
    try { await napTrangThai(); }
    catch { return; }
  }
  if (!state) return;
  if (queuedExplicitSetupIntent) {
    try { await replayExplicitSetupIntent(); }
    catch (error) {
      if (trainingActive) hienTinOnboarding("Lỗi: " + error.message);
    }
    if (!trainingActive || !state) return;
  }
  await render(chupOnboardingOwner());
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

async function ghiNhanDaThayLoiMoi() {
  if (state?.data?.firstSetupInviteSeen === true) return state;
  if (inviteSeenRequest) return inviteSeenRequest;
  inviteSeenRequest = hanhDong("invite_seen");
  try {
    return await inviteSeenRequest;
  } finally {
    inviteSeenRequest = null;
  }
}

function canAutoOfferFirstSetup() {
  return Boolean(lastOwnerUid && state && state.data?.firstSetupInviteSeen !== true);
}

function canManuallyEnterSetup() {
  return Boolean(lastOwnerUid);
}

async function replayExplicitSetupIntent() {
  if (!queuedExplicitSetupIntent || !canManuallyEnterSetup()) return null;
  if (explicitSetupEntryInFlight) return explicitSetupEntryInFlight;
  const owner = chupOnboardingOwner();
  const request = (async () => {
    try {
      if (!state && !await napTrangThai()) throw new Error("Chưa tải được tiến trình thiết lập trợ lý.");
      if (!onboardingOwnerConHieuLuc(owner)) throw new Error("Tài khoản Zalo đã thay đổi.");
      if (state.completed || Number(state.step) === 0) {
        if (!await hanhDong("start")) throw new Error("Không bắt đầu được lượt thiết lập trợ lý.");
        explicitPassGeneration += 1;
      }
      if (!state || state.completed) throw new Error("Không mở được lượt thiết lập trợ lý.");
      explicitSetupMode = true;
      coachDismissedThisSetup = false;
      queuedExplicitSetupIntent = false;
      datCheDoSetupUI();
      callbacks?.selectModule("training", { explicitSetup: true });
      await render(owner);
      return state;
    } catch (error) {
      if (onboardingOwnerConHieuLuc(owner)) {
        queuedExplicitSetupIntent = false;
        explicitSetupMode = false;
        datCheDoSetupUI();
      }
      throw error;
    }
  })();
  explicitSetupEntryInFlight = request;
  try {
    return await request;
  } finally {
    if (explicitSetupEntryInFlight === request) explicitSetupEntryInFlight = null;
  }
}

async function vaoThietLapTroLy() {
  queuedExplicitSetupIntent = true;
  return replayExplicitSetupIntent();
}

async function thoatThietLapTroLy() {
  explicitSetupMode = false;
  coachDismissedThisSetup = false;
  completionJustReached = false;
  reviewReadyToSave = false;
  anCoach();
  datCheDoSetupUI();
  if (state) await render(chupOnboardingOwner());
}

export async function dongBoTrangThaiZalo({ loggedIn, justLoggedIn, ownerUid }) {
  const nextOwnerUid = loggedIn && ownerUid ? String(ownerUid) : null;
  const ownerChanged = lastOwnerUid !== nextOwnerUid;
  const resolvingInitialOwner = ownerChanged && lastOwnerUid === null && nextOwnerUid !== null;
  if (ownerChanged) {
    ownerGeneration += 1;
    state = null;
    completionJustReached = false;
    reviewReadyToSave = false;
    explicitSetupMode = false;
    coachDismissedThisSetup = false;
    inviteSeenRequest = null;
    onboardingHydrationRequest = null;
    explicitSetupEntryInFlight = null;
    explicitPassGeneration = 0;
    if (!resolvingInitialOwner) queuedExplicitSetupIntent = false;
    els.firstRun.classList.add("hidden");
    els.progress.classList.add("hidden");
    els.progress.setAttribute("aria-hidden", "true");
    anCoach();
    datCheDoSetupUI();
  }
  if (!loggedIn || !ownerUid) {
    if (!loggedIn) queuedExplicitSetupIntent = false;
    lastOwnerUid = null;
    return;
  }
  lastOwnerUid = nextOwnerUid;
  if (ownerChanged || justLoggedIn) callbacks?.selectModule("zalo");
  const owner = chupOnboardingOwner();
  try {
    if (!await napTrangThai()) return;
  }
  catch { return; }

  if (!onboardingOwnerConHieuLuc(owner)) return;
  if (queuedExplicitSetupIntent) {
    try {
      const replayed = await replayExplicitSetupIntent();
      if (replayed && state?.data?.firstSetupInviteSeen !== true) {
        await ghiNhanDaThayLoiMoi();
      }
    }
    catch (error) {
      els.firstRun.querySelector(".onboarding-first-run-copy").textContent = error.message;
      if (trainingActive && explicitSetupMode) hienTinOnboarding("Lỗi: " + error.message);
    }
    if (explicitSetupMode) return;
  }
  if (canAutoOfferFirstSetup()) {
    els.firstRun.classList.remove("hidden");
    requestAnimationFrame(() => els.btnStart.focus());
    // Persist ngay khi loi moi da xuat hien. Neu request hong, modal van o do va
    // hai nut se thu lai; khong co client-only canonical state.
    void ghiNhanDaThayLoiMoi().catch(() => {});
  }
}

export function khoiTaoOnboarding(options) {
  if (initialized) return;
  initialized = true;
  callbacks = options;
  khoiTaoAccordion();
  thuThapPortal();

  els.btnStart.addEventListener("click", async () => {
    els.btnStart.disabled = true;
    els.btnLater.disabled = true;
    try {
      if (!await ghiNhanDaThayLoiMoi()) return;
      els.firstRun.classList.add("hidden");
      await vaoThietLapTroLy();
    } catch (error) {
      els.firstRun.querySelector(".onboarding-first-run-copy").textContent = error.message;
    } finally {
      els.btnStart.disabled = false;
      els.btnLater.disabled = false;
    }
  });
  els.btnLater.addEventListener("click", async () => {
    els.btnStart.disabled = true;
    els.btnLater.disabled = true;
    try {
      if (!await ghiNhanDaThayLoiMoi()) return;
      els.firstRun.classList.add("hidden");
      callbacks?.selectModule("zalo");
    } catch (error) {
      els.firstRun.querySelector(".onboarding-first-run-copy").textContent = error.message;
    } finally {
      els.btnStart.disabled = false;
      els.btnLater.disabled = false;
    }
  });
  els.dismiss.addEventListener("click", dismissCoachForThisSetup);
  els.btnSetup?.addEventListener("click", () => {
    void vaoThietLapTroLy().catch((error) => {
      if (trainingActive) hienTinOnboarding("Lỗi: " + error.message);
    });
  });
  els.btnExitSetup?.addEventListener("click", () => { void thoatThietLapTroLy(); });

  els.keyLinks.addEventListener("click", (event) => {
    if (!event.target.closest("a") || Number(state?.step) !== 1) return;
    void hanhDong("key_link_clicked").catch(() => {});
  });

  window.addEventListener("zalo:canonical-save", async (event) => {
    const detail = event.detail || {};
    if (!explicitSetupMode) return;
    try {
      if (detail.section === "api-key" && [1, 2].includes(Number(state?.step))) {
        await hanhDong("key_saved");
      } else if (detail.section === "ai-model" && Number(state?.step) === 3) {
        await hanhDong("model_selected");
      } else if (detail.section === "ai-config" && Number(state?.step) === 8) {
        await hanhDong("config_saved");
      } else if (detail.section === "admin" && Number(state?.step) === 9) {
        completionJustReached = true;
        await hanhDong("admin_saved", { adminUid: detail.adminUid });
      }
    } catch (error) {
      if (trainingActive && explicitSetupMode) {
        els.bubbleBody.textContent = error.message;
        els.coach.classList.remove("hidden");
      }
    }
  });

  window.addEventListener("resize", () => datViTriCoach(currentTarget));
  window.addEventListener("scroll", () => datViTriCoach(currentTarget), true);
}
