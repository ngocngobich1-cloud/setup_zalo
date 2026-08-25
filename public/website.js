let lamMoi = null;

async function goiBackend(url, options = {}) {
  const res = await fetch(url, options);
  let data = {};
  try {
    data = await res.json();
  } catch {
    // Backend cung phai fail safe neu co loi bat ngo khong tra JSON.
  }
  if (!res.ok) throw new Error(data?.error || "Không thực hiện được thao tác Website.");
  return data;
}

export async function napWebsite() {
  const panel = document.querySelector("#website-panel");
  if (!panel) return;
  if (lamMoi) return lamMoi();

  panel.innerHTML = `
    <section class="website-connector">
      <div class="website-form">
        <label class="website-field" for="ws-name">
          <span>Tên kết nối</span>
          <input id="ws-name" type="text" autocomplete="off" required />
        </label>
        <label class="website-field" for="ws-api-url">
          <span>API URL</span>
          <input id="ws-api-url" type="url" autocomplete="off" required />
        </label>
        <label class="website-field" for="ws-api-token">
          <span>API Token</span>
          <input id="ws-api-token" type="password" autocomplete="new-password" />
        </label>
        <div class="website-actions">
          <button id="ws-test" class="secondary-button" type="button">Kiểm tra kết nối</button>
          <button id="ws-save" class="primary-button" type="button">Lưu</button>
          <button id="ws-disconnect" class="secondary-button" type="button" hidden>Ngắt kết nối</button>
        </div>
        <p id="ws-message" class="field-hint website-message" aria-live="polite"></p>
      </div>
    </section>

    <section id="ws-customers-section" class="website-customers" hidden>
      <header class="website-customers-header">
        <h4>Danh sách khách hàng</h4>
        <button id="ws-reload" class="secondary-button" type="button">Tải lại</button>
      </header>
      <p id="ws-customers-message" class="field-hint website-message" aria-live="polite"></p>
      <div id="ws-customers-content"></div>
    </section>
  `;

  const $ = (selector) => panel.querySelector(selector);
  const cardStatus = document.querySelector("#tool-website-status");
  const detailStatus = document.querySelector("#website-detail-status");
  let configHienTai = null;

  const bao = (text, color = "var(--muted)") => {
    $("#ws-message").textContent = text || "";
    $("#ws-message").style.color = color;
  };

  const baoKhach = (text, color = "var(--muted)") => {
    $("#ws-customers-message").textContent = text || "";
    $("#ws-customers-message").style.color = color;
  };

  const datTrangThai = (text, color = "") => {
    for (const element of [cardStatus, detailStatus]) {
      if (!element) continue;
      element.textContent = text;
      element.style.color = color;
    }
  };

  const xoaDanhSach = () => {
    $("#ws-customers-content").textContent = "";
    baoKhach("");
    $("#ws-customers-section").hidden = true;
  };

  const veConfig = (config = {}) => {
    configHienTai = config;
    $("#ws-name").value = config.name || "";
    $("#ws-api-url").value = config.apiUrl || "";
    $("#ws-api-token").value = "";
    $("#ws-api-token").placeholder = config.hasApiToken
      ? "(đã lưu — để trống nếu không đổi)"
      : "";
    $("#ws-disconnect").hidden = !config.configured;

    if (config.connected) {
      datTrangThai("Đã kết nối", "var(--ok)");
      $("#ws-customers-section").hidden = false;
    } else if (config.configured) {
      datTrangThai("Chưa kiểm tra");
      xoaDanhSach();
    } else {
      datTrangThai("Chưa kết nối");
      xoaDanhSach();
    }
  };

  const veKhachHang = (customers = []) => {
    const content = $("#ws-customers-content");
    content.textContent = "";
    if (!customers.length) {
      const empty = document.createElement("p");
      empty.className = "website-empty";
      empty.textContent = "Website chưa có khách hàng nào.";
      content.append(empty);
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "website-table-wrap";
    const table = document.createElement("table");
    table.className = "website-table";
    table.innerHTML = `
      <thead><tr><th scope="col">Số điện thoại</th><th scope="col">Email</th></tr></thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");
    for (const customer of customers) {
      const row = document.createElement("tr");
      const phone = document.createElement("td");
      const email = document.createElement("td");
      phone.textContent = customer.phone;
      email.textContent = customer.email;
      row.append(phone, email);
      tbody.append(row);
    }
    wrap.append(table);
    content.append(wrap);
  };

  const taiKhachHang = async () => {
    if (!configHienTai?.connected) return xoaDanhSach();
    $("#ws-customers-section").hidden = false;
    baoKhach("Đang tải danh sách khách hàng…");
    $("#ws-customers-content").textContent = "";
    try {
      const data = await goiBackend("/api/website/customers");
      veKhachHang(data.customers || []);
      baoKhach(data.warning || "");
    } catch (error) {
      datTrangThai("Lỗi kết nối", "var(--danger)");
      baoKhach(error.message, "var(--danger)");
    }
  };

  const taiConfig = async () => {
    try {
      const data = await goiBackend("/api/website");
      veConfig(data.config || {});
      if (data.config?.connected) await taiKhachHang();
    } catch (error) {
      datTrangThai("Lỗi kết nối", "var(--danger)");
      bao(error.message, "var(--danger)");
      xoaDanhSach();
    }
  };

  $("#ws-save").addEventListener("click", async () => {
    bao("Đang lưu…");
    try {
      const data = await goiBackend("/api/website/luu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: $("#ws-name").value,
          apiUrl: $("#ws-api-url").value,
          apiToken: $("#ws-api-token").value,
        }),
      });
      veConfig(data.config || {});
      bao("Đã lưu. Bấm Kiểm tra kết nối để xác minh Website API.", "var(--ok)");
    } catch (error) {
      bao(error.message, "var(--danger)");
    }
  });

  $("#ws-test").addEventListener("click", async () => {
    bao("Đang kiểm tra kết nối…");
    try {
      const data = await goiBackend("/api/website/kiem-tra", { method: "POST" });
      await taiConfig();
      bao(data.warning || `Kết nối thành công · ${data.customerCount || 0} khách hàng`, "var(--ok)");
    } catch (error) {
      configHienTai = { ...(configHienTai || {}), connected: false };
      datTrangThai("Lỗi kết nối", "var(--danger)");
      xoaDanhSach();
      bao(error.message, "var(--danger)");
    }
  });

  $("#ws-disconnect").addEventListener("click", async () => {
    if (!confirm("Ngắt kết nối Website?")) return;
    bao("Đang ngắt kết nối…");
    try {
      const data = await goiBackend("/api/website/ngat", { method: "POST" });
      veConfig(data.config || {});
      bao("Đã ngắt kết nối Website.");
    } catch (error) {
      bao(error.message, "var(--danger)");
    }
  });

  $("#ws-reload").addEventListener("click", () => void taiKhachHang());

  lamMoi = taiConfig;
  await taiConfig();
}
