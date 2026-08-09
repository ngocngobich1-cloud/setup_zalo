import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Ma hoa cac bi mat truoc khi ghi xuong dia: cookie Zalo, khoa ky session,
 * mat khau SMTP.
 *
 * Muc dich CU THE: mot ban sao luu, mot anh chup o dia VPS hay mot file zalo.db
 * lo ra ngoai thi khong con dung duoc ngay. No KHONG chong duoc ke da vao duoc
 * may va doc duoc ca khoa - khong co cach nao chong dieu do khi app phai tu
 * giai ma de chay.
 *
 * Vi vay khoa phai nam NGOAI thu duoc sao luu: dat APP_SECRET_KEY trong .env.
 */

const TIEN_TO = "v1:";
const DATA_DIR = path.resolve("data");
const KHOA_FILE = path.join(DATA_DIR, ".secret-key");

let khoaCache = null;
let daCanhBao = false;

export function sinhKhoaMoi() {
  return crypto.randomBytes(32).toString("hex");
}

function docKhoa() {
  if (khoaCache) return khoaCache;

  const tuEnv = String(process.env.APP_SECRET_KEY || "").trim();
  if (tuEnv) {
    const buf = Buffer.from(tuEnv, "hex");
    if (buf.length !== 32) {
      throw new Error("APP_SECRET_KEY phải là 64 ký tự hex (32 byte). Sinh lại bằng: openssl rand -hex 32");
    }
    khoaCache = buf;
    return khoaCache;
  }

  // Du phong. App KHONG duoc chet chi vi thieu mot bien moi truong tren VPS,
  // nhung khoa nam trong data/ thi ban sao luu data/ se chua ca khoa lan du
  // lieu - het tac dung. Vi the phai keu that to.
  try {
    const buf = Buffer.from(fs.readFileSync(KHOA_FILE, "utf8").trim(), "hex");
    if (buf.length !== 32) throw new Error("sai độ dài");
    khoaCache = buf;
  } catch {
    khoaCache = crypto.randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KHOA_FILE, khoaCache.toString("hex"), { mode: 0o600 });
  }

  if (!daCanhBao) {
    daCanhBao = true;
    console.warn(
      "[bao-mat] CHUA dat APP_SECRET_KEY. Dang dung khoa du phong o data/.secret-key.\n" +
        "[bao-mat] Khoa nam CHUNG cho voi du lieu -> sao luu lo ra la lo ca hai.\n" +
        "[bao-mat] Hay them APP_SECRET_KEY=<64 ky tu hex> vao .env roi khoi dong lai."
    );
  }
  return khoaCache;
}

export function daMachHoa(value) {
  return String(value ?? "").startsWith(TIEN_TO);
}

/** Chuoi rong tra ve rong: khong ma hoa cai khong co gi, de con phan biet duoc. */
export function machHoa(plain) {
  const s = String(plain ?? "");
  if (!s) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", docKhoa(), iv);
  const ct = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
  // base64 khong bao gio chua dau ":", nen tach bang ":" luon an toan.
  return TIEN_TO + [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(":");
}

/**
 * Gia tri chua co tien to = du lieu cu con de tran -> tra nguyen van, de ban cu
 * van chay duoc trong khi cho ham di tru ghi de lai.
 */
export function giaiMa(stored) {
  const s = String(stored ?? "");
  if (!s) return "";
  if (!daMachHoa(s)) return s;

  const phan = s.slice(TIEN_TO.length).split(":");
  if (phan.length !== 3) throw new Error("Dữ liệu mã hoá hỏng định dạng.");
  const [iv, tag, ct] = phan.map((x) => Buffer.from(x, "base64"));

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", docKhoa(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // GCM phat hien sai khoa hoac du lieu bi sua. Noi ro ly do thay vi de
    // noi goi ham nhan mot chuoi rac.
    throw new Error(
      "Không giải mã được — khoá APP_SECRET_KEY không khớp với dữ liệu, hoặc dữ liệu đã bị sửa."
    );
  }
}
