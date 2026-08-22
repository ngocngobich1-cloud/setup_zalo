/**
 * Trong NHOM, bot chi duoc mo mieng khi co nguoi goi dich danh.
 *
 * Truoc day lam nguoc lai: liet ke nhung loai tin CAN CHAN (group.poll,
 * group.join...). Cach do thua hai lan roi - lan dau la tin binh chon, lan sau
 * la tin "Ban da tro thanh pho nhom" mang loai chat.ecard nen lot qua. Zalo de
 * them loai tin luc nao minh khong biet, danh sach chan khong bao gio du.
 *
 * Nen doi huong: trong nhom mac dinh IM. Zalo de ra bao nhieu loai su kien moi
 * cung khong sao, vi su kien thi khong ai tag bot ca.
 */

/** uid ao Zalo dung cho "@All". Tag ca nhom khong tinh la goi rieng bot. */
const TAG_TAT_CA = new Set(["-1", "0", "all"]);

/**
 * @param {object} message tin da normalize
 * @param {string} uidBot uid cua nick bot
 * @returns {boolean} co dung la nguoi ta tag dich danh bot khong
 */
export function botDuocGoi(message, uidBot) {
  const bot = String(uidBot || "");
  if (!bot) return false;

  const ds = message?.rawJson?.data?.mentions ?? message?.rawJson?.mentions;
  if (!Array.isArray(ds)) return false;

  // Doi chieu uid THAT trong du lieu tag, khong do chu "@Vizen" trong cau. Hai
  // nguoi nhac den ten bot luc noi chuyen voi nhau thi bot khong duoc chen vao.
  return ds.some((m) => {
    const uid = String(m?.uid ?? "");
    return uid && !TAG_TAT_CA.has(uid) && uid === bot;
  });
}
