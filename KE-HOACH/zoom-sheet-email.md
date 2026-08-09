# Kế hoạch TREO — Zoom + Google Sheet + Email lịch học

> **Trạng thái: TREO, chưa thi công.** Ghi lại ngày 09/08/2026 để sau này lấy ra
> làm tiếp mà không phải bàn lại từ đầu. Chưa có dòng code nào cho việc này.

## Mục tiêu

Sáng thứ 6 hàng tuần, bot tự tạo phòng Zoom rồi gửi email link học cho các học
viên còn hạn trong bảng Sheet. Sau buổi học, bot lấy báo cáo về để điểm danh.

Bảng Sheet học viên đóng hai vai: nguồn dữ liệu duyệt người vào nhóm Zalo, và
danh sách nhận email lịch học.

## Bốn điều đã chốt

| | Quyết định | Vì sao |
|---|---|---|
| 1 | **Đăng ký trước**, không dùng phòng chờ | Zoom KHÔNG có API duyệt phòng chờ — bot chỉ nhìn được, không bấm cho vào được. Đăng ký trước thì bot làm được hết, mỗi người một link riêng |
| 2 | **Link mới mỗi tuần** | Tránh học lậu. Đổi lại mỗi tuần phải đăng ký lại ~100 người |
| 3 | **Điểm danh sau buổi học** | Gọi báo cáo Zoom, đơn giản hơn theo dõi thời gian thực. Không cần bot nhắc lúc đang dạy |
| 4 | **Điểm danh lưu trong app** | Giữ quyền Google Sheet ở mức CHỈ ĐỌC. Sheet là nơi chị nhập tay, bot không đụng vào |

## Luồng chạy

```
Thứ 6 hàng tuần, 7h sáng
   Tạo phòng Zoom mới — 3 tiếng, bật đăng ký trước
   Đọc Sheet, lọc học viên còn hạn
   Đăng ký từng người → Zoom trả link riêng
   Gửi email, mỗi người nhận link của chính mình
   Nhắn Zalo báo admin: gửi được bao nhiêu, lỗi ai

Sau buổi học
   Lấy báo cáo Zoom, đối chiếu Sheet
   Lưu điểm danh vào app
   Nhắn Zalo tóm tắt: đủ / muộn / vắng
```

## Kế hoạch 5 đợt

- **Đợt A** — Dựng module "Công cụ & Kết nối". Khung chung, mỗi công cụ một tệp
  cùng khuôn. Thẻ trạng thái, nút Kiểm tra ngay, nút Ngắt. Bí mật mã hoá bằng
  `lib/crypto-box.js`. Mỗi sáng tự dò, hỏng thì nhắn Zalo.
  **Không đụng vào Zoho đang chạy** — chuyển sang cuối cùng.
- **Đợt B** — Nối Google Sheet, chỉ đọc. Có nút "Đọc thử" hiện 5 dòng đầu.
- **Đợt C** — Nối Zoom, tạo phòng, đăng ký học viên.
  **Bắt đầu bằng thử thật với 1 người** trước khi mở ra 100.
- **Đợt D** — Gmail + gửi hàng loạt + nối vào `lib/scheduler.js`.
  Có nút "Chạy thử ngay", không phải chờ tới thứ 6.
- **Đợt E** — Điểm danh: lấy báo cáo, đối chiếu, màn hình xem, xuất Excel.

## Cấu trúc bảng Sheet đã thống nhất

Dòng 1 là tiêu đề, mỗi dòng một học viên, không gộp ô.

| Tên cột | Ghi kiểu gì | Dùng để |
|---|---|---|
| `Mã HV` | `HV001`, không trùng, **không bao giờ sửa** | Khoá đối chiếu |
| `Họ tên` | | Xưng hô trong email |
| `SĐT` | `0901234567` | Dò ra Zalo để duyệt vào nhóm |
| `Email` | | Gửi lịch học |
| `Lớp` | K12, K13… | Lọc khi có nhiều lớp |
| `Ngày bắt đầu` | `dd/mm/yyyy` | |
| `Hạn đến` | `dd/mm/yyyy` | Lọc "còn hạn" |
| `Trạng thái` | `Đang học` / `Tạm dừng` / `Đã nghỉ` | Chặn tay |
| `Ghi chú` | | Bot không đọc |

Cột ngày phải đặt định dạng Văn bản thuần, không để Sheet tự đổi.

