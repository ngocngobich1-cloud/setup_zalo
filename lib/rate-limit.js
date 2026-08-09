/**
 * Chan do mat khau. Dem theo dia chi IP: khong dem theo ten dang nhap, vi ke tan
 * cong chi can doi ten la reset bo dem.
 * Luu trong bo nho: restart la mat, nhung khoi dong lai app khong phai thao tac
 * ma nguoi ngoai lam duoc.
 */
const SO_LAN_TOI_DA = 8;
const CUA_SO_MS = 15 * 60 * 1000;
const KHOA_MS = 15 * 60 * 1000;

const soLieu = new Map();

function donRac(now) {
  for (const [khoa, muc] of soLieu) {
    if (now > muc.hetHan) soLieu.delete(khoa);
  }
}

export function diaChi(req) {
  // Sau reverse proxy thi IP that nam o X-Forwarded-For; app da bat trust proxy.
  return req.ip || req.socket?.remoteAddress || "khong-ro";
}

/** Con duoc thu khong; neu dang bi khoa thi tra ve so giay con lai. */
export function kiemTra(key) {
  const now = Date.now();
  donRac(now);
  const muc = soLieu.get(key);
  if (!muc) return { choPhep: true };
  if (muc.khoaToi && now < muc.khoaToi) {
    return { choPhep: false, conLaiGiay: Math.ceil((muc.khoaToi - now) / 1000) };
  }
  return { choPhep: true };
}

export function ghiNhanThatBai(key) {
  const now = Date.now();
  const muc = soLieu.get(key);
  if (!muc || now > muc.hetHan) {
    soLieu.set(key, { soLan: 1, hetHan: now + CUA_SO_MS, khoaToi: 0 });
    return { soLanConLai: SO_LAN_TOI_DA - 1 };
  }
  muc.soLan += 1;
  if (muc.soLan >= SO_LAN_TOI_DA) {
    muc.khoaToi = now + KHOA_MS;
    muc.hetHan = muc.khoaToi;
    return { soLanConLai: 0, vuaKhoa: true };
  }
  return { soLanConLai: SO_LAN_TOI_DA - muc.soLan };
}

export function xoa(key) {
  soLieu.delete(key);
}

export const CAU_HINH = { SO_LAN_TOI_DA, KHOA_MS };
