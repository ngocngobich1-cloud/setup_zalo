import { Zalo, LoginQRCallbackEventType, ThreadType, AvatarSize } from "zca-js";
// KHONG import Reactions truc tiep: moi bieu tuong phai di qua layBieuTuong,
// la cong duy nhat kiem tra danh sach trang.
import {
  chonCamXuc,
  danhSachChoPhep,
  layBieuTuong,
  layBieuTuongApp,
  layMaTin,
  tenBieuTuongApp,
} from "./cam-xuc.js";
import { laTinHeThong, moTaSuKien } from "./tin-he-thong.js";
import { botDuocGoi } from "./goi-ten.js";
import { taoBoGom, khoaGom } from "./gom-tin.js";
import { locRuotGan } from "./loc-ruot-gan.js";
import { chonTinhHuong, danhSachSticker, layStickerHopLe } from "./sticker-zalo.js";
import { loadCredentials, saveCredentials, xoaCredentials } from "./credentials.js";
import {
  getThread,
  getThreadMessages,
  insertMessage,
  listThreads,
  rebuildThreadsFromMessages,
  upsertThread,
  getAutoReplyRules,
  getPdfAutomationRuleWithBlob,
  listEnabledPdfAutomationRules,
  deleteLocalMessage,
  markMessageRecalled,
  recomputeThreadPreview,
  resolveOwnedActionMessage,
  rutDanhTinhProvider,
} from "./db.js";
import { normalizeIncomingMessage, normalizeTs, splitIntoBubbles } from "./message-utils.js";
import { taoNguonDinhKemZalo } from "./zalo-media.js";
import {
  enrichExistingThread,
  enrichMessagesForDisplay,
  resolveSenderAvatar,
  resolveThreadMeta,
  syncThreadCatalog,
} from "./thread-meta.js";
import {
  attachOldMessagesListener,
  requestInitialHistorySync,
  resetHistorySyncState,
  syncHistoryForThread,
} from "./chat-history.js";
import { enrichMessageSticker } from "./sticker.js";
import { addLog, capHinhChuTaiKhoan as capHinhChuTaiKhoanLog } from "./activity-log.js";
import { capHinhChuTaiKhoan as capHinhChuTaiKhoanAdmin, laLenhAdmin, xuLyLenh } from "./admin-command.js";
import * as aiChat from "./ai-chat.js";
import {
  clearAllPendingPdfConfirmations,
  createPdfAutomationHandler,
  PDF_AUTOMATION_HANDLED,
} from "./pdf-automation.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";


const zalo = new Zalo({ logging: false, checkUpdate: true, selfListen: true });
let api = null;
let io = null;
let loginPromise = null;
let listenerAttached = false;
let dangNoiLai = false;
let soLanThuNoiLai = 0;
let lucDutGanNhat = 0;
let runtimeGeneration = 0;
let botEligibilityEpoch = 0;
let dongHoNoiLai = null;
let dongHoDongBoCatalog = null;
const CONFIRMED_OUTBOUND_AUTHORITY = Symbol("confirmed-outbound-authority");

/**
 * Han gio cho lenh dang nhap Zalo. Da tung do thay mot lan goi treo 31 phut
 * (dut luc 14:58:27, noi xong 15:29:41) vi thu vien khong tu bo cuoc bao gio.
 * Treo qua lau con te hon that bai: that bai thi con thu lai duoc.
 */
const HAN_GIO_DANG_NHAP_MS = 30000;

export function coHanGio(viec, ms, nhan) {
  let dongHo;
  const hetGio = new Promise((_, reject) => {
    dongHo = setTimeout(() => reject(new Error(`${nhan} quá ${ms / 1000} giây không phản hồi`)), ms);
  });
  return Promise.race([viec, hetGio]).finally(() => clearTimeout(dongHo));
}

/** Giai thich ma dong ket noi cua Zalo bang tieng Viet cho nguoi dung doc. */
const LY_DO_DUT = {
  1000: "Tự đóng kết nối",
  1006: "Đứt đột ngột (mất mạng, hoặc máy tính vừa ngủ dậy)",
  3000: "Zalo đá ra vì có kết nối khác cùng tài khoản",
  3003: "Zalo chủ động ngắt kết nối",
};

const appState = {
  loggedIn: false,
  loggingIn: false,
  uid: null,
  displayName: null,
  myAvatar: null,
  qr: {
    status: "idle",
    image: null,
    message: "",
    scannedName: null,
  },
  // Trang thai THAT cua duong day nghe tin nhan. Truoc day giao dien hien mot
  // dong chu cung "Dang ket noi realtime" bat ke thuc te ra sao, nen app dut
  // ca tieng dong ho ma chu van tuong dang chay.
  ketNoi: {
    trangThai: "chua", // chua | dang-noi | song | chet
    lyDo: "",
    luc: null,
  },
};

/**
 * Token chi danh cho viec bat dau trong mot runtime Zalo cu the. UID khong du:
 * A dang xuat roi dang nhap lai van la A, nhung do la hai runtime khac nhau.
 */
function taoOriginRuntime() {
  return Object.freeze({
    originOwnerUid: chuHienTai(),
    originRuntimeGeneration: runtimeGeneration,
    originApiIdentity: api,
    originDisplayName: appState.displayName,
    originAvatar: appState.myAvatar,
  });
}

/** Capture server-owned authority before an async HTTP/multipart boundary. */
export function captureRuntimeAuthority() {
  return taoOriginRuntime();
}

/** Khong co token la duong goi cu, giu nguyen hanh vi. Co token thi phai con dung runtime. */
function originConHieuLuc(originToken) {
  if (!originToken) return true;
  return originToken.originOwnerUid === chuHienTai()
    && originToken.originRuntimeGeneration === runtimeGeneration
    && originToken.originApiIdentity === api;
}

function botEligibilityConHieuLuc(capturedEpoch) {
  return Number.isInteger(capturedEpoch) && capturedEpoch === botEligibilityEpoch;
}

/** Bot toggle chi huy automatic-response work, khong dung vao runtime authority. */
export function applyBotEligibilityTransition(previousEnabled, nextEnabled) {
  if (Boolean(previousEnabled) === Boolean(nextEnabled)) return botEligibilityEpoch;
  boGom.huyTatCa();
  botEligibilityEpoch += 1;
  return botEligibilityEpoch;
}

const handlePdfAutomation = createPdfAutomationHandler({
  listEnabledRules: listEnabledPdfAutomationRules,
  getRuleWithBlob: getPdfAutomationRuleWithBlob,
  sendMessage: (payload) => sendChatMessage(payload),
  isOriginCurrent: originConHieuLuc,
  getOwnerUid: chuHienTai,
  getRuntimeGeneration: () => runtimeGeneration,
  log: addLog,
});

/** Ket thuc moi viec treo cua runtime cu; generation chi song trong bo nho. */
function voHieuHoaViecRuntimeCu() {
  runtimeGeneration += 1;
  clearAllPendingPdfConfirmations();
  boGom.huyTatCa();
  if (dongHoNoiLai) clearTimeout(dongHoNoiLai);
  if (dongHoDongBoCatalog) clearTimeout(dongHoDongBoCatalog);
  dongHoNoiLai = null;
  dongHoDongBoCatalog = null;
  dangNoiLai = false;
}

function datTrangThaiKetNoi(trangThai, lyDo = "") {
  appState.ketNoi = { trangThai, lyDo, luc: Date.now() };
  emitState();
}

export function configureZaloService(socketServer) {
  io = socketServer;
  // Tiem ham lay uid tai khoan hien tai cho ai-chat (tranh vong import).
  aiChat.capHinhChuTaiKhoan(chuHienTai);
  capHinhChuTaiKhoanLog(chuHienTai);
  capHinhChuTaiKhoanAdmin(chuHienTai);
}

export function getPublicState() {
  return { ...appState, qr: { ...appState.qr } };
}

export async function bootstrapState() {
  return {
    ...getPublicState(),
    threads: await listThreads(chuHienTai(), { recentOnly: true }),
  };
}

export async function tryLoginWithSavedCredentials() {
  const credentials = await loadCredentials();
  if (!credentials) return false;
  try {
    // PHAI co han gio. Truoc day goi thang zalo.login() khong gioi han thoi gian,
    // ma server.js lai bat bo hen gio SAU khi lenh nay xong. Zalo im lang mot cai
    // la ca chuoi khoi dong treo: web van mo, van dang nhap duoc, nhung bo hen
    // gio CHUA BAO GIO duoc bat - lich gui tin cua chi im lang khong chay.
    // O may nha thi con ngoi canh ma thay, tren VPS thi khong ai biet.
    const loggedApi = await coHanGio(
      zalo.login(credentials),
      HAN_GIO_DANG_NHAP_MS,
      "Đăng nhập Zalo lúc khởi động"
    );
    await finalizeLogin(loggedApi);
    console.log("Dang nhap lai bang credential thanh cong");
    return true;
  } catch (error) {
    console.warn("[zalo] Credential het han hoac khong hop le:", error.message);
    setQrState("idle", "Can quet QR de dang nhap lai.");
    appState.loggedIn = false;
    emitState();
    return false;
  }
}

export async function startQRLogin() {
  if (appState.loggedIn) return getPublicState();
  if (loginPromise) return loginPromise;

  appState.loggingIn = true;
  setQrState("loading", "Dang tao ma QR...");
  emitState();

  loginPromise = zalo
    .loginQR(
      {
        userAgent: USER_AGENT,
        language: "vi",
      },
      handleLoginQREvent
    )
    .then(async (loggedApi) => {
      await finalizeLogin(loggedApi);
      setQrState("done", "");
      return getPublicState();
    })
    .catch((error) => {
      console.error("[zalo] Loi login QR:", error);
      appState.loggedIn = false;
      appState.loggingIn = false;
      setQrState("error", error.message || "Khong dang nhap duoc.");
      throw error;
    })
    .finally(() => {
      loginPromise = null;
      emitState();
    });

  return loginPromise;
}

async function handleLoginQREvent(event) {
  switch (event.type) {
    case LoginQRCallbackEventType.QRCodeGenerated:
      appState.qr = {
        status: "generated",
        image: `data:image/png;base64,${event.data.image}`,
        message: "Quet ma QR bang app Zalo",
        scannedName: null,
      };
      break;
    case LoginQRCallbackEventType.QRCodeExpired:
      appState.qr = {
        status: "expired",
        image: null,
        message: "Ma QR da het han. Hay tao lai QR.",
        scannedName: null,
      };
      break;
    case LoginQRCallbackEventType.QRCodeScanned:
      appState.qr.status = "scanned";
      appState.qr.message = "Da quet - dang xac nhan tren dien thoai...";
      appState.qr.scannedName = event.data?.display_name || null;
      break;
    case LoginQRCallbackEventType.QRCodeDeclined:
      appState.qr = {
        status: "declined",
        image: null,
        message: "Dang nhap da bi tu choi tren dien thoai.",
        scannedName: null,
      };
      break;
    case LoginQRCallbackEventType.GotLoginInfo:
      appState.qr.status = "confirming";
      appState.qr.message = "Dang hoan tat dang nhap...";
      await saveCredentials({
        imei: event.data.imei,
        cookie: event.data.cookie,
        userAgent: USER_AGENT,
        language: "vi",
      });
      break;
    default:
      break;
  }
  emitState();
}

async function finalizeLogin(loggedApi) {
  // API moi, ke ca cung UID, luon la mot runtime generation moi.
  voHieuHoaViecRuntimeCu();
  api = loggedApi;
  appState.loggedIn = true;
  appState.loggingIn = false;
  resetHistorySyncState();
  await loadOwnProfile();
  // Doi tai khoan la phai nap lai cau hinh RIENG cua tai khoan do, neu khong
  // cong tac bot va lua chon nhom/nick cua tai khoan truoc van con hieu luc.
  //
  // Thu tu o day la BAT BUOC, phai nam giua loadOwnProfile va setupListener:
  //  - Dat TRUOC loadOwnProfile thi appState.uid con null, getAccountConfig(null)
  //    tra ve mac dinh fail-closed (bot TAT). Cau hinh trong bo nho vi the LUON
  //    la TAT sau moi lan dang nhap tu dong, du CSDL ghi BAT - va khong ai thay,
  //    vi nut Bot tren man hinh doc thang CSDL nen van sang. Ngay 23/08/2026
  //    container khoi dong lai luc 13:09; den 13:12 khach nhan hai tin, ca hai
  //    deu bi ghi "bot_off" trong khi giao dien khang dinh bot dang BAT.
  //  - Dat SAU setupListener thi tin den dau tien co the chay vao bo loc truoc
  //    khi cau hinh kip nap: van con khe hoi dua, chi la hep hon.
  await aiChat.refreshConfig().catch(() => {});
  setupListener();
  await rebuildThreadsFromMessages(chuHienTai());
  emitState();
  await emitThreads();
  const originToken = taoOriginRuntime();
  dongHoDongBoCatalog = setTimeout(async () => {
    dongHoDongBoCatalog = null;
    if (!originConHieuLuc(originToken)) return;
    const originApi = api;
    const originOwnerUid = chuHienTai();
    try {
      await syncThreadCatalog(originApi, originOwnerUid);
      if (!originConHieuLuc(originToken)) return;
      await emitThreads(originToken);
    } catch (error) {
      console.warn("[zalo] Loi sync catalog:", error.message);
    }
  }, 8000);
}

async function loadOwnProfile() {
  // Dat uid TRUOC khi goi mang: uid la thu quyet dinh bot co nhan ra minh bi tag
  // trong nhom hay khong. Lay profile hong ma keo theo mat uid thi bot cam tit
  // trong moi nhom, ma khong ai biet vi sao.
  try {
    appState.uid = String(api.getOwnId());
  } catch (error) {
    console.warn("[zalo] Khong lay duoc uid:", error.message);
  }

  try {
    const ownId = api.getOwnId();
    const info = await api.getUserInfo(ownId, AvatarSize?.Large);
    const user = Array.isArray(info) ? info[0] : info?.changed_profiles?.[ownId] || info?.[ownId] || info;
    appState.uid = String(ownId);
    appState.displayName = user?.displayName || user?.zaloName || user?.name || "Toi";
    appState.myAvatar = user?.avatar || user?.avatarUrl || null;
  } catch (error) {
    console.warn("[zalo] Khong lay duoc profile:", error.message);
  }
}

/* --- CAM XUC: TRANG THAI TRINH BAY TRONG PHIEN --- */

/**
 * "owner|threadId|msgId" -> Map(uid nguoi tha -> ma bieu tuong).
 *
 * CO Y de trong bo nho. Luu ben vung can them cot/bang moi, ma goi tin nay
 * KHONG duoc phep doi lai luoc do CSDL. Hau qua da biet va da ghi ro:
 * REACTION_UI_STATE_AFTER_FULL_RESTART = NOT_GUARANTEED_V1.
 * Tuyet doi khong gia vo luu ben vung bang cach nhet vao raw_json.
 */
const camXucTheoTin = new Map();

function khoaCamXuc(ownerUid, threadId, msgId) {
  return `${String(ownerUid)}|${String(threadId)}|${String(msgId)}`;
}

/**
 * Diem hoa giai DUY NHAT cho trang thai cam xuc.
 *
 * Ca hai duong - HTTP tra ve thanh cong va su kien listener cua Zalo - deu goi
 * vao day. Chi ban socket khi gia tri THAT SU doi, nen hai duong cung noi mot
 * dieu chi lam giao dien nhay mot lan.
 *
 * @returns {boolean} da co thay doi hay khong
 */
function capNhatCamXucCucBo({ ownerUid, threadId, msgId, reactorUid, icon }) {
  const chu = String(ownerUid || "").trim();
  const nguoiTha = String(reactorUid || "").trim();
  if (!chu || !threadId || !msgId || !nguoiTha) return false;

  const khoa = khoaCamXuc(chu, threadId, msgId);
  const hienCo = camXucTheoTin.get(khoa) || new Map();
  const cu = hienCo.get(nguoiTha) ?? "";
  const moi = String(icon ?? "");
  if (cu === moi) return false;

  // Chuoi rong la GO cam xuc, khong phai mot bieu tuong ten rong.
  if (moi === "") hienCo.delete(nguoiTha);
  else hienCo.set(nguoiTha, moi);

  if (hienCo.size) camXucTheoTin.set(khoa, hienCo);
  else camXucTheoTin.delete(khoa);

  if (chu === chuHienTai()) {
    io?.emit("message-reaction", {
      threadId: String(threadId),
      messageId: String(msgId),
      reactions: layCamXucCucBo(chu, threadId, msgId),
    });
  }
  return true;
}

