/**
 * KIEM THU ZOOM P2A + P2B + TOOLS UX V2.
 *
 * Chay:  node kiem-thu/kiem-tra-zoom.js
 *
 * Nguyen tac:
 *  - KHONG goi Zoom that. Toan bo mang di qua mot ham gia bom vao bang
 *    capHinhGoiMang(); moi lan goi deu duoc ghi so de khang dinh.
 *  - KHONG dung CSDL that: process.chdir() sang thu muc tam truoc khi import
 *    lib/db.js, vi db.js tinh path.resolve("data") ngay luc nap module.
 *  - Moi bai phai khang dinh trang thai quan sat duoc, khong bai nao "pass vi
 *    ham co ton tai".
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const napLib = (ten) => import(pathToFileURL(path.join(REPO, "lib", ten)).href);

const bienBan = [];
async function bai(ma, moTa, fn) {
  try {
    await fn();
    bienBan.push({ ma, ketQua: "PASS", moTa });
  } catch (error) {
    bienBan.push({ ma, ketQua: "FAIL", moTa, loi: error.message });
  }
}

/* --- Gia tri thu: neu bat ky gia tri nao lot ra ngoai la HONG --- */
const BI_MAT = {
  accountId: "ACC-THU-0001",
  clientId: "CID-THU-0002",
  clientSecret: "SECRET-THU-TUYET-MAT-0003",
  hostEmail: "chu.phong+hop@congty.com",
};
const TOKEN_GIA = "TOKEN-THU-TUYET-MAT-0004";

/* --- Mang gia --- */
let daGoi = [];
let traLoiTiepTheo = [];
function datTraLoi(danhSach) {
  traLoiTiepTheo = danhSach.slice();
}
function mangGia(url, options = {}) {
  daGoi.push({ url: String(url), options });
  const tl = traLoiTiepTheo.shift();
  if (!tl) throw new Error(`Ham gia het kich ban, nhung ma van goi: ${url}`);
  if (tl.nem) return Promise.reject(tl.nem);
  return Promise.resolve({
    ok: tl.status >= 200 && tl.status < 300,
    status: tl.status,
    text: async () => (typeof tl.body === "string" ? tl.body : JSON.stringify(tl.body ?? {})),
  });
}
const okToken = { status: 200, body: { access_token: TOKEN_GIA, expires_in: 3600 } };

/** Doc thang app_secrets (gia tri da ma hoa) de soi ro ri. */
function docAppSecretsTho(duongDanDb) {
  return new Promise((res, rej) => {
    const conn = new sqlite3.Database(duongDanDb, sqlite3.OPEN_READONLY);
    conn.all("SELECT key, value FROM app_secrets", (e, rows) => {
      conn.close();
      e ? rej(e) : res(rows || []);
    });
  });
}

