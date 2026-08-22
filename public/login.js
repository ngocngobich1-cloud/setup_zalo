const form = document.querySelector("#auth-form");
const username = document.querySelector("#auth-username");
const password = document.querySelector("#auth-password");
const errorBox = document.querySelector("#auth-error");
const submit = document.querySelector("#auth-submit");

const otpForm = document.querySelector("#otp-form");
const otpChannels = document.querySelector("#otp-channels");
const otpCodeGroup = document.querySelector("#otp-code-group");
const otpCode = document.querySelector("#otp-code");
const otpSentTo = document.querySelector("#otp-sent-to");
const otpError = document.querySelector("#otp-error");
const otpSubmit = document.querySelector("#otp-submit");
const otpResend = document.querySelector("#otp-resend");
const otpBack = document.querySelector("#otp-back");

let chonKenh = null;

/* --- Buoc bat buoc doi mat khau lan dau --- */
const doiMkForm = document.querySelector("#doi-mk-form");
const mkMoi = document.querySelector("#mk-moi");
const mkXacNhan = document.querySelector("#mk-xac-nhan");
const mkError = document.querySelector("#mk-error");
const mkSubmit = document.querySelector("#mk-submit");
let matKhauVuaDung = "";

function moBuocDoiMatKhau() {
  form.classList.add("hidden");
  otpForm.classList.add("hidden");
  doiMkForm.classList.remove("hidden");
  mkError.textContent = "";
  mkMoi.value = "";
  mkXacNhan.value = "";
  mkMoi.focus();
}

doiMkForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  mkError.textContent = "";

  if (mkMoi.value !== mkXacNhan.value) {
    mkError.textContent = "Hai ô mật khẩu không khớp.";
    return;
  }

  mkSubmit.disabled = true;
  mkSubmit.textContent = "Đang đổi...";
  try {
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: matKhauVuaDung,
        newPassword: mkMoi.value,
        confirmPassword: mkXacNhan.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Đổi mật khẩu thất bại.");
    matKhauVuaDung = "";
    window.location.href = "/";
  } catch (error) {
    mkError.textContent = error.message;
    mkMoi.value = "";
    mkXacNhan.value = "";
    mkMoi.focus();
  } finally {
    mkSubmit.disabled = false;
    mkSubmit.textContent = "Đổi mật khẩu và vào ứng dụng";
  }
});

function moBuocOtp(channels) {
  form.classList.add("hidden");
  otpForm.classList.remove("hidden");
  otpError.textContent = "";
  otpChannels.innerHTML = "";

  for (const channel of channels) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "otp-channel";
    button.dataset.channel = channel.id;
    // Dung textContent chu KHONG dung innerHTML: channel.label la ten hien thi
    // cua mot lien he Zalo - do nguoi khac dat, ho de gi vao cung duoc. Ghep
    // thang vao innerHTML thi mot cai ten chua the <script> se chay tren dung
    // trang nhap ma OTP.
    const ten = document.createElement("strong");
    ten.textContent = channel.label || "";
    const dich = document.createElement("span");
    dich.textContent = channel.target || "";
    button.replaceChildren(ten, dich);
    button.addEventListener("click", () => guiMa(channel));
    otpChannels.append(button);
  }
}

async function guiMa(channel) {
  chonKenh = channel;
  otpError.textContent = "";
  otpChannels.querySelectorAll(".otp-channel").forEach((b) => {
    b.classList.toggle("active", b.dataset.channel === channel.id);
    b.disabled = true;
  });

  try {
    const res = await fetch("/api/auth/otp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channel.id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Không gửi được mã.");

    otpCodeGroup.classList.remove("hidden");
    otpSubmit.classList.remove("hidden");
    otpResend.classList.remove("hidden");
    otpSentTo.textContent = `Đã gửi mã tới ${channel.label}: ${channel.target}. Mã có hiệu lực 5 phút.`;
    otpCode.value = "";
    otpCode.focus();
  } catch (error) {
    otpError.textContent = error.message;
  } finally {
    otpChannels.querySelectorAll(".otp-channel").forEach((b) => { b.disabled = false; });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.textContent = "";
  submit.disabled = true;
  submit.textContent = "Đang đăng nhập...";

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Đăng nhập thất bại.");

    if (data.otpRequired) {
      password.value = "";
      moBuocOtp(data.channels || []);
      return;
    }
    if (data.mustChangePassword) {
      // Giu lai mat khau vua go de goi API doi mat khau san co (no doi
      // currentPassword). Khong tao endpoint thu hai chi de bo qua buoc nay.
      matKhauVuaDung = password.value;
      password.value = "";
      moBuocDoiMatKhau();
      return;
    }
    window.location.href = "/";
  } catch (error) {
    errorBox.textContent = error.message;
    password.value = "";
    password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "Đăng nhập";
  }
});

otpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  otpError.textContent = "";
  otpSubmit.disabled = true;

  try {
    const res = await fetch("/api/auth/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: otpCode.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Xác thực thất bại.");
    window.location.href = "/";
  } catch (error) {
    otpError.textContent = error.message;
    otpCode.value = "";
    otpCode.focus();
  } finally {
    otpSubmit.disabled = false;
  }
});

otpResend.addEventListener("click", () => {
  if (chonKenh) guiMa(chonKenh);
});

otpBack.addEventListener("click", () => {
  otpForm.classList.add("hidden");
  form.classList.remove("hidden");
  otpCodeGroup.classList.add("hidden");
  otpSubmit.classList.add("hidden");
  otpResend.classList.add("hidden");
  otpError.textContent = "";
  username.focus();
});
