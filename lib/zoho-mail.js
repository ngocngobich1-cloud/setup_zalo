import { getZohoConfig, saveZohoConfig } from "./db.js";

/**
 * Noi voi Zoho Mail de TRA CUU thu da gui. Chi doc, khong gui, khong xoa:
 * quyen xin cua Zoho la ZohoMail.accounts.READ + ZohoMail.messages.READ.
 *
 * Khong dung thu vien nao - Node 24 co san fetch. Do la loi cua kieu "Self
 * Client": khong can luong OAuth qua trinh duyet nen khong can thu vien nao ca.
 */

/** Zoho co nhieu trung tam du lieu, dia chi may chu khac nhau theo vung. */
const VUNG = {
  com: { accounts: "https://accounts.zoho.com", mail: "https://mail.zoho.com", ten: "Quốc tế (.com)" },
  eu: { accounts: "https://accounts.zoho.eu", mail: "https://mail.zoho.eu", ten: "Châu Âu (.eu)" },
  in: { accounts: "https://accounts.zoho.in", mail: "https://mail.zoho.in", ten: "Ấn Độ (.in)" },
  "com.au": { accounts: "https://accounts.zoho.com.au", mail: "https://mail.zoho.com.au", ten: "Úc (.com.au)" },
  jp: { accounts: "https://accounts.zoho.jp", mail: "https://mail.zoho.jp", ten: "Nhật (.jp)" },
  ca: { accounts: "https://accounts.zohocloud.ca", mail: "https://mail.zohocloud.ca", ten: "Canada (.ca)" },
};

export function danhSachVung() {
  return Object.entries(VUNG).map(([id, v]) => ({ id, ten: v.ten }));
}

function mayChu(vung) {
  return VUNG[vung] || VUNG.com;
}

const HAN_GOI_MS = 20000;

/**
 * Zoho doi tham so cua /oauth/v2/token nam trong DIA CHI, khong phai trong than
 * yeu cau nhu chuan OAuth 2.0 thong thuong. Gui theo chuan thi Zoho khong thay
 * tham so nao ca va bao "invalid_client" - nghe nhu sai Client ID, that ra la
 * no chua doc duoc gi.
 */
