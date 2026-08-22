// Thu GIAI MA that mot bi mat trong ban sao luu.
//
// Vi sao can rieng buoc nay: PRAGMA integrity_check chi noi file CSDL con lanh,
// khong noi duoc du lieu ben trong co doc ra duoc hay khong. Toan bo bi mat
// (dang nhap Zalo, Zoho, SMTP) deu ma hoa bang APP_SECRET_KEY. Phuc hoi bang
// mot khoa khac thi CSDL van "nguyen ven" ma bot khong dang nhap duoc Zalo,
// khong goi duoc Zoho - va chi chi phat hien ra dung luc dang can nhat.
//
// Chay: node kiem-tra-giai-ma.js <duong-dan-csdl>
// Thoat 0 = giai ma duoc. Thoat 1 = khoa khong khop hoac du lieu hong.
import sqlite3 from "sqlite3";
import { giaiMa, daMachHoa } from "../lib/crypto-box.js";

const duongDan = process.argv[2];
if (!duongDan) {
  console.error("Thieu duong dan CSDL");
  process.exit(1);
}

const db = new sqlite3.Database(duongDan, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error("Khong mo duoc CSDL:", err.message);
    process.exit(1);
  }
});

const lay = (sql) => new Promise((res) => db.get(sql, (e, r) => res(e ? null : r)));

/** Cac cho co bi mat ma hoa. Tim duoc cai nao thi thu giai ma cai do. */
const CHO_THU = [
  { nhan: "khoa ky phien dang nhap", sql: "SELECT value AS v FROM app_secrets WHERE key = 'session_secret'" },
  { nhan: "Client Secret cua Zoho", sql: "SELECT client_secret AS v FROM zoho_config WHERE id = 1" },
  { nhan: "Refresh token cua Zoho", sql: "SELECT refresh_token AS v FROM zoho_config WHERE id = 1" },
  { nhan: "mat khau SMTP", sql: "SELECT password AS v FROM smtp_config WHERE id = 1" },
];

const daThu = [];
for (const cho of CHO_THU) {
  const row = await lay(cho.sql).catch(() => null);
  const v = row?.v;
  if (!v || !daMachHoa(v)) continue; // trong, hoac von la plaintext -> khong chung minh duoc gi
  try {
    const ra = giaiMa(v);
    // KHONG in gia tri. Chi in do dai de biet la co noi dung that.
    daThu.push({ nhan: cho.nhan, ok: true, doDai: String(ra).length });
  } catch (e) {
    daThu.push({ nhan: cho.nhan, ok: false, loi: e.message });
  }
}

db.close();

if (daThu.length === 0) {
  console.log("Khong tim thay bi mat da ma hoa nao de thu.");
  console.log("Ban sao luu nay chua tung luu dang nhap Zalo/Zoho/SMTP, hoac con rat moi.");
  process.exit(0);
}

let hong = 0;
for (const t of daThu) {
  if (t.ok) console.log(`  OK    ${t.nhan} - giai ma duoc (${t.doDai} ky tu)`);
  else {
    hong++;
    console.log(`  HONG  ${t.nhan} - ${t.loi}`);
  }
}

if (hong) {
  console.error("");
  console.error("KHOA KHONG KHOP. Ban sao luu nay khong dung duoc voi APP_SECRET_KEY hien tai.");
  console.error("Phuc hoi xong se phai quet lai QR Zalo va nhap lai ket noi Zoho/SMTP.");
  process.exit(1);
}

console.log("Giai ma duoc - ban sao luu nay dung duoc voi khoa hien tai.");
process.exit(0);