/** Gom theo bieu tuong de giao dien chi phai ve, khong phai tu dem. */
export function layCamXucCucBo(ownerUid, threadId, msgId) {
  const hienCo = camXucTheoTin.get(khoaCamXuc(ownerUid, threadId, msgId));
  if (!hienCo?.size) return [];
  const dem = new Map();
  for (const [uid, icon] of hienCo) {
    const ten = tenBieuTuongApp(icon);
    const muc = dem.get(ten) || { ten, count: 0, mine: false };
    muc.count += 1;
    if (String(uid) === String(ownerUid)) muc.mine = true;
    dem.set(ten, muc);
  }
  return [...dem.values()];
}

/** Chi de kiem thu va de duong dang xuat don sach trang thai cua phien cu. */
export function xoaCamXucCucBo() {
  camXucTheoTin.clear();
}

/**
 * Su kien cam xuc cua Zalo. rMsg[0].gMsgID la id toan cuc cua tin BI tha, con
 * data.msgId la id cua chinh hanh dong tha - lay nham la gan cam xuc vao mot
 * tin khong ton tai.
 */
function ghiNhanCamXucTuProvider(reaction, ownerUid) {
  const dt = reaction?.data;
  const msgId = dt?.content?.rMsg?.[0]?.gMsgID;
  if (!msgId) return false;
  return capNhatCamXucCucBo({
    ownerUid,
    threadId: reaction?.threadId,
    msgId,
    reactorUid: dt?.uidFrom,
    icon: dt?.content?.rIcon ?? "",
  });
}

/* --- THU HOI --- */

export const NHAN_TIN_DA_THU_HOI = "Tin nhắn đã được thu hồi";

/**
 * Diem hoa giai DUY NHAT cho trang thai da-thu-hoi.
 *
 * markMessageRecalled chi doi dong CHUA o trang thai thu hoi, nen HTTP tra ve
 * thanh cong roi su kien listener den sau (hoac nguoc lai) van chi sinh dung
 * mot lan doi trang thai va dung mot su kien socket.
 */
export async function apDungThuHoiCucBo({ ownerUid, threadId, messageId }) {
  const chu = String(ownerUid || "").trim();
  if (!chu || !threadId || !messageId) return false;

  const daDoi = await markMessageRecalled(chu, threadId, messageId, NHAN_TIN_DA_THU_HOI);
  if (!daDoi) return false;

  // Tin vua thu hoi co the dang la dong tom tat cua cuoc tro chuyen. Chi tinh
  // lai DUNG cuoc do, khong dung lai toan bo danh muc.
  const thread = await recomputeThreadPreview(chu, threadId);
  if (chu !== chuHienTai()) return true;

  io?.emit("message-recalled", {
    threadId: String(threadId),
    messageId: String(messageId),
    content: NHAN_TIN_DA_THU_HOI,
    msgType: "chat.recalled",
  });
  if (thread) io?.emit("thread-refresh", thread);
  await emitThreads();
  return true;
}

/**
 * content.globalMsgId la tin BI thu hoi; data.msgId la tin bao thu hoi. Lay
 * nham la doi nham mot bong bong khac thanh "da thu hoi".
 */
async function ghiNhanThuHoiTuProvider(undoEvent, ownerUid) {
  const messageId = undoEvent?.data?.content?.globalMsgId;
  if (!messageId) return false;
  return apDungThuHoiCucBo({
    ownerUid,
    threadId: undoEvent?.threadId,
    messageId,
  });
}

function setupListener() {
  if (listenerAttached || !api?.listener) return;
  listenerAttached = true;
  const listenerOwnerUid = chuHienTai();

  attachOldMessagesListener(api, chuHienTai, async () => {
    await rebuildThreadsFromMessages(chuHienTai());
    await emitThreads();
  });

  api.listener.on("message", async (message) => {
    // typeof giu cho cac harness cu tach rieng function nay van chay tokenless;
    // trong module production, helper luon ton tai va listener luon co token.
    const originToken = typeof taoOriginRuntime === "function" ? taoOriginRuntime() : null;
    let normalizedMsg = null;
    try {
      // zca-js da resolve direction va dat counterpart/group vao message.threadId.
      // Self event thieu field nay la invalid; khong duoc doan lai tu uidFrom/idTo.
      if (message?.isSelf === true && !message?.threadId) {
        console.warn("[zalo] Bo qua self event thieu provider threadId.");
        return;
      }
      normalizedMsg = normalizeIncomingMessage(message);
      if (normalizedMsg?.isSelf === true) {
        // chat.sticker: khi CHINH minh gui sticker, Zalo doi lai ban echo mang
        // day du msgId/cliMsgId/uidFrom. Truoc day bo lot no nen bong bong
        // sticker cua minh khong bao gio hien, va tin do khong co dinh danh.
        const supportedSelfTypes = new Set([
          "text",
          "chat.text",
          "webchat",
          "chat.photo",
          "share.file",
          "chat.sticker",
        ]);
        if (!normalizedMsg.threadId || !supportedSelfTypes.has(String(normalizedMsg.msgType || ""))) return;
      }
      await handleNewIncomingMessage(normalizedMsg, originToken);
    } catch (error) {
      console.error("[zalo] Loi xu ly tin realtime:", error);
      if ((!originToken || originConHieuLuc(originToken)) && chuHienTai()) {
        await addLog({
          event: "zalo_xu_ly_realtime_loi",
          level: "error",
          summary: `Lỗi xử lý tin Zalo realtime — ${error.message}`,
          detail: {
            stage: "incoming_processing",
            threadId: normalizedMsg?.threadId ?? null,
            threadType: normalizedMsg?.threadType ?? null,
            senderId: normalizedMsg?.senderId ?? null,
            msgType: normalizedMsg?.msgType ?? null,
            error: error.message,
          },
        });
      }
    }
  });

  // Ai dang go phim. Khong tra loi gi ca, chi ghi lai de bo gom biet duong cho.
  api.listener.on("typing", (typing) => {
    try {
      ghiNhanGoPhim(typing, listenerOwnerUid);
    } catch {
      // Mat mot tin hieu go phim khong dang de lam gi ca.
    }
  });

  // Bieu tuong cam xuc do BAT KY ai tha, ke ca chinh minh tu may khac. Day la
  // nguon su that duy nhat cho trang thai cam xuc: duong HTTP sau khi bam cung
  // di qua chinh ham nay, nen hai duong khong the ban ra hai trang thai khac nhau.
  api.listener.on("reaction", (reaction) => {
    try {
      ghiNhanCamXucTuProvider(reaction, listenerOwnerUid);
    } catch (error) {
      console.warn("[cam-xuc] Bo qua su kien cam xuc loi:", error?.message || error);
    }
  });

  // Tin bi thu hoi - co the do chinh minh bam, co the do nguoi kia thu hoi tin
  // cua ho. Ca hai truong hop deu phai doi bong bong o day thanh "da thu hoi".
  api.listener.on("undo", (undoEvent) => {
    ghiNhanThuHoiTuProvider(undoEvent, listenerOwnerUid).catch((error) => {
      console.warn("[thu-hoi] Bo qua su kien thu hoi loi:", error?.message || error);
    });
  });

  api.listener.on("cipher_key", () => requestInitialHistorySync(api));

  // BON TAI NGHE. Truoc day app khong bat mot su kien nao trong so nay, nen khi
  // duong day dut thi khong ai biet: khong log, khong doi trang thai, giao dien
  // van hien "dang ket noi". Chi chi phat hien ra khi thay ca buoi khong ai nhan.
  api.listener.on("connected", () => {
    soLanThuNoiLai = 0;
    datTrangThaiKetNoi("song");
    addLog({
      event: "zalo_ket_noi",
      level: "ok",
      summary: "Đã kết nối với Zalo — bắt đầu nhận tin nhắn",
    }).catch(() => {});
  });

  api.listener.on("disconnected", (code, reason) => ghiNhanDut("disconnected", code, reason));
  api.listener.on("closed", (code, reason) => ghiNhanDut("closed", code, reason));

  api.listener.on("error", (error) => {
    const loi = error?.message || String(error);
    datTrangThaiKetNoi("chet", loi);
    addLog({
      event: "zalo_mat_ket_noi",
      level: "error",
      summary: `Đường dây Zalo báo lỗi — ${loi}`,
      detail: { error: loi },
    }).catch(() => {});
    henNoiLai();
  });

  datTrangThaiKetNoi("dang-noi");
  api.listener.start({ retryOnClose: true });
}

function ghiNhanDut(suKien, code, reason) {
  // "disconnected" va "closed" cung bay ra cho MOT lan dut. Khong gop lai thi
  // log ra hai dong giong het nhau va bo dem gian cach bi day len gap doi.
  const bayGio = Date.now();
  if (bayGio - lucDutGanNhat < 3000) return;
  lucDutGanNhat = bayGio;

  // Code 1000 la logout chu dong va da bi vo hieu hoa tai dangXuatZalo.
  if (Number(code) !== 1000) voHieuHoaViecRuntimeCu();

  const moTa = LY_DO_DUT[code] || `Mã ${code}`;
  datTrangThaiKetNoi("chet", moTa);
  addLog({
    event: "zalo_mat_ket_noi",
    level: "warn",
    summary: `Mất kết nối Zalo — ${moTa}`,
    detail: { suKien, code, reason: reason || "", moTa },
  }).catch(() => {});

  // Ma 1000 la minh chu dong dong (dang xuat) -> khong noi lai.
  if (Number(code) === 1000) return;
  henNoiLai();
}

/**
 * Hen noi lai sau khi dut, gian dan: 5s, 10s, 20s, 40s, toi da 60s.
 * Thu mai khong nghi: app chay 24/7 tren VPS, mang chap chon vai phut roi hoi
 * la chuyen thuong - bo cuoc sau vai lan la sang hom sau chi mat ca dem tin.
 */
function henNoiLai() {
  if (dongHoNoiLai || dangNoiLai || !appState.loggedIn) return;
  soLanThuNoiLai++;
  const cho = Math.min(5000 * 2 ** (soLanThuNoiLai - 1), 60000);
  const originToken = taoOriginRuntime();
  dongHoNoiLai = setTimeout(() => {
    dongHoNoiLai = null;
    if (!originConHieuLuc(originToken)) return;
    noiLaiZalo(`tự động lần ${soLanThuNoiLai}`, originToken).catch(() => {});
  }, cho);
}

/**
 * Dung han duong day cu roi dung lai tu dau bang credential da luu.
 * Phai ha co listenerAttached, khong thi setupListener se thoat ngay va cai
 * api MOI se khong co tai nghe nao - dut lan hai la im lang vinh vien.
 */
export async function noiLaiZalo(nguon = "thủ công", originToken = null) {
  if (originToken && !originConHieuLuc(originToken)) {
    return { ok: false, message: "Runtime Zalo cũ đã kết thúc." };
  }
  if (dangNoiLai) return { ok: false, message: "Đang nối lại, chị đợi chút." };
  dangNoiLai = true;
  datTrangThaiKetNoi("dang-noi");
  let thanhCong = false;

  try {
    if (originToken && !originConHieuLuc(originToken)) {
      return { ok: false, message: "Runtime Zalo cũ đã kết thúc." };
    }
    try {
      api?.listener?.stop?.();
    } catch {
      // Duong day da chet san thi khong dong duoc - khong sao.
    }
    listenerAttached = false;

    const credentials = await loadCredentials();
    if (originToken && !originConHieuLuc(originToken)) {
      return { ok: false, message: "Runtime Zalo cũ đã kết thúc." };
    }
    if (!credentials) {
      datTrangThaiKetNoi("chet", "Chưa có thông tin đăng nhập Zalo — cần quét mã QR");
      appState.loggedIn = false;
      emitState();
      return { ok: false, message: "Chưa có thông tin đăng nhập. Chị quét mã QR giúp em." };
    }

    const loggedApi = await coHanGio(
      zalo.login(credentials),
      HAN_GIO_DANG_NHAP_MS,
      "Đăng nhập Zalo"
    );
    if (originToken && !originConHieuLuc(originToken)) {
      return { ok: false, message: "Runtime Zalo cũ đã kết thúc." };
    }
    await finalizeLogin(loggedApi);
    thanhCong = true;
    await addLog({
      event: "zalo_ket_noi",
      level: "ok",
      summary: `Đã nối lại Zalo (${nguon})`,
      detail: { nguon },
    }).catch(() => {});
    return { ok: true, message: "Đã nối lại Zalo." };
  } catch (error) {
    if (originToken && !originConHieuLuc(originToken)) {
      return { ok: false, message: "Runtime Zalo cũ đã kết thúc." };
    }
    const loi = error?.message || String(error);
    datTrangThaiKetNoi("chet", loi);

    // Thu lai mai nghia la moi phut mot dong loi. Bang nhat ky chi giu 500 dong,
    // ghi het ca thi sau 8 tieng moi thu huu ich khac bi day ra ngoai. Ghi 3 lan
    // dau (du de chi biet co chuyen), roi cach 10 lan moi ghi mot lan.
    if (soLanThuNoiLai <= 3 || soLanThuNoiLai % 10 === 0) {
      await addLog({
        event: "zalo_mat_ket_noi",
        level: "error",
        summary: `Nối lại Zalo THẤT BẠI (${nguon}) — ${loi}`,
        detail: { nguon, error: loi, soLanDaThu: soLanThuNoiLai },
      }).catch(() => {});
    }
    return { ok: false, message: `Nối lại không được: ${loi}` };
  } finally {
    // Boundary moi tu dat lai co nay. Viec cu khong duoc sua runtime moi.
    if (!originToken || originConHieuLuc(originToken)) dangNoiLai = false;
    // Thu lai cho den khi duoc. Truoc day that bai mot lan la nam chet luon:
    // chi gap laptop -> dut -> app thu noi lai dung mot lan trong luc may con
    // dang ngu -> that bai -> bo cuoc vinh vien. Sang hom sau van im lang.
    // Phai dat trong finally vi luc o trong catch thi dangNoiLai con dang bat.
    if ((!originToken || originConHieuLuc(originToken)) && !thanhCong && appState.loggedIn) henNoiLai();
  }
}

/**
 * Goi moi khi giao dien vua ket noi toi server, tuc la moi khi chi mo app.
 *
 * Ly do phai co: khi laptop ngu, tien trinh bi dong bang. Luc duong day dut thi
 * app dang ngu nen KHONG nghe duoc su kien nao. Ngu day, no cam mot cai ong
 * nghe da chet ma van tuong con song, va vi khong co tin bao dut nen co che tu
 * noi lai cung khong bao gio chay. Day KHONG phai bo hoi dinh ky: no chi chay
 * dung luc chi mo app.
 */
export async function kiemTraKetNoiKhiMoApp() {
  if (!appState.loggedIn || dangNoiLai) return;

  const ws = api?.listener?.ws;
  // readyState 1 = OPEN. Thu vien khong cong khai truong nay nen phai phong
  // truong hop ban sau doi ten: khong doc duoc thi dua vao trang thai da ghi.
  const wsSong = ws ? ws.readyState === 1 : appState.ketNoi.trangThai === "song";
  if (wsSong) return;

  await addLog({
    event: "zalo_mat_ket_noi",
    level: "warn",
    summary: "Mở app thấy đường dây Zalo đã chết — đang tự nối lại",
    detail: { readyState: ws?.readyState ?? null, trangThaiCu: appState.ketNoi.trangThai },
  }).catch(() => {});

  await noiLaiZalo("kiểm tra khi mở app");
}

/**
 * Dang xuat KHOI ZALO - khac han dang xuat khoi app. Xoa credential da luu nen
 * lan sau bat buoc phai quet QR.
 */
export async function dangXuatZalo() {
  voHieuHoaViecRuntimeCu();
  try {
    api?.listener?.stop?.();
  } catch {
    // Khong dong duoc thi thoi, van phai xoa credential.
  }
  listenerAttached = false;
  api = null;
  appState.loggedIn = false;
  appState.uid = null;
  appState.displayName = null;
  await aiChat.refreshConfig().catch(() => {});
  appState.myAvatar = null;
  resetHistorySyncState();
  await xoaCredentials();
  setQrState("idle", "Đã đăng xuất Zalo. Quét mã QR để đăng nhập lại.");
  datTrangThaiKetNoi("chua", "Đã đăng xuất khỏi Zalo");
  await addLog({
    event: "zalo_dang_xuat",
    level: "warn",
    summary: "Đã đăng xuất khỏi Zalo — cần quét mã QR để dùng lại",
  }).catch(() => {});
  emitState();
  return { ok: true };
}

/* --- NHIP TRA LOI CHO GIONG NGUOI THAT --- */

/**
 * Cho khach noi het da roi moi dap.
 *
 * Truoc day bot tra loi NGAY tung tin mot. Khach gui file roi 5 giay sau gui
 * loi nhan -> bot dap hai lan, hai cau gan giong het nhau (chinh la vu "sao em
 * lai tra loi 2 lan"). Con tinh nang doc file thi hong han: file va cau hoi bi
 * tach lam hai luot nen bot doc file ma khong biet khach muon hoi gi.
 */