**"Còn hạn" = `Hạn đến` chưa qua VÀ `Trạng thái` = `Đang học`.**

## Bốn thứ cần chuẩn bị trước khi thi công

| | Việc | Chặn đợt |
|---|---|---|
| 1 | Tài khoản dịch vụ Google Cloud + chia sẻ Sheet quyền **Người xem** | B |
| 2 | Tạo Sheet đúng 9 cột trên | B |
| 3 | App Server-to-Server OAuth trên Zoom Marketplace | C |
| 4 | Mật khẩu ứng dụng của Gmail (cần bật xác minh 2 bước) | D |

Đợt A không cần chuẩn bị gì, làm được ngay.

## Những gì đã tra được về Zoom

- **Server-to-Server OAuth**: 3 thứ — Account ID, Client ID, Client Secret.
  Lấy vé: `POST https://zoom.us/oauth/token`, `grant_type=account_credentials`,
  header Basic auth. Vé sống 1 tiếng, **không có refresh token** → hết thì xin
  vé mới. Không bao giờ đứt kết nối phải nối lại như Zoho.
  Scope cần: `meeting:write:admin`.
- **Phòng chờ**: KHÔNG có API duyệt. Xin từ 2020 tới nay chưa có.
  Chỉ có tín hiệu báo ai đang chờ, không bấm cho vào được.
- **Mật khẩu phòng**: tối đa **10 ký tự**, chỉ `a-z A-Z 0-9 @ - _ *`.
- **Giới hạn gọi API**: tạo/sửa phòng 100 lần/ngày/người. Mình cần 1 lần/tuần.
- **Báo cáo người tham dự** (`/report/meetings/{id}/participants`): cần tài
  khoản **trả phí** (Pro trở lên). Tài khoản của chị đã trả phí.
- **Gói miễn phí** cắt cuộc họp 3 người trở lên ở 40 phút — không dùng được cho
  lớp 3 tiếng. Đây là lý do phải dùng bản trả phí.
- **Email trong tín hiệu người vào/ra** chỉ có nếu người đó đăng nhập Zoom.
  Dùng đăng ký trước thì hết vấn đề này vì danh tính gắn với link.

## Về Gmail

- **Dùng mật khẩu ứng dụng + SMTP** (app đã có sẵn `lib/email-sender.js`).
- **KHÔNG dùng Gmail API** cho Gmail cá nhân: ứng dụng chưa được Google kiểm
  duyệt thì chìa khoá **hết hạn sau 7 ngày**, tuần nào cũng phải cấp quyền lại.
- Tài khoản dịch vụ Google **không gửi được** email thay Gmail cá nhân — chỉ
  Workspace có tên miền riêng mới làm được. Đọc Sheet và gửi Gmail là hai thứ
  hoàn toàn tách rời.
- Còn để ngỏ: dùng Gmail cá nhân hay dùng Zoho đã nối sẵn cho chuyên nghiệp hơn.

## Bốn rủi ro đã nêu với chị

1. **Email rơi vào hộp thư rác** — 100 thư một lúc từ Gmail cá nhân dễ bị nghi.
   Giảm bằng gửi rải. Lưới đỡ: bot đăng thêm lên nhóm Zalo "ai chưa nhận nhắn
   Vizen".
2. **Link riêng không phải cái khoá** — học viên vẫn đưa link của mình cho người
   khác được. Nhìn báo cáo thì phát hiện, nhưng không chặn trước được.
3. **Học viên đóng tiền giữa tuần** — cần nút "Đăng ký bổ sung".
4. **Chi tiết đăng ký của Zoom chưa chắc 100%** — diễn đàn nhắc vài chỗ lắt léo.
   Đợt C phải thử thật trước, hỏng thì báo và bàn lại, không tự đi đường vòng.

## Nguồn đã đọc

- https://developers.zoom.us/docs/internal-apps/s2s-oauth/
- https://developers.zoom.us/docs/internal-apps/create/
- https://developers.zoom.us/docs/api/rate-limits/
- https://developers.zoom.us/docs/api/meetings/events/
- https://devforum.zoom.us/t/manage-waiting-room-via-api/91451
- https://devforum.zoom.us/t/join-url-for-meeting-registrant/390
- https://devforum.zoom.us/t/meeting-reports-api-for-free-accounts/16006
- https://devforum.zoom.us/t/available-oauth-scopes-for-basic-account/80288
