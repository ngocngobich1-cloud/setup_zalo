# Phuc hoi Zalo Web Chat tu mot ban sao luu.
#
# Xem thu ban sao luu co dung duoc khong (KHONG dung toi du lieu that):
#   powershell -ExecutionPolicy Bypass -File "...\phuc-hoi.ps1" -ChiKiemTra
#
# Phuc hoi that:
#   powershell -ExecutionPolicy Bypass -File "...\phuc-hoi.ps1"
#   powershell -ExecutionPolicy Bypass -File "...\phuc-hoi.ps1" -TuFile "D:\zalo-web-sao-luu\zalo-web-2026-01-01-0300.zip"
#
# CAN CA .env: du lieu trong ban sao luu da ma hoa. Khong co dung APP_SECRET_KEY
# cu thi cookie Zalo va khoa ky session khong doc lai duoc.

param(
  [string]$TuFile = "",
  [switch]$ChiKiemTra
)

$ErrorActionPreference = "Stop"

$DuAn = Split-Path -Parent $PSScriptRoot
$KhoSaoLuu = "D:\zalo-web-sao-luu"

function Ghi($s) { Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $s) }

# 1. Chon ban sao luu
if (-not $TuFile) {
  $moiNhat = Get-ChildItem $KhoSaoLuu -Filter "zalo-web-*.zip" -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $moiNhat) { throw "Khong tim thay ban sao luu nao trong $KhoSaoLuu" }
  $TuFile = $moiNhat.FullName
}
if (-not (Test-Path $TuFile)) { throw "Khong co file: $TuFile" }
Ghi "Ban sao luu: $(Split-Path $TuFile -Leaf) ($([math]::Round((Get-Item $TuFile).Length/1MB,2)) MB)"

# 2. Bung ra thu muc tam
$Tam = Join-Path $env:TEMP "zalo-phuc-hoi-$(Get-Date -Format 'HHmmss')"
New-Item -ItemType Directory -Force -Path $Tam | Out-Null
try {
  Expand-Archive -Path $TuFile -DestinationPath $Tam -Force

  # 3. Kiem tra noi dung truoc khi dung toi bat cu thu gi
  $db = Join-Path $Tam "zalo.db"
  if (-not (Test-Path $db)) { throw "Ban sao luu thieu zalo.db" }

  docker cp (Join-Path $PSScriptRoot "kiem-tra-csdl.js") "zalo-web-chat:/app/_kiem-tra.js" | Out-Null
  docker cp $db "zalo-web-chat:/tmp/kiem-tra.db" | Out-Null
  $ketQua = docker exec zalo-web-chat node /app/_kiem-tra.js /tmp/kiem-tra.db
  docker exec zalo-web-chat rm -f /tmp/kiem-tra.db /app/_kiem-tra.js | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "CSDL trong ban sao luu bi hong" }
  $ketQua | ForEach-Object { Ghi "  $_" }

  $coCred = Test-Path (Join-Path $Tam "credentials.json")
  Ghi "  credentials.json (dang nhap Zalo): $(if($coCred){'co'}else{'KHONG CO'})"

  # Ban sao luu CO TINH khong chua opencode.jsonc - file do giu API key dang chu
  # thuong, de trong goi khong ma hoa la ai nhat duoc cung dung duoc.
  # Ban cu (tao truoc 09/08/2026) co the con file do; van bo qua cho an toan.
  $coKeyCu = Test-Path (Join-Path $Tam "opencode-config\opencode.jsonc")
  if ($coKeyCu) { Ghi "  (ban sao luu cu co chua opencode.jsonc - se KHONG phuc hoi file nay)" }

  if ($ChiKiemTra) {
    Ghi "Chi kiem tra - KHONG dung toi du lieu that. Ban sao luu dung duoc."
    return
  }

  # 4. Phuc hoi that. Dung app truoc de khong ai ghi vao giua chung.
  Ghi "Dang dung cac container..."
  docker compose -f (Join-Path $DuAn "docker-compose.yml") --project-directory $DuAn down | Out-Null

  # Du lieu hien tai duoc doi ten chu KHONG xoa: phuc hoi nham con duong lui.
  $luuCu = Join-Path $DuAn "data-truoc-khi-phuc-hoi-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  if (Test-Path (Join-Path $DuAn "data")) {
    Rename-Item (Join-Path $DuAn "data") (Split-Path $luuCu -Leaf)
    Ghi "Du lieu cu da doi ten thanh: $(Split-Path $luuCu -Leaf)"
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $DuAn "data") | Out-Null

  Copy-Item $db (Join-Path $DuAn "data\zalo.db")
  if ($coCred) { Copy-Item (Join-Path $Tam "credentials.json") (Join-Path $DuAn "data\credentials.json") }

  Ghi "Dang bat lai..."
  docker compose -f (Join-Path $DuAn "docker-compose.yml") --project-directory $DuAn up -d | Out-Null
  Ghi "Xong."
  Ghi "VIEC PHAI LAM TIEP: mo app, vao tab AI Chat va NHAP LAI API key."
  Ghi "  Ban sao luu co tinh khong chua key do (de goi sao luu khong thanh mieng moi)."
  Ghi "Neu app bao phai dang nhap Zalo lai bang QR, nghia la file .env khong con"
  Ghi "  dung khoa APP_SECRET_KEY luc tao ban sao luu nay."
}
finally {
  Remove-Item $Tam -Recurse -Force -ErrorAction SilentlyContinue
}
