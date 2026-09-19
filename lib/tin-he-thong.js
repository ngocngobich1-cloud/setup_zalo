/**
 * Phan biet TIN NGUOI NOI voi SU KIEN HE THONG.
 *
 * Zalo day su kien nhom vao cung mot duong voi tin nhan: ai do bo phieu, ai do
 * vao nhom, ai do doi ten nhom... App dich chung thanh cau tieng Viet de hien
 * cho de doc ("Do Thu Thuy tham gia cuoc binh chon: ..."), roi chinh cau do bi
 * nem cho bot nhu mot cau hoi cua khach.
 *
 * Hau qua that: mot hoc vien bam bo phieu, bot lien nhay vao giang mot bai ve
 * nghi ngoi. Khong ai hoi no ca. Trong nhom lop 30 nguoi thi moi lan bo phieu
 * la mot lan bot noi chen vao.
 */

/** Cac loai tin la SU KIEN nhom, khong phai loi nguoi noi. */
const TIEN_TO_SU_KIEN = ["group.", "event."];

/**
 * Khach bam "dong y ket ban": Zalo day ve mot action-list KHONG co href trong
 * chat RIENG. Luoi thu hai o duoi bat trung dung hinh dang do, nen loi chao dau
 * tien cua mot khach moi bi nem vao thung su kien - bot im, khong ai biet.
 *
 * Ngoai le nay phai HEP: doc dung duong raw cua provider, sai mot dieu kien la
 * roi xuong dung luoi cu, khong doi gi khac.
 */
const AT_KET_BAN = 7;
const MAU_KET_BAN_VI = "đã đồng ý kết bạn";
const MAU_KET_BAN_EN = "is now your friend";

const khopMauKetBan = (chuoi, mau) =>
  typeof chuoi === "string" && chuoi.trim().toLowerCase().includes(mau);

function laKetBanKhongCoHref(message) {
  if (message?.threadType !== 0) return false;

  const data = message?.rawJson?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (data.at !== AT_KET_BAN) return false;

  const content = data.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  if (content.action !== "msginfo.actionlist") return false;
  // CHI hai gia tri nay moi la "khong co href". null/false/0/khoang trang thi
  // khong - nen khong duoc viet gon thanh !content.href.
  if (content.href !== undefined && content.href !== "") return false;
  if (typeof content.params !== "string") return false;

  let thamSo;
  try {
    thamSo = JSON.parse(content.params);
  } catch {
    return false;
  }
  if (!thamSo || typeof thamSo !== "object" || Array.isArray(thamSo)) return false;
  if (!Array.isArray(thamSo.simpleInfos) || thamSo.simpleInfos.length === 0) return false;

  // Chi kiem HINH DANG cua simpleInfos, khong doc uid/ten/avatar ben trong.
  const mau = thamSo.msg;
  if (!mau || typeof mau !== "object" || Array.isArray(mau)) return false;
  return khopMauKetBan(mau.vi, MAU_KET_BAN_VI) || khopMauKetBan(mau.en, MAU_KET_BAN_EN);
}

export function laTinHeThong(message) {
  const loai = String(message?.msgType || "");
  if (TIEN_TO_SU_KIEN.some((t) => loai.startsWith(t))) return true;
  if (loai === "chat.recommended") return true;

  // Ngoai le hep, dat TRUOC luoi thu hai vi no chinh la cai bat nham.
  if (laKetBanKhongCoHref(message)) {
    const data = message.rawJson.data;
    console.info("[tin-he-thong] friend_accept_exception", {
      threadType: message.threadType,
      at: data.at,
    });
    return false;
  }

  // Luoi thu hai: bat theo HINH DANG, de Zalo them loai su kien moi thi cung
  // tu dong bi chan ma khong phai cap nhat danh sach tien to o tren.
  //
  // Do tren du lieu that trong may:
  //    group.poll   action = "create"   khong co href   <- su kien
  //    chat.photo   action = ""         CO href         <- anh khach gui
  //    share.file   action = ""         CO href         <- file khach gui
  // Anh va file CUNG co truong action/params, nen chi kiem "co action" thoi la
  // chan nham ca anh khach gui - hong luon tinh nang doc anh/PDF.
  // Dau hieu that: action KHAC RONG, va khong co duong dan tai tep.
  const noiDung = message?.rawJson?.data?.content ?? message?.rawJson?.content;
  if (
    noiDung &&
    typeof noiDung === "object" &&
    typeof noiDung.action === "string" &&
    noiDung.action.trim() !== "" &&
    typeof noiDung.params === "string" &&
    !noiDung.href
  ) {
    return true;
  }

  return false;
}

/** Chi de ghi vao nhat ky cho de doc. */
export function moTaSuKien(message) {
  const loai = String(message?.msgType || "");
  return (
    {
      "group.poll": "có người bình chọn",
      "group.join": "có người vào nhóm",
      "group.leave": "có người rời nhóm",
      "group.updateinfo": "nhóm đổi thông tin",
      "group.addmember": "thêm thành viên",
      "group.removemember": "bớt thành viên",
    }[loai] || `sự kiện nhóm (${loai || "không rõ"})`
  );
}
