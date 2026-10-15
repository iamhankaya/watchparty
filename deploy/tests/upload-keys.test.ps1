# upload-keys.ps1 birim testleri (Pester yok). Çalıştırma:
#   powershell -NoProfile -File deploy/tests/upload-keys.test.ps1
# Gerçek aws/SSM çağrılmaz: uzak okuma/yazma, infra çıktıları ve pano sahte fonksiyonlarla değiştirilir.
$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path -Parent $PSScriptRoot) "upload-keys.ps1")

$script:pass = 0
$script:fail = 0
$script:remote = ""
$script:written = @()
$script:clipboard = $null

# Dot-source'tan sonra tanımlandıkları için script'teki aynı adlı fonksiyonların yerine geçerler.
function Get-InfraOutputs {
    return [pscustomobject]@{ instance_id = "i-0abc"; cloudfront_domain = "d123.cloudfront.net"; video_bucket = "watchparty-videos-abc" }
}
function Read-RemoteUploadLines([string]$InstanceId) { return $script:remote }
function Write-RemoteUploadLines([string]$InstanceId, [string]$UploadLines) { $script:written += , $UploadLines }
function Set-Clipboard([string]$Value) { $script:clipboard = $Value }
function Read-Host { throw "Read-Host çağrılmamalıydı (-Force)" }

function Reset-State {
    $script:remote = ""
    $script:written = @()
    $script:clipboard = $null
}

function Run-Test([string]$Name, [scriptblock]$Body) {
    Reset-State
    $err = $null
    try { & $Body } catch { $err = $_.Exception.Message }
    Reset-State
    if ($null -eq $err) { Write-Host "PASS $Name"; $script:pass++ }
    else { Write-Host "FAIL $Name ($err)"; $script:fail++ }
}

function Assert([bool]$Cond, [string]$Msg) { if (-not $Cond) { throw $Msg } }

function Get-ErrorOf([scriptblock]$Body) {
    try { & $Body } catch { return $_.Exception.Message }
    return ""
}

$h1 = "a" * 64
$h2 = "b" * 64
$h3 = "c" * 64

Run-Test "ekle_bos_icerik" {
    $r = Update-EnvContent -Content "" -Action Add -Name "ali" -Sha256 $h1
    Assert ($r -eq "Upload__Keys__0__Name=ali`nUpload__Keys__0__Sha256=$h1`n") "beklenmeyen içerik: $r"
}

Run-Test "ekle_siradaki_indeks_ve_diger_satirlar_korunur" {
    $c = "ASPNETCORE_ENVIRONMENT=Production`r`nUpload__Keys__0__Name=ali`r`nUpload__Keys__0__Sha256=$h1`r`n"
    $r = Update-EnvContent -Content $c -Action Add -Name "veli" -Sha256 $h2
    $exp = "ASPNETCORE_ENVIRONMENT=Production`nUpload__Keys__0__Name=ali`nUpload__Keys__0__Sha256=$h1`nUpload__Keys__1__Name=veli`nUpload__Keys__1__Sha256=$h2`n"
    Assert ($r -eq $exp) "beklenmeyen içerik: $r"
}

Run-Test "ayni_ad_hata" {
    $c = Update-EnvContent -Content "" -Action Add -Name "ali" -Sha256 $h1
    $m = Get-ErrorOf { Update-EnvContent -Content $c -Action Add -Name "ali" -Sha256 $h2 }
    Assert ($m -like "*'ali' adlı anahtar zaten var*") "hata mesajı yanlış: $m"
}

Run-Test "gecersiz_ad_hata" {
    foreach ($n in @("", "Ali", "a b", "a_b", ("x" * 33))) {
        $m = Get-ErrorOf { Update-EnvContent -Content "" -Action Add -Name $n -Sha256 $h1 }
        Assert ($m -like "*Geçersiz anahtar adı*") "'$n' kabul edildi: $m"
    }
}

Run-Test "sil_ve_indeksleri_sikistir" {
    $c = ""
    $c = Update-EnvContent -Content $c -Action Add -Name "a" -Sha256 $h1
    $c = Update-EnvContent -Content $c -Action Add -Name "b" -Sha256 $h2
    $c = Update-EnvContent -Content $c -Action Add -Name "c" -Sha256 $h3
    $r = Update-EnvContent -Content $c -Action Remove -Name "b"
    $exp = "Upload__Keys__0__Name=a`nUpload__Keys__0__Sha256=$h1`nUpload__Keys__1__Name=c`nUpload__Keys__1__Sha256=$h3`n"
    Assert ($r -eq $exp) "beklenmeyen içerik: $r"
}

Run-Test "bosluklu_indeksler_sirali_sikistirilir" {
    $c = "Upload__Keys__5__Name=c`nUpload__Keys__5__Sha256=$h3`nUpload__Keys__2__Name=a`nUpload__Keys__2__Sha256=$h1`n"
    $r = Update-EnvContent -Content $c -Action Add -Name "d" -Sha256 $h2
    $exp = "Upload__Keys__0__Name=a`nUpload__Keys__0__Sha256=$h1`nUpload__Keys__1__Name=c`nUpload__Keys__1__Sha256=$h3`nUpload__Keys__2__Name=d`nUpload__Keys__2__Sha256=$h2`n"
    Assert ($r -eq $exp) "beklenmeyen içerik: $r"
}