/**
 * Do that tren may chi ngay 09/08/2026: Zalo ban lai tin hieu "dang go" khoang
 * 10 giay mot lan (11.5s / 10.3s / 10.1s / 10.2s). Nguong cu dat 5 giay nen gan
 * nhu luc nao cung ket luan "da ngung go" - tinh nang cho khach ke het cau coi
 * nhu khong chay. Dat 13 giay: cao hon nhip 11.5s do duoc, con du le, ma khong
 * cao qua khien khach go xong ngoi im phai cho lau.
 */
const CON_DANG_GO_MS = 13000;

/** Lan cuoi moi nguoi go phim: "ownerUid|threadId|uid" -> moc thoi gian. */
const lanGoCuoi = new Map();

/**
 * Zalo bao ai dang go phim. Dung de KHONG cat ngang nguoi dang ke do cau
 * chuyen: ho ngung 8 giay de nghi tiep thi bot van cho, thay vi nhay vao.
 */
function ghiNhanGoPhim(typing, ownerUid = chuHienTai()) {
  const uid = String(typing?.data?.uid || "");
  const threadId = String(typing?.threadId || typing?.data?.gid || "");
  const chu = String(ownerUid || "").trim();
  if (!chu || !uid || !threadId) return;
  lanGoCuoi.set(`${chu}|${khoaGom(threadId, uid)}`, Date.now());
}

/**
 * Da co mot lan em bat them dieu kien "tin hieu go phim phai den SAU tin nhan
 * cuoi moi tinh la dang soan tiep". Nghe thi chat che, thuc te lai pha dung cai
 * no dinh bao ve:
 *
 *    17:11:36  Zalo bao chi dang go
 *    17:11:38  chi gui cau 1
 *    17:11:45  bot kiem: tin hieu (:36) CU hon tin nhan (:38) -> "ngung roi"
 *    17:11:47  chi gui cau 2      <- bot da xong ra tra loi truoc do
 *
 * Vi Zalo chi ban lai tin hieu 10 giay mot lan, tin nhan roi vao giua hai nhip
 * la chuyen binh thuong. Nen bo dieu kien do, chi xet DO MOI: im lang qua
 * CON_DANG_GO_MS ma khong co nhip nao moi thi mac dinh la da ngung go.
 */
function conDangGo(threadId, senderId, ownerUid = chuHienTai()) {
  const chu = String(ownerUid || "").trim();
  if (!chu) return false;
  const moc = lanGoCuoi.get(`${chu}|${khoaGom(threadId, senderId)}`);
  return Boolean(moc) && Date.now() - moc < CON_DANG_GO_MS;
}

const boGom = taoBoGom({
  conDangGo,
  khiChot: (tins, automaticWork) => traLoiCumTin(tins, automaticWork)
    .catch((error) => console.error("[zalo] Loi tra loi:", error)),
});

/** Dau "dang soan tin" cua Zalo tu tat sau vai giay -> phai nhac lai lien tuc. */
const NHAC_GO_PHIM_MS = 3000;

/** Nghi truoc moi bubble, dai ngan theo so chu - nguoi that go cau dai thi lau hon. */
const NGHI_MOI_CHU_MS = 18;
const NGHI_IT_NHAT_MS = 1000;
const NGHI_NHIEU_NHAT_MS = 2500;

const doi = (ms) => new Promise((r) => setTimeout(r, ms));

function nghiTruocBubble(text) {
  const ms = String(text || "").length * NGHI_MOI_CHU_MS;
  return Math.min(Math.max(ms, NGHI_IT_NHAT_MS), NGHI_NHIEU_NHAT_MS);
}

/** Bat dau hien "dang soan tin". Tra ve ham de tat. Loi thi bo qua: mat dau ba
 *  cham khong duoc phep lam hong viec tra loi khach. */
function batDauGoPhim(threadId, threadType, originToken = null) {
  let dungRoi = false;
  const nhac = () => {
    if (originToken && !originConHieuLuc(originToken)) return;
    if (dungRoi || !api?.sendTypingEvent) return;
    sendTypingSignal({ threadId, threadType }, originToken).catch(() => {});
  };
  nhac();
  const dongHo = setInterval(nhac, NHAC_GO_PHIM_MS);
  return () => {
    dungRoi = true;
    clearInterval(dongHo);
  };
}

/* --- LINK CO ANH XEM TRUOC --- */

/** Sau khi bo duong link ra, phan chu con lai dai hon nguong nay thi coi nhu
 *  day la mot doan van co kem link, khong phai mot tin gui link. Doan van ma
 *  bien thanh the link se mat het cach xuong dong va nhip bong bong. */
const CHU_CON_LAI_TOI_DA = 120;
const MAU_LINK = /https?:\/\/[^\s<>"']+/g;

/**
 * @returns {{duongDan:string, loiNhan:string}|null}
 */
export function timLinkChinh(text) {
  const s = String(text || "");
  const tim = s.match(MAU_LINK);
  // Nhieu link thi de nguyen chu: the xem truoc chi hien duoc mot cai, gui
  // kieu do la nuot mat cac link con lai.
  if (!tim || tim.length !== 1) return null;

  const duongDan = tim[0].replace(/[.,;:)\]}]+$/, "");
  const loiNhan = s
    .replace(tim[0], "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\r\n]+/g, " ")
    .trim();
  if (loiNhan.length > CHU_CON_LAI_TOI_DA) return null;

  return { duongDan, loiNhan };
}

/* --- TRICH DAN, @NHAC TEN, MUC DO KHAN --- */

/** Zalo doi du 8 truong nay moi chiu hien khoi trich dan. Thieu mot cai la
 *  tin van gui duoc nhung khong co trich dan - nen kiem truoc cho chac. */
const TRUONG_TRICH_DAN = ["content", "msgType", "propertyExt", "uidFrom", "msgId", "cliMsgId", "ts", "ttl"];

function dungTrichDan(tin) {
  const dt = tin?.rawJson?.data;
  if (!dt) return null;
  if (TRUONG_TRICH_DAN.some((k) => dt[k] === undefined || dt[k] === null)) return null;
  return Object.fromEntries(TRUONG_TRICH_DAN.map((k) => [k, dt[k]]));
}

/** Ten thanh vien tung nhom, nho tam 15 phut - khong the goi Zalo moi lan tra loi. */
const nhoThanhVien = new Map();
const HAN_NHO_THANH_VIEN_MS = 15 * 60 * 1000;

async function layThanhVien(groupId, ownerUid = chuHienTai(), ownerApi = api) {
  const chu = String(ownerUid || "").trim();
  if (!chu) return [];
  const khoa = `${chu}:${groupId}`;
  const co = nhoThanhVien.get(khoa);
  if (co && Date.now() - co.luc < HAN_NHO_THANH_VIEN_MS) return co.ds;
  try {
    const { members } = await listGroupMembers(groupId, ownerApi);
    const ds = (members || [])
      .map((m) => ({ uid: String(m.id), ten: String(m.displayName || m.zaloName || "").trim() }))
      .filter((m) => m.ten.length >= 2 && m.uid !== chu)
      // Ten dai truoc: "Le Hong Minh" phai duoc thu truoc "Minh", khong thi
      // bat nham phan ngan roi bo sot phan con lai.
      .sort((a, b) => b.ten.length - a.ten.length);
    nhoThanhVien.set(khoa, { luc: Date.now(), ds });
    return ds;
  } catch (error) {
    console.warn("[zalo] Khong lay duoc thanh vien nhom:", error.message);
    return [];
  }
}

/**
 * Tim ten thanh vien trong cau tra loi roi bien thanh @nhac ten that.
 */
async function dungNhacTen(text, groupId, boQuaUid = [], ownerUid = chuHienTai(), ownerApi = api) {
  const bo = new Set(boQuaUid.map(String));
  return khopTenTrongCau(
    text,
    (await layThanhVien(groupId, ownerUid, ownerApi)).filter((t) => !bo.has(t.uid))
  );
}

/**
 * Chen dau @ vao truoc moi ten duoc gan the, va day lai vi tri cho khop.
 *
 * Zalo doi dau @ NAM THAT trong doan chu. Tin that nhan duoc tu Zalo:
 *    content  "@Vizen ơi"
 *    mentions [{ pos: 0, len: 6 }]     <- 6 = do dai "@Vizen", tinh ca dau @
 *
 * Truoc day minh gan the vao ten tran khong co @, nen Zalo bo qua het: bot
 * "gan the" ma nguoi kia khong he nhan duoc thong bao. Loi nay am tham vi
 * khong ai bao gi ca, tin van gui di binh thuong.
 *
 * Chen theo thu tu TU TRAI SANG, cong don do lech - moi lan chen mot ky tu thi
 * moi the phia sau day ra mot o.
 */
export function chenDauA(text, mentions) {
  if (!mentions?.length) return { text, mentions: [] };

  const xep = [...mentions].sort((a, b) => a.pos - b.pos);
  let ra = "";
  let cuoi = 0;
  let lech = 0;
  const moi = [];

  for (const m of xep) {
    ra += text.slice(cuoi, m.pos) + "@";
    moi.push({ uid: m.uid, pos: m.pos + lech, len: m.len + 1 });
    cuoi = m.pos;
    lech += 1;
  }
  ra += text.slice(cuoi);
  return { text: ra, mentions: moi };
}

/**
 * Dung doan chu va cac the @nhac ten cho mot bubble trong NHOM.
 *
 * Bubble DAU duoc gan the chinh nguoi vua noi. Trong nhom dong, trich dan thoi
 * chua du: khach khong mo Zalo ra thi khong biet co nguoi dang tra loi minh.
 * Gan the thi dien thoai ho keu.
 */
async function dungTheNhacTen(bubble, tin, laBubbleDau, ownerUid = chuHienTai(), ownerApi = api) {
  // Chot dung chuoi ma sendChatMessage se loc/trim lan nua, ROI moi tinh toa do.
  // Nho vay lan loc an toan thu hai la idempotent va khong lam lech the.
  const bubbleCuoi = await locTruocKhiGui(String(bubble || "").trim(), tin.threadId);
  if (!bubbleCuoi) return { text: bubbleCuoi, mentions: [] };

  let noiDung = bubbleCuoi;
  const theCoSan = [];

  const uidNguoiNoi = String(tin.senderId || "");
  const tenNguoiNoi = String(tin.senderName || "").trim();
  if (laBubbleDau && uidNguoiNoi && tenNguoiNoi) {
    noiDung = `${tenNguoiNoi} ${bubbleCuoi}`;
    theCoSan.push({ uid: uidNguoiNoi, pos: 0, len: tenNguoiNoi.length });
  }

  // Do truc tiep tren NOI DUNG CUOI, khong tinh tren raw text roi bu offset.
  // The nguoi noi chiem truoc vung dau cau de ten ngan (vd "Ngoc") cua mot
  // thanh vien khac khong khop nham ben trong "Bich Ngoc".
  const thanhVien = await layThanhVien(tin.threadId, ownerUid, ownerApi).catch(() => []);
  const the = khopTenTrongCau(
    noiDung,
    thanhVien.filter((tv) => String(tv.uid) !== uidNguoiNoi),
    theCoSan
  );

  return chenDauA(noiDung, the);
}

/**
 * Ngoai ten day du, chap nhan them TEN GOI = hai chu cuoi.
 *
 * Truoc day chi khop ten day du. Dung ve ly nhung sai ve doi: trong nhom ten
 * hien thi la "Tran Mai Anh", con nguoi that thi noi "chi Mai Anh oi" - khong
 * ai goi nhau bang ho ca. Ket qua la bot quote duoc ma khong bao gio gan the
 * duoc cho ai.
 *
 * HAI chu cuoi, khong phai mot: tieng Viet co "Anh", "Em", "Chi" vua la ten
 * vua la dai tu. Khop mot chu thi cau "anh ay noi" cung bi gan the.
 *
 * Va ten goi chi dung khi KHONG DUNG HANG voi ai khac trong nhom. Hai nguoi
 * cung "Mai Anh" thi bo qua ca hai - tha khong gan con hon gan nham nguoi.
 */
function dungTenGoi(ds) {
  const dem = new Map();
  const tenGoi = new Map(); // uid -> ten goi

  for (const tv of ds) {
    const tu = tv.ten.split(/\s+/).filter(Boolean);
    if (tu.length < 3) continue; // ten 1-2 chu thi ten goi trung ten day du
    const goi = tu.slice(-2).join(" ");
    tenGoi.set(tv.uid, goi);
    const khoa = goi.toLowerCase();
    dem.set(khoa, (dem.get(khoa) || 0) + 1);
  }

  // Ten goi trung voi ten DAY DU cua nguoi khac cung tinh la dung hang.
  for (const tv of ds) {
    const khoa = tv.ten.toLowerCase();
    if (dem.has(khoa) && tenGoi.get(tv.uid)?.toLowerCase() !== khoa) {
      dem.set(khoa, dem.get(khoa) + 1);
    }
  }

  const ra = [];
  for (const tv of ds) {
    const goi = tenGoi.get(tv.uid);
    if (goi && dem.get(goi.toLowerCase()) === 1) ra.push({ uid: tv.uid, ten: goi });
  }
  return ra;
}

/** Tao ban NFC viet thuong, kem khoang UTF-16 tuong ung trong chuoi goc. */
function taoBanSoSanhUnicode(goc) {
  const nguon = String(goc || "");
  let text = "";
  const ranges = [];

  for (let viTri = 0; viTri < nguon.length; ) {
    const start = viTri;
    let doan = String.fromCodePoint(nguon.codePointAt(viTri));
    viTri += doan.length;

    while (viTri < nguon.length) {
      const kyTu = String.fromCodePoint(nguon.codePointAt(viTri));
      if (!/\p{M}/u.test(kyTu)) break;
      doan += kyTu;
      viTri += kyTu.length;
    }

    const daDoi = doan.normalize("NFC").toLowerCase();
    text += daDoi;
    for (let i = 0; i < daDoi.length; i++) ranges.push({ start, end: viTri });
  }

  return { text, ranges };
}

/** Tach rieng phan thuan logic de kiem thu duoc ma khong can goi Zalo. */
export function khopTenTrongCau(text, ds, mentionsCoSan = []) {
  if (!ds?.length && !mentionsCoSan?.length) return [];

  // Ten day du va ten goi tron chung mot danh sach, XEP DAI TRUOC. Nho vay
  // "Tran Mai Anh" luon gianh cho truoc "Mai Anh", va moi lop bao ve cu (khong
  // cat ngang tu dai hon, khong de hai the len nhau) van chay nguyen.
  const ungVien = [...ds, ...dungTenGoi(ds)].sort((a, b) => b.ten.length - a.ten.length);

  const mentions = (mentionsCoSan || []).map((m) => ({ ...m }));
  const daDung = new Set(mentions.map((m) => String(m.uid)));
  const daChiem = mentions.map((m) => [m.pos, m.pos + m.len]);
  const banSoSanh = taoBanSoSanhUnicode(text);

  for (const tv of ungVien) {
    if (daDung.has(tv.uid)) continue;
    const ten = String(tv.ten).normalize("NFC").toLowerCase();

    // Duyet MOI lan xuat hien, khong chi lan dau. "Minhh khong phai la Minh":
    // lan dau nam trong "Minhh" nen bi loai, nhung chu "Minh" cuoi cau moi la
    // that - chi xet lan dau thi bo sot.
    for (let tu = 0; ; ) {
      const viTriSoSanh = banSoSanh.text.indexOf(ten, tu);
      if (viTriSoSanh < 0) break;
      tu = viTriSoSanh + 1;

      // Khong cat ngang mot tu dai hon (vd "Minh" nam trong "Minhh")
      const truoc = banSoSanh.text.slice(0, viTriSoSanh).match(/.$/u)?.[0] ?? " ";
      const sau = banSoSanh.text.slice(viTriSoSanh + ten.length).match(/^./u)?.[0] ?? " ";
      if (/[\p{L}\p{N}\p{M}]/u.test(truoc) || /[\p{L}\p{N}\p{M}]/u.test(sau)) continue;

      const dauGoc = banSoSanh.ranges[viTriSoSanh];
      const cuoiGoc = banSoSanh.ranges[viTriSoSanh + ten.length - 1];
      if (!dauGoc || !cuoiGoc) continue;
      const pos = dauGoc.start;
      const ketThuc = cuoiGoc.end;

      // Khong de hai the DE LEN NHAU. Nhom co ca "Le Hong Minh" lan "Minh" thi
      // cau "Le Hong Minh va Tu Anh" se bi gan 3 the, trong do "Minh" nam ngay
      // trong ten dai. Vi da xep ten dai truoc nen ten dai gianh cho truoc.
      if (daChiem.some(([a, b]) => pos < b && ketThuc > a)) continue;

      daChiem.push([pos, ketThuc]);
      mentions.push({ pos, uid: tv.uid, len: ketThuc - pos });
      daDung.add(tv.uid);
      break; // moi nguoi chi gan MOT the, khong spam
    }
  }
  return mentions.sort((a, b) => a.pos - b.pos);
}

