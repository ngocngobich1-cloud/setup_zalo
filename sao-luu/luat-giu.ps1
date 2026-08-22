# Luat giu ban sao luu, dung chung cho ca thu muc tren may lan tren Google Drive.
#
# Giu 3 tang:
#   - 30 ban gan nhat, moi ngay mot ban
#   - 12 ban tuan  (ban cua thu Hai) -> lui ve ~3 thang
#   - 12 ban thang (ban ngay mung 1) -> lui ve ~1 nam
#
# Vi sao khong giu tat ca: hong du lieu ma 3 tuan sau moi phat hien thi 7 ban
# la khong du - nhung giu vo han thi den mot ngay o dia day va ca may chet ma
# khong ai biet. Ba tang nay cho nhin lui duoc mot nam ma so file van co han.
#
# TRAN_GB la chot chan cuoi: du luat tren tinh the nao, tong dung luong khong
# bao gio duoc vuot qua. Vuot thi xoa ban cu nhat truoc.

function Don-BanSaoLuu {
  param(
    [Parameter(Mandatory)][string]$ThuMuc,
    [string]$Mau = "zalo-web-*.zip",
    [int]$GiuNgay = 30,
    [int]$GiuTuan = 12,
    [int]$GiuThang = 12,
    [double]$TranGB = 5,
    [scriptblock]$Ghi = { param($s) Write-Host $s }
  )

  if (-not (Test-Path $ThuMuc)) { return }

  $homNay = (Get-Date).Date
  $files = Get-ChildItem $ThuMuc -Filter $Mau -ErrorAction SilentlyContinue |
           Sort-Object Name -Descending   # ten co dang ...-YYYY-MM-DD-HHmm nen sap theo ten = sap theo thoi gian

  $giuLai = @()
  $xoa = @()
  $soTuan = 0
  $soThang = 0

  foreach ($f in $files) {
    if ($f.Name -notmatch '(\d{4})-(\d{2})-(\d{2})-\d{4}') { $giuLai += $f; continue }
    $ngay = [datetime]::ParseExact("$($matches[1])-$($matches[2])-$($matches[3])", "yyyy-MM-dd", $null)
    $tuoi = ($homNay - $ngay).Days

    if ($tuoi -lt $GiuNgay)                                      { $giuLai += $f; continue }
    if ($ngay.Day -eq 1        -and $soThang -lt $GiuThang)      { $soThang++; $giuLai += $f; continue }
    if ($ngay.DayOfWeek -eq [DayOfWeek]::Monday -and $soTuan -lt $GiuTuan) { $soTuan++; $giuLai += $f; continue }
    $xoa += $f
  }

  # Chot chan dung luong: duyet tu moi den cu, vuot tran thi cat phan con lai.
  $tran = $TranGB * 1GB
  $congDon = 0
  $quaTran = @()
  foreach ($f in $giuLai) {
    $congDon += $f.Length
    if ($congDon -gt $tran) { $quaTran += $f }
  }
  if ($quaTran.Count -gt 0) {
    & $Ghi "Cham tran $TranGB GB - bo them $($quaTran.Count) ban cu nhat"
    $xoa += $quaTran
  }

  foreach ($f in $xoa) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }

  $conLai = Get-ChildItem $ThuMuc -Filter $Mau -ErrorAction SilentlyContinue
  $mb = if ($conLai) { [math]::Round(($conLai | Measure-Object Length -Sum).Sum / 1MB, 1) } else { 0 }
  & $Ghi "Dang giu $($conLai.Count) ban ($mb MB)$(if($xoa.Count){", vua xoa $($xoa.Count) ban cu"})"
}
