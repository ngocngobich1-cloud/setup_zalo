import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const HAN_GOI_MS = 20000;

const KHOA = Object.freeze({
  name: "website_connection_name",
  apiUrl: "website_api_url",
  apiToken: "website_api_token",
  verified: "website_connection_verified",
});

const THONG_DIEP = Object.freeze({
  WEBSITE_CONFIG_INCOMPLETE: "Thông tin kết nối Website chưa đầy đủ.",
  WEBSITE_URL_INVALID: "API URL không hợp lệ. Hãy nhập một địa chỉ HTTPS đầy đủ.",
  WEBSITE_URL_BLOCKED: "API URL phải là địa chỉ HTTPS công khai, không phải địa chỉ nội bộ.",
  WEBSITE_DNS_FAILED: "Không xác minh được địa chỉ máy chủ Website.",
  WEBSITE_NOT_CONNECTED: "Website chưa được kiểm tra kết nối thành công.",
  WEBSITE_UNAUTHORIZED: "Website từ chối API Token. Hãy kiểm tra lại token.",
  WEBSITE_NOT_FOUND: "Không tìm thấy Website API tại địa chỉ đã cấu hình.",
  WEBSITE_TIMEOUT: "Website API không phản hồi trong 20 giây.",
  WEBSITE_NETWORK_FAILED: "Không kết nối được với Website API.",
  WEBSITE_RESPONSE_INVALID: "Website API trả về dữ liệu không đúng định dạng.",
  WEBSITE_REQUEST_FAILED: "Website API trả về lỗi.",
});

export class LoiWebsite extends Error {
  constructor(ma) {
    super(THONG_DIEP[ma] || THONG_DIEP.WEBSITE_REQUEST_FAILED);
    this.name = "LoiWebsite";
    this.ma = ma;
  }
}

function nem(ma) {
  throw new LoiWebsite(ma);
}

let goiMang = (...doiSo) => fetch(...doiSo);
let traDiaChi = (...doiSo) => lookup(...doiSo);
let khoBiMatGia = null;

/** Seam provider-free cho focused tests, theo cung pattern lib/zoom.js. */
export function capHinhGoiMang(fn) {
  goiMang = typeof fn === "function" ? fn : (...doiSo) => fetch(...doiSo);
}

export function capHinhTraDiaChi(fn) {
  traDiaChi = typeof fn === "function" ? fn : (...doiSo) => lookup(...doiSo);
}

/** Seam chi dung cho test; production luon roi vao helpers app_secrets that. */
export function capHinhKhoBiMat(kho) {
  khoBiMatGia = typeof kho?.get === "function" && typeof kho?.set === "function" ? kho : null;
}

async function docBiMat(key) {
  if (khoBiMatGia) return khoBiMatGia.get(key);
  const { getAppSecret } = await import("./db.js");
  return getAppSecret(key);
}

async function ghiBiMat(key, value) {
  if (khoBiMatGia) return khoBiMatGia.set(key, value);
  const { setAppSecret } = await import("./db.js");
  return setAppSecret(key, value);
}

function ipv4CongKhai(address) {
  const phan = address.split(".").map(Number);
  if (phan.length !== 4 || phan.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = phan;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;

  // Cac dai tai lieu/benchmark/reserved khong phai dich API cong khai.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6CongKhai(address) {
  const s = String(address || "").toLowerCase().split("%")[0];
  // Global unicast hien tai nam trong 2000::/3. Cach allow hẹp nay cung chan
  // IPv4-compatible/mapped (::/96), loopback, ULA, link-local va multicast.
  if (!/^[23]/.test(s)) return false;
  // Documentation va cac tunnel co the ma hoa mot IPv4 private ben trong.
  if (s.startsWith("2001:db8:") || s.startsWith("2001:0:") || s.startsWith("2002:")) return false;
  return true;
}

export function diaChiCongKhai(address) {
  const loai = isIP(String(address || ""));
  if (loai === 4) return ipv4CongKhai(String(address));
  if (loai === 6) return ipv6CongKhai(String(address));
  return false;
}

function tenMayBiChan(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  );
}

/** Kiem tra dong bo de route Luu khong phat sinh network call. */
export function validateWebsiteApiUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    nem("WEBSITE_URL_INVALID");
  }

  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    nem("WEBSITE_URL_INVALID");
  }

  const khoaQueryBiMat = /^(?:api[-_]?token|access[-_]?token|token|api[-_]?key|authorization|auth|secret|password)$/i;
  if ([...url.searchParams.keys()].some((key) => khoaQueryBiMat.test(key))) {
    nem("WEBSITE_URL_INVALID");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (tenMayBiChan(host)) nem("WEBSITE_URL_BLOCKED");
  if (isIP(host) && !diaChiCongKhai(host)) nem("WEBSITE_URL_BLOCKED");
  return url;
}

