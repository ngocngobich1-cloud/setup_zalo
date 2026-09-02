import { CONFIG_TABS, invalidateSettingsOwnerState, pushActivityLog, refreshSettingsDynamicData, setSettingsOwnerUid } from "./config.js";
import { invalidateTrainingOwnerState, napHuanLuyen } from "./training.js";
import { dinhDangDungLuong, laAnhZalo, phanLoaiMediaTinNhan } from "./chat-media.js";
import { napEmail } from "./email.js";
import { napZoom } from "./zoom.js";
import { napWebsite } from "./website.js";
import {
  datManHinhHuanLuyen,
  dongBoTrangThaiZalo,
  khoiTaoOnboarding,
  sauKhiDongCauHinh,
  truocKhiMoCauHinh,
} from "./onboarding.js";
const socket = io();
// Chi hien log CUA TAI KHOAN ZALO DANG XEM. Dong log sinh ra ngay truoc khi doi
// tai khoan van co the toi muon, khong duoc de no lot vao man LOG cua tai khoan moi.
socket.on("activity-log", (entry) => {
  if (!entry) return;
  if (entry.ownerUid && state.uid && String(entry.ownerUid) !== String(state.uid)) return;
  if (entry.ownerUid && !state.uid) return;
  pushActivityLog(entry);
});

const state = {
  loggedIn: false,
  loggingIn: false,
  uid: null,
  displayName: null,
  myAvatar: null,
  qr: {},
  ketNoi: { trangThai: "chua", lyDo: "" },
  threads: [],
  selectedThread: null,
  messagesByThread: new Map(),
  // "threadId|messageId" -> [{ ten, count, mine }]. Trinh duyet chi giu de VE;
  // nguon su that nam o may chu va den qua socket.
  reactionsByMessage: new Map(),
};

const els = {
  loginScreen: document.querySelector("#login-screen"),
  chatApp: document.querySelector("#chat-app"),
  btnLogin: document.querySelector("#btn-login"),
  qrPanel: document.querySelector("#qr-panel"),
  qrImage: document.querySelector("#qr-image"),
  qrStatus: document.querySelector("#qr-status"),
  btnRetryQr: document.querySelector("#btn-retry-qr"),
  myAvatar: document.querySelector("#my-avatar"),
  myName: document.querySelector("#my-name"),
  search: document.querySelector("#thread-search"),
  threads: document.querySelector("#threads"),
  threadEmpty: document.querySelector("#thread-empty"),
  chatEmpty: document.querySelector("#chat-empty"),
  chatPanel: document.querySelector("#chat-panel"),
  chatAvatar: document.querySelector("#chat-avatar"),
  chatTitle: document.querySelector("#chat-title-text"),
  messages: document.querySelector("#messages"),
  form: document.querySelector("#send-form"),
  input: document.querySelector("#message-input"),
  fileInput: document.querySelector("#chat-file-input"),
  attachmentPreview: document.querySelector("#chat-attachment-preview"),
  btnImage: document.querySelector("#btn-chat-image"),
  btnAttach: document.querySelector("#btn-chat-attach"),
  btnSend: document.querySelector("#btn-chat-send"),
  mobileMenus: [...document.querySelectorAll(".mobile-menu-button")],
  mobileChatBack: document.querySelector(".mobile-chat-back"),
  mobileDrawerBackdrop: document.querySelector(".mobile-drawer-backdrop"),
  
  zaloStatusDot: document.querySelector("#zalo-status-dot"),
  zaloStatusText: document.querySelector("#zalo-status-text"),
  btnZaloReconnect: document.querySelector("#btn-zalo-reconnect"),
  btnZaloLogout: document.querySelector("#btn-zalo-logout"),
  btnRefreshThreads: document.querySelector("#btn-refresh-threads"),
  botToggle: document.querySelector("#bot-toggle"),
  botState: document.querySelector("#bot-state"),
  botHint: document.querySelector("#bot-hint"),
  appShell: document.querySelector("#app-shell"),
  appResizer: document.querySelector("#app-resizer"),
  moduleNav: document.querySelector("#module-nav"),
  accountName: document.querySelector("#account-name"),
  accountAvatar: document.querySelector("#account-avatar"),
  accountToggle: document.querySelector("#account-toggle"),
  accountMenu: document.querySelector("#account-menu"),
  settingsModal: document.querySelector("#settings-modal"),
  btnCloseSettings: document.querySelector("#btn-close-settings"),
  btnSticker: document.querySelector("#btn-chat-sticker"),
  stickerPicker: document.querySelector("#sticker-picker"),
  msgActionSheet: document.querySelector("#msg-action-sheet"),
  msgActionBackdrop: document.querySelector("#msg-action-backdrop"),
  msgActionReactions: document.querySelector("#msg-action-reactions"),
  msgActionList: document.querySelector("#msg-action-list"),
  forwardDialog: document.querySelector("#forward-dialog"),
  forwardSearch: document.querySelector("#forward-search"),
  forwardList: document.querySelector("#forward-list"),
  btnForwardClose: document.querySelector("#btn-forward-close"),
};

let tepChat = null;
let dangGuiTin = false;
let frontendOwnerGeneration = 0;
let mobileThreadScrollTop = 0;

const MOBILE_VISUAL_VIEWPORT_HEIGHT_PROPERTY = "--mobile-vv-height";
const MOBILE_VISUAL_VIEWPORT_SETTLE_MS = 120;
let mobileVisualViewportSyncInitialized = false;
let mobileVisualViewportAnimationFrame = null;
let mobileVisualViewportSettleTimer = null;

export function syncMobileVisualViewport({ settle = true } = {}) {
  const visualHeight = Number(window.visualViewport?.height);
  const fallbackHeight = Number(window.innerHeight);
  const height = Number.isFinite(visualHeight) && visualHeight > 0
    ? visualHeight
    : fallbackHeight;
  if (!Number.isFinite(height) || height <= 0) return;

  document.documentElement.style.setProperty(MOBILE_VISUAL_VIEWPORT_HEIGHT_PROPERTY, `${height}px`);
  if (!settle) return;

  if (mobileVisualViewportAnimationFrame !== null && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(mobileVisualViewportAnimationFrame);
  }
  if (typeof window.requestAnimationFrame === "function") {
    mobileVisualViewportAnimationFrame = window.requestAnimationFrame(() => {
      mobileVisualViewportAnimationFrame = null;
      syncMobileVisualViewport({ settle: false });
    });
  }

  if (mobileVisualViewportSettleTimer !== null) window.clearTimeout(mobileVisualViewportSettleTimer);
  mobileVisualViewportSettleTimer = window.setTimeout(() => {
    mobileVisualViewportSettleTimer = null;
    syncMobileVisualViewport({ settle: false });
  }, MOBILE_VISUAL_VIEWPORT_SETTLE_MS);
}

export function initMobileVisualViewportSync() {
  if (mobileVisualViewportSyncInitialized) return;
  mobileVisualViewportSyncInitialized = true;
  window.visualViewport?.addEventListener("resize", syncMobileVisualViewport, { passive: true });
  window.addEventListener("resize", syncMobileVisualViewport, { passive: true });
  syncMobileVisualViewport();
}

function chupFrontendOwner() {
  return {
    ownerUid: state.uid ? String(state.uid) : null,
    ownerGeneration: frontendOwnerGeneration,
  };
}

function frontendOwnerConHieuLuc(owner) {
  const ownerUidHienTai = state.uid ? String(state.uid) : null;
  return owner.ownerGeneration === frontendOwnerGeneration && owner.ownerUid === ownerUidHienTai;
}

els.btnLogin.addEventListener("click", startLogin);
els.btnRetryQr.addEventListener("click", startLogin);

els.btnZaloReconnect?.addEventListener("click", async () => {
  els.btnZaloReconnect.disabled = true;
  els.zaloStatusText.textContent = "Đang kết nối lại…";
  try {
    const res = await fetch("/api/zalo/reconnect", { method: "POST" });
    const data = await res.json();
    if (!data.ok) alert(data.message || "Nối lại không được.");
  } catch (error) {
    alert("Nối lại không được: " + error.message);
  } finally {
    els.btnZaloReconnect.disabled = false;
  }
});

