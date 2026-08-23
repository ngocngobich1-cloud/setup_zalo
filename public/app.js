import { CONFIG_TABS, pushActivityLog, refreshSettingsDynamicData } from "./config.js";
import { napHuanLuyen } from "./training.js";
import { napEmail } from "./email.js";
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
};

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

bootstrap();

async function bootstrap() {
  const res = await fetch("/api/bootstrap");
  if (res.status === 401) {
    window.location.href = "/login";
    return;
  }
  const data = await res.json();
  state.threads = data.threads || [];
  if (data.user?.username) setAccount(data.user.username);
  applyState(data);
  renderThreads();
  napTrangThaiBot();
}

els.btnRefreshThreads?.addEventListener("click", async () => {
  const nut = els.btnRefreshThreads;
  nut.disabled = true;
  nut.classList.add("dang-quay");
  try {
    const res = await fetch("/api/threads/refresh", { method: "POST" });
    const data = await res.json();
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
    alert(error.message);
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
  try {
    const res = await fetch("/api/bot/status");
    if (res.ok) veCongTac(await res.json());
  } catch { /* mat mang thi giu nguyen hien thi */ }
}

els.botToggle?.addEventListener("click", async () => {
  const dangBat = els.botToggle.getAttribute("aria-checked") === "true";
  if (!dangBat && !confirm("Bật bot? Từ giờ bot sẽ TỰ TRẢ LỜI khách trong phạm vi đã cấu hình.")) return;

  els.botToggle.disabled = true;
  try {
    const res = await fetch("/api/bot/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !dangBat }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Không đổi được");
    veCongTac(data);
  } catch (error) {
    alert(error.message);
  } finally {
    els.botToggle.disabled = false;
  }
});

function setAccount(username) {
  if (els.accountName) els.accountName.textContent = username;
  if (els.accountAvatar) els.accountAvatar.textContent = fallbackLetter(username);
}

function applyState(next) {
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
    const title = document.createElement("div");
    title.className = "thread-title";
    title.textContent = thread.title || thread.id;
    const preview = document.createElement("div");
    preview.className = "thread-preview";
    preview.textContent = thread.lastMessage || "";
    body.append(title, preview);
    li.append(avatar, body);
    els.threads.append(li);
  }
}

async function selectThread(thread) {
  state.selectedThread = thread;
  renderThreads();
  els.chatEmpty.classList.add("hidden");
  els.chatPanel.classList.remove("hidden");
  els.chatTitle.textContent = thread.title || thread.id;
  setAvatar(els.chatAvatar, thread.avatar, thread.title || thread.id);

  if (!state.messagesByThread.has(thread.id)) {
    els.messages.textContent = "Dang tai lich su...";
    const res = await fetch(`/api/messages/${encodeURIComponent(thread.id)}`);
    const data = await res.json();
    state.messagesByThread.set(thread.id, data.messages || []);
  }
  renderMessages(state.messagesByThread.get(thread.id) || []);
}

function renderMessages(messages) {
  els.messages.innerHTML = "";
  let lastDay = null;
  for (const message of messages) {
    const currentDay = dayKey(message.ts);
    if (currentDay !== lastDay) {
      const divider = document.createElement("div");
      divider.className = "date-divider";
      divider.textContent = formatDateDivider(message.ts);
      els.messages.append(divider);
      lastDay = currentDay;
    }

    const row = document.createElement("div");
    row.className = `bubble-row ${message.isSelf ? "self" : "other"}`;
    const avatar = document.createElement("div");
    avatar.className = "avatar bubble-avatar";
    const avatarUrl = message.isSelf ? state.myAvatar || message.senderAvatar : message.senderAvatar || state.selectedThread?.avatar;
    setAvatar(avatar, avatarUrl, message.senderName || state.selectedThread?.title || "?");

    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (!message.isSelf && Number(state.selectedThread?.threadType) === 1 && message.senderName) {
      const sender = document.createElement("div");
      sender.className = "sender";
      sender.textContent = message.senderName;
      bubble.append(sender);
    }
    if (message.stickerUrl) {
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
    const time = document.createElement("time");
    time.className = "bubble-time";
    time.textContent = formatMessageTime(message.ts);
    wrap.append(bubble, time);

    if (message.isSelf) row.append(wrap, avatar);
    else row.append(avatar, wrap);
    els.messages.append(row);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function sendMessage(event) {
  event.preventDefault();
  const text = els.input.value.trim();
  if (!text || !state.selectedThread) return;
  els.input.value = "";
  const res = await fetch("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: state.selectedThread.id,
      text,
      threadType: state.selectedThread.threadType,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    els.input.value = text;
    alert(data.error || "Khong gui duoc tin nhan.");
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
  // Nap lai TOAN BO du lieu dong theo tai khoan Zalo: nhom/nick AI Chat, lich hen,
  // khach hang, nhat ky, nick OTP/Admin. KHONG await: modal phai bat len ngay,
  // du lieu tu dien vao khi mang tra ve.
  refreshSettingsDynamicData();
  els.settingsModal.classList.remove("hidden");
}

els.btnCloseSettings?.addEventListener("click", () => {
  els.settingsModal.classList.add("hidden");
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

els.moduleNav?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-module]");
  if (!button) return;
  const target = button.dataset.module;

  els.moduleNav.querySelectorAll("[data-module]").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
  document.querySelectorAll(".module-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `module-${target}`);
  });

  // Nap lan dau khi thuc su mo phan he, khong goi OpenCode ngay luc tai trang.
  if (target === "training") napHuanLuyen();
  if (target === "email") napEmail();
});

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
