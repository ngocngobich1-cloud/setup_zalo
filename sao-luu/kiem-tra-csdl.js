// Mo CSDL trong ban sao luu va dem lai. Muc dich: chung minh ban sao luu that
// su dung duoc, chu khong phai chi ton tai mot file .zip co dung kich thuoc.
import sqlite3 from "sqlite3";

const duongDan = process.argv[2];
if (!duongDan) {
  console.error("Thieu duong dan CSDL");
  process.exit(1);
}

const db = new sqlite3.Database(duongDan, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error("Khong mo duoc:", err.message);
    process.exit(1);
  }
});

const dem = (bang) =>
  new Promise((res) =>
    db.get(`SELECT COUNT(*) AS n FROM ${bang}`, (err, row) => res(err ? null : row.n))
  );

db.get("PRAGMA integrity_check", async (err, row) => {
  const ketQua = row ? Object.values(row)[0] : "loi";
  if (err || ketQua !== "ok") {
    console.error("CSDL hong:", err?.message || ketQua);
    process.exit(1);
  }
  console.log("CSDL nguyen ven: ok");

  for (const [bang, nhan] of [
    ["threads", "cuoc tro chuyen"],
    ["messages", "tin nhan"],
    ["customer_memory", "ho so khach"],
    ["knowledge_files", "file tri thuc"],
    ["users", "tai khoan"],
  ]) {
    const n = await dem(bang);
    if (n !== null) console.log(`${nhan}: ${n}`);
  }

  const soul = await new Promise((res) =>
    db.get("SELECT LENGTH(soul) AS n FROM ai_chat_config WHERE id = 1", (e, r) => res(e ? null : r?.n))
  );
  if (soul) console.log(`Soul: ${soul} ky tu`);

  db.close();
});