// Khac han "Dang xuat" trong menu tai khoan: cai do thoat khoi app, cai nay
// thoat khoi ZALO va bat buoc quet lai ma QR. Hoi that ro de khong bam nham.
els.btnZaloLogout?.addEventListener("click", async () => {
  const xacNhan = confirm(
    "ĐĂNG XUẤT KHỎI ZALO?\n\n" +
      "Đây KHÔNG phải đăng xuất khỏi app.\n" +
      "Bot sẽ ngừng nhận và trả lời tin nhắn Zalo cho tới khi chị quét lại mã QR.\n\n" +
      "Tin nhắn cũ, hồ sơ khách và cấu hình vẫn giữ nguyên."
  );
  if (!xacNhan) return;
  try {
    await fetch("/api/zalo/logout", { method: "POST" });
  } catch (error) {
    alert("Không đăng xuất được: " + error.message);
  }
});
els.search.addEventListener("input", renderThreads);
els.form.addEventListener("submit", sendMessage);
els.btnImage.addEventListener("click", () => {
  if (dangGuiTin) return;
  els.fileInput.accept = "image/*";
  els.fileInput.click();
});
els.btnAttach.addEventListener("click", () => {
  if (dangGuiTin) return;
  els.fileInput.accept = "";
  els.fileInput.click();
});
els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files?.[0];
  els.fileInput.value = "";
  if (!file) return;
  try {
    await chonTepChat(file);
  } catch (error) {
    alert(error.message);
  }
});

els.mobileMenus.forEach((button) => button.addEventListener("click", openMobileDrawer));
els.mobileChatBack?.addEventListener("click", closeMobileLayerWithHistory);
els.mobileDrawerBackdrop?.addEventListener("click", closeMobileLayerWithHistory);
window.addEventListener("popstate", () => {
  if (els.appShell.classList.contains("mobile-drawer-open")) {
    closeMobileDrawer();
    return;
  }
  if (els.chatApp.classList.contains("mobile-chat-open")) closeMobileChat();
});

socket.on("state", applyState);
socket.on("threads", (threads) => {
  state.threads = threads || [];
  renderThreads();
});
socket.on("thread-refresh", (thread) => {
  const index = state.threads.findIndex((item) => item.id === thread.id);
  if (index >= 0) state.threads[index] = thread;
  else state.threads.unshift(thread);
  renderThreads();
});
socket.on("new-message", (message) => {
  const list = state.messagesByThread.get(message.threadId) || [];
  if (!list.some((item) => item.id === message.id)) {
    list.push(message);
    state.messagesByThread.set(message.threadId, list);
  }
  if (state.selectedThread?.id === message.threadId) renderMessages(list);
});

socket.on("message-reaction", ({ threadId, messageId, reactions }) => {
  datCamXuc(threadId, messageId, reactions);
  if (state.selectedThread?.id === threadId) {
    renderMessages(state.messagesByThread.get(threadId) || []);
  }
});

// Tin bi thu hoi: doi NOI DUNG tai cho chu khong go dong di. Khung chat thung
// mot lo giua doan la nguoi doc mat mach; Zalo that cung giu lai mot dong xam.
socket.on("message-recalled", ({ threadId, messageId, content, msgType }) => {
  const list = state.messagesByThread.get(threadId);
  const tin = list?.find((item) => String(item.id) === String(messageId));
  if (!tin) return;
  tin.content = content;
  tin.msgType = msgType;
  tin.stickerUrl = null;
  tin.isSticker = false;
  if (state.selectedThread?.id === threadId) renderMessages(list);
});

socket.on("message-deleted", ({ threadId, messageId }) => {
  const list = state.messagesByThread.get(threadId);
  if (!list) return;
  const con = list.filter((item) => String(item.id) !== String(messageId));
  state.messagesByThread.set(threadId, con);
  xoaCamXuc(threadId, messageId);
  if (state.selectedThread?.id === threadId) renderMessages(con);
});

initMobileVisualViewportSync();
bootstrap();

async function bootstrap() {
  const res = await fetch("/api/bootstrap");
  if (res.status === 401) {
    window.location.href = "/login";
    return;
  }
  const data = await res.json();
  if (data.user?.username) setAccount(data.user.username);
  applyState(data);
  state.threads = data.threads || [];
  renderThreads();
}

els.btnRefreshThreads?.addEventListener("click", async () => {
  const nut = els.btnRefreshThreads;
  const owner = chupFrontendOwner();
  nut.disabled = true;
  nut.classList.add("dang-quay");
  try {
    const res = await fetch("/api/threads/refresh", { method: "POST" });
    const data = await res.json();
    if (!frontendOwnerConHieuLuc(owner)) return;
    if (!res.ok) throw new Error(data.error || "Không làm mới được");
    state.threads = data.threads || state.threads;
    // Tieu de cuoc tro chuyen dang mo cung phai doi theo, khong thi van hien ten cu.
    if (state.selectedThread) {
      const moi = state.threads.find((t) => t.id === state.selectedThread.id);
      if (moi) {
        state.selectedThread = moi;
        els.chatTitle.textContent = moi.title || moi.id;
        setAvatar(els.chatAvatar, moi.avatar, moi.title || moi.id);
      }
    }
    renderThreads();
  } catch (error) {
    if (frontendOwnerConHieuLuc(owner)) alert(error.message);
  } finally {
    nut.disabled = false;
    nut.classList.remove("dang-quay");
  }
});

// --- Cong tac bot ---

function veCongTac({ enabled, ready }) {
  els.botToggle.setAttribute("aria-checked", String(Boolean(enabled)));
  els.botState.textContent = enabled ? "Bot đang BẬT" : "Bot đang TẮT";
  els.botHint.textContent = enabled
    ? "đang tự trả lời khách"
    : ready
      ? "không tự trả lời khách"
      : "chưa cấu hình xong";
}

async function napTrangThaiBot() {
  const owner = chupFrontendOwner();
  try {
    const res = await fetch("/api/bot/status");
    const data = res.ok ? await res.json() : null;
    if (!frontendOwnerConHieuLuc(owner)) return;
    if (data) veCongTac(data);
  } catch { /* mat mang thi giu nguyen hien thi */ }
}

els.botToggle?.addEventListener("click", async () => {
  const dangBat = els.botToggle.getAttribute("aria-checked") === "true";
  if (!dangBat && !confirm("Bật bot? Từ giờ bot sẽ TỰ TRẢ LỜI khách trong phạm vi đã cấu hình.")) return;

  const owner = chupFrontendOwner();
  els.botToggle.disabled = true;
  try {
    const res = await fetch("/api/bot/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !dangBat }),
    });
    const data = await res.json();
    if (!frontendOwnerConHieuLuc(owner)) return;
    if (!res.ok) throw new Error(data.error || "Không đổi được");
    veCongTac(data);
  } catch (error) {
    if (frontendOwnerConHieuLuc(owner)) alert(error.message);
  } finally {
    els.botToggle.disabled = false;
  }
});

function setAccount(username) {
  if (els.accountName) els.accountName.textContent = username;
  if (els.accountAvatar) els.accountAvatar.textContent = fallbackLetter(username);
}

function applyState(next) {
  const daDangNhap = state.loggedIn;
  const uidCu = state.uid ? String(state.uid) : null;
  const uidMoi = next.uid ? String(next.uid) : null;
  const doiOwner = uidCu !== uidMoi;
  if (doiOwner) invalidateOwnerFrontendState(uidMoi);
  Object.assign(state, {
    loggedIn: Boolean(next.loggedIn),
    loggingIn: Boolean(next.loggingIn),
    uid: next.uid || null,
    displayName: next.displayName || null,
    myAvatar: next.myAvatar || null,
    qr: next.qr || {},
    ketNoi: next.ketNoi || { trangThai: "chua", lyDo: "" },
  });
  renderShell();
  renderLogin();
  renderZaloStatus();
  void dongBoTrangThaiZalo({
    loggedIn: state.loggedIn,
    justLoggedIn: !daDangNhap && state.loggedIn,
    ownerUid: state.uid,
  });
  if (doiOwner && state.loggedIn) {
    void napTrangThaiBot();
    if (!document.querySelector("#module-training")?.classList.contains("hidden")) void napHuanLuyen();
    if (!els.settingsModal.classList.contains("hidden")) refreshSettingsDynamicData();
  }
}

