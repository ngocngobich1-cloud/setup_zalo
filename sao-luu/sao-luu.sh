#!/bin/bash
# Sao luu Zalo Web Chat (VPS Linux).
#
# Cai dat chay tu dong 3 gio sang moi ngay:
#   crontab -e
#   0 3 * * * /duong/dan/zalo-web/sao-luu/sao-luu.sh >> /var/log/zalo-sao-luu.log 2>&1
#
# Day len Google Drive: cai rclone roi chay "rclone config" mot lan,
# dat ten ket noi la "gdrive". Chua cai thi script van chay, chi luu tai cho.
set -euo pipefail

DU_AN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DICH="${SAO_LUU_DICH:-/var/backups/zalo-web}"
CONTAINER="zalo-web-chat"
RCLONE_DICH="${RCLONE_DICH:-gdrive:Sao luu Zalo Web}"

# Luat giu: 30 ban ngay + 12 ban tuan (thu Hai) + 12 ban thang (mung 1).
# Nhin lui duoc ~1 nam ma so file van co han. TRAN_GB la chot chan cuoi: du
# luat tren tinh the nao, tong dung luong khong bao gio duoc vuot qua.
GIU_NGAY=30
GIU_TUAN=12
GIU_THANG=12
TRAN_GB=5
TRAN_GB_DRIVE=3   # Drive mien phi chi co 15 GB va con dung cho viec khac

ghi() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Don ban cu trong mot thu muc theo luat ngay/tuan/thang + tran dung luong.
# Dung "done < <(...)" chu khong "... | while": voi ong dan thi vong lap chay
# trong subshell va bo dem tuan/thang khong con dung sau khi ra khoi vong.
don_ban_cu() {
  local thu_muc="$1" tran_gb="$2"
  local hom_nay so_tuan=0 so_thang=0 cong_don=0 tran da_xoa=0
  [ -d "$thu_muc" ] || return 0
  hom_nay=$(date -d "$(date +%Y-%m-%d)" +%s)
  tran=$((tran_gb * 1024 * 1024 * 1024))

  local f ten ngay tuoi mung_may thu_may kich_thuoc giu
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    ten="$(basename "$f")"
    ngay="$(echo "$ten" | sed -n 's/.*\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\).*/\1/p')"
    [ -n "$ngay" ] || continue

    tuoi=$(( (hom_nay - $(date -d "$ngay" +%s)) / 86400 ))
    mung_may=$(date -d "$ngay" +%d)
    thu_may=$(date -d "$ngay" +%u)   # 1 = thu Hai
    giu=0

    if   [ "$tuoi" -lt "$GIU_NGAY" ]; then giu=1
    elif [ "$mung_may" = "01" ] && [ "$so_thang" -lt "$GIU_THANG" ]; then giu=1; so_thang=$((so_thang + 1))
    elif [ "$thu_may" = "1" ]  && [ "$so_tuan"  -lt "$GIU_TUAN"  ]; then giu=1; so_tuan=$((so_tuan + 1))
    fi

    if [ "$giu" = "1" ]; then
      kich_thuoc=$(stat -c%s "$f")
      if [ $((cong_don + kich_thuoc)) -gt "$tran" ]; then
        giu=0   # cham tran -> bo, va vi dang duyet tu moi den cu nen bo ban cu truoc
      else
        cong_don=$((cong_don + kich_thuoc))
      fi
    fi

    if [ "$giu" = "0" ]; then rm -f "$f"; da_xoa=$((da_xoa + 1)); fi
  done < <(find "$thu_muc" -maxdepth 1 -name 'zalo-web-*.tar.gz' -type f 2>/dev/null | sort -r)

  local con_lai
  con_lai=$(find "$thu_muc" -maxdepth 1 -name 'zalo-web-*.tar.gz' -type f 2>/dev/null | wc -l)
  ghi "Dang giu $con_lai ban ($(( cong_don / 1024 / 1024 )) MB)$([ "$da_xoa" -gt 0 ] && echo ", vua xoa $da_xoa ban cu")"
}

mkdir -p "$DICH"
NHAN="$(date '+%Y-%m-%d-%H%M')"
TAM="$(mktemp -d)"
trap 'rm -rf "$TAM"' EXIT

ghi "Bat dau sao luu"

# 1. Chup CSDL. Chep thang zalo.db khi app dang ghi se bat duoc ban do dang -
#    du lieu moi nhat con nam trong zalo.db-wal. VACUUM INTO gop lai thanh mot
#    file sach, an toan ngay ca luc dang chay.
if docker ps --filter "name=$CONTAINER" --filter "status=running" --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  ghi "Chup CSDL tu container"
  # Dat trong /app chu khong /tmp: import sqlite3 chi tim thay /app/node_modules.
  docker cp "$DU_AN/sao-luu/chup-csdl.js" "$CONTAINER:/app/_chup-csdl.js" >/dev/null
  docker exec "$CONTAINER" node /app/_chup-csdl.js /app/data/zalo.db /app/data/_chup.db >/dev/null
  docker cp "$CONTAINER:/app/data/_chup.db" "$TAM/zalo.db" >/dev/null
  docker exec "$CONTAINER" rm -f /app/data/_chup.db /app/_chup-csdl.js >/dev/null
else
  ghi "Container khong chay - chep thang file CSDL"
  cp "$DU_AN/data/zalo.db" "$TAM/zalo.db"
fi

# 2. Cookie Zalo (da ma hoa)
[ -f "$DU_AN/data/credentials.json" ] && cp "$DU_AN/data/credentials.json" "$TAM/"

# 3. Cau hinh OpenCode - noi giu key API. CHI lay file cau hinh, bo qua
#    node_modules (tai lai duoc) va share (phien tro chuyen, dung xong bo).
if [ -d "$DU_AN/opencode-data/config" ]; then
  mkdir -p "$TAM/opencode-config"
  for f in opencode.jsonc package.json package-lock.json; do
    [ -f "$DU_AN/opencode-data/config/$f" ] && cp "$DU_AN/opencode-data/config/$f" "$TAM/opencode-config/"
  done
fi

# 4. Nen. KHONG kem .env: file do chua khoa ma hoa, de chung thi ai lay duoc
#    ban sao luu la co ca khoa lan du lieu.
FILE="$DICH/zalo-web-$NHAN.tar.gz"
tar -czf "$FILE" -C "$TAM" .
chmod 600 "$FILE"

# 5. Mo thu. Mot ban sao luu chua bao gio mo duoc thi khong phai ban sao luu.
tar -tzf "$FILE" | grep -q "zalo.db" || { ghi "LOI: file nen thieu zalo.db"; exit 1; }
ghi "Xong: $(basename "$FILE") - $(du -h "$FILE" | cut -f1)"

# 6. Don ban cu theo luat ngay/tuan/thang
don_ban_cu "$DICH" "$TRAN_GB"

# 7. Day len Google Drive neu da cai rclone.
#    Dong bo ca thu muc thay vi tu tinh lai luat ben Drive: sau buoc 6 thi thu
#    muc tren may DA dung luat roi, cu chieu y nguyen len la xong.
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q "^gdrive:"; then
  rclone sync "$DICH" "$RCLONE_DICH" --include "zalo-web-*.tar.gz" \
    --max-size "${TRAN_GB_DRIVE}G" --quiet
  ghi "Da dong bo len Google Drive: $RCLONE_DICH"
else
  ghi "CHUA cai rclone - ban sao luu dang nam CUNG tren VPS. VPS chet la mat."
fi
