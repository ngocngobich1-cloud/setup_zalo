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
    button.innerHTML = `<strong>${channel.label}</strong><span>${channel.target}</span>`;
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
