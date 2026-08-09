import { Zalo, LoginQRCallbackEventType, ThreadType, AvatarSize } from "zca-js";
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
const CHO_GOM_MS = 7000;
const gomTin = new Map(); // threadId -> { tins, dongHo }

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

function gomTinRoiTraLoi(normalizedMsg) {
  const khoa = String(normalizedMsg.threadId);
  const dang = gomTin.get(khoa) || { tins: [] };
  dang.tins.push(normalizedMsg);
  if (dang.dongHo) clearTimeout(dang.dongHo);

  // Khach con go tiep thi dem lai tu dau.
  dang.dongHo = setTimeout(() => {
    gomTin.delete(khoa);
    traLoiCumTin(dang.tins).catch((error) => console.error("[zalo] Loi tra loi:", error));
  }, CHO_GOM_MS);

  gomTin.set(khoa, dang);
}

async function traLoiCumTin(tins) {
  const tin = gopThanhMotTin(tins);
  if (!tin.content?.trim()) return;

  // Bao khach biet minh da nghe thay, truoc ca khi AI kip nghi.
  api?.sendSeenEvent?.(tin.threadId, Number(tin.threadType)).catch(() => {});

  // Phai giu bien de con TAT duoc. Moi lan batDauGoPhim la mot dong ho moi;
  // goi lai ma khong giu ham tat thi dong ho cu chay ngam mai.
  let tatGoPhim = batDauGoPhim(tin.threadId, tin.threadType);

  let aiReply = null;
  try {
    aiReply = await aiChat.tryReply(tin.content, tin);
    if (!aiReply) return;

    const bubbles = splitIntoBubbles(aiReply);
    for (const [i, bubble] of bubbles.entries()) {
      // Nghi truoc TUNG bubble, ke ca bubble dau: vua nhan xong da co ngay ba
      // dong chu thi lo ra la may.
      await doi(i === 0 ? Math.min(nghiTruocBubble(bubble), 1200) : nghiTruocBubble(bubble));
      tatGoPhim();
      await sendChatMessage({ threadId: tin.threadId, threadType: tin.threadType, text: bubble });
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
      gomTinRoiTraLoi(normalizedMsg);
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

export async function sendChatMessage({ threadId, text, threadType }) {
  if (!api || !appState.loggedIn) throw new Error("Chua dang nhap Zalo.");
  const cleanText = String(text || "").trim();
  if (!threadId || !cleanText) throw new Error("Thieu cuoc chat hoac noi dung.");
  const numericThreadType = Number(threadType ?? ThreadType.User);
  await api.sendMessage(cleanText, threadId, numericThreadType);
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
