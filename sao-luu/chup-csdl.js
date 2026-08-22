// Chup mot ban CSDL lien mach ngay ca khi app dang ghi.
// Chep thang file zalo.db se bat duoc ban do dang: du lieu moi nhat con nam
// trong zalo.db-wal. VACUUM INTO gop tat ca lai thanh mot file sach.
//
// Chay bang: docker exec <container> node /app/_chup-csdl.js <nguon> <dich>
// Phai nam trong /app thi require/import moi tim thay /app/node_modules.
import sqlite3 from "sqlite3";

const nguon = process.argv[2] || "/app/data/zalo.db";
const dich = process.argv[3] || "/app/data/_chup.db";

const db = new sqlite3.Database(nguon, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error("Khong mo duoc CSDL:", err.message);
    process.exit(1);
  }
});

db.run(`VACUUM INTO '${dich.replace(/'/g, "''")}'`, (err) => {
  if (err) {
    console.error("VACUUM INTO that bai:", err.message);
    process.exit(1);
  }
  db.close();
  console.log("OK");
});
