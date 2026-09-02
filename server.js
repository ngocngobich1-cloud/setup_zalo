import express from "express";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import session from "express-session";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { changePassword, changeUsername, ensureDefaultUser, publicUser, verifyCredentials } from "./lib/auth.js";
import { SqliteSessionStore } from "./lib/session-store.js";
import * as chanDo from "./lib/rate-limit.js";
import { availableChannels, sendChallenge, verifyChallenge } from "./lib/otp.js";
import { verifySmtp } from "./lib/email-sender.js";
import {
  getAppSecret,
  getSmtpConfig,
  getUserById,
  saveSmtpConfig,
  setAppSecret,
  updateUserOtpSettings,
} from "./lib/db.js";
import {
  initDb,
  listThreads,
  getAutoReplyRules,
  getAiRuntimeConfig,
  insertAutoReplyRule,
  updateAutoReplyRule,
  deleteAutoReplyRule,
  clearActivityLogs,
  deletePdfAutomationRule,
  getPdfAutomationRule,
  insertPdfAutomationRule,
  listPdfAutomationRules,
  updatePdfAutomationRule,
} from "./lib/db.js";
import * as knowledge from "./lib/knowledge.js";
import * as activityLog from "./lib/activity-log.js";
import {
  bootstrapState,
  captureRuntimeAuthority,
  configureZaloService,
  chuHienTai,
  getMessagesForThread,
  getPublicState,
  refreshThreads,
  sendChatMessage,
  startQRLogin,
  tryLoginWithSavedCredentials,
  isLoggedIn,
  listGroups,
  listGroupMembers,
  noiLaiZalo,
  dangXuatZalo,
  kiemTraKetNoiKhiMoApp,
  applyBotEligibilityTransition,
  listAppStickers,
  appReactToMessage,
  appSendSticker,
  appSendTyping,
  appMarkSeen,
  appUndoMessage,
  appDeleteMessageForMe,
  appForwardMessage,
} from "./lib/zalo-service.js";
import * as aiChat from "./lib/ai-chat.js";
import * as ownerCredentials from "./lib/owner-credentials.js";
import {
  clearPendingPdfConfirmationsForRule,
  parsePdfEnabled,
  preparePdfKeyword,
  validatePdfUpload,
} from "./lib/pdf-automation.js";
import { PDF_AUTOMATION_MULTER_OPTIONS } from "./lib/pdf-upload-options.js";

const opencodeContextRoot = String(process.env.OPENCODE_CONTEXT_ROOT || "").trim();
if (!opencodeContextRoot) {
  console.error(
    "[server-config] OPENCODE_CONTEXT_ROOT_REQUIRED: OPENCODE_CONTEXT_ROOT phải được cấu hình trước khi khởi động."
  );
  process.exit(1);
}

process.on("unhandledRejection", (error) => console.error("[server]", error));
process.on("uncaughtException", (error) => console.error("[server]", error));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);

configureZaloService(io);
activityLog.setEmitter((entry) => io.emit("activity-log", entry));

// DB phai san sang TRUOC khi dung session middleware, vi khoa ky session doc tu DB.
await initDb();

// Startup khong co owner active: xoa projection legacy/global neu sidecar da
// san sang. Neu sidecar chua khoi dong kip, state van fail-closed; login owner
// sau do se project lai truoc khi listener inbound duoc mo.
await ownerCredentials.projectOwnerCredentials(null).catch((error) => {
  console.error("[owner-credentials] Startup empty projection failed:", error.code || "UNKNOWN");
});

// Khoa ky session sinh MOT LAN roi luu vao DB. Truoc day sinh ngau nhien moi lan
// khoi dong nen restart la moi nguoi bi dang xuat.
async function layKhoaSession() {
  const daCo = await getAppSecret("session_secret");
  if (daCo) return daCo;
  const moi = crypto.randomBytes(32).toString("hex");
  await setAppSecret("session_secret", moi);
  return moi;
}

/**
 * Cong chan cau hinh truoc khi mo dich vu.
 *
 * Chay o nha thi APP_DOMAIN=localhost, TLS noi bo, cookie khong Secure - deu
 * dung. Nhung day len VPS ma chi doi moi APP_DOMAIN thi ba thu nay van giu
 * nguyen mac dinh: Caddy cap chung chi noi bo (trinh duyet bao do), cookie di
 * qua HTTP (ai nam giua duong doc duoc phien dang nhap).
 *
 * Hong kieu do KHONG bao loi - web van mo, van dang nhap duoc, chi la khong an
 * toan. Nen chan ngay o day: sai cau hinh thi dung han, con hon chay am tham.
 */
function kiemCauHinhTrienKhai() {
  const mien = String(process.env.APP_DOMAIN || "localhost").trim();
  const laNoiBo = !mien || mien === "localhost" || /^127\./.test(mien) || mien === "::1";
  if (laNoiBo) return;

  const loi = [];
  if (process.env.COOKIE_SECURE !== "true") {
    loi.push(`APP_DOMAIN="${mien}" (miền công khai) nhưng COOKIE_SECURE chưa bật.
     -> Cookie đăng nhập sẽ đi qua HTTP, ai chặn được đường truyền là đọc được phiên.
     -> Sửa: đặt COOKIE_SECURE=true trong .env`);
  }
  if (!process.env.TLS_MODE || process.env.TLS_MODE === "internal") {
    loi.push(`APP_DOMAIN="${mien}" (miền công khai) nhưng TLS_MODE đang là "internal".
     -> Caddy sẽ cấp chứng chỉ tự ký, trình duyệt của khách báo trang không an toàn.
     -> Sửa: đặt TLS_MODE=<email của chị> trong .env để Caddy xin chứng chỉ thật.`);
  }
  if (!loi.length) return;

  console.error("\n" + "=".repeat(70));
  console.error("  DUNG LAI - CAU HINH TRIEN KHAI CHUA AN TOAN");
  console.error("=".repeat(70));
  for (const d of loi) console.error("\n  * " + d);
  console.error("\n" + "=".repeat(70) + "\n");
  process.exit(1);
}
kiemCauHinhTrienKhai();

// Sau reverse proxy (Caddy) thi req.ip va req.secure moi doc dung.
app.set("trust proxy", 1);

const sessionMiddleware = session({
  secret: await layKhoaSession(),
  name: "zalo_web_sid",
  store: new SqliteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    // Bat COOKIE_SECURE=true khi chay sau HTTPS. De true luc chay HTTP thi trinh
    // duyet khong gui cookie va khong ai dang nhap duoc, nen phai cau hinh tuong minh.
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

// Cookie co co Secure thi trinh duyet KHONG nhan qua HTTP: dang nhap se bao thanh
// cong nhung phien khong duoc luu, hong trong im lang. Day thang sang HTTPS thay vi
// de nguoi dung loay hoay.
const MIEN_HTTPS = process.env.APP_DOMAIN || "localhost";
app.use((req, res, next) => {
  if (process.env.COOKIE_SECURE === "true" && !req.secure) {
    return res.redirect(308, `https://${MIEN_HTTPS}${req.originalUrl}`);
  }
  next();
});

// Header bao mat co ban, khong can them thu vien.
app.use((_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  if (process.env.COOKIE_SECURE === "true") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware);

// Socket.IO dung chung session; chua dang nhap thi khong duoc mo ket noi,
// neu khong client van nhan duoc thread/tin nhan qua socket du chua qua cong login.
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  if (socket.request.session?.userId) return next();
  next(new Error("unauthorized"));
});

/* --- CONG DANG NHAP --- */

app.get("/login", (req, res) => {
  if (req.session.userId) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Cap session id moi truoc khi trao quyen, de tranh session fixation.
function completeLogin(req, res, user) {
  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: "Không tạo được phiên đăng nhập." });
    req.session.userId = user.id;
    req.session.username = user.username;
    // Doc tu CSDL luc dang nhap. Con nay quyet dinh app co bi khoa lai hay khong.
    req.session.mustChangePassword = Boolean(user.mustChangePassword);
    req.session.save(async (saveError) => {
      if (saveError) return res.status(500).json({ error: "Không lưu được phiên đăng nhập." });
      const khoa = chanDo.diaChi(req);
      await activityLog.addLog({
        event: "login_ok",
        level: "ok",
        summary: `Đăng nhập thành công: ${user.username} từ ${khoa}`,
        detail: { ip: khoa, username: user.username },
      });
      res.json({
        ok: true,
        user: publicUser(user),
        mustChangePassword: Boolean(user.mustChangePassword),
      });
    });
  });
}

