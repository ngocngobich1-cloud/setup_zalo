# Zalo Web

Ứng dụng chat Zalo chạy trên máy của bạn: xem hội thoại, lưu lịch sử tin nhắn, và một trợ lý tự trả lời khách khi bạn bật lên.

Toàn bộ dữ liệu nằm trên máy bạn. Không có máy chủ trung gian nào giữ tin nhắn của bạn.

---

## Cài nhanh trên MacBook

Hướng dẫn này viết cho người chưa từng dùng Terminal. Cứ làm lần lượt từng bước.

Bạn **không cần** cài Node.js, npm, sqlite3 hay bất cứ công cụ lập trình nào. Docker lo hết phần đó.

### Bước 1 — Cài Docker Desktop

1. Vào <https://www.docker.com/products/docker-desktop/>
2. Bấm nút tải cho máy Mac. Trang web thường có hai nút:
   - **Apple Silicon** — nếu máy bạn là M1, M2, M3, M4 hoặc mới hơn
   - **Intel Chip** — nếu máy bạn là MacBook đời cũ dùng chip Intel

   Không chắc máy mình loại nào? Bấm biểu tượng  ở góc trên bên trái → **About This Mac**. Dòng **Chip** ghi "Apple M…" là Apple Silicon; ghi "Intel" là Intel.
3. Mở file vừa tải, kéo **Docker** vào thư mục **Applications**.
4. Mở **Docker Desktop** từ Launchpad. Lần đầu nó sẽ hỏi mật khẩu máy — đó là bình thường.
5. **Chờ đến khi biểu tượng con cá voi trên thanh menu ngừng động và Docker báo "Running".**

> Bước 5 quan trọng. Docker chưa sẵn sàng thì các lệnh ở dưới sẽ báo lỗi.

### Bước 2 — Tải Zalo Web về máy

**Cách dễ nhất:**

1. Mở trang GitHub của dự án: `https://github.com/ngocngobich1-cloud/setup_zalo`
2. Bấm nút xanh **Code** → **Download ZIP**
3. Mở file ZIP vừa tải (thường nằm trong thư mục **Downloads**). macOS sẽ tự giải nén ra một thư mục.
4. Kéo thư mục đó vào chỗ bạn muốn giữ lâu dài, ví dụ thư mục **Documents**.

**Nếu bạn đã biết dùng Git:**

```bash
git clone https://github.com/ngocngobich1-cloud/setup_zalo
```

### Bước 3 — Mở Terminal ngay tại thư mục Zalo Web

1. Mở **Finder**, đi tới thư mục Zalo Web vừa giải nén.
2. Bấm chuột phải vào thư mục đó → **Services** → **New Terminal at Folder**.

Không thấy mục đó? Bật lên một lần: **System Settings** → **Keyboard** → **Keyboard Shortcuts** → **Services** → **Files and Folders** → tick **New Terminal at Folder**.

**Cách khác luôn dùng được:** mở **Terminal** (Launchpad → gõ "Terminal"), gõ `cd ` (có dấu cách ở cuối), rồi **kéo thả thư mục Zalo Web từ Finder vào cửa sổ Terminal**. Đường dẫn sẽ tự điền vào. Bấm Enter.

### Bước 4 — Khởi động ứng dụng

Trong Terminal, gõ đúng dòng này rồi bấm Enter:

```bash
docker compose up -d --build zalo-web
```

**Lần đầu chạy sẽ mất vài phút** — Docker phải tải và dựng mọi thứ. Màn hình sẽ trôi rất nhiều dòng chữ, đó là bình thường. Cứ để yên cho tới khi Terminal hiện lại dấu nhắc và bạn gõ được tiếp.

Những lần sau sẽ nhanh hơn nhiều.

### Bước 5 — Mở ứng dụng

Mở trình duyệt và vào:

**<http://localhost:3790>**

### Bước 6 — Đăng nhập lần đầu

```
Tên đăng nhập:  admin
Mật khẩu:       admin
```

Đây **chỉ là mật khẩu cho lần đăng nhập đầu tiên**, không phải mật khẩu thật của bạn.

### Bước 7 — Đổi mật khẩu

Ngay sau khi đăng nhập, ứng dụng sẽ hiện màn hình **Đổi mật khẩu**. Bạn không vào được ứng dụng cho tới khi đổi xong — đây là cố ý.

- Mật khẩu mới phải **từ 6 ký tự trở lên**
- Không được đặt lại chính chữ `admin`
- Nhập lại lần thứ hai cho khớp

Đổi xong, `admin/admin` **không còn dùng được nữa**. Hãy ghi mật khẩu mới vào chỗ an toàn — không có cách tự lấy lại.

### Bước 8 — Kết nối Zalo

1. Ứng dụng mở ra ở phân hệ **Chat Zalo**.
2. Bấm nút **LOGIN**.
3. Một **mã QR** hiện ra.
4. Mở app **Zalo trên điện thoại** → quét mã QR đó → xác nhận trên điện thoại.
5. Vài giây sau, danh sách hội thoại sẽ hiện lên.