async function goiToken(vung, thamSo) {
  const url = new URL(`${mayChu(vung).accounts}/oauth/v2/token`);
  for (const [k, v] of Object.entries(thamSo)) url.searchParams.set(k, String(v));
  return goi(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function goi(url, options = {}) {
  const controller = new AbortController();
  const dongHo = setTimeout(() => controller.abort(), HAN_GOI_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Zoho tra ve HTML khi sai duong dan -> giu nguyen text de bao loi cho de hieu
    }
    if (!res.ok) {
      const chiTiet = data?.error?.message || data?.data?.errorCode || data?.error || text.slice(0, 200);
      const err = new Error(`Zoho ${res.status}: ${chiTiet}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Zoho không phản hồi (quá 20 giây).");
    throw error;
  } finally {
    clearTimeout(dongHo);
  }
}

/**
 * Doi ma sinh o API Console lay chia khoa dai han.
 * Ma nay chi song 3-10 phut va dung duoc DUNG MOT LAN.
 */
export async function doiMaLayToken({ vung, clientId, clientSecret, ma }) {
  const data = await goiToken(vung, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: ma,
  });

  // Zoho tra ve HTTP 200 kem {"error":"invalid_code"} thay vi ma loi that.
  if (data?.error) {
    const giaiThich = {
      invalid_code: "Mã đã hết hạn hoặc đã dùng rồi. Chị sinh mã mới rồi dán lại trong vòng 10 phút giúp em.",
      invalid_client: "Client ID không đúng, hoặc tài khoản Zoho nằm ở vùng dữ liệu khác. Chị kiểm lại ô Vùng dữ liệu giúp em.",
      invalid_client_secret: "Client Secret không đúng — chị copy lại cho đủ ký tự giúp em.",
      invalid_redirect_uri: "Ứng dụng bên Zoho không phải loại Self Client. Chị tạo lại bằng Self Client giúp em.",
    };
    throw new Error(giaiThich[data.error] || `Zoho báo lỗi: ${data.error}`);
  }
  if (!data?.refresh_token) {
    throw new Error("Zoho không trả về chìa khoá dài hạn. Chị kiểm lại xem đã chọn đúng Self Client chưa.");
  }

  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    accessHetHan: Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600) - 120,
  };
}

/** Lay chia khoa ngan han con han. Het han thi tu xin cai moi. */
async function layAccessToken(config) {
  const bayGio = Math.floor(Date.now() / 1000);
  if (config.accessToken && config.accessHetHan > bayGio) return config.accessToken;
  if (!config.refreshToken) throw new Error("Chưa kết nối Zoho Mail.");

  const data = await goiToken(config.vung, {
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
  });
  if (data?.error || !data?.access_token) {
    throw new Error(
      data?.error === "invalid_grant"
        ? "Chìa khoá Zoho đã bị thu hồi. Chị vào API Console sinh mã mới rồi kết nối lại giúp em."
        : `Không làm mới được chìa khoá Zoho: ${data?.error || "không rõ"}`
    );
  }

  const hetHan = Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600) - 120;
  await saveZohoConfig({ accessToken: data.access_token, accessHetHan: hetHan });
  return data.access_token;
}

/**
 * Zoho Mail doi header la "Zoho-oauthtoken", KHONG phai "Bearer" nhu chuan
 * OAuth thong thuong. Dung Bearer se bi tu choi 401 ma khong noi ly do.
 */
async function goiMail(config, duongDan, thamSo = {}) {
  const token = await layAccessToken(config);
  const url = new URL(`${mayChu(config.vung).mail}${duongDan}`);
  for (const [k, v] of Object.entries(thamSo)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return goi(url.toString(), {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: "application/json" },
  });
}

/** Lay accountId + dia chi mail. Goi mot lan luc ket noi roi cat lai. */
export async function layThongTinTaiKhoan(config) {
  const data = await goiMail(config, "/api/accounts");
  const tk = Array.isArray(data?.data) ? data.data[0] : data?.data;
  if (!tk?.accountId) throw new Error("Không lấy được thông tin tài khoản Zoho.");
  return {
    accountId: String(tk.accountId),
    diaChi: tk.primaryEmailAddress || tk.mailboxAddress || tk.incomingUserName || "",
  };
}

/**
 * Doc moc thoi gian that cua mot la thu.
 *
 * PHAI dung receivedTime, KHONG dung sentDateInGMT. Da do tren hop thu that:
 *   sentDateInGMT = 1786201731000  -> London 16:08
 *   receivedTime  = 1786208933083  -> London 18:08  <- Zoho web hien 6:08 PM
 * Ten truong co chu "GMT" nhung gia tri lai lech 2 tieng (dung bang do lech mua
 * he cua trung tam du lieu chau Au). Tin vao cai ten la sai gio bao cho khach.
 *
 * Tra ve moc TUYET DOI (giay). Viec doi ra gio Viet Nam de cho noi hien thi lo.
 */
function docThoiGian(mail) {
  const raw = mail?.receivedTime ?? mail?.sentDateInGMT ?? mail?.sentDate;
  const so = Number(raw);
  if (Number.isFinite(so) && so > 0) return Math.floor(so / 1000);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

/** Zoho tra ve dia chi da ma hoa HTML: "Ten"&lt;a@b.com&gt; */
function goHtml(s) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .toLowerCase();
}

async function timKiem(config, searchKey) {
  const data = await goiMail(config, `/api/accounts/${encodeURIComponent(config.accountId)}/messages/search`, {
    searchKey,
    limit: 50,
    includeto: true,
    // Dat tuong minh. De trong thi Zoho tu lay "2 phut truoc" lam moc, va do
    // do do choi vong: cung mot cau tim, luc ra 0 ket qua luc ra 1.
    receivedTime: Date.now(),
  });
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Tim thu DA GUI toi mot dia chi.
 *
 * KHONG tin vao ket qua tim cua Zoho. Ly do da do duoc:
 *  - "to:...::in:Sent" luc tra ve 0 luc tra ve 1 cho cung mot hop thu.
 *  - "entire:..." thi bat ca thu NHAN VE tu nguoi do. Bao "da gui roi" trong
 *    khi that ra chi moi nhan thu cua ho la sai nguy hiem hon la khong tim thay.
 *
 * Nen: hoi Zoho rong nhat co the, roi TU KIEM tung thu - chi giu thu nao that
 * su GUI TU dia chi cua chi VA GUI TOI dia chi dang tra.
 */
export async function timThuDaGui(config, email) {
  const toi = String(config.diaChi || "").toLowerCase();
  const cantim = String(email).toLowerCase();

  let ds = await timKiem(config, `entire:${email}::in:Sent`);
  // Hop "Da gui" co the mang ten khac (giao dien tieng Viet, hoac nguoi dung
  // doi ten) -> tim khong gioi han thu muc roi loc bang huong gui.
  if (ds.length === 0) ds = await timKiem(config, `entire:${email}`);

  return ds
    .filter((m) => {
      const tu = goHtml(m.fromAddress || m.sender || "");
      const den = goHtml(JSON.stringify(m.toAddress ?? m.to ?? ""));
      return (!toi || tu.includes(toi)) && den.includes(cantim);
    })
    .map((m) => ({ luc: docThoiGian(m), tieuDe: m.subject || "(không tiêu đề)", messageId: m.messageId }))
    .sort((a, b) => (b.luc || 0) - (a.luc || 0));
}

/**
 * Tim thu BI TRA VE. Thu bao loi nam o Hop thu den, gui tu mailer-daemon hoac
 * postmaster, va nhac lai dia chi bi loi trong noi dung. Chi tim trong hop den
 * de khong nham voi thu binh thuong.
 */
export async function timThuTraVe(config, email) {
  const ds = await timKiem(config, `entire:${email}`);
  const DAU_HIEU = /mailer-daemon|postmaster|mail delivery|delivery status|undeliverable|returned mail|failure notice|delivery has failed|khong gui duoc/i;
  const toi = String(config.diaChi || "").toLowerCase();

  return ds
    .filter((m) => {
      const tu = goHtml(m.fromAddress || m.sender || "");
      // Thu bao loi la thu NHAN VE tu he thong mail, khong phai thu minh gui.
      if (toi && tu.includes(toi)) return false;
      return DAU_HIEU.test(`${tu} ${goHtml(m.subject || "")}`);
    })
    .map((m) => ({ luc: docThoiGian(m), tieuDe: m.subject || "(không tiêu đề)", tu: m.fromAddress || m.sender || "" }))
    .sort((a, b) => (b.luc || 0) - (a.luc || 0));
}

/** Thu ket noi ma khong tra cuu gi: dung cho den trang thai va nut "Thu lai". */
export async function kiemTraKetNoi() {
  const config = await getZohoConfig();
  if (!config?.refreshToken) throw new Error("Chưa kết nối Zoho Mail.");
  const tk = await layThongTinTaiKhoan(config);
  if (tk.accountId !== config.accountId || tk.diaChi !== config.diaChi) {
    await saveZohoConfig({ accountId: tk.accountId, diaChi: tk.diaChi });
  }
  return tk;
}