app.post("/api/auth/login", async (req, res) => {
  const khoa = chanDo.diaChi(req);
  const trangThai = chanDo.kiemTra(khoa);
  if (!trangThai.choPhep) {
    await activityLog.addLog({
      event: "login_blocked",
      level: "error",
      summary: `Chặn đăng nhập từ ${khoa} — thử sai quá nhiều lần`,
      detail: { ip: khoa, conLaiGiay: trangThai.conLaiGiay },
    });
    return res.status(429).json({
      error: `Sai quá nhiều lần. Thử lại sau ${Math.ceil(trangThai.conLaiGiay / 60)} phút.`,
    });
  }

  const { username, password } = req.body || {};
  const user = await verifyCredentials(username, password);
  if (!user) {
    const con = chanDo.ghiNhanThatBai(khoa);
    await activityLog.addLog({
      event: "login_failed",
      level: "warn",
      summary: `Đăng nhập sai từ ${khoa} — còn ${con.soLanConLai} lần trước khi bị khoá`,
      // Co tinh KHONG ghi mat khau; ten dang nhap thi ghi de biet ai dang bi do.
      detail: { ip: khoa, username: String(username || "").slice(0, 40), soLanConLai: con.soLanConLai },
    });
    return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu." });
  }
  chanDo.xoa(khoa);

  if (!user.otpEnabled) return completeLogin(req, res, user);

  const channels = availableChannels(await phuNickZaloTheoTaiKhoan(user));
  if (channels.length === 0) {
    // Fail closed: bat OTP ma khong con kenh nao thi TU CHOI, khong am tham bo qua
    // lop bao ve thu hai. Man hinh Tai khoan da chan luu o trang thai nay.
    return res.status(403).json({
      error: "Đã bật OTP nhưng chưa cấu hình nick Zalo hoặc email nhận mã. Không thể đăng nhập.",
    });
  }

  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: "Không tạo được phiên đăng nhập." });
    req.session.pendingUserId = user.id;
    req.session.save((saveError) => {
      if (saveError) return res.status(500).json({ error: "Không lưu được phiên đăng nhập." });
      res.json({ otpRequired: true, channels });
    });
  });
});

// Hai route duoi day PHAI nam truoc cong chan: luc nay nguoi dung moi qua buoc
// mat khau, chua co userId nen chua duoc coi la da dang nhap.

/**
 * Nick Zalo nhan OTP la thu THUOC VE tai khoan Zalo dang dang nhap, khong phai
 * thuoc ve tai khoan app. Phu gia tri cua dung tai khoan hien tai len ho so
 * nguoi dung truoc khi dung. Chua dang nhap Zalo -> khong co kenh Zalo (dong cua).
 */
async function phuNickZaloTheoTaiKhoan(user) {
  if (!user) return user;
  const { getAccountConfig } = await import("./lib/db.js");
  const c = await getAccountConfig(chuHienTai());
  return { ...user, otpZaloThreadId: c.otpZaloThreadId, otpZaloLabel: c.otpZaloLabel };
}

app.post("/api/auth/otp/send", async (req, res) => {
  if (!req.session.pendingUserId) return res.status(401).json({ error: "Phiên xác thực đã hết hạn." });
  const user = await getUserById(req.session.pendingUserId);
  if (!user) return res.status(401).json({ error: "Phiên xác thực không hợp lệ." });

  const channel = String(req.body?.channel || "");
  const userOtp = await phuNickZaloTheoTaiKhoan(user);
  if (!availableChannels(userOtp).some((item) => item.id === channel)) {
    return res.status(400).json({ error: "Kênh nhận OTP chưa được cấu hình." });
  }

  try {
    const result = await sendChallenge(req.session, userOtp, channel);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/auth/otp/verify", async (req, res) => {
  if (!req.session.pendingUserId) return res.status(401).json({ error: "Phiên xác thực đã hết hạn." });
  const user = await getUserById(req.session.pendingUserId);
  if (!user) return res.status(401).json({ error: "Phiên xác thực không hợp lệ." });

  const result = await verifyChallenge(req.session, req.body?.code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  completeLogin(req, res, user);
});

// Chi nhung thu can de HIEN trang login moi duoc di qua khi chua dang nhap.
const PUBLIC_ASSETS = new Set(["/login", "/login.html", "/login.js", "/style.css", "/favicon.ico"]);

app.use((req, res, next) => {
  if (req.session?.userId) return next();
  if (PUBLIC_ASSETS.has(req.path) || req.path.startsWith("/socket.io/")) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Chưa đăng nhập." });
  return res.redirect("/login");
});

// Chi nhung thu can de DOI MAT KHAU moi di qua khi tai khoan con bi bat doi.
const DUONG_DOI_MAT_KHAU = new Set([
  "/api/auth/change-password",
  "/api/auth/logout",
  "/api/auth/me",
  "/login",
  "/login.html",
  "/login.js",
  "/style.css",
  "/favicon.ico",
]);

/**
 * Cong chan bat buoc doi mat khau.
 *
 * Phai chan o day chu KHONG chi o giao dien: neu chi dua vao trinh duyet tu
 * chuyen huong, thi bat ky ai goi thang /api/bootstrap bang mat khau admin/admin
 * mac dinh deu doc duoc cuoc tro chuyen Zalo, ho so khach va cau hinh - dung
 * cai lo hong ma mat khau mac dinh sinh ra.
 */
app.use((req, res, next) => {
  if (!req.session?.mustChangePassword) return next();
  if (DUONG_DOI_MAT_KHAU.has(req.path)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(403).json({
      error: "Phải đổi mật khẩu mặc định trước khi dùng ứng dụng.",
      mustChangePassword: true,
    });
  }
  return res.redirect("/login");
});

/* --- Tu day tro xuong: bat buoc da dang nhap --- */

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("zalo_web_sid");
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  res.json({
    user: { id: req.session.userId, username: req.session.username },
    mustChangePassword: Boolean(req.session.mustChangePassword),
  });
});

app.get("/api/auth/otp-settings", async (req, res) => {
  const user = await getUserById(req.session.userId);
  // Nick Zalo nhan OTP va nick duoc ra lenh cho bot thuoc ve TAI KHOAN ZALO
  // dang dang nhap, khong thuoc ve tai khoan app. Chua dang nhap Zalo -> rong.
  const { getAccountConfig } = await import("./lib/db.js");
  const cauHinhTk = await getAccountConfig(chuHienTai());
  const smtp = await getSmtpConfig();
  res.json({
    otpEnabled: user.otpEnabled,
    otpZaloThreadId: cauHinhTk.otpZaloThreadId,
    otpZaloLabel: cauHinhTk.otpZaloLabel,
    otpEmail: user.otpEmail,
    adminZaloUid: cauHinhTk.adminZaloUid,
    adminZaloLabel: cauHinhTk.adminZaloLabel,
    // Khong bao gio tra mat khau SMTP ve client.
    smtp: {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      username: smtp.username,
      fromAddress: smtp.fromAddress,
      hasPassword: Boolean(smtp.password),
    },
  });
});

app.post("/api/auth/otp-settings", async (req, res) => {
  const { otpEnabled, otpZaloThreadId, otpZaloLabel, otpEmail, smtp } = req.body || {};

  const zalo = String(otpZaloThreadId || "").trim();
  const email = String(otpEmail || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Địa chỉ email không hợp lệ." });
  }
  if (otpEnabled && !zalo && !email) {
    return res.status(400).json({ error: "Bật OTP thì phải cấu hình ít nhất một kênh: nick Zalo hoặc email." });
  }

  if (smtp && typeof smtp === "object") {
    const current = await getSmtpConfig();
    await saveSmtpConfig({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      username: smtp.username,
      // De trong o mat khau = giu nguyen mat khau cu, khong phai xoa.
      password: smtp.password ? smtp.password : current.password,
      fromAddress: smtp.fromAddress,
    });
  }

  // Nick Zalo nhan OTP luu THEO TAI KHOAN ZALO. Chon nick khi chua dang nhap
  // Zalo la khong xac dinh duoc no thuoc ve ai -> chan lai.
  const chuOtp = chuHienTai();
  if (zalo && !chuOtp) {
    return res.status(400).json({ error: "Chưa đăng nhập Zalo nên chưa chọn được nick nhận OTP." });
  }
  if (chuOtp) {
    const { saveAccountConfig } = await import("./lib/db.js");
    await saveAccountConfig(chuOtp, {
      otpZaloThreadId: zalo,
      otpZaloLabel: String(otpZaloLabel || "").trim(),
    });
  }

  await updateUserOtpSettings(req.session.userId, {
    otpEnabled: Boolean(otpEnabled),
    otpZaloThreadId: zalo,
    otpZaloLabel: String(otpZaloLabel || "").trim(),
    otpEmail: email,
  });

  const { setAdminZalo } = await import("./lib/db.js");
  await setAdminZalo(chuHienTai(), req.body?.adminZaloUid, req.body?.adminZaloLabel);
  res.json({ ok: true });
});