/** Gop nhieu tin lien tiep thanh mot. Giu tin CO TEP lam goc de con doc duoc file. */
function gopThanhMotTin(tins) {
  const coTep = tins.find((t) => t.msgType === "chat.photo" || t.msgType === "share.file");
  const goc = coTep || tins[tins.length - 1];
  const loi = tins
    .map((t) => String(t.content || "").trim())
    .filter(Boolean)
    // Anh khong kem loi nhan thi Zalo de nguyen duong link lam noi dung -> bo di,
    // doc-tep se lo phan tep.
    .filter((s) => !/^https?:\/\/\S+$/.test(s));
  const sourceIds = [...new Set(tins.map((t) => t?.id).filter((id) => id !== null && id !== undefined).map(String))];
  return {
    ...goc,
    content: loi.join("\n") || String(goc.content || ""),
    ...(sourceIds.length ? { sourceIds } : {}),
  };
}


/**
 * Khach chi noi "cam on em" -> tha tim thay vi dap mot cau vo thuong vo phat.
 * Tra ve true neu da xu ly xong, khoi goi AI.
 */
async function thuThaCamXuc(tin, originToken = null) {
  if (originToken && !originConHieuLuc(originToken)) return false;
  const ten = chonCamXuc(tin.content);
  if (!ten) return false;

  // Chot chan cuoi. Du sau nay ai do sua chonCamXuc tra ve "HAHA" hay "ANGRY",
  // den day van bi chan - bot khong the tha bieu tuong ngoai danh sach trang.
  const bieuTuong = layBieuTuong(ten);
  if (!bieuTuong) {
    await addLog({
      event: "tha_cam_xuc",
      level: "error",
      summary: `CHẶN — biểu tượng "${ten}" không nằm trong danh sách được phép`,
      detail: { bieuTuong: ten, choPhep: danhSachChoPhep() },
    }).catch(() => {});
    return false;
  }

  const ma = layMaTin(tin);
  if (!ma || !api?.addReaction) return false;
  if (originToken && !originConHieuLuc(originToken)) return false;

  try {
    // Cung cong ra voi duong nguoi dung bam: mot bien gioi provider duy nhat.
    // Chinh sach cua bot van nam nguyen o tren (layBieuTuong), khong doi.
    await reactToMessage(
      { icon: bieuTuong, identity: ma, threadId: tin.threadId, threadType: tin.threadType },
      originToken
    );
    if (originToken && !originConHieuLuc(originToken)) return true;
    await addLog({
      event: "tha_cam_xuc",
      level: "ok",
      summary: `Thả ${ten === "HEART" ? "❤️" : "👍"} thay vì trả lời: "${String(tin.content).slice(0, 40)}"`,
      detail: { threadId: tin.threadId, nguoiGui: tin.senderName, noiDung: tin.content, bieuTuong: ten },
    });
    return true;
  } catch (error) {
    // Tha khong duoc thi cu tra loi binh thuong, khong de khach bi bo roi.
    console.warn("[cam-xuc] Khong tha duoc:", error.message);
    return false;
  }
}

/* --- STICKER --- */

/** Mot cuoc tro chuyen nhieu lam mot sticker trong khoang nay. */
const GIAN_STICKER_MS = 30 * 60 * 1000;
const lanStickerCuoi = new Map();

/**
 * Gui sticker sau khi da tra loi xong. Ba luat chi da duyet:
 *    1. CHI trong chat rieng 1-1  - trong nhom la lam phien ca lop
 *    2. Thua - nhieu nhat 1 lan moi 30 phut trong mot cuoc tro chuyen
 *    3. Chuyen dang nang thi chi duoc dung sticker an ui, khong bao gio sticker vui
 * Luat 3 nam trong chonTinhHuong(), khong de model tu can nhac.
 *
 * Nuot moi loi: thieu mot cai sticker khong dang de lam hong luot tra loi.
 */
async function thuGuiSticker(tin, originToken = null) {
  try {
    if (originToken && !originConHieuLuc(originToken)) return;
    if (Number(tin.threadType) !== Number(ThreadType.User)) return;
    if (!api?.sendSticker) return;

    const ownerUid = String(originToken?.originOwnerUid || chuHienTai() || "").trim();
    const threadId = String(tin.threadId);
    if (!ownerUid || !threadId) return;
    const khoaCooldown = `${ownerUid}:${threadId}`;
    const lanCuoi = lanStickerCuoi.get(khoaCooldown) || 0;
    if (Date.now() - lanCuoi < GIAN_STICKER_MS) return;

    const viec = chonTinhHuong(tin.content);
    if (!viec) return;

    const stk = layStickerHopLe(viec);
    if (!stk) return; // chan cuoi: ngoai danh sach trang thi khong gui

    await doi(900); // de sau cau tra loi mot nhip cho tu nhien
    if (originToken && !originConHieuLuc(originToken)) return;
    // Chinh sach cua bot (chi 1-1, cach 30 phut, danh sach trang) van o tren;
    // day chi la duong ra provider dung chung voi nguoi dung.
    await sendStickerMessage({ stickerKey: viec, threadId, threadType: tin.threadType }, originToken);
    if (originToken && !originConHieuLuc(originToken)) return;
    lanStickerCuoi.set(khoaCooldown, Date.now());

    await addLog({
      event: "gui_sticker",
      level: "ok",
      summary: `Gửi sticker "${stk.moTa}" (${viec})`,
      detail: { threadId, viec, sticker: stk, loiKhach: String(tin.content).slice(0, 100) },
    });
  } catch (error) {
    console.warn("[sticker] Khong gui duoc:", error.message);
  }
}

/**
 * Rut phong bi "da xem" tu tin MOI NHAT co du dinh danh trong cum.
 * Tra null neu khong tin nao du - khong bao gio dap phong bi tu cac manh roi.
 */
function phongBiDaXemMoiNhat(tins) {
  for (let i = tins.length - 1; i >= 0; i -= 1) {
    const phongBi = rutDanhTinhProvider(tins[i]?.rawJson);
    if (phongBi?.idTo) return { phongBi, threadType: tins[i].threadType };
  }
  return null;
}

/**
 * Best-effort. UAT provider nhan dung phong bi nhung nguoi that KHONG quan sat
 * duoc dau da xem, nen tuyet doi khong de no chan duong tra loi khach.
 */
function guiDaXemChoTins(tins, originToken = null) {
  const nguon = phongBiDaXemMoiNhat(tins);
  if (!nguon) return;
  Promise.resolve()
    .then(() => markMessageSeen({ envelope: nguon.phongBi, threadType: nguon.threadType }, originToken))
    .catch(() => {});
}

async function traLoiCumTin(tins, automaticWork = null) {
  // Caller cu co the truyen thang origin token. Production aggregation truyen
  // hai authority tach biet de Bot toggle khong lam doi nghia runtime token.
  const coAutomaticWork = automaticWork
    && Object.prototype.hasOwnProperty.call(automaticWork, "originToken");
  const originToken = coAutomaticWork ? automaticWork.originToken : automaticWork;
  const capturedBotEligibilityEpoch = coAutomaticWork
    ? automaticWork.capturedBotEligibilityEpoch
    : null;
  const phaiKiemBotEligibility = Number.isInteger(capturedBotEligibilityEpoch);
  const botWorkConHieuLuc = () => !phaiKiemBotEligibility
    || botEligibilityConHieuLuc(capturedBotEligibilityEpoch);

  if (originToken && !originConHieuLuc(originToken)) return;
  if (!botWorkConHieuLuc()) return;
  const tin = gopThanhMotTin(tins);
  if (!tin.content?.trim()) return;

  // Exact OK duoc kiem tra tren tung tin goc. Bo gom canonical da tach theo
  // sender; handler con khoa pending bang owner + thread + sender de mot thanh
  // vien nhom khong the xac nhan ho nguoi khac.
  if (typeof handlePdfAutomation === "function") {
    const pdfAutomationResult = await handlePdfAutomation({ tins, tin, originToken });
    if (originToken && !originConHieuLuc(originToken)) return;
    if (!botWorkConHieuLuc()) return;
    if (pdfAutomationResult === PDF_AUTOMATION_HANDLED) return;
  }

  // Bao khach biet minh da nghe thay, truoc ca khi AI kip nghi.
  //
  // Duong cu goi sendSeenEvent(threadId, threadType): tham so dau cua zca-js
  // 2.1.2 la PHONG BI TIN NHAN chu khong phai id cuoc tro chuyen, nen lenh do
  // chua bao gio mang dung nghia. Gio dung phong bi day du rut tu chinh tin
  // moi nhat trong cum; thieu truong bat buoc thi im lang bo qua chu khong bia.
  guiDaXemChoTins(tins, originToken);

  // Thu tha cam xuc TRUOC khi goi AI: cau "cam on em" khong dang mot luot goi.
  if (tins.length === 1 && (await thuThaCamXuc(tin, originToken))) return;
  if (originToken && !originConHieuLuc(originToken)) return;
  if (!botWorkConHieuLuc()) return;

  // Phai giu bien de con TAT duoc. Moi lan batDauGoPhim la mot dong ho moi;
  // goi lai ma khong giu ham tat thi dong ho cu chay ngam mai.
  let tatGoPhim = batDauGoPhim(tin.threadId, tin.threadType, originToken);

  let aiReply = null;
  let bubbles = [];
  let totalBubbleCount = 0;
  let sentBubbleCount = 0;
  let failedBubbleIndex = null;
  try {
    // Revalidation bat buoc ngay truoc AI.
    if (!botWorkConHieuLuc()) return;
    aiReply = await aiChat.tryReply(tin.content, tin);
    if (originToken && !originConHieuLuc(originToken)) return;
    // Bot co the bi OFF roi ON trong luc model dang chay; boolean hien tai ON
    // khong du de cho phep continuation cua epoch cu.
    if (!botWorkConHieuLuc()) return;
    if (!aiReply) return;

    const laNhom = Number(tin.threadType) === Number(ThreadType.Group);
    // Trich dan CHI trong nhom: 30 nguoi noi cung luc, khong trich thi khong ai
    // biet bot dang tra loi ai. Chat rieng hai nguoi ma cung trich dan thi may moc.
    const trichDan = laNhom ? dungTrichDan(tin) : null;

    bubbles = splitIntoBubbles(aiReply);
    totalBubbleCount = bubbles.length;
    for (const [i, bubble] of bubbles.entries()) {
      // Nghi truoc TUNG bubble, ke ca bubble dau: vua nhan xong da co ngay ba
      // dong chu thi lo ra la may.
      await doi(i === 0 ? Math.min(nghiTruocBubble(bubble), 1200) : nghiTruocBubble(bubble));
      tatGoPhim();
      if (originToken && !originConHieuLuc(originToken)) return;
      if (!botWorkConHieuLuc()) return;

      const { text: noiDung, mentions } = laNhom
        ? await dungTheNhacTen(
          bubble,
          tin,
          i === 0,
          originToken?.originOwnerUid || chuHienTai(),
          originToken?.originApiIdentity || api
        ).catch(() => ({ text: bubble, mentions: [] }))
        : { text: bubble, mentions: [] };
      if (originToken && !originConHieuLuc(originToken)) return;
      if (!botWorkConHieuLuc()) return;

      failedBubbleIndex = i + 1;
      await sendChatMessage({
        threadId: tin.threadId,
        threadType: tin.threadType,
        text: noiDung,
        // Chi trich dan o bubble DAU. Trich ca 3 bubble thi man hinh day khoi
        // trich dan lap lai, roi mat.
        quote: i === 0 ? trichDan : null,
        mentions,
        originToken,
      }, phaiKiemBotEligibility ? { botEligibilityEpoch: capturedBotEligibilityEpoch } : undefined);
      if (originToken && !originConHieuLuc(originToken)) return;
      if (!botWorkConHieuLuc()) return;
      sentBubbleCount += 1;
      failedBubbleIndex = null;

      // Con bubble nua thi go tiep, khach thay lien mach.
      if (i < bubbles.length - 1) tatGoPhim = batDauGoPhim(tin.threadId, tin.threadType, originToken);
    }
    if (originToken && !originConHieuLuc(originToken)) return;
    await addLog({
      event: "send_ok",
      level: "ok",
      summary: `Đã gửi ${bubbles.length} tin qua Zalo: ${bubbles[0].slice(0, 70)}`,
      detail: {
        threadId: tin.threadId,
        threadType: tin.threadType,
        soBubble: bubbles.length,
        soTinDaGom: tins.length,
        totalBubbleCount,
        sentBubbleCount,
        failedBubbleIndex: null,
        bubbles,
      },
    });

    if (originToken && !originConHieuLuc(originToken)) return;
    await thuGuiSticker(tin, originToken);
  } catch (error) {
    if (originToken && !originConHieuLuc(originToken)) return;
    console.error("[zalo] Loi AI-reply:", error);
    const laLoiMotPhan = sentBubbleCount > 0
      && sentBubbleCount < totalBubbleCount
      && failedBubbleIndex !== null;
    await addLog({
      event: "ai_error",
      level: "error",
      summary: laLoiMotPhan
        ? `Đã gửi ${sentBubbleCount}/${totalBubbleCount} phần trả lời; lỗi khi gửi phần ${failedBubbleIndex}/${totalBubbleCount}.`
        : `Gọi LLM xong nhưng KHÔNG gửi được qua Zalo — ${error.message}`,
      detail: {
        threadId: tin.threadId,
        reply: aiReply,
        error: error.message,
        totalBubbleCount,
        sentBubbleCount,
        failedBubbleIndex,
      },
    });
  } finally {
    tatGoPhim();
  }
}

