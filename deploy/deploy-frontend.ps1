# Frontend deploy: test -> build -> S3 (asset'ler immutable, kalanlar no-cache) -> CloudFront invalidation.
# Kullanım: .\deploy\deploy-frontend.ps1 [-Profile watchparty] [-DryRun]
param(
    [string]$Profile = "watchparty",
    [switch]$DryRun
)
. (Join-Path $PSScriptRoot "common.ps1")
$script:DryRun = $DryRun.IsPresent

$outputs = Get-InfraOutputs
$frontend = Join-Path $script:RepoRoot "frontend"
$dist = Join-Path $frontend "dist"
$site = "s3://$($outputs.site_bucket)"

Push-Location $frontend
try {
    Write-Host "Testler çalıştırılıyor..."
    & npm test
    if ($LASTEXITCODE -ne 0) { throw "npm test başarısız; deploy durduruldu" }
    Write-Host "Build alınıyor..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build başarısız" }
} finally {
    Pop-Location
}

# --delete yok: açık sayfalar eski JS'i yükleyebilsin diye eski asset'ler kalır.
Write-Host "Asset'ler yükleniyor (immutable)..."
Invoke-Aws s3 sync (Join-Path $dist "assets") "$site/assets" --cache-control "public, max-age=31536000, immutable" | Out-Null

Write-Host "index.html ve theme-init.js yükleniyor (no-cache)..."
Invoke-Aws s3 cp (Join-Path $dist "index.html") "$site/index.html" --cache-control "no-cache" | Out-Null
Invoke-Aws s3 cp (Join-Path $dist "theme-init.js") "$site/theme-init.js" --cache-control "no-cache" | Out-Null

# dist kökündeki diğer dosyalar (favicon vb.) da no-cache ile.
Get-ChildItem $dist -File | Where-Object { $_.Name -notin @("index.html", "theme-init.js") } | ForEach-Object {
    Invoke-Aws s3 cp $_.FullName "$site/$($_.Name)" --cache-control "no-cache" | Out-Null
}

Write-Host "CloudFront önbelleği temizleniyor..."
Invoke-Aws cloudfront create-invalidation --distribution-id $outputs.distribution_id --paths /index.html /theme-init.js | Out-Null

Write-Host "Frontend yayında: https://$($outputs.cloudfront_domain)"
