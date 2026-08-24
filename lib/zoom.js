// Zoom Server-to-Server OAuth — CHI LO PHAN KET NOI.
//
// Vong nay khong tao phong hop, khong sua phong hop, khong goi thay cho bot.
// Toan bo viec do de danh cho P2B.
//
// Vi sao khong dung account_config: bang do khoa theo owner_uid va fail-closed
// khi chua ro chu tai khoan Zalo. Cau hinh Zoom phai dat duoc ngay ca luc Zalo
// chua dang nhap, nen no thuoc tang ung dung chu khong thuoc tung tai khoan
// Zalo. app_secrets la kho khoa/gia tri san co o dung tang do, va da ma hoa
// truoc khi ghi dia (xem setAppSecret -> machHoa).
import { getAppSecret, setAppSecret } from "./db.js";

const HAN_GOI_MS = 20000;
export const MAX_PAGES = 10;

const MAY_CHU_TOKEN = "https://zoom.us/oauth/token";
const MAY_CHU_API = "https://api.zoom.us/v2";

/** Khoa luu trong app_secrets. Doi ten o day la doi ca noi luu. */
const KHOA = {
  accountId: "zoom_account_id",
  clientId: "zoom_client_id",
  clientSecret: "zoom_client_secret",
  hostEmail: "zoom_host_email",
};

/** Ma loi an toan: khong bao gio mang theo bi mat hay nguyen van loi cua Zoom. */
export class LoiZoom extends Error {
  constructor(ma, thongDiep) {
    super(thongDiep);
    this.name = "LoiZoom";
    this.ma = ma;
  }
}

const LOI = {
  ZOOM_CONFIG_INCOMPLETE: "Thông tin Zoom chưa đầy đủ.",
  ZOOM_AUTH_FAILED:
    "Zoom từ chối thông tin kết nối. Hãy kiểm tra Account ID, Client ID và Client Secret.",
  ZOOM_SCOPE_MISSING: "Ứng dụng Zoom chưa được cấp đủ quyền.",
  ZOOM_HOST_NOT_FOUND: "Không tìm thấy tài khoản Zoom với email này.",
  ZOOM_PROVIDER_UNAVAILABLE: "Không thể kết nối Zoom lúc này. Hãy thử lại.",
  ZOOM_REQUEST_FAILED: "Zoom trả về lỗi không mong đợi.",

  // --- P2B: tao cuoc hop ---
  ZOOM_MEETING_INPUT_INVALID: "Thông tin cuộc họp chưa hợp lệ.",
  ZOOM_MEETING_SCOPE_MISSING: "Ứng dụng Zoom chưa được cấp quyền tạo cuộc họp.",
  ZOOM_HOST_CANNOT_SCHEDULE: "Tài khoản Zoom này không có quyền tạo cuộc họp.",
  ZOOM_CREATE_RATE_LIMITED: "Zoom đang giới hạn số lần tạo cuộc họp. Hãy thử lại sau.",
  ZOOM_CREATE_UNCERTAIN:
    "Không xác định được Zoom đã tạo cuộc họp hay chưa. Không tự thử lại để tránh tạo trùng.",
  ZOOM_MEETING_CREATE_FAILED: "Zoom không tạo được cuộc họp. Hãy thử lại.",

  // --- P2D: dashboard provider lam nguon su that ---
  ZOOM_MEETING_ID_INVALID: "Meeting ID chưa hợp lệ.",
  ZOOM_MEETING_LIST_FAILED: "Không tải được lịch Zoom.",
  ZOOM_MEETING_DETAIL_FAILED: "Không đọc được thông tin cuộc họp Zoom.",
  ZOOM_MEETING_NOT_OWNED: "Không tìm thấy cuộc họp Zoom thuộc tài khoản đã cấu hình.",
  ZOOM_MEETING_TYPE_UNSUPPORTED: "P2D V1 chưa hỗ trợ sửa hoặc xoá cuộc họp lặp lại.",
  ZOOM_MEETING_UPDATE_FAILED: "Zoom không cập nhật được cuộc họp.",
  ZOOM_MEETING_DELETE_FAILED: "Zoom không xoá được cuộc họp.",
  ZOOM_MEETING_LIST_TOO_LARGE: "Lịch Zoom có quá nhiều trang để tải an toàn.",
  ZOOM_UPDATE_UNCERTAIN:
    "Không xác định được Zoom đã cập nhật cuộc họp hay chưa. Không tự thử lại.",
  ZOOM_DELETE_UNCERTAIN:
    "Không xác định được Zoom đã xoá cuộc họp hay chưa. Không tự thử lại.",
};