function invalidateOwnerFrontendState(nextOwnerUid = null) {
  frontendOwnerGeneration += 1;
  state.threads = [];
  state.selectedThread = null;
  state.messagesByThread.clear();
  state.reactionsByMessage.clear();
  daBaoDaXem.clear();
  dongLopThaoTacTin();
  dongBangSticker();
  datLaiNhipGoPhim();
  els.search.value = "";
  els.messages.innerHTML = "";
  els.chatPanel.classList.add("hidden");
  els.chatEmpty.classList.remove("hidden");
  boTepChat();
  veCongTac({ enabled: false, ready: false });
  setSettingsOwnerUid(nextOwnerUid);
  invalidateSettingsOwnerState();
  invalidateTrainingOwnerState();
  renderThreads();
}

function renderShell() {
  els.loginScreen.classList.toggle("hidden", state.loggedIn);
  els.chatApp.classList.toggle("hidden", !state.loggedIn);
  els.myName.textContent = state.displayName || "Zalo Web";
  setAvatar(els.myAvatar, state.myAvatar, state.displayName || "Me");
}

/**
 * Truoc day cho nay la mot dong chu cung "Dang ket noi realtime" trong HTML,
 * hien y het nhau du duong day song hay chet. Gio no doc trang thai that.
 */
const NHAN_KET_NOI = {
  song: { chu: "Đã kết nối", mau: "ok" },
  "dang-noi": { chu: "Đang kết nối…", mau: "cho" },
  chet: { chu: "MẤT KẾT NỐI", mau: "loi" },
  chua: { chu: "Chưa kết nối", mau: "cho" },
};

function renderZaloStatus() {
  if (!els.zaloStatusText) return;
  const { trangThai = "chua", lyDo = "" } = state.ketNoi || {};
  const nhan = NHAN_KET_NOI[trangThai] || NHAN_KET_NOI.chua;

  els.zaloStatusText.textContent = nhan.chu;
  els.zaloStatusDot.className = `zalo-dot zalo-dot-${nhan.mau}`;
  els.zaloStatusText.parentElement.title = lyDo || nhan.chu;

  // Nut noi lai chi hien khi thuc su can, de khoi lam roi mat.
  els.btnZaloReconnect?.classList.toggle("hidden", trangThai === "song" || trangThai === "dang-noi");
}

function renderLogin() {
  const showQr = state.loggingIn || Boolean(state.qr?.image) || ["expired", "declined", "error"].includes(state.qr?.status);
  els.btnLogin.classList.toggle("hidden", showQr);
  els.btnLogin.disabled = state.loggingIn;
  els.qrPanel.classList.toggle("hidden", !showQr);
  els.qrImage.classList.toggle("hidden", !state.qr?.image);
  if (state.qr?.image) els.qrImage.src = state.qr.image;
  els.qrStatus.textContent = [state.qr?.message, state.qr?.scannedName].filter(Boolean).join(" ");
  els.btnRetryQr.classList.toggle("hidden", !["expired", "declined", "error"].includes(state.qr?.status));
}

async function startLogin() {
  els.btnLogin.disabled = true;
  await fetch("/api/login/start", { method: "POST" });
}

function isMobileInbox() {
  if (typeof window.matchMedia === "function") return window.matchMedia("(max-width: 760px)").matches;
  return window.innerWidth <= 760;
}

function openMobileDrawer() {
  if (!isMobileInbox() || els.appShell.classList.contains("mobile-drawer-open")) return;
  els.appShell.classList.add("mobile-drawer-open");
  els.mobileDrawerBackdrop?.classList.remove("hidden");
  history.pushState({ inbox: "drawer" }, "");
}

function closeMobileDrawer() {
  els.appShell.classList.remove("mobile-drawer-open");
  els.mobileDrawerBackdrop?.classList.add("hidden");
}

function openMobileChat(thread) {
  if (!isMobileInbox()) return;
  mobileThreadScrollTop = els.threads.scrollTop;
  els.chatApp.classList.add("mobile-chat-open");
  if (history.state?.inbox !== "chat" || history.state?.threadId !== thread.id) {
    history.pushState({ inbox: "chat", threadId: thread.id }, "");
  }
}

function closeMobileChat() {
  els.chatApp.classList.remove("mobile-chat-open");
  els.threads.scrollTop = mobileThreadScrollTop;
  window.requestAnimationFrame?.(() => {
    els.threads.scrollTop = mobileThreadScrollTop;
  });
}

function closeMobileLayerWithHistory() {
  if (!isMobileInbox()) return;
  if (history.state?.inbox === "drawer" || history.state?.inbox === "chat") history.back();
  else {
    closeMobileDrawer();
    closeMobileChat();
  }
}

function renderThreads() {
  const query = els.search.value.trim().toLowerCase();
  const filtered = state.threads.filter((thread) => {
    const haystack = `${thread.title || ""} ${thread.lastMessage || ""} ${thread.id}`.toLowerCase();
    return haystack.includes(query);
  });
  els.threads.innerHTML = "";
  els.threadEmpty.classList.toggle("hidden", filtered.length > 0);
  for (const thread of filtered) {
    const li = document.createElement("li");
    li.className = `thread-item${state.selectedThread?.id === thread.id ? " active" : ""}`;
    li.addEventListener("click", () => selectThread(thread));

    const avatar = document.createElement("div");
    avatar.className = "avatar avatar-medium";
    setAvatar(avatar, thread.avatar, thread.title || thread.id);

    const body = document.createElement("div");
    body.className = "thread-body";
    const heading = document.createElement("div");
    heading.className = "thread-heading";
    const title = document.createElement("div");
    title.className = "thread-title";
    title.textContent = thread.title || thread.id;
    const time = document.createElement("time");
    time.className = "thread-time";
    time.textContent = formatThreadTime(thread.lastMessageAt);
    const preview = document.createElement("div");
    preview.className = "thread-preview";
    preview.textContent = formatThreadPreview(thread.lastMessage);
    heading.append(title, time);
    body.append(heading, preview);
    li.append(avatar, body);
    els.threads.append(li);
  }
}

function formatThreadPreview(lastMessage) {
  if (!lastMessage) return "";
  const text = String(lastMessage);
  if (!text.trim().startsWith("{")) return text;
  try {
    const payload = JSON.parse(text);
    const stickerPayload = payload
      && typeof payload === "object"
      && !Array.isArray(payload)
      && Number.isFinite(Number(payload.id))
      && Number(payload.id) > 0
      && Number.isFinite(Number(payload.catId))
      && Number(payload.catId) > 0
      && Number(payload.type) === 7;
    return stickerPayload ? "Sticker" : text;
  } catch {
    return text;
  }
}

async function selectThread(thread) {
  if (state.selectedThread?.id && state.selectedThread.id !== thread.id) boTepChat();
  dongLopThaoTacTin();
  dongBangSticker();
  datLaiNhipGoPhim();
  openMobileChat(thread);
  state.selectedThread = thread;
  renderThreads();
  els.chatEmpty.classList.add("hidden");
  els.chatPanel.classList.remove("hidden");
  els.chatTitle.textContent = thread.title || thread.id;
  setAvatar(els.chatAvatar, thread.avatar, thread.title || thread.id);

  if (!state.messagesByThread.has(thread.id)) {
    els.messages.textContent = "Dang tai lich su...";
    const owner = chupFrontendOwner();
    const res = await fetch(`/api/messages/${encodeURIComponent(thread.id)}`);
    const data = await res.json();
    if (!frontendOwnerConHieuLuc(owner)) return;
    state.messagesByThread.set(thread.id, data.messages || []);
  }
  if (state.selectedThread?.id === thread.id) {
    renderMessages(state.messagesByThread.get(thread.id) || []);
  }
}

