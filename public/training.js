import { dinhDangDungLuong } from "./chat-media.js";

const els = {
  panel: document.querySelector("#module-training"),
  log: document.querySelector("#training-log"),
  starters: document.querySelector("#onboarding-starters"),
  btnStarter: document.querySelector("#btn-onboarding-starter"),
  meta: document.querySelector("#training-meta"),
  form: document.querySelector("#training-form"),
  text: document.querySelector("#training-text"),
  fileInput: document.querySelector("#training-file-input"),
  fileList: document.querySelector("#training-files"),
  btnAttach: document.querySelector("#btn-training-attach"),
  btnSynth: document.querySelector("#btn-training-synth"),
  btnReset: document.querySelector("#btn-training-reset"),
};

let dinhKem = [];
let docDuocAnh = false;
let dangGui = false;
let daNap = false;
let ownerGeneration = 0;
let onboardingController = null;
let starterConsumed = false;
// Backend canonical luon doc duoc PDF/text/Markdown/CSV; docDuocAnh chi la
// capability rieng cua model, khong duoc dung de khoa tat ca cac loai tep.
const docDuocTepKhac = true;

/** UID boundary: xoa ngay transcript/attachment cu va huy hieu luc request cu. */
export function invalidateTrainingOwnerState() {
  ownerGeneration += 1;
  daNap = false;
  docDuocAnh = false;
  for (const entry of dinhKem) {
    if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  }
  dinhKem = [];
  veDanhSachTep();
  els.log.innerHTML = "";
  els.meta.textContent = "Đang tải hồ sơ Zalo hiện tại…";
  els.meta.classList.remove("training-warn");
}

export function datDieuPhoiOnboarding(controller) {
  onboardingController = controller || null;
  const dangOnboarding = Boolean(onboardingController?.active);
  const composerSpotlight = Boolean(onboardingController?.spotlightComposer);
  const showStarter = Boolean(onboardingController?.showStarter) && !starterConsumed;
  els.form.classList.toggle("training-form-onboarding", dangOnboarding);
  els.form.classList.toggle("training-form-composer-spotlight", composerSpotlight);
  els.starters.classList.toggle("hidden", !showStarter);
  els.btnAttach.disabled = dangGui || (dangOnboarding ? false : !docDuocAnh && !docDuocTepKhac);
  els.btnSynth.disabled = dangOnboarding || dangGui;
  els.btnReset.disabled = dangOnboarding || dangGui;
  els.text.placeholder = dangOnboarding
    ? "Trả lời Bot Chỉ huy từng câu một…"
    : "Dán ảnh chat mẫu bằng Ctrl+V, hoặc gõ lời dặn về giọng điệu…";
}

export function hienTinOnboarding(content) {
  els.log.querySelectorAll("[data-onboarding-message]").forEach((node) => node.remove());
  if (!content) return;
  const row = themDong({ role: "assistant", content });
  row.dataset.onboardingMessage = "true";
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
  els.btnSynth.disabled = khoaLai;
  els.btnReset.disabled = khoaLai;
}

function apDungMetaHuanLuyen(data) {
  docDuocAnh = Boolean(data.docDuocAnh);
  els.meta.textContent =
    `Model: ${data.model} · ${docDuocAnh ? "đọc được ảnh" : "KHÔNG đọc được ảnh"}` +
    (data.sessionId ? "" : " · chưa có phiên nào");
  els.meta.classList.toggle("training-warn", !docDuocAnh);
  els.btnAttach.disabled = dangGui;
  els.btnAttach.title = docDuocAnh
    ? "Đính ảnh hoặc tệp"
    : "Đính tệp; model hiện tại không đọc được ảnh";
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

export async function napHuanLuyen() {
  if (daNap) return;
  daNap = true;
  const generation = ownerGeneration;
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
    els.meta.classList.add("training-warn");
    daNap = false;
  }
}

window.addEventListener("zalo:canonical-save", (event) => {
  if (!["ai-model", "ai-config"].includes(event.detail?.section)) return;
  void napMetaHuanLuyen().catch((error) => {
    els.meta.textContent = error.message;
    els.meta.classList.add("training-warn");
  });
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

els.btnAttach.addEventListener("click", () => els.fileInput.click());

els.fileInput.addEventListener("change", () => {
  themTepDaChon(Array.from(els.fileInput.files || []));
  els.fileInput.value = "";
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
