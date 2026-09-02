import { dinhDangDungLuong } from "./chat-media.js";

const els = {
  panel: document.querySelector("#module-training"),
  log: document.querySelector("#training-log"),
  starters: document.querySelector("#onboarding-starters"),
  btnStarter: document.querySelector("#btn-onboarding-starter"),
  meta: document.querySelector("#training-meta"),
  mobileMeta: document.querySelector("#training-mobile-meta"),
  form: document.querySelector("#training-form"),
  text: document.querySelector("#training-text"),
  fileInput: document.querySelector("#training-file-input"),
  fileList: document.querySelector("#training-files"),
  btnAttach: document.querySelector("#btn-training-attach"),
  btnAttachFile: document.querySelector("#btn-training-attach-file"),
  btnSynth: document.querySelector("#btn-training-synth"),
  btnReset: document.querySelector("#btn-training-reset"),
  layout: document.querySelector("#training-layout"),
  configPanel: document.querySelector("#training-config-panel"),
  btnConfigToggle: document.querySelector("#btn-training-config-toggle"),
  segmentButtons: [...document.querySelectorAll("[data-training-segment]")],
  keyProvider: document.querySelector("#training-key-provider"),
  keyValue: document.querySelector("#training-key-value"),
  btnKeySave: document.querySelector("#btn-training-key-save"),
  btnKeyTest: document.querySelector("#btn-training-key-test"),
  btnKeyDelete: document.querySelector("#btn-training-key-delete"),
  btnKeyClear: document.querySelector("#btn-training-key-clear"),
  connectedProviders: document.querySelector("#training-connected-providers"),
};

const IMAGE_ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const FILE_ATTACHMENT_ACCEPT = "application/pdf,text/plain,text/markdown,text/csv";
const CANONICAL_ATTACHMENT_ACCEPT = els.fileInput?.getAttribute("accept") ||
  `${IMAGE_ATTACHMENT_ACCEPT},${FILE_ATTACHMENT_ACCEPT}`;

let dinhKem = [];
let docDuocAnh = false;
let dangGui = false;
let daNap = false;
let ownerGeneration = 0;
let onboardingController = null;
let starterConsumed = false;
let credentialCatalog = [];
let credentialStatus = new Map();
let credentialBusy = false;
// Backend canonical luon doc duoc PDF/text/Markdown/CSV; docDuocAnh chi la
// capability rieng cua model, khong duoc dung de khoa tat ca cac loai tep.
const docDuocTepKhac = true;

/** UID boundary: xoa ngay transcript/attachment cu va huy hieu luc request cu. */
export function invalidateTrainingOwnerState() {
  ownerGeneration += 1;
  daNap = false;
  docDuocAnh = false;
  starterConsumed = false;
  onboardingController = null;
  els.starters.classList.add("hidden");
  els.form.classList.remove("training-form-onboarding", "training-form-composer-spotlight");
  for (const entry of dinhKem) {
    if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  }
  dinhKem = [];
  veDanhSachTep();
  els.log.innerHTML = "";
  els.meta.textContent = "Đang tải hồ sơ Zalo hiện tại…";
  if (els.mobileMeta) els.mobileMeta.textContent = els.meta.textContent;
  els.meta.classList.remove("training-warn");
  credentialCatalog = [];
  credentialStatus = new Map();
  els.keyProvider.innerHTML = '<option value="">Chọn hãng</option>';
  els.keyValue.value = "";
  renderCredentialStatus();
  updateCredentialControls();
}