async function handleNewIncomingMessage(normalizedMsg) {
  // Giu signature cu cho cac caller/tokenless harness; listener production truyen
  // immutable origin o doi so thu hai de no song qua moi await ben duoi.
  const originToken = arguments[1] || null;
  const guiTheoOrigin = (payload, internalOptions) => sendChatMessage({ ...payload, originToken }, internalOptions);
  const guiRiengTheoOrigin = (payload) => sendResolvedPrivateMessage(payload, {
    ownerUid: originToken?.originOwnerUid || chuHienTai(),
    canonicalSend: guiTheoOrigin,
    originToken,
  });
  const processedMsg = await persistAndBroadcastMessage(normalizedMsg, originToken);
  if (!processedMsg) return;
  if (originToken && !originConHieuLuc(originToken)) return;

  if (!normalizedMsg.isSelf) {
    await addLog({
      event: "message_in",
      level: "info",
      summary: `Tin đến từ ${normalizedMsg.senderName || normalizedMsg.senderId || "?"}: ${String(normalizedMsg.content || "").slice(0, 80)}`,
      detail: {
        threadId: normalizedMsg.threadId,
        threadType: normalizedMsg.threadType,
        senderId: normalizedMsg.senderId,
        senderName: normalizedMsg.senderName,
        msgType: normalizedMsg.msgType,
        content: normalizedMsg.content,
      },
    });
    if (originToken && !originConHieuLuc(originToken)) return;

    // SU KIEN NHOM khong phai loi ai noi -> khong tra loi.
    // Chan o day, TRUOC ca lenh admin: mot cai bo phieu khong phai la lenh, va
    // cung khong phai cau hoi cua khach.
    if (laTinHeThong(normalizedMsg)) {
      await addLog({
        event: "bo_qua_su_kien",
        level: "info",
        summary: `Bỏ qua ${moTaSuKien(normalizedMsg)} — không phải lời ai nói`,
        detail: {
          threadId: normalizedMsg.threadId,
          msgType: normalizedMsg.msgType,
          noiDung: String(normalizedMsg.content || "").slice(0, 100),
        },
      });
      return;
    }

    // Lenh cua admin xu ly TRUOC cong tac tong: nut gat chi ngan bot tu tra loi
    // khach, con chi chu dong sai bao thi van phai lam.
    if (await laLenhAdmin(normalizedMsg)) {
      if (originToken && !originConHieuLuc(originToken)) return;
      const traLoi = await xuLyLenh(normalizedMsg, guiTheoOrigin, guiRiengTheoOrigin);
      if (originToken && !originConHieuLuc(originToken)) return;
      if (traLoi) {
        await guiTheoOrigin({
          threadId: normalizedMsg.threadId,
          threadType: normalizedMsg.threadType,
          text: traLoi,
        });
      }
      return;
    }

    // Cong tac tong: tat la KHONG tu gui bat cu thu gi cho khach, ke ca /lenh.
    // Chan o day chu khong chan sau, de log noi ro ly do thay vi im lang.
    if (!aiChat.getConfig()?.botEnabled) {
      await addLog({
        event: "bot_off",
        level: "warn",
        summary: "Bot đang TẮT — không tự trả lời tin này",
        detail: {
          threadId: normalizedMsg.threadId,
          senderName: normalizedMsg.senderName,
          content: normalizedMsg.content,
        },
      });
      return;
    }

    // Admission token chi duoc capture SAU persistence/broadcast va Bot-enabled
    // gate. No la authority rieng cho automatic-response work, khong phai runtime.
    const capturedBotEligibilityEpoch = typeof botEligibilityEpoch === "number"
      ? botEligibilityEpoch
      : 0;
    const automaticWork = Object.freeze({ originToken, capturedBotEligibilityEpoch });
    const botWorkConHieuLuc = () => typeof botEligibilityConHieuLuc !== "function"
      || botEligibilityConHieuLuc(capturedBotEligibilityEpoch);

    let handledByAutoReply = false;
    // Production listener luon co immutable origin token. Chi harness cu goi
    // thang handler moi dung chuHienTai() de giu compatibility. appState.uid la
    // seam cuoi chi cho extracted harness khong mang helper vao lexical scope.
    const tokenlessOwnerUid = typeof chuHienTai === "function"
      ? chuHienTai()
      : (typeof appState === "object" ? appState.uid : null);
    const autoReplyOwnerUid = originToken
      ? String(originToken.originOwnerUid || "").trim()
      : String(tokenlessOwnerUid || "").trim();
    if (!autoReplyOwnerUid) return;
    const rules = await getAutoReplyRules(autoReplyOwnerUid);
    if (originToken && !originConHieuLuc(originToken)) return;
    if (!botWorkConHieuLuc()) return;
    if (rules && rules.length > 0) {
      const sortedRules = [...rules].sort((a, b) => b.command.length - a.command.length);
      for (const rule of sortedRules) {
        let msgContent = normalizedMsg.content || "";
        let cmd = "/" + rule.command;

        if (rule.normalize) {
          msgContent = normalizeString(msgContent);
          cmd = normalizeString(cmd);
        }

        let matched = false;
        if (rule.match_anywhere) {
          matched = msgContent.includes(cmd);
        } else {
          matched = msgContent === cmd;
        }

        if (matched) {
          handledByAutoReply = true;
          try {
            if (!botWorkConHieuLuc()) return;
            await guiTheoOrigin({
              threadId: normalizedMsg.threadId,
              threadType: normalizedMsg.threadType,
              text: rule.reply_text,
            }, { botEligibilityEpoch: capturedBotEligibilityEpoch });
            if (originToken && !originConHieuLuc(originToken)) return;
            if (!botWorkConHieuLuc()) return;
            await addLog({
              event: "auto_reply",
              level: "ok",
              summary: `Khớp quy tắc /${rule.command} — đã gửi câu trả lời cố định`,
              detail: {
                command: rule.command,
                matchAnywhere: Boolean(rule.match_anywhere),
                normalize: Boolean(rule.normalize),
                replyText: rule.reply_text,
                content: normalizedMsg.content,
              },
            });
          } catch (error) {
            console.error("[zalo] Loi auto-reply:", error);
            await addLog({
              event: "auto_reply",
              level: "error",
              summary: `KHÔNG gửi được câu trả lời cố định cho /${rule.command}`,
              detail: {
                command: rule.command,
                matchAnywhere: Boolean(rule.match_anywhere),
                normalize: Boolean(rule.normalize),
                content: normalizedMsg.content,
                error: error.message,
              },
            });
          }
          break;
        }
      }
    }

    if (!handledByAutoReply && typeof normalizedMsg.content === "string" && normalizedMsg.content.trim()) {
      // TRONG NHOM: mac dinh IM. Chi noi khi co nguoi tag dich danh, hoac khi
      // chinh nguoi do vua tag xong va dang ke tiep (cua so gom con mo).
      const laNhom = Number(normalizedMsg.threadType) === Number(ThreadType.Group);
      if (laNhom) {
        const duocGoi = botDuocGoi(normalizedMsg, appState.uid);
        const dangKeTiep = boGom.dangMo(normalizedMsg.threadId, normalizedMsg.senderId);
        if (!duocGoi && !dangKeTiep) return; // khong ai goi -> khong noi
        if (duocGoi && !dangKeTiep) {
          await addLog({
            event: "duoc_tag",
            level: "info",
            summary: `${normalizedMsg.senderName || "Ai đó"} gọi bot trong nhóm — bắt đầu gom câu hỏi`,
            detail: { threadId: normalizedMsg.threadId, senderName: normalizedMsg.senderName },
          });
        }
      }
      if (originToken && !originConHieuLuc(originToken)) return;
      if (!botWorkConHieuLuc()) return;
      boGom.them(normalizedMsg, automaticWork);
    }
  }
}

/**
 * Uid cua tai khoan Zalo dang dang nhap. Moi thao tac cham vao du lieu cuoc tro
 * chuyen deu phai di qua day. Chua dang nhap -> null -> ben goi phai dung lai.
 */
export function chuHienTai() {
  return appState.uid ? String(appState.uid) : null;
}

export async function persistAndBroadcastMessage(message, originToken = null) {
  const confirmedOutboundAuthority = arguments[2]?.confirmedOutboundAuthority;
  const dungConfirmedOutboundAuthority = Boolean(
    confirmedOutboundAuthority?.[CONFIRMED_OUTBOUND_AUTHORITY]
    && String(confirmedOutboundAuthority.threadId) === String(message?.threadId)
  );
  const originHopLe = () => dungConfirmedOutboundAuthority
    || !originToken
    || originConHieuLuc(originToken);
  if (!originHopLe()) return null;

  const laDinhKemCanonical = ["chat.photo", "share.file"].includes(String(message?.msgType || ""))
    && Boolean(message?.rawJson?.data?.content ?? message?.rawJson?.content);
  if (!message.threadId || (!message.content && !laDinhKemCanonical)) return null;
  const chu = dungConfirmedOutboundAuthority
    ? String(confirmedOutboundAuthority.ownerUid || "").trim()
    : chuHienTai();
  const originApi = dungConfirmedOutboundAuthority
    ? confirmedOutboundAuthority.originApiIdentity
    : api;
  // Chua ro tai khoan thi KHONG ghi. Du lieu song khong bao gio duoc gan nhan
  // "unknown" - nhan do chi danh cho lich su cu khong the truy nguon.
  if (!chu) return null;
  const meta = await resolveThreadMeta(originApi, message.threadId, message.threadType, { ownerUid: chu });
  if (!originHopLe()) return null;
  let thread = await upsertThread(chu, {
    id: message.threadId,
    threadType: message.threadType,
    title: meta.title,
    avatar: meta.avatar,
    lastMessage: message.content,
    lastMessageAt: message.ts,
  });
  if (!originHopLe()) return null;
  message.senderAvatar = await resolveSenderAvatar(originApi, message, thread);
  if (!originHopLe()) return null;
  const result = await insertMessage(chu, message);
  if (!originHopLe()) return null;
  if (result?.changes === 0) return null; // da ton tai trong db
  thread = await getThread(chu, message.threadId);
  if (!originHopLe()) return null;

  // Narrow V1 exception: provider da gui thanh cong bang A, nhung runtime A da
  // stale. Ghi ben vung duoi A, tuyet doi khong phat socket global sang UI cua B.
  if (dungConfirmedOutboundAuthority) return message;

  const broadcast = await enrichMessageSticker(originApi, message);
  if (!originHopLe()) return null;
  io?.emit("new-message", broadcast);
  io?.emit("thread-refresh", thread);
  await emitThreads(originToken);
  return broadcast;
}

export async function getMessagesForThread(threadId) {
  const chu = chuHienTai();
  // Khong co tai khoan dang dang nhap thi khong doc lich su cua bat ky ai.
  if (!chu) return { messages: [], myAvatar: null };
  const thread = await getThread(chu, threadId);
  // Cuoc tro chuyen khong thuoc tai khoan nay -> coi nhu khong ton tai.
  if (!thread) return { messages: [], myAvatar: appState.myAvatar };
  if (appState.loggedIn) {
    await syncHistoryForThread(api, chu, threadId, thread.threadType);
  }
  const messages = await getThreadMessages(chu, threadId, 500);
  return {
    messages: api ? await enrichMessagesForDisplay(api, messages, thread, appState.myAvatar) : messages,
    myAvatar: appState.myAvatar,
  };
}

/**
 * Chan ruot gan cua bot lot ra ngoai. Da tung xay ra that trong nhom Admin AI:
 *    [tool_call: glob for pattern '...']
 *    [tool_call: bash for 'ls -F']
 * Khach nhin thay may dong do thi biet ngay dang noi chuyen voi may. Chot chan
 * dat ngay trong sendChatMessage - moi duong gui tin deu di qua day, khong sot.
 */
async function locTruocKhiGui(text, threadId) {
  const { sach, daCat, soDongCat } = locRuotGan(text);
  if (!daCat) return sach;

  await addLog({
    event: "chan_ruot_gan",
    level: "warn",
    summary: sach
      ? `Đã cắt ${soDongCat} dòng nội bộ của bot trước khi gửi`
      : "Chặn hẳn một tin chỉ toàn nội bộ của bot",
    detail: { threadId, goc: String(text).slice(0, 400), conLai: sach.slice(0, 400) },
  }).catch(() => {});

  return sach;
}

/**
 * @param {object} p
 * @param {object} [p.quote]   du lieu tin GOC cua khach, de tra loi kem trich dan
 * @param {Array}  [p.mentions] [{pos,uid,len}] - vi tri @nhac ten trong text
 * @param {number} [p.urgency] 0 thuong, 1 quan trong, 2 khan
 */
export async function sendChatMessage({ threadId, text, threadType, quote, mentions, urgency, attachment, originToken }) {
  const internalOptions = arguments[1] || {};
  const capturedRuntimeAuthority = internalOptions.capturedRuntimeAuthority || null;
  const capturedBotEligibilityEpoch = internalOptions.botEligibilityEpoch;
  const sendAuthority = capturedRuntimeAuthority || originToken || null;
  const strictCapturedAuthority = Boolean(capturedRuntimeAuthority);
  const botEligibilityBatBuoc = Number.isInteger(capturedBotEligibilityEpoch);
  const authorityConHieuLuc = () => !sendAuthority || originConHieuLuc(sendAuthority);
  const botWorkConHieuLuc = () => !botEligibilityBatBuoc
    || botEligibilityConHieuLuc(capturedBotEligibilityEpoch);
  const revalidateBeforeSend = () => {
    if (!botWorkConHieuLuc()) return false;
    if (authorityConHieuLuc()) return true;
    if (strictCapturedAuthority) {
      throw new Error("Phiên Zalo đã thay đổi trước khi gửi. Tin chưa được gửi; vui lòng thử lại.");
    }
    return false;
  };

  if (!revalidateBeforeSend()) return null;
  if (!api || !appState.loggedIn) throw new Error("Chua dang nhap Zalo.");

  // ===== CHOT CHAN QUYEN SO HUU =====
  // Phai chan TRUOC khi goi Zalo. Truoc day threadId di thang tu trinh duyet vao
  // api.sendMessage, nen chon mot cuoc tro chuyen cu cua TAI KHOAN KHAC roi bam
  // Gui la tin bay that sang do - bang phien cua tai khoan dang dang nhap.
  // Voi chat 1-1, threadId chinh la uid nguoi kia, nen viec gui gan nhu chac chan
  // THANH CONG: nhan cho mot nguoi chua bao gio noi chuyen voi tai khoan nay.
  const chuGui = sendAuthority?.originOwnerUid || chuHienTai();
  if (!chuGui) throw new Error("Chua ro tai khoan Zalo dang dang nhap - khong gui.");
  if (!threadId) throw new Error("Thieu cuoc chat hoac noi dung.");
  const threadCuaToi = await getThread(chuGui, threadId);
  if (!revalidateBeforeSend()) return null;
  if (!threadCuaToi) {
    throw new Error(
      "Cuoc tro chuyen nay khong thuoc tai khoan Zalo dang dang nhap. " +
        "Khong gui de tranh nhan nham bang tai khoan khac."
    );
  }

  const cleanText = await locTruocKhiGui(String(text || "").trim(), threadId);
  if (!revalidateBeforeSend()) return null;
  const nguonDinhKem = attachment ? taoNguonDinhKemZalo(attachment) : null;
  if (!cleanText && !nguonDinhKem) throw new Error("Thieu cuoc chat hoac noi dung.");
  const numericThreadType = Number(threadType ?? ThreadType.User);

  // Truoc day luon gui chuoi tran nen mat sach quote/mention/urgency. Chi dung
  // dang object khi THAT SU can, de duong gui thong thuong khong doi hanh vi.
  const coThemGi = quote || (mentions && mentions.length) || (urgency && urgency > 0);

  // Tin chu yeu la mot duong link -> gui dang the co anh xem truoc.
  // sendLink KHONG nhan quote/mention/urgency, nen chi dung khi khong can may
  // thu do. Trong nhom thi trich dan quan trong hon anh xem truoc.
  const link = coThemGi ? null : timLinkChinh(cleanText);
  let ketQuaGui;
  // Atomic boundary: sau check nay provider call bat dau dong bo trong cung turn.
  if (!revalidateBeforeSend()) return null;
  const confirmedOutboundAuthority = sendAuthority
    ? Object.freeze({
        [CONFIRMED_OUTBOUND_AUTHORITY]: true,
        ownerUid: String(chuGui),
        threadId: String(threadId),
        threadType: Number(threadType ?? ThreadType.User),
        originApiIdentity: sendAuthority.originApiIdentity,
        senderId: String(sendAuthority.originOwnerUid || chuGui),
        senderName: sendAuthority.originDisplayName ?? null,
        senderAvatar: sendAuthority.originAvatar ?? null,
      })
    : null;
  if (nguonDinhKem) {
    ketQuaGui = await api.sendMessage(
      {
        msg: cleanText,
        attachments: nguonDinhKem,
        ...(quote ? { quote } : {}),
        ...(mentions?.length ? { mentions } : {}),
        ...(urgency && urgency > 0 ? { urgency } : {}),
      },
      threadId,
      numericThreadType
    );
  } else if (link) {
    ketQuaGui = await api.sendLink(
      { link: link.duongDan, ...(link.loiNhan ? { msg: link.loiNhan } : {}) },
      threadId,
      numericThreadType
    );
  } else if (coThemGi) {
    ketQuaGui = await api.sendMessage(
      {
        msg: cleanText,
        ...(quote ? { quote } : {}),
        ...(mentions?.length ? { mentions } : {}),
        ...(urgency && urgency > 0 ? { urgency } : {}),
      },
      threadId,
      numericThreadType
    );
  } else {
    ketQuaGui = await api.sendMessage(cleanText, threadId, numericThreadType);
  }
  const runtimeConHieuLucSauSend = authorityConHieuLuc();

  // Lay msgId THAT do Zalo cap. Hai ham tra ve hai hinh dang khac nhau
  // (zca-js 2.1.2):
  //   sendMessage -> { message: { msgId: number } | null, attachment: [...] }
  //   sendLink    -> { msgId: string }
  // Voi media, response attachment chi co msgId, khong co URL provider. Khong
  // ghi ban media thieu href vao DB vi no se chan ban echo day du sau do. Neu
  // provider tach text + file thanh hai tin, chi ghi tin text o day; tin file
  // van cho listener canonical tra ve.
  const msgIdThat = nguonDinhKem
    ? ketQuaGui?.message?.msgId ?? null
    : layMsgIdTuKetQuaGui(ketQuaGui);

  // KHONG CON tu bia id kieu `self-<thread>-<ts>`.
  //
  // Vi sao: sau khi gui, Zalo DOI LAI chinh tin do qua listener kem msgId that.
  // Id tu bia khac msgId that -> khoa (thread_id, id) khong nhan ra la mot ->
  // luu thanh HAI dong va ban ra HAI su kien socket. Nguoi dung thay bot tra loi
  // hai lan, trong khi thuc te chi gui dung mot lan. Danh tinh cua tin nhan phai
  // do provider quyet dinh, khong phai app tu dat.
  if (!msgIdThat) {
    // Khong lay duoc msgId (vd Zalo tra message: null). Tha CHAM con hon TRUNG:
    // khong ghi gi ca, de tin doi lai tao ban ghi chuan. Cham hon vai tram ms.
    await addLog({
      event: nguonDinhKem ? "gui_media_cho_tin_doi_lai" : "gui_khong_co_msgid",
      level: "warn",
      summary: nguonDinhKem
        ? "Đã gửi media — chờ Zalo trả bản có URL để ghi"
        : "Zalo khong tra msgId cho tin vua gui — cho tin doi lai de ghi",
      detail: {
        threadId,
        threadType: numericThreadType,
        ...(nguonDinhKem ? { filename: nguonDinhKem.filename } : {}),
      },
    }).catch(() => {});
    return null;
  }

  const message = {
    id: String(msgIdThat),
    threadId,
    threadType: numericThreadType,
    content: cleanText,
    isSelf: true,
    senderId: sendAuthority?.originOwnerUid || appState.uid,
    senderName: sendAuthority ? (sendAuthority.originDisplayName ?? null) : appState.displayName,
    senderAvatar: sendAuthority ? (sendAuthority.originAvatar ?? null) : appState.myAvatar,
    msgType: "text",
    ts: normalizeTs(Date.now()),
    rawJson: null,
  };

  // Dung CHUNG duong ghi voi tin den. persistAndBroadcastMessage tra ve null khi
  // ban ghi da ton tai (changes === 0) va khi do KHONG ban socket lan nua, nen
  // an toan voi ca hai thu tu dua:
  //   - ghi tai cho truoc, tin doi lai den sau  -> lan hai bi bo qua
  //   - tin doi lai den truoc, ghi tai cho sau  -> lan hai bi bo qua
  let daPhat = runtimeConHieuLucSauSend
    ? await persistAndBroadcastMessage(message, sendAuthority)
    : await persistAndBroadcastMessage(message, null, { confirmedOutboundAuthority });
  // A co the stale trong mot await BEN TRONG canonical persistence (sau khi
  // post-send check con current). Khi do canonical path fail-closed; chay lai
  // narrow override de khong lam mat tin provider da gui thanh cong.
  if (!daPhat && sendAuthority && !authorityConHieuLuc()) {
    daPhat = await persistAndBroadcastMessage(message, null, { confirmedOutboundAuthority });
  }
  return daPhat || message;
}

