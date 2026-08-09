# Sao lưu và phục hồi — hướng dẫn cho người dùng

## Mọi thứ đã tự động, chị không cần làm gì hằng ngày

Máy tự sao lưu **12h30 trưa mỗi ngày**. Bản sao lưu nằm ở `D:\zalo-web-sao-luu\`

Nếu 12h30 máy đang tắt, lần sau bật máy lên nó sẽ chạy bù, không bỏ qua ngày đó.

### Giữ lại bao nhiêu bản

| Loại | Số bản | Nhìn lui được |
|---|---|---|
| Mỗi ngày một bản | 30 | 1 tháng gần nhất, từng ngày |
| Bản của thứ Hai hằng tuần | 12 | ~3 tháng |
| Bản của ngày mùng 1 hằng tháng | 12 | ~1 năm |
| **Tổng** | **54 bản** | **~12 tháng** |

Vì sao không giữ tất cả: dữ liệu hỏng mà 3 tuần sau mới phát hiện thì 7 bản là không đủ — nhưng giữ vô hạn thì đến một ngày ổ đầy và cả máy chết mà không ai biết. Ba tầng này cho nhìn lui một năm mà số file vẫn có hạn.

**Chốt chặn cuối: 5 GB.** Dù luật trên tính thế nào, tổng dung lượng không bao giờ vượt quá. Vượt thì bản cũ nhất bị xoá trước.

*(Đã thử với 400 ngày dữ liệu giả: 400 bản 7,8 GB → còn 54 bản 1,05 GB, nhìn lui 12,4 tháng.)*

---

## Bản sao lưu chứa gì

| Thứ | Mất thì sao |
|---|---|
| `zalo.db` | Toàn bộ tin nhắn, hồ sơ khách hàng, Soul, tri thức, tài khoản đăng nhập |
| `credentials.json` | Đăng nhập Zalo — mất thì phải quét lại QR |

## Bản sao lưu KHÔNG chứa gì, và vì sao

**Không chứa `.env`** (khoá mã hoá). Để chung thì ai lấy được bản sao lưu là có
cả khoá lẫn dữ liệu. Xem file **KHOA BI MAT - ZALO WEB.txt** trên desktop.

**Không chứa `opencode.jsonc`** (API key của nhà cung cấp AI). Trước ngày
09/08/2026 bản sao lưu **có** chứa file này — đó là một lỗ hổng: gói sao lưu
không mã hoá, lại còn được đẩy lên Google Drive, nên ai nhặt được một bản là
dùng được key ngay, phát sinh chi phí trên tài khoản của chị.

> **Sau khi phục hồi, chị phải vào tab AI Chat nhập lại API key.**
> Một lần gõ lại key, đổi lấy việc bản sao lưu không còn là miếng mồi.

Nếu chị còn giữ bản sao lưu **cũ** (tạo trước 09/08/2026), trong đó có key —
nên xoá những bản đó đi, kể cả bản trên Google Drive.

Cũng không chứa `node_modules` và cache phiên trò chuyện, vì hai thứ đó tự tạo lại được. Nhờ vậy bản sao lưu chỉ khoảng **0,05 MB** thay vì 58 MB.

---

## Muốn bản sao lưu tự lên Google Drive

Cài **Google Drive cho máy tính** (tải ở `google.com/drive/download`), đăng nhập một lần.

Xong. Script tự phát hiện và từ lần sau sẽ chép lên `Google Drive\Sao luu Zalo Web`. Chị không phải sửa gì cả.

> **Vì sao nên làm:** hiện tại bản sao lưu nằm cùng ổ đĩa D với dữ liệu gốc. Ổ D hỏng là mất cả hai.

---

## Khi cần phục hồi

**Bước 1 — xem bản sao lưu có dùng được không** (không đụng vào dữ liệu đang chạy):

```bash
powershell -ExecutionPolicy Bypass -File "D:\DA test\zalo-web\sao-luu\phuc-hoi.ps1" -ChiKiemTra
```

Nó sẽ in ra số cuộc trò chuyện, số tin nhắn, số hồ sơ khách trong bản sao lưu.

**Bước 2 — phục hồi thật:**

```bash
powershell -ExecutionPolicy Bypass -File "D:\DA test\zalo-web\sao-luu\phuc-hoi.ps1"
```

Dữ liệu hiện tại **không bị xoá** — nó được đổi tên thành `data-truoc-khi-phuc-hoi-<ngày giờ>`. Phục hồi nhầm thì vẫn quay lại được.

Muốn lấy một bản cũ hơn bản mới nhất:

```bash
powershell -ExecutionPolicy Bypass -File "D:\DA test\zalo-web\sao-luu\phuc-hoi.ps1" -TuFile "D:\zalo-web-sao-luu\zalo-web-2026-08-08-1944.zip"
```

---

## Chạy sao lưu ngay lập tức, không đợi 12h30

```bash
powershell -ExecutionPolicy Bypass -File "D:\DA test\zalo-web\sao-luu\sao-luu.ps1"
```

---

## Khi chuyển lên VPS

Dùng `sao-luu.sh` thay cho `sao-luu.ps1`. Cài chạy tự động 3h sáng:

```bash
crontab -e
```

Thêm dòng:

```bash
0 3 * * * /duong/dan/zalo-web/sao-luu/sao-luu.sh >> /var/log/zalo-sao-luu.log 2>&1
```

Để đẩy lên Google Drive từ VPS thì cài `rclone`, chạy `rclone config` một lần và đặt tên kết nối là `gdrive`. Bước này phải tự tay bấm "Cho phép" trong tài khoản Google — không ai làm thay được.

---

## Nhật ký

Mỗi lần chạy đều ghi vào `D:\zalo-web-sao-luu\nhat-ky.txt`. Nghi ngờ sao lưu không chạy thì mở file đó ra xem.
