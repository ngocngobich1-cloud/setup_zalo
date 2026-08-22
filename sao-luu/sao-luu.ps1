# Sao luu Zalo Web Chat (Windows).
# Chay tay:  powershell -ExecutionPolicy Bypass -File "D:\DA test\zalo-web\sao-luu\sao-luu.ps1"
#
# Tao ra: D:\zalo-web-sao-luu\zalo-web-<ngay>-<gio>.zip
# KHONG kem .env: file do chua khoa ma hoa. De chung thi ai lay duoc ban sao
# luu la co ca khoa lan du lieu, ma hoa thanh vo nghia.

$ErrorActionPreference = "Stop"

$DuAn    = Split-Path -Parent $PSScriptRoot
$DichCuoi = "D:\zalo-web-sao-luu"
$Container = "zalo-web-chat"

# Luat giu ban cu: 30 ban ngay + 12 ban tuan + 12 ban thang, tran cung 5 GB.
. (Join-Path $PSScriptRoot "luat-giu.ps1")
$TranGB_May   = 5
$TranGB_Drive = 3   # Drive mien phi chi co 15 GB va con dung cho viec khac

function Ghi($s) {
  $dong = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $s
  Write-Host $dong
  if (Test-Path $DichCuoi) { Add-Content -Path (Join-Path $DichCuoi "nhat-ky.txt") -Value $dong -Encoding utf8 }
}

New-Item -ItemType Directory -Force -Path $DichCuoi | Out-Null
$Nhan = Get-Date -Format "yyyy-MM-dd-HHmm"
$Tam  = Join-Path $env:TEMP "zalo-sao-luu-$Nhan"
New-Item -ItemType Directory -Force -Path $Tam | Out-Null

try {
  Ghi "Bat dau sao luu"

  # 1. Chup CSDL bang VACUUM INTO. Chep thang file .db khi app dang chay se
  #    bat duoc ban do dang: phan du lieu moi nhat con nam trong file -wal.
  #    VACUUM INTO tao ra mot ban sao lien mach, an toan ngay ca luc dang ghi.
  $dangChay = (docker ps --filter "name=$Container" --filter "status=running" --format "{{.Names}}") -eq $Container
  if ($dangChay) {
    Ghi "Dang chup CSDL tu container (an toan khi app dang chay)"
    # Dat trong /app chu khong phai /tmp: require('sqlite3') chi tim thay
    # /app/node_modules khi file nam trong cay thu muc do.
    docker cp (Join-Path $PSScriptRoot "chup-csdl.js") "${Container}:/app/_chup-csdl.js" | Out-Null
    docker exec $Container node /app/_chup-csdl.js /app/data/zalo.db /app/data/_chup.db | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Khong chup duoc CSDL" }
    docker cp "${Container}:/app/data/_chup.db" (Join-Path $Tam "zalo.db") | Out-Null
    docker exec $Container rm -f /app/data/_chup.db /app/_chup-csdl.js | Out-Null
  } else {
    Ghi "Container khong chay - chep thang file CSDL"
    Copy-Item (Join-Path $DuAn "data\zalo.db") (Join-Path $Tam "zalo.db") -ErrorAction SilentlyContinue
  }

  # 2. Cookie Zalo (da ma hoa)
  $cred = Join-Path $DuAn "data\credentials.json"
  if (Test-Path $cred) { Copy-Item $cred $Tam }

  # 3. KHONG lay opencode-data\config.
  #    Truoc day co lay, va do la mot lo hong that: opencode.jsonc giu API key cua
  #    nha cung cap AI duoi dang chu thuong. File nen nay khong ma hoa va con duoc
  #    day len Google Drive - ai nhat duoc mot ban la dung duoc key ngay.
  #    Nghich ly la ngay ben duoi da co tinh loai .env ra vi "chua khoa", trong khi
  #    van chep mot khoa khac vao.
  #    Doi lai: phuc hoi xong phai nhap lai API key trong tab AI Chat.

  # 4. Nen lai
  $zip = Join-Path $DichCuoi "zalo-web-$Nhan.zip"
  Compress-Archive -Path (Join-Path $Tam "*") -DestinationPath $zip -CompressionLevel Optimal -Force

  # 5. Mo thu file nen. Mot ban sao luu chua bao gio mo duoc thi khong phai ban sao luu.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $kt = [System.IO.Compression.ZipFile]::OpenRead($zip)
  $soFile = $kt.Entries.Count
  $coDb = $null -ne ($kt.Entries | Where-Object { $_.Name -eq "zalo.db" })
  $kt.Dispose()
  if (-not $coDb) { throw "File nen thieu zalo.db" }

  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
  Ghi "Xong: $(Split-Path $zip -Leaf) - $mb MB, $soFile muc"

  # 6. Don ban cu theo luat ngay/tuan/thang
  Don-BanSaoLuu -ThuMuc $DichCuoi -TranGB $TranGB_May -Ghi { param($s) Ghi $s }

  # 7. Neu may co Google Drive thi chep len luon. Chua co thi bao ro.
  $drive = @("$env:USERPROFILE\Google Drive", "G:\My Drive", "G:\Drive cua toi", "H:\My Drive") |
           Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($drive) {
    $dichDrive = Join-Path $drive "Sao luu Zalo Web"
    New-Item -ItemType Directory -Force -Path $dichDrive | Out-Null
    Copy-Item $zip $dichDrive -Force
    Don-BanSaoLuu -ThuMuc $dichDrive -TranGB $TranGB_Drive -Ghi { param($s) Ghi "Drive: $s" }
    Ghi "Da chep len Google Drive: $dichDrive"
  } else {
    Ghi "CHUA co Google Drive tren may - ban sao luu dang nam CUNG mot o dia voi du lieu goc."
  }
}
catch {
  Ghi "LOI: $($_.Exception.Message)"
  exit 1
}
finally {
  Remove-Item $Tam -Recurse -Force -ErrorAction SilentlyContinue
}