async function validateWebsiteDestination(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;

  let ketQua;
  try {
    ketQua = await traDiaChi(host, { all: true, verbatim: true });
  } catch {
    nem("WEBSITE_DNS_FAILED");
  }

  const danhSach = Array.isArray(ketQua) ? ketQua : ketQua ? [ketQua] : [];
  if (!danhSach.length) nem("WEBSITE_DNS_FAILED");
  if (danhSach.some((item) => !diaChiCongKhai(item?.address))) nem("WEBSITE_URL_BLOCKED");
}

function emailHopLe(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateWebsiteResponse(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.customers)) {
    nem("WEBSITE_RESPONSE_INVALID");
  }

  const customers = [];
  let skipped = 0;
  for (const row of data.customers) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      skipped++;
      continue;
    }
    if (typeof row.phone !== "string" || typeof row.email !== "string") {
      skipped++;
      continue;
    }

    const phone = row.phone.trim();
    const email = row.email.trim().toLowerCase();
    if (!phone || !emailHopLe(email)) {
      skipped++;
      continue;
    }
    customers.push({ phone, email });
  }

  return {
    customers,
    skipped,
    warning: skipped > 0 ? `Đã bỏ qua ${skipped} bản ghi khách hàng không hợp lệ.` : "",
  };
}

async function docConfigNoiBo() {
  const [name, apiUrl, apiToken, verified] = await Promise.all([
    docBiMat(KHOA.name),
    docBiMat(KHOA.apiUrl),
    docBiMat(KHOA.apiToken),
    docBiMat(KHOA.verified),
  ]);
  return {
    name: name || "",
    apiUrl: apiUrl || "",
    apiToken: apiToken || "",
    verified: verified === "1",
  };
}

function configDayDu(config) {
  return Boolean(config?.name && config?.apiUrl && config?.apiToken);
}

function congKhai(config) {
  const configured = configDayDu(config);
  return {
    name: config?.name || "",
    apiUrl: config?.apiUrl || "",
    hasApiToken: Boolean(config?.apiToken),
    configured,
    connected: configured && Boolean(config?.verified),
  };
}

export async function getSafeWebsiteConfig() {
  return congKhai(await docConfigNoiBo());
}

export async function saveWebsiteConfig(patch = {}) {
  const cu = await docConfigNoiBo();
  const name = String(patch.name ?? "").trim();
  const apiUrl = validateWebsiteApiUrl(patch.apiUrl).toString();
  const tokenMoi = String(patch.apiToken ?? "").trim();
  const apiToken = tokenMoi || cu.apiToken;

  if (!name || !apiUrl || !apiToken) nem("WEBSITE_CONFIG_INCOMPLETE");

  await Promise.all([
    ghiBiMat(KHOA.name, name),
    ghiBiMat(KHOA.apiUrl, apiUrl),
    ghiBiMat(KHOA.apiToken, apiToken),
    // Save chi luu config; bat buoc test lai moi duoc coi la da ket noi.
    ghiBiMat(KHOA.verified, ""),
  ]);
  return getSafeWebsiteConfig();
}

export async function disconnectWebsite() {
  await Promise.all(Object.values(KHOA).map((key) => ghiBiMat(key, "")));
  return getSafeWebsiteConfig();
}

async function goiWebsite(config) {
  if (!configDayDu(config)) nem("WEBSITE_CONFIG_INCOMPLETE");
  const url = validateWebsiteApiUrl(config.apiUrl);
  await validateWebsiteDestination(url);

  const controller = new AbortController();
  const dongHo = setTimeout(() => controller.abort(), HAN_GOI_MS);
  try {
    const res = await goiMang(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiToken}`,
      },
      redirect: "manual",
      signal: controller.signal,
    });

    if (!res?.ok) {
      if (res?.status === 401 || res?.status === 403) nem("WEBSITE_UNAUTHORIZED");
      if (res?.status === 404) nem("WEBSITE_NOT_FOUND");
      nem("WEBSITE_REQUEST_FAILED");
    }

    let data;
    try {
      const text = await res.text();
      data = JSON.parse(text);
    } catch {
      nem("WEBSITE_RESPONSE_INVALID");
    }
    return validateWebsiteResponse(data);
  } catch (error) {
    if (error?.name === "AbortError") nem("WEBSITE_TIMEOUT");
    if (error instanceof LoiWebsite) throw error;
    nem("WEBSITE_NETWORK_FAILED");
  } finally {
    clearTimeout(dongHo);
  }
}

export async function testWebsiteConnection() {
  const config = await docConfigNoiBo();
  try {
    const ketQua = await goiWebsite(config);
    await ghiBiMat(KHOA.verified, "1");
    return {
      connected: true,
      customerCount: ketQua.customers.length,
      skipped: ketQua.skipped,
      warning: ketQua.warning,
    };
  } catch (error) {
    await ghiBiMat(KHOA.verified, "");
    throw error;
  }
}

export async function fetchWebsiteCustomers() {
  const config = await docConfigNoiBo();
  if (!configDayDu(config) || !config.verified) nem("WEBSITE_NOT_CONNECTED");
  return goiWebsite(config);
}