function docKichThuocAnh(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Không đọc được ảnh đã chọn."));
    image.src = url;
  });
}

function boTepChat() {
  if (tepChat?.previewUrl) URL.revokeObjectURL(tepChat.previewUrl);
  tepChat = null;
  veTepChat();
}

async function chonTepChat(file) {
  boTepChat();
  const previewUrl = laAnhZalo(file) ? URL.createObjectURL(file) : null;
  try {
    const dimensions = previewUrl ? await docKichThuocAnh(previewUrl) : {};
    tepChat = { file, previewUrl, ...dimensions };
    veTepChat();
  } catch (error) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    throw error;
  }
}

function taoThongTinTep(filename, size) {
  const info = document.createElement("span");
  info.className = "chat-file-info";
  const name = document.createElement("strong");
  name.textContent = filename || "Tệp đính kèm";
  info.append(name);
  const readableSize = dinhDangDungLuong(size);
  if (readableSize) {
    const meta = document.createElement("small");
    meta.textContent = readableSize;
    info.append(meta);
  }
  return info;
}

function veTepChat() {
  els.attachmentPreview.innerHTML = "";
  els.attachmentPreview.classList.toggle("hidden", !tepChat);
  if (!tepChat) return;

  const card = document.createElement("div");
  card.className = "chat-selected-file";
  if (tepChat.previewUrl) {
    const image = document.createElement("img");
    image.src = tepChat.previewUrl;
    image.alt = tepChat.file.name || "Ảnh đã chọn";
    card.append(image);
  } else {
    const icon = document.createElement("span");
    icon.className = "chat-file-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📄";
    card.append(icon);
  }
  card.append(taoThongTinTep(tepChat.file.name, tepChat.file.size));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "chat-file-remove";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Bỏ tệp đính kèm");
  remove.addEventListener("click", boTepChat);
  card.append(remove);
  els.attachmentPreview.append(card);
}

function taoTheMedia(message) {
  const media = phanLoaiMediaTinNhan(message);
  if (!media) return null;

  if (media.kind === "image") {
    const wrap = document.createElement("div");
    wrap.className = "chat-image-wrap";
    const link = document.createElement("a");
    link.className = "chat-image-link";
    link.href = media.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Mở ảnh kích thước lớn");
    const image = document.createElement("img");
    image.className = "chat-image";
    image.src = media.thumbnailUrl;
    image.alt = media.filename || "Ảnh đính kèm";
    image.loading = "lazy";
    image.onerror = () => {
      const fallback = document.createElement("span");
      fallback.className = "chat-media-fallback";
      fallback.textContent = "Mở ảnh";
      image.replaceWith(fallback);
    };
    link.append(image);
    wrap.append(link);
    if (media.caption) {
      const caption = document.createElement("div");
      caption.className = "chat-media-caption";
      caption.textContent = media.caption;
      wrap.append(caption);
    }
    return wrap;
  }

  const link = document.createElement("a");
  link.className = "chat-file-card";
  link.href = media.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const icon = document.createElement("span");
  icon.className = "chat-file-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "📄";
  const action = document.createElement("span");
  action.className = "chat-file-action";
  action.textContent = "Mở / tải";
  link.append(icon, taoThongTinTep(media.filename, media.size), action);
  return link;
}

function renderMessages(messages) {
  els.messages.innerHTML = "";
  let lastDay = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const currentDay = dayKey(message.ts);
    if (currentDay !== lastDay) {
      const divider = document.createElement("div");
      divider.className = "date-divider";
      divider.textContent = formatDateDivider(message.ts);
      els.messages.append(divider);
      lastDay = currentDay;
    }

    const previous = messages[index - 1];
    const next = messages[index + 1];
    const startsCluster = !sameMessageCluster(previous, message);
    const endsCluster = !sameMessageCluster(message, next);
    const row = document.createElement("div");
    row.className = `bubble-row ${message.isSelf ? "self" : "other"}`;
    row.classList.toggle("cluster-start", startsCluster);
    row.classList.toggle("cluster-end", endsCluster);

    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (startsCluster && !message.isSelf && Number(state.selectedThread?.threadType) === 1 && message.senderName) {
      const sender = document.createElement("div");
      sender.className = "sender";
      sender.textContent = message.senderName;
      bubble.append(sender);
    }
    const media = daThuHoi(message) ? null : taoTheMedia(message);
    if (daThuHoi(message)) {
      // Chi hien dong thay the. Khong dung lai anh/tep/sticker cua tin da thu
      // hoi, va khong bao gio ve payload thu hoi cua Zalo ra man hinh.
      bubble.classList.add("bubble-recalled");
      const nhan = document.createElement("em");
      nhan.className = "recalled-note";
      nhan.textContent = message.content || "Tin nhắn đã được thu hồi";
      bubble.append(nhan);
    } else if (media) {
      bubble.classList.add("bubble-media");
      bubble.append(media);
    } else if (message.stickerUrl) {
      bubble.classList.add("bubble-sticker");
      const sticker = document.createElement("img");
      sticker.className = "sticker";
      sticker.src = message.stickerUrl;
      sticker.alt = "Sticker";
      sticker.onerror = () => {
        bubble.classList.remove("bubble-sticker");
        sticker.replaceWith(document.createTextNode("[Sticker]"));
      };
      bubble.append(sticker);
    } else if (message.isSticker) {
      bubble.append(document.createTextNode("[Sticker]"));
    } else {
      bubble.append(document.createTextNode(message.content || ""));
    }
    if (endsCluster) {
      const time = document.createElement("time");
      time.className = "bubble-time";
      time.textContent = formatMessageTime(message.ts);
      bubble.append(time);
    }
    wrap.append(bubble);

    const chip = veCamXuc(message);
    if (chip) wrap.append(chip);
    // Nut thao tac nam trong bubble-wrap chu khong phai trong header hoi thoai:
    // thao tac nay thuoc ve MOT tin cu the, phai bam ngay canh tin do.
    wrap.append(taoNutThaoTacTin(message));

    if (message.isSelf) {
      row.append(wrap);
    } else {
      const avatarSlot = document.createElement("div");
      if (endsCluster) {
        avatarSlot.className = "avatar bubble-avatar";
        setAvatar(
          avatarSlot,
          message.senderAvatar || state.selectedThread?.avatar,
          message.senderName || state.selectedThread?.title || "?",
        );
      } else {
        avatarSlot.className = "bubble-avatar-spacer";
        avatarSlot.setAttribute("aria-hidden", "true");
      }
      row.append(avatarSlot, wrap);
    }
    els.messages.append(row);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
  thuBaoDaXem();
}

function sameMessageCluster(first, second) {
  if (!first || !second) return false;
  const sameSide = Boolean(first.isSelf) === Boolean(second.isSelf);
  const sameDay = dayKey(first.ts) === dayKey(second.ts);
  if (!sameSide || !sameDay) return false;
  if (first.isSelf || Number(state.selectedThread?.threadType) !== 1) return true;

  const firstSenderId = String(first.senderId ?? "").trim();
  const secondSenderId = String(second.senderId ?? "").trim();
  return Boolean(firstSenderId) && firstSenderId === secondSenderId;
}

async function sendMessage(event) {
  event.preventDefault();
  if (dangGuiTin) return;
  const text = els.input.value.trim();
  if ((!text && !tepChat) || !state.selectedThread) return;

  const thread = state.selectedThread;
  const attachment = tepChat;
  const body = new FormData();
  body.append("threadId", thread.id);
  body.append("threadType", thread.threadType);
  body.append("text", text);
  if (attachment) {
    body.append("file", attachment.file);
    if (attachment.width) body.append("width", String(attachment.width));
    if (attachment.height) body.append("height", String(attachment.height));
  }

  dangGuiTin = true;
  els.btnSend.disabled = true;
  els.btnImage.disabled = true;
  els.btnAttach.disabled = true;
  try {
    const res = await fetch("/api/send", { method: "POST", body });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Không gửi được tin nhắn.");
    els.input.value = "";
    datLaiNhipGoPhim();
    if (attachment === tepChat) boTepChat();
  } catch (error) {
    alert(error.message);
  } finally {
    dangGuiTin = false;
    els.btnSend.disabled = false;
    els.btnImage.disabled = false;
    els.btnAttach.disabled = false;
  }
}