function nem(ma) {
  throw new LoiZoom(ma, LOI[ma] || LOI.ZOOM_REQUEST_FAILED);
}

/** Seam de kiem thu bom ham gia vao. Mac dinh la fetch that. */
let goiMang = (...doiSo) => fetch(...doiSo);
export function capHinhGoiMang(fn) {
  goiMang = typeof fn === "function" ? fn : (...doiSo) => fetch(...doiSo);
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function emailHopLe(email) {
  return RE_EMAIL.test(String(email || "").trim());
}

/* --- CAU HINH --- */

/**
 * Doc cau hinh day du (da giai ma). CHI dung trong noi bo server.
 * Tuyet doi khong tra thang ket qua ham nay ve trinh duyet.
 */
export async function getZoomConfig() {
  const [accountId, clientId, clientSecret, hostEmail] = await Promise.all([
    getAppSecret(KHOA.accountId),
    getAppSecret(KHOA.clientId),
    getAppSecret(KHOA.clientSecret),
    getAppSecret(KHOA.hostEmail),
  ]);
  return {
    accountId: accountId || "",
    clientId: clientId || "",
    clientSecret: clientSecret || "",
    hostEmail: hostEmail || "",
  };
}

/** Hinh dang AN TOAN de gui ve trinh duyet: chi co/khong, khong co bi mat. */
export function zoomCongKhai(config) {
  const coAccountId = Boolean(config?.accountId);
  const coClientId = Boolean(config?.clientId);
  const coClientSecret = Boolean(config?.clientSecret);
  const hostEmail = config?.hostEmail || "";
  return {
    configured: coAccountId && coClientId && coClientSecret && Boolean(hostEmail),
    hostEmail, // khong phai bi mat, va can de hien "Da cau hinh - <email>"
    hasAccountId: coAccountId,
    hasClientId: coClientId,
    hasClientSecret: coClientSecret,
  };
}

/**
 * Gop cau hinh moi vao cau hinh cu.
 *
 * O nhap de TRONG nghia la "giu nguyen gia tri cu", KHONG phai "xoa di" - nguoi
 * dung mo lai trang thi o mat khau luon rong, de trong ma hieu la xoa thi chi
 * can bam Luu mot lan la mat sach chia khoa.
 */
export async function saveZoomConfig(patch = {}) {
  const cu = await getZoomConfig();
  const lay = (moi, cuGiaTri) => {
    const s = String(moi ?? "").trim();
    return s ? s : cuGiaTri;
  };

  const moi = {
    accountId: lay(patch.accountId, cu.accountId),
    clientId: lay(patch.clientId, cu.clientId),
    clientSecret: lay(patch.clientSecret, cu.clientSecret),
    // Email host KHONG phai bi mat nen cho phep sua thang; van khong cho xoa
    // trang bang cach de trong, dung mot quy tac voi ba o kia.
    hostEmail: lay(patch.hostEmail, cu.hostEmail),
  };

  if (!emailHopLe(moi.hostEmail)) nem("ZOOM_CONFIG_INCOMPLETE");
  if (!moi.accountId || !moi.clientId || !moi.clientSecret) nem("ZOOM_CONFIG_INCOMPLETE");

  await Promise.all([
    setAppSecret(KHOA.accountId, moi.accountId),
    setAppSecret(KHOA.clientId, moi.clientId),
    setAppSecret(KHOA.clientSecret, moi.clientSecret),
    setAppSecret(KHOA.hostEmail, moi.hostEmail),
  ]);
  return moi;
}

/** Ngat ket noi: xoa DUNG bon o cua Zoom, khong dung den bat ky cau hinh nao khac. */
export async function clearZoomConfig() {
  await Promise.all([
    setAppSecret(KHOA.accountId, ""),
    setAppSecret(KHOA.clientId, ""),
    setAppSecret(KHOA.clientSecret, ""),
    setAppSecret(KHOA.hostEmail, ""),
  ]);
}

/* --- GOI ZOOM --- */

async function goi(url, options = {}) {
  const controller = new AbortController();
  const dongHo = setTimeout(() => controller.abort(), HAN_GOI_MS);
  try {
    const res = await goiMang(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Zoom co luc tra ve HTML khi sai duong dan - giu nguyen text de phan loai.
    }
    return { ok: res.ok, status: res.status, data, text };
  } catch (error) {
    if (error?.name === "AbortError") nem("ZOOM_PROVIDER_UNAVAILABLE");
    if (error instanceof LoiZoom) throw error;
    nem("ZOOM_PROVIDER_UNAVAILABLE");
  } finally {
    clearTimeout(dongHo);
  }
}

/** Nhan biet loi thieu quyen tu ma trang thai / thong diep cua Zoom. */
function laThieuQuyen(status, data, text) {
  if (status === 403) return true;
  const s = `${data?.message || ""} ${text || ""}`.toLowerCase();
  return s.includes("scope") || s.includes("permission");
}

function cauHinhZoomDayDu(config) {
  return Boolean(
    config?.accountId && config?.clientId && config?.clientSecret && config?.hostEmail
  );
}

function nemLoiDocMeeting(kq, maMacDinh, maKhongTimThay = "ZOOM_HOST_NOT_FOUND") {
  if (kq.status === 401) nem("ZOOM_AUTH_FAILED");
  if (kq.status === 404) nem(maKhongTimThay);
  if (laThieuQuyen(kq.status, kq.data, kq.text)) nem("ZOOM_SCOPE_MISSING");
  nem(maMacDinh);
}

/** Meeting ID tu URL/body la du lieu khong tin cay: P2D chi nhan ID so. */
export function meetingIdHopLe(meetingId) {
  const id = String(meetingId ?? "").trim();
  if (!/^\d{1,32}$/.test(id)) nem("ZOOM_MEETING_ID_INVALID");
  return id;
}

function emailZoomBangNhau(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

/** Chi cho phep participant URL http(s) di qua public response. */
function urlThamGiaAnToan(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/**
 * Xin access token theo luong Server-to-Server OAuth.
 *
 * Luong nay KHONG co refresh_token: het han thi xin lai token moi. Vi vay token
 * chi song trong bo nho mot lan goi - khong ghi xuong CSDL, khong tra ve trinh
 * duyet, khong ghi vao nhat ky.
 */
export async function getZoomAccessToken(config) {
  const c = config || (await getZoomConfig());
  if (!c.accountId || !c.clientId || !c.clientSecret) nem("ZOOM_CONFIG_INCOMPLETE");

  const url = new URL(MAY_CHU_TOKEN);
  url.searchParams.set("grant_type", "account_credentials");
  url.searchParams.set("account_id", c.accountId);

  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`, "utf8").toString("base64");
  const kq = await goi(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!kq.ok) {
    if (kq.status === 400 || kq.status === 401) nem("ZOOM_AUTH_FAILED");
    if (laThieuQuyen(kq.status, kq.data, kq.text)) nem("ZOOM_SCOPE_MISSING");
    nem("ZOOM_REQUEST_FAILED");
  }
  const token = kq.data?.access_token;
  if (!token) nem("ZOOM_AUTH_FAILED");
  return token;
}

/**
 * Kiem tra ket noi: xin token roi tra cuu DUNG tai khoan host da cau hinh.
 *
 * Khong dung /users/me: Server-to-Server OAuth la o cap tai khoan, "me" khong
 * tro toi mot nguoi cu the nao ca.
 */
export async function testZoomConnection() {
  const config = await getZoomConfig();
  if (!config.accountId || !config.clientId || !config.clientSecret || !config.hostEmail) {
    nem("ZOOM_CONFIG_INCOMPLETE");
  }

  const token = await getZoomAccessToken(config);
  const url = `${MAY_CHU_API}/users/${encodeURIComponent(config.hostEmail)}`;
  const kq = await goi(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!kq.ok) {
    if (kq.status === 404) nem("ZOOM_HOST_NOT_FOUND");
    if (kq.status === 401) nem("ZOOM_AUTH_FAILED");
    if (laThieuQuyen(kq.status, kq.data, kq.text)) nem("ZOOM_SCOPE_MISSING");
    nem("ZOOM_REQUEST_FAILED");
  }

  const u = kq.data || {};
  if (!u.email) nem("ZOOM_HOST_NOT_FOUND");

  // Chi tra ve dung nhung gi can hien: khong bung nguyen ho so Zoom.
  return {
    ok: true,
    email: u.email,
    displayName: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.display_name || "",
    userType: u.type ?? null,
  };
}

/* --- P2B: TAO CUOC HOP DA LEN LICH --- */

/** Mui gio hop le = Intl cua runtime nhan duoc. Khong keo them thu vien nao. */
export function muiGioHopLe(timezone) {
  const tz = String(timezone || "").trim();
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tach ngay/gio cua host tu moc provider ma khong dua vao timezone cua server.
 * Zoom List tra start_time UTC; neu provider bo hau to thi van hieu la UTC thay
 * vi vo tinh dung TZ cua container.
 */
export function tachNgayGioZoom(startTime, timezone) {
  const text = String(startTime || "").trim();
  const tz = String(timezone || "").trim();
  if (!text || !muiGioHopLe(tz)) return { date: "", time: "" };

  const coMuiGio = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const moc = new Date(coMuiGio ? text : `${text}Z`);
  if (Number.isNaN(moc.getTime())) return { date: "", time: "" };

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(moc);
  const lay = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${lay("year")}-${lay("month")}-${lay("day")}`,
    time: `${lay("hour")}:${lay("minute")}`,
  };
}

const RE_NGAY = /^\d{4}-\d{2}-\d{2}$/;
const RE_GIO = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Kiem dau vao TRUOC khi dong den mang. Sai o dau la dung o do -
 * khong mot goi Zoom nao duoc phep bay di voi du lieu hong.
 */
function kiemDauVaoCuocHop({ topic, date, time, duration, timezone }) {
  const ten = String(topic ?? "").trim();
  if (!ten) nem("ZOOM_MEETING_INPUT_INVALID");

  const ngay = String(date ?? "").trim();
  if (!RE_NGAY.test(ngay)) nem("ZOOM_MEETING_INPUT_INVALID");
  // 2026-02-30 khop regex nhung khong ton tai - bat bang Date roi doi chieu
  // lai tung phan (cung ky thuat voi ham docMoc doc moc gio cua bo lenh chat).
  const [nam, thang, ngayTrongThang] = ngay.split("-").map(Number);
  const thu = new Date(Date.UTC(nam, thang - 1, ngayTrongThang));
  if (
    thu.getUTCFullYear() !== nam ||
    thu.getUTCMonth() !== thang - 1 ||
    thu.getUTCDate() !== ngayTrongThang
  ) {
    nem("ZOOM_MEETING_INPUT_INVALID");
  }

  const gio = String(time ?? "").trim();
  if (!RE_GIO.test(gio)) nem("ZOOM_MEETING_INPUT_INVALID");

  const phut = Number(duration);
  if (!Number.isInteger(phut) || phut < 1 || phut > 1440) nem("ZOOM_MEETING_INPUT_INVALID");

  const tz = String(timezone ?? "").trim();
  if (!muiGioHopLe(tz)) nem("ZOOM_MEETING_INPUT_INVALID");

  return { ten, ngay, gio, phut, tz };
}

function locMeetingDashboard(raw) {
  const meetingId = meetingIdHopLe(raw?.id);

  const timezone = String(raw?.timezone || "UTC");
  const startTime = String(raw?.start_time || "");
  const { date, time } = tachNgayGioZoom(startTime, timezone);
  return {
    meetingId,
    topic: String(raw?.topic || ""),
    startTime,
    date,
    time,
    duration: Number.isFinite(Number(raw?.duration)) ? Number(raw.duration) : 0,
    timezone,
    joinUrl: urlThamGiaAnToan(raw?.join_url),
    type: Number.isFinite(Number(raw?.type)) ? Number(raw.type) : null,
  };
}

function sapXepMeeting(a, b) {
  const mocA = Date.parse(a.startTime);
  const mocB = Date.parse(b.startTime);
  if (Number.isNaN(mocA) && Number.isNaN(mocB)) return a.meetingId.localeCompare(b.meetingId);
  if (Number.isNaN(mocA)) return 1;
  if (Number.isNaN(mocB)) return -1;
  return mocA - mocB;
}

/** Lay toan bo lich scheduled cua DUNG host da cau hinh, khong cache cuc bo. */
export async function listZoomMeetings() {
  const config = await getZoomConfig();
  if (!cauHinhZoomDayDu(config)) nem("ZOOM_CONFIG_INCOMPLETE");
  const token = await getZoomAccessToken(config);

  const meetings = [];
  let nextPageToken = "";
  for (let trang = 0; trang < MAX_PAGES; trang++) {
    const url = new URL(`${MAY_CHU_API}/users/${encodeURIComponent(config.hostEmail)}/meetings`);
    url.searchParams.set("type", "scheduled");
    url.searchParams.set("page_size", "300");
    if (nextPageToken) url.searchParams.set("next_page_token", nextPageToken);

    const kq = await goi(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!kq.ok) nemLoiDocMeeting(kq, "ZOOM_MEETING_LIST_FAILED");
    if (!Array.isArray(kq.data?.meetings)) nem("ZOOM_MEETING_LIST_FAILED");
    meetings.push(...kq.data.meetings.map(locMeetingDashboard));
    nextPageToken = String(kq.data?.next_page_token || "").trim();
    if (!nextPageToken) return meetings.sort(sapXepMeeting);
  }

  // Van con token sau MAX_PAGES = provider chua tra het. Khong duoc cat im lang.
  if (nextPageToken) nem("ZOOM_MEETING_LIST_TOO_LARGE");
  return meetings.sort(sapXepMeeting);
}

async function layChiTietMeetingDaKiemSoHuu(meetingId, config, token) {
  const id = meetingIdHopLe(meetingId);
  const kq = await goi(`${MAY_CHU_API}/meetings/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!kq.ok) {
    nemLoiDocMeeting(kq, "ZOOM_MEETING_DETAIL_FAILED", "ZOOM_MEETING_DETAIL_FAILED");
  }
  const detail = kq.data || {};
  if (!emailZoomBangNhau(detail.host_email, config.hostEmail)) {
    nem("ZOOM_MEETING_NOT_OWNED");
  }
  return { id, detail };
}

function kiemLoaiMeetingQuanLyDuoc(detail) {
  if (Number(detail?.type) !== 2) nem("ZOOM_MEETING_TYPE_UNSUPPORTED");
}

/** Participant share data chi duoc doc on-demand va loc trang. */
export async function getZoomMeetingShare(meetingId) {
  const id = meetingIdHopLe(meetingId);
  const config = await getZoomConfig();
  if (!cauHinhZoomDayDu(config)) nem("ZOOM_CONFIG_INCOMPLETE");
  const token = await getZoomAccessToken(config);
  const { detail } = await layChiTietMeetingDaKiemSoHuu(id, config, token);
  const joinUrl = urlThamGiaAnToan(detail.join_url);
  if (!joinUrl) nem("ZOOM_MEETING_DETAIL_FAILED");
  return {
    meetingId: id,
    participantPasscode: detail.password == null ? "" : String(detail.password),
    joinUrl,
  };
}

/** Sua DUNG nam truong P2D V1; ownership va type duoc kiem truoc PATCH. */
export async function updateZoomMeeting(meetingId, dauVao = {}) {
  const id = meetingIdHopLe(meetingId);
  const { ten, ngay, gio, phut, tz } = kiemDauVaoCuocHop(dauVao);
  const config = await getZoomConfig();
  if (!cauHinhZoomDayDu(config)) nem("ZOOM_CONFIG_INCOMPLETE");
  const token = await getZoomAccessToken(config);
  const { detail } = await layChiTietMeetingDaKiemSoHuu(id, config, token);
  kiemLoaiMeetingQuanLyDuoc(detail);

  let kq;
  try {
    kq = await goi(`${MAY_CHU_API}/meetings/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topic: ten,
        start_time: `${ngay}T${gio}:00`,
        duration: phut,
        timezone: tz,
      }),
    });
  } catch (error) {
    if (error instanceof LoiZoom && error.ma === "ZOOM_PROVIDER_UNAVAILABLE") {
      nem("ZOOM_UPDATE_UNCERTAIN");
    }
    throw error;
  }
  if (!kq.ok) {
    if (kq.status === 401) nem("ZOOM_AUTH_FAILED");
    if (kq.status === 404) nem("ZOOM_MEETING_DETAIL_FAILED");
    if (laThieuQuyen(kq.status, kq.data, kq.text)) nem("ZOOM_SCOPE_MISSING");
    nem("ZOOM_MEETING_UPDATE_FAILED");
  }
  return { ok: true };
}

