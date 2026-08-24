// Zoom dashboard: provider la nguon danh sach duy nhat.
// Credential van chi o server; frontend khong luu meeting cuc bo.

let lamMoi = null;

export const MUI_GIO_MAC_DINH = "Asia/Ho_Chi_Minh";

export const CAC_MUI_GIO_ZOOM = Object.freeze([
  { value: "Asia/Ho_Chi_Minh", label: "Việt Nam (GMT+7)" },
  { value: "Asia/Bangkok", label: "Bangkok (GMT+7)" },
  { value: "Asia/Singapore", label: "Singapore (GMT+8)" },
  { value: "Asia/Hong_Kong", label: "Hong Kong (GMT+8)" },
  { value: "Asia/Tokyo", label: "Tokyo (GMT+9)" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "Asia/Dubai", label: "Dubai (GMT+4)" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "America/New_York", label: "New York" },
  { value: "America/Los_Angeles", label: "Los Angeles" },
  { value: "UTC", label: "UTC" },
]);

export function cauHinhZoomMoMacDinh(config = {}) {
  return !config.configured;
}

export function layMuiGioDaChon(control) {
  const value = String(control?.value || "").trim();
  return CAC_MUI_GIO_ZOOM.some((item) => item.value === value)
    ? value
    : MUI_GIO_MAC_DINH;
}

export function loaiMeetingQuanLyDuoc(type) {
  return Number(type) === 2;
}

/** Hop dong clipboard da duoc duyet; du lieu den tu Detail on-demand. */
export function taoNoiDungSaoChep(cuocHop = {}) {
  const pass = String(cuocHop.participantPasscode || "").trim() || "Không có";
  return [
    `Meeting ID: ${cuocHop.meetingId}`,
    `Pass: ${pass}`,
    `Link tham gia: ${cuocHop.joinUrl}`,
  ].join("\n");
}

function tuyChonMuiGioHtml() {
  return CAC_MUI_GIO_ZOOM.map(
    ({ value, label }) =>
      `<option value="${value}"${value === MUI_GIO_MAC_DINH ? " selected" : ""}>${label}</option>`
  ).join("");
}

function hienThiNgay(date) {
  const [nam, thang, ngay] = String(date || "").split("-");
  return nam && thang && ngay ? `${ngay}/${thang}/${nam}` : "—";
}

function taoNut(chu, className = "secondary-button") {
  const nut = document.createElement("button");
  nut.type = "button";
  nut.className = className;
  nut.textContent = chu;
  return nut;
}

function taoNhanTruong(chu, control) {
  const label = document.createElement("label");
  label.className = "zoom-truong";
  const span = document.createElement("span");
  span.textContent = chu;
  label.append(span, control);
  return label;
}

function taoSelectMuiGio(value) {
  const select = document.createElement("select");
  for (const item of CAC_MUI_GIO_ZOOM) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  select.value = CAC_MUI_GIO_ZOOM.some((item) => item.value === value)
    ? value
    : MUI_GIO_MAC_DINH;
  return select;
}

