function soNguyenDuong(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Bien tep multipart thanh AttachmentSource cua zca-js. Chi dung buffer server
 * vua nhan; khong co nhanh nao doc mot path do browser truyen len.
 */
export function taoNguonDinhKemZalo(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new Error("Tệp đính kèm trống hoặc không hợp lệ.");
  }

  const filename = String(file.filename || "")
    .split(/[\\/]/)
    .pop()
    ?.trim();
  if (!filename || !/\.[a-z0-9]+$/i.test(filename)) {
    throw new Error("Tệp đính kèm cần có tên và phần mở rộng hợp lệ.");
  }

  const metadata = { totalSize: file.buffer.length };
  if (/\.(?:jpe?g|png|webp|gif)$/i.test(filename)) {
    const width = soNguyenDuong(file.width);
    const height = soNguyenDuong(file.height);
    if (!width || !height) {
      throw new Error("Không đọc được kích thước ảnh đính kèm.");
    }
    metadata.width = width;
    metadata.height = height;
  }

  return { data: file.buffer, filename, metadata };
}