function datMobileSegment(segment) {
  const next = segment === "config" ? "config" : "chat";
  els.panel.dataset.mobileSegment = next;
  for (const button of els.segmentButtons) {
    const active = button.dataset.trainingSegment === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
}

for (const button of els.segmentButtons) {
  button.addEventListener("click", () => datMobileSegment(button.dataset.trainingSegment));
}

window.addEventListener("zalo:training-segment", (event) => {
  datMobileSegment(event.detail?.segment);
});

els.btnConfigToggle?.addEventListener("click", () => {
  const collapsed = els.layout.classList.toggle("training-config-collapsed");
  const label = collapsed ? "Mở cấu hình" : "Thu gọn cấu hình";
  els.btnConfigToggle.setAttribute("aria-expanded", String(!collapsed));
  els.btnConfigToggle.setAttribute("aria-label", label);
  els.btnConfigToggle.title = label;
  const srLabel = els.btnConfigToggle.querySelector(".sr-only");
  if (srLabel) srLabel.textContent = label;
});

export function datDieuPhoiOnboarding(controller) {
  onboardingController = controller || null;
  const dangOnboarding = Boolean(onboardingController?.active);
  const composerSpotlight = Boolean(onboardingController?.spotlightComposer);
  const showStarter = Boolean(onboardingController?.showStarter) && !starterConsumed;
  els.form.classList.toggle("training-form-onboarding", dangOnboarding);
  els.form.classList.toggle("training-form-composer-spotlight", composerSpotlight);
  els.starters.classList.toggle("hidden", !showStarter);
  els.btnAttach.disabled = dangGui || (dangOnboarding ? false : !docDuocAnh && !docDuocTepKhac);
  els.btnAttachFile.disabled = dangGui || (dangOnboarding ? false : !docDuocTepKhac);
  els.btnSynth.disabled = dangOnboarding || dangGui;
  els.btnReset.disabled = dangOnboarding || dangGui;
  els.text.placeholder = dangOnboarding
    ? "Trả lời Bot Chỉ huy từng câu một…"
    : "Dán ảnh chat mẫu bằng Ctrl+V, hoặc gõ lời dặn về giọng điệu…";
}

export function hienTinOnboarding(content, turnKey = "") {
  if (!content) return null;
  const canonicalKey = String(turnKey || "");
  const existing = canonicalKey
    ? [...els.log.querySelectorAll("[data-onboarding-message]")]
      .find((node) => node.dataset.onboardingTurnKey === canonicalKey)
    : null;
  if (existing) {
    const body = existing.querySelector(".training-msg-body");
    if (body && body.textContent !== content) body.textContent = content;
    return existing;
  }
  const row = themDong({ role: "assistant", content });
  row.dataset.onboardingMessage = "true";
  if (canonicalKey) row.dataset.onboardingTurnKey = canonicalKey;
  return row;
}

function veDanhSachTep() {
  els.fileList.innerHTML = "";
  els.fileList.classList.toggle("hidden", dinhKem.length === 0);
  dinhKem.forEach((entry, index) => {
    const chip = taoTheTepHuanLuyen(entry, true);
    const bo = document.createElement("button");
    bo.type = "button";
    bo.textContent = "×";
    bo.setAttribute("aria-label", "Bỏ tệp");
    bo.onclick = () => {
      const [removed] = dinhKem.splice(index, 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      veDanhSachTep();
    };
    chip.append(bo);
    els.fileList.append(chip);
  });
}

function thongTinTep(entry) {
  const file = entry?.file || entry || {};
  return {
    name: file.name || entry?.filename || "Tệp đính kèm",
    mime: file.type || entry?.mime || "",
    size: file.size || entry?.size || 0,
    previewUrl: entry?.previewUrl || null,
  };
}

function taoTheTepHuanLuyen(entry, selected = false) {
  const info = thongTinTep(entry);
  const card = document.createElement("span");
  card.className = selected ? "training-chip training-chip-selected" : "training-media-card";
  if (info.previewUrl && info.mime.startsWith("image/")) {
    card.classList.add("training-media-image-card");
    const image = document.createElement("img");
    image.className = selected ? "training-chip-image" : "training-message-image";
    image.src = info.previewUrl;
    image.alt = info.name || "Ảnh đính kèm";
    card.append(image);
  } else {
    const icon = document.createElement("span");
    icon.className = "training-file-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📄";
    card.append(icon);
  }
  const label = document.createElement("span");
  label.className = "training-file-info";
  const name = document.createElement("strong");
  name.textContent = info.name;
  label.append(name);
  const size = dinhDangDungLuong(info.size);
  if (size) {
    const meta = document.createElement("small");
    meta.textContent = size;
    label.append(meta);
  }
  card.append(label);
  return card;
}

function themTepDaChon(files) {
  let daChanAnh = false;
  for (const file of files) {
    if (dinhKem.length >= 6) break;
    if (file.type.startsWith("image/") && !docDuocAnh) {
      daChanAnh = true;
      continue;
    }
    dinhKem.push({
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    });
  }
  if (daChanAnh) {
    themDong({
      role: "assistant",
      content: "Model đang chọn không đọc được ảnh — hãy đổi model trước khi đính ảnh. Các tệp không phải ảnh vẫn dùng được.",
    });
  }
  veDanhSachTep();
}

function themDong({ role, content, files }) {
  const row = document.createElement("div");
  row.className = `training-msg training-${role}`;

  if (files?.length) {
    const kem = document.createElement("div");
    kem.className = "training-msg-files";
    for (const file of files) kem.append(taoTheTepHuanLuyen(file));
    row.append(kem);
  }
  if (content) {
    const body = document.createElement("div");
    body.className = "training-msg-body";
    body.textContent = content;
    row.append(body);
  }

  // Doan Soul thuong dai; cho copy nhanh vi chi tu dan vao o Soul.
  if (role === "assistant" && content && content.length > 200) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary-button training-copy";
    copy.textContent = "Sao chép";
    copy.onclick = async () => {
      await navigator.clipboard.writeText(content);
      copy.textContent = "Đã chép";
      setTimeout(() => { copy.textContent = "Sao chép"; }, 1500);
    };
    row.append(copy);
  }

  els.log.append(row);
  els.log.scrollTop = els.log.scrollHeight;
  return row;
}

function trangThaiCho(text) {
  const row = document.createElement("div");
  row.className = "training-msg training-assistant training-waiting";
  row.textContent = text;
  els.log.append(row);
  els.log.scrollTop = els.log.scrollHeight;
  return row;
}

function khoa(khoaLai) {
  dangGui = khoaLai;
  els.form.querySelector("button[type=submit]").disabled = khoaLai;
  els.btnAttach.disabled = khoaLai;
  els.btnAttachFile.disabled = khoaLai;
  els.btnSynth.disabled = khoaLai;
  els.btnReset.disabled = khoaLai;
}

function apDungMetaHuanLuyen(data) {
  docDuocAnh = Boolean(data.docDuocAnh);
  els.meta.textContent =
    `Model: ${data.model} · ${docDuocAnh ? "đọc được ảnh" : "KHÔNG đọc được ảnh"}` +
    (data.sessionId ? "" : " · chưa có phiên nào");
  if (els.mobileMeta) els.mobileMeta.textContent = els.meta.textContent;
  els.meta.classList.toggle("training-warn", !docDuocAnh);
  els.btnAttach.disabled = dangGui;
  els.btnAttach.title = docDuocAnh
    ? "Đính kèm ảnh"
    : "Đính kèm ảnh; model hiện tại không đọc được ảnh";
  els.btnAttachFile.disabled = dangGui;
  els.btnAttachFile.title = "Đính kèm tệp";
}

async function napMetaHuanLuyen() {
  const generation = ownerGeneration;
  const res = await fetch("/api/training");
  const data = await res.json();
  if (generation !== ownerGeneration) return null;
  if (!res.ok) throw new Error(data.error || "Không tải được cấu hình model");
  apDungMetaHuanLuyen(data);
  return data;
}

function setCredentialButton(button, enabled) {
  button.disabled = !enabled;
  button.setAttribute("aria-disabled", String(!enabled));
}

function updateCredentialControls() {
  const providerId = els.keyProvider.value;
  const saved = credentialStatus.has(providerId);
  els.keyProvider.disabled = credentialBusy;
  els.keyValue.disabled = credentialBusy;
  setCredentialButton(els.btnKeySave, !credentialBusy && Boolean(providerId && els.keyValue.value.trim()));
  setCredentialButton(els.btnKeyTest, !credentialBusy && saved);
  setCredentialButton(els.btnKeyDelete, !credentialBusy && saved);
  setCredentialButton(els.btnKeyClear, !credentialBusy && credentialStatus.size > 0);
}

function providerName(providerId) {
  return credentialCatalog.find((provider) => provider.id === providerId)?.name || providerId;
}

function renderCredentialStatus() {
  els.connectedProviders.innerHTML = "";
  const title = document.createElement("span");
  title.textContent = "Hãng đã kết nối";
  els.connectedProviders.append(title);
  if (credentialStatus.size === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Chưa có kết nối.";
    const helper = document.createElement("p");
    helper.textContent = "Bot cần ít nhất một API key đã kết nối để sử dụng AI.";
    els.connectedProviders.append(empty, helper);
    return;
  }
  for (const status of credentialStatus.values()) {
    const row = document.createElement("p");
    const updated = Number(status.updatedAt)
      ? ` · ${new Date(Number(status.updatedAt)).toLocaleString("vi-VN")}`
      : "";
    row.textContent = `${status.providerName || providerName(status.providerId)} · Đã kết nối${updated}`;
    els.connectedProviders.append(row);
  }
}

function renderCredentialProviders(selected = "") {
  const ids = new Set(credentialCatalog.map((provider) => provider.id));
  for (const status of credentialStatus.values()) {
    if (!ids.has(status.providerId)) {
      credentialCatalog.push({ id: status.providerId, name: status.providerName || status.providerId });
    }
  }
  credentialCatalog.sort((a, b) => a.name.localeCompare(b.name, "vi"));
  els.keyProvider.innerHTML = "";
  els.keyProvider.append(new Option("Chọn hãng", ""));
  for (const provider of credentialCatalog) {
    const suffix = credentialStatus.has(provider.id) ? " · Đã kết nối" : "";
    els.keyProvider.append(new Option(provider.name + suffix, provider.id));
  }
  if (selected && credentialCatalog.some((provider) => provider.id === selected)) {
    els.keyProvider.value = selected;
  }
}

async function napOwnerCredentials() {
  const generation = ownerGeneration;
  const selected = els.keyProvider.value;
  credentialBusy = true;
  updateCredentialControls();
  try {
    const [catalogResponse, statusResponse] = await Promise.all([
      fetch("/api/ai-chat/providers"),
      fetch("/api/ai-chat/owner-credentials"),
    ]);
    const [catalogData, statusData] = await Promise.all([catalogResponse.json(), statusResponse.json()]);
    if (generation !== ownerGeneration) return;
    if (!catalogResponse.ok) throw new Error(catalogData.error || "Không tải được danh sách hãng AI.");
    if (!statusResponse.ok) throw new Error(statusData.error || "Không tải được kết nối AI.");
    credentialCatalog = (catalogData.providers || []).map((provider) => ({
      id: provider.id,
      name: provider.name || provider.id,
    }));
    credentialStatus = new Map((statusData.providers || []).map((status) => [status.providerId, status]));
    renderCredentialProviders(selected);
    renderCredentialStatus();
  } catch (error) {
    if (generation !== ownerGeneration) return;
    els.connectedProviders.innerHTML = "";
    const title = document.createElement("span");
    title.textContent = "Hãng đã kết nối";
    const row = document.createElement("p");
    row.textContent = error.message;
    els.connectedProviders.append(title, row);
  } finally {
    if (generation === ownerGeneration) {
      credentialBusy = false;
      updateCredentialControls();
    }
  }
}

export async function napHuanLuyen() {
  if (daNap) return;
  daNap = true;
  const generation = ownerGeneration;
  void napOwnerCredentials();
  try {
    const res = await fetch("/api/training");
    const data = await res.json();
    if (generation !== ownerGeneration) return;
    if (!res.ok) throw new Error(data.error || "Không tải được phiên huấn luyện");

    apDungMetaHuanLuyen(data);

    els.log.innerHTML = "";
    if (!data.messages.length) {
      themDong({
        role: "assistant",
        content:
          "Chào chị. Chị dán ảnh chụp các đoạn chat mẫu (Ctrl+V) hoặc gõ lời dặn về giọng điệu, em sẽ học theo.\n" +
          "Khi đủ rồi, bấm \"Tổng hợp thành Soul\" để em viết lại thành một đoạn hoàn chỉnh cho chị dán vào ô Soul.",
      });
    } else {
      for (const m of data.messages) themDong(m);
    }
  } catch (error) {
    if (generation !== ownerGeneration) return;
    els.meta.textContent = error.message;
    if (els.mobileMeta) els.mobileMeta.textContent = els.meta.textContent;
    els.meta.classList.add("training-warn");
    daNap = false;
  }
}

window.addEventListener("zalo:canonical-save", (event) => {
  if (event.detail?.section === "api-key") void napOwnerCredentials();
  if (!["ai-model", "ai-config", "api-key"].includes(event.detail?.section)) return;
  void napMetaHuanLuyen().catch((error) => {
    els.meta.textContent = error.message;
    if (els.mobileMeta) els.mobileMeta.textContent = els.meta.textContent;
    els.meta.classList.add("training-warn");
  });
});

window.addEventListener("zalo:credential-change", () => {
  void napOwnerCredentials();
  void napMetaHuanLuyen().catch(() => {});
});

els.keyProvider.addEventListener("change", updateCredentialControls);
els.keyValue.addEventListener("input", updateCredentialControls);

els.btnKeySave.addEventListener("click", async () => {
  const providerId = els.keyProvider.value;
  const apiKey = els.keyValue.value.trim();
  if (!providerId || !apiKey || credentialBusy) return;
  const generation = ownerGeneration;
  credentialBusy = true;
  updateCredentialControls();
  try {
    const response = await fetch("/api/ai-chat/owner-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, apiKey }),
    });
    const data = await response.json();
    if (generation !== ownerGeneration) return;
    if (!response.ok) throw new Error(data.error || "Không lưu được API key.");
    els.keyValue.value = "";
    await napOwnerCredentials();
    window.dispatchEvent(new CustomEvent("zalo:canonical-save", {
      detail: { section: "api-key", providerId },
    }));
  } catch (error) {
    if (generation !== ownerGeneration) return;
    alert(error.message);
  } finally {
    if (generation === ownerGeneration) {
      credentialBusy = false;
      updateCredentialControls();
    }
  }
});