function setAvatar(el, url, name) {
  el.innerHTML = "";
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = name || "avatar";
    img.onerror = () => {
      el.textContent = fallbackLetter(name);
    };
    el.append(img);
  } else {
    el.textContent = fallbackLetter(name);
  }
}

function fallbackLetter(name) {
  return String(name || "?").trim().charAt(0).toUpperCase() || "?";
}

function normalizeTs(ts) {
  const value = Number(ts || Date.now());
  return value < 1e12 ? value * 1000 : value;
}

function dayKey(ts) {
  return new Date(normalizeTs(ts)).toISOString().slice(0, 10);
}

function formatMessageTime(ts) {
  const date = new Date(normalizeTs(ts));
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const hhmm = date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  if (dayKey(date) === dayKey(now)) return hhmm;
  if (dayKey(date) === dayKey(yesterday)) return `Hom qua, ${hhmm}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })}, ${hhmm}`;
  }
  return `${date.toLocaleDateString("vi-VN")}, ${hhmm}`;
}

function formatThreadTime(ts) {
  if (ts === null || ts === undefined || ts === "") return "";
  const numeric = Number(ts);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

function formatDateDivider(ts) {
  const date = new Date(normalizeTs(ts));
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return "Hom nay";
  if (dayKey(date) === dayKey(yesterday)) return "Hom qua";
  return date.toLocaleDateString("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// --- Settings Dynamic Tabs Logic ---
const tabsContainer = document.querySelector("#modal-tabs-container");
const bodyContainer = document.querySelector("#modal-body-container");

function renderSettingsTabs() {
  tabsContainer.innerHTML = "";
  bodyContainer.innerHTML = "";

  CONFIG_TABS.forEach((tab, index) => {
    const btn = document.createElement("button");
    btn.className = "tab-button";
    if (index === 0) btn.classList.add("active");
    btn.dataset.tab = tab.id;
    btn.type = "button";
    btn.textContent = tab.label;
    
    const pane = document.createElement("div");
    pane.className = "tab-pane";
    if (index === 0) pane.classList.add("active");
    pane.id = `tab-${tab.id}`;
    
    tab.mount(pane);

    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      pane.classList.add("active");
    });

    tabsContainer.append(btn);
    bodyContainer.append(pane);
  });
}

renderSettingsTabs();

function openSettings() {
  truocKhiMoCauHinh();
  // Nap lai TOAN BO du lieu dong theo tai khoan Zalo: nhom/nick AI Chat, lich hen,
  // khach hang, nhat ky, nick OTP/Admin. KHONG await: modal phai bat len ngay,
  // du lieu tu dien vao khi mang tra ve.
  refreshSettingsDynamicData();
  els.settingsModal.classList.remove("hidden");
}

els.btnCloseSettings?.addEventListener("click", () => {
  els.settingsModal.classList.add("hidden");
  sauKhiDongCauHinh();
});

// --- Dropdown tai khoan ---

function toggleAccountMenu(open) {
  const next = open ?? els.accountMenu.classList.contains("hidden");
  els.accountMenu.classList.toggle("hidden", !next);
  els.accountToggle.setAttribute("aria-expanded", String(next));
}

els.accountToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleAccountMenu();
});

document.addEventListener("click", (event) => {
  if (!els.accountMenu || els.accountMenu.classList.contains("hidden")) return;
  if (els.accountMenu.contains(event.target) || els.accountToggle.contains(event.target)) return;
  toggleAccountMenu(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleAccountMenu(false);
});

els.accountMenu?.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  toggleAccountMenu(false);

  if (action === "profile") {
    alert("Thông tin cá nhân đang được xây dựng.");
    return;
  }
  // Khong con nhanh "settings" o day: muc Cau hinh da go khoi menu avatar.
  // openSettings() van duoc giu nguyen va van do icon banh rang goi (o duoi).
  if (action === "logout") {
    if (!confirm("Đăng xuất khỏi ứng dụng?")) return;
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }
});

// --- Nut Cau hinh + menu Dang xuat o cuoi thanh dieu huong ---
//
// Hai muc trong menu Dang xuat KHONG tu goi API. Chung bam thang vao hai nut
// cu (nut "Dang xuat" trong menu tai khoan va #btn-zalo-logout) - hai nut do
// gio an di nhung van nam trong DOM. Lam vay de dung lai NGUYEN VEN hop xac
// nhan, endpoint, redirect va cach bao loi san co, khong viet lai logout lan
// thu hai. Day la HAI viec khac han nhau:
//   - Dang xuat app  -> POST /api/auth/logout, thoat phien dang nhap web
//   - Dang xuat Zalo -> POST /api/zalo/logout, bot ngung nhan tin cho toi khi
//                       quet lai ma QR
// Khong duoc gom chung thanh mot lenh.

const railSettings = document.querySelector("#rail-settings");
const railLogoutToggle = document.querySelector("#rail-logout-toggle");
const railLogoutMenu = document.querySelector("#rail-logout-menu");

railSettings?.addEventListener("click", openSettings);
railSettings?.addEventListener("click", () => {
  if (isMobileInbox() && els.appShell.classList.contains("mobile-drawer-open")) closeMobileLayerWithHistory();
});
document.querySelector("#btn-training-open-config")?.addEventListener("click", openSettings);

function toggleRailLogoutMenu(open) {
  if (!railLogoutMenu) return;
  const next = open ?? railLogoutMenu.classList.contains("hidden");
  railLogoutMenu.classList.toggle("hidden", !next);
  railLogoutToggle.setAttribute("aria-expanded", String(next));
}

railLogoutToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleRailLogoutMenu();
});

document.addEventListener("click", (event) => {
  if (!railLogoutMenu || railLogoutMenu.classList.contains("hidden")) return;
  if (railLogoutMenu.contains(event.target) || railLogoutToggle.contains(event.target)) return;
  toggleRailLogoutMenu(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleRailLogoutMenu(false);
});

railLogoutMenu?.addEventListener("click", (event) => {
  const kieu = event.target.closest("[data-logout]")?.dataset.logout;
  if (!kieu) return;
  toggleRailLogoutMenu(false);

  // Bam ho nut cu -> chay dung handler cu, ke ca hop confirm cua no.
  if (kieu === "app") document.querySelector('#account-menu [data-action="logout"]')?.click();
  if (kieu === "zalo") els.btnZaloLogout?.click();
});

// --- Chuyen phan he ---

// Cong cu dang chon chi song trong phien trinh duyet. Khong ghi DB/localStorage.
const toolGrid = document.querySelector(".tool-grid");
const toolCards = [...document.querySelectorAll("[data-tool]")];
const toolDetails = [...document.querySelectorAll("[data-tool-detail]")];
let activeTool = "zoom";

function chonCongCu(tool, { napNoiDung = false } = {}) {
  if (!toolCards.some((card) => card.dataset.tool === tool)) return;
  activeTool = tool;

  for (const card of toolCards) {
    const dangChon = card.dataset.tool === activeTool;
    card.classList.toggle("active", dangChon);
    card.setAttribute("aria-selected", String(dangChon));
    card.tabIndex = dangChon ? 0 : -1;
  }

  for (const detail of toolDetails) {
    const dangChon = detail.dataset.toolDetail === activeTool;
    detail.classList.toggle("hidden", !dangChon);
    detail.setAttribute("aria-hidden", String(!dangChon));
  }

  // Chi nap connector khi dung card cua no duoc chon; khong provider nao tu
  // kich hoat network cua provider khac.
  if (napNoiDung && activeTool === "zoom") void napZoom();
  if (napNoiDung && activeTool === "website") void napWebsite();
}

toolGrid?.addEventListener("click", (event) => {
  const card = event.target.closest("[data-tool]");
  if (!card || !toolGrid.contains(card)) return;
  chonCongCu(card.dataset.tool, { napNoiDung: true });
});

// Tab semantics: mui ten/Home/End doi tab va dua focus toi dung card.
toolGrid?.addEventListener("keydown", (event) => {
  const card = event.target.closest("[data-tool]");
  if (!card) return;
  const viTri = toolCards.indexOf(card);
  let tiepTheo = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") tiepTheo = (viTri + 1) % toolCards.length;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") tiepTheo = (viTri - 1 + toolCards.length) % toolCards.length;
  if (event.key === "Home") tiepTheo = 0;
  if (event.key === "End") tiepTheo = toolCards.length - 1;
  if (tiepTheo === null) return;
  event.preventDefault();
  const cardMoi = toolCards[tiepTheo];
  chonCongCu(cardMoi.dataset.tool, { napNoiDung: true });
  cardMoi.focus();
});

