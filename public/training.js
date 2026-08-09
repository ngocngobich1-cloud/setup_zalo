const els = {
  panel: document.querySelector("#module-training"),
  log: document.querySelector("#training-log"),
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

function veDanhSachTep() {
  els.fileList.innerHTML = "";
  els.fileList.classList.toggle("hidden", dinhKem.length === 0);
  dinhKem.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "training-chip";
    chip.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
    const bo = document.createElement("button");
    bo.type = "button";
    bo.textContent = "×";
    bo.setAttribute("aria-label", "Bỏ tệp");
    bo.onclick = () => { dinhKem.splice(index, 1); veDanhSachTep(); };
    chip.append(bo);
    els.fileList.append(chip);
  });
}

function themDong({ role, content, files }) {
  const row = document.createElement("div");
  row.className = `training-msg training-${role}`;

  if (files?.length) {
    const kem = document.createElement("div");
    kem.className = "training-msg-files";
    kem.textContent = "📎 " + files.map((f) => f.filename).join(", ");
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
  els.btnSynth.disabled = khoaLai;
  els.btnReset.disabled = khoaLai;
}

export async function napHuanLuyen() {
  if (daNap) return;
  daNap = true;
  try {
    const res = await fetch("/api/training");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Không tải được phiên huấn luyện");

    docDuocAnh = Boolean(data.docDuocAnh);
    els.meta.textContent =
      `Model: ${data.model} · ${docDuocAnh ? "đọc được ảnh" : "KHÔNG đọc được ảnh"}` +
      (data.sessionId ? "" : " · chưa có phiên nào");
    els.meta.classList.toggle("training-warn", !docDuocAnh);
    els.btnAttach.disabled = !docDuocAnh;
    els.btnAttach.title = docDuocAnh ? "Đính tệp" : "Model đang chọn không đọc được ảnh";

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
    els.meta.textContent = error.message;
    els.meta.classList.add("training-warn");
    daNap = false;
  }
}

async function gui(text, files) {
  const body = new FormData();
  body.append("text", text);
  for (const f of files) body.append("files", f);

  const res = await fetch("/api/training/message", { method: "POST", body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Gửi thất bại");
  return data.reply;
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (dangGui) return;
  const text = els.text.value.trim();
  if (!text && dinhKem.length === 0) return;

  themDong({ role: "user", content: text, files: dinhKem.map((f) => ({ filename: f.name })) });
  const cho = trangThaiCho("Đang đọc và suy nghĩ…");
  const tepGui = dinhKem;
  els.text.value = "";
  dinhKem = [];
  veDanhSachTep();
  khoa(true);

  try {
    const reply = await gui(text, tepGui);
    cho.remove();
    themDong({ role: "assistant", content: reply });
  } catch (error) {
    cho.remove();
    themDong({ role: "assistant", content: "Lỗi: " + error.message });
  } finally {
    khoa(false);
  }
});

els.btnSynth.addEventListener("click", async () => {
  if (dangGui) return;
  themDong({ role: "user", content: "Tổng hợp lại thành đoạn Soul hoàn chỉnh." });
  const cho = trangThaiCho("Đang tổng hợp Soul…");
  khoa(true);
  try {
    const res = await fetch("/api/training/synthesize", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Không tổng hợp được");
    cho.remove();
    themDong({ role: "assistant", content: data.reply });
  } catch (error) {
    cho.remove();
    themDong({ role: "assistant", content: "Lỗi: " + error.message });
  } finally {
    khoa(false);
  }
});

els.btnReset.addEventListener("click", async () => {
  if (!confirm("Xoá toàn bộ phiên huấn luyện và bắt đầu lại từ đầu?")) return;
  await fetch("/api/training", { method: "DELETE" });
  daNap = false;
  await napHuanLuyen();
});

els.btnAttach.addEventListener("click", () => els.fileInput.click());

els.fileInput.addEventListener("change", () => {
  dinhKem = [...dinhKem, ...Array.from(els.fileInput.files)].slice(0, 6);
  els.fileInput.value = "";
  veDanhSachTep();
});

// Dan anh truc tiep bang Ctrl+V - cach nhanh nhat de dua anh chup man hinh vao.
els.text.addEventListener("paste", (event) => {
  const anh = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (anh.length === 0) return;
  event.preventDefault();
  if (!docDuocAnh) {
    themDong({ role: "assistant", content: "Model đang chọn không đọc được ảnh — hãy đổi model trước khi dán ảnh." });
    return;
  }
  dinhKem = [...dinhKem, ...anh].slice(0, 6);
  veDanhSachTep();
});