async function main() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zoom-"));
  fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
  process.chdir(TMP);
  const DB_FILE = path.join(TMP, "data", "zalo.db");

  const db = await napLib("db.js");
  await db.initDb();

  const zoom = await napLib("zoom.js");
  zoom.capHinhGoiMang(mangGia);
  const zoomUi = await import(pathToFileURL(path.join(REPO, "public", "zoom.js")).href);
  const zaloService = await napLib("zalo-service.js");

  const dat = async () => {
    daGoi = [];
    traLoiTiepTheo = [];
    await zoom.clearZoomConfig();
  };
  const luuDu = () => zoom.saveZoomConfig({ ...BI_MAT });

  /* ================= Z01–Z26 ================= */

  await bai("Z01", "GET config không bao giờ trả về Client Secret", async () => {
    await dat();
    await luuDu();
    const congKhai = zoom.zoomCongKhai(await zoom.getZoomConfig());
    const chuoi = JSON.stringify(congKhai);
    assert.ok(!chuoi.includes(BI_MAT.clientSecret), `lộ Client Secret: ${chuoi}`);
    assert.equal(congKhai.hasClientSecret, true, "phải báo là ĐÃ có");
    assert.equal(congKhai.clientSecret, undefined, "không được có trường clientSecret");
  });

  await bai("Z02", "GET config không bao giờ trả về access token", async () => {
    const chuoi = JSON.stringify(zoom.zoomCongKhai(await zoom.getZoomConfig()));
    assert.ok(!chuoi.includes(TOKEN_GIA), "lộ access token");
    assert.ok(!/token/i.test(chuoi), `hình dạng công khai có chữ token: ${chuoi}`);
  });

  await bai("Z03", "lưu cấu hình đầy đủ thành công", async () => {
    await dat();
    await luuDu();
    const c = await zoom.getZoomConfig();
    assert.equal(c.accountId, BI_MAT.accountId);
    assert.equal(c.clientId, BI_MAT.clientId);
    assert.equal(c.clientSecret, BI_MAT.clientSecret);
    assert.equal(c.hostEmail, BI_MAT.hostEmail);
    assert.equal(zoom.zoomCongKhai(c).configured, true);
  });

  await bai("Z04", "ô chìa khoá để trống → GIỮ NGUYÊN giá trị cũ", async () => {
    await dat();
    await luuDu();
    await zoom.saveZoomConfig({
      accountId: "",
      clientId: "   ",
      clientSecret: "",
      hostEmail: "doi.email@congty.com",
    });
    const c = await zoom.getZoomConfig();
    assert.equal(c.accountId, BI_MAT.accountId, "Account ID bị xoá");
    assert.equal(c.clientId, BI_MAT.clientId, "Client ID bị xoá");
    assert.equal(c.clientSecret, BI_MAT.clientSecret, "Client Secret bị xoá");
    assert.equal(c.hostEmail, "doi.email@congty.com", "email host không đổi được");
  });

  await bai("Z05", "email host không hợp lệ → từ chối", async () => {
    await dat();
    for (const xau of ["khong-phai-email", "a@b", "@congty.com", "  "]) {
      await assert.rejects(
        () => zoom.saveZoomConfig({ ...BI_MAT, hostEmail: xau }),
        (e) => e.ma === "ZOOM_CONFIG_INCOMPLETE",
        `nhận nhầm email xấu: ${JSON.stringify(xau)}`
      );
    }
    assert.equal(zoom.zoomCongKhai(await zoom.getZoomConfig()).configured, false, "đã ghi dù sai");
  });

  await bai("Z06", "cấu hình sau khi gộp vẫn thiếu → từ chối", async () => {
    await dat();
    await assert.rejects(
      () => zoom.saveZoomConfig({ accountId: "chi-co-cai-nay", hostEmail: BI_MAT.hostEmail }),
      (e) => e.ma === "ZOOM_CONFIG_INCOMPLETE"
    );
    assert.equal(zoom.zoomCongKhai(await zoom.getZoomConfig()).configured, false);
  });

  await bai("Z07", "Kiểm tra khi chưa có cấu hình → KHÔNG gọi Zoom lần nào", async () => {
    await dat();
    await assert.rejects(() => zoom.testZoomConnection(), (e) => e.ma === "ZOOM_CONFIG_INCOMPLETE");
    assert.equal(daGoi.length, 0, `đã gọi Zoom ${daGoi.length} lần dù chưa cấu hình`);
  });

  await bai("Z08", "xin token dùng grant_type=account_credentials", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: { email: BI_MAT.hostEmail } }]);
    await zoom.testZoomConnection();
    const u = new URL(daGoi[0].url);
    assert.equal(u.searchParams.get("grant_type"), "account_credentials");
    assert.equal(daGoi[0].options.method, "POST");
  });

  await bai("Z09", "xin token dùng đúng Account ID đã lưu", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: { email: BI_MAT.hostEmail } }]);
    await zoom.testZoomConnection();
    const u = new URL(daGoi[0].url);
    assert.equal(u.searchParams.get("account_id"), BI_MAT.accountId);
    assert.match(daGoi[0].options.headers.Authorization, /^Basic /, "phải dùng HTTP Basic");
  });

  await bai("Z10", "Zoom từ chối chìa khoá → lỗi an toàn, không kèm bí mật", async () => {
    await dat();
    await luuDu();
    datTraLoi([{ status: 401, body: { reason: "Invalid client_id or client_secret" } }]);
    await assert.rejects(
      () => zoom.testZoomConnection(),
      (e) => {
        assert.equal(e.ma, "ZOOM_AUTH_FAILED");
        assert.ok(!e.message.includes(BI_MAT.clientSecret), "thông điệp lỗi lộ Client Secret");
        assert.ok(!e.message.includes(BI_MAT.clientId), "thông điệp lỗi lộ Client ID");
        return true;
      }
    );
  });

  await bai("Z11", "access token KHÔNG bao giờ được ghi xuống CSDL", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: { email: BI_MAT.hostEmail } }]);
    await zoom.testZoomConnection();
    const rows = await docAppSecretsTho(DB_FILE);
    const tho = JSON.stringify(rows);
    assert.ok(!tho.includes(TOKEN_GIA), "token nằm trong app_secrets");
    assert.ok(!rows.some((r) => /token/i.test(r.key)), `có khoá dạng token: ${rows.map((r) => r.key).join(",")}`);
  });

  await bai("Z12", "access token KHÔNG bao giờ trả về trình duyệt", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: { email: BI_MAT.hostEmail, first_name: "A", last_name: "B" } }]);
    const kq = await zoom.testZoomConnection();
    const chuoi = JSON.stringify(kq);
    assert.ok(!chuoi.includes(TOKEN_GIA), `lộ token: ${chuoi}`);
    assert.ok(!/authorization|bearer|basic/i.test(chuoi), `lộ header xác thực: ${chuoi}`);
  });

  await bai("Z13", "tra cứu người dùng theo ĐÚNG email host đã cấu hình", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: { email: BI_MAT.hostEmail } }]);
    await zoom.testZoomConnection();
    assert.equal(daGoi.length, 2, "phải đúng 2 lượt gọi: token + user");
    assert.match(daGoi[1].url, /\/v2\/users\//, `đường dẫn sai: ${daGoi[1].url}`);
    assert.equal(daGoi[1].options.method, "GET");
    assert.ok(!daGoi[1].url.includes("/users/me"), "không được dùng /users/me");
  });

  await bai("Z14", "email host được mã hoá đúng chuẩn URL", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: { email: BI_MAT.hostEmail } }]);
    await zoom.testZoomConnection();
    const url = daGoi[1].url;
    assert.ok(url.includes(encodeURIComponent(BI_MAT.hostEmail)), `chưa mã hoá: ${url}`);
    assert.ok(!url.includes("+hop@"), `còn ký tự thô chưa mã hoá: ${url}`);
    assert.ok(url.includes("%2B") && url.includes("%40"), `thiếu %2B/%40: ${url}`);
  });

  await bai("Z15", "thiếu quyền → phân loại ZOOM_SCOPE_MISSING", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 403, body: { message: "Invalid access token, does not contain scopes" } }]);
    await assert.rejects(() => zoom.testZoomConnection(), (e) => e.ma === "ZOOM_SCOPE_MISSING");
  });

  await bai("Z16", "không có tài khoản host → ZOOM_HOST_NOT_FOUND", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 404, body: { message: "User does not exist" } }]);
    await assert.rejects(() => zoom.testZoomConnection(), (e) => e.ma === "ZOOM_HOST_NOT_FOUND");
  });

  await bai("Z17", "thành công → chỉ trả về danh tính tối thiểu", async () => {
    await dat();
    await luuDu();
    datTraLoi([
      okToken,
      {
        status: 200,
        body: {
          email: BI_MAT.hostEmail,
          first_name: "Minh",
          last_name: "Ngọc",
          type: 2,
          pmi: 123456789,
          phone_number: "+84900000000",
          personal_meeting_url: "https://zoom.us/j/123456789",
        },
      },
    ]);
    const kq = await zoom.testZoomConnection();
    assert.deepEqual(Object.keys(kq).sort(), ["displayName", "email", "ok", "userType"]);
    assert.equal(kq.email, BI_MAT.hostEmail);
    assert.equal(kq.displayName, "Minh Ngọc");
    const chuoi = JSON.stringify(kq);
    assert.ok(!chuoi.includes("123456789"), "bung cả PMI/link họp cá nhân");
    assert.ok(!chuoi.includes("84900000000"), "bung cả số điện thoại");
  });

  await bai("Z18", "Ngắt kết nối chỉ xoá cấu hình Zoom", async () => {
    await dat();
    await luuDu();
    await db.setAppSecret("session_secret", "KHOA-KY-PHIEN-KHONG-DUOC-DUNG");
    await zoom.clearZoomConfig();
    assert.equal(zoom.zoomCongKhai(await zoom.getZoomConfig()).configured, false, "chưa xoá Zoom");
    assert.equal(
      await db.getAppSecret("session_secret"),
      "KHOA-KY-PHIEN-KHONG-DUOC-DUNG",
      "đã đụng vào bí mật khác"
    );
  });

  await bai("Z19", "lưu/ngắt Zoom không đụng cấu hình Zoho", async () => {
    await dat();
    await db.saveZohoConfig({ clientId: "ZOHO-CID", clientSecret: "ZOHO-SECRET", diaChi: "a@zoho.com" });
    const truoc = await db.getZohoConfig();
    await luuDu();
    await zoom.clearZoomConfig();
    const sau = await db.getZohoConfig();
    assert.equal(sau.clientId, truoc.clientId, "Zoho clientId bị đổi");
    assert.equal(sau.clientSecret, truoc.clientSecret, "Zoho clientSecret bị đổi");
    assert.equal(sau.diaChi, truoc.diaChi, "Zoho địa chỉ bị đổi");
  });

  await bai("Z20", "lưu/ngắt Zoom không đụng trí nhớ Dạy Bot", async () => {
    await dat();
    const CHU = "111111111";
    await db.setOwnerInstruction(CHU, { uid: "900000001", instruction: "Xưng con.", displayName: "X" });
    const truoc = await db.getOwnerInstruction(CHU, "900000001");
    await luuDu();
    await zoom.clearZoomConfig();
    assert.equal(await db.getOwnerInstruction(CHU, "900000001"), truoc, "chỉ dẫn bị đổi");
  });

  await bai("Z21", "thẻ Zoom là selector toàn card, không còn UX nút Kết nối riêng", async () => {
    const html = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
    const vt = html.indexOf('data-tool="zoom"');
    const the = html.slice(html.lastIndexOf("<button", vt), html.indexOf("</button>", vt) + 9);
    assert.ok(vt > 0 && the.includes('role="tab"'), "Zoom card chưa thành selector tab");
    assert.ok(the.includes('aria-controls="zoom-detail"'), "Zoom card không điều khiển zoom-detail");
    assert.ok(the.includes('id="tool-zoom-status"'), "thiếu trạng thái kết nối sống");
    assert.ok(!the.includes("disabled"), "Zoom selector bị disabled");
    assert.ok(!html.includes('id="tool-zoom-connect"'), "vẫn còn nút Kết nối UX cũ");
  });

  await bai("Z22", "Google selectable nhưng vẫn frontend placeholder-only", async () => {
    const html = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
    const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
    const vt = html.indexOf('data-tool="google-meet"');
    const the = html.slice(html.lastIndexOf("<button", vt), html.indexOf("</button>", vt) + 9);
    assert.ok(the.includes('role="tab"') && !the.includes("disabled"), "Google card chưa selectable");
    assert.ok(html.includes('id="google-meet-detail"'), "thiếu Google placeholder detail");
    assert.ok(html.includes("Tính năng đang được thiết lập."), "thiếu copy placeholder");
    assert.ok(!server.includes("/api/google"), "đã thêm backend Google ngoài scope");
  });

  await bai("Z23", "bộ route Zoom đúng hợp đồng P2A+P2B+P2D", async () => {
    const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
    const routes = [...new Set((server.match(/["'`]\/api\/zoom[^"'`]*/g) || []).map((s) => s.slice(1)))];
    assert.deepEqual(routes.sort(), [
      "/api/zoom",
      "/api/zoom/cuoc-hop",
      "/api/zoom/cuoc-hop/:meetingId",
      "/api/zoom/kiem-tra",
      "/api/zoom/luu",
      "/api/zoom/ngat",
      "/api/zoom/tao-cuoc-hop",
    ]);
    for (const cam of ["/api/zoom/sua", "/api/zoom/xoa", "/api/zoom/danh-sach", "/api/zoom/lich-su"]) {
      assert.ok(!server.includes(cam), `có route ngoài hợp đồng: ${cam}`);
    }
  });

  await bai("Z24", "đường KIỂM TRA KẾT NỐI không đụng tới API cuộc họp", async () => {
    // P2A phai giu nguyen: testZoomConnection chi goi token + user, khong bao
    // gio cham /meetings; cac ham P2D rieng khong duoc lam doi hanh vi nay.
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: { email: BI_MAT.hostEmail } }]);
    await zoom.testZoomConnection();
    assert.equal(daGoi.length, 2);
    assert.ok(!daGoi.some((g) => g.url.includes("/meetings")), "kiểm tra kết nối gọi vào /meetings");
    const fe = fs.readFileSync(path.join(REPO, "public", "zoom.js"), "utf8");
    assert.ok(!fe.includes("/meetings"), "trình duyệt gọi thẳng Zoom");
  });

  await bai("Z25", "route Zoom nằm SAU cổng chặn đăng nhập", async () => {
    const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
    const cong = server.indexOf('res.status(401).json({ error: "Chưa đăng nhập." })');
    assert.ok(cong > 0, "không tìm thấy cổng chặn đăng nhập");
    for (const r of ['app.get("/api/zoom"', 'app.post("/api/zoom/luu"', 'app.post("/api/zoom/kiem-tra"', 'app.post("/api/zoom/ngat"']) {
      const vt = server.indexOf(r);
      assert.ok(vt > 0, `không tìm thấy route: ${r}`);
      assert.ok(vt > cong, `route nằm TRƯỚC cổng chặn: ${r}`);
    }
  });

  await bai("Z26", "quét rò rỉ: bí mật không xuất hiện ở bất kỳ đầu ra nào", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: { email: BI_MAT.hostEmail } }]);
    const ketQua = await zoom.testZoomConnection();

    const dauRa = [
      JSON.stringify(zoom.zoomCongKhai(await zoom.getZoomConfig())),
      JSON.stringify(ketQua),
      JSON.stringify(await docAppSecretsTho(DB_FILE)),
    ].join("\n");

    const basic = Buffer.from(`${BI_MAT.clientId}:${BI_MAT.clientSecret}`, "utf8").toString("base64");
    let soRoRi = 0;
    for (const [ten, giaTri] of [
      ["Client Secret", BI_MAT.clientSecret],
      ["access token", TOKEN_GIA],
      ["chuỗi Basic", basic],
    ]) {
      if (dauRa.includes(giaTri)) {
        soRoRi++;
        console.log(`   RO RI: ${ten}`);
      }
    }
    assert.equal(soRoRi, 0, `SECRET_LEAK = ${soRoRi}`);

    // Bi mat phai duoc MA HOA truoc khi ghi dia, khong nam tho trong app_secrets.
    const tho = JSON.stringify(await docAppSecretsTho(DB_FILE));
    assert.ok(!tho.includes(BI_MAT.clientSecret), "Client Secret nằm thô trong CSDL");
  });

  /* ================= M01–M45: TAO CUOC HOP (P2B) ================= */

  const HOP = {
    topic: "Lớp Marketing",
    date: "2026-08-25",
    time: "20:00",
    duration: 120,
    timezone: "Asia/Ho_Chi_Minh",
  };
  const START_URL_GIA = "https://zoom.us/s/987654321?zak=START_URL_HOST_SECRET_X";
  const okTao = () => ({
    status: 201,
    body: {
      id: 987654321,
      uuid: "UUID_TEST_X==",
      topic: "Lớp Marketing",
      type: 2,
      start_time: "2026-08-25T20:00:00",
      duration: 120,
      timezone: "Asia/Ho_Chi_Minh",
      join_url: "https://zoom.us/j/987654321?pwd=thamgia",
      start_url: START_URL_GIA,
      password: "PASSWORD_TEST_X",
      encrypted_password: "ENC_PASSWORD_TEST_X",
      h323_password: "112233",
      settings: { waiting_room: true },
    },
  });

  /** Khang dinh: dau vao hong -> tu choi VA khong mot goi mang nao. */
  async function tuChoiKhongGoi(ma, dauVao, maMongDoi = "ZOOM_MEETING_INPUT_INVALID") {
    daGoi = [];
    await assert.rejects(
      () => zoom.taoZoomMeeting(dauVao),
      (e) => e.ma === maMongDoi,
      `${ma}: không từ chối ${JSON.stringify(dauVao)}`
    );
    assert.equal(daGoi.length, 0, `${ma}: đã gọi Zoom ${daGoi.length} lần dù đầu vào hỏng`);
  }

  await bai("M01", "tên họp rỗng → từ chối, 0 lượt gọi Zoom", async () => {
    await dat();
    await luuDu();
    for (const t of ["", "   ", null, undefined]) await tuChoiKhongGoi("M01", { ...HOP, topic: t });
  });

  await bai("M02", "thiếu ngày → từ chối, 0 lượt gọi", async () => {
    await tuChoiKhongGoi("M02", { ...HOP, date: "" });
    await tuChoiKhongGoi("M02", { ...HOP, date: undefined });
  });

  await bai("M03", "ngày sai dạng / không tồn tại → từ chối", async () => {
    for (const d of ["25-08-2026", "2026/08/25", "2026-8-5", "2026-02-30", "2026-13-01"])
      await tuChoiKhongGoi("M03", { ...HOP, date: d });
  });

  await bai("M04", "thiếu giờ → từ chối, 0 lượt gọi", async () => {
    await tuChoiKhongGoi("M04", { ...HOP, time: "" });
    await tuChoiKhongGoi("M04", { ...HOP, time: undefined });
  });

  await bai("M05", "giờ sai dạng → từ chối", async () => {
    for (const t of ["25:00", "20:60", "8g30", "20h00", "20:00:00"])
      await tuChoiKhongGoi("M05", { ...HOP, time: t });
  });

  await bai("M06", "thời lượng < 1 → từ chối", async () => {
    for (const d of [0, -5]) await tuChoiKhongGoi("M06", { ...HOP, duration: d });
  });

  await bai("M07", "thời lượng > 1440 → từ chối", async () => {
    await tuChoiKhongGoi("M07", { ...HOP, duration: 1441 });
    await tuChoiKhongGoi("M07", { ...HOP, duration: 99999 });
  });

  await bai("M08", "thời lượng không nguyên → từ chối", async () => {
    for (const d of [60.5, "abc", NaN, null]) await tuChoiKhongGoi("M08", { ...HOP, duration: d });
  });

  await bai("M09", "múi giờ không hợp lệ → từ chối", async () => {
    for (const tz of ["Khong/TonTai", "GMT+7x", ""]) await tuChoiKhongGoi("M09", { ...HOP, timezone: tz });
  });

  await bai("M10", "chưa cấu hình Zoom đủ → 0 lượt gọi tạo họp", async () => {
    await dat(); // xoa sach cau hinh
    await tuChoiKhongGoi("M10", { ...HOP }, "ZOOM_CONFIG_INCOMPLETE");
  });

  await bai("M11", "xin token dùng ĐÚNG đường xác thực của P2A, không có bản thứ hai", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, okTao()]);
    await zoom.taoZoomMeeting(HOP);
    const u = new URL(daGoi[0].url);
    assert.ok(daGoi[0].url.startsWith("https://zoom.us/oauth/token"), `token sai máy chủ: ${daGoi[0].url}`);
    assert.equal(u.searchParams.get("grant_type"), "account_credentials");
    assert.match(daGoi[0].options.headers.Authorization, /^Basic /);
    // Trong nguon chi duoc co MOT noi biet den oauth/token.
    const nguon = fs.readFileSync(path.join(REPO, "lib", "zoom.js"), "utf8");
    assert.equal((nguon.match(/oauth\/token/g) || []).length, 1, "có bản xác thực thứ hai");
  });

  await bai("M12", "tạo họp dùng POST", async () => {
    assert.equal(daGoi[1].options.method, "POST");
  });

  await bai("M13", "đường dẫn đúng /v2/users/{host}/meetings", async () => {
    assert.equal(
      daGoi[1].url,
      `https://api.zoom.us/v2/users/${encodeURIComponent(BI_MAT.hostEmail)}/meetings`
    );
  });

  await bai("M14", "host lấy từ cấu hình backend, trình duyệt không tráo được", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, okTao()]);
    // Ke tan cong nhet hostEmail/userId vao than request -> phai bi lam ngo.
    await zoom.taoZoomMeeting({ ...HOP, hostEmail: "hacker@xau.com", userId: "hacker@xau.com" });
    assert.ok(!daGoi[1].url.includes("hacker"), `host bị tráo: ${daGoi[1].url}`);
    assert.ok(daGoi[1].url.includes(encodeURIComponent(BI_MAT.hostEmail)), "không dùng host đã lưu");
  });

  await bai("M15", "email host được mã hoá URL trong đường tạo họp", async () => {
    assert.ok(daGoi[1].url.includes("%2B") && daGoi[1].url.includes("%40"), daGoi[1].url);
    assert.ok(!daGoi[1].url.includes("+hop@"), daGoi[1].url);
  });

  await bai("M16", "thân request: type = 2 (họp đã lên lịch)", async () => {
    const than = JSON.parse(daGoi[1].options.body);
    assert.equal(than.type, 2);
  });

  await bai("M17", "thân request: topic là chữ người dùng đã cắt khoảng trắng", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, okTao()]);
    await zoom.taoZoomMeeting({ ...HOP, topic: "   Lớp Marketing   " });
    const than = JSON.parse(daGoi[1].options.body);
    assert.equal(than.topic, "Lớp Marketing", `topic bị đổi: ${JSON.stringify(than.topic)}`);
  });

  await bai("M18", "thân request: duration đúng số nguyên đã nhập", async () => {
    const than = JSON.parse(daGoi[1].options.body);
    assert.strictEqual(than.duration, 120);
  });

  await bai("M19", "thân request: start_time ghép đúng ngày + giờ", async () => {
    const than = JSON.parse(daGoi[1].options.body);
    assert.equal(than.start_time, "2026-08-25T20:00:00");
  });

  await bai("M20", "thân request: timezone đúng giá trị đã kiểm", async () => {
    const than = JSON.parse(daGoi[1].options.body);
    assert.equal(than.timezone, "Asia/Ho_Chi_Minh");
  });

  await bai("M21", "waiting_room = true", async () => {
    const than = JSON.parse(daGoi[1].options.body);
    assert.strictEqual(than.settings?.waiting_room, true);
    assert.strictEqual(than.settings?.use_pmi, false, "phải tắt PMI — mỗi họp một ID riêng");
  });

  await bai("M22", "default_password = true", async () => {
    const than = JSON.parse(daGoi[1].options.body);
    assert.strictEqual(than.default_password, true);
  });

  let ketQuaTao = null;
  await bai("M23", "thành công → trả về joinUrl", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, okTao()]);
    ketQuaTao = await zoom.taoZoomMeeting(HOP);
    assert.equal(ketQuaTao.joinUrl, "https://zoom.us/j/987654321?pwd=thamgia");
  });

  await bai("M24", "thành công → trả về meetingId", async () => {
    assert.equal(ketQuaTao.meetingId, "987654321");
  });

  await bai("M25", "start_url bị loại khỏi kết quả công khai", async () => {
    const chuoi = JSON.stringify(ketQuaTao);
    assert.ok(!chuoi.includes("START_URL_HOST_SECRET_X"), "lộ start_url");
    assert.ok(!("start_url" in ketQuaTao) && !("startUrl" in ketQuaTao));
  });

  await bai("M26", "password được đổi tên an toàn thành participantPasscode", async () => {
    const chuoi = JSON.stringify(ketQuaTao);
    assert.equal(ketQuaTao.participantPasscode, "PASSWORD_TEST_X");
    assert.ok(!("password" in ketQuaTao), "còn raw password key");
    assert.ok(!chuoi.includes("ENC_PASSWORD_TEST_X"), "lộ encrypted_password");
  });

  await bai("M27", "access token bị loại khỏi kết quả công khai", async () => {
    assert.ok(!JSON.stringify(ketQuaTao).includes(TOKEN_GIA));
  });

  await bai("M28", "không trả về raw response — hợp đồng khoá cứng danh sách trường", async () => {
    assert.deepEqual(
      Object.keys(ketQuaTao).sort(),
      ["duration", "hostEmail", "joinUrl", "meetingId", "ok", "participantPasscode", "startTime", "timezone", "topic"]
    );
    assert.ok(!JSON.stringify(ketQuaTao).includes("UUID_TEST_X"), "lộ uuid");
  });

  await bai("M29", "Zoom 401 khi tạo → lỗi an toàn", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 401, body: { message: "Invalid access token" } }]);
    await assert.rejects(() => zoom.taoZoomMeeting(HOP), (e) => e.ma === "ZOOM_AUTH_FAILED");
  });

  await bai("M30", "thiếu quyền tạo họp → ZOOM_MEETING_SCOPE_MISSING", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 403, body: { message: "does not contain scopes:[meeting:write]" } }]);
    await assert.rejects(() => zoom.taoZoomMeeting(HOP), (e) => e.ma === "ZOOM_MEETING_SCOPE_MISSING");
  });

  await bai("M31", "host không được phép lên lịch → lỗi an toàn riêng", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 400, body: { message: "This user cannot schedule meetings." } }]);
    await assert.rejects(() => zoom.taoZoomMeeting(HOP), (e) => e.ma === "ZOOM_HOST_CANNOT_SCHEDULE");
  });

  await bai("M32", "Zoom 429 → báo giới hạn tần suất, không thử lại", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 429, body: { message: "Too many requests" } }]);
    await assert.rejects(() => zoom.taoZoomMeeting(HOP), (e) => e.ma === "ZOOM_CREATE_RATE_LIMITED");
    assert.equal(daGoi.length, 2, `đã thử lại: ${daGoi.length} lượt gọi`);
  });

  await bai("M33", "nghẽn giữa chừng lúc tạo → báo KHÔNG XÁC ĐỊNH, tuyệt đối không POST lại", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { nem: Object.assign(new Error("aborted"), { name: "AbortError" }) }]);
    await assert.rejects(() => zoom.taoZoomMeeting(HOP), (e) => e.ma === "ZOOM_CREATE_UNCERTAIN");
    assert.equal(daGoi.length, 2, `số lượt gọi = ${daGoi.length}, POST tạo họp phải đúng 1 lần`);
    assert.equal(daGoi.filter((g) => g.url.includes("/meetings")).length, 1, "đã POST tạo họp lần hai");
  });

  await bai("M34", "một lần gọi backend = tối đa MỘT POST tạo họp", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, okTao()]);
    await zoom.taoZoomMeeting(HOP);
    assert.equal(daGoi.filter((g) => g.url.includes("/meetings")).length, 1);
    assert.equal(daGoi.length, 2, "chỉ được token + create");
  });

  await bai("M35", "không một dữ liệu cuộc họp nào được ghi xuống CSDL", async () => {
    const rows = await docAppSecretsTho(DB_FILE);
    const khoa = rows.map((r) => r.key);
    assert.ok(
      khoa.every((k) => k === "session_secret" || k.startsWith("zoom_")),
      `app_secrets có khoá lạ: ${khoa.join(",")}`
    );
    const tho = JSON.stringify(rows);
    assert.ok(!tho.includes("987654321") && !tho.includes("join_url"), "dữ liệu họp nằm trong CSDL");
  });

  await bai("M36", "chìa khoá Zoom không đổi sau khi tạo họp", async () => {
    const c = await zoom.getZoomConfig();
    assert.deepEqual(c, { ...BI_MAT }, "cấu hình bị thay đổi bởi việc tạo họp");
  });

  await bai("M37", "cấu hình/dữ liệu Zoho không bị đụng", async () => {
    const truoc = await db.getZohoConfig();
    await dat();
    await luuDu();
    datTraLoi([okToken, okTao()]);
    await zoom.taoZoomMeeting(HOP);
    const sau = await db.getZohoConfig();
    assert.deepEqual(sau, truoc, "Zoho config đổi sau khi tạo họp");
  });

  await bai("M38", "trí nhớ Dạy Bot không bị đụng", async () => {
    const CHU = "111111111";
    const truoc = await db.getOwnerInstruction(CHU, "900000001");
    await dat();
    await luuDu();
    datTraLoi([okToken, okTao()]);
    await zoom.taoZoomMeeting(HOP);
    assert.equal(await db.getOwnerInstruction(CHU, "900000001"), truoc);
  });

  await bai("M39", "Google vẫn không có backend nhưng có selector/detail placeholder", async () => {
    const html = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
    const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
    assert.ok(html.includes('data-tool="google-meet"'), "thiếu Google selector");
    assert.ok(html.includes('data-tool-detail="google-meet"'), "thiếu Google detail");
    assert.ok(html.includes("Tính năng đang được thiết lập."), "thiếu placeholder");
    assert.ok(!server.includes("/api/google"), "Google đã có backend ngoài scope");
  });

  await bai("M40", "P2C tái sử dụng đúng taoZoomMeeting, không tạo vòng import", async () => {
    const admin = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
    const zoomImport = admin.match(/import\s*\{([^}]+)\}\s*from "\.\/zoom\.js";/)?.[1] || "";
    assert.match(zoomImport, /\btaoZoomMeeting\b/);
    assert.ok(admin.includes("taoCuocHopZoom = taoZoomMeeting"));
    assert.ok(!admin.includes("oauth/token") && !admin.includes("api.zoom.us"), "admin-command đã nhân bản Zoom API");
    const nguon = fs.readFileSync(path.join(REPO, "lib", "zoom.js"), "utf8");
    assert.ok(!nguon.includes("admin-command"), "lib/zoom.js import admin-command");
  });

  await bai("M41", "KHÔNG có đường gửi Zalo nào từ mã Zoom", async () => {
    const nguon = fs.readFileSync(path.join(REPO, "lib", "zoom.js"), "utf8");
    assert.ok(!nguon.includes("zalo-service") && !nguon.includes("sendChatMessage"));
    const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
    const khoiZoom = server.slice(server.indexOf("/api/zoom/tao-cuoc-hop"), server.indexOf("SO HEN GIO"));
    assert.ok(!khoiZoom.includes("sendChatMessage"), "route tạo họp có gửi Zalo");
  });

  await bai("M42", "route tạo họp nằm SAU cổng chặn đăng nhập", async () => {
    const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
    const cong = server.indexOf('res.status(401).json({ error: "Chưa đăng nhập." })');
    const vt = server.indexOf('app.post("/api/zoom/tao-cuoc-hop"');
    assert.ok(cong > 0 && vt > cong);
  });

  await bai("M43", "frontend chặn bấm trùng nút Tạo cuộc họp", async () => {
    const fe = fs.readFileSync(path.join(REPO, "public", "zoom.js"), "utf8");
    const khoi = fe.slice(fe.indexOf('$("#zm-tao-hop").addEventListener'));
    assert.ok(khoi.includes("if (nut.disabled) return;"), "thiếu chốt chặn bấm trùng");
    const vtKhoa = khoi.indexOf("nut.disabled = true");
    const vtFetch = khoi.indexOf("fetch(");
    assert.ok(vtKhoa > 0 && vtKhoa < vtFetch, "phải khoá nút TRƯỚC khi fetch");
    assert.ok(khoi.includes("finally"), "thiếu mở khoá nút trong finally");
  });

  await bai("M44", "frontend chỉ vẽ các trường an toàn", async () => {
    const fe = fs.readFileSync(path.join(REPO, "public", "zoom.js"), "utf8");
    for (const cam of ["start_url", "startUrl", "hop.password", "encrypted_password"]) {
      assert.ok(!fe.includes(cam), `public/zoom.js đụng tới: ${cam}`);
    }
    assert.ok(fe.includes("participantPasscode"), "frontend chưa dùng participantPasscode");
  });

  await bai("M45", "nút sao chép dùng đúng payload ba dòng", async () => {
    const fe = fs.readFileSync(path.join(REPO, "public", "zoom.js"), "utf8");
    const payload = zoomUi.taoNoiDungSaoChep({
      meetingId: "123456789",
      participantPasscode: "456789",
      joinUrl: "https://zoom.us/j/123456789",
    });
    assert.equal(
      payload,
      "Meeting ID: 123456789\nPass: 456789\nLink tham gia: https://zoom.us/j/123456789"
    );
    assert.ok(fe.includes("clipboard.writeText(taoNoiDungSaoChep(data))"), "copy không dùng Detail payload chuẩn");
    assert.equal((fe.match(/clipboard\.writeText/g) || []).length, 1, "có nhiều điểm copy");
  });

  /* ================= UX01–UX28: TOOLS + MEETING UX V2 ================= */

  const htmlUx = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
  const appUx = fs.readFileSync(path.join(REPO, "public", "app.js"), "utf8");
  const zoomUx = fs.readFileSync(path.join(REPO, "public", "zoom.js"), "utf8");
  const cssUx = fs.readFileSync(path.join(REPO, "public", "style.css"), "utf8");
  const layCard = (tool) => {
    const vt = htmlUx.indexOf(`data-tool="${tool}"`);
    return htmlUx.slice(htmlUx.lastIndexOf("<button", vt), htmlUx.indexOf("</button>", vt) + 9);
  };

  await bai("UX01", "mặc định đúng một tool active và đó là Zoom", async () => {
    assert.equal((htmlUx.match(/class="tool-card active"/g) || []).length, 1);
    assert.ok(layCard("zoom").includes('aria-selected="true"'));
    assert.ok(appUx.includes('let activeTool = "zoom"'));
  });

  await bai("UX02", "chọn Zoho dùng exclusive detail switch", async () => {
    assert.ok(layCard("zoho").includes('aria-controls="zoho-detail"'));
    assert.ok(htmlUx.includes('data-tool-detail="zoho"'));
    assert.ok(appUx.includes('detail.classList.toggle("hidden", !dangChon)'));
  });

  await bai("UX03", "chọn Zoom dùng exclusive detail switch", async () => {
    assert.ok(layCard("zoom").includes('aria-controls="zoom-detail"'));
    assert.ok(htmlUx.includes('data-tool-detail="zoom"'));
    assert.ok(appUx.includes("detail.dataset.toolDetail === activeTool"));
  });

  await bai("UX04", "chọn Google dùng exclusive detail switch", async () => {
    assert.ok(layCard("google-meet").includes('aria-controls="google-meet-detail"'));
    assert.ok(htmlUx.includes('data-tool-detail="google-meet"'));
    assert.ok(appUx.includes("chonCongCu(card.dataset.tool, { napNoiDung: true })"));
  });

  await bai("UX05", "active card nhận class và aria-selected", async () => {
    assert.ok(appUx.includes('card.classList.toggle("active", dangChon)'));
    assert.ok(appUx.includes('card.setAttribute("aria-selected", String(dangChon))'));
    assert.ok(cssUx.includes(".tool-card.active"));
  });

  await bai("UX06", "card cũ mất active state khi activeTool đổi", async () => {
    assert.ok(appUx.includes("for (const card of toolCards)"));
    assert.ok(appUx.includes("card.dataset.tool === activeTool"));
    assert.ok(appUx.includes("activeTool = tool"));
  });

  await bai("UX07", "#email-panel tồn tại đúng một lần", async () => {
    assert.equal((htmlUx.match(/id="email-panel"/g) || []).length, 1);
  });

  await bai("UX08", "Zoom detail tồn tại đúng một lần", async () => {
    assert.equal((htmlUx.match(/id="zoom-detail"/g) || []).length, 1);
  });

  await bai("UX09", "Google detail tồn tại đúng một lần", async () => {
    assert.equal((htmlUx.match(/id="google-meet-detail"/g) || []).length, 1);
  });

  await bai("UX10", "đổi tool không dựng lại hoặc nhân bản Zoho DOM", async () => {
    const dau = appUx.indexOf("function chonCongCu");
    const cuoi = appUx.indexOf('toolGrid?.addEventListener("click"', dau);
    const khoi = appUx.slice(dau, cuoi);
    assert.ok(khoi.includes("classList.toggle"), "không toggle visibility");
    assert.ok(!khoi.includes("innerHTML") && !khoi.includes("napEmail"), "selection dựng lại Zoho");
    assert.equal((htmlUx.match(/id="email-panel"/g) || []).length, 1);
  });

  await bai("UX11", "public/email.js giữ nguyên canonical hash", async () => {
    const hash = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(REPO, "public", "email.js")))
      .digest("hex");
    assert.equal(hash, "d674c729721b73965db4476e15f75a531e18aa7b5808d0e8590e00ab0fbfd413");
  });

  await bai("UX12", "năm trường tạo cuộc họp vẫn hiện diện đúng một lần", async () => {
    for (const id of ["zm-hop-ten", "zm-hop-ngay", "zm-hop-gio", "zm-hop-phut", "zm-hop-mui-gio"]) {
      assert.equal((zoomUx.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    }
  });

  await bai("UX13", "desktop create form có grid một hàng và nút cạnh tiêu đề", async () => {
    assert.ok(zoomUx.includes('class="zoom-tao-luoi"'));
    assert.ok(zoomUx.includes('class="primary-button zoom-tao-submit"'));
    assert.ok(cssUx.includes("grid-template-areas:"));
    assert.ok(cssUx.includes('"title action"') && cssUx.includes('"form form"'));
  });

  await bai("UX14", "session append không còn là nguồn dashboard", async () => {
    assert.ok(!zoomUx.includes("createdMeetings"));
    assert.ok(!zoomUx.includes("themKetQuaPhien"));
  });

  await bai("UX15", "create thành công reload provider list", async () => {
    const khoi = zoomUx.slice(zoomUx.indexOf('$("#zm-tao-hop").addEventListener'));
    assert.ok(khoi.includes("await taiLaiSauMutation()"));
    assert.ok(!khoi.includes("appendChild(khung)"));
  });

  await bai("UX16", "chọn Zoom kích hoạt napZoom nhưng tool khác không kích hoạt list", async () => {
    assert.ok(appUx.includes('if (napNoiDung && activeTool === "zoom") void napZoom()'));
    assert.ok(appUx.includes('if (activeTool === "zoom") napZoom()'));
  });

  await bai("UX17", "provider row hiển thị Meeting ID", async () => {
    assert.ok(zoomUx.includes('themCot(khung, "zoom-lich-id", "Meeting ID", hop.meetingId)'));
  });

  await bai("UX18", "dashboard list không render participant passcode", async () => {
    const dong = zoomUx.slice(zoomUx.indexOf("const veDong"), zoomUx.indexOf("function veDanhSach"));
    assert.ok(!dong.includes("participantPasscode"));
  });

  await bai("UX19", "provider row mở joinUrl an toàn ở tab mới", async () => {
    assert.ok(zoomUx.includes("moLink.href = hop.joinUrl"));
    assert.ok(zoomUx.includes('moLink.target = "_blank"'));
    assert.ok(zoomUx.includes('moLink.rel = "noopener noreferrer"'));
  });

  await bai("UX20", "mỗi provider row copy bằng Detail on-demand", async () => {
    const khoi = zoomUx.slice(zoomUx.indexOf("const saoChepMeeting"), zoomUx.indexOf("const veFormSua"));
    assert.ok(khoi.includes("/api/zoom/cuoc-hop/${encodeURIComponent(hop.meetingId)}"));
    assert.ok(khoi.includes("taoNoiDungSaoChep(data)"));
  });

  await bai("UX21", "payload Copy của Detail 1 không lấy dữ liệu Detail 2", async () => {
    const mot = zoomUi.taoNoiDungSaoChep({ meetingId: "1", participantPasscode: "A", joinUrl: "url-1" });
    const hai = zoomUi.taoNoiDungSaoChep({ meetingId: "2", participantPasscode: "B", joinUrl: "url-2" });
    assert.ok(mot.includes("Meeting ID: 1") && mot.includes("url-1") && !mot.includes("url-2"));
    assert.ok(hai.includes("Meeting ID: 2") && hai.includes("url-2") && !hai.includes("url-1"));
  });

  await bai("UX22", "clipboard đúng chính xác hợp đồng ba dòng", async () => {
    assert.equal(
      zoomUi.taoNoiDungSaoChep({ meetingId: "9", participantPasscode: "P9", joinUrl: "join-9" }),
      "Meeting ID: 9\nPass: P9\nLink tham gia: join-9"
    );
  });

  await bai("UX23", "clipboard không chứa start_url", async () => {
    const payload = zoomUi.taoNoiDungSaoChep({ meetingId: "9", joinUrl: "join-9", start_url: "host-only" });
    assert.ok(!payload.includes("host-only") && !payload.includes("start_url"));
  });

  await bai("UX24", "clipboard không chứa Client Secret", async () => {
    const payload = zoomUi.taoNoiDungSaoChep({ meetingId: "9", joinUrl: "join-9", clientSecret: BI_MAT.clientSecret });
    assert.ok(!payload.includes(BI_MAT.clientSecret));
  });

  await bai("UX25", "clipboard không chứa access token", async () => {
    const payload = zoomUi.taoNoiDungSaoChep({ meetingId: "9", joinUrl: "join-9", accessToken: TOKEN_GIA });
    assert.ok(!payload.includes(TOKEN_GIA));
  });

  await bai("UX26", "passcode rỗng hiển thị/copy Không có", async () => {
    const payload = zoomUi.taoNoiDungSaoChep({ meetingId: "9", participantPasscode: "", joinUrl: "join-9" });
    assert.ok(payload.includes("Pass: Không có"));
    assert.ok(zoomUx.includes('|| "Không có"'));
  });

  await bai("UX27", "double-submit guard vẫn khoá trước fetch và mở trong finally", async () => {
    const khoi = zoomUx.slice(zoomUx.indexOf('$("#zm-tao-hop").addEventListener'));
    assert.ok(khoi.includes("if (nut.disabled) return;"));
    assert.ok(khoi.indexOf("nut.disabled = true") < khoi.indexOf("fetch("));
    assert.ok(khoi.includes("finally") && khoi.includes("nut.disabled = !configHienTai?.configured"));
  });

  await bai("UX28", "kết quả create không chắc chắn không tự retry", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { nem: Object.assign(new Error("aborted"), { name: "AbortError" }) }]);
    await assert.rejects(() => zoom.taoZoomMeeting(HOP), (e) => e.ma === "ZOOM_CREATE_UNCERTAIN");
    assert.equal(daGoi.filter((g) => g.url.includes("/meetings")).length, 1);
  });

  /* ================= T01–T07: TOOLS TYPOGRAPHY ================= */

  const cssTools = cssUx.slice(
    cssUx.indexOf("/* --- PHAN HE CONG CU --- */"),
    cssUx.indexOf("/* --- DANG NHAP / TAI KHOAN --- */")
  );

  await bai("T01", "tiêu đề Công cụ dùng page-title token 24/700", async () => {
    assert.ok(cssTools.includes("--tools-text-page-title: 24px;"));
    const rule = cssTools.slice(cssTools.indexOf(".tools-header h2"), cssTools.indexOf(".tools-header p"));
    assert.ok(rule.includes("font-size: var(--tools-text-page-title)"));
    assert.ok(rule.includes("font-weight: 700") && rule.includes("line-height: 1.3"));
  });

  await bai("T02", "các detail title dùng section-title token 18/700", async () => {
    assert.ok(cssTools.includes("--tools-text-section-title: 18px;"));
    const rule = cssTools.slice(cssTools.indexOf(".tools-detail-title"), cssTools.indexOf(".tools-detail-status"));
    assert.ok(rule.includes("font-size: var(--tools-text-section-title)"));
    assert.ok(rule.includes("font-weight: 700") && rule.includes("line-height: 1.4"));
  });

  await bai("T03", "mọi tool card title dùng cùng token 16/600", async () => {
    assert.ok(cssTools.includes("--tools-text-card-title: 16px;"));
    const rule = cssTools.slice(cssTools.indexOf(".tool-name"), cssTools.indexOf(".tool-desc"));
    assert.ok(rule.includes("font-size: var(--tools-text-card-title)"));
    assert.ok(rule.includes("font-weight: 600") && rule.includes("line-height: 1.4"));
  });

  await bai("T04", "mọi form label trong Tools dùng cùng token 13/500", async () => {
    assert.ok(cssTools.includes("--tools-text-label: 13px;"));
    const rule = cssTools.slice(cssTools.indexOf(".tools-panel label"), cssTools.indexOf(".tools-panel .field-hint"));
    assert.ok(rule.includes("font-size: var(--tools-text-label)"));
    assert.ok(rule.includes("font-weight: 500") && rule.includes("line-height: 1.4"));
  });

  await bai("T05", "input và select trong Tools dùng cùng token 14/400", async () => {
    assert.ok(cssTools.includes("--tools-text-input: 14px;"));
    const rule = cssTools.slice(cssTools.indexOf(".tools-panel input"), cssTools.indexOf(".tools-panel label"));
    assert.ok(rule.includes(".tools-panel select"));
    assert.ok(rule.includes("font-size: var(--tools-text-input)"));
    assert.ok(rule.includes("font-weight: 400") && rule.includes("line-height: normal"));
  });

  await bai("T06", "mọi button trong Tools dùng cùng token 14/600", async () => {
    assert.ok(cssTools.includes("--tools-text-button: 14px;"));
    const rule = cssTools.slice(cssTools.indexOf(".tools-panel button"), cssTools.indexOf(".tools-panel input"));
    assert.ok(rule.includes("font-size: var(--tools-text-button)"));
    assert.ok(rule.includes("font-weight: 600") && rule.includes("line-height: 1.4"));
  });

  await bai("T07", "không có cỡ chữ Tools tuỳ tiện ngoài type scale đã duyệt", async () => {
    const approved = new Set([12, 13, 14, 15, 16, 18, 24]);
    const rawSizes = [...cssTools.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]));
    assert.ok(rawSizes.every((size) => approved.has(size)), `cỡ chữ lạ: ${rawSizes.join(", ")}`);
    for (const token of [
      "page-title: 24px", "section-title: 18px", "subsection-title: 15px",
      "card-title: 16px", "body: 14px", "label: 13px", "meta: 12px",
      "button: 14px", "input: 14px",
    ]) {
      assert.ok(cssTools.includes(`--tools-text-${token};`), `thiếu token ${token}`);
    }
  });

  /* ================= C01–C10: ZOOM CONFIG COLLAPSE ================= */

  await bai("C01", "Zoom đã cấu hình khởi đầu với credential form thu gọn", async () => {
    assert.equal(zoomUi.cauHinhZoomMoMacDinh({ configured: true }), false);
    assert.ok(zoomUx.includes("datMoCauHinh(cauHinhZoomMoMacDinh(config))"));
    assert.ok(cssUx.includes(".zoom-cau-hinh[hidden]"));
    assert.ok(cssUx.includes("display: none;"));
  });

  await bai("C02", "Zoom đã cấu hình vẫn hiện trạng thái kết nối an toàn", async () => {
    assert.ok(zoomUx.includes("Đã kết nối · ${config.hostEmail}"));
    assert.ok(!zoomUx.includes("config.clientSecret"), "frontend đọc Client Secret công khai");
  });

  await bai("C03", "Zoom đã cấu hình có action Cấu hình kết nối", async () => {
    assert.ok(zoomUx.includes('id="zm-ket-noi-actions"'));
    assert.ok(zoomUx.includes('id="zm-cau-hinh-toggle"'));
    assert.ok(zoomUx.includes("Cấu hình kết nối</button>"));
    assert.ok(zoomUx.includes('$("#zm-ket-noi-actions").hidden = !config?.configured'));
  });

  await bai("C04", "action Cấu hình kết nối mở được credential form", async () => {
    assert.ok(zoomUx.includes('aria-controls="zm-cau-hinh-noi-dung"'));
    const block = zoomUx.slice(
      zoomUx.indexOf('$("#zm-cau-hinh-toggle").addEventListener'),
      zoomUx.indexOf('$("#zm-mo-tao").addEventListener')
    );
    assert.ok(block.includes('datMoCauHinh($("#zm-cau-hinh-noi-dung").hidden)'));
    assert.ok(zoomUx.includes('nut.setAttribute("aria-expanded", String(mo))'));
  });

  await bai("C05", "credential đã lưu vẫn được bảo vệ khi mở form", async () => {
    assert.ok(zoomUx.includes('id="zm-client-secret" type="password"'));
    assert.ok(zoomUx.includes('$("#zm-client-secret").value = ""'));
    assert.ok(zoomUx.includes("(đã lưu — để trống nếu không đổi)"));
    assert.ok(!zoomUx.includes("config?.clientSecret"), "đã đưa Client Secret vào DOM");
  });

  await bai("C06", "Lưu giữ nguyên route và thu gọn lại sau khi thành công", async () => {
    const block = zoomUx.slice(
      zoomUx.indexOf('$("#zm-luu").addEventListener'),
      zoomUx.indexOf('$("#zm-kiem-tra").addEventListener')
    );
    assert.ok(block.includes('fetch("/api/zoom/luu"'));
    assert.ok(block.includes("veCauHinh(data.config)"));
    assert.ok(block.includes('body: JSON.stringify({'));
    assert.equal((zoomUx.match(/id="zm-luu"/g) || []).length, 1, "nút Lưu bị nhân bản");
  });

  await bai("C07", "Kiểm tra giữ nguyên route và chỉ nằm ở action row", async () => {
    assert.ok(zoomUx.includes('fetch("/api/zoom/kiem-tra", { method: "POST" })'));
    assert.equal((zoomUx.match(/id="zm-kiem-tra"/g) || []).length, 1);
  });

  await bai("C08", "Ngắt kết nối giữ nguyên route và chỉ nằm ở action row", async () => {
    assert.ok(zoomUx.includes('fetch("/api/zoom/ngat", { method: "POST" })'));
    assert.equal((zoomUx.match(/id="zm-ngat"/g) || []).length, 1);
  });

  await bai("C09", "Zoom chưa cấu hình khởi đầu với setup mở", async () => {
    assert.equal(zoomUi.cauHinhZoomMoMacDinh({ configured: false }), true);
    assert.equal(zoomUi.cauHinhZoomMoMacDinh({}), true);
  });

  await bai("C10", "khu tạo họp nằm ngoài credential form và mở khi đã cấu hình", async () => {
    const configStart = zoomUx.indexOf('class="zoom-ket-noi"');
    const configEnd = zoomUx.indexOf("</section>", configStart);
    const createStart = zoomUx.indexOf('class="zoom-tao-hop"');
    assert.ok(configStart > 0 && configEnd > configStart && createStart > configEnd);
    assert.ok(zoomUx.includes('$("#zm-tao-hop").disabled = !config?.configured'));
  });

  /* ================= TZ01–TZ14: TIMEZONE SELECT ================= */

  await bai("TZ01", "múi giờ là select native", async () => {
    assert.ok(zoomUx.includes('<select id="zm-hop-mui-gio">'));
    assert.ok(zoomUx.includes("${tuyChonMuiGioHtml()}</select>"));
  });

  await bai("TZ02", "múi giờ không còn là input free-text", async () => {
    assert.ok(!zoomUx.includes('<input id="zm-hop-mui-gio"'));
    assert.equal((zoomUx.match(/id="zm-hop-mui-gio"/g) || []).length, 1);
  });

  await bai("TZ03", "mặc định là Asia/Ho_Chi_Minh", async () => {
    assert.equal(zoomUi.MUI_GIO_MAC_DINH, "Asia/Ho_Chi_Minh");
    assert.equal(zoomUi.CAC_MUI_GIO_ZOOM[0].value, "Asia/Ho_Chi_Minh");
  });

  await bai("TZ04", "dropdown có nhãn Việt Nam (GMT+7)", async () => {
    assert.deepEqual(zoomUi.CAC_MUI_GIO_ZOOM[0], {
      value: "Asia/Ho_Chi_Minh",
      label: "Việt Nam (GMT+7)",
    });
  });

  await bai("TZ05", "dropdown có Bangkok", async () => {
    assert.ok(zoomUi.CAC_MUI_GIO_ZOOM.some((x) => x.value === "Asia/Bangkok"));
  });

  await bai("TZ06", "dropdown có Singapore", async () => {
    assert.ok(zoomUi.CAC_MUI_GIO_ZOOM.some((x) => x.value === "Asia/Singapore"));
  });

  await bai("TZ07", "dropdown có Tokyo", async () => {
    assert.ok(zoomUi.CAC_MUI_GIO_ZOOM.some((x) => x.value === "Asia/Tokyo"));
  });

  await bai("TZ08", "dropdown có London", async () => {
    assert.ok(zoomUi.CAC_MUI_GIO_ZOOM.some((x) => x.value === "Europe/London"));
  });

  await bai("TZ09", "dropdown có New York", async () => {
    assert.ok(zoomUi.CAC_MUI_GIO_ZOOM.some((x) => x.value === "America/New_York"));
  });

  await bai("TZ10", "dropdown có UTC và đủ danh sách thực dụng", async () => {
    assert.ok(zoomUi.CAC_MUI_GIO_ZOOM.some((x) => x.value === "UTC"));
    assert.equal(zoomUi.CAC_MUI_GIO_ZOOM.length, 12);
  });

  await bai("TZ11", "giá trị được chọn gửi IANA value", async () => {
    for (const { value } of zoomUi.CAC_MUI_GIO_ZOOM) {
      assert.match(value, /^(?:[A-Za-z_]+\/[A-Za-z_]+|UTC)$/);
      assert.equal(zoomUi.layMuiGioDaChon({ value }), value);
    }
    assert.ok(zoomUx.includes('timezone: layMuiGioDaChon($("#zm-hop-mui-gio"))'));
  });

  await bai("TZ12", "friendly label không bao giờ tới backend", async () => {
    assert.equal(zoomUi.layMuiGioDaChon({ value: "Việt Nam (GMT+7)" }), "Asia/Ho_Chi_Minh");
    await dat();
    await luuDu();
    await assert.rejects(
      () => zoom.taoZoomMeeting({ ...HOP, timezone: "Việt Nam (GMT+7)" }),
      (error) => error.ma === "ZOOM_MEETING_INPUT_INVALID"
    );
    assert.equal(daGoi.length, 0, "backend đã gọi mạng với friendly label");
  });

  await bai("TZ13", "chọn múi giờ khác làm thay đổi payload", async () => {
    assert.equal(zoomUi.layMuiGioDaChon({ value: "Asia/Tokyo" }), "Asia/Tokyo");
    assert.equal(zoomUi.layMuiGioDaChon({ value: "America/New_York" }), "America/New_York");
    assert.notEqual(
      zoomUi.layMuiGioDaChon({ value: "Asia/Tokyo" }),
      zoomUi.layMuiGioDaChon({ value: "America/New_York" })
    );
  });

  await bai("TZ14", "create validation vẫn nhận timezone IANA thay thế", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, okTao()]);
    await zoom.taoZoomMeeting({ ...HOP, timezone: "Europe/London" });
    const body = JSON.parse(daGoi[1].options.body);
    assert.equal(body.timezone, "Europe/London");
    assert.equal(daGoi.filter((call) => call.url.includes("/meetings")).length, 1);
  });

  /* ================= P2C-C01–C57: BOT COMMAND -> PREVIEW -> OK ================= */

  const adminCmd = await napLib("admin-command.js");
  const CHU_P2C = "owner-p2c";
  const ADMIN_P2C = "admin-p2c";
  const KHACH_P2C = "customer-p2c";
  const NHOM_P2C = "group-p2c";
  const MOC_P2C = Date.parse("2026-08-24T05:00:00.000Z"); // 12:00 ngay 24/08 tai Viet Nam
  const LENH_CHUAN = "Tạo Zoom lớp Marketing lúc 8 giờ tối mai trong 2 tiếng";
  const KET_QUA_CHAT_GIA = {
    meetingId: "246813579",
    participantPasscode: "PASS-P2C",
    joinUrl: "https://zoom.us/j/246813579?pwd=p2c",
  };
  const taoP2CGoi = [];
  const guiP2CGoi = [];
  let ketQuaTaoP2C = async (deXuat) => ({ ...KET_QUA_CHAT_GIA, deXuat });

  adminCmd.capHinhChuTaiKhoan(() => CHU_P2C);
  adminCmd.capHinhDongHoZoom(() => MOC_P2C);
  adminCmd.capHinhTaoZoom(async (deXuat) => {
    taoP2CGoi.push(structuredClone(deXuat));
    return ketQuaTaoP2C(deXuat);
  });
  adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "khong_hieu", lyDo: "P2C test" }));

  await db.setAdminZalo(CHU_P2C, ADMIN_P2C, "Admin P2C");
  const mocThreadP2C = Math.floor(MOC_P2C / 1000);
  await db.upsertThread(CHU_P2C, {
    id: NHOM_P2C,
    threadType: 1,
    title: "Nhóm P2C",
    lastMessage: "seed",
    lastMessageAt: mocThreadP2C,
    updatedAt: mocThreadP2C,
  });

  const tinP2C = (content, threadId = ADMIN_P2C, senderId = ADMIN_P2C) => ({
    threadId,
    threadType: 0,
    senderId,
    senderName: senderId === ADMIN_P2C ? "Admin P2C" : "Khách P2C",
    content,
  });
  const guiP2CGia = async (payload) => { guiP2CGoi.push(structuredClone(payload)); };
  const noiP2C = (content, threadId = ADMIN_P2C) => adminCmd.xuLyLenh(tinP2C(content, threadId), guiP2CGia);
  const datTaoP2CGia = (fn = async () => KET_QUA_CHAT_GIA) => {
    taoP2CGoi.length = 0;
    ketQuaTaoP2C = fn;
    adminCmd.capHinhTaoZoom(async (deXuat) => {
      taoP2CGoi.push(structuredClone(deXuat));
      return ketQuaTaoP2C(deXuat);
    });
  };
  const huyP2C = async (threadId) => {
    adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "khong_hieu", lyDo: "P2C cleanup" }));
    await noiP2C("hủy", threadId);
    await noiP2C("hủy", threadId);
  };
  const xemRoiOK = async (token, threadId, fn = async () => KET_QUA_CHAT_GIA) => {
    datTaoP2CGia(fn);
    const xem = await noiP2C(LENH_CHUAN, threadId);
    assert.match(xem, /Trả lời OK/);
    const xong = await noiP2C(token, threadId);
    return { xem, xong };
  };
  const tuChoiLenhP2C = async (ma, lenh) => {
    const threadId = `reject-${ma}`;
    datTaoP2CGia();
    const traLoi = await noiP2C(lenh, threadId);
    assert.match(traLoi, /chưa đủ thông tin/i, traLoi);
    assert.equal(taoP2CGoi.length, 0, `${ma}: lenh hong da goi create`);
    await noiP2C("OK", threadId);
    assert.equal(taoP2CGoi.length, 0, `${ma}: lenh hong da tao pending`);
  };

  await bai("P2C-C01", "authorized admin Zoom command được nhận diện", async () => {
    assert.equal(await adminCmd.laLenhAdmin(tinP2C(LENH_CHUAN)), true);
    assert.equal(adminCmd.laLenhTaoZoom(LENH_CHUAN), true);
  });

  await bai("P2C-C02", "khách thường nói câu Zoom không tạo pending", async () => {
    datTaoP2CGia();
    const tin = tinP2C(LENH_CHUAN, KHACH_P2C, KHACH_P2C);
    assert.equal(await adminCmd.laLenhAdmin(tin), false);
    assert.equal(taoP2CGoi.length, 0);
  });

  await bai("P2C-C03", "khách thường gửi OK không bao giờ tạo Zoom", async () => {
    datTaoP2CGia();
    const tin = tinP2C("OK", KHACH_P2C, KHACH_P2C);
    assert.equal(await adminCmd.laLenhAdmin(tin), false);
    assert.equal(taoP2CGoi.length, 0);
  });

  await bai("P2C-C04", "nguồn admin là account_config hiện có", async () => {
    assert.deepEqual(await db.getAdminZalo(CHU_P2C), { uid: ADMIN_P2C, label: "Admin P2C" });
    assert.equal(await adminCmd.laLenhAdmin(tinP2C("OK")), true);
  });

  await bai("P2C-C05", "câu chuẩn tách topic Lớp Marketing", async () => {
    assert.equal(adminCmd.phanTichLenhTaoZoom(LENH_CHUAN).topic, "Lớp Marketing");
  });

  await bai("P2C-C06", "8 giờ tối thành 20:00", async () => {
    assert.equal(adminCmd.phanTichLenhTaoZoom(LENH_CHUAN).time, "20:00");
  });

  await bai("P2C-C07", "8 giờ sáng thành 08:00", async () => {
    const kq = adminCmd.phanTichLenhTaoZoom("Tạo Zoom Họp sáng lúc 8 giờ sáng mai trong 1 giờ");
    assert.equal(kq.time, "08:00");
  });

  await bai("P2C-C08", "20h được parse", async () => {
    const kq = adminCmd.phanTichLenhTaoZoom("Tạo Zoom Họp team lúc 20h ngày mai trong 60 phút");
    assert.equal(kq.time, "20:00");
  });

  await bai("P2C-C09", "14:30 được parse", async () => {
    const kq = adminCmd.phanTichLenhTaoZoom("Tạo Zoom Demo sản phẩm lúc 14:30 ngày 26/8 trong 90 phút");
    assert.equal(kq.time, "14:30");
  });

  await bai("P2C-C10", "mai tính theo Asia/Ho_Chi_Minh", async () => {
    assert.equal(adminCmd.phanTichLenhTaoZoom(LENH_CHUAN).date, "2026-08-25");
  });

  await bai("P2C-C11", "ngày mai được parse", async () => {
    const kq = adminCmd.phanTichLenhTaoZoom("Tạo Zoom Họp team lúc 20h ngày mai trong 60 phút");
    assert.equal(kq.date, "2026-08-25");
  });

  await bai("P2C-C12", "dd/mm được parse", async () => {
    const kq = adminCmd.phanTichLenhTaoZoom("Tạo Zoom Demo lúc 14:30 ngày 26/8 trong 90 phút");
    assert.equal(kq.date, "2026-08-26");
  });

  await bai("P2C-C13", "dd/mm/yyyy được parse", async () => {
    const kq = adminCmd.phanTichLenhTaoZoom("Tạo Zoom Demo lúc 14:30 26/08/2026 trong 90 phút");
    assert.equal(kq.date, "2026-08-26");
  });

  await bai("P2C-C14", "2 tiếng thành 120 phút", async () => {
    assert.equal(adminCmd.phanTichLenhTaoZoom(LENH_CHUAN).duration, 120);
  });

  await bai("P2C-C15", "2 giờ thành 120 phút", async () => {
    const kq = adminCmd.phanTichLenhTaoZoom("Tạo Zoom Demo lúc 20h mai trong 2 giờ");
    assert.equal(kq.duration, 120);
  });

  await bai("P2C-C16", "120 phút thành 120 phút", async () => {
    const kq = adminCmd.phanTichLenhTaoZoom("Tạo Zoom Demo lúc 20h mai trong 120 phút");
    assert.equal(kq.duration, 120);
  });

  await bai("P2C-C17", "1 tiếng 30 phút thành 90 phút", async () => {
    const kq = adminCmd.phanTichLenhTaoZoom("Tạo Zoom Demo lúc 20h mai trong 1 tiếng 30 phút");
    assert.equal(kq.duration, 90);
  });

  await bai("P2C-C18", "thiếu topic bị từ chối, không pending/create", () =>
    tuChoiLenhP2C("C18", "Tạo Zoom lúc 20h mai trong 60 phút"));
  await bai("P2C-C19", "thiếu ngày bị từ chối, không pending/create", () =>
    tuChoiLenhP2C("C19", "Tạo Zoom Demo lúc 20h trong 60 phút"));
  await bai("P2C-C20", "thiếu giờ bị từ chối, không pending/create", () =>
    tuChoiLenhP2C("C20", "Tạo Zoom Demo lúc ngày mai trong 60 phút"));
  await bai("P2C-C21", "thiếu thời lượng bị từ chối, không pending/create", () =>
    tuChoiLenhP2C("C21", "Tạo Zoom Demo lúc 20h mai"));
  await bai("P2C-C22", "giờ vô lý bị từ chối, không pending/create", () =>
    tuChoiLenhP2C("C22", "Tạo Zoom Demo lúc 25h mai trong 60 phút"));
  await bai("P2C-C23", "ngày vô lý bị từ chối, không pending/create", () =>
    tuChoiLenhP2C("C23", "Tạo Zoom Demo lúc 20h ngày 31/2/2026 trong 60 phút"));
  await bai("P2C-C24", "thời lượng vô lý bị từ chối, không pending/create", () =>
    tuChoiLenhP2C("C24", "Tạo Zoom Demo lúc 20h mai trong 0 phút"));

  let xemChuanP2C = "";
  await bai("P2C-C25", "lệnh đầu tạo preview", async () => {
    datTaoP2CGia();
    xemChuanP2C = await noiP2C(LENH_CHUAN, "preview-main");
    assert.match(xemChuanP2C, /Em hiểu bạn muốn tạo/);
  });
  await bai("P2C-C26", "preview chứa topic", async () => {
    assert.match(xemChuanP2C, /Tên: Lớp Marketing/);
  });
  await bai("P2C-C27", "preview chứa ngày tuyệt đối", async () => {
    assert.match(xemChuanP2C, /25\/08\/2026/);
  });
  await bai("P2C-C28", "preview chứa HH:mm chuẩn hóa", async () => {
    assert.match(xemChuanP2C, /20:00/);
  });
  await bai("P2C-C29", "preview chứa thời lượng phút", async () => {
    assert.match(xemChuanP2C, /120 phút/);
  });
  await bai("P2C-C30", "preview chứa Việt Nam GMT+7", async () => {
    assert.match(xemChuanP2C, /Việt Nam \(GMT\+7\)/);
  });
  await bai("P2C-C31", "preview bảo trả lời OK", async () => {
    assert.match(xemChuanP2C, /Trả lời OK để tạo cuộc họp/);
  });
  await bai("P2C-C32", "lệnh đầu gọi create đúng 0 lần", async () => {
    assert.equal(taoP2CGoi.length, 0);
    await huyP2C("preview-main");
  });

  await bai("P2C-C33", "exact OK xác nhận", async () => {
    await xemRoiOK("OK", "confirm-OK");
    assert.equal(taoP2CGoi.length, 1);
  });
  await bai("P2C-C34", "Ok xác nhận", async () => {
    await xemRoiOK("Ok", "confirm-Ok");
    assert.equal(taoP2CGoi.length, 1);
  });
  await bai("P2C-C35", "ok xác nhận", async () => {
    await xemRoiOK("ok", "confirm-ok");
    assert.equal(taoP2CGoi.length, 1);
  });
  await bai("P2C-C36", "OK có khoảng trắng xác nhận sau trim", async () => {
    await xemRoiOK("  OK  ", "confirm-trim");
    assert.equal(taoP2CGoi.length, 1);
  });

  for (const [ma, token] of [
    ["P2C-C37", "xác nhận"],
    ["P2C-C38", "xac nhan"],
    ["P2C-C39", "OK."],
    ["P2C-C40", "okay"],
  ]) {
    await bai(ma, `${JSON.stringify(token)} không xác nhận`, async () => {
      const threadId = `reject-token-${ma}`;
      datTaoP2CGia();
      await noiP2C(LENH_CHUAN, threadId);
      const traLoi = await noiP2C(token, threadId);
      assert.equal(taoP2CGoi.length, 0);
      assert.match(traLoi, /trả lời OK/i);
      await huyP2C(threadId);
    });
  }

  await bai("P2C-C41", "OK không pending gây zero side effect", async () => {
    datTaoP2CGia();
    const traLoi = await noiP2C("OK", "no-pending");
    assert.equal(taoP2CGoi.length, 0);
    assert.match(traLoi, /không có thao tác nào đang chờ OK/i);
  });

  await bai("P2C-C42", "OK hợp lệ gọi taoZoomMeeting đúng một lần", async () => {
    await xemRoiOK("OK", "once-seam");
    assert.equal(taoP2CGoi.length, 1);
    assert.deepEqual(taoP2CGoi[0], HOP);
  });

  await bai("P2C-C43", "một OK tạo tối đa một Create Meeting POST qua seam mạng", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, okTao()]);
    adminCmd.capHinhTaoZoom(zoom.taoZoomMeeting);
    const threadId = "one-real-path";
    await noiP2C(LENH_CHUAN, threadId);
    const xong = await noiP2C("OK", threadId);
    assert.match(xong, /Meeting ID: 987654321/);
    assert.equal(daGoi.filter((g) => g.url.includes("/meetings")).length, 1);
    datTaoP2CGia();
  });

  let thanhCongP2C = "";
  await bai("P2C-C44", "thành công có Meeting ID", async () => {
    ({ xong: thanhCongP2C } = await xemRoiOK("OK", "success-chat"));
    assert.match(thanhCongP2C, /Meeting ID: 246813579/);
  });
  await bai("P2C-C45", "thành công có Pass participant", async () => {
    assert.match(thanhCongP2C, /Pass: PASS-P2C/);
  });
  await bai("P2C-C46", "thành công có Link tham gia", async () => {
    assert.match(thanhCongP2C, /Link tham gia: https:\/\/zoom\.us\/j\/246813579/);
  });

  await bai("P2C-C47", "hủy xóa Zoom pending", async () => {
    const threadId = "cancel-clears";
    datTaoP2CGia();
    await noiP2C(LENH_CHUAN, threadId);
    const huy = await noiP2C("hủy", threadId);
    assert.match(huy, /Đã hủy tạo cuộc họp Zoom/);
    const sau = await noiP2C("OK", threadId);
    assert.match(sau, /không có thao tác nào đang chờ OK/i);
  });
  await bai("P2C-C48", "cancel tạo đúng zero meeting", async () => {
    assert.equal(taoP2CGoi.length, 0);
  });

  await bai("P2C-C49", "reply không liên quan làm Zoom pending hết hiệu lực", async () => {
    const threadId = "stale-reply";
    datTaoP2CGia();
    await noiP2C(LENH_CHUAN, threadId);
    const traLoi = await noiP2C("tôi sẽ nhắn lại sau", threadId);
    assert.match(traLoi, /xem trước tạo Zoom đã được huỷ/i);
    assert.equal(taoP2CGoi.length, 0);
  });
  await bai("P2C-C50", "OK muộn sau stale không tạo gì", async () => {
    const traLoi = await noiP2C("OK", "stale-reply");
    assert.match(traLoi, /không có thao tác nào đang chờ OK/i);
    assert.equal(taoP2CGoi.length, 0);
  });

  await bai("P2C-C51", "restart/lost-memory không có Zoom pending bền vững", async () => {
    const freshUrl = `${pathToFileURL(path.join(REPO, "lib", "admin-command.js")).href}?restart=${Date.now()}`;
    const fresh = await import(freshUrl);
    let freshCreate = 0;
    fresh.capHinhChuTaiKhoan(() => CHU_P2C);
    fresh.capHinhTaoZoom(async () => { freshCreate++; return KET_QUA_CHAT_GIA; });
    const traLoi = await fresh.xuLyLenh(tinP2C("OK", "restart-p2c"), guiP2CGia);
    assert.match(traLoi, /không có thao tác nào đang chờ OK/i);
    assert.equal(freshCreate, 0);
  });

  await bai("P2C-C52", "gui_tin pending chặn Zoom pending", async () => {
    const threadId = "conflict-gui";
    adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "gui_tin", dichIds: [NHOM_P2C], noiDung: "Tin thử" }));
    await noiP2C("gửi tin thử", threadId);
    const traLoi = await noiP2C(LENH_CHUAN, threadId);
    assert.match(traLoi, /thao tác khác chờ OK/i);
    await huyP2C(threadId);
  });

  await bai("P2C-C53", "dat_lich pending chặn Zoom pending", async () => {
    const threadId = "conflict-schedule";
    adminCmd.capHinhPhanTichLenh(async () => ({
      hanhDong: "dat_lich",
      lich: [{ dichId: NHOM_P2C, dichTen: "Nhóm P2C", noiDung: "Tin hẹn", luc: "2099-01-01 08:00", lapLai: "" }],
    }));
    await noiP2C("hẹn tin thử", threadId);
    const traLoi = await noiP2C(LENH_CHUAN, threadId);
    assert.match(traLoi, /thao tác khác chờ OK/i);
    await huyP2C(threadId);
  });

  await bai("P2C-C54", "Teach Bot pending chặn Zoom pending", async () => {
    const threadId = "conflict-teach";
    adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "day_ghi_nho", dichTen: "Nhóm P2C", quyTac: "Không được ghi" }));
    // Nhóm bị từ chối nên tạo thêm một contact thật để có bản nháp Teach hợp lệ.
    const uidHocVien = "contact-p2c";
    await db.upsertThread(CHU_P2C, { id: uidHocVien, threadType: 0, title: "Học viên P2C", lastMessage: "seed", lastMessageAt: mocThreadP2C, updatedAt: mocThreadP2C });
    adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "day_ghi_nho", dichTen: "Học viên P2C", quyTac: "Gọi là bạn." }));
    const xem = await noiP2C("dạy thử", threadId);
    assert.match(xem, /OK/);
    const traLoi = await noiP2C(LENH_CHUAN, threadId);
    assert.match(traLoi, /thao tác khác chờ OK/i);
    await huyP2C(threadId);
  });

  await bai("P2C-C55", "Zoom pending chặn Zoom thứ hai", async () => {
    const threadId = "conflict-two-zoom";
    datTaoP2CGia();
    await noiP2C(LENH_CHUAN, threadId);
    const traLoi = await noiP2C("Tạo Zoom Demo khác lúc 9 giờ sáng mai trong 1 giờ", threadId);
    assert.match(traLoi, /thao tác khác chờ OK/i);
  });

  await bai("P2C-C56", "Zoom thứ hai không ghi đè đề xuất đầu", async () => {
    const xong = await noiP2C("OK", "conflict-two-zoom");
    assert.match(xong, /Meeting ID/);
    assert.equal(taoP2CGoi.length, 1);
    assert.equal(taoP2CGoi[0].topic, "Lớp Marketing");
  });

  await bai("P2C-C57", "conflict hướng dẫn OK hoặc hủy thao tác cũ", async () => {
    const threadId = "conflict-copy";
    await noiP2C(LENH_CHUAN, threadId);
    const traLoi = await noiP2C("Tạo Zoom Khác lúc 10h mai trong 1 giờ", threadId);
    assert.match(traLoi, /OK/);
    assert.match(traLoi, /huỷ|hủy/i);
    await huyP2C(threadId);
  });

  /* ================= P2C-S01–S04 + U01: CHAT SECURITY / UNCERTAIN ================= */

  const chatRoRi = async (threadId) => {
    return (await xemRoiOK("OK", threadId, async () => ({
      ...KET_QUA_CHAT_GIA,
      start_url: START_URL_GIA,
      clientSecret: BI_MAT.clientSecret,
      access_token: TOKEN_GIA,
      encrypted_password: "ENC_PASSWORD_TEST_X",
      settings: { host_key: "HOST_KEY_TEST_X" },
    }))).xong;
  };
  let chatAnToan = "";
  await bai("P2C-S01", "start_url không lọt vào chat", async () => {
    chatAnToan = await chatRoRi("safe-chat");
    assert.ok(!chatAnToan.includes(START_URL_GIA));
  });
  await bai("P2C-S02", "Client Secret không lọt vào chat", async () => {
    assert.ok(!chatAnToan.includes(BI_MAT.clientSecret));
  });
  await bai("P2C-S03", "access token không lọt vào chat", async () => {
    assert.ok(!chatAnToan.includes(TOKEN_GIA));
  });
  await bai("P2C-S04", "encrypted_password không lọt vào chat", async () => {
    assert.ok(!chatAnToan.includes("ENC_PASSWORD_TEST_X"));
  });

  await bai("P2C-U01", "create không rõ kết quả chỉ thử một lần và tiêu thụ pending", async () => {
    const threadId = "uncertain-create";
    datTaoP2CGia(async () => { throw Object.assign(new Error("timeout sau dispatch"), { ma: "ZOOM_CREATE_UNCERTAIN" }); });
    await noiP2C(LENH_CHUAN, threadId);
    const lanMot = await noiP2C("OK", threadId);
    assert.match(lanMot, /không tự thử lại/i);
    assert.equal(taoP2CGoi.length, 1);
    const lanHai = await noiP2C("OK", threadId);
    assert.match(lanHai, /không có thao tác nào đang chờ OK/i);
    assert.equal(taoP2CGoi.length, 1, "OK lặp đã gọi create lần hai");
  });

  /* ================= R01–R15: ZOOM SUCCESS CHAT COPY REPAIR ================= */

  let chatRepair = "";
  await bai("R01", "success heading đúng tuyệt đối", async () => {
    ({ xong: chatRepair } = await xemRoiOK("OK", "copy-repair-main"));
    assert.equal(chatRepair.split("\n")[0], "Đã tạo cuộc họp Zoom:");
  });

  await bai("R02", "có đúng một dòng trống ngay sau heading", async () => {
    const dong = chatRepair.split("\n");
    assert.equal(dong[1], "");
    assert.equal(dong[2], `- Meeting ID: ${KET_QUA_CHAT_GIA.meetingId}`);
  });

  await bai("R03", "Meeting ID nằm trên bullet line riêng", async () => {
    assert.equal(chatRepair.split("\n")[2], `- Meeting ID: ${KET_QUA_CHAT_GIA.meetingId}`);
  });

  await bai("R04", "Pass nằm trên bullet line riêng", async () => {
    assert.equal(chatRepair.split("\n")[3], `- Pass: ${KET_QUA_CHAT_GIA.participantPasscode}`);
  });

  await bai("R05", "Link tham gia nằm trên bullet line riêng", async () => {
    assert.equal(chatRepair.split("\n")[4], `- Link tham gia: ${KET_QUA_CHAT_GIA.joinUrl}`);
    assert.equal(chatRepair.split("\n").length, 5, "success response có dòng thừa hoặc bị dồn dòng");
  });

  await bai("R06", "participantPasscode được render đúng", async () => {
    assert.match(chatRepair, /^- Pass: PASS-P2C$/m);
  });

  let chatKhongPass = "";
  await bai("R07", "passcode rỗng hiển thị Không có", async () => {
    ({ xong: chatKhongPass } = await xemRoiOK("OK", "copy-repair-empty-pass", async () => ({
      ...KET_QUA_CHAT_GIA,
      participantPasscode: "",
    })));
    assert.match(chatKhongPass, /^- Pass: Không có$/m);
    assert.ok(!/undefined|null|^- Pass: -$/m.test(chatKhongPass));
  });

  await bai("R08", "raw joinUrl vẫn hiện nguyên văn", async () => {
    assert.match(chatRepair, new RegExp(`^- Link tham gia: ${KET_QUA_CHAT_GIA.joinUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  });

  await bai("R09", "không chủ động tạo Markdown link", async () => {
    assert.ok(!chatRepair.includes(`[${KET_QUA_CHAT_GIA.joinUrl}](`));
    assert.ok(!/\[[^\]]+\]\(https?:\/\//.test(chatRepair));
  });

  await bai("R10", "start_url tiếp tục vắng mặt", async () => {
    assert.ok(!chatAnToan.includes(START_URL_GIA) && !/start_?url/i.test(chatAnToan));
  });

  await bai("R11", "access token tiếp tục vắng mặt", async () => {
    assert.ok(!chatAnToan.includes(TOKEN_GIA) && !/access[_ ]?token/i.test(chatAnToan));
  });

  await bai("R12", "Client Secret tiếp tục vắng mặt", async () => {
    assert.ok(!chatAnToan.includes(BI_MAT.clientSecret) && !/client[_ ]?secret/i.test(chatAnToan));
  });

  await bai("R13", "encrypted_password tiếp tục vắng mặt", async () => {
    assert.ok(!chatAnToan.includes("ENC_PASSWORD_TEST_X") && !/encrypted_password/i.test(chatAnToan));
  });

  await bai("R14", "OK flow vẫn tạo tối đa một meeting", async () => {
    const threadId = "copy-repair-one-create";
    datTaoP2CGia();
    await noiP2C(LENH_CHUAN, threadId);
    await noiP2C("OK", threadId);
    await noiP2C("OK", threadId);
    assert.equal(taoP2CGoi.length, 1);
  });

  await bai("R15", "initial Zoom command vẫn tạo zero meeting", async () => {
    const threadId = "copy-repair-preview-only";
    datTaoP2CGia();
    const xem = await noiP2C(LENH_CHUAN, threadId);
    assert.match(xem, /Trả lời OK để tạo cuộc họp/);
    assert.equal(taoP2CGoi.length, 0);
    await huyP2C(threadId);
  });

  /* ================= P2E E01–E37 + D01–D26 + X01–X16 ================= */

  const HOP_P2E = Object.freeze({
    meetingId: "700000001",
    topic: "Lớp Marketing",
    startTime: "2026-08-25T13:00:00Z",
    date: "2026-08-25",
    time: "20:00",
    duration: 120,
    timezone: "Asia/Ho_Chi_Minh",
    joinUrl: "https://zoom.us/j/700000001?pwd=KHONG_DUOC_LO",
    type: 2,
  });
  const HOP_P2E_2 = Object.freeze({ ...HOP_P2E, meetingId: "700000002", time: "18:00" });
  const HOP_P2E_TRUNG = Object.freeze({ ...HOP_P2E, meetingId: "700000004" });
  const HOP_P2E_LAP = Object.freeze({ ...HOP_P2E, meetingId: "700000003", type: 8 });
  const LENH_SUA_P2E = "Sửa lịch Zoom lớp Marketing ngày mai lúc 20h sang 20h30";
  const LENH_XOA_P2E = "Xóa lịch Zoom lớp Marketing ngày mai lúc 20h";
  let listP2EGoi = 0;
  let updateP2EGoi = [];
  let deleteP2EGoi = [];

  function datQuanLyP2EGia({ meetings = [HOP_P2E], listError = null, updateError = null, deleteError = null } = {}) {
    listP2EGoi = 0;
    updateP2EGoi = [];
    deleteP2EGoi = [];
    adminCmd.capHinhQuanLyZoom({
      list: async () => {
        listP2EGoi++;
        if (listError) throw listError;
        return structuredClone(meetings);
      },
      update: async (meetingId, payload) => {
        updateP2EGoi.push({ meetingId: String(meetingId), payload: structuredClone(payload) });
        if (updateError) throw updateError;
        return { ok: true };
      },
      remove: async (meetingId) => {
        deleteP2EGoi.push(String(meetingId));
        if (deleteError) throw deleteError;
        return { ok: true };
      },
    });
    adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "khong_hieu", lyDo: "P2E fixture" }));
  }

  async function xemSuaP2E(threadId, options = {}, lenh = LENH_SUA_P2E) {
    datQuanLyP2EGia(options);
    return noiP2C(lenh, threadId);
  }

  async function xemXoaP2E(threadId, options = {}, lenh = LENH_XOA_P2E) {
    datQuanLyP2EGia(options);
    return noiP2C(lenh, threadId);
  }

  await bai("P2E-E01", "unique exact topic+date resolves", async () => {
    const kq = adminCmd.giaiQuyetMeetingZoom([HOP_P2E], { topic: "Lớp Marketing", date: "2026-08-25" });
    assert.equal(kq.trangThai, "resolved");
    assert.equal(kq.meeting.meetingId, "700000001");
  });

  await bai("P2E-E02", "topic match is case-insensitive", async () => {
    assert.equal(adminCmd.giaiQuyetMeetingZoom([HOP_P2E], { topic: "lỚP mARKETING", date: "2026-08-25" }).trangThai, "resolved");
  });

  await bai("P2E-E03", "topic whitespace normalization works", async () => {
    assert.equal(adminCmd.giaiQuyetMeetingZoom([HOP_P2E], { topic: "  Lớp   Marketing ", date: "2026-08-25" }).trangThai, "resolved");
  });

  await bai("P2E-E04", "partial title does not fuzzy-match", async () => {
    assert.equal(adminCmd.giaiQuyetMeetingZoom([HOP_P2E], { topic: "Marketing", date: "2026-08-25" }).trangThai, "not_found");
  });

  await bai("P2E-E05", "zero results creates no pending and no PATCH", async () => {
    const threadId = "p2e-e05";
    const traLoi = await xemSuaP2E(threadId, { meetings: [] });
    assert.match(traLoi, /không tìm thấy lịch Zoom phù hợp/i);
    assert.equal(updateP2EGoi.length, 0);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi.length, 0);
  });

  await bai("P2E-E06", "duplicate same topic/date is ambiguous", async () => {
    const threadId = "p2e-e06";
    const traLoi = await xemSuaP2E(threadId, { meetings: [HOP_P2E, HOP_P2E_TRUNG] });
    assert.match(traLoi, /nhiều lịch Zoom/i);
    assert.equal(updateP2EGoi.length, 0);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi.length, 0);
    const kq = adminCmd.giaiQuyetMeetingZoom([HOP_P2E, HOP_P2E_TRUNG], { topic: "Lớp Marketing", date: "2026-08-25", time: "20:00" });
    assert.equal(kq.trangThai, "ambiguous");
  });

  await bai("P2E-E07", "time disambiguates duplicate meetings", async () => {
    const kq = adminCmd.giaiQuyetMeetingZoom([HOP_P2E, HOP_P2E_2], { topic: "Lớp Marketing", date: "2026-08-25", time: "18:00" });
    assert.equal(kq.trangThai, "resolved");
    assert.equal(kq.meeting.meetingId, "700000002");
  });

  await bai("P2E-E08", "recurring meeting cannot create update pending", async () => {
    const threadId = "p2e-e08";
    const traLoi = await xemSuaP2E(threadId, { meetings: [HOP_P2E_LAP] });
    assert.match(traLoi, /lịch lặp/i);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi.length, 0);
  });

  await bai("P2E-E09", "resolver keeps meetingId as String", async () => {
    const kq = adminCmd.giaiQuyetMeetingZoom([{ ...HOP_P2E, meetingId: 700000001 }], { topic: HOP_P2E.topic, date: HOP_P2E.date });
    assert.equal(typeof kq.meeting.meetingId, "string");
  });

  await bai("P2E-E10", "resolver path uses injected provider list", async () => {
    const threadId = "p2e-e10";
    await xemSuaP2E(threadId);
    assert.equal(listP2EGoi, 1);
    assert.equal(updateP2EGoi.length, 0);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-E11", "edit canonical command is parsed", async () => {
    assert.equal(adminCmd.phanTichLenhSuaLichZoom(LENH_SUA_P2E).ok, true);
  });

  await bai("P2E-E12", "same-day update preserves current date", async () => {
    const kq = adminCmd.phanTichLenhSuaLichZoom(LENH_SUA_P2E);
    assert.equal(kq.currentDate, "2026-08-25");
    assert.equal(kq.newDate, "2026-08-25");
    assert.equal(kq.newTime, "20:30");
  });

  await bai("P2E-E13", "new-date and new-time are parsed", async () => {
    const kq = adminCmd.phanTichLenhSuaLichZoom("Sửa lịch Zoom lớp Marketing ngày mai lúc 20h sang ngày 26/8 lúc 20h30");
    assert.equal(kq.newDate, "2026-08-26");
    assert.equal(kq.newTime, "20:30");
  });

  await bai("P2E-E14", "explicit dd/mm current date is parsed", async () => {
    const kq = adminCmd.phanTichLenhSuaLichZoom("Sửa lịch Zoom lớp Marketing ngày 25/8 lúc 20h sang 20h30");
    assert.equal(kq.currentDate, "2026-08-25");
  });

  await bai("P2E-E15", "explicit dd/mm/yyyy current date is parsed", async () => {
    const kq = adminCmd.phanTichLenhSuaLichZoom("Sửa lịch Zoom lớp Marketing ngày 25/08/2026 lúc 20h sang 20h30");
    assert.equal(kq.currentDate, "2026-08-25");
  });

  await bai("P2E-E16", "optional new duration is parsed", async () => {
    const kq = adminCmd.phanTichLenhSuaLichZoom(`${LENH_SUA_P2E} thời lượng 1 tiếng 30 phút`);
    assert.equal(kq.duration, 90);
  });

  await bai("P2E-E17", "missing new time is rejected", async () => {
    const lenh = "Sửa lịch Zoom lớp Marketing ngày mai lúc 20h sang";
    assert.equal(adminCmd.phanTichLenhSuaLichZoom(lenh).ok, false);
    datQuanLyP2EGia();
    await noiP2C(lenh, "p2e-e17");
    await noiP2C("OK", "p2e-e17");
    assert.equal(listP2EGoi, 0);
    assert.equal(updateP2EGoi.length, 0);
  });

  await bai("P2E-E18", "invalid new time is rejected", async () => {
    const lenh = "Sửa lịch Zoom lớp Marketing ngày mai lúc 20h sang 25h";
    assert.equal(adminCmd.phanTichLenhSuaLichZoom(lenh).ok, false);
    datQuanLyP2EGia();
    await noiP2C(lenh, "p2e-e18");
    await noiP2C("OK", "p2e-e18");
    assert.equal(listP2EGoi, 0);
    assert.equal(updateP2EGoi.length, 0);
  });

  await bai("P2E-E19", "invalid current/new date is rejected", async () => {
    const lenh = "Sửa lịch Zoom lớp Marketing ngày 31/2/2026 lúc 20h sang 20h30";
    assert.equal(adminCmd.phanTichLenhSuaLichZoom(lenh).ok, false);
    assert.equal(adminCmd.phanTichLenhSuaLichZoom("Sửa lịch Zoom lớp Marketing ngày mai lúc 20h sang ngày 31/2/2026 lúc 20h30").ok, false);
    datQuanLyP2EGia();
    await noiP2C(lenh, "p2e-e19");
    await noiP2C("OK", "p2e-e19");
    assert.equal(listP2EGoi, 0);
    assert.equal(updateP2EGoi.length, 0);
  });

  await bai("P2E-E20", "invalid duration is rejected", async () => {
    const lenh = `${LENH_SUA_P2E} thời lượng 0 phút`;
    assert.equal(adminCmd.phanTichLenhSuaLichZoom(lenh).ok, false);
    datQuanLyP2EGia();
    await noiP2C(lenh, "p2e-e20");
    await noiP2C("OK", "p2e-e20");
    assert.equal(listP2EGoi, 0);
    assert.equal(updateP2EGoi.length, 0);
  });

  let xemSuaChuan = "";
  await bai("P2E-E21", "edit first message returns preview", async () => {
    xemSuaChuan = await xemSuaP2E("p2e-e21");
    assert.match(xemSuaChuan, /^Em hiểu bạn muốn sửa lịch Zoom:/);
    assert.equal(updateP2EGoi.length, 0);
    await noiP2C("hủy", "p2e-e21");
  });

  await bai("P2E-E22", "edit preview shows provider topic", async () => {
    const xem = await xemSuaP2E("p2e-e22");
    assert.match(xem, /Tên: Lớp Marketing/);
    await noiP2C("hủy", "p2e-e22");
  });

  await bai("P2E-E23", "edit preview shows current schedule", async () => {
    const xem = await xemSuaP2E("p2e-e23");
    assert.match(xem, /Hiện tại: 20:00 ngày 25\/08\/2026/);
    await noiP2C("hủy", "p2e-e23");
  });

  await bai("P2E-E24", "edit preview shows proposed schedule", async () => {
    const xem = await xemSuaP2E("p2e-e24");
    assert.match(xem, /Chuyển sang: 20:30 ngày 25\/08\/2026/);
    await noiP2C("hủy", "p2e-e24");
  });

  await bai("P2E-E25", "edit preview requires exact OK copy", async () => {
    const xem = await xemSuaP2E("p2e-e25");
    assert.match(xem, /Trả lời OK để lưu thay đổi\./);
    await noiP2C("hủy", "p2e-e25");
  });

  await bai("P2E-E26", "initial edit command makes zero PATCH", async () => {
    await xemSuaP2E("p2e-e26");
    assert.equal(updateP2EGoi.length, 0);
    await noiP2C("hủy", "p2e-e26");
  });

  await bai("P2E-E27", "OK causes exactly one update call", async () => {
    const threadId = "p2e-e27";
    await xemSuaP2E(threadId);
    await noiP2C("OK", threadId);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi.length, 1);
  });

  for (const [ma, token] of [["P2E-E28", "Ok"], ["P2E-E29", "ok"]]) {
    await bai(ma, `${token} confirms edit`, async () => {
      const threadId = ma.toLowerCase();
      await xemSuaP2E(threadId);
      await noiP2C(token, threadId);
      assert.equal(updateP2EGoi.length, 1);
    });
  }

  await bai("P2E-E30", "old xác nhận token does not update", async () => {
    const threadId = "p2e-e30";
    await xemSuaP2E(threadId);
    const traLoi = await noiP2C("xác nhận", threadId);
    assert.match(traLoi, /trả lời OK/i);
    assert.equal(updateP2EGoi.length, 0);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-E31", "OK. does not update", async () => {
    const threadId = "p2e-e31";
    await xemSuaP2E(threadId);
    await noiP2C("OK.", threadId);
    assert.equal(updateP2EGoi.length, 0);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-E32", "edit success uses canonical heading", async () => {
    const threadId = "p2e-e32";
    await xemSuaP2E(threadId);
    const xong = await noiP2C("OK", threadId);
    assert.match(xong, /^Đã sửa lịch Zoom:/);
  });

  await bai("P2E-E33", "Hủy clears edit pending", async () => {
    const threadId = "p2e-e33";
    await xemSuaP2E(threadId);
    const huy = await noiP2C("Hủy", threadId);
    assert.equal(huy, "Đã hủy thao tác sửa lịch Zoom.");
    const sau = await noiP2C("OK", threadId);
    assert.match(sau, /không có thao tác nào đang chờ OK/i);
  });

  await bai("P2E-E34", "Hủy causes zero PATCH", async () => {
    const threadId = "p2e-e34";
    await xemSuaP2E(threadId);
    await noiP2C("Hủy", threadId);
    assert.equal(updateP2EGoi.length, 0);
  });

  await bai("P2E-E35", "unrelated reply invalidates edit pending", async () => {
    const threadId = "p2e-e35";
    await xemSuaP2E(threadId);
    const traLoi = await noiP2C("cho em xem lịch khác", threadId);
    assert.match(traLoi, /xem trước.*Zoom.*huỷ/is);
    assert.equal(updateP2EGoi.length, 0);
  });

  await bai("P2E-E36", "late OK after edit invalidation makes zero PATCH", async () => {
    const threadId = "p2e-e36";
    await xemSuaP2E(threadId);
    await noiP2C("câu không liên quan", threadId);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi.length, 0);
  });

  await bai("P2E-E37", "second manage command cannot overwrite edit pending", async () => {
    const threadId = "p2e-e37";
    await xemSuaP2E(threadId);
    const xungDot = await noiP2C(LENH_XOA_P2E, threadId);
    assert.match(xungDot, /thao tác khác chờ OK/i);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi.length, 1);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-D01", "delete canonical command is recognized", async () => {
    assert.equal(adminCmd.phanTichLenhXoaLichZoom("Xóa lịch Zoom lớp Marketing ngày mai").ok, true);
  });

  await bai("P2E-D02", "delete optional time is parsed", async () => {
    assert.equal(adminCmd.phanTichLenhXoaLichZoom(LENH_XOA_P2E).time, "20:00");
  });

  await bai("P2E-D03", "unique delete match creates preview", async () => {
    const threadId = "p2e-d03";
    const xem = await xemXoaP2E(threadId);
    assert.match(xem, /^Em hiểu bạn muốn xóa lịch Zoom:/);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-D04", "ambiguous delete creates no pending", async () => {
    const threadId = "p2e-d04";
    const xem = await xemXoaP2E(threadId, { meetings: [HOP_P2E, HOP_P2E_2] }, "Xóa lịch Zoom lớp Marketing ngày mai");
    assert.match(xem, /nhiều lịch Zoom/);
    assert.match(xem, /18:00/);
    assert.match(xem, /20:00/);
    await noiP2C("OK", threadId);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-D05", "no-match delete creates no pending", async () => {
    const threadId = "p2e-d05";
    const xem = await xemXoaP2E(threadId, { meetings: [] });
    assert.match(xem, /không tìm thấy/);
    await noiP2C("OK", threadId);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-D06", "recurring delete is rejected", async () => {
    const threadId = "p2e-d06";
    const xem = await xemXoaP2E(threadId, { meetings: [HOP_P2E_LAP] });
    assert.match(xem, /lịch lặp/);
    await noiP2C("OK", threadId);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-D07", "Hủy Zoom is never delete", async () => {
    const threadId = "p2e-d07";
    datQuanLyP2EGia();
    const traLoi = await noiP2C("Hủy Zoom lớp Marketing ngày mai", threadId);
    assert.match(traLoi, /Xóa lịch Zoom/);
    assert.equal(listP2EGoi, 0);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-D08", "Hủy lịch Zoom is never delete", async () => {
    const threadId = "p2e-d08";
    datQuanLyP2EGia();
    const traLoi = await noiP2C("Hủy lịch Zoom lớp Marketing ngày mai", threadId);
    assert.match(traLoi, /Xóa lịch Zoom/);
    await noiP2C("OK", threadId);
    assert.equal(deleteP2EGoi.length, 0);
  });

  let xemXoaChuan = "";
  await bai("P2E-D09", "delete preview heading uses xóa lịch Zoom", async () => {
    xemXoaChuan = await xemXoaP2E("p2e-d09");
    assert.match(xemXoaChuan, /muốn xóa lịch Zoom/);
    await noiP2C("hủy", "p2e-d09");
  });

  await bai("P2E-D10", "delete preview contains topic", async () => {
    const xem = await xemXoaP2E("p2e-d10");
    assert.match(xem, /Tên: Lớp Marketing/);
    await noiP2C("hủy", "p2e-d10");
  });

  await bai("P2E-D11", "delete preview contains current date/time", async () => {
    const xem = await xemXoaP2E("p2e-d11");
    assert.match(xem, /Thời gian: 20:00 ngày 25\/08\/2026/);
    await noiP2C("hủy", "p2e-d11");
  });

  await bai("P2E-D12", "delete preview requires exact OK copy", async () => {
    const xem = await xemXoaP2E("p2e-d12");
    assert.match(xem, /Trả lời OK để xóa lịch\./);
    await noiP2C("hủy", "p2e-d12");
  });

  await bai("P2E-D13", "delete preview makes zero DELETE", async () => {
    await xemXoaP2E("p2e-d13");
    assert.equal(deleteP2EGoi.length, 0);
    await noiP2C("hủy", "p2e-d13");
  });

  await bai("P2E-D14", "OK causes exactly one delete call", async () => {
    const threadId = "p2e-d14";
    await xemXoaP2E(threadId);
    await noiP2C("OK", threadId);
    await noiP2C("OK", threadId);
    assert.deepEqual(deleteP2EGoi, ["700000001"]);
  });

  for (const [ma, token] of [["P2E-D15", "Ok"], ["P2E-D16", "ok"]]) {
    await bai(ma, `${token} confirms delete`, async () => {
      const threadId = ma.toLowerCase();
      await xemXoaP2E(threadId);
      await noiP2C(token, threadId);
      assert.equal(deleteP2EGoi.length, 1);
    });
  }

  await bai("P2E-D17", "old xác nhận token does not delete", async () => {
    const threadId = "p2e-d17";
    await xemXoaP2E(threadId);
    await noiP2C("xác nhận", threadId);
    assert.equal(deleteP2EGoi.length, 0);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-D18", "OK. does not delete", async () => {
    const threadId = "p2e-d18";
    await xemXoaP2E(threadId);
    await noiP2C("OK.", threadId);
    assert.equal(deleteP2EGoi.length, 0);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-D19", "delete success uses canonical heading", async () => {
    const threadId = "p2e-d19";
    await xemXoaP2E(threadId);
    const xong = await noiP2C("OK", threadId);
    assert.match(xong, /^Đã xóa lịch Zoom:/);
  });

  await bai("P2E-D20", "delete success never says Đã hủy lịch Zoom", async () => {
    const threadId = "p2e-d20";
    await xemXoaP2E(threadId);
    const xong = await noiP2C("OK", threadId);
    assert.doesNotMatch(xong, /Đã hủy lịch Zoom/i);
  });

  await bai("P2E-D21", "Hủy clears delete pending", async () => {
    const threadId = "p2e-d21";
    await xemXoaP2E(threadId);
    await noiP2C("Hủy", threadId);
    await noiP2C("OK", threadId);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-D22", "Hủy causes zero DELETE", async () => {
    const threadId = "p2e-d22";
    await xemXoaP2E(threadId);
    await noiP2C("Hủy", threadId);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-D23", "delete cancel copy is unambiguous", async () => {
    const threadId = "p2e-d23";
    await xemXoaP2E(threadId);
    assert.equal(await noiP2C("Hủy", threadId), "Đã hủy thao tác xóa lịch Zoom.");
  });

  await bai("P2E-D24", "unrelated reply invalidates delete pending", async () => {
    const threadId = "p2e-d24";
    await xemXoaP2E(threadId);
    await noiP2C("câu không liên quan", threadId);
    await noiP2C("OK", threadId);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-D25", "late OK after delete invalidation makes zero DELETE", async () => {
    const threadId = "p2e-d25";
    await xemXoaP2E(threadId);
    await noiP2C("xem việc khác", threadId);
    const sau = await noiP2C("OK", threadId);
    assert.match(sau, /không có thao tác nào đang chờ OK/i);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-D26", "second manage command cannot overwrite delete pending", async () => {
    const threadId = "p2e-d26";
    await xemXoaP2E(threadId);
    const xungDot = await noiP2C(LENH_SUA_P2E, threadId);
    assert.match(xungDot, /thao tác khác chờ OK/i);
    await noiP2C("OK", threadId);
    assert.equal(deleteP2EGoi.length, 1);
    assert.equal(updateP2EGoi.length, 0);
  });

  await bai("P2E-X01", "ordinary customer cannot enter canonical admin path", async () => {
    const tin = tinP2C(LENH_XOA_P2E, KHACH_P2C, KHACH_P2C);
    assert.equal(await adminCmd.laLenhAdmin(tin), false);
  });

  await bai("P2E-X02", "group message cannot enter canonical admin path", async () => {
    assert.equal(await adminCmd.laLenhAdmin({ ...tinP2C(LENH_SUA_P2E), threadType: 1 }), false);
  });

  await bai("P2E-X03", "P2C create pending blocks P2E", async () => {
    const threadId = "p2e-x03";
    datTaoP2CGia();
    await noiP2C(LENH_CHUAN, threadId);
    datQuanLyP2EGia();
    const xungDot = await noiP2C(LENH_SUA_P2E, threadId);
    assert.match(xungDot, /thao tác khác chờ OK/i);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-X04", "P2E pending blocks P2C create", async () => {
    const threadId = "p2e-x04";
    await xemSuaP2E(threadId);
    const xungDot = await noiP2C(LENH_CHUAN, threadId);
    assert.match(xungDot, /thao tác khác chờ OK/i);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-X05", "gui_tin pending blocks P2E", async () => {
    const threadId = "p2e-x05";
    adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "gui_tin", dichIds: [NHOM_P2C], noiDung: "Tin giả" }));
    const xem = await noiP2C("gửi tin giả", threadId);
    assert.match(xem, /OK/);
    datQuanLyP2EGia();
    assert.match(await noiP2C(LENH_XOA_P2E, threadId), /thao tác khác chờ OK/i);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-X06", "dat_lich pending blocks P2E", async () => {
    const threadId = "p2e-x06";
    const lucTuongLai = new Date(MOC_P2C);
    lucTuongLai.setDate(lucTuongLai.getDate() + 2);
    lucTuongLai.setHours(20, 0, 0, 0);
    const haiChuSo = (so) => String(so).padStart(2, "0");
    const lucDatLichTuongLai = [
      `${lucTuongLai.getFullYear()}-${haiChuSo(lucTuongLai.getMonth() + 1)}-${haiChuSo(lucTuongLai.getDate())}`,
      `${haiChuSo(lucTuongLai.getHours())}:${haiChuSo(lucTuongLai.getMinutes())}`,
    ].join(" ");
    const dateNowThat = Date.now;
    Date.now = () => MOC_P2C;
    try {
      adminCmd.capHinhPhanTichLenh(async () => ({
        hanhDong: "dat_lich",
        lich: [{ dichId: NHOM_P2C, dichTen: "Nhóm P2C", noiDung: "Tin giả", luc: lucDatLichTuongLai, lapLai: "" }],
      }));
      const xem = await noiP2C("đặt lịch giả", threadId);
      assert.match(xem, /OK/);
      datQuanLyP2EGia();
      assert.match(await noiP2C(LENH_SUA_P2E, threadId), /thao tác khác chờ OK/i);
      await noiP2C("hủy", threadId);
    } finally {
      Date.now = dateNowThat;
    }
  });

  await bai("P2E-X07", "Teach Bot draft blocks P2E", async () => {
    const threadId = "p2e-x07";
    await db.upsertThread(CHU_P2C, {
      id: "contact-p2e",
      threadType: 0,
      title: "Khách P2E",
      lastMessage: "seed",
      lastMessageAt: mocThreadP2C,
      updatedAt: mocThreadP2C,
    });
    adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "day_sua", dichTen: "Khách P2E", quyTac: "Gọi là bạn." }));
    assert.match(await noiP2C("sửa chỉ dẫn", threadId), /OK/);
    datQuanLyP2EGia();
    assert.match(await noiP2C(LENH_XOA_P2E, threadId), /thao tác khác chờ OK/i);
    await noiP2C("hủy", threadId);
  });

  await bai("P2E-X08", "P2E pending blocks Teach Bot confirmable action", async () => {
    const threadId = "p2e-x08";
    await xemSuaP2E(threadId);
    adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "day_sua", dichTen: "Khách P2E", quyTac: "Không được ghi." }));
    assert.match(await noiP2C("sửa chỉ dẫn khác", threadId), /thao tác khác chờ OK/i);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi.length, 1);
  });

  await bai("P2E-X09", "P2C canonical create flow remains preview then one create", async () => {
    const threadId = "p2e-x09";
    datTaoP2CGia();
    const xem = await noiP2C(LENH_CHUAN, threadId);
    assert.match(xem, /Trả lời OK để tạo cuộc họp/);
    assert.equal(taoP2CGoi.length, 0);
    await noiP2C("OK", threadId);
    assert.equal(taoP2CGoi.length, 1);
  });

  await bai("P2E-X10", "edit payload preserves provider topic/timezone and duration", async () => {
    const threadId = "p2e-x10";
    await xemSuaP2E(threadId);
    await noiP2C("OK", threadId);
    assert.deepEqual(updateP2EGoi[0], {
      meetingId: "700000001",
      payload: {
        topic: "Lớp Marketing",
        date: "2026-08-25",
        time: "20:30",
        duration: 120,
        timezone: "Asia/Ho_Chi_Minh",
      },
    });
  });

  await bai("P2E-X11", "manage previews and pending never expose participant credentials", async () => {
    const threadEdit = "p2e-x11-edit";
    const threadDelete = "p2e-x11-delete";
    const xemEdit = await xemSuaP2E(threadEdit);
    assert.doesNotMatch(xemEdit, /KHONG_DUOC_LO|joinUrl|Pass:|participant/i);
    await noiP2C("hủy", threadEdit);
    const xemDelete = await xemXoaP2E(threadDelete);
    assert.doesNotMatch(xemDelete, /KHONG_DUOC_LO|joinUrl|Pass:|participant/i);
    await noiP2C("hủy", threadDelete);
  });

  await bai("P2E-X12", "provider list failure creates no pending or mutation", async () => {
    const threadId = "p2e-x12";
    const xem = await xemSuaP2E(threadId, { listError: new Error("provider fake") });
    assert.match(xem, /chưa tải được lịch Zoom/i);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi.length, 0);
    assert.equal(deleteP2EGoi.length, 0);
  });

  await bai("P2E-X13", "stale/update failure is not retried by a second OK", async () => {
    const threadId = "p2e-x13";
    const loi = Object.assign(new Error("stale fake"), { ma: "ZOOM_MEETING_DETAIL_FAILED" });
    await xemSuaP2E(threadId, { updateError: loi });
    const lanMot = await noiP2C("OK", threadId);
    const lanHai = await noiP2C("OK", threadId);
    assert.match(lanMot, /không còn sẵn sàng/i);
    assert.match(lanHai, /không có thao tác nào đang chờ OK/i);
    assert.equal(updateP2EGoi.length, 1);
  });

  await bai("P2E-X14", "stale/delete failure is not retried by a second OK", async () => {
    const threadId = "p2e-x14";
    const loi = Object.assign(new Error("stale fake"), { ma: "ZOOM_MEETING_DETAIL_FAILED" });
    await xemXoaP2E(threadId, { deleteError: loi });
    const lanMot = await noiP2C("OK", threadId);
    const lanHai = await noiP2C("OK", threadId);
    assert.match(lanMot, /không còn sẵn sàng/i);
    assert.match(lanHai, /không có thao tác nào đang chờ OK/i);
    assert.equal(deleteP2EGoi.length, 1);
  });

  await bai("P2E-X15", "new date/time/duration reach update seam exactly", async () => {
    const threadId = "p2e-x15";
    await xemSuaP2E(
      threadId,
      {},
      "Sửa lịch Zoom lớp Marketing ngày mai lúc 20h sang ngày 26/8 lúc 20h30 thời lượng 90 phút"
    );
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi[0].payload.date, "2026-08-26");
    assert.equal(updateP2EGoi[0].payload.time, "20:30");
    assert.equal(updateP2EGoi[0].payload.duration, 90);
  });

  await bai("P2E-X16", "invalid provider timezone uses approved Vietnam fallback", async () => {
    const threadId = "p2e-x16";
    await xemSuaP2E(threadId, { meetings: [{ ...HOP_P2E, timezone: "Provider/Invalid" }] });
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi[0].payload.timezone, "Asia/Ho_Chi_Minh");
  });

  /* ================= TZC01–TZC19: FRIENDLY BOT TIMEZONE COPY ================= */

  const NHAN_TZC = [
    ["TZC01", "Asia/Ho_Chi_Minh", "Việt Nam (GMT+7)"],
    ["TZC02", "Asia/Bangkok", "Bangkok (GMT+7)"],
    ["TZC03", "Asia/Singapore", "Singapore (GMT+8)"],
    ["TZC04", "Asia/Hong_Kong", "Hong Kong (GMT+8)"],
    ["TZC05", "Asia/Tokyo", "Tokyo (GMT+9)"],
    ["TZC06", "Australia/Sydney", "Sydney"],
    ["TZC07", "Asia/Dubai", "Dubai (GMT+4)"],
    ["TZC08", "Europe/London", "London"],
    ["TZC09", "Europe/Paris", "Paris"],
    ["TZC10", "America/New_York", "New York"],
    ["TZC11", "America/Los_Angeles", "Los Angeles"],
    ["TZC12", "UTC", "UTC"],
  ];
  for (const [ma, iana, label] of NHAN_TZC) {
    await bai(ma, `${iana} displays as ${label}`, async () => {
      assert.equal(adminCmd.nhanMuiGioZoom(iana), label);
    });
  }

  await bai("TZC13", "unknown timezone falls back to original IANA value", async () => {
    assert.equal(adminCmd.nhanMuiGioZoom("Pacific/Auckland"), "Pacific/Auckland");
  });

  await bai("TZC14", "Bangkok edit preview hides technical IANA value", async () => {
    const threadId = "tzc14";
    const xem = await xemSuaP2E(threadId, { meetings: [{ ...HOP_P2E, timezone: "Asia/Bangkok" }] });
    assert.ok(!xem.includes("Asia/Bangkok"), xem);
    await noiP2C("hủy", threadId);
  });

  await bai("TZC15", "Bangkok edit preview shows friendly GMT+7 label", async () => {
    const threadId = "tzc15";
    const xem = await xemSuaP2E(threadId, { meetings: [{ ...HOP_P2E, timezone: "Asia/Bangkok" }] });
    assert.match(xem, /^Múi giờ: Bangkok \(GMT\+7\)$/m);
    await noiP2C("hủy", threadId);
  });

  await bai("TZC16", "Vietnam edit preview keeps approved friendly label", async () => {
    const threadId = "tzc16";
    const xem = await xemSuaP2E(threadId);
    assert.match(xem, /^Múi giờ: Việt Nam \(GMT\+7\)$/m);
    await noiP2C("hủy", threadId);
  });

  await bai("TZC17", "display mapping does not mutate pending-shaped timezone data", async () => {
    const deXuat = { timezone: "Asia/Bangkok" };
    assert.equal(adminCmd.nhanMuiGioZoom(deXuat.timezone), "Bangkok (GMT+7)");
    assert.equal(deXuat.timezone, "Asia/Bangkok");
  });

  await bai("TZC18", "Bangkok preview OK still sends Asia/Bangkok to update seam", async () => {
    const threadId = "tzc18";
    const xem = await xemSuaP2E(threadId, { meetings: [{ ...HOP_P2E, timezone: "Asia/Bangkok" }] });
    assert.match(xem, /Bangkok \(GMT\+7\)/);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi[0].payload.timezone, "Asia/Bangkok");
  });

  await bai("TZC19", "Vietnam preview OK still sends Asia/Ho_Chi_Minh to update seam", async () => {
    const threadId = "tzc19";
    const xem = await xemSuaP2E(threadId);
    assert.match(xem, /Việt Nam \(GMT\+7\)/);
    await noiP2C("OK", threadId);
    assert.equal(updateP2EGoi[0].payload.timezone, "Asia/Ho_Chi_Minh");
  });

  adminCmd.capHinhQuanLyZoom();
  adminCmd.capHinhPhanTichLenh(async () => ({ hanhDong: "khong_hieu", lyDo: "P2C test" }));

  /* ================= ML01–ML15: MULTILINE THROUGH SENDLINK ================= */

  const FIXTURE_ML = [
    "Đã tạo cuộc họp Zoom:",
    "",
    "- Meeting ID: 123456789",
    "- Pass: ABC123",
    "- Link tham gia: https://example.com/zoom",
  ].join("\n");
  const LINK_ML = zaloService.timLinkChinh(FIXTURE_ML);

  await bai("ML01", "timLinkChinh giữ newline của tin nhiều dòng có URL", async () => {
    assert.ok(LINK_ML, "fixture không đi vào link-preview path");
    assert.ok(LINK_ML.loiNhan.includes("\n"), JSON.stringify(LINK_ML));
  });

  await bai("ML02", "dòng trống sau heading còn nguyên", async () => {
    assert.ok(LINK_ML.loiNhan.startsWith("Đã tạo cuộc họp Zoom:\n\n"), JSON.stringify(LINK_ML.loiNhan));
  });

  await bai("ML03", "Meeting ID bullet vẫn là một dòng riêng", async () => {
    assert.equal(LINK_ML.loiNhan.split("\n")[2], "- Meeting ID: 123456789");
  });

  await bai("ML04", "Pass bullet vẫn là một dòng riêng", async () => {
    assert.equal(LINK_ML.loiNhan.split("\n")[3], "- Pass: ABC123");
  });

  await bai("ML05", "Link bullet vẫn là một dòng riêng sau khi tách URL", async () => {
    assert.equal(LINK_ML.loiNhan.split("\n")[4], "- Link tham gia:");
    assert.equal(LINK_ML.loiNhan.split("\n").length, 5);
  });

  await bai("ML06", "space/tab ngang được gom nhưng newline không mất", async () => {
    const kq = zaloService.timLinkChinh("Dòng   1\t  A\r\nDòng   2 https://example.com/x");
    assert.deepEqual(kq, { duongDan: "https://example.com/x", loiNhan: "Dòng 1 A\nDòng 2" });
  });

  await bai("ML07", "tin link một dòng giữ nguyên ý nghĩa hiện tại", async () => {
    const kq = zaloService.timLinkChinh("Xem   tại https://example.com nhé");
    assert.deepEqual(kq, { duongDan: "https://example.com", loiNhan: "Xem tại nhé" });
  });

  const nguonZaloService = fs.readFileSync(path.join(REPO, "lib", "zalo-service.js"), "utf8");
  const khoiSendLink = nguonZaloService.slice(
    nguonZaloService.indexOf("const link = coThemGi ? null : timLinkChinh(cleanText)"),
    nguonZaloService.indexOf("// Lay msgId THAT")
  );

  await bai("ML08", "sendLink path vẫn được chọn khi helper trả link", async () => {
    assert.ok(LINK_ML);
    assert.ok(khoiSendLink.includes("if (link)"));
    assert.ok(khoiSendLink.includes("await api.sendLink("));
  });

  await bai("ML09", "primary URL extraction không đổi", async () => {
    assert.equal(LINK_ML.duongDan, "https://example.com/zoom");
  });

  await bai("ML10", "link-preview contract vẫn truyền link và msg", async () => {
    assert.ok(khoiSendLink.includes("link: link.duongDan"));
    assert.ok(khoiSendLink.includes("msg: link.loiNhan"));
  });

  await bai("ML11", "multiline không URL vẫn bỏ qua helper và giữ plain-message path", async () => {
    const khongLink = "Dòng 1\n\nDòng 3";
    assert.equal(zaloService.timLinkChinh(khongLink), null);
    assert.ok(khoiSendLink.includes("api.sendMessage(cleanText"));
  });

  await bai("ML12", "repair không chuyển plain text thành HTML", async () => {
    const khoiHelper = nguonZaloService.slice(
      nguonZaloService.indexOf("export function timLinkChinh"),
      nguonZaloService.indexOf("/* --- TRICH DAN")
    );
    assert.ok(!/innerHTML|<br\s*\/?\s*>/i.test(khoiHelper));
  });

  await bai("ML13", "Zoom success formatter source giữ nguyên canonical copy", async () => {
    const admin = fs.readFileSync(path.join(REPO, "lib", "admin-command.js"), "utf8");
    const khoi = admin.slice(admin.indexOf("async function taoZoomTuLenh"), admin.indexOf("export async function laLenhAdmin"));
    for (const dong of [
      '"Đã tạo cuộc họp Zoom:"',
      '`- Meeting ID: ${ketQua?.meetingId || ""}`',
      '`- Pass: ${pass}`',
      '`- Link tham gia: ${ketQua?.joinUrl || ""}`',
    ]) assert.ok(khoi.includes(dong), dong);
  });

  await bai("ML14", "URL không bị nhân đôi giữa caption và primary link", async () => {
    assert.ok(!LINK_ML.loiNhan.includes(LINK_ML.duongDan));
    assert.equal((JSON.stringify(LINK_ML).match(/https:\/\/example\.com\/zoom/g) || []).length, 1);
  });

  await bai("ML15", "focused multiline checks không gọi provider thật", async () => {
    assert.ok(!khoiSendLink.includes("fetch("));
    assert.equal(daGoi.filter((call) => call.url.includes("example.com")).length, 0);
  });

  adminCmd.capHinhTaoZoom();
  adminCmd.capHinhDongHoZoom();
  adminCmd.capHinhPhanTichLenh();

  /* ================= P01–P09: PARTICIPANT PASSCODE / SAFE RESPONSE ================= */

  await bai("P01", "provider password được map thành participantPasscode", async () => {
    assert.equal(ketQuaTao.participantPasscode, "PASSWORD_TEST_X");
  });

  await bai("P02", "public response không có raw password key", async () => {
    assert.ok(!Object.prototype.hasOwnProperty.call(ketQuaTao, "password"));
  });

  await bai("P03", "public response có participantPasscode", async () => {
    assert.ok(Object.prototype.hasOwnProperty.call(ketQuaTao, "participantPasscode"));
  });

  await bai("P04", "encrypted_password không ra public response", async () => {
    assert.ok(!JSON.stringify(ketQuaTao).includes("ENC_PASSWORD_TEST_X"));
    assert.ok(!Object.prototype.hasOwnProperty.call(ketQuaTao, "encrypted_password"));
  });

  await bai("P05", "start_url không ra public response", async () => {
    assert.ok(!JSON.stringify(ketQuaTao).includes(START_URL_GIA));
    assert.ok(!Object.prototype.hasOwnProperty.call(ketQuaTao, "start_url"));
  });

  await bai("P06", "access token không ra public response", async () => {
    assert.ok(!JSON.stringify(ketQuaTao).includes(TOKEN_GIA));
  });

  await bai("P07", "raw provider response không được bung ra", async () => {
    for (const key of ["uuid", "settings", "type", "h323_password", "pstn_password"]) {
      assert.ok(!Object.prototype.hasOwnProperty.call(ketQuaTao, key), key);
    }
  });

  await bai("P08", "joinUrl vẫn được giữ", async () => {
    assert.equal(ketQuaTao.joinUrl, "https://zoom.us/j/987654321?pwd=thamgia");
  });

  await bai("P09", "meetingId vẫn được giữ", async () => {
    assert.equal(ketQuaTao.meetingId, "987654321");
  });

  /* ================= L01–L20: PROVIDER MEETING LIST ================= */

  const providerMeetingP2D = (overrides = {}) => ({
    id: 86201234567,
    uuid: "UUID-P2D-SECRET",
    host_id: "HOST-ID-P2D",
    topic: "Lớp Marketing",
    start_time: "2026-08-25T13:00:00Z",
    duration: 120,
    timezone: "Asia/Ho_Chi_Minh",
    join_url: "https://zoom.us/j/86201234567?pwd=join",
    type: 2,
    agenda: "RAW-AGENDA",
    ...overrides,
  });
  const providerDetailP2D = (overrides = {}) => ({
    id: 86201234567,
    host_email: BI_MAT.hostEmail,
    topic: "Lớp Marketing",
    type: 2,
    join_url: "https://zoom.us/j/86201234567?pwd=join",
    password: "PASS-P2D",
    start_url: "https://zoom.us/s/host-secret",
    dynamic_host_key: "DYNAMIC-HOST-SECRET",
    encrypted_password: "ENCRYPTED-PASS-SECRET",
    h323_password: "H323-SECRET",
    pstn_password: "PSTN-SECRET",
    ...overrides,
  });
  const trangListP2D = (meetings, nextPageToken = "") => ({
    status: 200,
    body: { meetings, next_page_token: nextPageToken },
  });
  async function chayListP2D(...pages) {
    await dat();
    await luuDu();
    datTraLoi([okToken, ...pages]);
    return zoom.listZoomMeetings();
  }

  await bai("L01", "missing config → zero network", async () => {
    await dat();
    await assert.rejects(() => zoom.listZoomMeetings(), (e) => e.ma === "ZOOM_CONFIG_INCOMPLETE");
    assert.equal(daGoi.length, 0);
  });

  await bai("L02", "list reuse existing token path", async () => {
    await chayListP2D(trangListP2D([]));
    const tokenUrl = new URL(daGoi[0].url);
    assert.equal(tokenUrl.hostname, "zoom.us");
    assert.equal(tokenUrl.searchParams.get("grant_type"), "account_credentials");
    assert.equal(daGoi[0].options.method, "POST");
  });

  await bai("L03", "list host comes from backend config", async () => {
    await chayListP2D(trangListP2D([]));
    assert.ok(daGoi[1].url.includes(encodeURIComponent(BI_MAT.hostEmail)));
    assert.ok(!daGoi[1].url.includes("hacker"));
  });

  await bai("L04", "list encodes configured host in GET path", async () => {
    await chayListP2D(trangListP2D([]));
    assert.match(daGoi[1].url, /\/v2\/users\/chu\.phong%2Bhop%40congty\.com\/meetings/);
  });

  await bai("L05", "list uses GET", async () => {
    await chayListP2D(trangListP2D([]));
    assert.equal(daGoi[1].options.method, "GET");
    assert.equal(new URL(daGoi[1].url).searchParams.get("type"), "scheduled");
  });

  let dsListAnToan = null;
  await bai("L06", "list sanitizes meetingId to String", async () => {
    dsListAnToan = await chayListP2D(trangListP2D([providerMeetingP2D()]));
    assert.equal(dsListAnToan[0].meetingId, "86201234567");
    assert.equal(typeof dsListAnToan[0].meetingId, "string");
  });

  await bai("L07", "list retains topic", async () => {
    assert.equal(dsListAnToan[0].topic, "Lớp Marketing");
  });

  await bai("L08", "list retains duration", async () => {
    assert.equal(dsListAnToan[0].duration, 120);
  });

  await bai("L09", "list retains timezone and derives host date/time deterministically", async () => {
    assert.equal(dsListAnToan[0].timezone, "Asia/Ho_Chi_Minh");
    assert.equal(dsListAnToan[0].date, "2026-08-25");
    assert.equal(dsListAnToan[0].time, "20:00");
    assert.deepEqual(
      zoom.tachNgayGioZoom("2026-08-25T13:00:00Z", "Asia/Ho_Chi_Minh"),
      { date: "2026-08-25", time: "20:00" }
    );
  });

  await bai("L10", "list retains only safe joinUrl", async () => {
    assert.equal(dsListAnToan[0].joinUrl, "https://zoom.us/j/86201234567?pwd=join");
  });

  await bai("L11", "list removes raw host_id", async () => {
    assert.equal(dsListAnToan[0].host_id, undefined);
    assert.ok(!JSON.stringify(dsListAnToan).includes("HOST-ID-P2D"));
  });

  await bai("L12", "list removes uuid", async () => {
    assert.equal(dsListAnToan[0].uuid, undefined);
    assert.ok(!JSON.stringify(dsListAnToan).includes("UUID-P2D-SECRET"));
  });

  await bai("L13", "list locks exact public allowlist and removes raw provider", async () => {
    assert.deepEqual(Object.keys(dsListAnToan[0]).sort(), [
      "date", "duration", "joinUrl", "meetingId", "startTime", "time", "timezone", "topic", "type",
    ]);
    assert.ok(!JSON.stringify(dsListAnToan).includes("RAW-AGENDA"));
    assert.ok(!Object.prototype.hasOwnProperty.call(dsListAnToan[0], "password"));
  });

  await bai("L14", "next_page_token fetches next page", async () => {
    await chayListP2D(
      trangListP2D([providerMeetingP2D({ id: 1 })], "TOKEN-PAGE-2"),
      trangListP2D([providerMeetingP2D({ id: 2 })])
    );
    const listCalls = daGoi.filter((g) => g.url.includes("/meetings"));
    assert.equal(listCalls.length, 2);
    assert.equal(new URL(listCalls[1].url).searchParams.get("next_page_token"), "TOKEN-PAGE-2");
  });

  await bai("L15", "multiple list pages combine", async () => {
    const ds = await chayListP2D(
      trangListP2D([providerMeetingP2D({ id: 1, start_time: "2026-08-26T00:00:00Z" })], "NEXT"),
      trangListP2D([providerMeetingP2D({ id: 2, start_time: "2026-08-25T00:00:00Z" })])
    );
    assert.deepEqual(ds.map((x) => x.meetingId), ["2", "1"]);
  });

  await bai("L16", "pagination stops on empty token", async () => {
    await chayListP2D(trangListP2D([]));
    assert.equal(daGoi.filter((g) => g.url.includes("/meetings")).length, 1);
    assert.equal(traLoiTiepTheo.length, 0);
  });

  await bai("L17", "pagination safety cap fails and never silently truncates", async () => {
    await dat();
    await luuDu();
    datTraLoi([
      okToken,
      ...Array.from({ length: zoom.MAX_PAGES }, (_, i) =>
        trangListP2D([providerMeetingP2D({ id: i + 1 })], `NEXT-${i + 1}`)
      ),
    ]);
    await assert.rejects(() => zoom.listZoomMeetings(), (e) => e.ma === "ZOOM_MEETING_LIST_TOO_LARGE");
    assert.equal(daGoi.filter((g) => g.url.includes("/meetings")).length, 10);
  });

  await bai("L18", "scheduled type 2 is actionable", async () => {
    assert.equal(dsListAnToan[0].type, 2);
    assert.equal(zoomUi.loaiMeetingQuanLyDuoc(dsListAnToan[0].type), true);
  });

  await bai("L19", "recurring types remain visible but are not destructively actionable", async () => {
    const ds = await chayListP2D(trangListP2D([
      providerMeetingP2D({ id: 3, type: 3 }),
      providerMeetingP2D({ id: 8, type: 8 }),
    ]));
    assert.deepEqual(ds.map((x) => x.type), [3, 8]);
    assert.ok(ds.every((x) => !zoomUi.loaiMeetingQuanLyDuoc(x.type)));
  });

  await bai("L20", "list creates no DB meeting persistence", async () => {
    await chayListP2D(trangListP2D([providerMeetingP2D()]));
    const tables = await new Promise((resolve, reject) => {
      const conn = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READONLY);
      conn.all("SELECT name FROM sqlite_master WHERE type = 'table'", (error, rows) => {
        conn.close();
        error ? reject(error) : resolve((rows || []).map((row) => row.name));
      });
    });
    assert.ok(!tables.some((name) => /zoom|meeting/i.test(name)), tables.join(", "));
  });

  /* ================= G01–G12: DETAIL / COPY ================= */

  async function chayDetailP2D(detail = providerDetailP2D(), meetingId = "86201234567") {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: detail }]);
    return zoom.getZoomMeetingShare(meetingId);
  }

  await bai("G01", "detail uses GET /meetings/{id}", async () => {
    await chayDetailP2D();
    assert.match(daGoi[1].url, /\/v2\/meetings\/86201234567$/);
    assert.equal(daGoi[1].options.method, "GET");
  });

  await bai("G02", "meetingId is validated before detail network", async () => {
    await dat();
    await luuDu();
    for (const id of ["", "abc", "1/2", "../9"]) {
      await assert.rejects(() => zoom.getZoomMeetingShare(id), (e) => e.ma === "ZOOM_MEETING_ID_INVALID");
    }
    assert.equal(daGoi.length, 0);
  });

  await bai("G03", "detail ownership matches configured host case-insensitively", async () => {
    const share = await chayDetailP2D(providerDetailP2D({ host_email: BI_MAT.hostEmail.toUpperCase() }));
    assert.equal(share.meetingId, "86201234567");
  });

  await bai("G04", "detail host mismatch is rejected", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: providerDetailP2D({ host_email: "other@congty.com" }) }]);
    await assert.rejects(() => zoom.getZoomMeetingShare("86201234567"), (e) => e.ma === "ZOOM_MEETING_NOT_OWNED");
    assert.equal(daGoi.length, 2);
  });

  let shareAnToan = null;
  await bai("G05", "provider password maps to participantPasscode", async () => {
    shareAnToan = await chayDetailP2D();
    assert.equal(shareAnToan.participantPasscode, "PASS-P2D");
    assert.equal(shareAnToan.password, undefined);
  });

  await bai("G06", "detail join_url maps to joinUrl", async () => {
    assert.equal(shareAnToan.joinUrl, "https://zoom.us/j/86201234567?pwd=join");
  });

  await bai("G07", "detail removes start_url", async () => {
    assert.ok(!JSON.stringify(shareAnToan).includes("host-secret"));
    assert.equal(shareAnToan.start_url, undefined);
  });

  await bai("G08", "detail removes dynamic_host_key", async () => {
    assert.ok(!JSON.stringify(shareAnToan).includes("DYNAMIC-HOST-SECRET"));
  });

  await bai("G09", "detail removes encrypted and alternate passwords", async () => {
    const text = JSON.stringify(shareAnToan);
    for (const secret of ["ENCRYPTED-PASS-SECRET", "H323-SECRET", "PSTN-SECRET"]) {
      assert.ok(!text.includes(secret));
    }
  });

  await bai("G10", "detail locks exact public allowlist and no raw provider", async () => {
    assert.deepEqual(Object.keys(shareAnToan).sort(), ["joinUrl", "meetingId", "participantPasscode"]);
  });

  await bai("G11", "detail produces exact three-line clipboard contract", async () => {
    assert.equal(
      zoomUi.taoNoiDungSaoChep(shareAnToan),
      "Meeting ID: 86201234567\nPass: PASS-P2D\nLink tham gia: https://zoom.us/j/86201234567?pwd=join"
    );
  });

  await bai("G12", "empty detail passcode becomes Không có", async () => {
    const share = await chayDetailP2D(providerDetailP2D({ password: "" }));
    assert.match(zoomUi.taoNoiDungSaoChep(share), /^Meeting ID: .+\nPass: Không có\nLink tham gia:/);
  });

  /* ================= U01–U15: UPDATE ================= */

  const HOP_SUA = { ...HOP, topic: "Lớp Marketing sửa" };
  async function chayUpdateP2D({ detail = providerDetailP2D(), patch = { status: 204, body: null } } = {}) {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: detail }, patch]);
    return zoom.updateZoomMeeting("86201234567", HOP_SUA);
  }

  await bai("U01", "update reuses all five input validations", async () => {
    const invalid = [
      { topic: "" },
      { date: "2026-02-30" },
      { time: "25:00" },
      { duration: 0 },
      { timezone: "Khong/TonTai" },
    ];
    for (const patch of invalid) {
      await dat();
      await luuDu();
      await assert.rejects(
        () => zoom.updateZoomMeeting("86201234567", { ...HOP_SUA, ...patch }),
        (e) => e.ma === "ZOOM_MEETING_INPUT_INVALID"
      );
      assert.equal(daGoi.length, 0, JSON.stringify(patch));
    }
  });

  await bai("U02", "invalid update causes zero provider mutation", async () => {
    await dat();
    await luuDu();
    await assert.rejects(() => zoom.updateZoomMeeting("86201234567", { ...HOP_SUA, duration: 1441 }));
    assert.equal(daGoi.filter((g) => g.options.method === "PATCH").length, 0);
  });

  let patchBodyP2D = null;
  await bai("U03", "ownership detail GET occurs before PATCH", async () => {
    await chayUpdateP2D();
    assert.equal(daGoi[1].options.method, "GET");
    assert.equal(daGoi[2].options.method, "PATCH");
    patchBodyP2D = JSON.parse(daGoi[2].options.body);
  });

  await bai("U04", "host mismatch causes zero PATCH", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: providerDetailP2D({ host_email: "other@congty.com" }) }]);
    await assert.rejects(
      () => zoom.updateZoomMeeting("86201234567", HOP_SUA),
      (e) => e.ma === "ZOOM_MEETING_NOT_OWNED"
    );
    assert.equal(daGoi.filter((g) => g.options.method === "PATCH").length, 0);
  });

  await bai("U05", "update uses exact PATCH meeting path", async () => {
    await chayUpdateP2D();
    const call = daGoi.find((g) => g.options.method === "PATCH");
    assert.equal(call.url, "https://api.zoom.us/v2/meetings/86201234567");
  });

  await bai("U06", "PATCH body contains topic", async () => {
    assert.equal(patchBodyP2D.topic, "Lớp Marketing sửa");
  });

  await bai("U07", "PATCH body contains start_time", async () => {
    assert.equal(patchBodyP2D.start_time, "2026-08-25T20:00:00");
  });

  await bai("U08", "PATCH body contains duration", async () => {
    assert.equal(patchBodyP2D.duration, 120);
  });

  await bai("U09", "PATCH body contains timezone", async () => {
    assert.equal(patchBodyP2D.timezone, "Asia/Ho_Chi_Minh");
  });

  await bai("U10", "PATCH body excludes password and security fields", async () => {
    assert.deepEqual(Object.keys(patchBodyP2D).sort(), ["duration", "start_time", "timezone", "topic"]);
    for (const key of ["password", "waiting_room", "join_url", "hostEmail", "userId"]) {
      assert.equal(patchBodyP2D[key], undefined);
    }
  });

  await bai("U11", "one Save causes maximum one PATCH", async () => {
    await chayUpdateP2D();
    assert.equal(daGoi.filter((g) => g.options.method === "PATCH").length, 1);
  });

  await bai("U12", "update provider error is safe", async () => {
    await assert.rejects(
      () => chayUpdateP2D({ patch: { status: 500, body: { message: `raw ${BI_MAT.clientSecret}` } } }),
      (e) => {
        assert.equal(e.ma, "ZOOM_MEETING_UPDATE_FAILED");
        assert.ok(!e.message.includes(BI_MAT.clientSecret));
        return true;
      }
    );
  });

  await bai("U13", "update success reloads provider list", async () => {
    const fe = fs.readFileSync(path.join(REPO, "public", "zoom.js"), "utf8");
    const block = fe.slice(fe.indexOf("const veFormSua"), fe.indexOf("const veXacNhanXoa"));
    assert.ok(block.includes('method: "PATCH"'));
    assert.ok(block.includes("await taiLaiSauMutation()"));
  });

  await bai("U14", "update UI does not locally mutate meeting row", async () => {
    const fe = fs.readFileSync(path.join(REPO, "public", "zoom.js"), "utf8");
    const block = fe.slice(fe.indexOf("const veFormSua"), fe.indexOf("const veXacNhanXoa"));
    assert.ok(!/hop\.[A-Za-z]+\s*=/.test(block));
    assert.ok(!block.includes("meetingsHienTai.splice"));
  });

  await bai("U15", "uncertain update is never retried", async () => {
    await dat();
    await luuDu();
    datTraLoi([
      okToken,
      { status: 200, body: providerDetailP2D() },
      { nem: new Error("network interrupted") },
    ]);
    await assert.rejects(() => zoom.updateZoomMeeting("86201234567", HOP_SUA), (e) => e.ma === "ZOOM_UPDATE_UNCERTAIN");
    assert.equal(daGoi.filter((g) => g.options.method === "PATCH").length, 1);
  });

  /* ================= D01–D12: DELETE ================= */

  const zoomFrontendP2D = fs.readFileSync(path.join(REPO, "public", "zoom.js"), "utf8");
  const xoaFrontendP2D = zoomFrontendP2D.slice(
    zoomFrontendP2D.indexOf("const veXacNhanXoa"),
    zoomFrontendP2D.indexOf("const veDong")
  );

  await bai("D01", "opening row menu does not delete", async () => {
    const menu = zoomFrontendP2D.slice(zoomFrontendP2D.indexOf("const veDong"), zoomFrontendP2D.indexOf("function veDanhSach"));
    const mo = menu.slice(menu.indexOf('moMenu.addEventListener("click"'));
    assert.ok(!mo.slice(0, mo.indexOf("menu.append")).includes('method: "DELETE"'));
  });

  await bai("D02", "choosing Xóa lịch only opens inline confirmation", async () => {
    assert.ok(zoomFrontendP2D.includes('xoa.addEventListener("click", () => veXacNhanXoa(hop, khung))'));
    assert.ok(xoaFrontendP2D.includes("khung.appendChild(xacNhan)"));
  });

  await bai("D03", "inline Hủy causes zero DELETE", async () => {
    const huyBlock = xoaFrontendP2D.slice(xoaFrontendP2D.indexOf('huy.addEventListener("click"'), xoaFrontendP2D.indexOf('xoa.addEventListener("click"'));
    assert.ok(huyBlock.includes("xacNhan.remove()"));
    assert.ok(!huyBlock.includes("fetch("));
  });

  await bai("D04", "final Xóa lịch causes one backend DELETE path", async () => {
    assert.equal((xoaFrontendP2D.match(/method: "DELETE"/g) || []).length, 1);
    assert.ok(xoaFrontendP2D.includes("/api/zoom/cuoc-hop/${encodeURIComponent(hop.meetingId)}"));
  });

  let deleteCallsP2D = null;
  await bai("D05", "ownership detail check occurs before DELETE", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: providerDetailP2D() }, { status: 204, body: null }]);
    await zoom.deleteZoomMeeting("86201234567");
    deleteCallsP2D = daGoi.slice();
    assert.equal(deleteCallsP2D[1].options.method, "GET");
    assert.equal(deleteCallsP2D[2].options.method, "DELETE");
  });

  await bai("D06", "delete host mismatch causes zero DELETE", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: providerDetailP2D({ host_email: "other@congty.com" }) }]);
    await assert.rejects(
      () => zoom.deleteZoomMeeting("86201234567"),
      (e) => e.ma === "ZOOM_MEETING_NOT_OWNED"
    );
    assert.equal(daGoi.filter((g) => g.options.method === "DELETE").length, 0);
  });

  await bai("D07", "delete uses exact meeting path", async () => {
    const call = deleteCallsP2D.find((g) => g.options.method === "DELETE");
    assert.equal(call.url, "https://api.zoom.us/v2/meetings/86201234567");
  });

  await bai("D08", "provider 204 delete success is handled", async () => {
    await dat();
    await luuDu();
    datTraLoi([okToken, { status: 200, body: providerDetailP2D() }, { status: 204, body: null }]);
    assert.deepEqual(await zoom.deleteZoomMeeting("86201234567"), { ok: true });
  });

  await bai("D09", "delete provider error keeps row and shows safe error", async () => {
    const catchBlock = xoaFrontendP2D.slice(xoaFrontendP2D.indexOf("} catch (error)"));
    assert.ok(catchBlock.includes("baoLoi.textContent = error.message"));
    assert.ok(catchBlock.includes("xoa.disabled = false"));
    assert.ok(!catchBlock.includes("khung.remove()"));
  });

  await bai("D10", "delete success reloads provider list", async () => {
    assert.ok(xoaFrontendP2D.includes("await taiLaiSauMutation()"));
  });

  await bai("D11", "delete UI has no optimistic local deletion", async () => {
    assert.ok(!xoaFrontendP2D.includes("meetingsHienTai.splice"));
    assert.ok(!xoaFrontendP2D.includes("khung.remove()"));
  });

  await bai("D12", "uncertain delete is never retried", async () => {
    await dat();
    await luuDu();
    datTraLoi([
      okToken,
      { status: 200, body: providerDetailP2D() },
      { nem: new Error("network interrupted") },
    ]);
    await assert.rejects(() => zoom.deleteZoomMeeting("86201234567"), (e) => e.ma === "ZOOM_DELETE_UNCERTAIN");
    assert.equal(daGoi.filter((g) => g.options.method === "DELETE").length, 1);
  });

  /* ================= UI01–UI16: PROVIDER DASHBOARD ================= */

  const appFrontendP2D = fs.readFileSync(path.join(REPO, "public", "app.js"), "utf8");
  const cssFrontendP2D = fs.readFileSync(path.join(REPO, "public", "style.css"), "utf8");

  await bai("UI01", "selecting Zoom loads provider list", async () => {
    assert.ok(appFrontendP2D.includes('if (napNoiDung && activeTool === "zoom") void napZoom()'));
    assert.ok(zoomFrontendP2D.includes('fetch("/api/zoom/cuoc-hop")'));
  });

  await bai("UI02", "selecting Zoho does not load Zoom list", async () => {
    const select = appFrontendP2D.slice(appFrontendP2D.indexOf("function chonCongCu"), appFrontendP2D.indexOf("toolGrid?.addEventListener"));
    assert.ok(select.includes('activeTool === "zoom"'));
    assert.ok(!select.includes('activeTool === "zoho") void napZoom'));
  });

  await bai("UI03", "bot/provider fixture can render in dashboard", async () => {
    assert.equal(dsListAnToan[0].topic, "Lớp Marketing");
    assert.ok(zoomFrontendP2D.includes("veDanhSach(data.meetings || [])"));
    assert.ok(zoomFrontendP2D.includes("for (const hop of meetingsHienTai)"));
  });

  await bai("UI04", "page/provider reload replaces session-only assumption", async () => {
    assert.ok(!zoomFrontendP2D.includes("createdMeetings"));
    assert.ok(zoomFrontendP2D.includes("lamMoi = async ()"));
    assert.ok(zoomFrontendP2D.includes("await taiDanhSach()"));
  });

  await bai("UI05", "create success reloads list", async () => {
    const block = zoomFrontendP2D.slice(zoomFrontendP2D.indexOf('$("#zm-tao-hop").addEventListener'));
    assert.ok(block.includes("await taiLaiSauMutation()"));
  });

  await bai("UI06", "update success reloads list", async () => {
    const block = zoomFrontendP2D.slice(zoomFrontendP2D.indexOf("const veFormSua"), zoomFrontendP2D.indexOf("const veXacNhanXoa"));
    assert.ok(block.includes("await taiLaiSauMutation()"));
  });

  await bai("UI07", "delete success reloads list", async () => {
    assert.ok(xoaFrontendP2D.includes("await taiLaiSauMutation()"));
  });

  await bai("UI08", "dashboard has loading state", async () => {
    assert.ok(zoomFrontendP2D.includes("Đang tải lịch Zoom..."));
  });

  await bai("UI09", "dashboard has empty state", async () => {
    assert.ok(zoomFrontendP2D.includes("Chưa có cuộc họp Zoom sắp tới."));
  });

  await bai("UI10", "dashboard has isolated error and retry state", async () => {
    assert.ok(zoomFrontendP2D.includes("Không tải được lịch Zoom."));
    assert.ok(zoomFrontendP2D.includes('const nut = taoNut("Thử lại")'));
    assert.ok(zoomFrontendP2D.includes('const khung = $("#zm-lich-bao")'));
  });

  await bai("UI11", "only one row action menu can be open", async () => {
    assert.ok(zoomFrontendP2D.includes("let menuDangMo = null"));
    assert.ok(zoomFrontendP2D.includes("dongMenu()"));
    assert.ok(zoomFrontendP2D.includes('if (event.key === "Escape") dongMenu()'));
  });

  await bai("UI12", "edit is inline with five fields and save/cancel", async () => {
    const block = zoomFrontendP2D.slice(zoomFrontendP2D.indexOf("const veFormSua"), zoomFrontendP2D.indexOf("const veXacNhanXoa"));
    for (const label of ["Tên cuộc họp", "Ngày", "Giờ", "Thời lượng", "Múi giờ", "Lưu thay đổi", "Hủy"]) {
      assert.ok(block.includes(label), label);
    }
  });

  await bai("UI13", "delete uses inline second confirmation, never window.confirm", async () => {
    assert.ok(xoaFrontendP2D.includes("Xóa cuộc họp"));
    assert.ok(xoaFrontendP2D.includes('taoNut("Xóa lịch", "danger-button")'));
    assert.ok(!zoomFrontendP2D.includes("confirm("));
  });

  await bai("UI14", "mobile uses stacked provider cards", async () => {
    assert.ok(cssFrontendP2D.includes("@media (max-width: 640px)"));
    assert.ok(cssFrontendP2D.includes(".zoom-lich-dong,"));
    assert.ok(cssFrontendP2D.includes("grid-template-columns: minmax(0, 1fr)"));
  });

  await bai("UI15", "long provider values cannot break layout", async () => {
    const block = cssFrontendP2D.slice(cssFrontendP2D.indexOf(".zoom-lich-cot"), cssFrontendP2D.indexOf(".zoom-lich-ten"));
    assert.ok(block.includes("min-width: 0"));
    assert.ok(block.includes("overflow-wrap: anywhere"));
  });

  await bai("UI16", "provider strings render via textContent/createTextNode only", async () => {
    const row = zoomFrontendP2D.slice(zoomFrontendP2D.indexOf("const veDong"), zoomFrontendP2D.indexOf("function veDanhSach"));
    assert.ok(row.includes("textContent"));
    assert.ok(!row.includes("innerHTML"));
    assert.ok(zoomFrontendP2D.includes("o.textContent = String(value ?? \"\")"));
  });

  /* ================= Bao cao ================= */
  const rong = bienBan.filter((b) => b.ketQua === "FAIL");
  console.log("");
  for (const b of bienBan) {
    console.log(`${b.ma} = ${b.ketQua}  ${b.moTa}${b.loi ? `\n        ↳ ${b.loi}` : ""}`);
  }
  console.log("");
  console.log(`TONG: ${bienBan.length - rong.length}/${bienBan.length} PASS`);
  console.log(`So lan goi Zoom THAT: 0 (toan bo di qua ham mang gia)`);
  console.log(`Thu muc tam: ${TMP}`);
  process.exit(rong.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Khung kiem thu hong:", error);
  process.exit(2);
});
