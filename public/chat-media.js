const LOAI_ANH_ZALO = "chat.photo";
const LOAI_TEP_ZALO = "share.file";
const DUOI_ANH_ZALO = /\.(?:jpe?g|png|webp|gif)$/i;

function noiDungProvider(message) {
  return message?.rawJson?.data?.content ?? message?.rawJson?.content ?? null;
}

function chuoiCoGiaTri(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function urlHttp(value) {
  const text = chuoiCoGiaTri(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function jsonParams(value) {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function soDuong(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

/**
 * Phan loai bang msgType canonical cua Zalo. Khong suy dien media tu mot URL
 * .jpg nam trong tin text, nen link nguoi dung go van la tin nhan binh thuong.
 */
export function phanLoaiMediaTinNhan(message) {
  const msgType = String(message?.msgType || "");
  if (msgType !== LOAI_ANH_ZALO && msgType !== LOAI_TEP_ZALO) return null;

  const raw = noiDungProvider(message);
  if (!raw || typeof raw !== "object") return null;
  const url = urlHttp(raw.href);
  if (!url) return null;

  const params = jsonParams(raw.params);
  const filename = chuoiCoGiaTri(raw.title) || chuoiCoGiaTri(raw.fileName);
  const size = soDuong(raw.fileSize, raw.totalSize, raw.hdSize, params.fileSize, params.totalSize, params.hdSize);
  const width = soDuong(raw.width, params.width);
  const height = soDuong(raw.height, params.height);

  if (msgType === LOAI_ANH_ZALO) {
    const description = chuoiCoGiaTri(raw.description);
    return {
      kind: "image",
      url,
      thumbnailUrl: urlHttp(raw.thumb) || urlHttp(raw.thumbUrl) || url,
      filename,
      size,
      width,
      height,
      caption: description && description !== url ? description : null,
    };
  }

  return { kind: "file", url, filename, size };
}

export function laAnhZalo(file) {
  return DUOI_ANH_ZALO.test(String(file?.name || ""));
}

export function dinhDangDungLuong(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
