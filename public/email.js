// Phan he Email: noi voi Zoho Mail va tra cuu thu da gui.
// Client Secret va chia khoa KHONG BAO GIO duoc gui ve trinh duyet - server chi
// tra ve "co/khong co", nen o mat khau luon rong khi mo lai trang.

const KET_QUA = {
  da_gui: { chu: "Đã gửi", mau: "var(--ok)", icon: "✓" },
  tra_ve: { chu: "Bị trả về", mau: "var(--danger)", icon: "⚠" },
  khong_thay: { chu: "Không thấy trong Đã gửi", mau: "var(--warn)", icon: "✗" },
  loi: { chu: "Tra cứu lỗi", mau: "var(--danger)", icon: "!" },
};

const gio = (giay) =>
  giay
    ? new Date(Number(giay) * 1000).toLocaleString("vi-VN", {
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "—";

// Giu ham lam moi lai de lan sau mo phan he thi chi ve lai, khong dung lai UI.
let lamMoi = null;

export async function napEmail() {
  const panel = document.querySelector("#email-panel");
  if (!panel) return;
  if (lamMoi) return lamMoi();

  panel.innerHTML = `
    <header class="email-header">
      <div>
        <h2>Email</h2>
        <p class="training-meta" id="em-trang-thai">Đang kiểm tra…</p>
      </div>
      <span id="em-den" class="zalo-dot"></span>
    </header>

    <section class="email-khoi">
      <h3>Kết nối Zoho Mail</h3>
      <div class="email-hang">
        <label>Vùng dữ liệu</label>
        <select id="em-vung"></select>
      </div>
      <div class="email-hang">
        <label>Client ID</label>
        <input id="em-client-id" autocomplete="off" placeholder="1000.XXXXXXXX..." />
      </div>
      <div class="email-hang">
        <label>Client Secret</label>
        <input id="em-client-secret" type="password" autocomplete="new-password" placeholder="để trống nếu không đổi" />
      </div>
      <div class="email-nut">
        <button id="em-luu-app" class="secondary-button" type="button">Lưu</button>
      </div>
      <p class="field-hint" style="margin:0">
        Hai ô trên luôn để trống khi mở lại trang — app không bao giờ gửi bí mật về trình duyệt.
        Muốn đổi mỗi Vùng dữ liệu thì cứ để trống rồi bấm Lưu.
      </p>

      <hr class="email-vach" />

      <p class="field-hint" style="margin:0 0 8px">
        Vào <strong>api-console.zoho.com</strong> → Self Client → tab <strong>Generate Code</strong>.
        Scope điền: <code>ZohoMail.accounts.READ,ZohoMail.messages.READ</code> — chọn thời hạn dài nhất.
        Mã chỉ sống vài phút, dán vào đây ngay.
      </p>
      <div class="email-hang">
        <label>Mã từ Zoho</label>
        <input id="em-ma" autocomplete="off" placeholder="1000.xxxxx.yyyyy" />
      </div>
      <div class="email-nut">
        <button id="em-ket-noi" class="primary-button" type="button">🔗 Kết nối với Zoho</button>
        <button id="em-kiem-tra" class="secondary-button" type="button">Kiểm tra</button>
        <button id="em-ngat" class="secondary-button" type="button">Ngắt kết nối</button>
      </div>
      <label class="email-gat">
        <input type="checkbox" id="em-bat" />
        <span>Cho bot tự tra cứu khi khách nhắn riêng kèm địa chỉ email</span>
      </label>
      <div id="em-bao" class="field-hint" style="min-height:18px"></div>
    </section>

    <section class="email-khoi">
      <h3>Tra thử</h3>
      <div class="email-hang">
        <input id="em-tra-email" autocomplete="off" placeholder="email-cua-hoc-vien@gmail.com" />
        <button id="em-tra" class="secondary-button" type="button">Tra cứu</button>
      </div>
      <div id="em-tra-ket-qua" class="field-hint" style="min-height:20px"></div>
    </section>

    <section class="email-khoi">
      <div class="rule-list-header">
        <h3>Lịch sử tra cứu</h3>
        <div style="display:flex; gap:8px">
          <button id="em-lich-su-tai-lai" class="secondary-button" type="button">Tải lại</button>
          <button id="em-lich-su-xoa" class="secondary-button" type="button">Xoá hết</button>
        </div>
      </div>
      <div id="em-lich-su-bao" class="field-hint" style="min-height:18px; margin-bottom:6px"></div>
      <div id="em-lich-su" class="rule-list"></div>
    </section>
  `;

  const $ = (id) => panel.querySelector(id);
  const bao = (text, loi = false) => {
    $("#em-bao").textContent = text;
    $("#em-bao").style.color = loi ? "var(--danger)" : "var(--muted)";
  };
  const baoLichSu = (text, loi = false) => {
    $("#em-lich-su-bao").textContent = text;
    $("#em-lich-su-bao").style.color = loi ? "var(--danger)" : "var(--muted)";
  };

  async function veLaiTrangThai() {
    const res = await fetch("/api/zoho");
    const data = await res.json();
    const c = data.config || {};

    if (!$("#em-vung").options.length) {
      for (const v of data.vung || []) {
        const o = document.createElement("option");
        o.value = v.id;
        o.textContent = v.ten;
        $("#em-vung").append(o);
      }
    }
    $("#em-vung").value = c.vung || "com";
    $("#em-client-id").placeholder = c.coClientId ? "(đã lưu — gõ để thay)" : "1000.XXXXXXXX...";
    $("#em-client-secret").placeholder = c.coClientSecret ? "(đã lưu — để trống nếu không đổi)" : "";
    $("#em-bat").checked = Boolean(c.bat);
    $("#em-bat").disabled = !c.daKetNoi;

    const den = $("#em-den");
    if (c.daKetNoi) {
      den.className = "zalo-dot zalo-dot-ok";
      $("#em-trang-thai").textContent = `Đã kết nối · ${c.diaChi}` + (c.bat ? "" : " · bot đang KHÔNG tự tra");
    } else {
      den.className = "zalo-dot zalo-dot-cho";
      $("#em-trang-thai").textContent = c.coClientId
        ? "Chưa kết nối — chị sinh mã ở Zoho rồi dán vào bên dưới"
        : "Chưa kết nối — chị nhập Client ID / Secret trước";
    }
  }

  async function veLaiLichSu() {
    const res = await fetch("/api/zoho/lich-su");
    const data = await res.json();
    const ds = data.lichSu || [];
    const box = $("#em-lich-su");
    box.innerHTML = "";
    if (!ds.length) {
      box.innerHTML = "<div class='empty-hint' style='margin:0; padding:12px;'>Chưa có lượt tra cứu nào.</div>";
      return;
    }
    for (const d of ds) {
      const k = KET_QUA[d.ketQua] || { chu: d.ketQua, mau: "var(--muted)", icon: "·" };
      const item = document.createElement("div");
      item.className = "rule-item";
      const info = document.createElement("div");
      info.className = "rule-info";

      const d1 = document.createElement("div");
      d1.className = "rule-cmd";
      const ai =
        { thu_cong: "chị tra thủ công", admin_zalo: "chị hỏi qua Zalo" }[d.nguon] ||
        `${d.nguoiHoiTen || "Khách"} hỏi`;
      d1.textContent = `${gio(d.luc)} · ${ai}`;

      const d2 = document.createElement("div");
      d2.className = "rule-meta";
      d2.textContent = d.emailTra;

      const d3 = document.createElement("div");
      d3.className = "rule-meta";
      d3.style.color = k.mau;
      d3.textContent = `${k.icon} ${k.chu}` + (d.guiLuc ? ` · gửi lúc ${gio(d.guiLuc)}` : "");

      info.append(d1, d2, d3);
      item.append(info);
      box.append(item);
    }
  }

  $("#em-luu-app").onclick = async () => {
    bao("Đang lưu…");
    const res = await fetch("/api/zoho/app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vung: $("#em-vung").value,
        clientId: $("#em-client-id").value.trim(),
        clientSecret: $("#em-client-secret").value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) return bao("Lỗi: " + data.error, true);
    $("#em-client-id").value = "";
    $("#em-client-secret").value = "";
    bao(`Đã lưu (vùng: ${$("#em-vung").selectedOptions[0]?.textContent || ""}). Giờ chị sinh mã ở Zoho rồi dán vào ô bên dưới.`);
    await veLaiTrangThai();
  };

  $("#em-ket-noi").onclick = async () => {
    const ma = $("#em-ma").value.trim();
    if (!ma) return bao("Chị dán mã từ Zoho vào giúp em.", true);
    bao("Đang kết nối với Zoho…");
    $("#em-ket-noi").disabled = true;
    try {
      const res = await fetch("/api/zoho/ket-noi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ma }),
      });
      const data = await res.json();
      if (!res.ok) return bao("Lỗi: " + data.error, true);
      $("#em-ma").value = "";
      bao("Kết nối thành công. Từ giờ không phải làm lại nữa.");
      await veLaiTrangThai();
    } finally {
      $("#em-ket-noi").disabled = false;
    }
  };

  $("#em-kiem-tra").onclick = async () => {
    bao("Đang kiểm tra…");
    const res = await fetch("/api/zoho/kiem-tra", { method: "POST" });
    const data = await res.json();
    bao(res.ok ? `Kết nối tốt · ${data.diaChi}` : "Lỗi: " + data.error, !res.ok);
    await veLaiTrangThai();
  };

  $("#em-ngat").onclick = async () => {
    if (!confirm("Ngắt kết nối Zoho Mail?\n\nBot sẽ không tra cứu email được nữa cho tới khi chị kết nối lại bằng mã mới.")) return;
    await fetch("/api/zoho/ngat", { method: "POST" });
    bao("Đã ngắt kết nối.");
    await veLaiTrangThai();
  };

  $("#em-bat").onchange = async () => {
    await fetch("/api/zoho/bat-tat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bat: $("#em-bat").checked }),
    });
    await veLaiTrangThai();
  };

  $("#em-tra").onclick = async () => {
    const email = $("#em-tra-email").value.trim();
    const o = $("#em-tra-ket-qua");
    if (!email) return;
    o.textContent = "Đang tra…";
    o.style.color = "var(--muted)";
    const res = await fetch("/api/zoho/tra-cuu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) {
      o.textContent = "Lỗi: " + data.error;
      o.style.color = "var(--danger)";
    } else {
      const k = KET_QUA[data.ketQua.trangThai] || { chu: data.ketQua.trangThai, mau: "var(--muted)", icon: "·" };
      o.textContent = `${k.icon} ${k.chu}` + (data.ketQua.guiLuc ? ` · gửi lúc ${gio(data.ketQua.guiLuc)}` : "");
      o.style.color = k.mau;
    }
    await veLaiLichSu();
  };

  // Truoc day chi co mot nut ten "Lam moi". No tai lai danh sach, nhung khong
  // bao gi sau khi bam nen trong y het bi hong - va cai ten thi de hieu nham
  // thanh "don sach danh sach". Tach hai viec ra, moi nut lam dung ten cua no.
  $("#em-lich-su-tai-lai").onclick = async () => {
    await veLaiLichSu();
    const n = $("#em-lich-su").querySelectorAll(".rule-item").length;
    baoLichSu(`Đã tải lại lúc ${new Date().toLocaleTimeString("vi-VN")} · ${n} lượt tra`);
  };

  $("#em-lich-su-xoa").onclick = async () => {
    if (!confirm("Xoá TOÀN BỘ lịch sử tra cứu email?\n\nChỉ xoá phần ghi chép trong app. Thư trong hộp mail Zoho không bị đụng tới.")) return;
    const res = await fetch("/api/zoho/lich-su", { method: "DELETE" });
    const data = await res.json();
    baoLichSu(res.ok ? `Đã xoá ${data.soDong} dòng.` : "Lỗi: " + data.error, !res.ok);
    await veLaiLichSu();
  };

  lamMoi = async () => {
    await veLaiTrangThai().catch(() => {});
    await veLaiLichSu().catch(() => {});
  };

  await lamMoi();
}