chonCongCu(activeTool);

function chonPhanHe(target, options = {}) {
  const button = els.moduleNav?.querySelector(`[data-module="${target}"]`);
  if (!button) return;
  els.moduleNav.querySelectorAll("[data-module]").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
  document.querySelectorAll(".module-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `module-${target}`);
  });

  // Nap lan dau khi thuc su mo phan he, khong goi OpenCode ngay luc tai trang.
  void datManHinhHuanLuyen(target === "training", options);
  if (target === "training") napHuanLuyen();
  // Cau hinh Zoho gio nam trong phan he Cong cu (khoa "note"), khong con phan he
  // Email rieng nua. Khoa van la "note" vi no da nam trong hop dong dieu huong.
  if (target === "note") {
    napEmail();
    if (activeTool === "zoom") napZoom();
    if (activeTool === "website") napWebsite();
  }
}

els.moduleNav?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-module]");
  if (!button) return;
  chonPhanHe(button.dataset.module);
  if (isMobileInbox() && els.appShell.classList.contains("mobile-drawer-open")) closeMobileLayerWithHistory();
});

khoiTaoOnboarding({ selectModule: chonPhanHe });

// --- Keo doi do rong 2 cot ---

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_KEY = "zalo-web:sidebar-width";

function applySidebarWidth(px) {
  const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
  els.appShell.style.setProperty("--sidebar-width", `${clamped}px`);
  return clamped;
}

const savedWidth = Number(localStorage.getItem(SIDEBAR_KEY));
if (Number.isFinite(savedWidth) && savedWidth > 0) applySidebarWidth(savedWidth);

els.appResizer?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  els.appResizer.setPointerCapture(event.pointerId);
  els.appShell.classList.add("is-resizing");

  const onMove = (moveEvent) => {
    applySidebarWidth(moveEvent.clientX - els.appShell.getBoundingClientRect().left);
  };
  const onUp = () => {
    els.appResizer.removeEventListener("pointermove", onMove);
    els.appResizer.removeEventListener("pointerup", onUp);
    els.appResizer.removeEventListener("pointercancel", onUp);
    els.appShell.classList.remove("is-resizing");
    const current = parseInt(els.appShell.style.getPropertyValue("--sidebar-width"), 10);
    if (Number.isFinite(current)) localStorage.setItem(SIDEBAR_KEY, String(current));
  };

  els.appResizer.addEventListener("pointermove", onMove);
  els.appResizer.addEventListener("pointerup", onUp);
  els.appResizer.addEventListener("pointercancel", onUp);
});

// Ban phim: mui ten trai/phai khi resizer dang duoc focus
els.appResizer?.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const current = parseInt(getComputedStyle(els.appShell).getPropertyValue("--sidebar-width"), 10) || 240;
  const next = applySidebarWidth(current + (event.key === "ArrowLeft" ? -16 : 16));
  localStorage.setItem(SIDEBAR_KEY, String(next));
});

/* =====================================================================
 * THAO TAC TREN TIN NHAN — MESSAGING POWER PACK V1
 *
 * Trinh duyet o day chi biet ba thu: cuoc nao, tin nao, muon lam gi. Moi
 * dinh danh cua Zalo (msgId, cliMsgId, uidFrom, threadType) do may chu tu
 * tra ra tu du lieu no giu, nen mot the DOM bi sua tay khong the tro
 * thanh quyen tac dong len tin cua nguoi khac.
 * ===================================================================== */

/** Sau bieu tuong da duyet, kem hanh dong go. Khong mo them tu enum cua Zalo. */
const CAM_XUC_APP = [
  { ten: "HEART", bieuTuong: "❤️", nhan: "Tim" },
  { ten: "LIKE", bieuTuong: "👍", nhan: "Thích" },
  { ten: "HAHA", bieuTuong: "😂", nhan: "Haha" },
  { ten: "WOW", bieuTuong: "😮", nhan: "Wow" },
  { ten: "CRY", bieuTuong: "😢", nhan: "Buồn" },
  { ten: "ANGRY", bieuTuong: "😡", nhan: "Giận" },
];
const BIEU_TUONG_THEO_TEN = new Map(CAM_XUC_APP.map((c) => [c.ten, c.bieuTuong]));

/** Chi mot thao tac tin nhan duoc bay mot luc. Bam hai lan la hai lan goi Zalo. */
let dangThaoTacTin = false;
let tinDangThaoTac = null;

function khoaCamXucTin(threadId, messageId) {
  return `${String(threadId)}|${String(messageId)}`;
}

function datCamXuc(threadId, messageId, reactions) {
  const khoa = khoaCamXucTin(threadId, messageId);
  if (Array.isArray(reactions) && reactions.length) state.reactionsByMessage.set(khoa, reactions);
  else state.reactionsByMessage.delete(khoa);
}

function xoaCamXuc(threadId, messageId) {
  state.reactionsByMessage.delete(khoaCamXucTin(threadId, messageId));
}

function layCamXuc(threadId, messageId) {
  return state.reactionsByMessage.get(khoaCamXucTin(threadId, messageId)) || [];
}

function daThuHoi(message) {
  return String(message?.msgType || "") === "chat.recalled";
}

/**
 * Cam xuc chi song trong phien nay: luu ben vung can them cot moi cho CSDL, ma
 * goi tin V1 khong duoc phep doi luoc do. Mo lai app la day trong tro lai.
 */
function veCamXuc(message) {
  const ds = layCamXuc(state.selectedThread?.id, message.id);
  if (!ds.length) return null;
  const hop = document.createElement("div");
  hop.className = "msg-reactions";
  for (const muc of ds) {
    const chip = document.createElement("span");
    chip.className = "msg-reaction-chip";
    chip.classList.toggle("mine", Boolean(muc.mine));
    chip.textContent = `${BIEU_TUONG_THEO_TEN.get(muc.ten) || "•"}${muc.count > 1 ? ` ${muc.count}` : ""}`;
    hop.append(chip);
  }
  return hop;
}

function taoNutThaoTacTin(message) {
  const nut = document.createElement("button");
  nut.type = "button";
  nut.className = "msg-action-trigger";
  nut.dataset.messageId = String(message.id);
  nut.setAttribute("aria-haspopup", "true");
  nut.setAttribute("aria-label", "Thao tác với tin nhắn");
  nut.title = "Thao tác";
  nut.textContent = "⋯";
  nut.addEventListener("click", (event) => {
    event.stopPropagation();
    moLopThaoTacTin(message, nut);
  });
  return nut;
}

/* --- LOP THAO TAC: popover tren may tinh, sheet duoi day tren dien thoai --- */

function dongLopThaoTacTin() {
  tinDangThaoTac = null;
  els.msgActionSheet?.classList.add("hidden");
  els.msgActionBackdrop?.classList.add("hidden");
  els.msgActionSheet?.style.removeProperty("top");
  els.msgActionSheet?.style.removeProperty("left");
  els.msgActionSheet?.style.removeProperty("max-height");
  els.msgActionSheet?.style.removeProperty("overflow-y");
}

