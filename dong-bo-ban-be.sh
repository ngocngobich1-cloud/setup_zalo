#!/bin/bash
# Day ma nguon sang kho danh cho ban be. MOT CHIEU: tu kho rieng -> kho ban be.
#
# Vi sao khong dung git remote thu hai: lam vay la day ca LICH SU sang. Ai co
# kho ban be cung go duoc mot lenh de moi lai nhung file da xoa - trong do co
# KE-HOACH/ la ke hoach kinh doanh. Nen kho ban be phai la ban chup SACH, chi
# mot commit, khong mang qua khu.
#
# Dung: ./dong-bo-ban-be.sh
set -euo pipefail

KHO_BAN_BE="git@github.com:ngocngobich1-cloud/setup_zalo.git"

# Nhung thu KHONG day sang. Them dong vao day khi co file rieng tu moi.
LOAI_TRU=(
  "KE-HOACH"          # ke hoach kinh doanh cua chi
  "dong-bo-ban-be.sh" # chinh file nay
)

DU_AN="$(cd "$(dirname "$0")" && pwd)"
cd "$DU_AN"

ghi() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
chet() { ghi "LOI: $*"; exit 1; }

git rev-parse --git-dir >/dev/null 2>&1 || chet "Thu muc nay khong phai kho git."
[ -z "$(git status --porcelain)" ] || ghi "Luu y: dang co thay doi chua commit - van day ban tren dia."

TAM="$(mktemp -d)"
trap 'rm -rf "$TAM"' EXIT

ghi "Dang chep ma nguon..."
# Chi chep file GIT DANG THEO DOI. Nho vay .env va data/ khong the lot sang, du
# co ai lo tay - chung nam trong .gitignore nen khong bao gio xuat hien o day.
dem=0
while IFS= read -r f; do
  bo=0
  for x in "${LOAI_TRU[@]}"; do
    case "$f" in "$x"|"$x"/*) bo=1; break;; esac
  done
  [ "$bo" -eq 1 ] && continue
  mkdir -p "$TAM/$(dirname "$f")"
  cp "$f" "$TAM/$f"
  dem=$((dem + 1))
done < <(git ls-files)

ghi "Da chep $dem tep"

for x in "${LOAI_TRU[@]}"; do
  [ -e "$TAM/$x" ] && chet "$x van lot sang - dung lai."
done
[ -e "$TAM/.env" ] && chet ".env lot sang - dung lai."
ghi "Da kiem: khong co tep rieng tu nao lot sang"

cat > "$TAM/README.md" <<'MD'
# Bộ cài Zalo Bot

Mã nguồn để dựng bot Zalo trên máy chủ riêng.

Đây là bản chụp, không có lịch sử phát triển. Hướng dẫn cài đặt nằm ở trang
riêng — hỏi người gửi bạn kho này.

## Cần chuẩn bị trước

- Một máy chủ VPS chạy Ubuntu 24.04
- Một tên miền trỏ về máy chủ đó
- Một API key của nhà cung cấp AI

## Lưu ý

Dự án dùng `zca-js` — thư viện **không chính thức** cho Zalo. Điều khoản của
Zalo không cho phép điều khiển tài khoản cá nhân bằng chương trình, nên tài
khoản có thể bị khoá. Cân nhắc trước khi dùng cho công việc quan trọng.
MD

ghi "Dang day len kho ban be..."
cd "$TAM"
git init -q
git add -A
git -c user.name="setup" -c user.email="setup@local" commit -qm "Ban ma nguon $(date '+%Y-%m-%d')"
git branch -M main
git remote add origin "$KHO_BAN_BE"
git push -q --force origin main

ghi "Xong. Kho ban be gio co dung mot commit, khong mang lich su."
ghi "Kho: $KHO_BAN_BE"
