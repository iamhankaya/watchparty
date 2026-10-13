# Ortak yardımcılar: deploy-backend.ps1 ve deploy-frontend.ps1 tarafından dot-source edilir.
# Çağıran script'te $Profile (AWS profili) ve isteğe bağlı $script:DryRun tanımlı olmalıdır.
$ErrorActionPreference = "Stop"

$script:RepoRoot = Split-Path -Parent $PSScriptRoot

# Windows'ta aws CLI çıktıyı sistem kod sayfasıyla (ör. cp1254) yazar; Türkçe karakterler bozulmasın diye UTF-8'e zorlanır.
$env:AWS_CLI_OUTPUT_ENCODING = "UTF-8"

# CI'da terraform yok: çıktılar SSM parametresinde (/watchparty/infra-outputs) düz JSON olarak durur.
# Salt okunur olduğu için $script:DryRun'dan bağımsız gerçekten çalışır.
function Get-InfraOutputsFromSsm {
    $awsArgs = @("ssm", "get-parameter", "--name", "/watchparty/infra-outputs")
    if ($Profile) { $awsArgs += @("--profile", $Profile) }
    $awsArgs += @("--output", "json")
    $out = $null
    try {
        $out = & aws @awsArgs
    } catch {
        $out = $null
    }
    if (-not $out -or $LASTEXITCODE -ne 0) {
        throw "infra çıktıları SSM parametresinden (/watchparty/infra-outputs) okunamadı"
    }
    $value = (($out -join "`n") | ConvertFrom-Json).Parameter.Value
    $raw = $value | ConvertFrom-Json
    $flat = [ordered]@{}
    foreach ($p in $raw.PSObject.Properties) { $flat[$p.Name] = $p.Value }
    return $flat
}

# terraform output -json çıktısını düz bir nesneye çevirir: $o.cloudfront_domain, $o.instance_id vb.
function Get-InfraOutputs {
    $fromSsm = ($env:WP_OUTPUTS_FROM_SSM -eq "1")
    if ($fromSsm) {
        $flat = Get-InfraOutputsFromSsm
    } else {
        $flat = Get-InfraOutputsFromTerraform
    }
    # Zorunlu anahtar kontrolü iki yol için ortak; SSM yolunda origin_domain da gerekir.
    $required = @("cloudfront_domain", "distribution_id", "site_bucket", "deploy_bucket", "instance_id")
    if ($fromSsm) { $required += "origin_domain" }
    foreach ($k in $required) {
        if (-not $flat.Contains($k)) {
            $hint = if ($fromSsm) { "SSM parametresini güncellemek için terraform apply" } else { "önce terraform apply" }
            throw "infra çıktıları eksik ($k); $hint"
        }
    }
    return [pscustomobject]$flat
}

# terraform output -json çıktısını düz bir sıralı sözlüğe çevirir.
function Get-InfraOutputsFromTerraform {
    $infra = Join-Path $script:RepoRoot "infra"
    $json = $null
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if (Test-Path $infra) {
            $json = & terraform "-chdir=$infra" output -json 2>$null
        }
    } catch {
        $json = $null
    } finally {
        $ErrorActionPreference = $prev
    }
    if (-not $json -or $LASTEXITCODE -ne 0) {
        throw "infra çıktıları okunamadı; önce terraform apply"
    }
    $raw = ($json -join "`n") | ConvertFrom-Json
    $flat = [ordered]@{}
    foreach ($p in $raw.PSObject.Properties) { $flat[$p.Name] = $p.Value.value }
    return $flat
}

# Klasörü, girdi adlarında '/' ayırıcı kullanan bir zip'e paketler (Linux'taki unzip için).
function New-ZipWithForwardSlashes([string]$SourceDir, [string]$ZipPath) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # GetFiles yolları verilen kökle aynı biçimde döndürür (Get-ChildItem kısa adı METOHA~1 gibi uzun ada çevirebilir).
    $root = [System.IO.Path]::GetFullPath($SourceDir).TrimEnd('\') + '\'
    $archive = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($path in [System.IO.Directory]::GetFiles($root, "*", [System.IO.SearchOption]::AllDirectories)) {
            $entryName = $path.Substring($root.Length).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $path, $entryName) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }
}

# aws CLI'yi seçili profille çalıştırır; çıkış kodu sıfır değilse hata fırlatır.
# $script:DryRun açıksa komutu çalıştırmaz, yalnızca yazdırır.
function Invoke-Aws {
    $awsArgs = @($args)
    # Profil boşsa (CI'da OIDC ortam değişkenleri) --profile eklenmez.
    if ($Profile) { $awsArgs += @("--profile", $Profile) }
    $awsArgs += @("--output", "json")
    if ($script:DryRun) {
        Write-Host ("[DryRun] aws " + ($awsArgs -join " "))
        return
    }
    # PowerShell yerel komut çıktısını [Console]::OutputEncoding ile okur; aws artık UTF-8 yazıyor.
    $prevEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    try {
        $out = & aws @awsArgs
    } finally {
        [Console]::OutputEncoding = $prevEncoding
    }
    if ($LASTEXITCODE -ne 0) {
        throw "aws komutu başarısız oldu (çıkış kodu $LASTEXITCODE): aws $($args -join ' ')"
    }
    return $out
}
