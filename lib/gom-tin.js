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
export const NHIP_KIEM_MS = 2000;

export function khoaGom(threadId, senderId) {
  return `${threadId}|${senderId}`;
}

/**
 * @param {object} p
 * @param {number} [p.choMs]     im lang bao lau thi chot
 * @param {number} [p.tranMs]    cho toi da bao lau ke tu tin dau
 * @param {number} [p.nhipKiemMs] khi dang cho vi nguoi ta con go, kiem lai moi bay nhieu
 * @param {(threadId, senderId) => boolean} p.conDangGo
 * @param {(tins, originToken) => void} p.khiChot
 * @param {(tin, originToken) => boolean} [p.threadDangBan]
 * @param {(ownerUid, threadId, senderId) => boolean} [p.conDangBan]
 * @param {(threadId, ownerUid) => void} [p.khiHuyTheoThread]
 * @param {() => void} [p.khiHuyTatCa]
 * @param {() => number} [p.bayGio] de kiem thu bom thoi gian gia
 * @param {typeof setTimeout} [p.datHen] de kiem thu bom timer gia
 * @param {typeof clearTimeout} [p.huyHen] de kiem thu bom timer gia
 */
export function taoBoGom({
  choMs = CHO_GOM_MS,
  tranMs = TRAN_CHO_MS,
  nhipKiemMs = NHIP_KIEM_MS,
  conDangGo,
  khiChot,
  threadDangBan = () => false,
  conDangBan = () => false,
  khiHuyTheoThread = () => {},
  khiHuyTatCa = () => {},
  bayGio = Date.now,
  datHen = setTimeout,
  huyHen = clearTimeout,
}) {
  const dang = new Map();

  function them(tin, originToken = null) {
    const khoa = khoaGom(tin.threadId, tin.senderId);
    const mucDangMo = dang.get(khoa);

    // Khi lane owner+thread dang chay, tin moi phai vao pending ngay de stale
    // generation hien tai truoc customer outbound. Khong doi timeout cua duong
    // binh thuong: lane ranh van gom du CHO_GOM_MS nhu cu. Neu cung sender da
    // co bucket mo, phai day CA bucket theo dung thu tu den; day rieng tin moi
    // se de tin cu no timer sau va dao A2 len truoc A1.
    if (threadDangBan(tin, originToken)) {
      if (mucDangMo) {
        if (mucDangMo.dongHo) huyHen(mucDangMo.dongHo);
        mucDangMo.tins.push(tin);
        dang.delete(khoa);
        khiChot(mucDangMo.tins, mucDangMo.originToken);
      } else {
        khiChot([tin], originToken);
      }
      return;
    }

    const muc = mucDangMo || { tins: [], batDau: bayGio(), originToken };
    muc.tins.push(tin);
    if (muc.dongHo) huyHen(muc.dongHo);

    const chot = () => {
      // Dang cho vi nguoi ta con go thi kiem lai day hon choMs: het dau go phim
      // la tra loi ngay, khong ngoi thua them may giay nua.
      if (conDangGo(tin.threadId, tin.senderId) && bayGio() - muc.batDau < tranMs) {
        muc.dongHo = datHen(chot, nhipKiemMs);
        return;
      }
      dang.delete(khoa);
      khiChot(muc.tins, muc.originToken);
    };

    muc.dongHo = datHen(chot, choMs);
    dang.set(khoa, muc);
  }

  function huyTheoThread(threadId, ownerUid = null) {
    let daHuy = 0;
    const prefix = `${String(threadId)}|`;
    for (const [khoa, muc] of dang) {
      if (!khoa.startsWith(prefix)) continue;
      if (muc.dongHo) huyHen(muc.dongHo);
      dang.delete(khoa);
      daHuy += 1;
    }
    khiHuyTheoThread(threadId, ownerUid);
    return daHuy;
  }

  return {
    them,
    /** Huy tat ca sender bucket cua DUNG mot direct/group thread. */
    huyTheoThread,
    /** Huy toan bo cua so khi runtime Zalo hien tai ket thuc. */
    huyTatCa: () => {
      for (const muc of dang.values()) {
        if (muc.dongHo) huyHen(muc.dongHo);
      }
      dang.clear();
      khiHuyTatCa();
    },
    /** Nguoi nay dang co cua so gom mo san chua. */
    dangMo: (threadId, senderId) => dang.has(khoaGom(threadId, senderId)),
    /** Cua so gom HOAC lane active/pending co dung sender nay. */
    dangBan: (ownerUid, threadId, senderId) => (
      dang.has(khoaGom(threadId, senderId))
      || Boolean(conDangBan(ownerUid, threadId, senderId))
    ),
    /** Chi de kiem thu. */
    soCuaSo: () => dang.size,
  };
}