els.btnKeyTest.addEventListener("click", async () => {
  const providerId = els.keyProvider.value;
  if (!credentialStatus.has(providerId) || credentialBusy) return;
  const generation = ownerGeneration;
  credentialBusy = true;
  updateCredentialControls();
  try {
    const response = await fetch("/api/ai-chat/owner-credentials/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
    });
    const data = await response.json();
    if (generation !== ownerGeneration) return;
    if (!response.ok) throw new Error(data.message || data.error || "Không kiểm tra được API key.");
    alert(`API key dùng được · ${data.model}`);
  } catch (error) {
    if (generation !== ownerGeneration) return;
    alert(error.message);
  } finally {
    if (generation === ownerGeneration) {
      credentialBusy = false;
      updateCredentialControls();
    }
  }
});

els.btnKeyDelete.addEventListener("click", async () => {
  const providerId = els.keyProvider.value;
  if (!credentialStatus.has(providerId) || credentialBusy) return;
  if (!confirm(`Gỡ API key ${providerName(providerId)} của tài khoản Zalo hiện tại?`)) return;
  const generation = ownerGeneration;
  credentialBusy = true;
  updateCredentialControls();
  try {
    const response = await fetch(`/api/ai-chat/owner-credentials/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    });
    const data = await response.json();
    if (generation !== ownerGeneration) return;
    if (!response.ok) throw new Error(data.error || "Không gỡ được API key.");
    await napOwnerCredentials();
    window.dispatchEvent(new CustomEvent("zalo:credential-change", {
      detail: { action: "delete-selected", providerId },
    }));
  } catch (error) {
    if (generation !== ownerGeneration) return;
    alert(error.message);
  } finally {
    if (generation === ownerGeneration) {
      credentialBusy = false;
      updateCredentialControls();
    }
  }
});

els.btnKeyClear.addEventListener("click", async () => {
  if (credentialStatus.size === 0 || credentialBusy) return;
  if (!confirm("Chỉ các API key AI đã lưu của tài khoản Zalo hiện tại sẽ bị gỡ.\n\nGỡ tất cả key của tôi?")) return;
  const generation = ownerGeneration;
  credentialBusy = true;
  updateCredentialControls();
  try {
    const response = await fetch("/api/ai-chat/owner-credentials", { method: "DELETE" });
    const data = await response.json();
    if (generation !== ownerGeneration) return;
    if (!response.ok) throw new Error(data.error || "Không gỡ được các API key.");
    await napOwnerCredentials();
    window.dispatchEvent(new CustomEvent("zalo:credential-change", {
      detail: { action: "delete-all" },
    }));
  } catch (error) {
    if (generation !== ownerGeneration) return;
    alert(error.message);
  } finally {
    if (generation === ownerGeneration) {
      credentialBusy = false;
      updateCredentialControls();
    }
  }
});

async function gui(text, files) {
  const body = new FormData();
  body.append("text", text);
  for (const entry of files) body.append("files", entry.file || entry);

  const res = await fetch("/api/training/message", { method: "POST", body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Gửi thất bại");
  return data.reply;
}

async function guiTuComposer(event) {
  event.preventDefault();
  if (dangGui) return;
  const text = els.text.value.trim();
  const generation = ownerGeneration;
  if (!text && dinhKem.length === 0) return;

  if (onboardingController?.active) {
    if (!text) return;
    if (onboardingController.showStarter) {
      starterConsumed = true;
      els.starters.classList.add("hidden");
    }
    themDong({ role: "user", content: text, files: [] });
    els.text.value = "";
    khoa(true);
    try {
      await onboardingController.submit(text);
      if (generation !== ownerGeneration) return;
    } catch (error) {
      if (generation !== ownerGeneration) return;
      // Model/OpenCode có thể lỗi tạm thời. Backend đã giữ transcript/state;
      // trả lại đúng câu vừa gửi để người dùng bấm gửi lại thay vì phải gõ lại.
      if (!els.text.value.trim()) els.text.value = text;
      themDong({ role: "assistant", content: "Lỗi: " + error.message });
    } finally {
      khoa(false);
      if (generation === ownerGeneration) datDieuPhoiOnboarding(onboardingController);
    }
    return;
  }

  themDong({ role: "user", content: text, files: dinhKem });
  const cho = trangThaiCho("Đang đọc và suy nghĩ…");
  const tepGui = dinhKem;
  els.text.value = "";
  dinhKem = [];
  veDanhSachTep();
  khoa(true);

  try {
    const reply = await gui(text, tepGui);
    cho.remove();
    if (generation !== ownerGeneration) return;
    themDong({ role: "assistant", content: reply });
  } catch (error) {
    cho.remove();
    if (generation !== ownerGeneration) return;
    themDong({ role: "assistant", content: "Lỗi: " + error.message });
  } finally {
    khoa(false);
  }
}

els.form.addEventListener("submit", guiTuComposer);

els.btnStarter.addEventListener("click", () => {
  const message = els.btnStarter.textContent.trim();
  if (!message || dangGui) return;
  els.text.value = message;
  els.text.focus();
  els.form.requestSubmit();
});

els.text.addEventListener("keydown", (event) => {
  const dangSoanIme = event.isComposing || event.keyCode === 229;
  if (event.key !== "Enter" || event.shiftKey || dangSoanIme) return;
  event.preventDefault();
  if (!dangGui) els.form.requestSubmit();
});

els.btnSynth.addEventListener("click", async () => {
  if (dangGui) return;
  const generation = ownerGeneration;
  themDong({ role: "user", content: "Tổng hợp lại thành đoạn Soul hoàn chỉnh." });
  const cho = trangThaiCho("Đang tổng hợp Soul…");
  khoa(true);
  try {
    const res = await fetch("/api/training/synthesize", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Không tổng hợp được");
    cho.remove();
    if (generation !== ownerGeneration) return;
    themDong({ role: "assistant", content: data.reply });
  } catch (error) {
    cho.remove();
    if (generation !== ownerGeneration) return;
    themDong({ role: "assistant", content: "Lỗi: " + error.message });
  } finally {
    khoa(false);
  }
});

els.btnReset.addEventListener("click", async () => {
  if (!confirm("Xoá toàn bộ phiên huấn luyện và bắt đầu lại từ đầu?")) return;
  const generation = ownerGeneration;
  await fetch("/api/training", { method: "DELETE" });
  if (generation !== ownerGeneration) return;
  daNap = false;
  await napHuanLuyen();
});

function moHopChonTep(accept) {
  els.fileInput.setAttribute("accept", accept);
  els.fileInput.click();
}

els.btnAttach.addEventListener("click", () => moHopChonTep(IMAGE_ATTACHMENT_ACCEPT));
els.btnAttachFile.addEventListener("click", () => moHopChonTep(FILE_ATTACHMENT_ACCEPT));

els.fileInput.addEventListener("change", () => {
  themTepDaChon(Array.from(els.fileInput.files || []));
  els.fileInput.value = "";
  els.fileInput.setAttribute("accept", CANONICAL_ATTACHMENT_ACCEPT);
});

// Dan anh truc tiep bang Ctrl+V - cach nhanh nhat de dua anh chup man hinh vao.
els.text.addEventListener("paste", (event) => {
  const anh = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (anh.length === 0) return;
  event.preventDefault();
  themTepDaChon(anh);
});
