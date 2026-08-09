/**
 * Gom nhieu tin lien tiep cua CUNG MOT NGUOI roi tra loi mot lan.
 *
 * Truoc day gom theo cuoc tro chuyen: trong nhom hai nguoi cung noi thi loi cua
 * ca hai bi gop thanh mot cuc, bot tra loi nhu the mot nguoi vua noi het.
 * Gio khoa la "cuoc tro chuyen + nguoi noi".
 *
 * Va khong chi dem nguoc im lang: neu Zalo con bao nguoi do dang go phim thi
 * cho tiep. Khach ngung 8 giay de nghi cau sau ma bot da nhay vao thi hong ca
 * cau chuyen. Nhung cho co tran, khong ai doi mai duoc.
 */

export const CHO_GOM_MS = 7000;
export const TRAN_CHO_MS = 60000;

export function khoaGom(threadId, senderId) {
  return `${threadId}|${senderId}`;
}

/**
 * @param {object} p
 * @param {number} [p.choMs]     im lang bao lau thi chot
 * @param {number} [p.tranMs]    cho toi da bao lau ke tu tin dau
 * @param {(threadId, senderId) => boolean} p.conDangGo
 * @param {(tins) => void} p.khiChot
 * @param {() => number} [p.bayGio] de kiem thu bom thoi gian gia
 */
export function taoBoGom({ choMs = CHO_GOM_MS, tranMs = TRAN_CHO_MS, conDangGo, khiChot, bayGio = Date.now }) {
  const dang = new Map();

  function them(tin) {
    const khoa = khoaGom(tin.threadId, tin.senderId);
    const muc = dang.get(khoa) || { tins: [], batDau: bayGio() };
    muc.tins.push(tin);
    if (muc.dongHo) clearTimeout(muc.dongHo);

    const chot = () => {
      if (conDangGo(tin.threadId, tin.senderId) && bayGio() - muc.batDau < tranMs) {
        muc.dongHo = setTimeout(chot, choMs);
        return;
      }
      dang.delete(khoa);
      khiChot(muc.tins);
    };

    muc.dongHo = setTimeout(chot, choMs);
    dang.set(khoa, muc);
  }

  return {
    them,
    /** Nguoi nay dang co cua so gom mo san chua. */
    dangMo: (threadId, senderId) => dang.has(khoaGom(threadId, senderId)),
    /** Chi de kiem thu. */
    soCuaSo: () => dang.size,
  };
}
