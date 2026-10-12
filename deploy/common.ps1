# Ortak yardımcılar: deploy-backend.ps1 ve deploy-frontend.ps1 tarafından dot-source edilir.
# Çağıran script'te $Profile (AWS profili) ve isteğe bağlı $script:DryRun tanımlı olmalıdır.
$ErrorActionPreference = "Stop"

$script:RepoRoot = Split-Path -Parent $PSScriptRoot

# terraform output -json çıktısını düz bir nesneye çevirir: $o.cloudfront_domain, $o.instance_id vb.
function Get-InfraOutputs {
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
    foreach ($k in "cloudfront_domain", "distribution_id", "site_bucket", "deploy_bucket", "instance_id") {
        if (-not $flat.Contains($k)) { throw "infra çıktıları eksik ($k); önce terraform apply" }
    }
    return [pscustomobject]$flat
}

# aws CLI'yi seçili profille çalıştırır; çıkış kodu sıfır değilse hata fırlatır.
# $script:DryRun açıksa komutu çalıştırmaz, yalnızca yazdırır.
function Invoke-Aws {
    $awsArgs = @($args) + @("--profile", $Profile, "--output", "json")
    if ($script:DryRun) {
        Write-Host ("[DryRun] aws " + ($awsArgs -join " "))
        return
    }
    $out = & aws @awsArgs
    if ($LASTEXITCODE -ne 0) {
        throw "aws komutu başarısız oldu (çıkış kodu $LASTEXITCODE): aws $($args -join ' ')"
    }
    return $out
}