/**
 * Gui dung mot tin rieng toi UID da duoc findUser resolve.
 * Dang ky thread theo dung owner hien tai, sau do van di qua sendChatMessage.
 * Tham so thu hai chi la seam hep de test khong cham provider.
 */
export async function sendResolvedPrivateMessage(
  { uid, displayName, avatar, text },
  {
    ownerUid = chuHienTai(),
    registerThread = upsertThread,
    canonicalSend = sendChatMessage,
    originToken = null,
  } = {}
) {
  const resolvedUid = String(uid || "").trim();
  const cleanText = String(text || "").trim();
  const currentOwner = ownerUid ? String(ownerUid) : null;

  if (!resolvedUid) throw new Error("Thiếu UID Zalo đã xác minh.");
  if (!cleanText) throw new Error("Thiếu nội dung tin nhắn.");
  if (!currentOwner) throw new Error("Chưa rõ tài khoản Zalo đang đăng nhập - không gửi.");
  if (originToken && !originConHieuLuc(originToken)) return null;

  await registerThread(currentOwner, {
    id: resolvedUid,
    threadType: ThreadType.User,
    title: String(displayName || resolvedUid),
    avatar: avatar || null,
  });
  if (originToken && !originConHieuLuc(originToken)) return null;

  return canonicalSend({
    threadId: resolvedUid,
    threadType: ThreadType.User,
    text: cleanText,
    ...(originToken ? { originToken } : {}),
  });
}

/**
 * Rut msgId that tu ket qua gui. Tra ve null neu provider khong cap.
 * Khong doan, khong bia: khong co id thi bao khong co.
 */
function layMsgIdTuKetQuaGui(ketQua) {
  if (!ketQua) return null;
  // sendLink: { msgId: string }
  if (ketQua.msgId !== undefined && ketQua.msgId !== null) return ketQua.msgId;
  // sendMessage: { message: { msgId: number } | null }
  if (ketQua.message?.msgId !== undefined && ketQua.message?.msgId !== null) return ketQua.message.msgId;
  // Tin co dinh kem: lay ban ghi dau tien co msgId.
  if (Array.isArray(ketQua.attachment)) {
    const co = ketQua.attachment.find((x) => x?.msgId !== undefined && x?.msgId !== null);
    if (co) return co.msgId;
  }
  return null;
}

export async function refreshThreads() {
  // Nguoi dung bam Lam moi thi phai hoi Zalo that, khong duoc tra ban trong bo nho.
  if (api) await syncThreadCatalog(api, chuHienTai(), true);
  await rebuildThreadsFromMessages(chuHienTai());
  const threads = await listThreads(chuHienTai(), { recentOnly: true });
  io?.emit("threads", threads);
  return threads;
}

export async function ensureThreadMeta(threadId, threadType) {
  if (!api) return getThread(chuHienTai(), threadId);
  return enrichExistingThread(api, chuHienTai(), threadId, threadType);
}

export async function emitThreads(originToken = null) {
  if (originToken && !originConHieuLuc(originToken)) return;
  const threads = await listThreads(chuHienTai(), { recentOnly: true });
  if (originToken && !originConHieuLuc(originToken)) return;
  io?.emit("threads", threads);
}

export function emitState() {
  io?.emit("state", getPublicState());
}

function setQrState(status, message) {
  appState.qr = { status, image: null, message, scannedName: null };
}

