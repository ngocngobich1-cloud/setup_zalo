import {
  clearOwnerInstruction,
  danhDauChotBinhChon,
  getAdminZalo,
  getAiChatConfig,
  getOwnerInstruction,
  huyLichHen,
  listBinhChon,
  listLichHen,
  listThreads,
  setOwnerInstruction,
  themBinhChon,
  themLichHen,
} from "./db.js";
import { call, extractReply, splitModel, KHONG_TOOL } from "./opencode.js";
import { dinhDangGio } from "./scheduler.js";
import * as emailCheck from "./email-check.js";
import { addLog } from "./activity-log.js";
import {
  deleteZoomMeeting,
  listZoomMeetings,
  muiGioHopLe,
  taoZoomMeeting,
  updateZoomMeeting,
} from "./zoom.js";

const LAP_LAI_HOP_LE = ["", "hang_ngay", "hang_tuan"];
const TEN_LAP_LAI = { hang_ngay: "hằng ngày", hang_tuan: "hằng tuần", hang_thang: "hằng tháng" };

/** Ma lap lai cua Zalo cho loi nhac: 0 khong lap, 1 ngay, 2 tuan, 3 thang. */
const MA_LAP_ZALO = { "": 0, hang_ngay: 1, hang_tuan: 2, hang_thang: 3 };

/**
 * Muc do khan cua Zalo: 0 thuong, 1 quan trong, 2 khan.
 * Bat bang tu khoa trong chinh cau lenh cua chi, KHONG de model tu quyet -
 * model se doan bua roi danh dau khan tran lan, khach quen dan roi lo luon.
 */
const TEN_KHAN = { 1: "Quan trọng", 2: "Khẩn" };
export function docMucKhan(cauLenh) {
  const s = String(cauLenh || "").toLowerCase();
  if (/\bkhẩn\b|\bkhan cap\b|\bgấp\b|\bgap\b/.test(s)) return 2;
  if (/\bquan trọng\b|\bquan trong\b|\bnhớ\b.*\bnhé\b/.test(s)) return 1;
  return 0;
}

/**
 * Doc moc thoi gian model tra ve. Bat buoc dung dang YYYY-MM-DD HH:mm va phai
 * khop lai sau khi dung Date: viet 2026-02-30 thi Date se tu nhay sang 02/03,
 * gui tin sai ngay ma khong ai biet.
 */
function docMoc(chuoi) {
  const m = String(chuoi || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, nam, thang, ngay, gio, phut] = m.map(Number);
  const d = new Date(nam, thang - 1, ngay, gio, phut, 0, 0);
  if (
    d.getFullYear() !== nam ||
    d.getMonth() !== thang - 1 ||
    d.getDate() !== ngay ||
    d.getHours() !== gio ||
    d.getMinutes() !== phut
  ) {
    return null;
  }
  return Math.floor(d.getTime() / 1000);
}

/** Lenh cho cho xac nhan, theo tung cuoc tro chuyen. Mat khi restart - khong sao,
 *  chi can nhan lai lenh. Co han de mot lenh cu khong bat ngo duoc gui di sau nhieu gio. */
const cho = new Map();
const HAN_XAC_NHAN_MS = 10 * 60 * 1000;

const CHU_OK = "ok";
export const PHONE_USER_DIRECT_MESSAGE = "PHONE_USER_DIRECT_MESSAGE";
const TOKEN_XAC_NHAN_CU = new Set(["xac nhan", "oke", "okey", "okay", "dong y", "gui", "u", "yes"]);
const TU_HUY = ["huỷ", "huy", "hủy", "không", "khong", "thôi", "thoi", "cancel", "dừng", "dung"];

const HANH_DONG_CAN_XAC_NHAN = new Set([
  "gui_tin",
  "dat_lich",
  "dat_nhac",
  "tao_nhom",
  "doi_ten_nhom",
  "them_vao_nhom",
  "xoa_khoi_nhom",
  "duyet_vao_nhom",
  "ghim_ghi_chu",
  "tao_binh_chon",
  "day_ghi_nho",
  "day_sua",
]);

function chuanHoa(text) {
  return String(text || "").trim().toLowerCase().replace(/[.!,]+$/g, "");
}