function themMucThaoTac(nhan, kieu, khiBam) {
  const nut = document.createElement("button");
  nut.type = "button";
  nut.className = `msg-action-item${kieu ? ` ${kieu}` : ""}`;
  nut.textContent = nhan;
  nut.addEventListener("click", khiBam);
  els.msgActionList.append(nut);
  return nut;
}

function moLopThaoTacTin(message, neo) {
  if (!state.selectedThread) return;
  tinDangThaoTac = message;
  els.msgActionReactions.innerHTML = "";
  els.msgActionList.innerHTML = "";

  const daCoCuaToi = layCamXuc(state.selectedThread.id, message.id).some((muc) => muc.mine);
  if (!daThuHoi(message)) {
    for (const cam of CAM_XUC_APP) {
      const nut = document.createElement("button");
      nut.type = "button";
      nut.className = "msg-reaction-option";
      nut.dataset.reaction = cam.ten;
      // Nhan doc duoc cho trinh doc man hinh: mot emoji tran khong noi len gi.
      nut.setAttribute("aria-label", cam.nhan);
      nut.title = cam.nhan;
      nut.textContent = cam.bieuTuong;
      nut.addEventListener("click", () => guiCamXuc(message, cam.ten));
      els.msgActionReactions.append(nut);
    }
    // Chi hien khi that su co cai de go - mot nut go luon hien la mot loi hua sai.
    if (daCoCuaToi) themMucThaoTac("Bỏ cảm xúc", "", () => guiCamXuc(message, "NONE"));
  }

  if (coTheChuyenTiep(message)) themMucThaoTac("Chuyển tiếp", "", () => moBangChuyenTiep(message));
  if (message.isSelf && !daThuHoi(message)) {
    themMucThaoTac("Thu hồi", "nguy-hiem", () => thuHoiTin(message));
  }
  themMucThaoTac("Xóa ở phía tôi", "nguy-hiem", () => xoaTinPhiaToi(message));

  els.msgActionSheet.classList.remove("hidden");
  els.msgActionBackdrop.classList.remove("hidden");
  datViTriLopThaoTac(neo);
}

/**
 * Tren dien thoai lop nay la sheet duoi day (CSS lo), nen khong dat toa do.
 * Tren may tinh no phai bam vao dung bong bong vua bam.
 */
function datViTriLopThaoTac(neo) {
  const sheet = els.msgActionSheet;
  sheet?.style.removeProperty("top");
  sheet?.style.removeProperty("left");
  sheet?.style.removeProperty("max-height");
  sheet?.style.removeProperty("overflow-y");
  if (isMobileInbox() || !neo?.getBoundingClientRect || !sheet?.getBoundingClientRect) return;

  const neoRect = neo.getBoundingClientRect();
  const panelRect = els.chatPanel.getBoundingClientRect();
  let sheetRect = sheet.getBoundingClientRect();
  const le = 8;
  const khoangCach = 6;

  // style.top/left thuoc he toa do cua .chat-panel. Gioi han nhin thay duoc la
  // giao cua panel voi viewport, cung duoc doi ve he toa do panel truoc khi so.
  const trenThayDuoc = Math.max(panelRect.top, 0) - panelRect.top;
  const duoiThayDuoc = Math.min(panelRect.bottom, window.innerHeight) - panelRect.top;
  const traiThayDuoc = Math.max(panelRect.left, 0) - panelRect.left;
  const phaiThayDuoc = Math.min(panelRect.right, window.innerWidth) - panelRect.left;
  const chieuCaoKhaDung = Math.max(0, duoiThayDuoc - trenThayDuoc - le * 2);

  if (sheetRect.height > chieuCaoKhaDung) {
    sheet.style.maxHeight = `${chieuCaoKhaDung}px`;
    sheet.style.overflowY = "auto";
    sheetRect = sheet.getBoundingClientRect();
  }

  const cao = Math.min(sheetRect.height, chieuCaoKhaDung);
  const rong = sheetRect.width;
  const viTriDuoi = neoRect.bottom - panelRect.top + khoangCach;
  const viTriTren = neoRect.top - panelRect.top - khoangCach - cao;
  const duChoPhiaDuoi = viTriDuoi + cao <= duoiThayDuoc - le;
  const topMongMuon = duChoPhiaDuoi ? viTriDuoi : viTriTren;
  const topToiDa = Math.max(trenThayDuoc + le, duoiThayDuoc - le - cao);
  const top = Math.min(Math.max(topMongMuon, trenThayDuoc + le), topToiDa);

  const leftMongMuon = neoRect.right - panelRect.left - rong;
  const leftToiDa = Math.max(traiThayDuoc + le, phaiThayDuoc - le - rong);
  const left = Math.min(Math.max(leftMongMuon, traiThayDuoc + le), leftToiDa);

  sheet.style.top = `${top}px`;
  sheet.style.left = `${left}px`;
}

/** Chi tin CHU moi chuyen tiep duoc trong V1; may chu con chan lai mot lan nua. */
function coTheChuyenTiep(message) {
  if (daThuHoi(message)) return false;
  if (message.stickerUrl || message.isSticker) return false;
  if (!["text", "chat.text", "webchat"].includes(message.msgType)) return false;
  return Boolean(String(message.content || "").trim());
}

/**
 * Mot cong duy nhat cho moi thao tac tin nhan: chot don luong, goi may chu, va
 * bao that bai bang dung loi may chu tra ve. Khong tu thu lai lan nao.
 */