Run-Test "olmayan_ad_silme_hata" {
    $m = Get-ErrorOf { Update-EnvContent -Content "" -Action Remove -Name "yok" }
    Assert ($m -like "*'yok' adlı anahtar bulunamadı*") "hata mesajı yanlış: $m"
}

Run-Test "init_yazar_ve_idempotent" {
    $c = "Upload__Keys__0__Name=a`nUpload__Keys__0__Sha256=$h1`n"
    $r1 = Update-EnvContent -Content $c -Action Init -VideoBucket "vb" -PublicBaseUrl "https://d1.cloudfront.net"
    $r2 = Update-EnvContent -Content $r1 -Action Init -VideoBucket "vb" -PublicBaseUrl "https://d1.cloudfront.net"
    Assert ($r1 -eq $r2) "ikinci Init içeriği değiştirdi"
    Assert ($r1 -like "*Upload__VideoBucket=vb`n*") "VideoBucket yok: $r1"
    Assert ($r1 -like "*Upload__PublicBaseUrl=https://d1.cloudfront.net`n*") "PublicBaseUrl yok: $r1"
    Assert ((Get-UploadKeyNames $r1) -join "," -eq "a") "anahtar kaybedildi"
}

Run-Test "init_degeri_gunceller" {
    $c = "Upload__VideoBucket=eski`nUpload__PublicBaseUrl=https://eski`n"
    $r = Update-EnvContent -Content $c -Action Init -VideoBucket "yeni" -PublicBaseUrl "https://yeni"
    Assert ($r -eq "Upload__VideoBucket=yeni`nUpload__PublicBaseUrl=https://yeni`n") "beklenmeyen içerik: $r"
}

Run-Test "anahtar_32_base62" {
    $k = New-UploadKey
    Assert ($k.Length -eq 32) "uzunluk $($k.Length)"
    Assert ($k -cmatch '^[0-9A-Za-z]{32}\z') "base62 değil"
}

Run-Test "iki_anahtar_farkli" {
    Assert ((New-UploadKey) -cne (New-UploadKey)) "aynı anahtar üretildi"
}

Run-Test "sha256_kucuk_hex" {
    # "abc" için bilinen SHA-256.
    Assert ((Get-Sha256Hex "abc") -ceq "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") "özet yanlış"
}

Run-Test "add_anahtari_yazdirmaz_panoya_kopyalar" {
    $script:remote = "Upload__Keys__0__Name=eski`nUpload__Keys__0__Sha256=$h1`n"
    $out = & { Invoke-UploadKeys -Add "yeni" -Force } *>&1 | Out-String
    $key = $script:clipboard
    Assert ($key -and $key.Length -eq 32) "panoya anahtar kopyalanmadı"
    Assert (-not $out.Contains($key)) "çıktıda açık anahtar var"
    Assert ($out -like "*Anahtar panoya kopyalandı (yeni)*") "onay mesajı yok: $out"
    Assert ($out -like "*açık lobiler düşer*") "uyarı yok: $out"
    Assert ($script:written.Count -eq 1) "sunucuya yazılmadı"
    Assert (-not $script:written[0].Contains($key)) "sunucuya açık anahtar gitti"
    Assert ($script:written[0].Contains("Upload__Keys__1__Sha256=$(Get-Sha256Hex $key)")) "özet yazılmadı: $($script:written[0])"
}

Run-Test "add_ayni_ad_yazmaz_kopyalamaz" {
    $script:remote = "Upload__Keys__0__Name=ali`nUpload__Keys__0__Sha256=$h1`n"
    $m = Get-ErrorOf { Invoke-UploadKeys -Add "ali" -Force *>&1 | Out-Null }
    Assert ($m -like "*zaten var*") "hata yok: $m"
    Assert ($script:written.Count -eq 0) "sunucuya yazıldı"
    Assert ($null -eq $script:clipboard) "panoya kopyalandı"
}

Run-Test "list_yalnizca_adlar" {
    $script:remote = "Upload__VideoBucket=vb`nUpload__Keys__0__Name=ali`nUpload__Keys__0__Sha256=$h1`n"
    $out = & { Invoke-UploadKeys -List } *>&1 | Out-String
    Assert ($out -like "*ali*") "ad yok: $out"
    Assert (-not $out.Contains($h1)) "özet yazdırıldı"
    Assert ($script:written.Count -eq 0) "List sunucuya yazdı"
}

Run-Test "init_guncelse_yazmaz" {
    $script:remote = "Upload__VideoBucket=watchparty-videos-abc`nUpload__PublicBaseUrl=https://d123.cloudfront.net`n"
    & { Invoke-UploadKeys -Init -Force } *>&1 | Out-Null
    Assert ($script:written.Count -eq 0) "değişiklik yokken yazıldı"
}

Run-Test "init_eksikse_yazar" {
    $script:remote = "Upload__Keys__0__Name=ali`nUpload__Keys__0__Sha256=$h1`n"
    & { Invoke-UploadKeys -Init -Force } *>&1 | Out-Null
    Assert ($script:written.Count -eq 1) "yazılmadı"
    Assert ($script:written[0] -like "*Upload__PublicBaseUrl=https://d123.cloudfront.net`n*") "PublicBaseUrl yok"
}

Run-Test "tek_islem_zorunlu" {
    $m = Get-ErrorOf { Invoke-UploadKeys -List -Init }
    Assert ($m -like "*Tam olarak bir işlem*") "hata yok: $m"
}

Write-Host "$($script:pass) geçti, $($script:fail) kaldı"
if ($script:fail -gt 0) { exit 1 }
