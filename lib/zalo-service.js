import { Zalo, LoginQRCallbackEventType, ThreadType, AvatarSize } from "zca-js";
// KHONG import Reactions truc tiep: moi bieu tuong phai di qua layBieuTuong,
// la cong duy nhat kiem tra danh sach trang.
import { chonCamXuc, danhSachChoPhep, layBieuTuong, layMaTin } from "./cam-xuc.js";
import { laTinHeThong, moTaSuKien } from "./tin-he-thong.js";
import { botDuocGoi } from "./goi-ten.js";
import { taoBoGom, khoaGom } from "./gom-tin.js";
import { locRuotGan } from "./loc-ruot-gan.js";
import { loadCredentials, saveCredentials, xoaCredentials } from "./credentials.js";
import {
  getThread,
  getThreadMessages,
  insertMessage,
  listThreads,
  rebuildThreadsFromMessages,
  upsertThread,
  getAutoReplyRules,
} from "./db.js";
import { normalizeIncomingMessage, normalizeTs, splitIntoBubbles } from "./message-utils.js";
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
import { addLog } from "./activity-log.js";
import { laLenhAdmin, xuLyLenh } from "./admin-command.js";
import * as aiChat from "./ai-chat.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";


const zalo = new Zalo({ logging: false, checkUpdate: true });
let api = null;
let io = null;
let loginPromise = null;
let listenerAttached = false;
let dangNoiLai = false;
let soLanThuNoiLai = 0;
let lucDutGanNhat = 0;

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

function datTrangThaiKetNoi(trangThai, lyDo = "") {
  appState.ketNoi = { trangThai, lyDo, luc: Date.now() };
  emitState();
}

export function configureZaloService(socketServer) {
  io = socketServer;
}

export function getPublicState() {
  return { ...appState, qr: { ...appState.qr } };
}

export async function bootstrapState() {
  return {
    ...getPublicState(),
    threads: await listThreads({ recentOnly: true }),
  };
}

