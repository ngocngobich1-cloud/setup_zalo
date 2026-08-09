import { capNhatLichHen, layLichDenHan } from "./db.js";
import { addLog } from "./activity-log.js";

/**
 * Dong ho canh gio cho so hen.
 *
 * Day KHONG phai bo hoi Zalo nhu cai da bi xoa: no chi doc mot bang trong CSDL
 * ngay tren may, khong goi mang, khong goi Zalo. Cham 30 giay mot lan la du cho
 * do chinh xac theo phut ma khong ton gi.
 */
const NHIP_MS = 30 * 1000;

/**
 * Tre qua nguong nay thi KHONG gui nua.
 * Ly do: nhac khach vao Zoom tre 3 tieng thi vo nghia, con gay kho hieu. Gui roi
 * la khong rut lai duoc, nen tha bo va bao cho chi biet.
 */
export const NGUONG_TRE_GIAY = 30 * 60;

let dongHo = null;
let dangChay = false;

/** Ham gui tin, truyen tu zalo-service vao de tranh vong import. */
let guiTin = null;
/** Ham bao cho admin biet, truyen tu ngoai vao. */
let baoAdmin = null;

export function capHinhScheduler({ gui, thongBaoAdmin }) {
  guiTin = gui;
  baoAdmin = thongBaoAdmin;
}

const MOT_NGAY = 24 * 60 * 60;
const MOT_TUAN = 7 * MOT_NGAY;

/**
 * Moc ke tiep cua lich lap. Viet Nam khong doi gio mua he nen cong thang so
 * giay la chinh xac, khong so lech mot tieng nhu cac nuoc co DST.
 * Neu app tat may ngay thi cong don cho toi khi vuot qua hien tai.
 */
export function mocKeTiep(lucGui, lapLai, bayGioGiay) {
  const buoc = lapLai === "hang_ngay" ? MOT_NGAY : lapLai === "hang_tuan" ? MOT_TUAN : 0;
  if (!buoc) return null;
  let moc = Number(lucGui) + buoc;
  while (moc <= bayGioGiay) moc += buoc;
  return moc;
}

function doDai(giay) {
  const phut = Math.round(giay / 60);
  if (phut < 60) return `${phut} phút`;
  const gio = Math.floor(phut / 60);
  return `${gio} tiếng ${phut % 60} phút`;
}

export function dinhDangGio(giay) {
  return new Date(Number(giay) * 1000).toLocaleString("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function chayMotVong() {
  if (dangChay) return; // vong truoc con dang gui, khong chong len nhau
  dangChay = true;
  try {
    const bayGio = Math.floor(Date.now() / 1000);
    const denHan = await layLichDenHan(bayGio);

    for (const lich of denHan) {
      const tre = bayGio - lich.lucGui;

      // Tre qua nguong -> bo, bao chi biet. Van tinh moc ke tiep neu la lich lap,
      // khong thi mot lan lo se giet luon ca chuoi lich hang tuan.
      if (tre > NGUONG_TRE_GIAY) {
        const ke = mocKeTiep(lich.lucGui, lich.lapLai, bayGio);
        await capNhatLichHen(lich.id, {
          trangThai: ke ? "cho" : "bo_qua",
          lucGui: ke ?? null,
          ghiChu: `Lỡ giờ ${doDai(tre)} — không gửi`,
        });
        await addLog({
          event: "lich_bo_qua",
          level: "warn",
          summary: `Lỡ lịch #${lich.id} gửi "${lich.dichTen}" — trễ ${doDai(tre)}, không gửi nữa`,
          detail: { id: lich.id, dichTen: lich.dichTen, treGiay: tre, noiDung: lich.noiDung },
        }).catch(() => {});
        await baoAdmin?.(
          `Em LỠ một lịch hẹn ạ:\n\n` +
            `「${lich.dichTen}」 lúc ${dinhDangGio(lich.lucGui)}\n` +
            `"${lich.noiDung}"\n\n` +
            `Trễ mất ${doDai(tre)} nên em không gửi nữa, sợ gửi muộn lại kỳ.` +
            (ke ? `\nLần kế tiếp: ${dinhDangGio(ke)}` : "")
        ).catch(() => {});
        continue;
      }

      try {
        await guiTin({
          threadId: lich.dichId,
          threadType: lich.loai === "nhom" ? 1 : 0,
          text: lich.noiDung,
          urgency: lich.khan || 0,
        });

        const ke = mocKeTiep(lich.lucGui, lich.lapLai, bayGio);
        await capNhatLichHen(lich.id, {
          trangThai: ke ? "cho" : "da_gui",
          guiLuc: bayGio,
          lucGui: ke ?? null,
          ghiChu: ke ? `Đã gửi, lần kế tiếp ${dinhDangGio(ke)}` : "",
        });
        await addLog({
          event: "lich_da_gui",
          level: "ok",
          summary: `Đã gửi lịch hẹn #${lich.id} vào "${lich.dichTen}"`,
          detail: {
            id: lich.id,
            dichTen: lich.dichTen,
            noiDung: lich.noiDung,
            treGiay: tre,
            lapLai: lich.lapLai || "(một lần)",
            keTiep: ke ? dinhDangGio(ke) : null,
          },
        }).catch(() => {});
      } catch (error) {
        // Gui hong thi KHONG thu lai vo han: co the la nhom da giai tan hoac bi
        // chan. Danh dau loi va bao chi, de chi quyet dinh.
        await capNhatLichHen(lich.id, {
          trangThai: "loi",
          ghiChu: error.message,
        });
        await addLog({
          event: "lich_loi",
          level: "error",
          summary: `Không gửi được lịch hẹn #${lich.id} vào "${lich.dichTen}" — ${error.message}`,
          detail: { id: lich.id, dichTen: lich.dichTen, error: error.message },
        }).catch(() => {});
        await baoAdmin?.(
          `Em không gửi được lịch hẹn vào 「${lich.dichTen}」 ạ:\n${error.message}`
        ).catch(() => {});
      }
    }
  } catch (error) {
    console.warn("[lich-hen] Loi vong quet:", error.message);
  } finally {
    dangChay = false;
  }
}

export function batDauScheduler() {
  if (dongHo) clearInterval(dongHo);
  dongHo = setInterval(chayMotVong, NHIP_MS);
  // Quet ngay mot lan luc khoi dong: app vua tat mot lat co the da lo vai lich.
  chayMotVong().catch(() => {});
  console.log("[lich-hen] Da bat dong ho canh gio (30 giay/lan)");
}

export function dungScheduler() {
  if (dongHo) clearInterval(dongHo);
  dongHo = null;
}

/** Cho phep goi quet ngay, dung khi kiem thu. */
export async function quetNgay() {
  await chayMotVong();
}