app.post("/api/auth/smtp-test", async (_req, res) => {
  try {
    await verifySmtp();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/auth/change-username", async (req, res) => {
  const result = await changeUsername(req.session.userId, req.body?.currentPassword, req.body?.newUsername);
  if (!result.ok) return res.status(400).json({ error: result.error });
  req.session.username = result.username;
  await activityLog.addLog({
    event: "account_changed",
    level: "ok",
    summary: `Đã đổi tên đăng nhập thành "${result.username}"`,
    detail: { username: result.username },
  });
  res.json({ ok: true, username: result.username });
});

app.post("/api/auth/change-password", async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  const result = await changePassword(req.session.userId, currentPassword, newPassword, confirmPassword);
  if (!result.ok) return res.status(400).json({ error: result.error });
  // Doi xong thi mo khoa app. updateUserPassword() da go co trong CSDL bang
  // cung mot cau lenh; day chi la go not ban dang giu trong phien.
  req.session.mustChangePassword = false;
  req.session.save(() => res.json({ ok: true }));
});

app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: knowledge.MAX_FILE_BYTES },
});

// Media chat di thang trong bo nho den Zalo provider. Khong luu tep tam va
// khong bao gio nhan duong dan tep tu trinh duyet. Gioi han mot tep dung voi UX
// composer hien tai; dung luong/duoi tep do provider canonical quyet dinh.
const zaloSendUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1 },
});

const pdfAutomationUpload = multer(PDF_AUTOMATION_MULTER_OPTIONS);

app.get("/api/bootstrap", async (req, res) => {
  const state = await bootstrapState();
  res.json({ ...state, user: { id: req.session.userId, username: req.session.username } });
});

app.post("/api/login/start", async (_req, res) => {
  try {
    res.json(await startQRLogin());
  } catch (error) {
    res.status(500).json({ error: error.message, state: getPublicState() });
  }
});