export async function tryLoginWithSavedCredentials() {
  const credentials = await loadCredentials();
  if (!credentials) return false;
  try {
    const loggedApi = await zalo.login(credentials);
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
  api = loggedApi;
  appState.loggedIn = true;
  appState.loggingIn = false;
  resetHistorySyncState();
  await loadOwnProfile();
  setupListener();
  await rebuildThreadsFromMessages();
  emitState();
  await emitThreads();
  setTimeout(() => {
    syncThreadCatalog(api)
      .then(emitThreads)
      .catch((error) => console.warn("[zalo] Loi sync catalog:", error.message));
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

function setupListener() {
  if (listenerAttached || !api?.listener) return;
  listenerAttached = true;

  attachOldMessagesListener(api, async () => {
    await rebuildThreadsFromMessages();
    await emitThreads();
  });

  api.listener.on("message", async (message) => {
    try {
      const normalizedMsg = normalizeIncomingMessage(message);
      await handleNewIncomingMessage(normalizedMsg);
    } catch (error) {
      console.error("[zalo] Loi xu ly tin realtime:", error);
    }
  });

  // Ai dang go phim. Khong tra loi gi ca, chi ghi lai de bo gom biet duong cho.
  api.listener.on("typing", (typing) => {
    try {
      ghiNhanGoPhim(typing);
    } catch {
      // Mat mot tin hieu go phim khong dang de lam gi ca.
    }
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
  if (dangNoiLai || !appState.loggedIn) return;
  soLanThuNoiLai++;
  const cho = Math.min(5000 * 2 ** (soLanThuNoiLai - 1), 60000);
  setTimeout(() => {
    noiLaiZalo(`tự động lần ${soLanThuNoiLai}`).catch(() => {});
  }, cho);
}

/**
 * Dung han duong day cu roi dung lai tu dau bang credential da luu.
 * Phai ha co listenerAttached, khong thi setupListener se thoat ngay va cai
 * api MOI se khong co tai nghe nao - dut lan hai la im lang vinh vien.
 */
export async function noiLaiZalo(nguon = "thủ công") {
  if (dangNoiLai) return { ok: false, message: "Đang nối lại, chị đợi chút." };
  dangNoiLai = true;
  datTrangThaiKetNoi("dang-noi");
  let thanhCong = false;

  try {
    try {
      api?.listener?.stop?.();
    } catch {
      // Duong day da chet san thi khong dong duoc - khong sao.
    }
    listenerAttached = false;

    const credentials = await loadCredentials();
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
    dangNoiLai = false;
    // Thu lai cho den khi duoc. Truoc day that bai mot lan la nam chet luon:
    // chi gap laptop -> dut -> app thu noi lai dung mot lan trong luc may con
    // dang ngu -> that bai -> bo cuoc vinh vien. Sang hom sau van im lang.
    // Phai dat trong finally vi luc o trong catch thi dangNoiLai con dang bat.
    if (!thanhCong && appState.loggedIn) henNoiLai();
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
/** Coi la "van dang go" neu tin hieu go phim moi den trong khoang nay. */
const CON_DANG_GO_MS = 5000;

/** Lan cuoi moi nguoi go phim: "threadId|uid" -> moc thoi gian. */
const lanGoCuoi = new Map();

/**
 * Zalo bao ai dang go phim. Dung de KHONG cat ngang nguoi dang ke do cau
 * chuyen: ho ngung 8 giay de nghi tiep thi bot van cho, thay vi nhay vao.
 */
function ghiNhanGoPhim(typing) {
  const uid = String(typing?.data?.uid || "");
  const threadId = String(typing?.threadId || typing?.data?.gid || "");
  if (!uid || !threadId) return;
  lanGoCuoi.set(khoaGom(threadId, uid), Date.now());
}

function conDangGo(threadId, senderId) {
  const moc = lanGoCuoi.get(khoaGom(threadId, senderId));
  return Boolean(moc) && Date.now() - moc < CON_DANG_GO_MS;
}

const boGom = taoBoGom({
  conDangGo,
  khiChot: (tins) => traLoiCumTin(tins).catch((error) => console.error("[zalo] Loi tra loi:", error)),
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
function batDauGoPhim(threadId, threadType) {
  let dungRoi = false;
  const nhac = () => {
    if (dungRoi || !api?.sendTypingEvent) return;
    api.sendTypingEvent(threadId, Number(threadType)).catch(() => {});
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
  const loiNhan = s.replace(tim[0], "").replace(/\s+/g, " ").trim();
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

async function layThanhVien(groupId) {
  const co = nhoThanhVien.get(groupId);
  if (co && Date.now() - co.luc < HAN_NHO_THANH_VIEN_MS) return co.ds;
  try {
    const { members } = await listGroupMembers(groupId);
    const ds = (members || [])
      .map((m) => ({ uid: String(m.id), ten: String(m.displayName || m.zaloName || "").trim() }))
      .filter((m) => m.ten.length >= 2 && m.uid !== String(appState.uid))
      // Ten dai truoc: "Le Hong Minh" phai duoc thu truoc "Minh", khong thi
      // bat nham phan ngan roi bo sot phan con lai.
      .sort((a, b) => b.ten.length - a.ten.length);
    nhoThanhVien.set(groupId, { luc: Date.now(), ds });
    return ds;
  } catch (error) {
    console.warn("[zalo] Khong lay duoc thanh vien nhom:", error.message);
    return [];
  }
}

/**
 * Tim ten thanh vien trong cau tra loi roi bien thanh @nhac ten that.
 *
 * Chi khop TEN DAY DU, khong khop ten rieng le: nhom co "Ngoc Bich" ma di khop
 * moi chu "Ngoc" thi cau nao co chu do cung bi gan the, sai nguoi nhu choi.
 */
async function dungNhacTen(text, groupId) {
  return khopTenTrongCau(text, await layThanhVien(groupId));
}

/** Tach rieng phan thuan logic de kiem thu duoc ma khong can goi Zalo. */
export function khopTenTrongCau(text, ds) {
  if (!ds?.length) return [];

  const mentions = [];
  const daDung = new Set();
  const daChiem = []; // [batDau, ketThuc) da bi mot the chiem
  const thap = text.toLowerCase();

  for (const tv of ds) {
    if (daDung.has(tv.uid)) continue;
    const ten = tv.ten.toLowerCase();

    // Duyet MOI lan xuat hien, khong chi lan dau. "Minhh khong phai la Minh":
    // lan dau nam trong "Minhh" nen bi loai, nhung chu "Minh" cuoi cau moi la
    // that - chi xet lan dau thi bo sot.
    for (let tu = 0; ; ) {
      const pos = thap.indexOf(ten, tu);
      if (pos < 0) break;
      tu = pos + 1;

      // Khong cat ngang mot tu dai hon (vd "Minh" nam trong "Minhh")
      const truoc = pos > 0 ? text[pos - 1] : " ";
      const sau = text[pos + tv.ten.length] ?? " ";
      if (/[\p{L}\p{N}]/u.test(truoc) || /[\p{L}\p{N}]/u.test(sau)) continue;

      // Khong de hai the DE LEN NHAU. Nhom co ca "Le Hong Minh" lan "Minh" thi
      // cau "Le Hong Minh va Tu Anh" se bi gan 3 the, trong do "Minh" nam ngay
      // trong ten dai. Vi da xep ten dai truoc nen ten dai gianh cho truoc.
      const ketThuc = pos + tv.ten.length;
      if (daChiem.some(([a, b]) => pos < b && ketThuc > a)) continue;

      daChiem.push([pos, ketThuc]);
      mentions.push({ pos, uid: tv.uid, len: tv.ten.length });
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
  return { ...goc, content: loi.join("\n") || String(goc.content || "") };
}


/**
 * Khach chi noi "cam on em" -> tha tim thay vi dap mot cau vo thuong vo phat.
 * Tra ve true neu da xu ly xong, khoi goi AI.
 */
async function thuThaCamXuc(tin) {
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

  try {
    await api.addReaction(bieuTuong, {
      data: ma,
      threadId: tin.threadId,
      type: Number(tin.threadType),
    });
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

async function traLoiCumTin(tins) {
  const tin = gopThanhMotTin(tins);
  if (!tin.content?.trim()) return;

  // Bao khach biet minh da nghe thay, truoc ca khi AI kip nghi.
  api?.sendSeenEvent?.(tin.threadId, Number(tin.threadType)).catch(() => {});

  // Thu tha cam xuc TRUOC khi goi AI: cau "cam on em" khong dang mot luot goi.
  if (tins.length === 1 && (await thuThaCamXuc(tin))) return;

  // Phai giu bien de con TAT duoc. Moi lan batDauGoPhim la mot dong ho moi;
  // goi lai ma khong giu ham tat thi dong ho cu chay ngam mai.
  let tatGoPhim = batDauGoPhim(tin.threadId, tin.threadType);

  let aiReply = null;
  try {
    aiReply = await aiChat.tryReply(tin.content, tin);
    if (!aiReply) return;

    const laNhom = Number(tin.threadType) === Number(ThreadType.Group);
    // Trich dan CHI trong nhom: 30 nguoi noi cung luc, khong trich thi khong ai
    // biet bot dang tra loi ai. Chat rieng hai nguoi ma cung trich dan thi may moc.
    const trichDan = laNhom ? dungTrichDan(tin) : null;

    const bubbles = splitIntoBubbles(aiReply);
    for (const [i, bubble] of bubbles.entries()) {
      // Nghi truoc TUNG bubble, ke ca bubble dau: vua nhan xong da co ngay ba
      // dong chu thi lo ra la may.
      await doi(i === 0 ? Math.min(nghiTruocBubble(bubble), 1200) : nghiTruocBubble(bubble));
      tatGoPhim();

      const mentions = laNhom ? await dungNhacTen(bubble, tin.threadId).catch(() => []) : [];
      await sendChatMessage({
        threadId: tin.threadId,
        threadType: tin.threadType,
        text: bubble,
        // Chi trich dan o bubble DAU. Trich ca 3 bubble thi man hinh day khoi
        // trich dan lap lai, roi mat.
        quote: i === 0 ? trichDan : null,
        mentions,
      });

      // Con bubble nua thi go tiep, khach thay lien mach.
      if (i < bubbles.length - 1) tatGoPhim = batDauGoPhim(tin.threadId, tin.threadType);
    }
    await addLog({
      event: "send_ok",
      level: "ok",
      summary: `Đã gửi ${bubbles.length} tin qua Zalo: ${bubbles[0].slice(0, 70)}`,
      detail: {
        threadId: tin.threadId,
        threadType: tin.threadType,
        soBubble: bubbles.length,
        soTinDaGom: tins.length,
        bubbles,
      },
    });
  } catch (error) {
    console.error("[zalo] Loi AI-reply:", error);
    await addLog({
      event: "ai_error",
      level: "error",
      summary: `Gọi LLM xong nhưng KHÔNG gửi được qua Zalo — ${error.message}`,
      detail: { threadId: tin.threadId, reply: aiReply, error: error.message },
    });
  } finally {
    tatGoPhim();
  }
}

async function handleNewIncomingMessage(normalizedMsg) {
  const processedMsg = await persistAndBroadcastMessage(normalizedMsg);
  if (!processedMsg) return;

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
      const traLoi = await xuLyLenh(normalizedMsg, sendChatMessage);
      if (traLoi) {
        await sendChatMessage({
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

    let handledByAutoReply = false;
    const rules = await getAutoReplyRules();
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
          await addLog({
            event: "auto_reply",
            level: "ok",
            summary: `Khớp quy tắc /${rule.command} — trả lời bằng câu cố định`,
            detail: {
              command: rule.command,
              matchAnywhere: Boolean(rule.match_anywhere),
              normalize: Boolean(rule.normalize),
              replyText: rule.reply_text,
              content: normalizedMsg.content,
            },
          });
          sendChatMessage({
            threadId: normalizedMsg.threadId,
            threadType: normalizedMsg.threadType,
            text: rule.reply_text,
          }).catch(err => console.error("[zalo] Loi auto-reply:", err));
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
      boGom.them(normalizedMsg);
    }
  }
}

export async function persistAndBroadcastMessage(message) {
  if (!message.threadId || !message.content) return null;
  const meta = await resolveThreadMeta(api, message.threadId, message.threadType);
  let thread = await upsertThread({
    id: message.threadId,
    threadType: message.threadType,
    title: meta.title,
    avatar: meta.avatar,
    lastMessage: message.content,
    lastMessageAt: message.ts,
  });
  message.senderAvatar = await resolveSenderAvatar(api, message, thread);
  const result = await insertMessage(message);
  if (result?.changes === 0) return null; // da ton tai trong db
  thread = await getThread(message.threadId);
  const broadcast = await enrichMessageSticker(api, message);
  io?.emit("new-message", broadcast);
  io?.emit("thread-refresh", thread);
  await emitThreads();
  return broadcast;
}

export async function getMessagesForThread(threadId) {
  const thread = await getThread(threadId);
  if (appState.loggedIn && thread) {
    await syncHistoryForThread(api, threadId, thread.threadType);
  }
  const messages = await getThreadMessages(threadId, 500);
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
export async function sendChatMessage({ threadId, text, threadType, quote, mentions, urgency }) {
  if (!api || !appState.loggedIn) throw new Error("Chua dang nhap Zalo.");
  const cleanText = await locTruocKhiGui(String(text || "").trim(), threadId);
  if (!threadId || !cleanText) throw new Error("Thieu cuoc chat hoac noi dung.");
  const numericThreadType = Number(threadType ?? ThreadType.User);

  // Truoc day luon gui chuoi tran nen mat sach quote/mention/urgency. Chi dung
  // dang object khi THAT SU can, de duong gui thong thuong khong doi hanh vi.
  const coThemGi = quote || (mentions && mentions.length) || (urgency && urgency > 0);

  // Tin chu yeu la mot duong link -> gui dang the co anh xem truoc.
  // sendLink KHONG nhan quote/mention/urgency, nen chi dung khi khong can may
  // thu do. Trong nhom thi trich dan quan trong hon anh xem truoc.
  const link = coThemGi ? null : timLinkChinh(cleanText);
  if (link) {
    await api.sendLink(
      { link: link.duongDan, ...(link.loiNhan ? { msg: link.loiNhan } : {}) },
      threadId,
      numericThreadType
    );
  } else if (coThemGi) {
    await api.sendMessage(
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
    await api.sendMessage(cleanText, threadId, numericThreadType);
  }
  const message = {
    id: `self-${threadId}-${Date.now()}`,
    threadId,
    threadType: numericThreadType,
    content: cleanText,
    isSelf: true,
    senderId: appState.uid,
    senderName: appState.displayName,
    senderAvatar: appState.myAvatar,
    msgType: "text",
    ts: normalizeTs(Date.now()),
    rawJson: null,
  };
  const meta = await resolveThreadMeta(api, threadId, numericThreadType);
  await insertMessage(message);
  const thread = await upsertThread({
    id: threadId,
    threadType: numericThreadType,
    title: meta.title,
    avatar: meta.avatar,
    lastMessage: cleanText,
    lastMessageAt: message.ts,
  });
  io?.emit("new-message", message);
  io?.emit("thread-refresh", thread);
  await emitThreads();
  return message;
}

export async function refreshThreads() {
  // Nguoi dung bam Lam moi thi phai hoi Zalo that, khong duoc tra ban trong bo nho.
  if (api) await syncThreadCatalog(api, true);
  await rebuildThreadsFromMessages();
  const threads = await listThreads({ recentOnly: true });
  io?.emit("threads", threads);
  return threads;
}

export async function ensureThreadMeta(threadId, threadType) {
  if (!api) return getThread(threadId);
  return enrichExistingThread(api, threadId, threadType);
}

export async function emitThreads() {
  io?.emit("threads", await listThreads({ recentOnly: true }));
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
const lichSuTraSo = [];

export function conLuotTraSo() {
  const mocMotGio = Date.now() - 60 * 60 * 1000;
  while (lichSuTraSo.length && lichSuTraSo[0] < mocMotGio) lichSuTraSo.shift();
  return TRA_SO_MOI_GIO - lichSuTraSo.length;
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

  if (conLuotTraSo() <= 0) {
    throw new Error(`Đã tra ${TRA_SO_MOI_GIO} số trong 1 giờ. Nghỉ một lát rồi tra tiếp, tránh Zalo khoá tài khoản.`);
  }
  lichSuTraSo.push(Date.now());

  const u = await api.findUser(so);
  return {
    uid: String(u?.uid || u?.userId || ""),
    ten: u?.display_name || u?.displayName || u?.zalo_name || u?.zaloName || "",
    anh: u?.avatar || null,
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

export async function listGroupMembers(groupId) {
  if (!api) throw new Error("Chưa đăng nhập");
  const infoData = await api.getGroupInfo(groupId);
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
      const chunkInfo = await api.getGroupMembersInfo(chunk);
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