async function goiThaoTacTin(duongDan, than) {
  if (dangThaoTacTin) return null;
  dangThaoTacTin = true;
  els.msgActionSheet?.classList.add("dang-cho");
  try {
    const res = await fetch(duongDan, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(than),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Không thực hiện được thao tác.");
    return data;
  } catch (error) {
    alert(error.message);
    return null;
  } finally {
    dangThaoTacTin = false;
    els.msgActionSheet?.classList.remove("dang-cho");
  }
}

async function guiCamXuc(message, reaction) {
  const thread = state.selectedThread;
  if (!thread) return;
  const data = await goiThaoTacTin("/api/messaging/reaction", {
    threadId: thread.id,
    messageId: message.id,
    reaction,
  });
  dongLopThaoTacTin();
  if (!data) return;
  datCamXuc(thread.id, message.id, data.reactions);
  if (state.selectedThread?.id === thread.id) {
    renderMessages(state.messagesByThread.get(thread.id) || []);
  }
}

async function thuHoiTin(message) {
  const thread = state.selectedThread;
  if (!thread) return;
  // Thu hoi la thao tac nguoi khac nhin thay ngay. Hoi truoc mot cau.
  if (!confirm("Thu hồi tin nhắn này?")) return;
  const data = await goiThaoTacTin("/api/messaging/undo", {
    threadId: thread.id,
    messageId: message.id,
  });
  dongLopThaoTacTin();
  if (!data) return;
  // May chu da doi trang thai va ban su kien "message-recalled"; day chi la
  // duong du phong khi socket den cham, va no idempotent nen khong nhay hai lan.
  const list = state.messagesByThread.get(thread.id);
  const tin = list?.find((item) => String(item.id) === String(message.id));
  if (tin && !daThuHoi(tin)) {
    tin.content = data.content;
    tin.msgType = "chat.recalled";
    tin.stickerUrl = null;
    tin.isSticker = false;
    if (state.selectedThread?.id === thread.id) renderMessages(list);
  }
}

async function xoaTinPhiaToi(message) {
  const thread = state.selectedThread;
  if (!thread) return;
  if (!confirm("Xóa tin nhắn này ở phía tôi? Người kia vẫn còn thấy tin.")) return;
  const data = await goiThaoTacTin("/api/messaging/delete", {
    threadId: thread.id,
    messageId: message.id,
  });
  dongLopThaoTacTin();
  if (!data) return;
  const list = state.messagesByThread.get(thread.id) || [];
  const con = list.filter((item) => String(item.id) !== String(message.id));
  state.messagesByThread.set(thread.id, con);
  xoaCamXuc(thread.id, message.id);
  if (state.selectedThread?.id === thread.id) renderMessages(con);
}

/* --- CHUYEN TIEP: mot tin chu, mot cuoc dich --- */

let tinDangChuyenTiep = null;

function moBangChuyenTiep(message) {
  tinDangChuyenTiep = message;
  dongLopThaoTacTin();
  els.forwardSearch.value = "";
  veDanhSachChuyenTiep();
  els.forwardDialog.classList.remove("hidden");
  els.forwardSearch.focus();
}

function dongBangChuyenTiep() {
  tinDangChuyenTiep = null;
  els.forwardDialog.classList.add("hidden");
}

/** Dung lai danh muc cuoc tro chuyen dang co, khong dung so dia chi rieng. */
function veDanhSachChuyenTiep() {
  const tim = els.forwardSearch.value.trim().toLowerCase();
  els.forwardList.innerHTML = "";
  const ds = state.threads.filter((t) => !tim || String(t.title || t.id).toLowerCase().includes(tim));
  if (!ds.length) {
    const trong = document.createElement("p");
    trong.className = "empty-hint";
    trong.textContent = "Không có cuộc trò chuyện phù hợp.";
    els.forwardList.append(trong);
    return;
  }
  for (const thread of ds) {
    const nut = document.createElement("button");
    nut.type = "button";
    nut.className = "forward-item";
    nut.textContent = thread.title || thread.id;
    nut.addEventListener("click", () => chuyenTiepToi(thread));
    els.forwardList.append(nut);
  }
}

async function chuyenTiepToi(dich) {
  const nguon = tinDangChuyenTiep;
  const thread = state.selectedThread;
  if (!nguon || !thread) return;
  const data = await goiThaoTacTin("/api/messaging/forward", {
    threadId: thread.id,
    messageId: nguon.id,
    targetThreadId: dich.id,
  });
  // Chi dong bang khi that su xong. That bai ma bang tu dong dong la nguoi dung
  // tuong da chuyen roi.
  if (data) dongBangChuyenTiep();
}

els.btnForwardClose?.addEventListener("click", dongBangChuyenTiep);
els.forwardSearch?.addEventListener("input", veDanhSachChuyenTiep);
els.forwardDialog?.addEventListener("click", (event) => {
  if (event.target === els.forwardDialog) dongBangChuyenTiep();
});
els.msgActionBackdrop?.addEventListener("click", dongLopThaoTacTin);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  dongLopThaoTacTin();
  dongBangSticker();
  if (!els.forwardDialog?.classList.contains("hidden")) dongBangChuyenTiep();
});

/* --- STICKER: dung tam cai da duyet, khong co kho, khong co tim kiem --- */

let danhSachStickerApp = null;

function dongBangSticker() {
  els.stickerPicker?.classList.add("hidden");
  els.btnSticker?.setAttribute("aria-expanded", "false");
}

async function moBangSticker() {
  if (!state.selectedThread) return;
  if (!els.stickerPicker.classList.contains("hidden")) {
    dongBangSticker();
    return;
  }
  if (!danhSachStickerApp) {
    try {
      const res = await fetch("/api/messaging/stickers");
      const data = await res.json();
      danhSachStickerApp = data.stickers || [];
    } catch {
      danhSachStickerApp = [];
    }
  }
  els.stickerPicker.innerHTML = "";
  for (const sticker of danhSachStickerApp) {
    const nut = document.createElement("button");
    nut.type = "button";
    nut.className = "sticker-option";
    nut.dataset.stickerKey = sticker.key;
    nut.textContent = sticker.moTa || sticker.key;
    nut.addEventListener("click", () => guiSticker(sticker.key));
    els.stickerPicker.append(nut);
  }
  els.stickerPicker.classList.remove("hidden");
  els.btnSticker.setAttribute("aria-expanded", "true");
}

/**
 * Khong tu ve bong bong sticker tai cho: Zalo doi lai chinh tin do kem msgId
 * that, va duong ghi canonical se hien no. Ve truoc la co hai bong bong cho
 * mot lan gui.
 */
async function guiSticker(stickerKey) {
  const thread = state.selectedThread;
  if (!thread) return;
  dongBangSticker();
  await goiThaoTacTin("/api/messaging/sticker", { threadId: thread.id, stickerKey });
}

els.btnSticker?.addEventListener("click", (event) => {
  event.stopPropagation();
  void moBangSticker();
});
document.addEventListener("click", (event) => {
  if (els.stickerPicker?.classList.contains("hidden")) return;
  if (els.stickerPicker.contains(event.target) || els.btnSticker?.contains(event.target)) return;
  dongBangSticker();
});

/* --- DANG SOAN TIN: tu dong, khong co nut bam --- */

/** Zalo tu tat dau ba cham sau vai giay; nhac lai day hon 3 giay mot lan la spam. */
const NHIP_GO_PHIM_MS = 3000;
let mocGoPhimCuoi = 0;
let composerDangCoChu = false;

function datLaiNhipGoPhim() {
  mocGoPhimCuoi = 0;
  composerDangCoChu = false;
}

/**
 * Bao mot lan khi o soan tin di tu RONG sang CO CHU, sau do nhieu nhat mot lan
 * moi 3 giay. Goi theo tung phim la ban hang chuc lenh cho mot cau ngan.
 *
 * That bai thi im lang: UAT cho thay tin hieu nay nguoi that khong quan sat
 * duoc, nen no khong duoc phep lam phien viec go va gui tin.
 */
function thuBaoDangSoan() {
  const thread = state.selectedThread;
  if (!thread) return;
  if (!els.input.value.trim()) {
    datLaiNhipGoPhim();
    return;
  }
  const bayGio = Date.now();
  if (composerDangCoChu && bayGio - mocGoPhimCuoi < NHIP_GO_PHIM_MS) return;
  composerDangCoChu = true;
  mocGoPhimCuoi = bayGio;
  fetch("/api/messaging/typing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: thread.id }),
  }).catch(() => {});
}

els.input?.addEventListener("input", thuBaoDangSoan);
els.input?.addEventListener("blur", datLaiNhipGoPhim);

/* --- DA XEM: tu dong, va chi khi nguoi dung THAT SU dang nhin --- */

/** Cach day duoi bao nhieu pixel thi van coi la dang doc tin moi nhat. */
const BIEN_DAY_KHUNG_CHAT_PX = 40;
const daBaoDaXem = new Map();

function dangONhinTinMoiNhat() {
  const khung = els.messages;
  return khung.scrollHeight - khung.scrollTop - khung.clientHeight <= BIEN_DAY_KHUNG_CHAT_PX;
}

/**
 * Bon dieu kien deu bat buoc. Bao da xem chi vi vua TAI VE lich su la noi doi:
 * tin co the dang nam trong mot tab an, hoac o mot cuoc tro chuyen nguoi dung
 * chua mo, hoac tren mot doan da cuon len tu lau.
 *
 * Best-effort thuan: khong thu lai, khong bao loi. Zalo co the nhan lenh ma
 * dau da xem van khong hien ben kia — dieu do da biet va khong hua nguoc lai.
 */
function thuBaoDaXem() {
  const thread = state.selectedThread;
  if (!thread) return;
  if (typeof document.visibilityState === "string" && document.visibilityState !== "visible") return;
  const list = state.messagesByThread.get(thread.id) || [];
  if (!list.length || !els.messages.childElementCount) return;
  if (!dangONhinTinMoiNhat()) return;

  let moiNhat = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i].isSelf && list[i].id) { moiNhat = list[i]; break; }
  }
  if (!moiNhat) return;
  if (daBaoDaXem.get(thread.id) === String(moiNhat.id)) return;
  daBaoDaXem.set(thread.id, String(moiNhat.id));

  fetch("/api/messaging/seen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: thread.id, messageId: moiNhat.id }),
  }).catch(() => {});
}

els.messages?.addEventListener("scroll", thuBaoDaXem);
document.addEventListener("visibilitychange", thuBaoDaXem);