Xong. Ứng dụng đã sẵn sàng.

---

## Mở lại ứng dụng vào lần sau

Mỗi lần bật máy, **Docker Desktop phải đang chạy** trước đã.

Mở Terminal tại thư mục Zalo Web (như Bước 3) rồi gõ:

```bash
docker compose up -d zalo-web
```

Lần này **không có** `--build` nên chạy rất nhanh.

Rồi vào lại <http://localhost:3790>.

> Chỉ cần thêm `--build` khi bạn vừa cập nhật mã nguồn mới (xem mục *Cập nhật phiên bản*).

---

## Dừng ứng dụng

```bash
docker compose stop zalo-web
```

Lệnh này chỉ tạm dừng. **Dữ liệu của bạn vẫn còn nguyên.** Lần sau khởi động lại là dùng tiếp được.

---

## Dữ liệu của bạn nằm ở đâu

Tất cả nằm trong thư mục **`data/`** ngay bên trong thư mục Zalo Web:

| File | Chứa gì |
|---|---|
| `data/zalo.db` | Lịch sử tin nhắn, hội thoại, hồ sơ khách, cấu hình |
| `data/credentials.json` | Thông tin đăng nhập Zalo (đã mã hoá) |
| `data/.secret-key` | Khoá mã hoá |

> ⚠️ **Đừng xoá thư mục `data/`.** Xoá là mất sạch lịch sử tin nhắn, cấu hình, và phải quét lại mã QR Zalo từ đầu.

---

## Sao lưu dữ liệu

Cách đơn giản và an toàn nhất cho máy Mac:

1. Dừng ứng dụng trước cho dữ liệu ở trạng thái tĩnh:

   ```bash
   docker compose stop zalo-web
   ```

2. Trong Finder, copy thư mục **`data/`** sang chỗ khác — ổ cứng ngoài, iCloud Drive, hoặc Google Drive. Đặt tên kèm ngày cho dễ tìm, ví dụ `data-2026-08-23`.

3. Bật lại ứng dụng:

   ```bash
   docker compose up -d zalo-web
   ```

Nên làm định kỳ — mỗi tuần một lần là hợp lý.

> Trong thư mục `sao-luu/` có sẵn vài script sao lưu tự động, nhưng chúng viết cho **máy chủ Linux và máy Windows**, chưa được kiểm chứng trên macOS. Người dùng Mac cứ copy tay như trên là chắc chắn nhất.

---

## Cập nhật phiên bản

1. **Sao lưu `data/` trước** (xem mục trên).
2. Tải bản mới từ GitHub về, giải nén ra một thư mục **mới**.
3. Copy thư mục **`data/`** từ bản cũ sang đè vào bản mới.
4. Mở Terminal tại thư mục mới rồi chạy:

   ```bash
   docker compose up -d --build zalo-web
   ```

> ⚠️ Điểm quan trọng duy nhất: **giữ lại `data/`**. Mã nguồn thì thay mới thoải mái, còn `data/` là toàn bộ tin nhắn và cấu hình của bạn.
>
> *(Nâng cao — hãy tự kiểm tra trước khi dùng: nếu bạn cài bằng `git clone`, có thể cập nhật bằng `git pull` rồi build lại. `data/` không nằm trong Git nên không bị đụng tới.)*

---

## Xử lý lỗi thường gặp

**Terminal báo không kết nối được Docker**

Docker Desktop chưa chạy. Mở Docker Desktop từ Launchpad, chờ tới khi báo "Running", rồi gõ lại lệnh.

**Lệnh báo cổng 3790 đang bị chiếm (`port is already allocated`)**

Có ứng dụng khác đang dùng cổng 3790, hoặc Zalo Web đã chạy sẵn rồi. Thử mở <http://localhost:3790> trước — có khi nó đang chạy. Nếu vẫn lỗi, tắt ứng dụng kia rồi thử lại.

**Lần đầu chạy mà mở trang không lên**

Bước build lần đầu mất vài phút. Chờ tới khi Terminal gõ tiếp được, rồi tải lại trang.

**Bấm LOGIN mà mã QR không hiện**

Chờ thêm chục giây rồi tải lại trang một lần. Ứng dụng cần một lúc để sẵn sàng sau khi khởi động.

**Quên mật khẩu**

Không có chức năng tự lấy lại. Hãy giữ mật khẩu ở nơi an toàn.

---

## Ghi chú kỹ thuật

- Ứng dụng chạy ở **<http://localhost:3790>** và chỉ mở cho **chính máy bạn** — máy khác trong cùng mạng không vào được.
- `admin/admin` chỉ dùng cho lần đăng nhập đầu tiên và bị bắt đổi ngay. Đừng để nguyên.
- Hướng dẫn này cố ý **chỉ khởi động dịch vụ `zalo-web`**. Trong dự án còn một dịch vụ `caddy` dùng khi đưa lên máy chủ có tên miền thật — dùng ở nhà thì không cần, nên không bật.
- Muốn xem app đang chạy hay không: `docker compose ps`
- Muốn xem nhật ký khi có trục trặc: `docker compose logs zalo-web`
