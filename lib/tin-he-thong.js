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

export function laTinHeThong(message) {
  const loai = String(message?.msgType || "");
  if (TIEN_TO_SU_KIEN.some((t) => loai.startsWith(t))) return true;

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