app.get("/api/messages/:threadId", async (req, res) => {
  try {
    res.json(await getMessagesForThread(req.params.threadId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/send", (req, res) => {
  // Capture immutable server-owned authority BEFORE Multer's async parsing.
  // Khong field nao trong req.body duoc phep thay the token nay.
  const capturedRuntimeAuthority = captureRuntimeAuthority();
  zaloSendUpload.single("file")(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(400).json({ ok: false, error: uploadError.message });
    }
    try {
      const attachment = req.file
        ? {
            buffer: req.file.buffer,
            filename: req.file.originalname,
            size: req.file.size,
            mime: req.file.mimetype,
            width: req.body?.width,
            height: req.body?.height,
          }
        : null;
      const {
        threadId,
        text,
        threadType,
        quote,
        mentions,
        urgency,
      } = req.body || {};
      const message = await sendChatMessage({
        threadId,
        text,
        threadType,
        quote,
        mentions,
        urgency,
        attachment,
      }, { capturedRuntimeAuthority });
      res.json({ ok: true, message });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });
});

app.post("/api/threads/refresh", async (_req, res) => {
  try {
    res.json({ ok: true, threads: await refreshThreads() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* =====================================================================
 * /api/messaging — THAO TAC TREN TIN NHAN
 *
 * Moi route o day co nghia nghiep vu rieng. CO Y khong co mot route kieu
 * "goi ham Zalo ten X voi tham so Y": mot cong nhu vay bien moi lo hong
 * XSS thanh quyen dieu khien toan bo tai khoan Zalo, va khong con danh
 * sach trang nao con y nghia.
 *
 * Trinh duyet chi duoc noi: cuoc nao, tin nao, muon lam gi. Con threadType,
 * msgId, cliMsgId, uidFrom va onlyMe deu do may chu tu quyet.
 * ===================================================================== */

/** Ma loi -> ma HTTP. Khong lo chi tiet provider; thong bao da duoc lam sach o lop duoi. */
const MA_HTTP_THEO_LOI = {
  MALFORMED_REQUEST: 400,
  ACTION_NOT_APPLICABLE: 409,
  ACTION_IDENTITY_UNAVAILABLE: 409,
  ZALO_RUNTIME_CHANGED: 409,
  NOT_FOUND: 404,
  PROVIDER_REJECTED: 502,
};

function traLoiThatBai(res, error) {
  const code = MA_HTTP_THEO_LOI[error?.code] ? error.code : "INTERNAL_ERROR";
  const status = MA_HTTP_THEO_LOI[code] || 500;
  if (code === "INTERNAL_ERROR") console.error("[messaging]", error);
  res.status(status).json({
    ok: false,
    code,
    // Loi khong co ma la loi minh chua luong truoc: khong day thong bao goc ra
    // ngoai vi no co the kem duong dan, tham so da ma hoa hoac ca stack.
    error: code === "INTERNAL_ERROR" ? "Không thực hiện được thao tác." : error.message,
  });
}

/**
 * Chup quyen runtime TRUOC moi ranh gioi async, giong /api/send. Khong truong
 * nao trong req.body duoc phep thay the token nay.
 */
function tuyenMessaging(handler) {
  return async (req, res) => {
    const capturedRuntimeAuthority = captureRuntimeAuthority();
    try {
      res.json({ ok: true, ...(await handler(req.body || {}, capturedRuntimeAuthority)) });
    } catch (error) {
      traLoiThatBai(res, error);
    }
  };
}

/** Danh muc sticker da duyet. Chi khoa va mo ta - khong id that cua Zalo. */
app.get("/api/messaging/stickers", (_req, res) => {
  res.json({ ok: true, stickers: listAppStickers() });
});

app.post("/api/messaging/reaction", tuyenMessaging(
  ({ threadId, messageId, reaction }, quyen) =>
    appReactToMessage({ threadId, messageId, reaction }, quyen)
));

app.post("/api/messaging/sticker", tuyenMessaging(
  ({ threadId, stickerKey }, quyen) => appSendSticker({ threadId, stickerKey }, quyen)
));

app.post("/api/messaging/typing", tuyenMessaging(
  ({ threadId }, quyen) => appSendTyping({ threadId }, quyen)
));

app.post("/api/messaging/seen", tuyenMessaging(
  ({ threadId, messageId }, quyen) => appMarkSeen({ threadId, messageId }, quyen)
));

app.post("/api/messaging/undo", tuyenMessaging(
  ({ threadId, messageId }, quyen) => appUndoMessage({ threadId, messageId }, quyen)
));

// onlyMe KHONG doc tu req.body. Xoa ca hai dau la thao tac khong hoan tac
// duoc, va no chua bao gio nam trong pham vi da duyet cua V1.
app.post("/api/messaging/delete", tuyenMessaging(
  ({ threadId, messageId }, quyen) => appDeleteMessageForMe({ threadId, messageId }, quyen)
));

app.post("/api/messaging/forward", tuyenMessaging(
  ({ threadId, messageId, targetThreadId }, quyen) =>
    appForwardMessage({ threadId, messageId, targetThreadId }, quyen)
));

app.get("/api/auto-reply", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    res.json(await getAutoReplyRules(ownerUid));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/auto-reply", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    await insertAutoReplyRule(ownerUid, req.body);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/auto-reply/:id", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    await updateAutoReplyRule(ownerUid, req.params.id, req.body);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/auto-reply/:id", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    await deleteAutoReplyRule(ownerUid, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function pdfAutomationErrorStatus(error) {
  const message = String(error?.message || "");
  if (error?.code === "SQLITE_CONSTRAINT" || /UNIQUE constraint failed/i.test(message)) return 409;
  return 400;
}

function handlePdfAutomationUpload(req, res, next) {
  pdfAutomationUpload.single("file")(req, res, (error) => {
    if (!error) return next();
    const message = error.code === "LIMIT_FILE_SIZE" ? "File PDF vượt quá 10 MB." : error.message;
    return res.status(400).json({ error: message });
  });
}

app.get("/api/pdf-automation-rules", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    res.json({ rules: await listPdfAutomationRules(ownerUid) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/pdf-automation-rules", handlePdfAutomationUpload, async (req, res) => {
  const ownerUid = chuHienTai();
  if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
  try {
    const keyword = preparePdfKeyword(req.body?.keyword);
    const pdf = validatePdfUpload(req.file);
    const rule = await insertPdfAutomationRule(ownerUid, {
      ...keyword,
      ...pdf,
      enabled: parsePdfEnabled(req.body?.enabled, true),
    });
    res.status(201).json({ rule });
  } catch (error) {
    res.status(pdfAutomationErrorStatus(error)).json({ error: error.message });
  }
});

app.put("/api/pdf-automation-rules/:id", handlePdfAutomationUpload, async (req, res) => {
  const ownerUid = chuHienTai();
  if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
  try {
    const existing = await getPdfAutomationRule(ownerUid, req.params.id);
    if (!existing) return res.status(404).json({ error: "Không tìm thấy rule PDF." });

    const changes = {};
    if (req.body?.keyword !== undefined) Object.assign(changes, preparePdfKeyword(req.body.keyword));
    if (req.body?.enabled !== undefined) changes.enabled = parsePdfEnabled(req.body.enabled, existing.enabled);
    if (req.file) Object.assign(changes, validatePdfUpload(req.file));

    const rule = await updatePdfAutomationRule(ownerUid, req.params.id, changes);
    if (!rule) return res.status(404).json({ error: "Không tìm thấy rule PDF." });
    if (!rule.enabled) clearPendingPdfConfirmationsForRule(ownerUid, rule.id);
    res.json({ rule });
  } catch (error) {
    res.status(pdfAutomationErrorStatus(error)).json({ error: error.message });
  }
});

app.delete("/api/pdf-automation-rules/:id", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const removed = await deletePdfAutomationRule(ownerUid, req.params.id);
    if (!removed) return res.status(404).json({ error: "Không tìm thấy rule PDF." });
    clearPendingPdfConfirmationsForRule(ownerUid, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/ai-chat", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    if (!aiChat.getConfig(ownerUid)) await aiChat.refreshConfig();
    const config = aiChat.getConfig(ownerUid) || {};
    const { ownedIds: knowledgeFileIds } = await knowledge.validateOwnedFileIds(
      ownerUid,
      config.knowledgeFileIds || []
    );
    res.json({
      config: { ...config, knowledgeFileIds },
      ready: aiChat.isAiChatReady(config)
        && ownerCredentials.ownerCredentialReadyForConfig(ownerUid, config)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/bot/status", (_req, res) => {
  const ownerUid = chuHienTai();
  const config = aiChat.getConfig(ownerUid);
  res.json({
    enabled: Boolean(config?.botEnabled),
    ready: aiChat.isAiChatReady(config)
      && ownerCredentials.ownerCredentialReadyForConfig(ownerUid, config),
  });
});

app.post("/api/bot/toggle", async (req, res) => {
  try {
    const { setBotEnabled } = await import("./lib/db.js");
    const bat = Boolean(req.body?.enabled);
    // Cong tac bot thuoc ve DUNG tai khoan Zalo dang dang nhap.
    const chuBot = chuHienTai();
    if (!chuBot) return res.status(400).json({ error: "Chua dang nhap Zalo - khong doi duoc cong tac bot." });
    const botEnabledTruoc = Boolean(aiChat.getConfig(chuBot)?.botEnabled);
    await setBotEnabled(chuBot, bat);
    await aiChat.refreshConfig();
    const botEnabledSau = Boolean(aiChat.getConfig(chuBot)?.botEnabled);
    applyBotEligibilityTransition(botEnabledTruoc, botEnabledSau);
    await activityLog.addLog({
      event: bat ? "bot_on" : "bot_off",
      level: bat ? "ok" : "warn",
      summary: bat ? "Đã BẬT bot tự động trả lời" : "Đã TẮT bot tự động trả lời",
      detail: { boi: req.session.username },
    });
    res.json({
      ok: true,
      enabled: bat,
      ready: aiChat.isAiChatReady(aiChat.getConfig(chuBot))
        && ownerCredentials.ownerCredentialReadyForConfig(chuBot, aiChat.getConfig(chuBot)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/ai-chat", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const {
      allowedTopics, roleTone, allowedGroupId, allowedSenderIds, useKnowledge, knowledgeFileIds,
      soul, opencodeBaseUrl, opencodeAgent, opencodeModel, opencodeFallbackModel,
    } = req.body;

    // Lưu kết nối AI là một action boundary riêng: vẫn dùng canonical endpoint
    // và persistence hiện có, nhưng không đòi cấu hình trợ lý chưa được tạo.
    if (req.body?.saveScope === "ai-connection") {
      if (!opencodeBaseUrl) return res.status(400).json({ error: "Địa chỉ OpenCode server là bắt buộc" });
      const { splitModel } = await import("./lib/opencode.js");
      if (!splitModel(opencodeModel)) {
        return res.status(400).json({ error: "Hãy chọn đủ Hãng AI và Model" });
      }
      const fallbackProvided = opencodeFallbackModel !== undefined && opencodeFallbackModel !== null;
      const fallbackModel = fallbackProvided ? String(opencodeFallbackModel || "").trim() : null;
      if (fallbackProvided && fallbackModel && !splitModel(fallbackModel)) {
        return res.status(400).json({ error: "Model Phụ không hợp lệ" });
      }

      const { saveAiChatConfig } = await import("./lib/db.js");
      await saveAiChatConfig(ownerUid, {
        opencodeBaseUrl: String(opencodeBaseUrl).trim(),
        opencodeAgent: String(opencodeAgent || "general").trim() || "general",
        opencodeModel: String(opencodeModel).trim(),
        ...(fallbackProvided ? { opencodeFallbackModel: fallbackModel } : {}),
      });
      await aiChat.refreshConfig();
      const config = aiChat.getConfig(ownerUid);
      return res.json({
        ok: true,
        config,
        ready: aiChat.isAiChatReady(config)
          && ownerCredentials.ownerCredentialReadyForConfig(ownerUid, config),
      });
    }

    if (!soul) return res.status(400).json({ error: "Soul là bắt buộc — đây là nội dung nạp vào session OpenCode" });
    if (!allowedTopics) return res.status(400).json({ error: "Các chủ đề cho phép trả lời không được để trống" });
    if (useKnowledge === true && (!Array.isArray(knowledgeFileIds) || knowledgeFileIds.length === 0)) {
      return res.status(400).json({ error: "Đã bật dùng tri thức thì phải chọn ít nhất 1 file" });
    }

    let ownedKnowledgeFileIds = knowledgeFileIds;
    if (knowledgeFileIds !== undefined) {
      const validation = await knowledge.validateOwnedFileIds(ownerUid, knowledgeFileIds);
      if (!validation.allOwned) {
        return res.status(400).json({ error: "Không tìm thấy file." });
      }
      ownedKnowledgeFileIds = validation.ownedIds;
    }

    const { saveAiChatConfig, saveAccountConfig, getAiChatConfig, clearOpencodeSessions } = await import("./lib/db.js");

    // Nhom/nick duoc phep thuoc ve TUNG TAI KHOAN Zalo, khong phai cau hinh chung.
    // Truoc day hai truong nay bi ghi vao bang toan cuc trong khi luc doc lai doc
    // tu account_config, nen lua chon cua nguoi dung khong bao gio co tac dung.
    const chuAi = ownerUid;
    const coChonThucThe = Boolean(
      String(allowedGroupId || "").trim() ||
      (Array.isArray(allowedSenderIds) && allowedSenderIds.length)
    );
    if (coChonThucThe && !chuAi) {
      return res.status(400).json({
        error: "Chưa đăng nhập Zalo nên chưa lưu được lựa chọn nhóm/nick. Hãy kết nối Zalo trước.",
      });
    }

    // PHAI doc cau hinh CU truoc khi ghi de, vi doan duoi so sanh Soul cu voi
    // Soul moi de quyet dinh co xoa phien OpenCode hay khong.
    // Dong nay tung bi xoa nham o commit c688397 (luc bo Groq key): luc do
    // `truoc` chi con phuc vu moi truong groqApiKey nen bi don di, nhung cho
    // dung o `soulDoi` ben duoi thi bo sot. Hau qua: moi lan bam Luu deu nem
    // ReferenceError -> API tra 500, va phien OpenCode cu KHONG BAO GIO bi xoa
    // nen doi Soul xong bot van noi theo Soul cu.
    const truoc = await getAiChatConfig(ownerUid);

    // Ho so tro ly thuoc owner hien tai. URL/agent la runtime global va chi
    // duoc ghi qua action boundary "ai-connection" o tren.
    await saveAiChatConfig(ownerUid, {
      allowedTopics, roleTone, useKnowledge, knowledgeFileIds: ownedKnowledgeFileIds,
      soul,
    });

    // Truong RIENG tung tai khoan Zalo.
    if (chuAi) {
      await saveAccountConfig(chuAi, {
        allowedGroupId: String(allowedGroupId || ""),
        allowedSenderIds: Array.isArray(allowedSenderIds) ? allowedSenderIds : [],
      });
    }

    // Soul/chu de/tri thuc chi duoc nap MOT lan luc tao session. Doi noi dung do
    // ma giu session cu thi agent van chay theo Soul cu -> bo het de nap lai.
    const soulDoi =
      truoc?.soul !== (soul || "") ||
      truoc?.roleTone !== (roleTone || "") ||
      truoc?.allowedTopics !== (allowedTopics || "") ||
      Boolean(truoc?.useKnowledge) !== Boolean(useKnowledge) ||
      JSON.stringify(truoc?.knowledgeFileIds || []) !== JSON.stringify(ownedKnowledgeFileIds || []);
    if (soulDoi) {
      const phienCu = await clearOpencodeSessions(ownerUid);
      const { deleteSessions } = await import("./lib/opencode.js");
      const { quenTatCaPhien } = await import("./lib/customer-memory.js");
      const daXoa = await deleteSessions(truoc, phienCu);
      quenTatCaPhien(); // phien moi phai duoc nap lai ho so khach tu dau
      await activityLog.addLog({
        event: "opencode_session",
        level: "warn",
        summary: `Soul/chủ đề/tri thức thay đổi — làm mới ${phienCu.length} phiên hội thoại`,
        detail: {
          soPhien: phienCu.length,
          daXoaBenOpencode: daXoa,
          ghiChu:
            "Phiên mới sẽ được nạp lại Soul kèm các tin gần nhất của từng cuộc trò chuyện, nên bot không mất ngữ cảnh khách hàng.",
        },
      });
    }
    await aiChat.refreshConfig();

    // Chi nhanh save cau hinh tro ly (Soul/giong dieu/chu de) thanh cong moi
    // hoan tat guidance. Nhanh saveScope="ai-connection" da return o tren.
    const onboarding = await import("./lib/onboarding.js");
    await onboarding.xuLyHanhDongOnboarding(ownerUid, "guidance_completed");
    const config = aiChat.getConfig(ownerUid);
    res.json({
      ok: true,
      config,
      ready: aiChat.isAiChatReady(config)
        && ownerCredentials.ownerCredentialReadyForConfig(ownerUid, config),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Bat/tat doc anh-PDF. Tach rieng khoi form cau hinh de khoi reset phien oan. */
app.post("/api/ai-chat/doc-tep", async (req, res) => {
  try {
    const { setDocTep } = await import("./lib/db.js");
    const bat = Boolean(req.body?.bat);
    await setDocTep(bat);
    await aiChat.refreshConfig();
    await activityLog.addLog({
      event: "doc_tep",
      level: "warn",
      summary: bat ? "Đã BẬT cho bot đọc ảnh/PDF khách gửi" : "Đã TẮT đọc ảnh/PDF",
    });
    res.json({ ok: true, bat });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/ai-chat/opencode-test", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const { ping } = await import("./lib/opencode.js");
    const runtime = await getAiRuntimeConfig();
    const info = await ownerCredentials.withCurrentOwnerPlaneRead(
      ownerUid,
      () => ping({ opencodeBaseUrl: req.body?.opencodeBaseUrl || runtime.opencodeBaseUrl })
    );
    res.json({ ok: true, ...info });
  } catch (error) {
    const safe = ownerCredentials.ownerCredentialHttpError(error);
    res.status(safe.status).json({ error: safe.message, code: safe.code });
  }
});

app.get("/api/ai-chat/providers", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    res.json({ providers: await ownerCredentials.listCurrentOwnerProviderCatalog(ownerUid) });
  } catch (error) {
    const safe = ownerCredentials.ownerCredentialHttpError(error);
    res.status(safe.status).json({ error: safe.message, code: safe.code });
  }
});

app.get("/api/ai-chat/owner-credentials", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    res.json(await ownerCredentials.listCurrentOwnerCredentialStatus(ownerUid));
  } catch (error) {
    const safe = ownerCredentials.ownerCredentialHttpError(error);
    res.status(safe.status).json({ error: safe.message, code: safe.code });
  }
});

app.post("/api/ai-chat/owner-credentials", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const saved = await ownerCredentials.saveCurrentOwnerCredential(
      ownerUid,
      req.body?.providerId,
      req.body?.apiKey
    );
    await aiChat.refreshConfig();
    res.json({ ok: true, providerId: saved.providerId, updatedAt: saved.updatedAt });
  } catch (error) {
    const safe = ownerCredentials.ownerCredentialHttpError(error);
    res.status(safe.status).json({ error: safe.message, code: safe.code });
  }
});

app.post("/api/ai-chat/owner-credentials/test", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    res.json({
      ok: true,
      ...(await ownerCredentials.testCurrentOwnerCredential(ownerUid, req.body?.providerId)),
    });
  } catch (error) {
    const safe = ownerCredentials.ownerCredentialHttpError(error);
    res.status(safe.status).json({ ok: false, error: safe.code, message: safe.message });
  }
});

app.delete("/api/ai-chat/owner-credentials/:providerId", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const result = await ownerCredentials.deleteCurrentOwnerCredential(ownerUid, req.params.providerId);
    await aiChat.refreshConfig();
    res.json({ ok: true, providerId: result.providerId, removed: result.removed });
  } catch (error) {
    const safe = ownerCredentials.ownerCredentialHttpError(error);
    res.status(safe.status).json({ error: safe.message, code: safe.code });
  }
});

app.delete("/api/ai-chat/owner-credentials", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const result = await ownerCredentials.deleteAllCurrentOwnerCredentials(ownerUid);
    await aiChat.refreshConfig();
    res.json({ ok: true, removed: result.removed });
  } catch (error) {
    const safe = ownerCredentials.ownerCredentialHttpError(error);
    res.status(safe.status).json({ error: safe.message, code: safe.code });
  }
});

/* --- ZOHO MAIL --- */

/** Khong bao gio tra Client Secret hay chia khoa ve trinh duyet. */
function zohoCongKhai(config) {
  return {
    vung: config?.vung || "com",
    coClientId: Boolean(config?.clientId),
    coClientSecret: Boolean(config?.clientSecret),
    daKetNoi: Boolean(config?.refreshToken && config?.accountId),
    diaChi: config?.diaChi || "",
    bat: Boolean(config?.bat),
    updatedAt: config?.updatedAt || 0,
  };
}

app.get("/api/zoho", async (_req, res) => {
  try {
    const { getZohoConfig } = await import("./lib/db.js");
    const { danhSachVung } = await import("./lib/zoho-mail.js");
    res.json({ config: zohoCongKhai(await getZohoConfig()), vung: danhSachVung() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Luu Client ID / Secret / vung. Chua ket noi - moi chi cat lai. */
app.post("/api/zoho/app", async (req, res) => {
  try {
    const { getZohoConfig, saveZohoConfig } = await import("./lib/db.js");
    const clientId = String(req.body?.clientId || "").trim();
    const clientSecret = String(req.body?.clientSecret || "").trim();

    // O nhap luon trong sau khi tai lai trang (khong bao gio gui bi mat ve trinh
    // duyet). Neu bat buoc phai co Client ID thi chi khong the doi mot minh o
    // Vung du lieu - ma doi vung lai la viec hay phai lam nhat khi kem nhau.
    const cu = await getZohoConfig();
    if (!clientId && !cu?.clientId) {
      return res.status(400).json({ error: "Thiếu Client ID." });
    }

    const config = await saveZohoConfig({
      vung: String(req.body?.vung || "com"),
      // De trong = giu nguyen cai cu.
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    });
    await activityLog.addLog({ event: "zoho_cau_hinh", level: "info", summary: "Đã lưu Client ID/Secret của Zoho" });
    res.json({ ok: true, config: zohoCongKhai(config) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Doi ma sinh o API Console lay chia khoa dai han. Ma chi song vai phut. */
app.post("/api/zoho/ket-noi", async (req, res) => {
  try {
    const { getZohoConfig, saveZohoConfig } = await import("./lib/db.js");
    const { doiMaLayToken, layThongTinTaiKhoan } = await import("./lib/zoho-mail.js");

    const ma = String(req.body?.ma || "").trim();
    if (!ma) return res.status(400).json({ error: "Chị dán mã sinh ở Zoho API Console vào giúp em." });

    const cu = await getZohoConfig();
    if (!cu?.clientId || !cu?.clientSecret) {
      return res.status(400).json({ error: "Chưa có Client ID / Client Secret. Chị lưu hai cái đó trước." });
    }

    const token = await doiMaLayToken({ vung: cu.vung, clientId: cu.clientId, clientSecret: cu.clientSecret, ma });
    await saveZohoConfig(token);
    const tk = await layThongTinTaiKhoan({ ...cu, ...token });
    const config = await saveZohoConfig({ accountId: tk.accountId, diaChi: tk.diaChi, bat: true });

    await activityLog.addLog({
      event: "zoho_ket_noi",
      level: "ok",
      summary: `Đã kết nối Zoho Mail — ${tk.diaChi}`,
      detail: { diaChi: tk.diaChi },
    });
    res.json({ ok: true, config: zohoCongKhai(config) });
  } catch (error) {
    await activityLog.addLog({ event: "zoho_loi", level: "error", summary: `Kết nối Zoho thất bại — ${error.message}` });
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/zoho/ngat", async (_req, res) => {
  try {
    const { xoaKetNoiZoho } = await import("./lib/db.js");
    await xoaKetNoiZoho();
    await activityLog.addLog({ event: "zoho_ngat", level: "warn", summary: "Đã ngắt kết nối Zoho Mail" });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/zoho/bat-tat", async (req, res) => {
  try {
    const { saveZohoConfig } = await import("./lib/db.js");
    const config = await saveZohoConfig({ bat: Boolean(req.body?.bat) });
    res.json({ ok: true, config: zohoCongKhai(config) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/zoho/kiem-tra", async (_req, res) => {
  try {
    const { kiemTraKetNoi } = await import("./lib/zoho-mail.js");
    res.json({ ok: true, ...(await kiemTraKetNoi()) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/** Chi tu tra, khong cho qua bot. */
app.post("/api/zoho/tra-cuu", async (req, res) => {
  try {
    const { traCuu, timEmailTrongTin } = await import("./lib/email-check.js");
    const email = timEmailTrongTin(req.body?.email);
    if (!email) return res.status(400).json({ error: "Địa chỉ email không hợp lệ." });
    const ketQua = await traCuu({ email, nguon: "thu_cong" });
    if (!ketQua) return res.status(400).json({ error: "Chưa kết nối Zoho Mail, hoặc tính năng đang tắt." });
    res.json({ ok: true, ketQua });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/zoho/lich-su", async (_req, res) => {
  try {
    const { listTraCuu } = await import("./lib/db.js");
    res.json({ lichSu: await listTraCuu(chuHienTai(), 60) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/zoho/lich-su", async (_req, res) => {
  try {
    const { xoaLichSuTraCuu } = await import("./lib/db.js");
    const soDong = await xoaLichSuTraCuu(chuHienTai());
    await activityLog.addLog({
      event: "email_lich_su_xoa",
      level: "warn",
      summary: `Đã xoá ${soDong} dòng lịch sử tra cứu email`,
      detail: { soDong },
    });
    res.json({ ok: true, soDong });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* --- WEBSITE API CONNECTOR --- */

function traLoiLoiWebsite(res, website, error) {
  if (error instanceof website.LoiWebsite) {
    return res.status(400).json({ error: error.message, ma: error.ma });
  }
  return res.status(500).json({ error: "Website connector gặp lỗi không mong đợi." });
}

app.get("/api/website", async (_req, res) => {
  const website = await import("./lib/website.js");
  try {
    res.json({ config: await website.getSafeWebsiteConfig() });
  } catch (error) {
    traLoiLoiWebsite(res, website, error);
  }
});

app.post("/api/website/luu", async (req, res) => {
  const website = await import("./lib/website.js");
  try {
    const config = await website.saveWebsiteConfig({
      name: req.body?.name,
      apiUrl: req.body?.apiUrl,
      apiToken: req.body?.apiToken,
    });
    res.json({ ok: true, config });
  } catch (error) {
    traLoiLoiWebsite(res, website, error);
  }
});

app.post("/api/website/kiem-tra", async (_req, res) => {
  const website = await import("./lib/website.js");
  try {
    res.json({ ok: true, ...(await website.testWebsiteConnection()) });
  } catch (error) {
    traLoiLoiWebsite(res, website, error);
  }
});

app.post("/api/website/ngat", async (_req, res) => {
  const website = await import("./lib/website.js");
  try {
    res.json({ ok: true, config: await website.disconnectWebsite() });
  } catch (error) {
    traLoiLoiWebsite(res, website, error);
  }
});

app.get("/api/website/customers", async (_req, res) => {
  const website = await import("./lib/website.js");
  try {
    res.json(await website.fetchWebsiteCustomers());
  } catch (error) {
    traLoiLoiWebsite(res, website, error);
  }
});

/* --- ZOOM (Server-to-Server OAuth) ---
 *
 * Vong nay CHI lo ket noi: luu chia khoa, kiem tra, ngat. Khong co duong nao
 * tao phong hop - viec do de danh cho P2B.
 *
 * Cac route nay nam SAU cong chan dang nhap o dau file nen tu dong duoc bao ve
 * giong moi API cau hinh khac.
 */

/** Tra ve trang thai AN TOAN. Khong bao gio kem Client Secret hay access token. */
app.get("/api/zoom", async (_req, res) => {
  try {
    const { getZoomConfig, zoomCongKhai } = await import("./lib/zoom.js");
    res.json({ config: zoomCongKhai(await getZoomConfig()) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Luu cau hinh. O nhap de trong = giu nguyen gia tri cu. Khong goi Zoom o day. */
app.post("/api/zoom/luu", async (req, res) => {
  const zoom = await import("./lib/zoom.js");
  try {
    await zoom.saveZoomConfig({
      accountId: req.body?.accountId,
      clientId: req.body?.clientId,
      clientSecret: req.body?.clientSecret,
      hostEmail: req.body?.hostEmail,
    });
    // Nhat ky KHONG duoc mang theo gia tri nao cua chia khoa.
    await activityLog.addLog({
      event: "zoom_cau_hinh",
      level: "info",
      summary: "Đã lưu thông tin kết nối Zoom",
    });
    res.json({ ok: true, config: zoom.zoomCongKhai(await zoom.getZoomConfig()) });
  } catch (error) {
    if (error instanceof zoom.LoiZoom) {
      return res.status(400).json({ error: error.message, ma: error.ma });
    }
    res.status(500).json({ error: error.message });
  }
});

/** Kiem tra that: xin token roi tra cuu dung tai khoan host da cau hinh. */
app.post("/api/zoom/kiem-tra", async (_req, res) => {
  const zoom = await import("./lib/zoom.js");
  try {
    res.json({ ok: true, tk: await zoom.testZoomConnection() });
  } catch (error) {
    if (error instanceof zoom.LoiZoom) {
      await activityLog.addLog({
        event: "zoom_loi",
        level: "warn",
        summary: `Kiểm tra Zoom thất bại — ${error.ma}`,
      });
      return res.status(400).json({ error: error.message, ma: error.ma });
    }
    res.status(500).json({ error: error.message });
  }
});

/** Ngat ket noi: chi xoa bon o cua Zoom. */
app.post("/api/zoom/ngat", async (_req, res) => {
  try {
    const { clearZoomConfig, getZoomConfig, zoomCongKhai } = await import("./lib/zoom.js");
    await clearZoomConfig();
    await activityLog.addLog({ event: "zoom_ngat", level: "warn", summary: "Đã ngắt kết nối Zoom" });
    res.json({ ok: true, config: zoomCongKhai(await getZoomConfig()) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Tao mot cuoc hop Zoom da len lich (P2B).
 *
 * Trinh duyet CHI duoc gui: topic, date, time, duration, timezone. Host lay tu
 * cau hinh da luu o backend - nhan host tu trinh duyet la cho ai dang nhap app
 * chon host Zoom tuy y. Mot request = toi da MOT lan POST sang Zoom, khong tu
 * thu lai (tao trung con te hon bao loi).
 */
app.post("/api/zoom/tao-cuoc-hop", async (req, res) => {
  const zoom = await import("./lib/zoom.js");
  try {
    const cuocHop = await zoom.taoZoomMeeting({
      topic: req.body?.topic,
      date: req.body?.date,
      time: req.body?.time,
      duration: req.body?.duration,
      timezone: req.body?.timezone,
    });
    // Nhat ky: ten + ID la du de doi soat. KHONG ghi start_url (khong co de ghi
    // - da bi vut tu lib/zoom.js), khong ghi join_url de link khong nam trong log.
    await activityLog.addLog({
      event: "zoom_tao_hop",
      level: "ok",
      summary: `Đã tạo cuộc họp Zoom "${cuocHop.topic}" (ID ${cuocHop.meetingId})`,
      detail: { meetingId: cuocHop.meetingId, startTime: cuocHop.startTime, duration: cuocHop.duration },
    });
    res.json(cuocHop);
  } catch (error) {
    if (error instanceof zoom.LoiZoom) {
      await activityLog.addLog({
        event: "zoom_loi",
        level: "warn",
        summary: `Tạo cuộc họp Zoom thất bại — ${error.ma}`,
      });
      return res.status(400).json({ error: error.message, ma: error.ma });
    }
    res.status(500).json({ error: error.message });
  }
});

/* --- ZOOM P2D: provider la nguon danh sach duy nhat --- */

function trangThaiLoiZoom(error) {
  const ma = String(error?.ma || "");
  if (ma === "ZOOM_MEETING_NOT_OWNED" || ma === "ZOOM_HOST_NOT_FOUND") return 404;
  if (ma === "ZOOM_SCOPE_MISSING") return 403;
  if (ma === "ZOOM_PROVIDER_UNAVAILABLE") return 503;
  if (ma === "ZOOM_MEETING_LIST_TOO_LARGE") return 502;
  return 400;
}

function traLoiLoiZoom(res, zoom, error) {
  if (error instanceof zoom.LoiZoom) {
    return res.status(trangThaiLoiZoom(error)).json({ error: error.message, ma: error.ma });
  }
  return res.status(500).json({ error: "Zoom gặp lỗi không mong đợi." });
}

/** Dashboard: khong doc activity_logs/DB cache, luon list truc tiep tu Zoom. */
app.get("/api/zoom/cuoc-hop", async (_req, res) => {
  const zoom = await import("./lib/zoom.js");
  try {
    res.json({ ok: true, meetings: await zoom.listZoomMeetings() });
  } catch (error) {
    return traLoiLoiZoom(res, zoom, error);
  }
});

/** Participant share detail on-demand; lib da kiem configured-host ownership. */
app.get("/api/zoom/cuoc-hop/:meetingId", async (req, res) => {
  const zoom = await import("./lib/zoom.js");
  try {
    const chiaSe = await zoom.getZoomMeetingShare(req.params.meetingId);
    res.json({ ok: true, ...chiaSe });
  } catch (error) {
    return traLoiLoiZoom(res, zoom, error);
  }
});

/** Sua lich type 2; body khong co duong thay passcode/security/host. */
app.patch("/api/zoom/cuoc-hop/:meetingId", async (req, res) => {
  const zoom = await import("./lib/zoom.js");
  try {
    await zoom.updateZoomMeeting(req.params.meetingId, {
      topic: req.body?.topic,
      date: req.body?.date,
      time: req.body?.time,
      duration: req.body?.duration,
      timezone: req.body?.timezone,
    });
    await activityLog.addLog({
      event: "zoom_sua_hop",
      level: "ok",
      summary: `Đã sửa lịch Zoom "${String(req.body?.topic || "").trim()}" (ID ${req.params.meetingId})`,
      detail: {
        meetingId: String(req.params.meetingId),
        startTime: `${String(req.body?.date || "")}T${String(req.body?.time || "")}:00`,
        duration: Number(req.body?.duration),
      },
    });
    res.json({ ok: true });
  } catch (error) {
    return traLoiLoiZoom(res, zoom, error);
  }
});

/** Route nay chi chay sau confirm inline cua UI; backend van ownership-guard. */
app.delete("/api/zoom/cuoc-hop/:meetingId", async (req, res) => {
  const zoom = await import("./lib/zoom.js");
  try {
    await zoom.deleteZoomMeeting(req.params.meetingId);
    await activityLog.addLog({
      event: "zoom_xoa_hop",
      level: "warn",
      summary: `Đã xoá cuộc họp Zoom (ID ${req.params.meetingId})`,
      detail: { meetingId: String(req.params.meetingId) },
    });
    res.json({ ok: true });
  } catch (error) {
    return traLoiLoiZoom(res, zoom, error);
  }
});

/* --- SO HEN GIO --- */

app.get("/api/lich-hen", async (_req, res) => {
  try {
    const { listLichHen } = await import("./lib/db.js");
    res.json({ lich: await listLichHen(chuHienTai(), { gioiHan: 100 }) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/lich-hen/:id", async (req, res) => {
  try {
    const { huyLichHen } = await import("./lib/db.js");
    const daHuy = await huyLichHen(chuHienTai(), req.params.id);
    if (!daHuy) return res.status(400).json({ error: "Lịch này đã gửi hoặc đã huỷ rồi." });
    await activityLog.addLog({
      event: "lich_huy",
      level: "warn",
      summary: `Đã huỷ lịch hẹn #${req.params.id} từ giao diện`,
      detail: { id: req.params.id },
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* --- HO SO KHACH HANG --- */

app.get("/api/customer-memory", async (_req, res) => {
  try {
    const { listCustomerMemories } = await import("./lib/db.js");
    res.json({ customers: await listCustomerMemories(chuHienTai()) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/customer-memory/:uid", async (req, res) => {
  try {
    const { saveCustomerMemory } = await import("./lib/db.js");
    const { HO_SO_MAX_CHARS, quenTatCaPhien } = await import("./lib/customer-memory.js");
    const profile = String(req.body?.profile ?? "");
    if (profile.length > HO_SO_MAX_CHARS) {
      return res.status(400).json({ error: `Hồ sơ tối đa ${HO_SO_MAX_CHARS} ký tự.` });
    }
    const chuHoSo = chuHienTai();
    if (!chuHoSo) return res.status(400).json({ error: "Chua dang nhap Zalo." });
    const customer = await saveCustomerMemory(chuHoSo, {
      uid: req.params.uid,
      profile,
      locked: req.body?.locked,
    });
    // Cac phien dang chay van giu ban ho so cu trong lich su cua chung. Quen
    // danh dau "da nap" de ban vua sua duoc dua vao lai.
    quenTatCaPhien();
    await activityLog.addLog({
      event: "customer_memory",
      level: "ok",
      summary: `Chị đã sửa tay hồ sơ khách "${customer?.displayName || req.params.uid}"${customer?.locked ? " và khoá lại" : ""}`,
      detail: { uid: req.params.uid, locked: Boolean(customer?.locked), hoSo: profile },
    });
    res.json({ ok: true, customer });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/customer-memory/:uid", async (req, res) => {
  try {
    const { deleteCustomerMemory } = await import("./lib/db.js");
    const { quenTatCaPhien } = await import("./lib/customer-memory.js");
    await deleteCustomerMemory(chuHienTai(), req.params.uid);
    quenTatCaPhien();
    await activityLog.addLog({
      event: "customer_memory",
      level: "warn",
      summary: `Đã xoá hồ sơ khách ${req.params.uid}`,
      detail: { uid: req.params.uid },
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/ai-chat/reset-sessions", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const { clearOpencodeSessions } = await import("./lib/db.js");
    const { deleteSessions } = await import("./lib/opencode.js");
    const { quenTatCaPhien } = await import("./lib/customer-memory.js");
    const phienCu = await clearOpencodeSessions(ownerUid);
    if (!aiChat.getConfig()) await aiChat.refreshConfig();
    await deleteSessions(aiChat.getConfig(), phienCu);
    quenTatCaPhien();
    await activityLog.addLog({
      event: "opencode_session",
      level: "warn",
      summary: `Reset thủ công — đã bỏ ${phienCu.length} phiên hội thoại`,
      detail: { soPhien: phienCu.length },
    });
    res.json({ ok: true, soPhien: phienCu.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Noi lai duong day Zalo bang thong tin da luu — khong can quet QR. */
app.post("/api/zalo/reconnect", async (_req, res) => {
  try {
    res.json(await noiLaiZalo("chị bấm nút"));
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

/**
 * Dang xuat KHOI ZALO. Khac han "Dang xuat" trong menu tai khoan (thoat khoi
 * app). Cai nay xoa thong tin dang nhap Zalo -> lan sau phai quet lai ma QR.
 */
app.post("/api/zalo/logout", async (_req, res) => {
  try {
    res.json(await dangXuatZalo());
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/zalo/groups", async (req, res) => {
  if (!isLoggedIn()) return res.status(401).json({ error: "Chưa đăng nhập Zalo" });
  try {
    res.json(await listGroups());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/zalo/groups/:groupId/members", async (req, res) => {
  if (!isLoggedIn()) return res.status(401).json({ error: "Chưa đăng nhập Zalo" });
  try {
    res.json(await listGroupMembers(req.params.groupId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* --- FIRST-RUN AI ONBOARDING --- */

app.get("/api/onboarding", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const onboarding = await import("./lib/onboarding.js");
    res.json(await onboarding.trangThaiOnboarding(ownerUid));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/onboarding/action", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const onboarding = await import("./lib/onboarding.js");
    res.json(await onboarding.xuLyHanhDongOnboarding(ownerUid, req.body?.action, req.body?.payload));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/onboarding/answer", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const onboarding = await import("./lib/onboarding.js");
    const { getAiChatConfig } = await import("./lib/db.js");
    const config = aiChat.getConfig(ownerUid) || await getAiChatConfig(ownerUid);
    res.json(await ownerCredentials.withCurrentOwnerCredentialRead(
      ownerUid,
      config,
      () => onboarding.traLoiOnboarding(ownerUid, req.body?.text)
    ));
  } catch (error) {
    const safe = ownerCredentials.ownerCredentialHttpError(error);
    res.status(safe.status).json({ error: safe.message, code: safe.code });
  }
});

/* --- XUONG HUAN LUYEN --- */

const trainingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
});

app.get("/api/training", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const training = await import("./lib/training.js");
    res.json(await ownerCredentials.withCurrentOwnerPlaneRead(
      ownerUid,
      () => training.trangThai(ownerUid)
    ));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/training/message", (req, res) => {
  trainingUpload.array("files", 6)(req, res, async (uploadError) => {
    if (uploadError) {
      const quaLon = uploadError.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({ error: quaLon ? "Tệp vượt quá 8MB." : uploadError.message });
    }
    try {
      const ownerUid = chuHienTai();
      if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
      const training = await import("./lib/training.js");
      const { getAiChatConfig } = await import("./lib/db.js");
      const config = aiChat.getConfig(ownerUid) || await getAiChatConfig(ownerUid);
      const reply = await ownerCredentials.withCurrentOwnerCredentialRead(
        ownerUid,
        config,
        () => training.guiTinHuanLuyen(ownerUid, req.body?.text || "", req.files || [])
      );
      res.json({ ok: true, reply });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
});

app.post("/api/training/synthesize", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const training = await import("./lib/training.js");
    const { getAiChatConfig } = await import("./lib/db.js");
    const config = aiChat.getConfig(ownerUid) || await getAiChatConfig(ownerUid);
    res.json({
      ok: true,
      reply: await ownerCredentials.withCurrentOwnerCredentialRead(
        ownerUid,
        config,
        () => training.tongHopSoul(ownerUid)
      ),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/training", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const { clearTrainingMessages } = await import("./lib/db.js");
    await clearTrainingMessages(ownerUid);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* --- KHO TRI THUC --- */

app.get("/api/knowledge", async (_req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    res.json({ files: await knowledge.listFiles(ownerUid) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/knowledge", (req, res) => {
  const ownerUid = chuHienTai();
  if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
  upload.single("file")(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({ error: tooLarge ? "File vượt quá 10MB." : uploadError.message });
    }
    if (!req.file) return res.status(400).json({ error: "Thiếu file tải lên." });
    try {
      const file = await knowledge.addFile(ownerUid, req.file.buffer, req.file.originalname);
      res.status(201).json({ file });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
});

app.get("/api/knowledge/:id/content", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const file = await knowledge.getFileContent(ownerUid, req.params.id);
    if (!file) return res.status(404).json({ error: "Không tìm thấy file." });
    res.json({ file });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/knowledge/:id", async (req, res) => {
  try {
    const ownerUid = chuHienTai();
    if (!ownerUid) return res.status(400).json({ error: "Chưa đăng nhập Zalo." });
    const removed = await knowledge.removeFile(ownerUid, req.params.id);
    if (!removed) return res.status(404).json({ error: "Không tìm thấy file." });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* --- NHAT KY --- */

app.get("/api/logs", async (req, res) => {
  try {
    res.json({ logs: await activityLog.getRecentLogs(req.query.limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/logs", async (_req, res) => {
  try {
    await clearActivityLogs(chuHienTai());
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

io.on("connection", async (socket) => {
  socket.emit("state", getPublicState());
  socket.emit("threads", await listThreads(chuHienTai(), { recentOnly: true }));

  // Chi vua mo app -> kiem tra duong day Zalo con song khong. Day la luoi
  // an toan cho truong hop laptop ngu day: luc dut thi app dang dong bang nen
  // khong nghe duoc tin bao nao, tu no se khong bao gio biet ma noi lai.
  kiemTraKetNoiKhiMoApp().catch((error) =>
    console.warn("[zalo] Loi kiem tra ket noi:", error.message)
  );
});

function canListen(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, "127.0.0.1");
  });
}

async function findFreePort(preferredPort) {
  if (await canListen(preferredPort)) return preferredPort;
  return 0;
}

await ensureDefaultUser();
await aiChat.loadConfig();
const preferredPort = Number(process.env.PORT || 3790);
const port = await findFreePort(preferredPort);

server.listen(port, "0.0.0.0", async () => {
  const actualPort = server.address().port;
  console.log("Zalo Web Chat dang chay");
  console.log(`Mo trinh duyet: http://127.0.0.1:${actualPort}`);
  // Dang nhap Zalo co han gio ben trong. Nuot loi o day: dang nhap hong thi app
  // van phai chay tiep de bat bo hen gio va mo giao dien - khong duoc keo ca
  // chuoi khoi dong chet theo.
  try {
    await tryLoginWithSavedCredentials();
  } catch (error) {
    console.warn("[server] Dang nhap Zalo luc khoi dong khong xong:", error.message);
  }

  // Dong ho canh so hen. Bat SAU khi dang nhap Zalo, de vong quet dau tien da co
  // ket noi san. Nhung KHONG phu thuoc vao viec dang nhap co thanh cong hay
  // khong: dang nhap hong ma bo hen gio cung khong chay thi lich cua chi im lang
  // ca ngay, tren VPS thi khong ai nhin thay.
  const { batDauScheduler, capHinhScheduler } = await import("./lib/scheduler.js");
  const { capHinhBaoAdmin } = await import("./lib/email-check.js");
  const { getAdminZalo } = await import("./lib/db.js");

  // Bao rieng cho nick admin. Khong dat admin thi im lang - van con tab LOG.
  const nhanRiengChoAdmin = async (ownerUid, text) => {
    const admin = await getAdminZalo(ownerUid);
    if (!admin?.uid) return;
    await sendChatMessage({ threadId: admin.uid, threadType: 0, text });
  };

  const { capHinhTaoNhac, capHinhBinhChon, capHinhGhiChu, capHinhTimNguoi, capHinhNhom, capHinhNhan } =
    await import("./lib/admin-command.js");
  const {
    taoNhacZalo, taoBinhChonZalo, docBinhChonZalo, chotBinhChonZalo, taoGhiChuZalo,
    timNguoiTheoSo, conLuotTraSo, xemNguoiChoDuyet, duyetNguoiVaoNhom, taoNhomZalo,
    xemThanhVienNhom, themNguoiVaoNhom, xoaNguoiKhoiNhom, doiTenNhomZalo,
    xemNhanZalo, ganNhanZalo, boNhanZalo,
  } = await import("./lib/zalo-service.js");

  capHinhScheduler({ gui: sendChatMessage, thongBaoAdmin: nhanRiengChoAdmin, layChu: chuHienTai });
  capHinhBaoAdmin(nhanRiengChoAdmin);
  capHinhTaoNhac(taoNhacZalo);
  capHinhBinhChon({ tao: taoBinhChonZalo, doc: docBinhChonZalo, chot: chotBinhChonZalo });
  capHinhGhiChu(taoGhiChuZalo);
  capHinhTimNguoi({ tim: timNguoiTheoSo, conLuot: conLuotTraSo });
  capHinhNhom({
    xemCho: xemNguoiChoDuyet,
    duyet: duyetNguoiVaoNhom,
    tao: taoNhomZalo,
    thanhVien: xemThanhVienNhom,
    them: themNguoiVaoNhom,
    xoa: xoaNguoiKhoiNhom,
    doiTen: doiTenNhomZalo,
  });
  capHinhNhan({ xem: xemNhanZalo, gan: ganNhanZalo, bo: boNhanZalo });

  // Khach gui PDF -> tu dan nhan "Bai test" len hoi thoai do.
  const { capHinhGanNhan } = await import("./lib/ai-chat.js");
  capHinhGanNhan(ganNhanZalo);
  batDauScheduler();
});