const RE_DAU_LENH_NHAN_THEO_SO = [
  /^(?:em\s+)?nhắn\s+qua\s+số(?:\s+điện\s+thoại)?(?:\s|$)/iu,
  /^(?:em\s+)?nhắn\s+cho\s+số(?:\s+điện\s+thoại)?(?:\s|$)/iu,
  /^(?:em\s+)?nhắn\s+cho\s+bạn(?:\s+[\p{L}\p{M}'’_-]+)*\s+(?:qua\s+)?số(?:\s+điện\s+thoại)?(?:\s|$)/iu,
  /^(?:em\s+)?gửi\s+cho\s+số(?:\s+điện\s+thoại)?(?:\s|$)/iu,
  /^(?:em\s+)?gửi\s+tin\s+cho\s+số(?:\s+điện\s+thoại)?(?:\s|$)/iu,
];

/** Lay tat ca so dung ba dang duoc ho tro, kem vi tri de cat nguyen van noi dung. */
function cacSoDienThoaiHoTro(text) {
  const ketQua = [];
  const re = /(?:^|[^\d])((?:\+84|84|0)\d{9})(?!\d)/gu;
  for (const khop of String(text || "").matchAll(re)) {
    const so = khop[1];
    ketQua.push({ so, viTri: Number(khop.index) + khop[0].lastIndexOf(so) });
  }
  return ketQua;
}

function laDauLenhNhanTheoSo(text) {
  return RE_DAU_LENH_NHAN_THEO_SO.some((re) => re.test(String(text || "").trim()));
}

/** Cau chi neu mot so dien thoai, khong yeu cau gui hay tra cuu, khong duoc qua AI. */
function laVanBanSoKhongHanhDong(text, cacSo) {
  if (cacSo.length === 0) return false;
  const raw = String(text || "").trim();
  if (cacSo.length === 1 && raw === cacSo[0].so) return true;
  return /^số\s+điện\s+thoại\s+của\b/iu.test(raw);
}

function tachNoiDungNhanTheoSo(duoiSo) {
  const raw = String(duoiSo || "");
  if (!raw.trim()) return { trangThai: "thieu_noi_dung" };

  const cacMau = [
    /^\s*nội\s+dung\s+([\s\S]*)$/iu,
    /^\s*rằng\s+([\s\S]*)$/iu,
    /^\s*:\s*([\s\S]*)$/u,
    /^\s*,\s*(?:em\s+bảo\s+)?([\s\S]*)$/iu,
  ];
  for (const re of cacMau) {
    const khop = raw.match(re);
    if (!khop) continue;
    const noiDung = String(khop[1] || "").trim();
    return noiDung ? { trangThai: "hop_le", noiDung } : { trangThai: "thieu_noi_dung" };
  }
  return { trangThai: "khong_ro_noi_dung" };
}

/**
 * Phan loai hep, tat dinh tai bien routing. Khong dung ten nguoi de resolve va
 * khong goi provider. Moi trang thai loi duoc xu ly truoc generic AI parser.
 */
function phanLoaiLenhNhanQuaSo(text) {
  const raw = String(text || "").trim();
  const cacSo = cacSoDienThoaiHoTro(raw);
  if (!laDauLenhNhanTheoSo(raw)) {
    if (laVanBanSoKhongHanhDong(raw, cacSo)) {
      return {
        trangThai: "khong_hanh_dong",
        phanHoi: "Em chưa thấy yêu cầu gửi tin nhắn theo số điện thoại ạ.",
      };
    }
    return null;
  }

  if (cacSo.length === 0) {
    return {
      trangThai: "so_khong_hop_le",
      phanHoi: "Số điện thoại chưa đúng định dạng hỗ trợ. Chị dùng một số dạng 0xxxxxxxxx, 84xxxxxxxxx hoặc +84xxxxxxxxx giúp em.",
    };
  }
  if (cacSo.length > 1) {
    return {
      trangThai: "nhieu_so",
      phanHoi: "Em thấy nhiều số điện thoại. Chị vui lòng chỉ dùng một số cho mỗi lệnh gửi tin.",
    };
  }

  const [{ so, viTri }] = cacSo;
  const ketQuaNoiDung = tachNoiDungNhanTheoSo(raw.slice(viTri + so.length));
  if (ketQuaNoiDung.trangThai === "thieu_noi_dung") {
    return {
      trangThai: "thieu_noi_dung",
      phanHoi: `Chị muốn em gửi nội dung gì tới số ${so} ạ?`,
    };
  }
  if (ketQuaNoiDung.trangThai !== "hop_le") {
    return {
      trangThai: "khong_ro_noi_dung",
      phanHoi: "Em chưa tách được nội dung cần gửi. Chị đặt nội dung sau dấu hai chấm, “nội dung”, “rằng” hoặc “em bảo” giúp em.",
    };
  }
  return { trangThai: "hop_le", so, noiDung: ketQuaNoiDung.noiDung };
}

/** API parser cu chi tra ve lenh hop le; cac trang thai guard do xuLyLenh xu ly. */
export function phanTichLenhNhanQuaSo(text) {
  const ketQua = phanLoaiLenhNhanQuaSo(text);
  return ketQua?.trangThai === "hop_le" ? { so: ketQua.so, noiDung: ketQua.noiDung } : null;
}

/** Token side effect toan app: trim + khong phan biet hoa thuong + DUNG "OK". */
function laXacNhanOK(text) {
  return String(text || "").trim().toLowerCase() === CHU_OK;
}

/** Nhan ra mot loi thu xac nhan sai de chan no roi nhac lai, khong goi parser. */
function laThuXacNhanKhongHopLe(text) {
  if (laXacNhanOK(text)) return false;
  const raw = String(text || "").trim().toLowerCase();
  const khongDau = bocDau(raw);
  return khongDau === CHU_OK || khongDau.startsWith("ok ") || TOKEN_XAC_NHAN_CU.has(khongDau);
}

/**
 * Ten hanh dong trong huong dan viet khong dau ("duyet_vao_nhom"), nhung tieu de
 * ngay tren no lai co dau ("DUYET hoac TU CHOI"), nen model thinh thoang chep
 * lai thanh "duyet_vao_nhom" co dau. Bo dau truoc khi so sanh cho chac.
 */
function chuanHoaHanhDong(ten) {
  return String(ten || "")
    .normalize("NFD") // tach dau ra thanh ky tu rieng
    .toLowerCase()
    .replace(/đ/g, "d") // chu "d" gach ngang khong tach duoc bang NFD
    .replace(/[^a-z0-9_]/g, ""); // bo dau va moi ky tu la
}

/* --- ZOOM P2C: LENH CHAT -> PREVIEW -> OK -> CREATE --- */

export const MUI_GIO_BOT_ZOOM = "Asia/Ho_Chi_Minh";
export const NHAN_MUI_GIO_BOT_ZOOM = "Việt Nam (GMT+7)";

let taoCuocHopZoom = taoZoomMeeting;
let layDanhSachCuocHopZoom = listZoomMeetings;
let suaCuocHopZoom = updateZoomMeeting;
let xoaCuocHopZoom = deleteZoomMeeting;
let layBayGioZoom = () => Date.now();
let phanTichLenhAdminGia = null;

/** Seam hep cho test: production mac dinh luon dung dung taoZoomMeeting(). */
export function capHinhTaoZoom(fn) {
  taoCuocHopZoom = typeof fn === "function" ? fn : taoZoomMeeting;
}

/** Seam hep P2E: production mac dinh dung truc tiep cac ham provider P2D. */
export function capHinhQuanLyZoom({ list, update, remove } = {}) {
  layDanhSachCuocHopZoom = typeof list === "function" ? list : listZoomMeetings;
  suaCuocHopZoom = typeof update === "function" ? update : updateZoomMeeting;
  xoaCuocHopZoom = typeof remove === "function" ? remove : deleteZoomMeeting;
}

/** Dong ho chi phuc vu parser Zoom tuong doi; khong thay doi parser lich cu. */
export function capHinhDongHoZoom(fn) {
  layBayGioZoom = typeof fn === "function" ? fn : () => Date.now();
}

/** Seam parser admin cho test xung dot pending, mac dinh van dung OpenCode. */
export function capHinhPhanTichLenh(fn) {
  phanTichLenhAdminGia = typeof fn === "function" ? fn : null;
}

function ngayVietNamTai(miliGiay) {
  const phan = new Intl.DateTimeFormat("en-CA", {
    timeZone: MUI_GIO_BOT_ZOOM,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(miliGiay));
  const lay = (loai) => Number(phan.find((p) => p.type === loai)?.value);
  return { nam: lay("year"), thang: lay("month"), ngay: lay("day") };
}

function congNgay({ nam, thang, ngay }, soNgay) {
  const d = new Date(Date.UTC(nam, thang - 1, ngay + soNgay));
  return { nam: d.getUTCFullYear(), thang: d.getUTCMonth() + 1, ngay: d.getUTCDate() };
}

function ngayTonTai({ nam, thang, ngay }) {
  const d = new Date(Date.UTC(nam, thang - 1, ngay));
  return d.getUTCFullYear() === nam && d.getUTCMonth() + 1 === thang && d.getUTCDate() === ngay;
}

function haiSo(so) {
  return String(so).padStart(2, "0");
}

function ngayMay({ nam, thang, ngay }) {
  return `${nam}-${haiSo(thang)}-${haiSo(ngay)}`;
}

function ngayHienThi({ nam, thang, ngay }) {
  return `${haiSo(ngay)}/${haiSo(thang)}/${nam}`;
}

function docNgayZoom(text, bayGio) {
  const raw = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  const homNay = ngayVietNamTai(bayGio);
  if (raw === "hôm nay") return homNay;
  if (raw === "mai" || raw === "ngày mai") return congNgay(homNay, 1);

  const m = raw.match(/^(?:ngày\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/u);
  if (!m) return null;
  const kq = { ngay: Number(m[1]), thang: Number(m[2]), nam: Number(m[3] || homNay.nam) };
  return ngayTonTai(kq) ? kq : null;
}

function docGioZoom(text) {
  const raw = String(text || "")
    .normalize("NFD")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9:\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let m = raw.match(/^(\d{1,2})(?::|h)(\d{1,2})?(?:\s*(sang|toi|chieu))?$/);
  if (!m) m = raw.match(/^(\d{1,2})\s+gio(?:\s+(\d{1,2})\s+phut)?(?:\s+(sang|toi|chieu))?$/);
  if (!m) return null;

  let gio = Number(m[1]);
  const phut = Number(m[2] || 0);
  const buoi = m[3] || "";
  if (phut > 59) return null;
  if (buoi) {
    if (gio < 1 || gio > 12) return null;
    if (buoi === "sang") gio = gio === 12 ? 0 : gio;
    else gio = gio === 12 ? 12 : gio + 12;
  }
  if (gio < 0 || gio > 23) return null;
  return `${haiSo(gio)}:${haiSo(phut)}`;
}

function docThoiLuongZoom(text) {
  const raw = bocDau(text);
  const m = raw.match(/^(?:(\d+)\s*(?:tieng|gio))?(?:\s*(\d+)\s*phut)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const phut = Number(m[1] || 0) * 60 + Number(m[2] || 0);
  return Number.isInteger(phut) && phut >= 1 && phut <= 1440 ? phut : null;
}

function vietHoaChuDau(text) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  return s ? s[0].toLocaleUpperCase("vi-VN") + s.slice(1) : "";
}

export function laLenhTaoZoom(text) {
  return /^tao zoom(?:\s|$)/.test(bocDau(text));
}

/** Parser P2C V1 tat dinh, khong goi AI va luon tinh ngay theo gio Viet Nam. */
export function phanTichLenhTaoZoom(text, bayGio = layBayGioZoom()) {
  const noiDung = String(text || "").trim();
  if (!laLenhTaoZoom(noiDung)) return { ok: false, recognized: false };

  const m = noiDung.match(
    /^tạo\s+zoom\s+(.+?)\s+lúc\s+(.+?)\s+(hôm\s+nay|ngày\s+mai|mai|(?:ngày\s+)?\d{1,2}\/\d{1,2}(?:\/\d{4})?)\s+trong\s+(.+)$/iu
  );
  if (!m) return { ok: false, recognized: true, ma: "ZOOM_COMMAND_INCOMPLETE" };

  const topic = vietHoaChuDau(m[1]);
  const time = docGioZoom(m[2]);
  const ngay = docNgayZoom(m[3], bayGio);
  const duration = docThoiLuongZoom(m[4]);
  if (!topic) return { ok: false, recognized: true, ma: "ZOOM_TOPIC_MISSING" };
  if (!time) return { ok: false, recognized: true, ma: "ZOOM_TIME_INVALID" };
  if (!ngay) return { ok: false, recognized: true, ma: "ZOOM_DATE_INVALID" };
  if (!duration) return { ok: false, recognized: true, ma: "ZOOM_DURATION_INVALID" };

  return {
    ok: true,
    recognized: true,
    topic,
    date: ngayMay(ngay),
    displayDate: ngayHienThi(ngay),
    time,
    duration,
    timezone: MUI_GIO_BOT_ZOOM,
  };
}

/* --- ZOOM P2E: RESOLVE -> PREVIEW -> OK -> UPDATE / DELETE --- */

const MAU_NGAY_QUAN_LY_ZOOM = String.raw`(?:(?:hôm|hom)\s+nay|(?:ngày|ngay)\s+mai|mai|(?:(?:ngày|ngay)\s+)?\d{1,2}\/\d{1,2}(?:\/\d{4})?)`;
const RE_SUA_LICH_ZOOM = new RegExp(
  String.raw`^s(?:ửa|ua)\s+l(?:ịch|ich)\s+zoom\s+(.+?)\s+(${MAU_NGAY_QUAN_LY_ZOOM})\s+l(?:úc|uc)\s+(.+?)\s+sang\s+(.+)$`,
  "iu"
);
const RE_XOA_LICH_ZOOM = new RegExp(
  String.raw`^x(?:óa|oa)\s+l(?:ịch|ich)\s+zoom\s+(.+?)\s+(${MAU_NGAY_QUAN_LY_ZOOM})(?:\s+l(?:úc|uc)\s+(.+))?$`,
  "iu"
);
const RE_NGAY_GIO_MOI_ZOOM = new RegExp(
  String.raw`^(${MAU_NGAY_QUAN_LY_ZOOM})\s+l(?:úc|uc)\s+(.+)$`,
  "iu"
);
const RE_THOI_LUONG_MOI_ZOOM = /^(.*?)\s+th(?:ời|oi)\s+l(?:ượng|uong)\s+(.+)$/iu;

export function laLenhSuaLichZoom(text) {
  return /^sua lich zoom(?:\s|$)/.test(bocDau(text));
}

export function laLenhXoaLichZoom(text) {
  return /^xoa lich zoom(?:\s|$)/.test(bocDau(text));
}

/** Cu phap cu/nhap nhang khong bao gio duoc nang cap thanh DELETE. */
export function laLenhHuyZoomCu(text) {
  return /^(?:huy zoom|huy lich zoom)(?:\s|$)/.test(bocDau(text));
}

function noiDungMotDong(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

/** Parser P2E dung lai docNgayZoom/docGioZoom/docThoiLuongZoom cua P2C. */
export function phanTichLenhSuaLichZoom(text, bayGio = layBayGioZoom()) {
  const noiDung = noiDungMotDong(text);
  if (!laLenhSuaLichZoom(noiDung)) return { ok: false, recognized: false };

  const m = noiDung.match(RE_SUA_LICH_ZOOM);
  if (!m) return { ok: false, recognized: true, ma: "ZOOM_MANAGE_COMMAND_INCOMPLETE" };

  const topic = noiDungMotDong(m[1]);
  const ngayHienTai = docNgayZoom(m[2], bayGio);
  const gioHienTai = docGioZoom(m[3]);
  let duoiMoi = noiDungMotDong(m[4]);
  let duration = null;
  const coThoiLuong = duoiMoi.match(RE_THOI_LUONG_MOI_ZOOM);
  if (coThoiLuong) {
    duoiMoi = noiDungMotDong(coThoiLuong[1]);
    duration = docThoiLuongZoom(coThoiLuong[2]);
    if (!duration) return { ok: false, recognized: true, ma: "ZOOM_DURATION_INVALID" };
  }

  let ngayMoi = ngayHienTai;
  let gioMoiRaw = duoiMoi;
  const doiCaNgay = duoiMoi.match(RE_NGAY_GIO_MOI_ZOOM);
  if (doiCaNgay) {
    ngayMoi = docNgayZoom(doiCaNgay[1], bayGio);
    gioMoiRaw = doiCaNgay[2];
    if (!ngayMoi) return { ok: false, recognized: true, ma: "ZOOM_DATE_INVALID" };
  }
  const gioMoi = docGioZoom(gioMoiRaw);

  if (!topic) return { ok: false, recognized: true, ma: "ZOOM_TOPIC_MISSING" };
  if (!ngayHienTai) return { ok: false, recognized: true, ma: "ZOOM_DATE_INVALID" };
  if (!gioHienTai || !gioMoi) return { ok: false, recognized: true, ma: "ZOOM_TIME_INVALID" };

  return {
    ok: true,
    recognized: true,
    topic,
    currentDate: ngayMay(ngayHienTai),
    currentTime: gioHienTai,
    newDate: ngayMay(ngayMoi),
    newTime: gioMoi,
    duration,
  };
}

export function phanTichLenhXoaLichZoom(text, bayGio = layBayGioZoom()) {
  const noiDung = noiDungMotDong(text);
  if (!laLenhXoaLichZoom(noiDung)) return { ok: false, recognized: false };

  const m = noiDung.match(RE_XOA_LICH_ZOOM);
  if (!m) return { ok: false, recognized: true, ma: "ZOOM_MANAGE_COMMAND_INCOMPLETE" };
  const topic = noiDungMotDong(m[1]);
  const ngay = docNgayZoom(m[2], bayGio);
  const time = m[3] == null ? "" : docGioZoom(m[3]);

  if (!topic) return { ok: false, recognized: true, ma: "ZOOM_TOPIC_MISSING" };
  if (!ngay) return { ok: false, recognized: true, ma: "ZOOM_DATE_INVALID" };
  if (m[3] != null && !time) return { ok: false, recognized: true, ma: "ZOOM_TIME_INVALID" };

  return {
    ok: true,
    recognized: true,
    topic,
    date: ngayMay(ngay),
    time,
  };
}

function chuanHoaTopicZoom(text) {
  return noiDungMotDong(text).toLocaleLowerCase("vi-VN");
}

/** Resolver bao thu: exact topic + exact date + optional exact time, khong fuzzy. */
export function giaiQuyetMeetingZoom(danhSach, { topic, date, time = "" } = {}) {
  const tenCanTim = chuanHoaTopicZoom(topic);
  const ngayCanTim = String(date || "").trim();
  const gioCanTim = String(time || "").trim();
  const meetings = Array.isArray(danhSach) ? danhSach : [];
  const ungVien = meetings
    .filter((hop) => chuanHoaTopicZoom(hop?.topic) === tenCanTim)
    .filter((hop) => String(hop?.date || "").trim() === ngayCanTim)
    .filter((hop) => !gioCanTim || String(hop?.time || "").trim() === gioCanTim)
    .map((hop) => ({ ...hop, meetingId: String(hop?.meetingId ?? "") }));

  if (ungVien.length === 0) return { trangThai: "not_found", ungVien: [] };
  if (ungVien.length > 1) return { trangThai: "ambiguous", ungVien };
  if (Number(ungVien[0].type) !== 2) return { trangThai: "recurring", ungVien };
  return { trangThai: "resolved", meeting: ungVien[0], ungVien };
}

function ngayMayHopLe(date) {
  const m = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const ngay = { nam: Number(m[1]), thang: Number(m[2]), ngay: Number(m[3]) };
  return ngayTonTai(ngay) ? ngay : null;
}

function ngayMaySangHienThi(date) {
  const ngay = ngayMayHopLe(date);
  return ngay ? ngayHienThi(ngay) : String(date || "");
}

const NHAN_MUI_GIO_ZOOM = Object.freeze({
  "Asia/Ho_Chi_Minh": NHAN_MUI_GIO_BOT_ZOOM,
  "Asia/Bangkok": "Bangkok (GMT+7)",
  "Asia/Singapore": "Singapore (GMT+8)",
  "Asia/Hong_Kong": "Hong Kong (GMT+8)",
  "Asia/Tokyo": "Tokyo (GMT+9)",
  "Australia/Sydney": "Sydney",
  "Asia/Dubai": "Dubai (GMT+4)",
  "Europe/London": "London",
  "Europe/Paris": "Paris",
  "America/New_York": "New York",
  "America/Los_Angeles": "Los Angeles",
  UTC: "UTC",
});

/** Chi doi copy cho nguoi doc; gia tri IANA dung noi bo van giu nguyen. */
export function nhanMuiGioZoom(timezone) {
  const iana = String(timezone || "").trim() || MUI_GIO_BOT_ZOOM;
  return NHAN_MUI_GIO_ZOOM[iana] || iana;
}

function thoiLuongZoomHopLe(value) {
  const so = Number(value);
  return Number.isInteger(so) && so >= 1 && so <= 1440;
}

function deXuatSuaZoomHopLe(deXuat) {
  return Boolean(
    /^\d{1,32}$/.test(String(deXuat?.meetingId || "")) &&
    noiDungMotDong(deXuat?.topic) &&
    ngayMayHopLe(deXuat?.currentDate) &&
    docGioZoom(deXuat?.currentTime) === deXuat?.currentTime &&
    ngayMayHopLe(deXuat?.newDate) &&
    docGioZoom(deXuat?.newTime) === deXuat?.newTime &&
    thoiLuongZoomHopLe(deXuat?.duration) &&
    muiGioHopLe(deXuat?.timezone)
  );
}

function deXuatXoaZoomHopLe(deXuat) {
  return Boolean(
    /^\d{1,32}$/.test(String(deXuat?.meetingId || "")) &&
    noiDungMotDong(deXuat?.topic) &&
    ngayMayHopLe(deXuat?.date) &&
    docGioZoom(deXuat?.time) === deXuat?.time &&
    thoiLuongZoomHopLe(deXuat?.duration) &&
    muiGioHopLe(deXuat?.timezone)
  );
}

const HUONG_DAN_HUY_ZOOM_CU = [
  "Để xóa một cuộc họp Zoom đã có, hãy dùng lệnh:",
  "“Xóa lịch Zoom <tên> ngày <ngày> lúc <giờ>”.",
].join("\n");

const LOI_SUA_LICH_ZOOM_THIEU = [
  "Em chưa đủ thông tin để sửa lịch Zoom.",
  "Bạn có thể nhắn: “Sửa lịch Zoom lớp Marketing ngày mai lúc 20h sang 20h30”.",
].join("\n");

const LOI_XOA_LICH_ZOOM_THIEU = [
  "Em chưa đủ thông tin để xóa lịch Zoom.",
  "Bạn có thể nhắn: “Xóa lịch Zoom lớp Marketing ngày mai lúc 20h30”.",
].join("\n");

function cauTraLoiResolverZoom(ketQua, topic, date) {
  if (ketQua.trangThai === "not_found") return "Em không tìm thấy lịch Zoom phù hợp.";
  if (ketQua.trangThai === "recurring") {
    return "Cuộc họp này là lịch lặp. Hiện bot chưa hỗ trợ sửa hoặc xóa lịch Zoom lặp.";
  }
  if (ketQua.trangThai !== "ambiguous") return null;

  const cacGio = [...new Set(ketQua.ungVien.map((hop) => String(hop.time || "Không rõ giờ")))].sort();
  return [
    `Em tìm thấy nhiều lịch Zoom “${noiDungMotDong(topic)}” ngày ${ngayMaySangHienThi(date)}:`,
    "",
    ...cacGio.map((gio) => `- ${gio}`),
    "",
    "Hãy ghi thêm giờ của lịch cần thao tác.",
  ].join("\n");
}

async function timMeetingZoom(tieuChi) {
  try {
    const meetings = await layDanhSachCuocHopZoom();
    return giaiQuyetMeetingZoom(meetings, tieuChi);
  } catch {
    return { trangThai: "provider_error" };
  }
}

async function chuanBiSuaLichZoom(noiDung, khoa) {
  if (thaoTacChoConHan(khoa)) return LOI_DANG_CO_THAO_TAC_KHAC;
  const lenh = phanTichLenhSuaLichZoom(noiDung);
  if (!lenh.ok) return LOI_SUA_LICH_ZOOM_THIEU;

  const ketQua = await timMeetingZoom({ topic: lenh.topic, date: lenh.currentDate, time: lenh.currentTime });
  if (ketQua.trangThai === "provider_error") return "Em chưa tải được lịch Zoom để tìm cuộc họp. Hãy thử lại sau.";
  const loiResolver = cauTraLoiResolverZoom(ketQua, lenh.topic, lenh.currentDate);
  if (loiResolver) return loiResolver;

  const hop = ketQua.meeting;
  const duration = lenh.duration == null ? Number(hop.duration) : lenh.duration;
  const timezone = muiGioHopLe(hop.timezone) ? String(hop.timezone) : MUI_GIO_BOT_ZOOM;
  const deXuat = {
    meetingId: String(hop.meetingId),
    topic: noiDungMotDong(hop.topic),
    currentDate: String(hop.date),
    currentTime: String(hop.time),
    newDate: lenh.newDate,
    newTime: lenh.newTime,
    duration,
    timezone,
  };
  if (!deXuatSuaZoomHopLe(deXuat)) return "Thông tin lịch Zoom hiện tại chưa đủ an toàn để sửa.";

  cho.set(khoa, { loai: "zoom_update", deXuat, hetHan: Date.now() + HAN_XAC_NHAN_MS });
  return [
    "Em hiểu bạn muốn sửa lịch Zoom:",
    "",
    `Tên: ${deXuat.topic}`,
    `Hiện tại: ${deXuat.currentTime} ngày ${ngayMaySangHienThi(deXuat.currentDate)}`,
    `Chuyển sang: ${deXuat.newTime} ngày ${ngayMaySangHienThi(deXuat.newDate)}`,
    `Thời lượng: ${deXuat.duration} phút`,
    `Múi giờ: ${nhanMuiGioZoom(deXuat.timezone)}`,
    "",
    "Trả lời OK để lưu thay đổi.",
  ].join("\n");
}

async function chuanBiXoaLichZoom(noiDung, khoa) {
  if (thaoTacChoConHan(khoa)) return LOI_DANG_CO_THAO_TAC_KHAC;
  const lenh = phanTichLenhXoaLichZoom(noiDung);
  if (!lenh.ok) return LOI_XOA_LICH_ZOOM_THIEU;

  const ketQua = await timMeetingZoom({ topic: lenh.topic, date: lenh.date, time: lenh.time });
  if (ketQua.trangThai === "provider_error") return "Em chưa tải được lịch Zoom để tìm cuộc họp. Hãy thử lại sau.";
  const loiResolver = cauTraLoiResolverZoom(ketQua, lenh.topic, lenh.date);
  if (loiResolver) return loiResolver;

  const hop = ketQua.meeting;
  const deXuat = {
    meetingId: String(hop.meetingId),
    topic: noiDungMotDong(hop.topic),
    date: String(hop.date),
    time: String(hop.time),
    duration: Number(hop.duration),
    timezone: muiGioHopLe(hop.timezone) ? String(hop.timezone) : MUI_GIO_BOT_ZOOM,
  };
  if (!deXuatXoaZoomHopLe(deXuat)) return "Thông tin lịch Zoom hiện tại chưa đủ an toàn để xóa.";

  cho.set(khoa, { loai: "zoom_delete", deXuat, hetHan: Date.now() + HAN_XAC_NHAN_MS });
  return [
    "Em hiểu bạn muốn xóa lịch Zoom:",
    "",
    `Tên: ${deXuat.topic}`,
    `Thời gian: ${deXuat.time} ngày ${ngayMaySangHienThi(deXuat.date)}`,
    `Thời lượng: ${deXuat.duration} phút`,
    "",
    "Trả lời OK để xóa lịch.",
  ].join("\n");
}

function loiMutationZoom(action, error) {
  if (error?.ma === "ZOOM_MEETING_TYPE_UNSUPPORTED") {
    return "Cuộc họp này là lịch lặp. Hiện bot chưa hỗ trợ sửa hoặc xóa lịch Zoom lặp.";
  }
  if (["ZOOM_MEETING_DETAIL_FAILED", "ZOOM_MEETING_NOT_OWNED"].includes(error?.ma)) {
    return "Cuộc họp Zoom không còn sẵn sàng. Em không tự thử lại; hãy gửi một lệnh mới.";
  }
  return action === "update"
    ? "Em chưa sửa được lịch Zoom. Em không tự thử lại; hãy kiểm tra dashboard rồi gửi lệnh mới."
    : "Em chưa xóa được lịch Zoom. Em không tự thử lại; hãy kiểm tra dashboard rồi gửi lệnh mới.";
}

async function suaZoomTuLenh(dangCho) {
  const deXuat = dangCho?.deXuat;
  if (!deXuatSuaZoomHopLe(deXuat)) return "Đề xuất sửa lịch Zoom không còn hợp lệ. Không có thay đổi nào được thực hiện.";
  try {
    await suaCuocHopZoom(deXuat.meetingId, {
      topic: deXuat.topic,
      date: deXuat.newDate,
      time: deXuat.newTime,
      duration: deXuat.duration,
      timezone: deXuat.timezone,
    });
    return [
      "Đã sửa lịch Zoom:",
      "",
      `- Tên: ${deXuat.topic}`,
      `- Thời gian: ${deXuat.newTime} ngày ${ngayMaySangHienThi(deXuat.newDate)}`,
      `- Thời lượng: ${deXuat.duration} phút`,
    ].join("\n");
  } catch (error) {
    return loiMutationZoom("update", error);
  }
}

async function xoaZoomTuLenh(dangCho) {
  const deXuat = dangCho?.deXuat;
  if (!deXuatXoaZoomHopLe(deXuat)) return "Đề xuất xóa lịch Zoom không còn hợp lệ. Không có thay đổi nào được thực hiện.";
  try {
    await xoaCuocHopZoom(deXuat.meetingId);
    return [
      "Đã xóa lịch Zoom:",
      "",
      `- Tên: ${deXuat.topic}`,
      `- Thời gian: ${deXuat.time} ngày ${ngayMaySangHienThi(deXuat.date)}`,
    ].join("\n");
  } catch (error) {
    return loiMutationZoom("delete", error);
  }
}

const LOI_DANG_CO_THAO_TAC_KHAC = [
  "Hiện đang có một thao tác khác chờ OK.",
  "Hãy OK hoặc huỷ thao tác đó trước, rồi thử lại nhé.",
].join("\n");

function cauBanXemZoomBiHuy(loai) {
  if (loai === "zoom_update") {
    return "Bản xem trước sửa lịch Zoom đã được huỷ. Hãy gửi lại lệnh sửa lịch Zoom khi bạn sẵn sàng.";
  }
  if (loai === "zoom_delete") {
    return "Bản xem trước xóa lịch Zoom đã được huỷ. Hãy gửi lại lệnh xóa lịch Zoom khi bạn sẵn sàng.";
  }
  return "Bản xem trước tạo Zoom đã được huỷ. Hãy gửi lại lệnh tạo Zoom khi bạn sẵn sàng.";
}

const LOI_ZOOM_THIEU_THONG_TIN = [
  "Em chưa đủ thông tin để tạo Zoom.",
  "",
  "Bạn có thể nhắn:",
  "“Tạo Zoom lớp Marketing lúc 8 giờ tối mai trong 2 tiếng.”",
].join("\n");

function thaoTacChoConHan(khoa) {
  const dangCho = cho.get(khoa);
  if (!dangCho) return null;
  if (Date.now() <= dangCho.hetHan) return dangCho;
  cho.delete(khoa);
  return null;
}

function chuanBiTaoZoom(noiDung, khoa) {
  if (thaoTacChoConHan(khoa)) return LOI_DANG_CO_THAO_TAC_KHAC;
  const deXuat = phanTichLenhTaoZoom(noiDung);
  if (!deXuat.ok) return LOI_ZOOM_THIEU_THONG_TIN;

  cho.set(khoa, {
    loai: "zoom",
    deXuat: {
      topic: deXuat.topic,
      date: deXuat.date,
      time: deXuat.time,
      duration: deXuat.duration,
      timezone: deXuat.timezone,
    },
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });

  return [
    "Em hiểu bạn muốn tạo:",
    "",
    `Tên: ${deXuat.topic}`,
    `Thời gian: ${deXuat.time} ngày ${deXuat.displayDate}`,
    `Thời lượng: ${deXuat.duration} phút`,
    `Múi giờ: ${NHAN_MUI_GIO_BOT_ZOOM}`,
    "",
    "Trả lời OK để tạo cuộc họp.",
  ].join("\n");
}

async function taoZoomTuLenh(dangCho) {
  try {
    // taoZoomMeeting tu kiem lai dau vao va doc LAI config hien tai truoc khi
    // xin token. Pending da bi tieu thu o xuLyLenh truoc khi vao day.
    const ketQua = await taoCuocHopZoom({ ...dangCho.deXuat });
    const pass = String(ketQua?.participantPasscode || "").trim() || "Không có";
    return [
      "Đã tạo cuộc họp Zoom:",
      "",
      `- Meeting ID: ${ketQua?.meetingId || ""}`,
      `- Pass: ${pass}`,
      `- Link tham gia: ${ketQua?.joinUrl || ""}`,
    ].join("\n");
  } catch (error) {
    if (error?.ma === "ZOOM_CREATE_UNCERTAIN") {
      return [
        "Em chưa xác định được Zoom đã tạo cuộc họp hay chưa.",
        "Em không tự thử lại để tránh tạo trùng.",
      ].join("\n");
    }
    if (String(error?.ma || "").startsWith("ZOOM_")) {
      return `Em chưa tạo được cuộc họp Zoom. ${error.message}`;
    }
    return "Em chưa tạo được cuộc họp Zoom do lỗi không xác định. Em không tự thử lại để tránh tạo trùng.";
  }
}

/**
 * Lenh CHI duoc nhan trong chat RIENG voi dung nick admin.
 * Neu nhan ca trong nhom thi bat ky ai go dung cau do cung sai khien duoc bot.
 */
export async function laLenhAdmin(message) {
  if (Number(message?.threadType) !== 0) return false;
  const admin = await getAdminZalo(layChuTaiKhoan());
  if (!admin.uid) return false;
  return String(message.senderId) === String(admin.uid);
}

async function danhSachDichDen() {
  const threads = await listThreads(layChuTaiKhoan(), { recentOnly: true });
  return threads.map((t) => ({
    id: t.id,
    ten: t.title || t.id,
    loai: Number(t.threadType) === 1 ? "nhom" : "nick",
  }));
}

const HUONG_DAN = `Bạn là bộ phân tích lệnh. Chủ shop nhắn một câu tiếng Việt, bạn phải chuyển thành JSON.

Chỉ trả về JSON thuần, không kèm giải thích, không kèm dấu \`\`\`.

GỬI NGAY (có thể gửi tới NHIỀU nhóm/nick cùng lúc):
{"hanhDong":"gui_tin","dichIds":["<id1>","<id2>"],"noiDung":"<nội dung>"}
Chỉ một đích thì vẫn để mảng một phần tử.
Ví dụ "nhắn vào nhóm masterclass và nhóm lớp 2: mai nghỉ học" → dichIds có 2 id.

HẸN GIỜ GỬI (một câu lệnh có thể chứa NHIỀU mốc giờ):
{"hanhDong":"dat_lich","lich":[
  {"dichId":"<id>","dichTen":"<tên>","noiDung":"<nội dung>","luc":"YYYY-MM-DD HH:mm","lapLai":""}
]}

TẠO LỜI NHẮC CỦA ZALO (thẻ nhắc hiện trong nhóm, Zalo tự đẩy thông báo cho mọi thành viên):
{"hanhDong":"dat_nhac","dichId":"<id>","tieuDe":"<nội dung nhắc, ngắn gọn>","luc":"YYYY-MM-DD HH:mm","lapLai":""}
lapLai: "" | "hang_ngay" | "hang_tuan" | "hang_thang"

PHÂN BIỆT dat_nhac với dat_lich — rất quan trọng:
- dat_nhac = một SỰ KIỆN cần mọi người biết và nhớ. Zalo hiện thẻ nhắc, đẩy thông báo.
  Ví dụ: "nhắc cả lớp 15h mai vào zoom", "đặt lời nhắc 8h thứ 2 hằng tuần họp lớp"
- dat_lich = một TIN NHẮN cần bot gửi đúng giờ. Hiện ra như tin nhắn bình thường.
  Ví dụ: "8h sáng 10/8 gửi nhóm: mn cho em xin cảm nhận", "14h nhắn chị Tú Anh link zoom"
Nếu câu lệnh có nội dung dài, có lời văn, có link → dat_lich.
Nếu chỉ là mốc sự kiện ngắn cần cả nhóm nhớ → dat_nhac.

XEM DANH SÁCH NGƯỜI XIN VÀO NHÓM:
{"hanhDong":"xem_cho_duyet","dichId":"<id nhóm>"}
Ví dụ: "ai đang xin vào nhóm masterclass", "xem danh sách chờ duyệt nhóm lớp 2".

DUYỆT hoặc TỪ CHỐI người xin vào nhóm:
{"hanhDong":"duyet_vao_nhom","dichId":"<id nhóm>","soThuTu":[1,2],"dongY":true}
soThuTu là số thứ tự trong danh sách chờ vừa xem. dongY=false nghĩa là từ chối.
Cứ chép đúng con số admin nói, dù to hay nhỏ — hệ thống tự kiểm tra số đó có
hợp lệ không, đừng tự đoán là sai rồi trả về khong_hieu.
Ví dụ: "duyệt số 1 và 2 vào nhóm masterclass", "từ chối số 3", "duyệt số 12".

GẮN NHÃN cho một hội thoại (nhãn chỉ mình chủ shop nhìn thấy):
{"hanhDong":"gan_nhan","dichId":"<id nick hoặc nhóm>","nhan":"<tên nhãn>"}
Ví dụ: "gắn nhãn coaching cho Ngọc Bích", "dán nhãn class cho nhóm Lớp K13".

BỎ NHÃN khỏi một hội thoại:
{"hanhDong":"bo_nhan","dichId":"<id>","nhan":"<tên nhãn>"}
Ví dụ: "bỏ nhãn coaching của Ngọc Bích".

XEM DANH SÁCH NHÃN:
{"hanhDong":"xem_nhan"}
Ví dụ: "có những nhãn nào", "xem nhãn".

ĐỔI TÊN NHÓM:
{"hanhDong":"doi_ten_nhom","dichId":"<id nhóm>","tenMoi":"<tên mới>"}
Ví dụ: "đổi tên nhóm Lớp K13 thành Lớp K13 - Nâng cao".

THÊM NGƯỜI VÀO NHÓM có sẵn:
{"hanhDong":"them_vao_nhom","dichId":"<id nhóm>","thanhVien":["<id nick 1>"]}
thanhVien lấy id của các đích đến có loại=nick.
Ví dụ: "thêm Ngọc Bích vào nhóm Lớp K13".

XOÁ NGƯỜI KHỎI NHÓM:
{"hanhDong":"xoa_khoi_nhom","dichId":"<id nhóm>","ten":["<tên người 1>"]}
Ở đây ghi TÊN người như admin nói, KHÔNG phải id — vì người trong nhóm có thể
chưa từng nhắn tin với bot nên không có trong danh sách đích đến.
Nếu admin nói kiểu "xoá hết", "xoá tất cả", "xoá toàn bộ" mà không nêu đích danh
từng người, trả về {"hanhDong":"xoa_hang_loat"}.
Ví dụ: "xoá Thu Hà khỏi nhóm Lớp K13".

TẠO NHÓM MỚI:
{"hanhDong":"tao_nhom","ten":"<tên nhóm>","thanhVien":["<id nick 1>","<id nick 2>"]}
thanhVien lấy id của các đích đến có loại=nick, KHÔNG lấy loại=nhom.
Ví dụ: "tạo nhóm tên Lớp K13 gồm Ngọc Bích và Thu Hà".

TÌM NGƯỜI THEO SỐ ĐIỆN THOẠI:
{"hanhDong":"tim_nguoi","so":"<số điện thoại trong câu>"}
Ví dụ: "tìm số 0901234567 là ai", "check số 0987654321 giúp chị".

GHIM GHI CHÚ lên đầu nhóm:
{"hanhDong":"ghim_ghi_chu","dichId":"<id nhóm>","noiDung":"<nội dung ghi chú>"}
Dùng khi chủ shop muốn ghim một thông tin cố định cho cả nhóm luôn nhìn thấy —
lịch học, quy định lớp, link tài liệu. Khác với gửi tin: ghi chú nằm ở đầu nhóm,
không trôi đi. Ví dụ: "ghim lên nhóm masterclass: lịch học thứ 3 và thứ 5, 20h".

TẠO BÌNH CHỌN trong nhóm:
{"hanhDong":"tao_binh_chon","dichId":"<id nhóm>","cauHoi":"<câu hỏi>","luaChon":["<a>","<b>"],
 "nhieuLuaChon":false,"choThemLuaChon":false,"anDanh":false}
nhieuLuaChon=true nếu cho chọn nhiều đáp án; choThemLuaChon=true nếu cho thành viên tự thêm;
anDanh=true nếu không ai thấy ai bỏ phiếu gì. Phải có ít nhất 2 lựa chọn.

XEM KẾT QUẢ BÌNH CHỌN: {"hanhDong":"xem_binh_chon"}
CHỐT BÌNH CHỌN:        {"hanhDong":"chot_binh_chon","id":<số thứ tự trong danh sách>}

XEM DANH SÁCH LỊCH: {"hanhDong":"xem_lich"}
HUỶ MỘT LỊCH:       {"hanhDong":"huy_lich","id":<số>}

TRA CỨU EMAIL ĐÃ GỬI CHƯA:
{"hanhDong":"tra_mail","email":"<địa chỉ email trong câu>"}
Dùng khi chủ shop hỏi đã gửi mail cho ai đó chưa, mail có tới nơi không, kiểm tra mail...
Ví dụ: "tra xem mail gửi a@b.com thành công chưa", "check mail c@d.com giúp chị",
"đã gửi mail cho e@f.com chưa em".

DẠY EM CÁCH CƯ XỬ VỚI MỘT NGƯỜI CỤ THỂ (nhớ lâu dài):
{"hanhDong":"day_ghi_nho","dichTen":"<tên người, đúng như chủ shop gọi>","quyTac":"<điều cần nhớ>"}
Dùng khi chủ shop dặn em cách xưng hô, cách nói, điều cần tránh với MỘT người.
Ví dụ: "khi nói chuyện với bố thì xưng con, gọi là bố",
"với chị Tú Anh thì gọi là chị và xưng em", "đừng nhắc chuyện giá với Ngọc Bích".
"dichTen" chép đúng cụm tên chủ shop nói, KHÔNG tự đổi, KHÔNG tự tra id.

"quyTac" PHẢI GIỮ ĐẦY ĐỦ nội dung và ý nghĩa chủ shop đã dặn.
Chỉ được bỏ phần VỎ RA LỆNH, ví dụ "từ giờ em nhớ là", "hãy nhớ rằng",
"chị muốn em nhớ", "nhé", "giúp chị".
TUYỆT ĐỐI KHÔNG được: tóm tắt, rút gọn, bỏ bớt mệnh đề, thêm ý mới, đổi nghĩa.
Nếu lời dặn có NHIỀU yêu cầu hoặc điều kiện thì phải giữ ĐỦ TẤT CẢ.
Ví dụ: "Từ giờ với bố thì xưng là con, gọi bố là bố, và đừng nhắc chuyện vay tiền nhé."
→ quyTac = "Với bố thì xưng là con, gọi bố là bố, và đừng nhắc chuyện vay tiền."
(giữ đủ cả ba yêu cầu — bỏ mất một yêu cầu là SAI).

SỬA LẠI TOÀN BỘ CHỈ DẪN VỀ MỘT NGƯỜI:
{"hanhDong":"day_sua","dichTen":"<tên người>","quyTac":"<nội dung mới thay hết cái cũ>"}
Ví dụ: "sửa lại chỉ dẫn về bố thành: xưng con, gọi bố, không nói chuyện tiền nong".

QUÊN CHỈ DẪN VỀ MỘT NGƯỜI:
{"hanhDong":"day_quen","dichTen":"<tên người>"}
Ví dụ: "quên chỉ dẫn về bố đi", "bỏ hết những gì chị dặn về chị Tú Anh".

XEM CHỈ DẪN ĐANG CÓ VỀ MỘT NGƯỜI:
{"hanhDong":"day_xem","dichTen":"<tên người>"}
Ví dụ: "chị đã dặn em gì về bố", "xem chỉ dẫn về Ngọc Bích".

Phân biệt bốn lệnh dạy ở trên với gan_nhan: nhãn là để chủ shop lọc hội thoại,
còn dạy là để thay đổi cách EM nói chuyện với người đó.
Nếu chủ shop dặn một điều áp dụng cho MỌI khách chứ không cho riêng ai
("từ giờ với ai cũng...", "mọi khách đều..."), vẫn trả về day_ghi_nho nhưng để
"dichTen" là chuỗi rỗng — hệ thống sẽ tự từ chối và giải thích, đừng tự gán bừa
cho một người nào đó.

KHÔNG HIỂU:         {"hanhDong":"khong_hieu","lyDo":"<ngắn gọn, tiếng Việt>"}

Quy tắc chung:
- dichId PHẢI lấy đúng từ danh sách bên dưới, không được bịa.
- noiDung là nội dung sẽ gửi cho người nhận, KHÔNG kèm phần ra lệnh như "hãy nhắn vào nhóm..." hay phần chỉ giờ.
- Giữ nguyên đường link và cách xuống dòng trong nội dung.

Quy tắc về thời gian:
- "luc" luôn theo giờ Việt Nam, dạng YYYY-MM-DD HH:mm, dùng đồng hồ 24 giờ.
- Dựa vào MỐC HIỆN TẠI bên dưới để hiểu "mai", "thứ Ba tới", "8h sáng 10/8".
- "8h sáng"=08:00, "2h chiều"/"14h"=14:00, "8h tối"=20:00, "14h45 chiều"=14:45.
- Nếu một mốc chỉ ghi giờ mà không ghi ngày, lấy ngày của mốc ĐỨNG NGAY TRƯỚC trong cùng câu lệnh. Nếu không có mốc nào trước đó thì lấy ngày hôm nay; nếu giờ đó đã trôi qua rồi thì lấy ngày mai.
- "lapLai": để "" nếu chỉ gửi một lần; "hang_ngay" nếu lặp mỗi ngày; "hang_tuan" nếu lặp mỗi tuần.
- Nếu câu lệnh mơ hồ về thời gian, trả về khong_hieu chứ TUYỆT ĐỐI KHÔNG đoán bừa.`;

async function phanTichLenh(config, cauLenh, dichDen) {
  const model = splitModel(config.opencodeModel);
  const session = await call(config, "/session", {
    method: "POST",
    body: JSON.stringify({ title: "Phan tich lenh admin", agent: config.opencodeAgent || "general" }),
  });

  try {
    const danhSach = dichDen.map((d) => `- id=${d.id} | loại=${d.loai} | tên="${d.ten}"`).join("\n");
    // Model khong tu biet hom nay la ngay may. Khong dua moc hien tai vao thi
    // "mai", "thu Ba toi", "15h" deu khong the tinh ra ngay that.
    const bayGio = new Date();
    const moc =
      `Bây giờ là ${bayGio.toLocaleString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}` +
      ` (dạng máy: ${bayGio.getFullYear()}-${String(bayGio.getMonth() + 1).padStart(2, "0")}-${String(bayGio.getDate()).padStart(2, "0")} ${String(bayGio.getHours()).padStart(2, "0")}:${String(bayGio.getMinutes()).padStart(2, "0")}), giờ Việt Nam.`;

    const response = await call(config, `/session/${encodeURIComponent(session.id)}/message`, {
      method: "POST",
      body: JSON.stringify({
        agent: config.opencodeAgent || "general",
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
        tools: KHONG_TOOL,
        parts: [
          {
            type: "text",
            text: `${HUONG_DAN}\n\n# MỐC HIỆN TẠI\n${moc}\n\n# DANH SÁCH ĐÍCH ĐẾN\n${danhSach}\n\n# CÂU LỆNH\n${cauLenh}`,
          },
        ],
      }),
    });
    if (response?.info?.error) throw new Error(response.info.error?.data?.message || "OpenCode lỗi");

    const tho = extractReply(response).replace(/^```(?:json)?|```$/gim, "").trim();
    try {
      const doc = JSON.parse(tho);
      if (doc && typeof doc === "object") doc.hanhDong = chuanHoaHanhDong(doc.hanhDong);
      return doc;
    } catch {
      return { hanhDong: "khong_hieu", lyDo: "Không đọc được kết quả phân tích." };
    }
  } finally {
    await call(config, `/session/${encodeURIComponent(session.id)}`, { method: "DELETE" }).catch(() => {});
  }
}

/**
 * @param {object} message tin nhan da normalize
 * @param {(payload) => Promise<any>} gui ham gui tin (truyen tu zalo-service de tranh vong import)
 * @returns {Promise<string|null>} cau tra loi gui lai cho admin
 */
export async function xuLyLenh(message, gui, guiRiengDaTim = null) {
  const config = await getAiChatConfig();
  const noiDung = String(message.content || "").trim();
  const khoa = String(message.threadId);
  const dinhTuyenNhanQuaSo = phanLoaiLenhNhanQuaSo(noiDung);
  const lenhNhanQuaSo = dinhTuyenNhanQuaSo?.trangThai === "hop_le" ? dinhTuyenNhanQuaSo : null;
  const laLenhZoomTao = laLenhTaoZoom(noiDung);
  const laLenhZoomSua = laLenhSuaLichZoom(noiDung);
  const laLenhZoomXoa = laLenhXoaLichZoom(noiDung);
  const laLenhZoom = laLenhZoomTao || laLenhZoomSua || laLenhZoomXoa;
  const laHuyZoomCu = laLenhHuyZoomCu(noiDung);

  // Ban nhap Teach Bot dang cho OK phai chan Zoom, khong duoc bi lenh Zoom xoa.
  if (laLenhZoom && coBanNhapDay(message)) return LOI_DANG_CO_THAO_TAC_KHAC;

  // Ban nhap chi dan dang cho chi duyet - giai quyet TRUOC MOI THU KHAC.
  // Chu "OK" khong can bo phan tich de hieu, va mot cau bat ky cung phai
  // huy duoc ban nhap cu ngay tai day truoc khi di tiep.
  const ketBanNhap = await xuLyBanNhapDay(message);
  if (ketBanNhap !== null) return ketBanNhap;

  let dangCho = thaoTacChoConHan(khoa);
  let zoomDangChoCanPhanLoai = false;

  // Buoc xac nhan: chi khi dang co lenh cho san
  if (dangCho) {
    if (laXacNhanOK(noiDung)) {
      // Tieu thu TRUOC side effect. Ke ca provider khong ro ket qua, OK lan sau
      // cung khong bao gio tao lai tu pending cu.
      cho.delete(khoa);
      if (dangCho.loai === "zoom") return taoZoomTuLenh(dangCho);
      if (dangCho.loai === "zoom_update") return suaZoomTuLenh(dangCho);
      if (dangCho.loai === "zoom_delete") return xoaZoomTuLenh(dangCho);
      if (dangCho.loai === "dat_lich") return datLich(dangCho);
      if (dangCho.loai === "dat_nhac") return datNhac(dangCho);
      if (dangCho.loai === "binh_chon") return taoBinhChon(dangCho);
      if (dangCho.loai === "ghi_chu") return ghimGhiChu(dangCho);
      if (dangCho.loai === "duyet_nhom") return duyetVaoNhom(dangCho);
      if (dangCho.loai === "tao_nhom") return taoNhom(dangCho);
      if (dangCho.loai === "doi_ten_nhom") return doiTenNhom(dangCho);
      if (dangCho.loai === "them_nguoi") return themNguoi(dangCho);
      if (dangCho.loai === "xoa_nguoi") return xoaNguoi(dangCho);
      if (dangCho.loai === PHONE_USER_DIRECT_MESSAGE) return guiTinRiengTheoSo(dangCho, guiRiengDaTim);
      return guiNgay(dangCho, gui);
    } else if (TU_HUY.includes(chuanHoa(noiDung))) {
      cho.delete(khoa);
      await addLog({ event: "admin_cancel", level: "warn", summary: "Admin huỷ lệnh", detail: { loai: dangCho.loai } });
      if (dangCho.loai === "zoom") return "Đã hủy tạo cuộc họp Zoom.";
      if (dangCho.loai === "zoom_update") return "Đã hủy thao tác sửa lịch Zoom.";
      if (dangCho.loai === "zoom_delete") return "Đã hủy thao tác xóa lịch Zoom.";
      if (dangCho.loai === "dat_lich") return "Đã huỷ, em không đặt lịch nào cả.";
      if (dangCho.loai === "duyet_nhom") return "Đã huỷ, em không duyệt ai cả.";
      if (dangCho.loai === "tao_nhom") return "Đã huỷ, em không tạo nhóm nào cả.";
      if (dangCho.loai === "doi_ten_nhom") return "Đã huỷ, em không đổi tên nhóm nào cả.";
      if (dangCho.loai === "them_nguoi") return "Đã huỷ, em không thêm ai cả.";
      if (dangCho.loai === "xoa_nguoi") return "Đã huỷ, em không xoá ai cả.";
      if (dangCho.loai === PHONE_USER_DIRECT_MESSAGE) return "Đã huỷ, em không gửi tin nhắn theo số điện thoại.";
      return "Đã huỷ, em không gửi gì cả.";
    } else if (laHuyZoomCu) {
      // Day la mot reply khong lien quan: lam stale pending, nhung tuyet doi
      // khong duoc nang cap cum "Huy Zoom" thanh thao tac xoa meeting.
      cho.delete(khoa);
      return HUONG_DAN_HUY_ZOOM_CU;
    } else if (laThuXacNhanKhongHopLe(noiDung)) {
      return "Để tiếp tục, hãy trả lời OK.";
    } else if (dinhTuyenNhanQuaSo) {
      return LOI_DANG_CO_THAO_TAC_KHAC;
    } else if (laLenhZoom) {
      // Bat ky pending nao cung chan mot de xuat Zoom moi; de xuat cu khong bi
      // ghi de, ke ca pending hien tai cung la Zoom.
      return LOI_DANG_CO_THAO_TAC_KHAC;
    } else if (["zoom", "zoom_update", "zoom_delete"].includes(dangCho.loai)) {
      // Can phan biet lenh confirmable khac (phai bi chan, giu Zoom) voi mot cau
      // khong lien quan (huy Zoom stale theo hop dong P2C).
      zoomDangChoCanPhanLoai = true;
    }
    // Pending cu khong phai Zoom giu nguyen hanh vi cu: lenh moi co the thay no.
  }

  // Token xac nhan (dung hoac cu/sai) khi khong co pending: zero side effect,
  // zero parser call. App restart mat pending thi noi thang su that.
  if (!dangCho && (laXacNhanOK(noiDung) || laThuXacNhanKhongHopLe(noiDung))) {
    return "Không có thao tác nào đang chờ OK.";
  }

  // Ngon ngu cu chi nhan huong dan, khong qua AI va khong tao destructive pending.
  if (laHuyZoomCu) return HUONG_DAN_HUY_ZOOM_CU;

  // Zoom la grammar tat dinh rieng, khong qua generic AI ke ca parse bi thieu.
  if (laLenhZoomTao) return chuanBiTaoZoom(noiDung, khoa);
  if (laLenhZoomSua) return chuanBiSuaLichZoom(noiDung, khoa);
  if (laLenhZoomXoa) return chuanBiXoaLichZoom(noiDung, khoa);
  if (dinhTuyenNhanQuaSo) {
    if (!lenhNhanQuaSo) return dinhTuyenNhanQuaSo.phanHoi;
    // Terminal consumed branch: preview nay la phan hoi duy nhat cua incoming command.
    return await chuanBiNhanQuaSo(lenhNhanQuaSo, khoa);
  }

  const dichDen = await danhSachDichDen();
  if (zoomDangChoCanPhanLoai && dichDen.length === 0) {
    cho.delete(khoa);
    return cauBanXemZoomBiHuy(dangCho.loai);
  }
  if (dichDen.length === 0) return "Chưa có cuộc trò chuyện nào để gửi ạ.";

  let ketQua;
  try {
    ketQua = phanTichLenhAdminGia
      ? await phanTichLenhAdminGia(config, noiDung, dichDen)
      : await phanTichLenh(config, noiDung, dichDen);
  } catch (error) {
    if (zoomDangChoCanPhanLoai) {
      cho.delete(khoa);
      return cauBanXemZoomBiHuy(dangCho.loai);
    }
    await addLog({ event: "admin_error", level: "error", summary: `Không phân tích được lệnh: ${error.message}`, detail: { noiDung } });
    return `Em chưa hiểu được lệnh: ${error.message}`;
  }

  if (zoomDangChoCanPhanLoai) {
    if (HANH_DONG_CAN_XAC_NHAN.has(ketQua?.hanhDong)) return LOI_DANG_CO_THAO_TAC_KHAC;
    cho.delete(khoa);
    return cauBanXemZoomBiHuy(dangCho.loai);
  }

  if (ketQua?.hanhDong === "tra_mail") return traMailChoAdmin(ketQua.email || noiDung, message);
  if (ketQua?.hanhDong === "xem_lich") return xemLich();
  if (ketQua?.hanhDong === "huy_lich") return huyMotLich(ketQua.id);
  if (ketQua?.hanhDong === "dat_lich") return chuanBiDatLich(ketQua, dichDen, khoa, noiDung);
  if (ketQua?.hanhDong === "dat_nhac") return chuanBiDatNhac(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "tao_nhom") return chuanBiTaoNhom(ketQua, dichDen, khoa, message);
  if (ketQua?.hanhDong === "day_ghi_nho") return dayGhiNho(ketQua, message);
  if (ketQua?.hanhDong === "day_sua") return daySua(ketQua, message);
  if (ketQua?.hanhDong === "day_quen") return dayQuen(ketQua);
  if (ketQua?.hanhDong === "day_xem") return dayXem(ketQua);
  if (ketQua?.hanhDong === "xem_nhan") return xemNhan();
  if (ketQua?.hanhDong === "gan_nhan") return ganNhan(ketQua, dichDen);
  if (ketQua?.hanhDong === "bo_nhan") return boNhan(ketQua, dichDen);
  if (ketQua?.hanhDong === "doi_ten_nhom") return chuanBiDoiTen(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "them_vao_nhom") return chuanBiThemNguoi(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "xoa_khoi_nhom") return chuanBiXoaNguoi(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "xoa_hang_loat") {
    return [
      "Em không xoá hàng loạt được ạ.",
      "Chị nêu đích danh từng người giúp em, kiểu “xoá Thu Hà khỏi nhóm Lớp K13”.",
      `Mỗi lần em xoá tối đa ${XOA_MOI_LAN} người.`,
    ].join("\n");
  }
  if (ketQua?.hanhDong === "xem_cho_duyet") return xemChoDuyet(ketQua, dichDen);
  if (ketQua?.hanhDong === "duyet_vao_nhom") return chuanBiDuyet(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "tim_nguoi") return timNguoi(ketQua.so || noiDung, message);
  if (ketQua?.hanhDong === "ghim_ghi_chu") return chuanBiGhiChu(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "tao_binh_chon") return chuanBiBinhChon(ketQua, dichDen, khoa);
  if (ketQua?.hanhDong === "xem_binh_chon") return xemBinhChon();
  if (ketQua?.hanhDong === "chot_binh_chon") return chotBinhChon(ketQua.id);

  // Model co the tra ve dang cu (dichId le) hoac dang moi (dichIds mang).
  const idMongMuon = Array.isArray(ketQua?.dichIds)
    ? ketQua.dichIds
    : ketQua?.dichId
      ? [ketQua.dichId]
      : [];

  if (ketQua?.hanhDong !== "gui_tin" || idMongMuon.length === 0 || !ketQua.noiDung) {
    await addLog({ event: "admin_unknown", level: "warn", summary: `Không hiểu lệnh: ${noiDung.slice(0, 60)}`, detail: { ketQua } });
    // Liet ke dung nhung viec bot lam duoc. Truoc day cau nay chi noi ve gui tin,
    // nen chi hoi tra mail thieu dia chi lai bi khuyen "noi ro gui vao nhom nao".
    return [
      `Em chưa hiểu ạ${ketQua?.lyDo ? ` (${ketQua.lyDo})` : ""}.`,
      "Em làm được mấy việc này:",
      "• Gửi tin — “nhắn vào nhóm masterclass là ...”",
      "• Tìm & nhắn theo SĐT — “nhắn cho số ........: nội dung muốn nhắn”",
      "• Hẹn giờ gửi — “8h sáng 10/8 gửi nhóm masterclass là ...”",
      "• Xem lịch / huỷ lịch — “xem lịch”, “huỷ lịch 3”",
      "• Tra mail — “tra xem mail gửi abc@gmail.com chưa”",
    ].join("\n");
  }

  // Model co the bia id -> doi chieu lai voi danh sach that truoc khi chap nhan.
  // Loc trung: model hay tra ve cung mot id hai lan khi chi noi ten nhom hai kieu.
  const dsDich = [];
  const daCo = new Set();
  const khongThay = [];
  for (const id of idMongMuon) {
    const d = dichDen.find((x) => String(x.id) === String(id));
    if (!d) khongThay.push(String(id));
    else if (!daCo.has(d.id)) {
      daCo.add(d.id);
      dsDich.push(d);
    }
  }

  if (dsDich.length === 0) {
    await addLog({ event: "admin_unknown", level: "warn", summary: "Model tra ve dich den khong co that", detail: { ketQua } });
    return "Em không tìm thấy nhóm/nick đó trong danh sách. Chị nói rõ tên giúp em.";
  }

  const khan = docMucKhan(noiDung);
  cho.set(khoa, {
    loai: "gui_tin",
    dsDich,
    noiDung: ketQua.noiDung,
    khan,
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });
  await addLog({
    event: "admin_command",
    level: "info",
    summary: `Lệnh admin — chờ xác nhận gửi tới ${dsDich.length} nơi`,
    detail: { dich: dsDich, khan, noiDung: ketQua.noiDung, cauLenh: noiDung, khongThay },
  });

  const tenDich = dsDich.map((d) => `${d.loai === "nhom" ? "nhóm" : "nick"} 「${d.ten}」`);
  return [
    dsDich.length === 1
      ? `Em sẽ gửi vào ${tenDich[0]} nội dung:`
      : `Em sẽ gửi vào ${dsDich.length} nơi — ${tenDich.join(", ")} — nội dung:`,
    "",
    ketQua.noiDung,
    ...(khan ? ["", `Đánh dấu: ${TEN_KHAN[khan]}`] : []),
    ...(khongThay.length ? ["", `(Bỏ qua vì không tìm thấy: ${khongThay.join(", ")})`] : []),
    "",
    "Chị gõ OK để em gửi, hoặc HUỶ để bỏ.",
  ].join("\n");
}

async function guiNgay(dangCho, gui) {
  const xong = [];
  const hong = [];

  // Gui tung noi mot. Mot noi hong khong duoc keo do ca chum - nhom kia van
  // phai nhan duoc tin.
  for (const d of dangCho.dsDich) {
    try {
      await gui({
        threadId: d.id,
        threadType: d.loai === "nhom" ? 1 : 0,
        text: dangCho.noiDung,
        urgency: dangCho.khan || 0,
      });
      xong.push(d.ten);
    } catch (error) {
      hong.push(`${d.ten} (${error.message})`);
    }
  }

  await addLog({
    event: xong.length ? "admin_sent" : "admin_error",
    level: hong.length ? "warn" : "ok",
    summary: `Lệnh admin — gửi được ${xong.length}/${dangCho.dsDich.length} nơi`,
    detail: { xong, hong, noiDung: dangCho.noiDung, khan: dangCho.khan || 0 },
  });

  if (!xong.length) return `Em gửi không được ạ:\n${hong.map((h) => "• " + h).join("\n")}`;
  return [
    xong.length === 1 ? `Đã gửi vào "${xong[0]}" rồi ạ.` : `Đã gửi xong ${xong.length} nơi ạ:`,
    ...(xong.length > 1 ? xong.map((t) => "• " + t) : []),
    ...(hong.length ? ["", "Không gửi được:", ...hong.map((h) => "• " + h)] : []),
  ].join("\n");
}

/**
 * Kiem tra tung moc gio truoc khi cho chi duyet. Model co the tra ve gio trong
 * qua khu, ngay khong ton tai, hoac dich den bia ra - de lot mot cai la tin bay
 * vao ca nhom sai gio, ma gui roi thi khong rut lai duoc.
 */
async function chuanBiDatLich(ketQua, dichDen, khoa, cauLenh) {
  const danhSach = Array.isArray(ketQua.lich) ? ketQua.lich : [];
  if (danhSach.length === 0) return "Em không thấy mốc giờ nào trong lệnh của chị ạ.";

  const bayGioGiay = Math.floor(Date.now() / 1000);
  const hopLe = [];
  const loi = [];

  for (const [i, muc] of danhSach.entries()) {
    const dich = dichDen.find((d) => String(d.id) === String(muc.dichId));
    if (!dich) {
      loi.push(`Mục ${i + 1}: không tìm thấy nhóm/nick "${muc.dichTen || muc.dichId}"`);
      continue;
    }
    const lucGui = docMoc(muc.luc);
    if (!lucGui) {
      loi.push(`Mục ${i + 1}: không đọc được mốc giờ "${muc.luc}"`);
      continue;
    }
    if (lucGui <= bayGioGiay) {
      loi.push(`Mục ${i + 1}: ${dinhDangGio(lucGui)} đã trôi qua rồi`);
      continue;
    }
    if (!String(muc.noiDung || "").trim()) {
      loi.push(`Mục ${i + 1}: không có nội dung để gửi`);
      continue;
    }
    const lapLai = LAP_LAI_HOP_LE.includes(muc.lapLai) ? muc.lapLai || "" : "";
    hopLe.push({ dichId: dich.id, dichTen: dich.ten, loaiDich: dich.loai, noiDung: String(muc.noiDung).trim(), lucGui, lapLai });
  }

  if (hopLe.length === 0) {
    await addLog({ event: "admin_unknown", level: "warn", summary: "Đặt lịch thất bại — không mục nào hợp lệ", detail: { cauLenh, loi } });
    return "Em chưa đặt được lịch nào ạ:\n" + loi.map((l) => "• " + l).join("\n");
  }

  const khan = docMucKhan(cauLenh);
  cho.set(khoa, { loai: "dat_lich", lich: hopLe, cauLenh, khan, hetHan: Date.now() + HAN_XAC_NHAN_MS });
  await addLog({
    event: "admin_command",
    level: "info",
    summary: `Lệnh admin — chờ xác nhận đặt ${hopLe.length} lịch hẹn`,
    detail: { cauLenh, soLich: hopLe.length, loi },
  });

  const dong = hopLe.map((l, i) =>
    [
      `${i + 1}. ${dinhDangGio(l.lucGui)}${l.lapLai ? ` — lặp lại ${TEN_LAP_LAI[l.lapLai]}` : ""}${khan ? ` — đánh dấu ${TEN_KHAN[khan]}` : ""}`,
      `   → ${l.loaiDich === "nhom" ? "nhóm" : "nick"} 「${l.dichTen}」`,
      `   "${l.noiDung}"`,
    ].join("\n")
  );

  return [
    `Em ghi ${hopLe.length} lịch hẹn:`,
    "",
    dong.join("\n\n"),
    ...(loi.length ? ["", "Bỏ qua vì lỗi:", ...loi.map((l) => "• " + l)] : []),
    "",
    "Chị kiểm lại ngày giờ giúp em. Gõ OK để đặt, HUỶ để bỏ.",
  ].join("\n");
}

async function datLich(dangCho) {
  const daDat = [];
  for (const l of dangCho.lich) {
    const lich = await themLichHen(layChuTaiKhoan(), {
      dichId: l.dichId,
      dichTen: l.dichTen,
      loai: l.loaiDich,
      noiDung: l.noiDung,
      lucGui: l.lucGui,
      lapLai: l.lapLai,
      cauLenh: dangCho.cauLenh,
      khan: dangCho.khan || 0,
    });
    daDat.push(lich);
  }
  await addLog({
    event: "lich_dat",
    level: "ok",
    summary: `Đã đặt ${daDat.length} lịch hẹn theo lệnh admin`,
    detail: { soLich: daDat.length, lich: daDat.map((l) => ({ id: l.id, dichTen: l.dichTen, luc: dinhDangGio(l.lucGui) })) },
  });

  return [
    `Đã đặt xong ${daDat.length} lịch ạ:`,
    ...daDat.map((l) => `#${l.id} — ${dinhDangGio(l.lucGui)} → 「${l.dichTen}」`),
    "",
    'Chị nhắn "xem lịch" để xem lại, hoặc "huỷ lịch <số>" để bỏ.',
  ].join("\n");
}

/**
 * Tra cuu mail cho CHINH CHU SHOP. Khac han cach tra loi khach:
 * chi duoc nghe thang su that - ke ca "khong tim thay", ke ca tieu de thu.
 * Khach thi khong bao gio duoc nghe "chua gui" (xem email-check.js).
 *
 * Khong can buoc xac nhan OK: tra cuu chi la doc, khong gui gi cho ai.
 */
async function traMailChoAdmin(chuoiCoEmail, message) {
  const email = emailCheck.timEmailTrongTin(chuoiCoEmail);
  if (!email) return "Chị cho em địa chỉ email cần tra giúp em ạ.";

  const ketQua = await emailCheck.traCuu({
    email,
    nguon: "admin_zalo",
    nguoiHoiTen: message?.senderName || "Chị",
    nguoiHoiUid: message?.senderId || "",
  });

  if (!ketQua) {
    return "Em chưa nối được với hộp mail Zoho ạ. Chị vào phân hệ Email trong app kết nối giúp em, hoặc bật lại tính năng tra cứu.";
  }

  if (ketQua.trangThai === "da_gui") {
    return [
      `Mail gửi tới ${email} vào lúc ${dinhDangGio(ketQua.guiLuc)} ạ.`,
      ketQua.tieuDe ? `Tiêu đề: 「${ketQua.tieuDe}」` : "",
      "Thư đi thành công, không có báo lỗi trả về.",
    ].filter(Boolean).join("\n");
  }

  if (ketQua.trangThai === "tra_ve") {
    return [
      `Mail gửi tới ${email} vào lúc ${dinhDangGio(ketQua.guiLuc)}, NHƯNG BỊ TRẢ VỀ lúc ${dinhDangGio(ketQua.traVeLuc)} ạ.`,
      ketQua.tieuDe ? `Tiêu đề: 「${ketQua.tieuDe}」` : "",
      "Nhiều khả năng địa chỉ sai. Chị kiểm lại giúp em rồi gửi lại nhé.",
    ].filter(Boolean).join("\n");
  }

  if (ketQua.trangThai === "khong_thay") {
    return `Em KHÔNG tìm thấy thư nào đã gửi tới ${email} trong hộp Đã gửi ạ. Có khi mình chưa gửi.`;
  }

  return `Em không tra cứu được ạ: ${ketQua.moTa}`;
}

/**
 * Loi nhac cua CHINH ZALO - khac han lich hen cua app.
 *  - Lich hen cua app: bot gui mot tin nhan dung gio.
 *  - Loi nhac Zalo: hien the nhac trong nhom, Zalo tu day thong bao cho MOI
 *    thanh vien, va no nam lai trong muc Nhac hen cua nhom.
 * Nen "nhac ca lop 15h vao zoom" thi dung cai nay moi dung viec.
 */
async function chuanBiDatNhac(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm/nick đó trong danh sách. Chị nói rõ tên giúp em.";

  const tieuDe = String(ketQua.tieuDe || "").trim();
  if (!tieuDe) return "Chị cho em nội dung cần nhắc là gì ạ.";

  const lucGui = docMoc(ketQua.luc);
  if (!lucGui) return `Em không đọc được mốc giờ "${ketQua.luc}" ạ.`;
  if (lucGui <= Math.floor(Date.now() / 1000)) return `${dinhDangGio(lucGui)} đã trôi qua rồi ạ.`;

  const lapLai = Object.prototype.hasOwnProperty.call(MA_LAP_ZALO, ketQua.lapLai) ? ketQua.lapLai || "" : "";

  cho.set(khoa, {
    loai: "dat_nhac",
    dichId: dich.id,
    dichTen: dich.ten,
    loaiDich: dich.loai,
    tieuDe,
    lucGui,
    lapLai,
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });

  return [
    `Em sẽ tạo LỜI NHẮC CỦA ZALO trong ${dich.loai === "nhom" ? "nhóm" : "nick"} 「${dich.ten}」:`,
    "",
    `⏰ ${tieuDe}`,
    `   ${dinhDangGio(lucGui)}${lapLai ? ` — lặp lại ${TEN_LAP_LAI[lapLai]}` : ""}`,
    "",
    "Khác với lịch hẹn: cái này Zalo đẩy thông báo cho cả nhóm và nằm lại ở mục Nhắc hẹn.",
    "Chị gõ OK để tạo, HUỶ để bỏ.",
  ].join("\n");
}

let taoNhacZalo = null;
/** zalo-service gan ham nay vao de tranh vong import. */
/** zalo-service tiem ham lay uid tai khoan dang dang nhap vao day. */
let layChuTaiKhoan = () => null;
export function capHinhChuTaiKhoan(fn) {
  layChuTaiKhoan = fn;
}

export function capHinhTaoNhac(fn) {
  taoNhacZalo = fn;
}

async function datNhac(dangCho) {
  if (!taoNhacZalo) return "Em chưa nối được với Zalo để tạo lời nhắc ạ.";
  try {
    await taoNhacZalo({
      threadId: dangCho.dichId,
      threadType: dangCho.loaiDich === "nhom" ? 1 : 0,
      tieuDe: dangCho.tieuDe,
      lucGui: dangCho.lucGui,
      maLap: MA_LAP_ZALO[dangCho.lapLai] ?? 0,
    });
    await addLog({
      event: "nhac_zalo",
      level: "ok",
      summary: `Đã tạo lời nhắc Zalo trong "${dangCho.dichTen}": ${dangCho.tieuDe}`,
      detail: { dichTen: dangCho.dichTen, tieuDe: dangCho.tieuDe, luc: dinhDangGio(dangCho.lucGui), lapLai: dangCho.lapLai },
    });
    return [
      `Đã tạo lời nhắc trong 「${dangCho.dichTen}」 ạ:`,
      `⏰ ${dangCho.tieuDe} — ${dinhDangGio(dangCho.lucGui)}${dangCho.lapLai ? ` (${TEN_LAP_LAI[dangCho.lapLai]})` : ""}`,
      "Cả nhóm sẽ nhận được thông báo của Zalo khi tới giờ.",
    ].join("\n");
  } catch (error) {
    await addLog({ event: "nhac_zalo", level: "error", summary: `Tạo lời nhắc thất bại — ${error.message}`, detail: { dangCho } });
    return `Em tạo lời nhắc không được ạ: ${error.message}`;
  }
}

/* --- DAY BOT: CHI DAN RIENG CHO TUNG NGUOI ---
 *
 * Admin dan bot mot quy tac rieng cho mot lien he chat 1-1 bat ky cua chinh tai
 * khoan Zalo do. Quy tac ay phai song qua restart, phai dung ve DUNG mot nguoi,
 * va khong duoc AI ghi de. Vi vay no nam o cot rieng
 * customer_memory.owner_instruction chu khong phai trong profile.
 */

/** Tran do dai chi dan. Vuot thi TU CHOI, khong bao gio tu cat bot. */
export const MAX_CHI_DAN = 300;

/** Chuan hoa CHI de SO SANH (ten nguoi, quy tac trung). Khong dung de luu. */
function chuanHoaDeSo(text) {
  return String(text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/* --- BAN NHAP CHO ADMIN XAC NHAN ---
 *
 * Vi sao phai co: bo phan tich la mot model, no co the hieu lech mot menh de
 * trong cau chi dan. Ghi thang xuong CSDL nghia la bot doi cach noi voi mot
 * nguoi that ma admin khong kip biet. Nen bay gio bot doc lai dung cau sap nho,
 * cho admin go "OK" roi moi ghi.
 *
 * CHI NAM TRONG BO NHO, co y khong luu xuong dau ca: app khoi dong lai giua
 * chung thi ban nhap mat va CSDL van sach - dung hon la mot ban nhap cu bat
 * ngo duoc ghi sau khi restart.
 */
const choDay = new Map(); // "<owner_uid>::<uid admin>" -> { hanhDong, uid, ten, quyTac }

/** Khoa theo CA chu tai khoan LAN nick admin: hai tai khoan khong dung chung. */
function khoaBanNhap(ownerUid, senderId) {
  return `${String(ownerUid || "")}::${String(senderId || "")}`;
}

/** Chi exact OK (sau trim, khong phan biet hoa/thuong) moi la dong y. */
/** Bo dau roi nen "Hủy"/"Không"/"Sai rồi" deu roi vao day. */
const CHU_BO_BAN_NHAP = new Set(["huy", "khong", "sai roi"]);

/**
 * Cau dan cho CA LANG chu khong cho rieng ai. V1 khong duoc bien nhung cau nay
 * thanh chi dan cua mot nguoi: gan nham thi bot se di xung "con" voi mot khach
 * hoan toan xa la. Doi cach noi voi moi khach la viec cua Soul.
 *
 * Dung lai bocDau() san co ben duoi (bo dau + thuong hoa + gop khoang trang).
 */
const RE_TOAN_CUC = /(^|\s)(moi khach|moi nguoi|tat ca|ai cung|khach nao cung|nguoi nao cung|toan bo)(\s|$)/;
function laDichToanCuc(ten) {
  const s = bocDau(ten);
  if (!s) return true;
  return RE_TOAN_CUC.test(s);
}

function dungKetQuaTim(thread) {
  // V1 khong day duoc cho nhom: xung "con" giua nhom dong nguoi la lo quan he
  // rieng cua chi truoc mat nguoi la.
  if (Number(thread.threadType) === 1) {
    return { ok: false, ma: "la_nhom", ten: thread.title || String(thread.id) };
  }
  return { ok: true, uid: String(thread.id), ten: thread.title || String(thread.id) };
}

/**
 * Quy TEN chi noi ra UID chuan. TAT DINH hoan toan - model chi duoc phep noi
 * TEN, con viec quy ra UID la viec cua ma nay. Khong mo phong, khong do gan
 * giong, khong tu chon nguoi nhan tin gan day nhat.
 *
 * recentOnly:false la co chu dich: chi phai day duoc ve mot nguoi lau roi khong
 * nhan tin, chu khong chi nhung ai vua noi chuyen.
 */
async function timNguoiDeDay(dichTen) {
  const raw = String(dichTen || "").trim();
  if (laDichToanCuc(raw)) return { ok: false, ma: "toan_cuc" };

  const chu = layChuTaiKhoan();
  if (!chu) return { ok: false, ma: "chua_dang_nhap" };

  const threads = await listThreads(chu, { recentOnly: false });

  // 1. Trung khop UID TUYET DOI. Khong mot phan, khong tien to.
  const theoUid = threads.filter((t) => String(t.id) === raw);
  if (theoUid.length === 1) return dungKetQuaTim(theoUid[0]);

  // 2. Trung khop TEN sau chuan hoa, van la trung khop TUYET DOI.
  const can = chuanHoaDeSo(raw);
  const theoTen = threads.filter((t) => chuanHoaDeSo(t.title) === can);
  if (theoTen.length === 0) return { ok: false, ma: "khong_thay", ten: raw };
  // Hai nguoi cung ten thi KHONG doan. Ghi nham vao ho so nguoi khac con te hon
  // la bat chi noi lai mot lan.
  if (theoTen.length > 1) return { ok: false, ma: "trung_ten", ten: raw, soNguoi: theoTen.length };
  return dungKetQuaTim(theoTen[0]);
}

function loiTimNguoi(kq) {
  if (kq.ma === "toan_cuc") {
    return [
      "Đây là quy tắc chung cho toàn bot, không phải chỉ dẫn riêng cho một người.",
      "Phiên bản này chưa hỗ trợ thay đổi quy tắc chung bằng lệnh chat.",
      "Hãy sửa trong Cài đặt → AI Chat → Soul.",
    ].join("\n");
  }
  if (kq.ma === "chua_dang_nhap") {
    return "Em chưa rõ đang đăng nhập tài khoản Zalo nào nên chưa ghi được.";
  }
  if (kq.ma === "la_nhom") {
    return [
      `「${kq.ten}」 là một nhóm.`,
      "Hiện tính năng này chỉ hỗ trợ chỉ dẫn riêng cho từng người, chưa áp dụng cho nhóm.",
    ].join("\n");
  }
  if (kq.ma === "trung_ten") {
    return [
      `Có nhiều liên hệ trùng tên 「${kq.ten}」 (${kq.soNguoi} người) nên em chưa ghi.`,
      "Hãy gửi lại kèm UID Zalo để em xác định đúng người.",
    ].join("\n");
  }
  return `Em không tìm thấy liên hệ 「${kq.ten}」 trong danh sách trò chuyện.`;
}

/**
 * Dat ban nhap va soan cau doc lai cho admin duyet.
 *
 * Cau doc lai PHAI chua dung chuoi quyTac sap luu, khong duoc tom tat lan hai:
 * noi mot dang roi luu mot dang khac thi buoc xac nhan mat het y nghia.
 */
function datBanNhap(message, nhap) {
  const chu = layChuTaiKhoan();
  choDay.set(khoaBanNhap(chu, message?.senderId), nhap);
}

function coBanNhapDay(message) {
  return choDay.has(khoaBanNhap(layChuTaiKhoan(), message?.senderId));
}

/**
 * Da co mot thao tac khac (gui tin, dat lich, tao nhom...) dang cho xac nhan
 * trong chinh cuoc tro chuyen nay hay chua?
 *
 * Vi sao phai hoi: chi co MOT token "OK". De hai thu cung cho thi token do
 * khong con biet minh dang duyet cai nao. Truoc day lenh day am tham xoa thao
 * tac cu di - lam vay la tu quyet thay admin, va mot tin dang cho gui co the
 * bien mat ma khong ai biet. Gio thi lenh day chiu nhuong: thao tac cu duoc giu
 * nguyen, lenh day bi tu choi, admin tu chon xu ly cai nao truoc.
 *
 * Dung CHINH so `cho` san co lam nguon su that, khong de ra so thu hai.
 */
function coThaoTacDangCho(message) {
  const dang = cho.get(String(message?.threadId));
  if (!dang) return false;
  // Qua han thi coi nhu khong con - dung dung nghia voi nhanh o dau xuLyLenh.
  return Date.now() <= dang.hetHan;
}

function cauDocLai(ten, quyTac, laSua) {
  return [
    laSua
      ? `Em hiểu bạn muốn SỬA LẠI TOÀN BỘ chỉ dẫn về 「${ten}」 thành:`
      : `Em hiểu bạn muốn em ghi nhớ với 「${ten}」 là:`,
    "",
    `“${quyTac}”`,
    "",
    'Nếu đúng, hãy trả lời “OK” để em lưu. Nếu sai, hãy nhắn “sai rồi”.',
  ].join("\n");
}

async function dayGhiNho(ketQua, message) {
  const nguoi = await timNguoiDeDay(ketQua?.dichTen);
  if (!nguoi.ok) return loiTimNguoi(nguoi);

  // Mot quy tac = mot dong. Gop khoang trang lai de phep so trung ben duoi
  // khong bi mot dau xuong dong lam hong.
  const quyTac = String(ketQua?.quyTac || "").trim().replace(/\s+/g, " ");
  if (!quyTac) return `Bạn muốn em ghi nhớ điều gì về 「${nguoi.ten}」?`;

  const chu = layChuTaiKhoan();
  const cu = await getOwnerInstruction(chu, nguoi.uid);

  // Da nho roi thi khong bat xac nhan mot viec khong can lam.
  const daCo = cu.split("\n").map(chuanHoaDeSo).filter(Boolean);
  if (daCo.includes(chuanHoaDeSo(quyTac))) {
    return `Em đã ghi nhớ đúng điều này về 「${nguoi.ten}」 từ trước rồi.`;
  }

  const moi = cu.trim() ? `${cu.trim()}\n${quyTac}` : quyTac;
  // Tran tinh tren GIA TRI CUOI CUNG, ke ca dau xuong dong noi giua.
  if (moi.length > MAX_CHI_DAN) {
    return [
      `Ghi thêm câu này thì chỉ dẫn về 「${nguoi.ten}」 dài ${moi.length} ký tự, quá mức ${MAX_CHI_DAN} nên em chưa ghi.`,
      "Em giữ nguyên chỉ dẫn cũ, không cắt bớt chữ nào.",
      `Hãy dùng “sửa chỉ dẫn về ${nguoi.ten} thành ...” để viết lại ngắn hơn.`,
    ].join("\n");
  }

  // Mot token "OK" chi duoc ung voi MOT thao tac. Dang co thao tac khac cho
  // thi lenh day chiu nhuong, KHONG dung den thao tac do.
  if (coThaoTacDangCho(message)) return LOI_DANG_CO_THAO_TAC_KHAC;

  // Moi thu deu hop le -> van CHUA ghi. Doc lai cho admin duyet da.
  datBanNhap(message, { hanhDong: "day_ghi_nho", uid: nguoi.uid, ten: nguoi.ten, quyTac });
  return cauDocLai(nguoi.ten, quyTac, false);
}

async function daySua(ketQua, message) {
  const nguoi = await timNguoiDeDay(ketQua?.dichTen);
  if (!nguoi.ok) return loiTimNguoi(nguoi);

  const quyTac = String(ketQua?.quyTac || "").trim().replace(/\s+/g, " ");
  if (!quyTac) return `Bạn muốn sửa chỉ dẫn về 「${nguoi.ten}」 thành gì?`;
  if (quyTac.length > MAX_CHI_DAN) {
    return [
      `Nội dung mới dài ${quyTac.length} ký tự, quá mức ${MAX_CHI_DAN} nên em chưa ghi.`,
      "Em giữ nguyên chỉ dẫn cũ, không cắt bớt chữ nào.",
    ].join("\n");
  }

  if (coThaoTacDangCho(message)) return LOI_DANG_CO_THAO_TAC_KHAC;

  datBanNhap(message, { hanhDong: "day_sua", uid: nguoi.uid, ten: nguoi.ten, quyTac });
  return cauDocLai(nguoi.ten, quyTac, true);
}

/**
 * Admin da go "OK" -> gio moi duoc ghi.
 *
 * CO Y doc lai gia tri hien tai tu CSDL thay vi tin ban chup luc xem truoc:
 * giua luc doc lai va luc xac nhan, chi dan co the da doi (sua tay tren giao
 * dien, hoac mot ban nhap khac vua duoc ghi). Kiem lai trung lap va tran 300
 * mot lan nua roi moi ghi.
 */
async function ghiBanNhap(nhap) {
  const chu = layChuTaiKhoan();
  if (!chu) return "Em chưa rõ đang đăng nhập tài khoản Zalo nào nên chưa ghi được.";

  try {
    if (nhap.hanhDong === "day_sua") {
      if (nhap.quyTac.length > MAX_CHI_DAN) {
        return `Nội dung dài ${nhap.quyTac.length} ký tự, quá mức ${MAX_CHI_DAN} nên em chưa ghi. Chỉ dẫn cũ giữ nguyên.`;
      }
      await setOwnerInstruction(chu, { uid: nhap.uid, instruction: nhap.quyTac, displayName: nhap.ten });
      await addLog({
        event: "day_po",
        level: "ok",
        summary: `Admin xác nhận sửa chỉ dẫn về "${nhap.ten}"`,
        detail: { uid: nhap.uid, ten: nhap.ten, quyTac: nhap.quyTac },
      });
      return [`Em đã cập nhật rồi. Chỉ dẫn về 「${nhap.ten}」 giờ là:`, nhap.quyTac].join("\n");
    }

    const cu = await getOwnerInstruction(chu, nhap.uid);
    const daCo = cu.split("\n").map(chuanHoaDeSo).filter(Boolean);
    if (daCo.includes(chuanHoaDeSo(nhap.quyTac))) {
      return `Chỉ dẫn này đã có sẵn cho 「${nhap.ten}」, em không ghi thêm.`;
    }
    const moi = cu.trim() ? `${cu.trim()}\n${nhap.quyTac}` : nhap.quyTac;
    if (moi.length > MAX_CHI_DAN) {
      return [
        `Lúc này chỉ dẫn về 「${nhap.ten}」 sẽ dài ${moi.length} ký tự, quá mức ${MAX_CHI_DAN} nên em chưa ghi.`,
        "Em giữ nguyên chỉ dẫn cũ, không cắt bớt chữ nào.",
      ].join("\n");
    }
    await setOwnerInstruction(chu, { uid: nhap.uid, instruction: moi, displayName: nhap.ten });
    await addLog({
      event: "day_po",
      level: "ok",
      summary: `Admin xác nhận dạy thêm về "${nhap.ten}": ${nhap.quyTac.slice(0, 60)}`,
      detail: { uid: nhap.uid, ten: nhap.ten, quyTac: nhap.quyTac, tongDai: moi.length },
    });
    return [`Em đã ghi nhớ rồi. Từ giờ với 「${nhap.ten}」 em sẽ theo:`, moi].join("\n");
  } catch (error) {
    // Ghi hong thi phai noi that. Bao "da nho" trong khi CSDL khong co gi con
    // te hon la bao loi: admin se tin la bot da doi cach noi, ma no thi khong.
    await addLog({
      event: "day_po",
      level: "error",
      summary: `Không lưu được chỉ dẫn về "${nhap.ten}" — ${error.message}`,
      detail: { uid: nhap.uid, ten: nhap.ten, error: error.message },
    }).catch(() => {});
    return `Em chưa lưu được chỉ dẫn. Hãy thử dạy lại giúp em. (${error.message})`;
  }
}

/**
 * Chan tren cung cua xuLyLenh: giai quyet ban nhap dang cho TRUOC khi dong den
 * bo phan tich. Chu "OK" khong can AI de hieu.
 *
 * Tra ve chuoi -> da xu ly xong, xuLyLenh tra ve ngay.
 * Tra ve null  -> khong con gi dang cho, di tiep luong binh thuong.
 */
async function xuLyBanNhapDay(message) {
  const khoa = khoaBanNhap(layChuTaiKhoan(), message?.senderId);
  const nhap = choDay.get(khoa);
  if (!nhap) return null;

  const cau = bocDau(message?.content);

  if (laXacNhanOK(message?.content)) {
    choDay.delete(khoa); // dung mot lan roi bo, du ghi duoc hay khong
    return ghiBanNhap(nhap);
  }
  if (CHU_BO_BAN_NHAP.has(cau)) {
    choDay.delete(khoa);
    await addLog({
      event: "day_po",
      level: "warn",
      summary: `Admin bỏ bản nháp chỉ dẫn về "${nhap.ten}"`,
      detail: { uid: nhap.uid, ten: nhap.ten },
    });
    return "Em chưa lưu nội dung đó.";
  }
  if (laThuXacNhanKhongHopLe(message?.content)) {
    return "Để tiếp tục, hãy trả lời OK.";
  }

  // Cau khac hoan toan: bo ban nhap cu TRUOC roi moi xu ly cau moi. Khong de
  // mot ban nhap tu nay giờ nam cho, roi vai phut sau mot chu "OK" lac
  // vao lam ghi nham.
  choDay.delete(khoa);
  return null;
}

async function dayQuen(ketQua) {
  const nguoi = await timNguoiDeDay(ketQua?.dichTen);
  if (!nguoi.ok) return loiTimNguoi(nguoi);

  let kq;
  try {
    kq = await clearOwnerInstruction(layChuTaiKhoan(), nguoi.uid);
  } catch (error) {
    return `Em chưa quên được: ${error.message}`;
  }
  if (!kq.changes) {
    return `Hiện chưa có chỉ dẫn riêng nào cho 「${nguoi.ten}」 nên không có gì để quên.`;
  }
  await addLog({
    event: "day_po",
    level: "warn",
    summary: `Admin cho quên hết chỉ dẫn về "${nguoi.ten}"`,
    detail: { uid: nguoi.uid, ten: nguoi.ten },
  });
  return `Em đã quên hết chỉ dẫn riêng về 「${nguoi.ten}」. Từ giờ em nói chuyện như với khách bình thường.`;
}

async function dayXem(ketQua) {
  const nguoi = await timNguoiDeDay(ketQua?.dichTen);
  if (!nguoi.ok) return loiTimNguoi(nguoi);

  // Chi tra ve dung chi dan. Khong kem ho so, khong kem lich su tin nhan.
  const chiDan = await getOwnerInstruction(layChuTaiKhoan(), nguoi.uid);
  if (!chiDan.trim()) return `Hiện chưa có chỉ dẫn riêng nào cho 「${nguoi.ten}」.`;
  return [`Bạn đã dặn em về 「${nguoi.ten}」:`, chiDan.trim()].join("\n");
}

/* --- NHAN HOI THOAI --- */

let nhanZalo = null;
export function capHinhNhan(fns) {
  nhanZalo = fns;
}

async function xemNhan() {
  if (!nhanZalo?.xem) return "Em chưa nối được với Zalo ạ.";
  try {
    const { nhan } = await nhanZalo.xem();
    if (!nhan.length) return "Chị chưa có nhãn nào ạ.";
    return [
      `Chị đang có ${nhan.length} nhãn:`,
      ...nhan.map((l) => `   • ${l.ten} — ${l.soHoiThoai ? `${l.soHoiThoai} hội thoại` : "chưa gắn cho ai"}`),
    ].join("\n");
  } catch (error) {
    return `Em xem không được ạ: ${error.message}`;
  }
}

async function ganNhan(ketQua, dichDen) {
  if (!nhanZalo?.gan) return "Em chưa nối được với Zalo ạ.";

  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy cuộc trò chuyện đó ạ.";
  const ten = String(ketQua.nhan || "").trim();
  if (!ten) return 'Chị cho em biết gắn nhãn gì ạ, kiểu "gắn nhãn coaching cho Ngọc Bích".';

  try {
    const kq = await nhanZalo.gan(ten, dich.id);
    await addLog({
      event: "gan_nhan",
      level: "ok",
      summary: `Gắn nhãn "${ten}" cho "${dich.ten}"`,
      detail: { nhan: ten, dichTen: dich.ten, dichId: dich.id, laNhanMoi: kq.laNhanMoi, daCo: kq.daCo },
    });
    if (kq.daCo) return `「${dich.ten}」 đã có nhãn 「${ten}」 từ trước rồi ạ.`;
    return kq.laNhanMoi
      ? `Đã tạo nhãn mới 「${ten}」 và gắn cho 「${dich.ten}」 ạ.`
      : `Đã gắn nhãn 「${ten}」 cho 「${dich.ten}」 ạ.`;
  } catch (error) {
    return `Em gắn không được ạ: ${error.message}`;
  }
}

async function boNhan(ketQua, dichDen) {
  if (!nhanZalo?.bo) return "Em chưa nối được với Zalo ạ.";

  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy cuộc trò chuyện đó ạ.";
  const ten = String(ketQua.nhan || "").trim();
  if (!ten) return "Chị cho em biết bỏ nhãn gì ạ.";

  try {
    const kq = await nhanZalo.bo(ten, dich.id);
    await addLog({
      event: "bo_nhan",
      level: "ok",
      summary: `Bỏ nhãn "${ten}" khỏi "${dich.ten}"`,
      detail: { nhan: ten, dichTen: dich.ten, dichId: dich.id, coGan: kq.coGan },
    });
    return kq.coGan
      ? `Đã bỏ nhãn 「${ten}」 khỏi 「${dich.ten}」 ạ.`
      : `「${dich.ten}」 vốn không có nhãn 「${ten}」 ạ, em không đổi gì cả.`;
  } catch (error) {
    return `Em bỏ không được ạ: ${error.message}`;
  }
}

/* --- DOI TEN NHOM --- */

async function chuanBiDoiTen(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ.";
  if (dich.loai !== "nhom") return "Chỉ nhóm mới đổi tên được ạ.";
  if (!nhomZalo?.doiTen) return "Em chưa nối được với Zalo ạ.";

  const tenMoi = String(ketQua.tenMoi || "").trim().slice(0, TEN_NHOM_MAX);
  if (!tenMoi) return 'Chị cho em biết tên mới ạ, kiểu "đổi tên nhóm Lớp K13 thành Lớp K13 - Nâng cao".';
  if (tenMoi === dich.ten) return `Nhóm đang mang đúng tên 「${tenMoi}」 rồi ạ.`;

  cho.set(khoa, {
    loai: "doi_ten_nhom",
    dichId: dich.id,
    dichTen: dich.ten,
    tenMoi,
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });

  return [
    "Em sẽ đổi tên nhóm:",
    `   từ 「${dich.ten}」`,
    `   thành 「${tenMoi}」`,
    "",
    "Cả nhóm sẽ thấy dòng báo đổi tên.",
    "Chị gõ OK để đổi, HUỶ để bỏ.",
  ].join("\n");
}

async function doiTenNhom(dangCho) {
  if (!nhomZalo?.doiTen) return "Em chưa nối được với Zalo ạ.";
  try {
    const kq = await nhomZalo.doiTen(dangCho.dichId, dangCho.tenMoi);
    await addLog({
      event: "doi_ten_nhom",
      level: "ok",
      summary: `Đổi tên nhóm "${kq.tenCu}" thành "${kq.tenMoi}"`,
      detail: { groupId: dangCho.dichId, tenCu: kq.tenCu, tenMoi: kq.tenMoi },
    });
    return `Đã đổi tên nhóm 「${kq.tenCu}」 thành 「${kq.tenMoi}」 ạ.`;
  } catch (error) {
    return `Em đổi không được ạ: ${error.message}`;
  }
}

/* --- THEM / XOA NGUOI KHOI NHOM --- */

/** Xoa nham thi nguoi ta thay ngay va phai moi lai tu dau, nen chan so luong. */
const XOA_MOI_LAN = 5;

function bocDau(s) {
  return String(s || "").normalize("NFD").toLowerCase().replace(/đ/g, "d").replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Khop ten admin go voi ten that trong nhom: khop tron truoc, roi moi khop mot phan. */
function timTheoTen(ten, danhSach) {
  const can = bocDau(ten);
  if (!can) return [];
  const tron = danhSach.filter((n) => bocDau(n.ten) === can);
  if (tron.length) return tron;
  return danhSach.filter((n) => bocDau(n.ten).includes(can));
}

async function chuanBiThemNguoi(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ.";
  if (dich.loai !== "nhom") return "Chỉ thêm người vào nhóm được thôi ạ.";
  if (!nhomZalo?.them) return "Em chưa nối được với Zalo ạ.";

  const chon = [];
  const khongThay = [];
  for (const id of Array.isArray(ketQua.thanhVien) ? ketQua.thanhVien : []) {
    const d = dichDen.find((x) => String(x.id) === String(id) && x.loai === "nick");
    if (!d) khongThay.push(String(id));
    else if (!chon.some((c) => c.id === d.id)) chon.push(d);
  }

  if (!chon.length) {
    return [
      "Em chưa rõ thêm ai ạ.",
      "Em chỉ thêm được người đã từng nhắn tin với bot thôi.",
    ].join("\n");
  }

  cho.set(khoa, {
    loai: "them_nguoi",
    dichId: dich.id,
    dichTen: dich.ten,
    chon,
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });

  return [
    `Em sẽ thêm ${chon.length} người vào nhóm 「${dich.ten}」:`,
    ...chon.map((d) => `   • ${d.ten}`),
    ...(khongThay.length ? ["", `(Không tìm thấy: ${khongThay.join(", ")})`] : []),
    "",
    "Chị gõ OK để thêm, HUỶ để bỏ.",
  ].join("\n");
}

async function themNguoi(dangCho) {
  if (!nhomZalo?.them) return "Em chưa nối được với Zalo ạ.";
  try {
    const kq = await nhomZalo.them(dangCho.dichId, dangCho.chon.map((d) => d.id));
    const ten = new Map(dangCho.chon.map((d) => [String(d.id), d.ten]));
    const xong = kq.filter((x) => x.xong);
    const hong = kq.filter((x) => !x.xong);

    await addLog({
      event: "them_vao_nhom",
      level: hong.length ? "warn" : "ok",
      summary: `Thêm ${xong.length}/${kq.length} người vào "${dangCho.dichTen}"`,
      detail: { dichTen: dangCho.dichTen, kq },
    });

    return [
      `Đã thêm ${xong.length}/${kq.length} người vào 「${dangCho.dichTen}」 ạ.`,
      ...xong.map((x) => `   ✓ ${ten.get(x.uid) || x.uid}`),
      ...(hong.length ? ["", "Không thêm được:", ...hong.map((x) => `   ✗ ${ten.get(x.uid) || x.uid} — ${x.moTa}`)] : []),
    ].join("\n");
  } catch (error) {
    return `Em thêm không được ạ: ${error.message}`;
  }
}

async function chuanBiXoaNguoi(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ.";
  if (dich.loai !== "nhom") return "Chỉ xoá người khỏi nhóm được thôi ạ.";
  if (!nhomZalo?.xoa || !nhomZalo?.thanhVien) return "Em chưa nối được với Zalo ạ.";

  const xin = (Array.isArray(ketQua.ten) ? ketQua.ten : [ketQua.ten]).filter(Boolean);
  if (!xin.length) return 'Chị nói rõ xoá ai giúp em ạ, kiểu "xoá Thu Hà khỏi nhóm Lớp K13".';
  if (xin.length > XOA_MOI_LAN) return `Một lần em chỉ xoá tối đa ${XOA_MOI_LAN} người thôi ạ, cho chắc.`;

  let thanhVien;
  try {
    thanhVien = await nhomZalo.thanhVien(dich.id);
  } catch (error) {
    return `Em không đọc được danh sách thành viên ạ: ${error.message}`;
  }

  const chon = [];
  const khongThay = [];
  const nhapNhem = [];
  for (const t of xin) {
    const khop = timTheoTen(t, thanhVien);
    if (!khop.length) khongThay.push(t);
    else if (khop.length > 1) nhapNhem.push({ go: t, ten: khop.map((k) => k.ten) });
    else if (!chon.some((c) => c.uid === khop[0].uid)) chon.push(khop[0]);
  }

  if (nhapNhem.length) {
    return [
      "Có tên trùng nhau nên em chưa dám xoá ạ:",
      ...nhapNhem.map((n) => `   "${n.go}" khớp với: ${n.ten.join(" / ")}`),
      "",
      "Chị ghi đầy đủ tên giúp em.",
    ].join("\n");
  }
  if (!chon.length) {
    return [`Không tìm thấy ai tên như vậy trong nhóm 「${dich.ten}」 ạ:`, ...khongThay.map((t) => `   • ${t}`)].join("\n");
  }

  cho.set(khoa, {
    loai: "xoa_nguoi",
    dichId: dich.id,
    dichTen: dich.ten,
    chon,
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });

  return [
    `Em sẽ XOÁ ${chon.length} người khỏi nhóm 「${dich.ten}」:`,
    ...chon.map((n) => `   • ${n.ten}`),
    ...(khongThay.length ? ["", `(Không tìm thấy: ${khongThay.join(", ")})`] : []),
    "",
    "Người bị xoá thấy ngay, muốn vào lại thì phải mời lại từ đầu.",
    "Chị gõ OK để xoá, HUỶ để bỏ.",
  ].join("\n");
}

async function xoaNguoi(dangCho) {
  if (!nhomZalo?.xoa) return "Em chưa nối được với Zalo ạ.";
  try {
    const kq = await nhomZalo.xoa(dangCho.dichId, dangCho.chon.map((n) => n.uid));
    const ten = new Map(dangCho.chon.map((n) => [String(n.uid), n.ten]));
    const xong = kq.filter((x) => x.xong);
    const hong = kq.filter((x) => !x.xong);

    await addLog({
      event: "xoa_khoi_nhom",
      level: hong.length ? "warn" : "ok",
      summary: `Xoá ${xong.length}/${kq.length} người khỏi "${dangCho.dichTen}"`,
      detail: { dichTen: dangCho.dichTen, kq: kq.map((x) => ({ ...x, ten: ten.get(x.uid) })) },
    });

    return [
      `Đã xoá ${xong.length}/${kq.length} người khỏi 「${dangCho.dichTen}」 ạ.`,
      ...xong.map((x) => `   ✓ ${ten.get(x.uid) || x.uid}`),
      ...(hong.length ? ["", "Không xoá được:", ...hong.map((x) => `   ✗ ${ten.get(x.uid) || x.uid}`)] : []),
    ].join("\n");
  } catch (error) {
    return `Em xoá không được ạ: ${error.message}`;
  }
}

/* --- TAO NHOM MOI --- */

const TEN_NHOM_MAX = 100;

async function chuanBiTaoNhom(ketQua, dichDen, khoa, message) {
  if (!nhomZalo?.tao) return "Em chưa nối được với Zalo ạ.";

  const ten = String(ketQua.ten || "").trim().slice(0, TEN_NHOM_MAX);
  if (!ten) return 'Chị đặt tên nhóm giúp em ạ, kiểu "tạo nhóm tên Lớp K13 gồm ...".';

  const xin = Array.isArray(ketQua.thanhVien) ? ketQua.thanhVien : [];
  const chon = [];
  const laNhom = [];
  const khongThay = [];
  for (const id of xin) {
    const d = dichDen.find((x) => String(x.id) === String(id));
    if (!d) khongThay.push(String(id));
    else if (d.loai === "nhom") laNhom.push(d.ten);
    else if (!chon.some((c) => c.id === d.id)) chon.push(d);
  }

  if (!chon.length) {
    return [
      "Em chưa rõ thêm ai vào nhóm ạ.",
      "Chị nhắn kiểu: “tạo nhóm tên Lớp K13 gồm Ngọc Bích và Thu Hà”.",
      "Em chỉ thêm được người đã từng nhắn tin với bot thôi ạ.",
    ].join("\n");
  }

  // Chi la nguoi ra lenh -> chuyen quyen truong nhom cho chi ngay sau khi tao.
  const adminUid = String(message?.senderId || "");

  cho.set(khoa, {
    loai: "tao_nhom",
    ten,
    chon,
    adminUid,
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });

  return [
    `Em sẽ tạo nhóm mới 「${ten}」 với ${chon.length} người:`,
    ...chon.map((d) => `   • ${d.ten}`),
    ...(laNhom.length ? ["", `(Bỏ qua vì là nhóm chứ không phải người: ${laNhom.join(", ")})`] : []),
    ...(khongThay.length ? ["", `(Không tìm thấy: ${khongThay.join(", ")})`] : []),
    "",
    "Tạo xong em chuyển quyền trưởng nhóm cho chị luôn.",
    "Mọi người sẽ nhận thông báo ngay, chị xem kỹ giúp em.",
    "Chị gõ OK để tạo, HUỶ để bỏ.",
  ].join("\n");
}

async function taoNhom(dangCho) {
  if (!nhomZalo?.tao) return "Em chưa nối được với Zalo ạ.";
  try {
    const kq = await nhomZalo.tao({
      ten: dangCho.ten,
      uids: dangCho.chon.map((d) => d.id),
      chuyenTruongCho: dangCho.adminUid || null,
    });

    const ten = new Map(dangCho.chon.map((d) => [String(d.id), d.ten]));
    const dong = [`Đã tạo nhóm 「${dangCho.ten}」 ạ.`];

    if (kq.vaoDuoc.length) {
      dong.push(`Vào được ${kq.vaoDuoc.length} người:`);
      dong.push(...kq.vaoDuoc.map((u) => `   ✓ ${ten.get(u) || u}`));
    }
    if (kq.hong.length) {
      dong.push("", "Không thêm được:");
      dong.push(...kq.hong.map((u) => `   ✗ ${ten.get(u) || u}`));
    }

    if (kq.chuyenTruong?.xong) dong.push("", "Đã chuyển quyền trưởng nhóm cho chị.");
    else if (kq.chuyenTruong) dong.push("", `Chưa chuyển được quyền trưởng nhóm: ${kq.chuyenTruong.moTa}`);

    // Chuyen quyen xong bot co the tut xuong thanh vien thuong -> mat quyen duyet
    // nguoi vao nhom. Bao truoc con hon de chi phat hien luc can dung.
    if (kq.vaiTroBot && kq.vaiTroBot === "thành viên thường") {
      dong.push(
        "",
        "Lưu ý: giờ bot chỉ là thành viên thường trong nhóm này.",
        "Muốn bot duyệt được người xin vào thì chị đặt bot làm PHÓ NHÓM giúp em."
      );
    }

    await addLog({
      event: "tao_nhom",
      level: kq.hong.length ? "warn" : "ok",
      summary: `Tạo nhóm "${dangCho.ten}" — ${kq.vaoDuoc.length} người vào được`,
      detail: { ten: dangCho.ten, groupId: kq.groupId, vaoDuoc: kq.vaoDuoc, hong: kq.hong, chuyenTruong: kq.chuyenTruong, vaiTroBot: kq.vaiTroBot },
    });

    return dong.join("\n");
  } catch (error) {
    await addLog({ event: "tao_nhom", level: "error", summary: `Tạo nhóm hỏng: ${error.message}`, detail: { ten: dangCho.ten } });
    return `Em tạo không được ạ: ${error.message}`;
  }
}

/* --- DUYET NGUOI XIN VAO NHOM --- */

let nhomZalo = null;
export function capHinhNhom(fns) {
  nhomZalo = fns;
}

/** Danh sach cho duyet lan gan nhat, theo tung nhom. Can nho de chi noi "duyet
 *  so 1, 2" thay vi phai doc ra day uid dai loang ngoang. */
const choDuyetGanDay = new Map();

async function xemChoDuyet(ketQua, dichDen) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ.";
  if (dich.loai !== "nhom") return "Chỉ nhóm mới có danh sách chờ duyệt ạ.";
  if (!nhomZalo?.xemCho) return "Em chưa nối được với Zalo ạ.";

  try {
    const ds = await nhomZalo.xemCho(dich.id);
    choDuyetGanDay.set(String(dich.id), ds);
    if (!ds.length) return `Không có ai đang chờ vào nhóm 「${dich.ten}」 ạ.`;
    return [
      `Có ${ds.length} người đang xin vào nhóm 「${dich.ten}」:`,
      "",
      ...ds.map((u, i) => `${i + 1}. ${u.ten || "(không có tên)"}`),
      "",
      'Duyệt thì nhắn "duyệt số 1, 2 vào nhóm ..." — từ chối thì "từ chối số 3".',
    ].join("\n");
  } catch (error) {
    return `Em không xem được ạ: ${error.message}`;
  }
}

async function chuanBiDuyet(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ.";

  const ds = choDuyetGanDay.get(String(dich.id));
  if (!ds?.length) return `Chị nhắn "xem danh sách chờ duyệt nhóm ${dich.ten}" trước để em biết ai với ai ạ.`;

  const soTT = Array.isArray(ketQua.soThuTu) ? ketQua.soThuTu : [ketQua.soThuTu];
  const chon = [];
  const sai = [];
  for (const s of soTT) {
    const i = Number(s) - 1;
    if (Number.isInteger(i) && i >= 0 && i < ds.length) chon.push(ds[i]);
    else sai.push(String(s));
  }
  if (!chon.length) return `Số thứ tự không đúng ạ. Danh sách chỉ có ${ds.length} người.`;

  const dongY = ketQua.dongY !== false;
  cho.set(khoa, { loai: "duyet_nhom", dichId: dich.id, dichTen: dich.ten, chon, dongY, hetHan: Date.now() + HAN_XAC_NHAN_MS });

  return [
    dongY
      ? `Em sẽ DUYỆT ${chon.length} người vào nhóm 「${dich.ten}」:`
      : `Em sẽ TỪ CHỐI ${chon.length} người xin vào nhóm 「${dich.ten}」:`,
    ...chon.map((u) => `   • ${u.ten || "(không có tên)"}`),
    ...(sai.length ? ["", `(Bỏ qua số không hợp lệ: ${sai.join(", ")})`] : []),
    "",
    dongY ? "Chị gõ OK để duyệt, HUỶ để bỏ." : "Từ chối rồi thì họ phải xin lại. Chị gõ OK để từ chối, HUỶ để bỏ.",
  ].join("\n");
}

async function duyetVaoNhom(dangCho) {
  if (!nhomZalo?.duyet) return "Em chưa nối được với Zalo ạ.";
  try {
    const kq = await nhomZalo.duyet(dangCho.dichId, dangCho.chon.map((u) => u.uid), dangCho.dongY);
    const ten = new Map(dangCho.chon.map((u) => [u.uid, u.ten]));
    const xong = kq.filter((x) => x.xong);
    const hong = kq.filter((x) => !x.xong);

    // Danh sach cu da doi -> bo di, bat chi xem lai truoc khi duyet tiep.
    choDuyetGanDay.delete(String(dangCho.dichId));

    await addLog({
      event: "duyet_nhom",
      level: hong.length ? "warn" : "ok",
      summary: `${dangCho.dongY ? "Duyệt" : "Từ chối"} ${xong.length}/${kq.length} người vào "${dangCho.dichTen}"`,
      detail: { dichTen: dangCho.dichTen, dongY: dangCho.dongY, kq },
    });

    return [
      `${dangCho.dongY ? "Đã duyệt" : "Đã từ chối"} ${xong.length}/${kq.length} người ạ.`,
      ...xong.map((x) => `   ✓ ${ten.get(x.uid) || x.uid}`),
      ...(hong.length ? ["", "Không xong:", ...hong.map((x) => `   ✗ ${ten.get(x.uid) || x.uid} — ${x.moTa}`)] : []),
    ].join("\n");
  } catch (error) {
    return `Em làm không được ạ: ${error.message}`;
  }
}

/* --- TIM NGUOI THEO SO DIEN THOAI --- */

let timNguoiZalo = null;
export function capHinhTimNguoi(fns) {
  timNguoiZalo = fns;
}

async function chuanBiNhanQuaSo(lenh, khoa) {
  if (!timNguoiZalo?.tim) return "Em chưa nối được với Zalo ạ.";

  try {
    const u = await timNguoiZalo.tim(lenh.so);
    const uid = String(u?.uid || "").trim();
    if (!uid) return `Em không tìm thấy người dùng Zalo phù hợp với số ${lenh.so} ạ.`;

    const so = String(u?.phone || "").trim();
    if (!/^84\d{9}$/.test(so)) {
      return "Em chưa chuẩn hoá được số điện thoại nên chưa tạo thao tác gửi.";
    }

    const ten = String(u?.display_name || u?.ten || u?.zalo_name || "").trim() || "(không có tên hiển thị)";
    cho.set(
      khoa,
      Object.freeze({
        loai: PHONE_USER_DIRECT_MESSAGE,
        so,
        uid,
        ten,
        anh: u?.anh || u?.avatar || null,
        noiDung: lenh.noiDung,
        hetHan: Date.now() + HAN_XAC_NHAN_MS,
      })
    );

    return [
      "Em sẽ gửi một tin nhắn riêng:",
      "",
      `Người nhận: ${ten}`,
      `Số điện thoại: ${so}`,
      "Nội dung:",
      lenh.noiDung,
      "",
      "Trả lời OK để gửi.",
      "Trả lời HUỶ để bỏ.",
    ].join("\n");
  } catch (error) {
    return `Em tra số chưa được nên chưa gửi gì ạ: ${error.message}`;
  }
}

async function guiTinRiengTheoSo(dangCho, guiRiengDaTim) {
  if (typeof guiRiengDaTim !== "function") return "Em chưa nối được đường gửi tin riêng an toàn ạ.";
  try {
    await guiRiengDaTim({
      uid: dangCho.uid,
      displayName: dangCho.ten,
      avatar: dangCho.anh,
      text: dangCho.noiDung,
    });
    return `Đã gửi một tin nhắn riêng tới “${dangCho.ten}” rồi ạ.`;
  } catch (error) {
    return `Em gửi tin nhắn riêng chưa được ạ: ${error.message}`;
  }
}

/**
 * Tra so ra danh tinh Zalo. KHONG can buoc xac nhan (chi doc), nhung GHI NHAT KY
 * moi luot: day la tra danh tinh nguoi that, phai co dau vet de soi lai.
 */
async function timNguoi(chuoi, message) {
  if (!timNguoiZalo?.tim) return "Em chưa nối được với Zalo ạ.";

  const so = String(chuoi || "").match(/(?:\+?84|0)\d{9}\b/)?.[0];
  if (!so) return 'Chị cho em số điện thoại 10 số giúp em, ví dụ "tìm số 0901234567 là ai".';

  try {
    const u = await timNguoiZalo.tim(so);
    await addLog({
      event: "tim_nguoi",
      level: "warn",
      summary: `Tra số ${so} → ${u.ten || "(không rõ tên)"}`,
      detail: { so, uid: u.uid, ten: u.ten, nguoiHoi: message?.senderName || "" },
    });
    if (!u.uid) return `Em không tìm thấy ai dùng Zalo với số ${so} ạ.`;
    return [
      `Số ${so} là:`,
      `👤 ${u.ten || "(không có tên hiển thị)"}`,
      "",
      `Còn ${timNguoiZalo.conLuot()} lượt tra trong giờ này.`,
    ].join("\n");
  } catch (error) {
    await addLog({ event: "tim_nguoi", level: "error", summary: `Tra số ${so} thất bại — ${error.message}`, detail: { so } });
    return `Em tra không được ạ: ${error.message}`;
  }
}

/* --- GHI CHU GHIM DAU NHOM --- */

let ghiChuZalo = null;
export function capHinhGhiChu(fn) {
  ghiChuZalo = fn;
}

async function chuanBiGhiChu(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ. Chị nói rõ tên nhóm giúp em.";
  if (dich.loai !== "nhom") return "Ghi chú chỉ ghim được trong NHÓM, không ghim trong chat riêng ạ.";

  const noiDung = String(ketQua.noiDung || "").trim();
  if (!noiDung) return "Chị cho em nội dung cần ghim ạ.";

  cho.set(khoa, { loai: "ghi_chu", dichId: dich.id, dichTen: dich.ten, noiDung, hetHan: Date.now() + HAN_XAC_NHAN_MS });

  return [
    `Em sẽ ghim ghi chú lên đầu nhóm 「${dich.ten}」:`,
    "",
    `📌 ${noiDung}`,
    "",
    "Lưu ý: Zalo KHÔNG cho xoá ghi chú bằng lệnh. Ghim rồi thì chỉ sửa được,",
    "muốn bỏ hẳn phải vào Zalo xoá tay. Chị đọc lại nội dung giúp em.",
    "",
    "Chị gõ OK để ghim, HUỶ để bỏ.",
  ].join("\n");
}

async function ghimGhiChu(dangCho) {
  if (!ghiChuZalo) return "Em chưa nối được với Zalo ạ.";
  try {
    await ghiChuZalo({ groupId: dangCho.dichId, noiDung: dangCho.noiDung, ghim: true });
    await addLog({
      event: "ghi_chu",
      level: "ok",
      summary: `Đã ghim ghi chú trong "${dangCho.dichTen}": ${dangCho.noiDung.slice(0, 50)}`,
      detail: { dichTen: dangCho.dichTen, noiDung: dangCho.noiDung },
    });
    return `Đã ghim lên đầu nhóm 「${dangCho.dichTen}」 ạ. Cả nhóm mở ra là thấy ngay.`;
  } catch (error) {
    await addLog({ event: "ghi_chu", level: "error", summary: `Ghim ghi chú thất bại — ${error.message}`, detail: { dangCho } });
    return `Em ghim không được ạ: ${error.message}`;
  }
}

/* --- BINH CHON --- */

let binhChonZalo = null;
/** zalo-service gan cac ham that vao day, tranh vong import. */
export function capHinhBinhChon(fns) {
  binhChonZalo = fns;
}

async function chuanBiBinhChon(ketQua, dichDen, khoa) {
  const dich = dichDen.find((d) => String(d.id) === String(ketQua.dichId));
  if (!dich) return "Em không tìm thấy nhóm đó ạ. Chị nói rõ tên nhóm giúp em.";
  if (dich.loai !== "nhom") return "Bình chọn chỉ tạo được trong NHÓM, không tạo trong chat riêng ạ.";

  const cauHoi = String(ketQua.cauHoi || "").trim();
  const luaChon = (Array.isArray(ketQua.luaChon) ? ketQua.luaChon : [])
    .map((x) => String(x).trim())
    .filter(Boolean);

  if (!cauHoi) return "Chị cho em câu hỏi của bình chọn ạ.";
  if (luaChon.length < 2) return "Bình chọn cần ít nhất 2 lựa chọn ạ. Chị liệt kê giúp em.";

  cho.set(khoa, {
    loai: "binh_chon",
    dichId: dich.id,
    dichTen: dich.ten,
    cauHoi,
    luaChon,
    nhieuLuaChon: Boolean(ketQua.nhieuLuaChon),
    choThemLuaChon: Boolean(ketQua.choThemLuaChon),
    anDanh: Boolean(ketQua.anDanh),
    hetHan: Date.now() + HAN_XAC_NHAN_MS,
  });

  const tuyChon = [
    ketQua.nhieuLuaChon ? "cho chọn nhiều đáp án" : "chỉ chọn một",
    ketQua.choThemLuaChon ? "cho thành viên thêm lựa chọn" : null,
    ketQua.anDanh ? "ẩn danh" : null,
  ].filter(Boolean);

  return [
    `Em sẽ tạo bình chọn trong nhóm 「${dich.ten}」:`,
    "",
    `📊 ${cauHoi}`,
    ...luaChon.map((x, i) => `   ${i + 1}. ${x}`),
    "",
    `(${tuyChon.join(" · ")})`,
    "",
    "Chị gõ OK để tạo, HUỶ để bỏ.",
  ].join("\n");
}

async function taoBinhChon(dangCho) {
  if (!binhChonZalo?.tao) return "Em chưa nối được với Zalo ạ.";
  try {
    const r = await binhChonZalo.tao({
      groupId: dangCho.dichId,
      cauHoi: dangCho.cauHoi,
      luaChon: dangCho.luaChon,
      nhieuLuaChon: dangCho.nhieuLuaChon,
      choThemLuaChon: dangCho.choThemLuaChon,
      anDanh: dangCho.anDanh,
    });
    await themBinhChon({
      pollId: r.pollId,
      threadId: dangCho.dichId,
      dichTen: dangCho.dichTen,
      cauHoi: dangCho.cauHoi,
      luaChon: dangCho.luaChon,
    });
    await addLog({
      event: "binh_chon",
      level: "ok",
      summary: `Đã tạo bình chọn trong "${dangCho.dichTen}": ${dangCho.cauHoi}`,
      detail: { pollId: r.pollId, dichTen: dangCho.dichTen, cauHoi: dangCho.cauHoi, luaChon: dangCho.luaChon },
    });
    return [
      `Đã tạo bình chọn trong 「${dangCho.dichTen}」 ạ.`,
      'Chị nhắn "xem bình chọn" để coi kết quả, hoặc "chốt bình chọn 1" để khoá.',
    ].join("\n");
  } catch (error) {
    await addLog({ event: "binh_chon", level: "error", summary: `Tạo bình chọn thất bại — ${error.message}`, detail: { dangCho } });
    return `Em tạo bình chọn không được ạ: ${error.message}`;
  }
}

async function xemBinhChon() {
  const ds = await listBinhChon(10);
  if (!ds.length) return "Chưa có bình chọn nào em tạo ạ.";
  if (!binhChonZalo?.doc) return "Em chưa nối được với Zalo ạ.";

  const dong = [];
  for (const [i, bc] of ds.entries()) {
    try {
      const kq = await binhChonZalo.doc(bc.pollId);
      const sapXep = [...kq.luaChon].sort((a, b) => b.phieu - a.phieu);
      dong.push(
        `${i + 1}. 📊 ${kq.cauHoi}${kq.daDong ? "  [đã chốt]" : ""}`,
        `   nhóm 「${bc.dichTen}」 · ${kq.tongPhieu} người đã chọn`,
        ...sapXep.map((o) => `      ${o.phieu} phiếu — ${o.noiDung}`)
      );
    } catch {
      dong.push(`${i + 1}. 📊 ${bc.cauHoi}`, `   (không đọc được kết quả)`);
    }
  }
  return ["Các bình chọn gần đây:", "", ...dong, "", 'Chốt cái nào thì nhắn "chốt bình chọn <số>".'].join("\n");
}

async function chotBinhChon(soThuTu) {
  const ds = await listBinhChon(10);
  const i = Number(soThuTu) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= ds.length) {
    return 'Chị cho em số thứ tự trong danh sách, ví dụ "chốt bình chọn 1". Nhắn "xem bình chọn" để coi danh sách.';
  }
  const bc = ds[i];
  if (bc.daChot) return `Bình chọn "${bc.cauHoi}" đã chốt từ trước rồi ạ.`;

  try {
    await binhChonZalo.chot(bc.pollId);
    await danhDauChotBinhChon(bc.pollId);
    await addLog({ event: "binh_chon", level: "warn", summary: `Đã chốt bình chọn: ${bc.cauHoi}`, detail: { pollId: bc.pollId } });
    return `Đã chốt bình chọn "${bc.cauHoi}" — cả nhóm không bỏ phiếu thêm được nữa ạ.`;
  } catch (error) {
    return `Em chốt không được ạ: ${error.message}`;
  }
}

async function xemLich() {
  const danhSach = await listLichHen(
    layChuTaiKhoan(),
    { chiChoGui: true, gioiHan: 30 }
  );
  if (danhSach.length === 0) return "Hiện không có lịch hẹn nào đang chờ ạ.";
  return [
    `Có ${danhSach.length} lịch đang chờ:`,
    "",
    ...danhSach.map((l) =>
      `#${l.id} — ${dinhDangGio(l.lucGui)}${l.lapLai ? ` (${TEN_LAP_LAI[l.lapLai]})` : ""}\n` +
      `   → 「${l.dichTen}」: ${l.noiDung.slice(0, 60)}${l.noiDung.length > 60 ? "…" : ""}`
    ),
    "",
    'Muốn bỏ cái nào thì nhắn "huỷ lịch <số>".',
  ].join("\n");
}

async function huyMotLich(id) {
  if (!id) return 'Chị cho em số của lịch cần huỷ, ví dụ "huỷ lịch 3".';
  const daHuy = await huyLichHen(id);
  if (!daHuy) return `Không có lịch #${id} đang chờ, hoặc nó đã gửi/đã huỷ rồi ạ.`;
  await addLog({ event: "lich_huy", level: "warn", summary: `Admin huỷ lịch hẹn #${id}`, detail: { id } });
  return `Đã huỷ lịch #${id} ạ.`;
}
