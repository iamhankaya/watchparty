# Backend deploy: test -> publish -> zip -> S3 -> SSM ile sunucuda remote-deploy.sh.
# Kullanım: .\deploy\deploy-backend.ps1 [-Profile watchparty] [-Rollback]
param(
    [string]$Profile = "watchparty",
    [switch]$Rollback
)
. (Join-Path $PSScriptRoot "common.ps1")

$repo = $script:RepoRoot
$outputs = Get-InfraOutputs
$release = Get-Date -Format "yyyyMMdd-HHmmss"

if ($Rollback) {
    Write-Host "Geri alma istendi; paket yüklenmeyecek."
    $remoteArgs = "rollback"
} else {
    Write-Host "Testler çalıştırılıyor..."
    & dotnet test (Join-Path $repo "backend/WatchParty.slnx")
    if ($LASTEXITCODE -ne 0) { throw "dotnet test başarısız; deploy durduruldu" }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "watchparty-$release"
    $zip = "$tmp.zip"
    try {
        Write-Host "Publish ediliyor (linux-arm64)..."
        & dotnet publish (Join-Path $repo "backend/WatchParty.Api") -c Release -r linux-arm64 --self-contained false -o $tmp
        if ($LASTEXITCODE -ne 0) { throw "dotnet publish başarısız" }

        # Compress-Archive PS 5.1'de '\' yazar ve Linux'ta unzip bozuk açar; ZipFile '/' yazar.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        if (Test-Path $zip) { Remove-Item $zip -Force }
        [System.IO.Compression.ZipFile]::CreateFromDirectory($tmp, $zip)

        $s3Uri = "s3://$($outputs.deploy_bucket)/backend/$release.zip"
        Write-Host "Yükleniyor: $s3Uri"
        Invoke-Aws s3 cp $zip $s3Uri | Out-Null
    } finally {
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        if (Test-Path $zip) { Remove-Item $zip -Force }
    }
    $remoteArgs = "deploy $s3Uri $release"
}

# remote-deploy.sh içeriği base64 ile gönderilir (CRLF -> LF; autocrlf açık makinelerde gerekli).
$scriptText = ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "remote-deploy.sh"), [System.Text.Encoding]::UTF8)) -replace "`r", ""
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($scriptText))
$command = "echo $b64 | base64 -d > /tmp/remote-deploy.sh && bash /tmp/remote-deploy.sh $remoteArgs"

# Karmaşık tırnaklamadan kaçınmak için istek JSON dosyasıyla verilir.
$request = [ordered]@{
    DocumentName   = "AWS-RunShellScript"
    InstanceIds    = @($outputs.instance_id)
    TimeoutSeconds = 120
    Comment        = "WatchParty backend deploy"
    Parameters     = @{ commands = @($command) }
}
$reqFile = Join-Path ([System.IO.Path]::GetTempPath()) "watchparty-ssm-$release.json"
[System.IO.File]::WriteAllText($reqFile, ($request | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

try {
    Write-Host "SSM komutu gönderiliyor ($($outputs.instance_id))..."
    $sent = Invoke-Aws ssm send-command --cli-input-json ("file://" + ($reqFile -replace "\\", "/")) | ConvertFrom-Json
} finally {
    Remove-Item $reqFile -Force -ErrorAction SilentlyContinue
}
$commandId = $sent.Command.CommandId

Start-Sleep -Seconds 3
try {
    Invoke-Aws ssm wait command-executed --command-id $commandId --instance-id $outputs.instance_id | Out-Null
} catch {
    # Komut hata ile bittiyse wait da hata verir; sonucu aşağıda okuyup raporluyoruz.
    Write-Host "Bekleme sona erdi: $($_.Exception.Message)"
}

# wait zaman aşımına uğradıysa komut hâlâ sürüyor olabilir; bitene kadar yokla.
for ($i = 0; $i -lt 30; $i++) {
    $inv = Invoke-Aws ssm get-command-invocation --command-id $commandId --instance-id $outputs.instance_id | ConvertFrom-Json
    if ($inv.Status -notin @("Pending", "InProgress", "Delayed")) { break }
    Start-Sleep -Seconds 5
}

Write-Host "--- Sunucu çıktısı (stdout) ---"
Write-Host $inv.StandardOutputContent
if ($inv.StandardErrorContent) {
    Write-Host "--- Sunucu çıktısı (stderr) ---"
    Write-Host $inv.StandardErrorContent
}

if ($inv.Status -ne "Success") {
    Write-Host "Deploy BAŞARISIZ (durum: $($inv.Status))."
    exit 1
}
Write-Host "Deploy başarılı."