/** Xoa mot meeting type 2 sau ownership guard; khong retry, khong local delete. */
export async function deleteZoomMeeting(meetingId) {
  const id = meetingIdHopLe(meetingId);
  const config = await getZoomConfig();
  if (!cauHinhZoomDayDu(config)) nem("ZOOM_CONFIG_INCOMPLETE");
  const token = await getZoomAccessToken(config);
  const { detail } = await layChiTietMeetingDaKiemSoHuu(id, config, token);
  kiemLoaiMeetingQuanLyDuoc(detail);

  let kq;
  try {
    kq = await goi(`${MAY_CHU_API}/meetings/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error instanceof LoiZoom && error.ma === "ZOOM_PROVIDER_UNAVAILABLE") {
      nem("ZOOM_DELETE_UNCERTAIN");
    }
    throw error;
  }
  if (!kq.ok) {
    if (kq.status === 401) nem("ZOOM_AUTH_FAILED");
    if (kq.status === 404) nem("ZOOM_MEETING_DETAIL_FAILED");
    if (laThieuQuyen(kq.status, kq.data, kq.text)) nem("ZOOM_SCOPE_MISSING");
    nem("ZOOM_MEETING_DELETE_FAILED");
  }
  return { ok: true };
}

/** Nhan dien "host khong duoc phep len lich" tu than loi cua Zoom. */
function laKhongDuocLenLich(data, text) {
  const s = `${data?.message || ""} ${text || ""}`.toLowerCase();
  return s.includes("schedul") || s.includes("host") || s.includes("license");
}

/**
 * Tao DUNG MOT cuoc hop da len lich (type=2) cho host da cau hinh o backend.
 *
 * Nhung dieu co chu dich:
 *  - Host lay tu cau hinh da luu, KHONG BAO GIO nhan tu trinh duyet - khong thi
 *    ai dang nhap app cung chon duoc host Zoom tuy y.
 *  - start_time gui kem timezone, de Zoom tu hieu gio dia phuong. Khong tu che
 *    phep quy doi mui gio.
 *  - waiting_room bat, default_password bat, use_pmi tat: moi cuoc hop mot ID
 *    rieng, khong dung phong ca nhan.
 *  - KHONG TU THU LAI: tao cuoc hop la side effect. Goi ma khong ro ket qua
 *    (nghen mang giua chung) thi bao "khong xac dinh" va de nguoi dung tu quyet
 *    - tu POST lai la co the tao trung.
 *  - start_url (quyen host) bi VUT BO ngay tai day: khong tra ve, khong ghi
 *    nhat ky, khong ghi CSDL.
 */
export async function taoZoomMeeting(dauVao = {}) {
  const { ten, ngay, gio, phut, tz } = kiemDauVaoCuocHop(dauVao);

  const config = await getZoomConfig();
  if (!config.accountId || !config.clientId || !config.clientSecret || !config.hostEmail) {
    nem("ZOOM_CONFIG_INCOMPLETE");
  }

  const token = await getZoomAccessToken(config);

  const url = `${MAY_CHU_API}/users/${encodeURIComponent(config.hostEmail)}/meetings`;
  let kq;
  try {
    kq = await goi(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topic: ten,
        type: 2,
        start_time: `${ngay}T${gio}:00`,
        duration: phut,
        timezone: tz,
        default_password: true,
        settings: { waiting_room: true, use_pmi: false },
      }),
    });
  } catch (error) {
    // Den duoc day nghia la loi xay ra TRONG luc POST tao cuoc hop: khong biet
    // Zoom da nhan hay chua. Phan loai rieng va tuyet doi khong thu lai.
    if (error instanceof LoiZoom && error.ma === "ZOOM_PROVIDER_UNAVAILABLE") {
      nem("ZOOM_CREATE_UNCERTAIN");
    }
    throw error;
  }

  if (!kq.ok) {
    if (kq.status === 429) nem("ZOOM_CREATE_RATE_LIMITED");
    if (kq.status === 401) nem("ZOOM_AUTH_FAILED");
    if (kq.status === 404) nem("ZOOM_HOST_NOT_FOUND");
    if (laThieuQuyen(kq.status, kq.data, kq.text)) nem("ZOOM_MEETING_SCOPE_MISSING");
    if (laKhongDuocLenLich(kq.data, kq.text)) nem("ZOOM_HOST_CANNOT_SCHEDULE");
    nem("ZOOM_MEETING_CREATE_FAILED");
  }

  const m = kq.data || {};
  if (!m.id || !m.join_url) nem("ZOOM_MEETING_CREATE_FAILED");

  // Loc TRANG: chi nhung truong duoc phep di tiep. Password cua nguoi tham gia
  // duoc doi ten thanh participantPasscode; raw password key / start_url /
  // encrypted_password / uuid / raw response van dung lai tai day.
  return {
    ok: true,
    meetingId: String(m.id),
    topic: m.topic || ten,
    startTime: m.start_time || `${ngay}T${gio}:00`,
    duration: m.duration ?? phut,
    timezone: m.timezone || tz,
    joinUrl: m.join_url,
    hostEmail: config.hostEmail,
    participantPasscode: m.password == null ? "" : String(m.password),
  };
}