function normalizeString(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export function isLoggedIn() {
  return appState.loggedIn;
}

export async function listGroups() {
  if (!api) throw new Error("Chưa đăng nhập");
  const allGroups = await api.getAllGroups();
  const groupIds = Object.keys(allGroups?.gridVerMap || {});
  
  const groups = [];
  // chunk by 25
  for (let i = 0; i < groupIds.length; i += 25) {
    const chunk = groupIds.slice(i, i + 25);
    try {
      const info = await api.getGroupInfo(chunk);
      // zca-js tra ve { gridInfoMap: { [groupId]: {...} } }, khong phai map phang.
      const infoMap = info?.gridInfoMap || {};
      for (const id of chunk) {
        if (infoMap[id]) {
          groups.push({ id, name: infoMap[id].name || id });
        }
      }
    } catch (e) {
      console.warn("[zalo] getGroupInfo chunk lỗi:", e.message);
    }
  }
  
  groups.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return { groups };
}

/**
 * Tao loi nhac cua chinh Zalo trong mot cuoc tro chuyen.
 * Khac lich hen cua app: Zalo day thong bao cho moi thanh vien va giu the nhac
 * lai trong nhom, chu khong chi la mot tin nhan troi qua.
 */
export async function taoNhacZalo({ threadId, threadType, tieuDe, lucGui, maLap }) {
  if (!api?.createReminder) throw new Error("Chưa đăng nhập Zalo.");
  return api.createReminder(
    {
      title: String(tieuDe),
      emoji: "⏰",
      startTime: Number(lucGui) * 1000, // Zalo dung mili giay
      repeat: Number(maLap) || 0,
    },
    String(threadId),
    Number(threadType)
  );
}

/* --- DUYET NGUOI XIN VAO NHOM --- */

/** Ma ket qua Zalo tra ve khi duyet. */
const LY_DO_DUYET = {
  0: "xong",
  170: "không còn trong danh sách chờ",
  178: "đã ở trong nhóm rồi",
  166: "bot không đủ quyền — cần là trưởng hoặc phó nhóm",
};

/**
 * Bot phai la TRUONG hoac PHO nhom moi lam duoc. Kiem truoc va bao ro, khong
 * thi Zalo chi tra ve "Tham so khong hop le" - doc xong khong biet duong sua.
 */
async function kiemQuyenNhom(groupId) {
  const info = (await api.getGroupInfo(groupId))?.gridInfoMap?.[groupId];
  if (!info) throw new Error("Không đọc được thông tin nhóm.");
  const toi = String(api.getOwnId());
  const laTruong = String(info.creatorId) === toi;
  const laPho = (info.adminIds || []).map(String).includes(toi);
  return {
    duocPhep: laTruong || laPho,
    vaiTro: laTruong ? "trưởng nhóm" : laPho ? "phó nhóm" : "thành viên thường",
    batDuyet: Number(info?.setting?.joinAppr) === 1,
    tenNhom: info.name || "",
  };
}

export async function xemNguoiChoDuyet(groupId) {
  if (!api?.getPendingGroupMembers) throw new Error("Chưa đăng nhập Zalo.");

  const quyen = await kiemQuyenNhom(groupId);
  if (!quyen.duocPhep) {
    throw new Error(
      `Bot đang là ${quyen.vaiTro} trong nhóm này nên không xem được danh sách chờ. ` +
        `Chị vào Zalo, mục Thành viên, đặt nick bot làm PHÓ NHÓM giúp em.`
    );
  }
  if (!quyen.batDuyet) {
    throw new Error(
      `Nhóm này chưa bật "Duyệt thành viên mới" nên không có ai phải chờ duyệt cả. ` +
        `Chị bật trong Cài đặt nhóm nếu muốn dùng.`
    );
  }

  const r = await api.getPendingGroupMembers(String(groupId));
  return (r?.users || []).map((u) => ({ uid: String(u.uid), ten: u.dpn || "", anh: u.avatar || null }));
}

export async function duyetNguoiVaoNhom(groupId, uids, dongY) {
  if (!api?.reviewPendingMemberRequest) throw new Error("Chưa đăng nhập Zalo.");

  const quyen = await kiemQuyenNhom(groupId);
  if (!quyen.duocPhep) {
    throw new Error(`Bot đang là ${quyen.vaiTro} nên không duyệt được. Chị đặt nick bot làm PHÓ NHÓM giúp em.`);
  }

  const ds = Array.isArray(uids) ? uids.map(String) : [String(uids)];
  const kq = await api.reviewPendingMemberRequest({ members: ds, isApprove: Boolean(dongY) }, String(groupId));

  return ds.map((uid) => {
    const ma = Number(kq?.[uid]);
    return { uid, ma, moTa: LY_DO_DUYET[ma] || `mã ${ma}`, xong: ma === 0 };
  });
}

/* --- THEM / XOA NGUOI KHOI NHOM --- */

/** Ma loi Zalo tra ve trong error_data khi them nguoi vao nhom. */
const LY_DO_THEM = {
  178: "đã ở trong nhóm rồi",
  170: "người này không cho thêm vào nhóm",
};

/**
 * Danh sach thanh vien that cua nhom. Can cho viec xoa nguoi: nguoi trong nhom
 * chua chac da tung nhan tin voi bot, nen khong tim ra trong danh sach hoi thoai.
 */
export async function xemThanhVienNhom(groupId) {
  if (!api?.getGroupInfo) throw new Error("Chưa đăng nhập Zalo.");

  const info = (await api.getGroupInfo(String(groupId)))?.gridInfoMap?.[String(groupId)];
  if (!info) throw new Error("Không đọc được thông tin nhóm.");

  const ma = info.memVerList || [];
  if (!ma.length) return [];

  const r = await api.getGroupMembersInfo(ma);
  return Object.values(r?.profiles || {}).map((p) => ({
    uid: String(p.id),
    ten: p.displayName || p.zaloName || "",
  }));
}

export async function themNguoiVaoNhom(groupId, uids) {
  if (!api?.addUserToGroup) throw new Error("Chưa đăng nhập Zalo.");

  const quyen = await kiemQuyenNhom(groupId);
  if (!quyen.duocPhep) {
    throw new Error(`Bot đang là ${quyen.vaiTro} nên không thêm người được. Chị đặt nick bot làm PHÓ NHÓM giúp em.`);
  }

  const ds = [...new Set((Array.isArray(uids) ? uids : [uids]).map(String).filter(Boolean))];
  if (!ds.length) throw new Error("Chưa có ai để thêm.");

  const kq = await api.addUserToGroup(ds, String(groupId));
  const hong = (kq?.errorMembers || []).map(String);

  // error_data dang { "<ma loi>": ["<uid>", ...] } - lat nguoc lai de tra ma theo uid.
  const maTheoUid = new Map();
  for (const [ma, ds2] of Object.entries(kq?.error_data || {})) {
    for (const u of Array.isArray(ds2) ? ds2 : []) maTheoUid.set(String(u), Number(ma));
  }

  return ds.map((uid) => {
    const xong = !hong.includes(uid);
    const ma = maTheoUid.get(uid);
    return { uid, xong, moTa: xong ? "xong" : LY_DO_THEM[ma] || (ma ? `mã ${ma}` : "không rõ lý do") };
  });
}

export async function xoaNguoiKhoiNhom(groupId, uids) {
  if (!api?.removeUserFromGroup) throw new Error("Chưa đăng nhập Zalo.");

  const quyen = await kiemQuyenNhom(groupId);
  if (!quyen.duocPhep) {
    throw new Error(`Bot đang là ${quyen.vaiTro} nên không xoá người được. Chị đặt nick bot làm PHÓ NHÓM giúp em.`);
  }

  const ds = [...new Set((Array.isArray(uids) ? uids : [uids]).map(String).filter(Boolean))];
  if (!ds.length) throw new Error("Chưa có ai để xoá.");

  const toi = String(api.getOwnId());
  if (ds.includes(toi)) throw new Error("Em không tự xoá mình khỏi nhóm được ạ.");

  // Zalo khong tra ve errorMembers khi uid khong con trong nhom - no nem han loi
  // "Tham so khong hop le", doc xong khong hieu gi. Dich lai cho de hieu.
  let kq;
  try {
    kq = await api.removeUserFromGroup(ds, String(groupId));
  } catch (error) {
    if (/tham số không hợp lệ/i.test(error.message || "")) {
      throw new Error("Zalo không nhận — có thể người đó vừa rời nhóm rồi. Chị xem lại danh sách thành viên giúp em.");
    }
    throw error;
  }

  const hong = (kq?.errorMembers || []).map(String);
  return ds.map((uid) => ({ uid, xong: !hong.includes(uid) }));
}

/* --- NHAN HOI THOAI --- */

/** Mau cho nhan moi, lay theo bang mau san co cua Zalo. */
const MAU_NHAN = ["#d91b1b", "#f31bc8", "#ff6905", "#fac000", "#4bc377", "#0068ff", "#8b5cf6", "#06b6d4"];

export async function xemNhanZalo() {
  if (!api?.getLabels) throw new Error("Chưa đăng nhập Zalo.");
  const r = await api.getLabels();
  return {
    version: r?.version ?? 0,
    nhan: (r?.labelData || []).map((l) => ({
      id: l.id,
      ten: l.text,
      mau: l.color,
      soHoiThoai: (l.conversations || []).length,
      hoiThoai: (l.conversations || []).map(String),
    })),
  };
}

/**
 * Zalo KHONG co API sua mot nhan - updateLabels GHI DE CA DANH SACH. Gui thieu
 * mot nhan la nhan do bien mat khoi may chi. Vi vay luon doc het -> sua -> ghi
 * lai het, va tuyet doi khong ghi khi doc ve rong.
 */
async function ghiNhan(bienDoi, moTaViec) {
  if (!api?.getLabels || !api?.updateLabels) throw new Error("Chưa đăng nhập Zalo.");

  const cu = await api.getLabels();
  const danhSachCu = cu?.labelData;
  if (!Array.isArray(danhSachCu)) throw new Error("Không đọc được danh sách nhãn hiện tại, em không dám ghi đè.");

  // Ban sao nguyen ven de neu ghi hong con biet duong khoi phuc.
  await addLog({
    event: "nhan_sao_luu",
    level: "info",
    summary: `Sao lưu ${danhSachCu.length} nhãn trước khi ${moTaViec}`,
    detail: { version: cu.version, labelData: danhSachCu },
  }).catch(() => {});

  const moi = bienDoi(JSON.parse(JSON.stringify(danhSachCu)));
  if (!Array.isArray(moi) || moi.length < danhSachCu.length) {
    throw new Error("Danh sách nhãn mới bị hụt so với cũ — em dừng lại cho an toàn.");
  }

  const kq = await api.updateLabels({ labelData: moi, version: cu.version });
  return { version: kq?.version, nhan: kq?.labelData || moi };
}

function timNhan(danhSach, ten) {
  const can = String(ten || "").trim().toLowerCase();
  return danhSach.find((l) => String(l.text || "").trim().toLowerCase() === can) || null;
}

export async function ganNhanZalo(tenNhan, threadId) {
  const ten = String(tenNhan || "").trim();
  const id = String(threadId || "");
  if (!ten || !id) throw new Error("Thiếu tên nhãn hoặc hội thoại.");

  let daCo = false;
  let laNhanMoi = false;

  await ghiNhan((ds) => {
    let nhan = timNhan(ds, ten);
    if (!nhan) {
      laNhanMoi = true;
      const idMax = ds.reduce((m, l) => Math.max(m, Number(l.id) || 0), 0);
      const offMax = ds.reduce((m, l) => Math.max(m, Number(l.offset) || 0), 0);
      nhan = {
        id: idMax + 1,
        text: ten,
        textKey: "",
        conversations: [],
        color: MAU_NHAN[(idMax + 1) % MAU_NHAN.length],
        offset: offMax + 1,
        emoji: "",
        createTime: Date.now(),
      };
      ds.push(nhan);
    }
    nhan.conversations = (nhan.conversations || []).map(String);
    if (nhan.conversations.includes(id)) daCo = true;
    else nhan.conversations.push(id);
    return ds;
  }, `gắn nhãn "${ten}"`);

  return { ten, daCo, laNhanMoi };
}

export async function boNhanZalo(tenNhan, threadId) {
  const ten = String(tenNhan || "").trim();
  const id = String(threadId || "");
  if (!ten || !id) throw new Error("Thiếu tên nhãn hoặc hội thoại.");

  let coNhan = false;
  let coGan = false;

  await ghiNhan((ds) => {
    const nhan = timNhan(ds, ten);
    if (!nhan) return ds;
    coNhan = true;
    const truoc = (nhan.conversations || []).map(String);
    nhan.conversations = truoc.filter((c) => c !== id);
    coGan = truoc.length !== nhan.conversations.length;
    return ds;
  }, `bỏ nhãn "${ten}"`);

  if (!coNhan) throw new Error(`Chưa có nhãn nào tên 「${ten}」 ạ.`);
  return { ten, coGan };
}

/* --- DOI TEN NHOM --- */

export async function doiTenNhomZalo(groupId, tenMoi) {
  if (!api?.changeGroupName) throw new Error("Chưa đăng nhập Zalo.");

  const ten = String(tenMoi || "").trim();
  if (!ten) throw new Error("Chưa có tên mới.");

  const quyen = await kiemQuyenNhom(groupId);
  if (!quyen.duocPhep) {
    throw new Error(`Bot đang là ${quyen.vaiTro} nên không đổi tên nhóm được. Chị đặt nick bot làm PHÓ NHÓM giúp em.`);
  }
  if (quyen.tenNhom === ten) throw new Error("Nhóm đang mang đúng tên đó rồi ạ.");

  await api.changeGroupName(ten, String(groupId));
  return { tenCu: quyen.tenNhom, tenMoi: ten };
}

/* --- TAO NHOM MOI --- */

/**
 * Tao nhom moi. Nguoi goi createGroup se la TRUONG NHOM - o day la nick bot,
 * khong phai chi. Nen sau khi tao thi chuyen quyen truong nhom cho admin.
 *
 * Chuyen xong thi bot con quyen gi trong nhom la do Zalo quyet, khong phai minh.
 * Vi vay doc lai vai tro that bang getGroupInfo roi bao ve cho admin biet, chu
 * khong doan bua - neu bot tut xuong thanh vien thuong thi ham duyet nguoi vao
 * nhom se khong chay duoc nua.
 */
export async function taoNhomZalo({ ten, uids, chuyenTruongCho }) {
  if (!api?.createGroup) throw new Error("Chưa đăng nhập Zalo.");

  const ds = [...new Set((uids || []).map(String).filter(Boolean))];
  if (!ds.length) throw new Error("Chưa có ai để thêm vào nhóm.");

  const kq = await api.createGroup({ name: String(ten || "").trim() || undefined, members: ds });
  const groupId = String(kq?.groupId || "");
  if (!groupId) throw new Error("Zalo không trả về mã nhóm.");

  const vaoDuoc = (kq?.sucessMembers || []).map(String);
  const hong = (kq?.errorMembers || []).map(String);

  let chuyenTruong = null;
  if (chuyenTruongCho) {
    const nhan = String(chuyenTruongCho);
    if (!vaoDuoc.includes(nhan)) {
      chuyenTruong = { xong: false, moTa: "người nhận quyền chưa vào được nhóm" };
    } else {
      try {
        await api.changeGroupOwner(nhan, groupId);
        chuyenTruong = { xong: true };
      } catch (error) {
        chuyenTruong = { xong: false, moTa: error.message };
      }
    }
  }

  let vaiTroBot = null;
  try {
    vaiTroBot = (await kiemQuyenNhom(groupId)).vaiTro;
  } catch {
    // Doc khong duoc thi thoi, khong lam hong viec da tao xong.
  }

  return { groupId, vaoDuoc, hong, chuyenTruong, vaiTroBot };
}

/* --- TIM NGUOI THEO SO DIEN THOAI --- */

/**
 * Zalo co the khoa tai khoan neu thay tra so hang loat - dau hieu cua cong cu
 * quet danh ba. Chan o phia minh truoc khi Zalo phai chan.
 */
const TRA_SO_MOI_GIO = 20;
const lichSuTraSo = new Map();

export function conLuotTraSo(ownerUid = chuHienTai()) {
  const chu = String(ownerUid || "").trim();
  if (!chu) return 0;
  const lichSu = lichSuTraSo.get(chu) || [];
  const mocMotGio = Date.now() - 60 * 60 * 1000;
  while (lichSu.length && lichSu[0] < mocMotGio) lichSu.shift();
  if (lichSu.length) lichSuTraSo.set(chu, lichSu);
  else lichSuTraSo.delete(chu);
  return TRA_SO_MOI_GIO - lichSu.length;
}

/** Chuan hoa so Viet Nam: 0901..., +84901..., 84901... -> 84901... */
export function chuanHoaSo(so) {
  const s = String(so || "").replace(/[^\d+]/g, "");
  if (/^0\d{9}$/.test(s)) return "84" + s.slice(1);
  if (/^\+84\d{9}$/.test(s)) return s.slice(1);
  if (/^84\d{9}$/.test(s)) return s;
  return null;
}

export async function timNguoiTheoSo(soDienThoai) {
  // Kiem dinh dang TRUOC khi kiem dang nhap: so sai thi sai bat ke tinh trang
  // ket noi, va bao dung ly do thi chi con biet duong sua.
  const so = chuanHoaSo(soDienThoai);
  if (!so) throw new Error("Số điện thoại không đúng định dạng Việt Nam (10 số, bắt đầu bằng 0).");

  if (!api?.findUser) throw new Error("Chưa đăng nhập Zalo.");
  const ownerUid = chuHienTai();
  if (!ownerUid) throw new Error("Chưa đăng nhập Zalo.");

  if (conLuotTraSo(ownerUid) <= 0) {
    throw new Error(`Đã tra ${TRA_SO_MOI_GIO} số trong 1 giờ. Nghỉ một lát rồi tra tiếp, tránh Zalo khoá tài khoản.`);
  }
  const lichSu = lichSuTraSo.get(ownerUid) || [];
  lichSu.push(Date.now());
  lichSuTraSo.set(ownerUid, lichSu);

  const u = await api.findUser(so);
  const displayName = u?.display_name || u?.displayName || u?.zalo_name || u?.zaloName || "";
  return {
    uid: String(u?.uid || u?.userId || ""),
    display_name: u?.display_name || u?.displayName || "",
    zalo_name: u?.zalo_name || u?.zaloName || "",
    ten: displayName,
    anh: u?.avatar || null,
    phone: so,
  };
}

/**
 * Ghim mot ghi chu len dau nhom (bang tin cua nhom).
 * LUU Y: thu vien KHONG co ham xoa ghi chu - tao roi chi sua duoc, muon bo thi
 * phai vao Zalo xoa tay. Nen buoc xac nhan truoc khi tao la bat buoc.
 */
export async function taoGhiChuZalo({ groupId, noiDung, ghim }) {
  if (!api?.createNote) throw new Error("Chưa đăng nhập Zalo.");
  const r = await api.createNote({ title: String(noiDung), pinAct: ghim !== false }, String(groupId));
  return { id: String(r.id ?? "") };
}

/* --- BINH CHON --- */

export async function taoBinhChonZalo({ groupId, cauHoi, luaChon, nhieuLuaChon, choThemLuaChon, anDanh, hetHan }) {
  if (!api?.createPoll) throw new Error("Chưa đăng nhập Zalo.");
  const r = await api.createPoll(
    {
      question: String(cauHoi),
      options: luaChon.map(String),
      expiredTime: Number(hetHan) || 0, // 0 = khong het han
      allowMultiChoices: Boolean(nhieuLuaChon),
      allowAddNewOption: Boolean(choThemLuaChon),
      isAnonymous: Boolean(anDanh),
    },
    String(groupId)
  );
  // Zalo tra ve poll_id (gach duoi), khong phai pollId nhu kieu du lieu khai.
  return { pollId: String(r.poll_id), luaChon: (r.options || []).map((o) => o.content) };
}

export async function docBinhChonZalo(pollId) {
  if (!api?.getPollDetail) throw new Error("Chưa đăng nhập Zalo.");
  const d = await api.getPollDetail(Number(pollId));
  return {
    cauHoi: d.question,
    daDong: Boolean(d.closed),
    tongPhieu: Number(d.num_vote) || 0,
    luaChon: (d.options || []).map((o) => ({ noiDung: o.content, phieu: Number(o.votes) || 0 })),
  };
}

export async function chotBinhChonZalo(pollId) {
  if (!api?.lockPoll) throw new Error("Chưa đăng nhập Zalo.");
  await api.lockPoll(Number(pollId));
}

export async function listGroupMembers(groupId, sourceApi = api) {
  if (!sourceApi) throw new Error("Chưa đăng nhập");
  const infoData = await sourceApi.getGroupInfo(groupId);
  const info = infoData?.gridInfoMap?.[groupId] || null;
  if (!info) throw new Error("Không lấy được thông tin nhóm");
  
  const uidSet = new Set();
  if (Array.isArray(info.currentMems)) info.currentMems.forEach(id => uidSet.add(String(id)));
  if (Array.isArray(info.memberIds)) info.memberIds.forEach(id => uidSet.add(String(id)));
  if (Array.isArray(info.memVerList)) {
    info.memVerList.forEach(item => {
      if (typeof item === 'string') {
        uidSet.add(item.replace(/_0$/, ''));
      }
    });
  }
  
  const uids = Array.from(uidSet);
  const members = [];
  
  for (let i = 0; i < uids.length; i += 50) {
    const chunk = uids.slice(i, i + 50);
    try {
      const chunkInfo = await sourceApi.getGroupMembersInfo(chunk);
      // Response la { profiles: { [uid]: {...} } }; key co the kem hau to _0 nen chuan hoa lai.
      const profiles = {};
      for (const [key, profile] of Object.entries(chunkInfo?.profiles || {})) {
        profiles[String(key).replace(/_0$/, "")] = profile;
      }
      for (const uid of chunk) {
        const uInfo = profiles[uid];
        if (uInfo) {
          members.push({
            id: uid,
            displayName: uInfo.displayName || '',
            zaloName: uInfo.zaloName || ''
          });
        } else {
          members.push({ id: uid, displayName: uid, zaloName: uid });
        }
      }
    } catch (e) {
      console.warn("[zalo] getGroupMembersInfo chunk lỗi:", e);
    }
  }
  
  return { members };
}

/* =====================================================================
 * BIEN GIOI PROVIDER CANONICAL — MESSAGING POWER PACK V1
 *
 * MOI duong goi Zalo cua ca APP lan BOT deu di qua day. Khong lop nao ben
 * tren giu tham chieu rieng toi `api`, va khong endpoint nao cho phep trinh
 * duyet chi dinh mot ham zca-js bat ky. Mot runtime Zalo, mot cong ra.
 *
 * Luat chung cua moi wrapper duoi day:
 *   - kiem quyen runtime TRUOC va SAU khi goi provider;
 *   - kiem tham so truoc khi cham mang;
 *   - KHONG tu thu lai. Mot lan bam la mot lan goi. Thu lai mot lenh da
 *     thanh cong ma phan hoi bi mat la tha them mot cai tim, thu hoi them
 *     mot lan, gui them mot tin - nguoi dung khong bao gio yeu cau viec do.
 * ===================================================================== */

/** Loi co ma on dinh cho lop API; khong bao gio lo chi tiet provider ra trinh duyet. */
function loiCoMa(code, thongDiep) {
  const loi = new Error(thongDiep);
  loi.code = code;
  return loi;
}

/**
 * Chot quyen: token chup truoc ranh gioi async phai con dung runtime hien tai.
 * A dang xuat roi B dang nhap giua chung thi hanh dong cua A KHONG duoc chay
 * tiep bang phien cua B.
 */
function chotQuyenRuntime(capturedAuthority) {
  if (!capturedAuthority) return;
  if (!originConHieuLuc(capturedAuthority)) {
    throw loiCoMa("ZALO_RUNTIME_CHANGED", "Phiên Zalo đã thay đổi — hành động chưa được thực hiện.");
  }
}

/** Runtime phai dang song VA co dung ham provider can dung. */
function chotApiSan(tenHam, capturedAuthority) {
  chotQuyenRuntime(capturedAuthority);
  if (!api || !appState.loggedIn) throw loiCoMa("PROVIDER_REJECTED", "Chưa đăng nhập Zalo.");
  if (typeof api[tenHam] !== "function") {
    throw loiCoMa("ACTION_NOT_APPLICABLE", "Phiên bản Zalo hiện tại không hỗ trợ thao tác này.");
  }
  return api;
}

/**
 * Nuot chi tiet cua provider lai o phia may chu. Thong bao provider co the kem
 * cookie, tham so da ma hoa hoac ca stack - khong dong nao duoc sang trinh duyet.
 */
function nemLoiProvider(error, viec) {
  console.warn(`[zalo] Provider tu choi ${viec}:`, error?.message || error);
  throw loiCoMa("PROVIDER_REJECTED", `Zalo không thực hiện được thao tác ${viec}.`);
}

function chotThreadType(threadType) {
  const so = Number(threadType);
  if (so !== Number(ThreadType.User) && so !== Number(ThreadType.Group)) {
    throw loiCoMa("MALFORMED_REQUEST", "Loại cuộc trò chuyện không hợp lệ.");
  }
  return so;
}

/** Danh tinh du de goi provider, lay tu du lieu may chu chu khong tu trinh duyet. */
function chotDanhTinh(identity) {
  if (!identity?.msgId || !identity?.cliMsgId) {
    throw loiCoMa("ACTION_IDENTITY_UNAVAILABLE", "Tin nhắn này chưa đủ định danh để thao tác.");
  }
  return identity;
}

/**
 * Tha / doi / go bieu tuong cam xuc.
 *
 * Provider da chung minh: tha lai dung bieu tuong cu = giu nguyen; tha bieu
 * tuong khac = thay the; NONE = go. App khong tu mo phong lai ba luat do.
 */
export async function reactToMessage({ icon, identity, threadId, threadType }, capturedAuthority = null) {
  if (typeof icon !== "string") throw loiCoMa("MALFORMED_REQUEST", "Thiếu biểu tượng cảm xúc.");
  if (!threadId) throw loiCoMa("MALFORMED_REQUEST", "Thiếu cuộc trò chuyện.");
  const kieu = chotThreadType(threadType);
  const ma = chotDanhTinh(identity);
  const ownerApi = chotApiSan("addReaction", capturedAuthority);

  let ketQua;
  try {
    ketQua = await ownerApi.addReaction(icon, {
      data: { msgId: String(ma.msgId), cliMsgId: String(ma.cliMsgId) },
      threadId: String(threadId),
      type: kieu,
    });
  } catch (error) {
    nemLoiProvider(error, "thả cảm xúc");
  }
  chotQuyenRuntime(capturedAuthority);
  return ketQua;
}

/** Danh muc sticker cong khai: CHI khoa va mo ta, khong lo id/cateId/type cua Zalo. */
export function listAppStickers() {
  return danhSachSticker().map((s) => ({ key: s.viec, moTa: s.moTa }));
}

/**
 * Gui sticker theo KHOA nghiep vu. Trinh duyet khong bao gio duoc noi id that:
 * mo id ra la mo ca kho sticker cua Zalo, trong khi UI da duyet chi co tam cai.
 */
export async function sendStickerMessage({ stickerKey, threadId, threadType }, capturedAuthority = null) {
  if (!threadId) throw loiCoMa("MALFORMED_REQUEST", "Thiếu cuộc trò chuyện.");
  const kieu = chotThreadType(threadType);
  const stk = layStickerHopLe(String(stickerKey || ""));
  if (!stk) throw loiCoMa("MALFORMED_REQUEST", "Sticker không nằm trong danh sách được phép.");
  const ownerApi = chotApiSan("sendSticker", capturedAuthority);

  let ketQua;
  try {
    ketQua = await ownerApi.sendSticker(
      { id: stk.id, cateId: stk.cateId, type: stk.type },
      String(threadId),
      kieu
    );
  } catch (error) {
    nemLoiProvider(error, "gửi sticker");
  }
  chotQuyenRuntime(capturedAuthority);
  return ketQua;
}

/**
 * Bao "dang soan tin". Best-effort: UAT provider nhan lenh nhung nguoi that
 * KHONG nhin thay dau hieu, nen khong duoc phep chan bat cu viec gi khac.
 */
export async function sendTypingSignal({ threadId, threadType }, capturedAuthority = null) {
  if (!threadId) throw loiCoMa("MALFORMED_REQUEST", "Thiếu cuộc trò chuyện.");
  const kieu = chotThreadType(threadType);
  const ownerApi = chotApiSan("sendTypingEvent", capturedAuthority);
  try {
    return await ownerApi.sendTypingEvent(String(threadId), kieu);
  } catch (error) {
    nemLoiProvider(error, "báo đang soạn tin");
  }
}

/**
 * Bao DA XEM bang dung phong bi ma zca-js 2.1.2 doi hoi.
 *
 * Duong cu truyen (threadId, threadType) vao cho tham so `messages` - Zalo nhan
 * mot chuoi thay vi mot phong bi tin nhan, nen lenh khong bao gio dung nghia.
 * Chin truong duoi day deu lay tu rawJson cua chinh tin do; thieu mot truong
 * bat buoc la dung lai chu khong bia.
 */
export async function markMessageSeen({ envelope, threadType }, capturedAuthority = null) {
  const kieu = chotThreadType(threadType);
  const ds = Array.isArray(envelope) ? envelope : [envelope];
  if (!ds.length) throw loiCoMa("MALFORMED_REQUEST", "Thiếu tin nhắn để báo đã xem.");
  const phongBi = ds.map((e) => {
    if (!e?.msgId || !e?.cliMsgId || !e?.uidFrom || !e?.idTo) {
      throw loiCoMa("ACTION_IDENTITY_UNAVAILABLE", "Tin nhắn này chưa đủ định danh để báo đã xem.");
    }
    return {
      msgId: String(e.msgId),
      cliMsgId: String(e.cliMsgId),
      uidFrom: String(e.uidFrom),
      idTo: String(e.idTo),
      msgType: String(e.msgType ?? ""),
      st: Number(e.st ?? 0),
      at: Number(e.at ?? 0),
      cmd: Number(e.cmd ?? 0),
      ts: e.ts ?? 0,
    };
  });
  const ownerApi = chotApiSan("sendSeenEvent", capturedAuthority);
  try {
    return await ownerApi.sendSeenEvent(phongBi.length === 1 ? phongBi[0] : phongBi, kieu);
  } catch (error) {
    nemLoiProvider(error, "báo đã xem");
  }
}

/**
 * Thu hoi tin cua chinh minh.
 *
 * UAT cho thay goi lai lan hai van duoc chap nhan va tin van o trang thai da
 * thu hoi, nhung day KHONG phai ly do de tu goi lai: khong co lan thu lai tu
 * dong nao trong duong nay.
 */
export async function recallMessage({ identity, threadId, threadType }, capturedAuthority = null) {
  if (!threadId) throw loiCoMa("MALFORMED_REQUEST", "Thiếu cuộc trò chuyện.");
  const kieu = chotThreadType(threadType);
  const ma = chotDanhTinh(identity);
  const ownerApi = chotApiSan("undo", capturedAuthority);
  let ketQua;
  try {
    ketQua = await ownerApi.undo(
      { msgId: String(ma.msgId), cliMsgId: String(ma.cliMsgId) },
      String(threadId),
      kieu
    );
  } catch (error) {
    nemLoiProvider(error, "thu hồi tin nhắn");
  }
  chotQuyenRuntime(capturedAuthority);
  return ketQua;
}

/**
 * Xoa tin CHI O PHIA MINH.
 *
 * onlyMe dong cung tai day. Khong tham so nao cua ham nay, va khong truong nao
 * trong than yeu cau HTTP, co the ha no xuong false. deleteMessage voi
 * onlyMe=false la xoa ca hai dau - mot cu bam nham la mat tin cua nguoi khac,
 * khong hoan tac duoc.
 */
export async function deleteMessageForSelf({ identity, threadId, threadType }, capturedAuthority = null) {
  if (!threadId) throw loiCoMa("MALFORMED_REQUEST", "Thiếu cuộc trò chuyện.");
  const kieu = chotThreadType(threadType);
  const ma = chotDanhTinh(identity);
  if (!ma.uidFrom) {
    throw loiCoMa("ACTION_IDENTITY_UNAVAILABLE", "Tin nhắn này chưa đủ định danh để xóa.");
  }
  const ownerApi = chotApiSan("deleteMessage", capturedAuthority);
  let ketQua;
  try {
    ketQua = await ownerApi.deleteMessage(
      {
        data: {
          cliMsgId: String(ma.cliMsgId),
          msgId: String(ma.msgId),
          uidFrom: String(ma.uidFrom),
        },
        threadId: String(threadId),
        type: kieu,
      },
      true
    );
  } catch (error) {
    nemLoiProvider(error, "xóa tin nhắn");
  }
  chotQuyenRuntime(capturedAuthority);
  return ketQua;
}

/**
 * Chuyen tiep NOI DUNG CHU da luu, toi DUNG MOT cuoc tro chuyen.
 *
 * V1 khong kem reference: gan reference vao la Zalo hien nhan "da chuyen tiep"
 * kem nguon, ma nguon do lay tu tin cua nguoi khac - chua duoc duyet cho V1.
 */
export async function forwardStoredMessage({ text, threadId, threadType }, capturedAuthority = null) {
  const noiDung = String(text ?? "").trim();
  if (!noiDung) throw loiCoMa("ACTION_NOT_APPLICABLE", "Chỉ chuyển tiếp được tin nhắn chữ.");
  if (!threadId) throw loiCoMa("MALFORMED_REQUEST", "Thiếu cuộc trò chuyện đích.");
  const kieu = chotThreadType(threadType);
  const ownerApi = chotApiSan("forwardMessage", capturedAuthority);

  let ketQua;
  try {
    ketQua = await ownerApi.forwardMessage({ message: noiDung }, [String(threadId)], kieu);
  } catch (error) {
    nemLoiProvider(error, "chuyển tiếp tin nhắn");
  }
  chotQuyenRuntime(capturedAuthority);
  // forwardMessage tra ve { success: [], fail: [] }. Danh sach success rong van
  // la that bai - khong duoc bao thanh cong khi Zalo chua nhan tin nao.
  if (!Array.isArray(ketQua?.success) || ketQua.success.length === 0) {
    throw loiCoMa("PROVIDER_REJECTED", "Zalo không nhận tin chuyển tiếp.");
  }
  return ketQua;
}

/**
 * Doc the xem truoc cua mot duong link. NOI BO: khong route cong khai nao goi
 * thang ham nay. Chi nhan http/https - de nguyen passthrough la mo duong cho
 * file://, ftp:// va cac lo dich khac.
 */
export async function parseMessageLink(link, capturedAuthority = null) {
  const duongDan = String(link || "").trim();
  if (!/^https?:\/\//i.test(duongDan)) {
    throw loiCoMa("MALFORMED_REQUEST", "Chỉ đọc được đường dẫn http hoặc https.");
  }
  const ownerApi = chotApiSan("parseLink", capturedAuthority);
  try {
    return await ownerApi.parseLink(duongDan);
  } catch (error) {
    nemLoiProvider(error, "đọc đường dẫn");
  }
}

/* =====================================================================
 * HANH DONG CUA NGUOI DUNG APP
 *
 * Lop nay dung giua route HTTP va bien gioi provider. No lam dung mot viec ma
 * route khong duoc phep tu lam: BIEN cai trinh duyet noi ("cuoc nay, tin nay")
 * thanh cai Zalo can (threadType, msgId, cliMsgId, uidFrom) - bang du lieu may
 * chu tu giu. Trinh duyet khong bao gio la nguon su that cho dinh danh provider.
 * ===================================================================== */

/** Kieu tin CHUYEN TIEP duoc trong V1. Media/sticker/tin da thu hoi deu ngoai vong. */
const KIEU_TIN_CHUYEN_TIEP_DUOC = new Set(["text", "chat.text", "webchat"]);

/**
 * Chi cho phep Forward khi TAT CA bang chung canonical deu noi day la tin chu.
 *
 * Tin tu gui co the duoc ghi som voi msg_type="text", roi ban echo cua Zalo
 * bo sung raw_json cho biet no that ra la anh/tep. Trong tinh huong mau thuan
 * do, cot nong hon khong duoc phep thang phong bi provider giau hon. Noi dung
 * provider dang object cung fail-closed: do la dang structured/media, khong
 * phai payload text thuan ma Forward V1 duoc phep gui lai.
 */
function laTinChuChuyenTiepDuoc(message) {
  const kieuDaLuu = String(message?.msgType ?? "").trim();
  if (!KIEU_TIN_CHUYEN_TIEP_DUOC.has(kieuDaLuu)) return false;

  const raw = message?.rawJson;
  if (!raw || typeof raw !== "object") return true;

  const kieuProvider = raw?.data?.msgType ?? raw?.msgType;
  if (
    kieuProvider !== null
    && kieuProvider !== undefined
    && String(kieuProvider).trim() !== ""
    && !KIEU_TIN_CHUYEN_TIEP_DUOC.has(String(kieuProvider).trim())
  ) {
    return false;
  }

  const noiDungProvider = raw?.data?.content ?? raw?.content;
  if (noiDungProvider && typeof noiDungProvider === "object") return false;
  return true;
}

function chotChuTuQuyen(capturedAuthority) {
  const chu = String(capturedAuthority?.originOwnerUid || chuHienTai() || "").trim();
  if (!chu) throw loiCoMa("ZALO_RUNTIME_CHANGED", "Chưa đăng nhập Zalo.");
  return chu;
}

/**
 * Doc mot tin trong pham vi so huu. Ma loi cua db duoc chuyen thang thanh ma
 * loi cua API: khong tim thay va khong du dinh danh la HAI ket cuc khac nhau,
 * gop lai thi nguoi dung khong biet nen thu lai hay thoi.
 */
async function chotTinCuaChu(chu, threadId, messageId, tuyChon) {
  const ketQua = await resolveOwnedActionMessage(chu, threadId, messageId, tuyChon);
  if (!ketQua.ok) {
    throw loiCoMa(
      ketQua.code,
      ketQua.code === "NOT_FOUND"
        ? "Không tìm thấy tin nhắn trong cuộc trò chuyện này."
        : "Tin nhắn này chưa đủ định danh để thao tác."
    );
  }
  return ketQua;
}

/** Tha / doi / go bieu tuong tren mot tin cua cuoc tro chuyen minh so huu. */
export async function appReactToMessage({ threadId, messageId, reaction }, capturedAuthority = null) {
  const chu = chotChuTuQuyen(capturedAuthority);
  const icon = layBieuTuongApp(String(reaction || ""));
  // null khac chuoi rong: chuoi rong la NONE (go cam xuc) va hoan toan hop le.
  if (icon === null) throw loiCoMa("MALFORMED_REQUEST", "Biểu tượng cảm xúc không được phép.");

  const { thread, identity } = await chotTinCuaChu(chu, threadId, messageId);
  await reactToMessage(
    { icon, identity, threadId: thread.id, threadType: thread.threadType },
    capturedAuthority
  );

  // Cap nhat qua CUNG diem hoa giai voi su kien listener, nen khi Zalo doi lai
  // su kien cam xuc cua chinh minh thi khong co lan doi trang thai thu hai.
  capNhatCamXucCucBo({
    ownerUid: chu,
    threadId: thread.id,
    msgId: messageId,
    reactorUid: chu,
    icon: String(icon),
  });
  return { reactions: layCamXucCucBo(chu, thread.id, messageId) };
}

/**
 * Gui sticker. KHONG ghi ban ghi tai cho: Zalo doi lai ban echo chat.sticker
 * mang msgId that, va duong ghi canonical se nhan no. Tu ve mot bong bong o
 * day la co hai bong bong cho mot lan gui.
 */
export async function appSendSticker({ threadId, stickerKey }, capturedAuthority = null) {
  const chu = chotChuTuQuyen(capturedAuthority);
  const thread = await getThread(chu, threadId);
  if (!thread) throw loiCoMa("NOT_FOUND", "Cuộc trò chuyện không thuộc tài khoản đang đăng nhập.");

  const ketQua = await sendStickerMessage(
    { stickerKey, threadId: thread.id, threadType: thread.threadType },
    capturedAuthority
  );
  return { msgId: ketQua?.msgId ?? null };
}

/** Bao dang soan tin. Nhip do thuoc ve trinh duyet; day chi chuyen tiep tin hieu. */
export async function appSendTyping({ threadId }, capturedAuthority = null) {
  const chu = chotChuTuQuyen(capturedAuthority);
  const thread = await getThread(chu, threadId);
  if (!thread) throw loiCoMa("NOT_FOUND", "Cuộc trò chuyện không thuộc tài khoản đang đăng nhập.");
  await sendTypingSignal({ threadId: thread.id, threadType: thread.threadType }, capturedAuthority);
  return { ok: true };
}

/**
 * Bao da xem mot tin DEN. Bao da xem tin cua chinh minh la vo nghia, va phong
 * bi cua tin tu gui cung khong phai cai Zalo cho o day.
 */
export async function appMarkSeen({ threadId, messageId }, capturedAuthority = null) {
  const chu = chotChuTuQuyen(capturedAuthority);
  const { thread, message, identity } = await chotTinCuaChu(chu, threadId, messageId);
  if (message.isSelf) {
    throw loiCoMa("ACTION_NOT_APPLICABLE", "Chỉ báo đã xem cho tin nhắn đến.");
  }
  await markMessageSeen({ envelope: identity, threadType: thread.threadType }, capturedAuthority);
  return { ok: true };
}

/**
 * Thu hoi tin cua CHINH MINH.
 *
 * Sau khi Zalo xac nhan moi doi trang thai cuc bo, va doi qua cung diem hoa
 * giai voi su kien "undo" cua listener nen khong co hai lan doi trang thai.
 */
export async function appUndoMessage({ threadId, messageId }, capturedAuthority = null) {
  const chu = chotChuTuQuyen(capturedAuthority);
  const { thread, message, identity } = await chotTinCuaChu(chu, threadId, messageId);
  if (!message.isSelf) throw loiCoMa("ACTION_NOT_APPLICABLE", "Chỉ thu hồi được tin của chính mình.");
  if (String(message.msgType) === "chat.recalled") {
    throw loiCoMa("ACTION_NOT_APPLICABLE", "Tin nhắn này đã được thu hồi.");
  }

  await recallMessage(
    { identity, threadId: thread.id, threadType: thread.threadType },
    capturedAuthority
  );
  await apDungThuHoiCucBo({ ownerUid: chu, threadId: thread.id, messageId });
  return { ok: true, content: NHAN_TIN_DA_THU_HOI };
}

/**
 * Xoa tin CHI O PHIA MINH.
 *
 * Thu tu la bat buoc: Zalo truoc, CSDL sau. Xoa cuc bo truoc roi Zalo tu choi
 * la tin bien mat khoi man hinh nhung van con o may Zalo - nguoi dung tin la
 * da xoa trong khi chua he xoa.
 */
export async function appDeleteMessageForMe({ threadId, messageId }, capturedAuthority = null) {
  const chu = chotChuTuQuyen(capturedAuthority);
  const { thread, identity } = await chotTinCuaChu(chu, threadId, messageId);

  await deleteMessageForSelf(
    { identity, threadId: thread.id, threadType: thread.threadType },
    capturedAuthority
  );

  await deleteLocalMessage(chu, thread.id, messageId);
  const threadMoi = await recomputeThreadPreview(chu, thread.id);
  if (chu === chuHienTai()) {
    io?.emit("message-deleted", { threadId: String(thread.id), messageId: String(messageId) });
    if (threadMoi) io?.emit("thread-refresh", threadMoi);
    await emitThreads();
  }
  return { ok: true };
}

/**
 * Chuyen tiep MOT tin chu toi MOT cuoc tro chuyen. Ca nguon lan dich deu phai
 * thuoc tai khoan dang dang nhap: thieu mot trong hai la day duoc noi dung cua
 * mot cuoc tro chuyen sang mot cuoc khong lien quan.
 */
export async function appForwardMessage({ threadId, messageId, targetThreadId }, capturedAuthority = null) {
  const chu = chotChuTuQuyen(capturedAuthority);
  // Nguon chi can noi dung chu; provider khong doi dinh danh tin goc cho ban
  // text-only, nen tin cu thieu cliMsgId van chuyen tiep duoc.
  const { message } = await chotTinCuaChu(chu, threadId, messageId, { requireIdentity: false });
  if (!laTinChuChuyenTiepDuoc(message)) {
    throw loiCoMa("ACTION_NOT_APPLICABLE", "Chỉ chuyển tiếp được tin nhắn chữ.");
  }
  if (!String(message.content || "").trim()) {
    throw loiCoMa("ACTION_NOT_APPLICABLE", "Chỉ chuyển tiếp được tin nhắn chữ.");
  }

  const dich = await getThread(chu, targetThreadId);
  if (!dich) throw loiCoMa("NOT_FOUND", "Cuộc trò chuyện đích không thuộc tài khoản đang đăng nhập.");

  await forwardStoredMessage(
    { text: message.content, threadId: dich.id, threadType: dich.threadType },
    capturedAuthority
  );
  return { ok: true, targetThreadId: dich.id };
}
