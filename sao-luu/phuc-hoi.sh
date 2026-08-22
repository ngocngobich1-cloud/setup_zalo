#!/bin/sh
# Phuc hoi ban sao luu tren Linux (VPS).
#
# Ban Windows la phuc-hoi.ps1, chi nhan .zip. VPS thi sao-luu.sh tao .tar.gz,
# nen truoc day co ban sao luu ma khong co duong phuc hoi - coi nhu khong co
# ban sao luu. File nay lap cho trong do.
#
# Dung:
#   ./phuc-hoi.sh /duong/dan/zalo-web-....tar.gz            # phuc hoi that
#   ./phuc-hoi.sh /duong/dan/zalo-web-....tar.gz --chi-kiem  # chi kiem tra
#
# Che do --chi-kiem KHONG dung toi du lieu dang chay. Dung de dien tap.
set -eu

DU_AN="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="zalo-web-chat"
GOI="${1:-}"
CHI_KIEM="${2:-}"

ghi() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
chet() { ghi "LOI: $*"; exit 1; }

[ -n "$GOI" ] || chet "Thieu duong dan goi sao luu. Vi du: ./phuc-hoi.sh /duong/dan/zalo-web-2026-08-09.tar.gz"
[ -f "$GOI" ] || chet "Khong thay file: $GOI"

TAM="$(mktemp -d)"
trap 'rm -rf "$TAM"' EXIT

ghi "Dang mo goi: $(basename "$GOI")"
# Nhan ca hai dinh dang: .tar.gz do sao-luu.sh (VPS) tao, va .zip do sao-luu.ps1
# (may Windows) tao. Chuyen tu may nha len VPS thi goi la .zip.
case "$GOI" in
  *.zip)
    command -v unzip >/dev/null 2>&1 || chet "Chua co unzip. Cai bang: apt install -y unzip"
    unzip -q "$GOI" -d "$TAM" || chet "Khong giai nen duoc .zip. Goi co the bi hong."
    ;;
  *)
    tar -xzf "$GOI" -C "$TAM" || chet "Khong giai nen duoc .tar.gz. Goi co the bi hong."
    ;;
esac

DB="$TAM/zalo.db"
[ -f "$DB" ] || chet "Trong goi khong co zalo.db - day khong phai ban sao luu hop le."

# ---------- KIEM TRA ----------
# Chay trong container vi sqlite3 va crypto-box nam o do. Cung la cach dam bao
# kiem bang DUNG khoa APP_SECRET_KEY ma app dang dung, chu khong phai khoa khac.
docker ps --filter "name=$CONTAINER" --filter "status=running" --format '{{.Names}}' \
  | grep -q "^${CONTAINER}$" || chet "Container $CONTAINER chua chay. Bat len truoc: docker compose up -d"

ghi "Kiem tra 1/2 - CSDL con nguyen ven khong"
docker cp "$DB" "$CONTAINER:/tmp/kiem-tra.db" >/dev/null
docker cp "$DU_AN/sao-luu/kiem-tra-csdl.js" "$CONTAINER:/app/_kiem-tra.js" >/dev/null
if ! docker exec "$CONTAINER" node /app/_kiem-tra.js /tmp/kiem-tra.db; then
  docker exec "$CONTAINER" rm -f /tmp/kiem-tra.db /app/_kiem-tra.js >/dev/null 2>&1 || true
  chet "CSDL trong ban sao luu bi hong."
fi

# Buoc nay moi la buoc that su chung minh ban sao luu dung duoc. CSDL nguyen ven
# ma khoa khong khop thi phuc hoi xong van phai quet lai QR, nhap lai Zoho.
ghi "Kiem tra 2/2 - co giai ma duoc bi mat trong do khong"
docker cp "$DU_AN/sao-luu/kiem-tra-giai-ma.js" "$CONTAINER:/app/sao-luu-kiem-tra-giai-ma.js" >/dev/null
docker exec "$CONTAINER" mkdir -p /app/sao-luu >/dev/null 2>&1 || true
docker cp "$DU_AN/sao-luu/kiem-tra-giai-ma.js" "$CONTAINER:/app/sao-luu/kiem-tra-giai-ma.js" >/dev/null
GIAI_MA_OK=1
docker exec "$CONTAINER" node /app/sao-luu/kiem-tra-giai-ma.js /tmp/kiem-tra.db || GIAI_MA_OK=0

docker exec "$CONTAINER" rm -f /tmp/kiem-tra.db /app/_kiem-tra.js \
  /app/sao-luu/kiem-tra-giai-ma.js /app/sao-luu-kiem-tra-giai-ma.js >/dev/null 2>&1 || true

[ -f "$TAM/credentials.json" ] \
  && ghi "  credentials.json (dang nhap Zalo): co" \
  || ghi "  credentials.json (dang nhap Zalo): KHONG CO - se phai quet lai QR"

if [ "$GIAI_MA_OK" -eq 0 ]; then
  ghi ""
  ghi "CANH BAO: khoa hien tai khong mo duoc du lieu trong ban sao luu nay."
  ghi "Phuc hoi van chay duoc, nhung se phai quet lai QR Zalo va nhap lai Zoho/SMTP."
fi

if [ "$CHI_KIEM" = "--chi-kiem" ]; then
  ghi ""
  ghi "Che do chi kiem tra - KHONG dung toi du lieu that."
  [ "$GIAI_MA_OK" -eq 1 ] && ghi "Ban sao luu nay dung duoc." || ghi "Ban sao luu nay dung duoc mot phan."
  exit 0
fi

# ---------- PHUC HOI THAT ----------
ghi ""
ghi "Dang dung cac container..."
docker compose -f "$DU_AN/docker-compose.yml" --project-directory "$DU_AN" down >/dev/null

# Du lieu hien tai DOI TEN chu khong xoa: phuc hoi nham con duong lui.
LUU_CU="$DU_AN/data-truoc-khi-phuc-hoi-$(date '+%Y%m%d-%H%M%S')"
if [ -d "$DU_AN/data" ]; then
  mv "$DU_AN/data" "$LUU_CU"
  ghi "Du lieu cu da doi ten thanh: $(basename "$LUU_CU")"
fi
mkdir -p "$DU_AN/data"

cp "$DB" "$DU_AN/data/zalo.db"
[ -f "$TAM/credentials.json" ] && cp "$TAM/credentials.json" "$DU_AN/data/credentials.json"

# CO TINH khong phuc hoi opencode.jsonc: file do giu API key dang chu thuong nen
# ban sao luu khong con chua no nua. Ban cu co the con - van bo qua.
if [ -f "$TAM/opencode-config/opencode.jsonc" ]; then
  ghi "(Ban sao luu cu co chua opencode.jsonc - KHONG phuc hoi file nay)"
fi

ghi "Dang bat lai..."
docker compose -f "$DU_AN/docker-compose.yml" --project-directory "$DU_AN" up -d >/dev/null

ghi ""
ghi "Xong. Du lieu cu van con o: $(basename "$LUU_CU")"
ghi "VIEC PHAI LAM TIEP: mo app, vao tab AI Chat va NHAP LAI API key."
[ "$GIAI_MA_OK" -eq 1 ] || ghi "Va: quet lai QR Zalo, nhap lai ket noi Zoho/SMTP."
