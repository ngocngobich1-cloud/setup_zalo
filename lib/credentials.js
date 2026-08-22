import fs from "node:fs/promises";
import path from "node:path";
import { daMachHoa, giaiMa, machHoa } from "./crypto-box.js";

const DATA_DIR = path.resolve("data");
const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");

/**
 * File nay chua cookie + IMEI Zalo: ai cam duoc no la vao duoc thang tai khoan
 * Zalo cua chu app. Vi the noi dung duoc ma hoa truoc khi ghi.
 */
export async function loadCredentials() {
  let raw;
  try {
    raw = (await fs.readFile(CREDENTIALS_PATH, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("[credentials] Khong doc duoc credentials:", error.message);
    }
    return null;
  }

  const daMa = daMachHoa(raw);
  let credentials;
  try {
    credentials = JSON.parse(daMa ? giaiMa(raw) : raw);
  } catch (error) {
    console.warn("[credentials] Khong doc duoc credentials:", error.message);
    if (daMa) {
      console.warn("[credentials] Se phai dang nhap lai Zalo bang ma QR.");
    }
    return null;
  }

  if (!credentials?.imei || !credentials?.cookie || !credentials?.userAgent) {
    return null;
  }

  // Ban cu con de tran -> ghi de lai dang da ma hoa. Chi chay dung mot lan.
  if (!daMa) {
    try {
      await saveCredentials(credentials);
      console.log("[credentials] Da ma hoa lai credentials.json");
    } catch (error) {
      console.warn("[credentials] Khong ma hoa lai duoc:", error.message);
    }
  }

  return credentials;
}

/**
 * Xoa han thong tin dang nhap Zalo. Dung cho nut "Dang xuat Zalo" - khac han
 * dang xuat khoi app. Xoa xong thi lan sau bat buoc phai quet lai ma QR.
 */
export async function xoaCredentials() {
  try {
    await fs.unlink(CREDENTIALS_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function saveCredentials(credentials) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CREDENTIALS_PATH, machHoa(JSON.stringify(credentials)), {
    encoding: "utf8",
    mode: 0o600,
  });
  // writeFile chi ap dung "mode" luc TAO file. File da ton tai tu ban cu (0644)
  // thi phai dat quyen tuong minh, khong thi no giu nguyen quyen cu mai mai.
  await fs.chmod(CREDENTIALS_PATH, 0o600).catch(() => {});
}