export async function napZoom() {
  const panel = document.querySelector("#zoom-panel");
  if (!panel) return;
  if (lamMoi) return lamMoi();

  panel.innerHTML = `
    <section class="zoom-ket-noi">
      <div class="zoom-ket-noi-actions" id="zm-ket-noi-actions" aria-label="Thao tác kết nối Zoom" hidden>
        <button id="zm-cau-hinh-toggle" class="secondary-button" type="button"
                aria-expanded="false" aria-controls="zm-cau-hinh-noi-dung">Cấu hình kết nối</button>
        <button id="zm-kiem-tra" class="secondary-button" type="button">Kiểm tra</button>
        <button id="zm-ngat" class="secondary-button" type="button">Ngắt kết nối</button>
      </div>
      <div id="zm-bao" class="field-hint" style="min-height:18px"></div>

      <div class="zoom-cau-hinh" id="zm-cau-hinh-noi-dung">
        <h4 class="zoom-muc-tieu-de">Cấu hình kết nối</h4>
        <div class="zoom-huong-dan">
          <p>Tạo một ứng dụng <strong>Server-to-Server OAuth</strong> trong Zoom App Marketplace, rồi thêm sáu quyền:</p>
          <div class="zoom-scope-list">
            <code>user:read:user:admin</code>
            <code>meeting:write:meeting:admin</code>
            <code>meeting:read:list_meetings:admin</code>
            <code>meeting:read:meeting:admin</code>
            <code>meeting:update:meeting:admin</code>
            <code>meeting:delete:meeting:admin</code>
          </div>
          <p>Sau đó nhập Account ID, Client ID, Client Secret và email tài khoản Zoom dùng để tạo phòng họp.</p>
        </div>

        <div class="zoom-hang">
          <label for="zm-account-id">Account ID</label>
          <input id="zm-account-id" autocomplete="off" />
        </div>
        <div class="zoom-hang">
          <label for="zm-client-id">Client ID</label>
          <input id="zm-client-id" autocomplete="off" />
        </div>
        <div class="zoom-hang">
          <label for="zm-client-secret">Client Secret</label>
          <input id="zm-client-secret" type="password" autocomplete="new-password" />
        </div>
        <div class="zoom-hang">
          <label for="zm-host-email">Email tài khoản Zoom</label>
          <input id="zm-host-email" autocomplete="off" placeholder="ten@congty.com" />
        </div>
        <div class="zoom-nut">
          <button id="zm-luu" class="primary-button" type="button">Lưu</button>
        </div>
      </div>
    </section>

    <section class="zoom-lich">
      <header class="zoom-lich-header">
        <h4 class="zoom-tao-tieu-de">Lịch Zoom</h4>
        <button id="zm-mo-tao" class="primary-button" type="button" aria-expanded="false"
                aria-controls="zm-tao-khung" disabled>Tạo cuộc họp</button>
      </header>

      <div id="zm-tao-khung" class="zoom-tao-hop" hidden>
        <h5>Tạo cuộc họp Zoom</h5>
        <div class="zoom-tao-luoi">
          <label class="zoom-truong zoom-truong-ten" for="zm-hop-ten">
            <span>Tên cuộc họp</span>
            <input id="zm-hop-ten" autocomplete="off" placeholder="Lớp Marketing buổi 3" />
          </label>
          <label class="zoom-truong" for="zm-hop-ngay">
            <span>Ngày</span>
            <input id="zm-hop-ngay" type="date" />
          </label>
          <label class="zoom-truong" for="zm-hop-gio">
            <span>Giờ</span>
            <input id="zm-hop-gio" type="time" />
          </label>
          <label class="zoom-truong" for="zm-hop-phut">
            <span>Thời lượng</span>
            <input id="zm-hop-phut" type="number" min="1" max="1440" value="60" />
          </label>
          <label class="zoom-truong" for="zm-hop-mui-gio">
            <span>Múi giờ</span>
            <select id="zm-hop-mui-gio">${tuyChonMuiGioHtml()}</select>
          </label>
        </div>
        <div class="zoom-form-actions">
          <button id="zm-tao-hop" class="primary-button zoom-tao-submit" type="button" disabled>Tạo cuộc họp</button>
          <button id="zm-huy-tao" class="secondary-button" type="button">Hủy</button>
        </div>
        <div id="zm-hop-bao" class="field-hint" style="min-height:18px"></div>
      </div>

      <div id="zm-lich-bao" class="zoom-lich-bao" aria-live="polite"></div>
      <div id="zm-hop-danh-sach" class="zoom-lich-danh-sach"></div>
    </section>
  `;

  const $ = (selector) => panel.querySelector(selector);
  const the = document.querySelector("#tool-zoom-status");
  const trangThaiChiTiet = document.querySelector("#zoom-detail-status");
  let configHienTai = null;
  let meetingsHienTai = [];
  let dangTaiDanhSach = null;
  let menuDangMo = null;

  const datMoCauHinh = (mo) => {
    const noiDung = $("#zm-cau-hinh-noi-dung");
    const nut = $("#zm-cau-hinh-toggle");
    noiDung.hidden = !mo;
    nut.setAttribute("aria-expanded", String(mo));
    nut.textContent = mo ? "Thu gọn cấu hình" : "Cấu hình kết nối";
  };

  const datMoTao = (mo) => {
    $("#zm-tao-khung").hidden = !mo;
    $("#zm-mo-tao").setAttribute("aria-expanded", String(mo));
  };

  const bao = (chu, mau) => {
    const o = $("#zm-bao");
    o.textContent = chu || "";
    o.style.color = mau || "var(--muted)";
  };

  const baoHop = (chu, mau) => {
    const o = $("#zm-hop-bao");
    o.textContent = chu || "";
    o.style.color = mau || "var(--muted)";
  };

  const datTrangThai = (chu, mau) => {
    for (const o of [the, trangThaiChiTiet]) {
      if (!o) continue;
      o.textContent = chu;
      o.style.color = mau || "";
    }
  };

  const dongMenu = () => {
    if (!menuDangMo) return;
    menuDangMo.hidden = true;
    menuDangMo.previousElementSibling?.setAttribute("aria-expanded", "false");
    menuDangMo = null;
  };

  const veCauHinh = (config) => {
    configHienTai = config || {};
    const daCo = (co) => (co ? "(đã lưu — để trống nếu không đổi)" : "");
    $("#zm-account-id").value = "";
    $("#zm-client-id").value = "";
    $("#zm-client-secret").value = "";
    $("#zm-account-id").placeholder = daCo(config?.hasAccountId) || "Account ID";
    $("#zm-client-id").placeholder = daCo(config?.hasClientId) || "Client ID";
    $("#zm-client-secret").placeholder = daCo(config?.hasClientSecret) || "Client Secret";
    $("#zm-host-email").value = config?.hostEmail || "";

    datTrangThai(
      config?.configured ? `Đã kết nối · ${config.hostEmail}` : "Chưa kết nối",
      "var(--muted)"
    );
    $("#zm-ket-noi-actions").hidden = !config?.configured;
    datMoCauHinh(cauHinhZoomMoMacDinh(config));
    $("#zm-tao-hop").disabled = !config?.configured;
    $("#zm-mo-tao").disabled = !config?.configured;
    if (!config?.configured) datMoTao(false);
  };

  const veThongBaoLich = (chu, { loi = false, thuLai = false } = {}) => {
    const khung = $("#zm-lich-bao");
    khung.textContent = "";
    const p = document.createElement("p");
    p.textContent = chu;
    p.className = loi ? "zoom-lich-loi" : "field-hint";
    khung.appendChild(p);
    if (thuLai) {
      const nut = taoNut("Thử lại");
      nut.addEventListener("click", () => taiDanhSach());
      khung.appendChild(nut);
    }
  };

  const themCot = (khung, className, label, value) => {
    const o = document.createElement("div");
    o.className = `zoom-lich-cot ${className}`;
    o.dataset.label = label;
    o.textContent = String(value ?? "");
    khung.appendChild(o);
    return o;
  };

  const taiLaiSauMutation = async () => {
    if (dangTaiDanhSach) {
      try { await dangTaiDanhSach; } catch { /* request cu da ve trang thai loi */ }
    }
    return taiDanhSach();
  };

  const saoChepMeeting = async (hop, nut, phanHoi) => {
    if (nut.disabled) return;
    nut.disabled = true;
    phanHoi.textContent = "Đang lấy thông tin…";
    try {
      const res = await fetch(`/api/zoom/cuoc-hop/${encodeURIComponent(hop.meetingId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không lấy được thông tin tham gia.");
      await navigator.clipboard.writeText(taoNoiDungSaoChep(data));
      phanHoi.textContent = "Đã sao chép";
      phanHoi.style.color = "var(--ok)";
    } catch (error) {
      phanHoi.textContent = error.message || "Không thể sao chép tự động.";
      phanHoi.style.color = "var(--warn)";
    } finally {
      nut.disabled = false;
    }
  };

  const veFormSua = (hop, khung) => {
    dongMenu();
    khung.textContent = "";
    khung.classList.add("zoom-lich-dong-dang-sua");
    const form = document.createElement("div");
    form.className = "zoom-sua-form";

    const ten = document.createElement("input");
    ten.value = hop.topic || "";
    ten.autocomplete = "off";
    const ngay = document.createElement("input");
    ngay.type = "date";
    ngay.value = hop.date || "";
    const gio = document.createElement("input");
    gio.type = "time";
    gio.value = hop.time || "";
    const phut = document.createElement("input");
    phut.type = "number";
    phut.min = "1";
    phut.max = "1440";
    phut.value = String(hop.duration || 60);
    const muiGio = taoSelectMuiGio(hop.timezone);

    const truongTen = taoNhanTruong("Tên cuộc họp", ten);
    truongTen.classList.add("zoom-truong-ten");
    form.append(
      truongTen,
      taoNhanTruong("Ngày", ngay),
      taoNhanTruong("Giờ", gio),
      taoNhanTruong("Thời lượng", phut),
      taoNhanTruong("Múi giờ", muiGio)
    );

    const hanhDong = document.createElement("div");
    hanhDong.className = "zoom-form-actions";
    const luu = taoNut("Lưu thay đổi", "primary-button");
    const huy = taoNut("Hủy");
    const baoLoi = document.createElement("span");
    baoLoi.className = "zoom-inline-bao";
    baoLoi.setAttribute("aria-live", "polite");
    huy.addEventListener("click", () => veDanhSach(meetingsHienTai));
    luu.addEventListener("click", async () => {
      if (luu.disabled) return;
      luu.disabled = true;
      baoLoi.textContent = "Đang lưu…";
      try {
        const res = await fetch(`/api/zoom/cuoc-hop/${encodeURIComponent(hop.meetingId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: ten.value,
            date: ngay.value,
            time: gio.value,
            duration: Number(phut.value),
            timezone: layMuiGioDaChon(muiGio),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Không sửa được lịch Zoom.");
        await taiLaiSauMutation();
      } catch (error) {
        baoLoi.textContent = error.message;
        baoLoi.style.color = "var(--danger)";
        luu.disabled = false;
      }
    });
    hanhDong.append(luu, huy, baoLoi);
    khung.append(form, hanhDong);
  };

  const veXacNhanXoa = (hop, khung) => {
    dongMenu();
    khung.querySelector(".zoom-xoa-xac-nhan")?.remove();
    const xacNhan = document.createElement("div");
    xacNhan.className = "zoom-xoa-xac-nhan";
    const cauHoi = document.createElement("p");
    cauHoi.textContent = `Xóa cuộc họp “${hop.topic || hop.meetingId}”?`;
    const actions = document.createElement("div");
    actions.className = "zoom-form-actions";
    const huy = taoNut("Hủy");
    const xoa = taoNut("Xóa lịch", "danger-button");
    const baoLoi = document.createElement("span");
    baoLoi.className = "zoom-inline-bao";
    baoLoi.setAttribute("aria-live", "polite");
    huy.addEventListener("click", () => xacNhan.remove());
    xoa.addEventListener("click", async () => {
      if (xoa.disabled) return;
      xoa.disabled = true;
      baoLoi.textContent = "Đang xóa…";
      try {
        const res = await fetch(`/api/zoom/cuoc-hop/${encodeURIComponent(hop.meetingId)}`, {
          method: "DELETE",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Không xóa được lịch Zoom.");
        await taiLaiSauMutation();
      } catch (error) {
        baoLoi.textContent = error.message;
        baoLoi.style.color = "var(--danger)";
        xoa.disabled = false;
      }
    });
    actions.append(huy, xoa, baoLoi);
    xacNhan.append(cauHoi, actions);
    khung.appendChild(xacNhan);
  };

  const veDong = (hop) => {
    const khung = document.createElement("article");
    khung.className = "zoom-lich-dong";
    khung.dataset.meetingId = String(hop.meetingId || "");

    const ten = themCot(khung, "zoom-lich-ten", "Tên cuộc họp", hop.topic || "(Không có tên)");
    if (!loaiMeetingQuanLyDuoc(hop.type)) {
      const badge = document.createElement("span");
      badge.className = "zoom-loai-badge";
      badge.textContent = "Lặp lại — P2D V1 chỉ xem";
      ten.appendChild(badge);
    }
    themCot(khung, "zoom-lich-ngay", "Ngày", hienThiNgay(hop.date));
    themCot(khung, "zoom-lich-gio", "Giờ", hop.time || "—");
    themCot(khung, "zoom-lich-phut", "Thời lượng", `${hop.duration || 0} phút`);
    themCot(khung, "zoom-lich-id", "Meeting ID", hop.meetingId);

    const hanhDong = document.createElement("div");
    hanhDong.className = "zoom-lich-hanh-dong";
    if (hop.joinUrl) {
      const moLink = document.createElement("a");
      moLink.className = "secondary-button zoom-mo-link";
      moLink.href = hop.joinUrl;
      moLink.target = "_blank";
      moLink.rel = "noopener noreferrer";
      moLink.textContent = "Mở link";
      hanhDong.appendChild(moLink);
    }

    const phanHoi = document.createElement("span");
    phanHoi.className = "zoom-sao-chep-phan-hoi";
    phanHoi.setAttribute("aria-live", "polite");
    const saoChep = taoNut("Sao chép");
    saoChep.addEventListener("click", () => saoChepMeeting(hop, saoChep, phanHoi));
    hanhDong.append(saoChep, phanHoi);

    if (loaiMeetingQuanLyDuoc(hop.type)) {
      const bocMenu = document.createElement("div");
      bocMenu.className = "zoom-row-menu-wrap";
      const moMenu = taoNut("...", "secondary-button zoom-row-menu-button");
      moMenu.setAttribute("aria-label", `Thao tác cho ${hop.topic || hop.meetingId}`);
      moMenu.setAttribute("aria-haspopup", "menu");
      moMenu.setAttribute("aria-expanded", "false");
      const menu = document.createElement("div");
      menu.className = "zoom-row-menu";
      menu.setAttribute("role", "menu");
      menu.hidden = true;
      const sua = taoNut("Sửa lịch", "zoom-row-menu-item");
      sua.setAttribute("role", "menuitem");
      const xoa = taoNut("Xóa lịch", "zoom-row-menu-item zoom-row-menu-item-danger");
      xoa.setAttribute("role", "menuitem");
      sua.addEventListener("click", () => veFormSua(hop, khung));
      xoa.addEventListener("click", () => veXacNhanXoa(hop, khung));
      moMenu.addEventListener("click", (event) => {
        event.stopPropagation();
        const seMo = menu.hidden;
        dongMenu();
        menu.hidden = !seMo;
        moMenu.setAttribute("aria-expanded", String(seMo));
        menuDangMo = seMo ? menu : null;
      });
      menu.append(sua, xoa);
      bocMenu.append(moMenu, menu);
      hanhDong.appendChild(bocMenu);
    }
    khung.appendChild(hanhDong);
    return khung;
  };

  function veDanhSach(meetings) {
    dongMenu();
    meetingsHienTai = Array.isArray(meetings) ? meetings : [];
    const danhSach = $("#zm-hop-danh-sach");
    danhSach.textContent = "";
    $("#zm-lich-bao").textContent = "";
    if (!meetingsHienTai.length) {
      veThongBaoLich("Chưa có cuộc họp Zoom sắp tới.");
      return;
    }

    const dau = document.createElement("div");
    dau.className = "zoom-lich-dau";
    for (const label of ["Tên cuộc họp", "Ngày", "Giờ", "Thời lượng", "Meeting ID", "Tham gia"]) {
      const o = document.createElement("span");
      o.textContent = label;
      dau.appendChild(o);
    }
    danhSach.appendChild(dau);
    for (const hop of meetingsHienTai) danhSach.appendChild(veDong(hop));
  }

  async function taiDanhSach() {
    if (!configHienTai?.configured) {
      meetingsHienTai = [];
      $("#zm-hop-danh-sach").textContent = "";
      veThongBaoLich("Kết nối Zoom để tải lịch.");
      return;
    }
    if (dangTaiDanhSach) return dangTaiDanhSach;
    $("#zm-hop-danh-sach").textContent = "";
    veThongBaoLich("Đang tải lịch Zoom...");

    dangTaiDanhSach = (async () => {
      try {
        const res = await fetch("/api/zoom/cuoc-hop");
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Không tải được lịch Zoom.");
        veDanhSach(data.meetings || []);
      } catch {
        $("#zm-hop-danh-sach").textContent = "";
        veThongBaoLich("Không tải được lịch Zoom.", { loi: true, thuLai: true });
      } finally {
        dangTaiDanhSach = null;
      }
    })();
    return dangTaiDanhSach;
  }

  async function docCauHinh() {
    try {
      const res = await fetch("/api/zoom");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không đọc được cấu hình Zoom.");
      veCauHinh(data.config);
      return data.config;
    } catch (error) {
      bao(error.message, "var(--danger)");
      configHienTai = null;
      return null;
    }
  }

  $("#zm-cau-hinh-toggle").addEventListener("click", () => {
    datMoCauHinh($("#zm-cau-hinh-noi-dung").hidden);
  });

  $("#zm-mo-tao").addEventListener("click", () => {
    datMoTao($("#zm-tao-khung").hidden);
  });
  $("#zm-huy-tao").addEventListener("click", () => {
    datMoTao(false);
    baoHop("");
  });

  $("#zm-luu").addEventListener("click", async () => {
    bao("Đang lưu…");
    try {
      const res = await fetch("/api/zoom/luu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: $("#zm-account-id").value,
          clientId: $("#zm-client-id").value,
          clientSecret: $("#zm-client-secret").value,
          hostEmail: $("#zm-host-email").value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Lưu không được.");
      veCauHinh(data.config);
      bao("Đã lưu. Bấm Kiểm tra để thử kết nối.", "var(--ok)");
      await taiDanhSach();
    } catch (error) {
      bao(error.message, "var(--danger)");
    }
  });

  $("#zm-kiem-tra").addEventListener("click", async () => {
    bao("Đang kiểm tra…");
    try {
      const res = await fetch("/api/zoom/kiem-tra", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Kiểm tra không được.");
      const ten = data.tk?.displayName ? ` (${data.tk.displayName})` : "";
      datTrangThai(`Kết nối tốt · ${data.tk?.email || ""}`, "var(--ok)");
      bao(`Kết nối tốt · ${data.tk?.email || ""}${ten}`, "var(--ok)");
    } catch (error) {
      bao(error.message, "var(--danger)");
    }
  });

  $("#zm-ngat").addEventListener("click", async () => {
    bao("Đang ngắt…");
    try {
      const res = await fetch("/api/zoom/ngat", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Ngắt không được.");
      veCauHinh(data.config);
      meetingsHienTai = [];
      $("#zm-hop-danh-sach").textContent = "";
      veThongBaoLich("Kết nối Zoom để tải lịch.");
      bao("Đã ngắt kết nối Zoom.", "var(--warn)");
    } catch (error) {
      bao(error.message, "var(--danger)");
    }
  });

  $("#zm-tao-hop").addEventListener("click", async () => {
    const nut = $("#zm-tao-hop");
    if (nut.disabled) return;
    nut.disabled = true;
    const chuCu = nut.textContent;
    nut.textContent = "Đang tạo…";
    baoHop("");
    try {
      const res = await fetch("/api/zoom/tao-cuoc-hop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: $("#zm-hop-ten").value,
          date: $("#zm-hop-ngay").value,
          time: $("#zm-hop-gio").value,
          duration: Number($("#zm-hop-phut").value),
          timezone: layMuiGioDaChon($("#zm-hop-mui-gio")),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Tạo cuộc họp không được.");
      $("#zm-hop-ten").value = "";
      $("#zm-hop-ngay").value = "";
      $("#zm-hop-gio").value = "";
      $("#zm-hop-phut").value = "60";
      $("#zm-hop-mui-gio").value = MUI_GIO_MAC_DINH;
      datMoTao(false);
      await taiLaiSauMutation();
    } catch (error) {
      baoHop(error.message, "var(--danger)");
    } finally {
      nut.disabled = !configHienTai?.configured;
      nut.textContent = chuCu;
    }
  });

  document.addEventListener("click", (event) => {
    if (menuDangMo && !menuDangMo.parentElement?.contains(event.target)) dongMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dongMenu();
  });

  lamMoi = async () => {
    await docCauHinh();
    await taiDanhSach();
  };
  await lamMoi();
}
