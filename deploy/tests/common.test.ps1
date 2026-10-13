# common.ps1 birim testleri (Pester yok). Çalıştırma:
#   powershell -NoProfile -File deploy/tests/common.test.ps1   (Windows)
#   pwsh -NoProfile -File deploy/tests/common.test.ps1         (CI)
# Gerçek aws CLI çağrılmaz; sahte `aws` fonksiyonu kullanılır.
$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path -Parent $PSScriptRoot) "common.ps1")

$script:pass = 0
$script:fail = 0
$script:calls = @()
$script:fakeValue = ""
$script:fakeExit = 0

# Fonksiyonlar dış komutlardan önce çözüldüğünden common.ps1'deki `& aws` buna düşer.
function aws {
    $script:calls += , (@($args) -join " ")
    $global:LASTEXITCODE = $script:fakeExit
    if ($script:fakeExit -ne 0) { return }
    $o = @{ Parameter = @{ Value = $script:fakeValue } }
    return ($o | ConvertTo-Json -Compress)
}

function Reset-State {
    $script:calls = @()
    $script:fakeExit = 0
    $script:DryRun = $false
    $env:WP_OUTPUTS_FROM_SSM = $null
    $global:LASTEXITCODE = 0
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

function Get-FullJson([string[]]$Omit = @()) {
    $h = [ordered]@{
        cloudfront_domain = "d123.cloudfront.net"
        distribution_id   = "EDIST123"
        site_bucket       = "site-bucket"
        deploy_bucket     = "deploy-bucket"
        instance_id       = "i-0abc"
        origin_domain     = "ec2-1-2-3-4.eu-north-1.compute.amazonaws.com"
    }
    foreach ($k in $Omit) { $h.Remove($k) }
    return ($h | ConvertTo-Json -Compress)
}

function Get-ErrorOf([scriptblock]$Body) {
    try { & $Body } catch { return $_.Exception.Message }
    return ""
}

Run-Test "profil_bos_ise_profile_eklenmez" {
    $Profile = ""
    Invoke-Aws s3 ls | Out-Null
    $c = $script:calls[0]
    Assert ($c -notmatch "--profile") "--profile bulundu: $c"
    Assert ($c -match "--output json") "--output json yok: $c"
}

Run-Test "profil_dolu_ise_profile_eklenir" {
    $Profile = "watchparty"
    Invoke-Aws s3 ls | Out-Null
    Assert ($script:calls[0] -match "--profile watchparty") "--profile watchparty yok: $($script:calls[0])"
}

Run-Test "ssm_yolu_ciktilari_okur" {
    $Profile = ""
    $env:WP_OUTPUTS_FROM_SSM = "1"
    $script:fakeValue = Get-FullJson
    $o = Get-InfraOutputs
    Assert ($o.site_bucket -eq "site-bucket") "site_bucket yanlış"
    Assert ($o.distribution_id -eq "EDIST123") "distribution_id yanlış"
    Assert ($o.origin_domain -eq "ec2-1-2-3-4.eu-north-1.compute.amazonaws.com") "origin_domain yanlış"
    Assert ($script:calls[0] -match "ssm get-parameter --name /watchparty/infra-outputs") "aws argümanları yanlış: $($script:calls[0])"
}

Run-Test "ssm_eksik_anahtar" {
    $Profile = ""
    $env:WP_OUTPUTS_FROM_SSM = "1"
    $script:fakeValue = Get-FullJson -Omit "instance_id"
    $m = Get-ErrorOf { Get-InfraOutputs }
    Assert ($m -like "*infra çıktıları eksik (instance_id)*") "hata mesajı yanlış: $m"
}

Run-Test "ssm_okuma_hatasi" {
    $Profile = ""
    $env:WP_OUTPUTS_FROM_SSM = "1"
    $script:fakeExit = 255
    $m = Get-ErrorOf { Get-InfraOutputs }
    Assert ($m -like "*/watchparty/infra-outputs*") "parametre adı yok: $m"
    Assert ($m -like "*okunamadı*") "'okunamadı' yok: $m"
}

Run-Test "dryrun_ssm_okur" {
    $Profile = ""
    $env:WP_OUTPUTS_FROM_SSM = "1"
    $script:DryRun = $true
    $script:fakeValue = Get-FullJson
    $o = Get-InfraOutputs
    Assert ($script:calls.Count -ge 1) "sahte aws çağrılmadı"
    Assert ($o.instance_id -eq "i-0abc") "nesne dolu değil"
}

Write-Host "$($script:pass) geçti, $($script:fail) kaldı"
if ($script:fail -gt 0) { exit 1 }
