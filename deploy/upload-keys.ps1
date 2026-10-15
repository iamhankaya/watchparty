# Yükleme anahtarlarını yönetir: sunucudaki /etc/watchparty/watchparty.env'e SSM ile özet (SHA-256) yazar.
# Kullanım:
#   .\deploy\upload-keys.ps1 -Init   [-Force] [-Profile watchparty]   # Upload__VideoBucket / Upload__PublicBaseUrl
#   .\deploy\upload-keys.ps1 -Add <ad> [-Force] [-Profile watchparty]  # yeni anahtar; açık hali yalnızca panoya kopyalanır
#   .\deploy\upload-keys.ps1 -Remove <ad> [-Force] [-Profile watchparty]
#   .\deploy\upload-keys.ps1 -List [-Profile watchparty]               # yalnızca adlar
# Açık anahtar asla konsola, loga, dosyaya ya da SSM komutuna yazılmaz; sunucuya yalnızca özeti gider.
# Ortam dosyasının yalnızca Upload__ satırları okunur/yazılır (OriginSecret gibi diğer değerler sunucudan çıkmaz).
param(
    [switch]$Init,
    [string]$Add,
    [string]$Remove,
    [switch]$List,
    [switch]$Force,
    [string]$Profile = "watchparty"
)
. (Join-Path $PSScriptRoot "common.ps1")

$script:EnvFile = "/etc/watchparty/watchparty.env"
$script:NamePattern = '^[a-z0-9-]{1,32}\z'
$script:Base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

# 32 karakterlik base62 anahtar. Reddetme örneklemesi: 248 = 62*4'ten küçük baytlar kabul edilir,
# böylece her karakter eşit olasılıklıdır (mod yanlılığı yok).
function New-UploadKey {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $sb = New-Object System.Text.StringBuilder
        $buf = New-Object byte[] 64
        while ($sb.Length -lt 32) {
            $rng.GetBytes($buf)
            foreach ($b in $buf) {
                if ($b -lt 248 -and $sb.Length -lt 32) { [void]$sb.Append($script:Base62[$b % 62]) }
            }
        }
        return $sb.ToString()
    } finally {
        $rng.Dispose()
    }
}

# UTF-8 baytlarının SHA-256 özeti, küçük harf hex (sunucu X-Upload-Key'i aynı biçimde özetler).
function Get-Sha256Hex([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    } finally {
        $sha.Dispose()
    }
    return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
}

# Ortam dosyası içeriğini ayrıştırır: anahtar kayıtları (indeks sırasıyla) ve diğer satırlar.
function ConvertFrom-EnvContent([string]$Content) {
    $other = New-Object System.Collections.Generic.List[string]
    $byIndex = @{}
    foreach ($raw in ($Content -split "`n")) {
        $line = $raw.TrimEnd("`r")
        if ($line -eq "") { continue }
        if ($line -cmatch '^Upload__Keys__(\d+)__(Name|Sha256)=(.*)$') {
            $i = [int]$Matches[1]
            if (-not $byIndex.ContainsKey($i)) { $byIndex[$i] = @{ Name = $null; Sha256 = $null } }
            $byIndex[$i][$Matches[2]] = $Matches[3]
            continue
        }
        $other.Add($line)
    }
    $keys = @()
    foreach ($i in ($byIndex.Keys | Sort-Object)) {
        $e = $byIndex[$i]
        if (-not $e.Name -or -not $e.Sha256) { throw "Ortam dosyasında eksik anahtar kaydı (indeks $i)" }
        $keys += , ([pscustomobject]@{ Name = $e.Name; Sha256 = $e.Sha256 })
    }
    return [pscustomobject]@{ Other = $other; Keys = $keys }
}

# Saf fonksiyon: ortam dosyası içeriğini düzenler ve yeni içeriği döndürür (LF, sonda satır sonu).
# Anahtar kayıtları her zaman 0'dan başlayarak ardışık indekslerle, dosyanın sonuna yazılır.
function Update-EnvContent {
    param(
        [AllowEmptyString()][string]$Content,
        [Parameter(Mandatory = $true)][ValidateSet("Init", "Add", "Remove")][string]$Action,
        [string]$Name,
        [string]$Sha256,
        [string]$VideoBucket,
        [string]$PublicBaseUrl
    )
    $parsed = ConvertFrom-EnvContent $Content
    $other = $parsed.Other
    $keys = @($parsed.Keys)

    switch ($Action) {
        "Init" {
            if (-not $VideoBucket) { throw "Video bucket adı boş" }
            if (-not $PublicBaseUrl) { throw "Genel adres (PublicBaseUrl) boş" }
            foreach ($pair in @(@("Upload__VideoBucket", $VideoBucket), @("Upload__PublicBaseUrl", $PublicBaseUrl))) {
                $prefix = $pair[0] + "="
                $newLine = $prefix + $pair[1]
                $found = $false
                for ($i = 0; $i -lt $other.Count; $i++) {
                    if ($other[$i].StartsWith($prefix)) { $other[$i] = $newLine; $found = $true }
                }
                if (-not $found) { $other.Add($newLine) }
            }
        }
        "Add" {
            if ($Name -cnotmatch $script:NamePattern) { throw "Geçersiz anahtar adı '$Name' (yalnızca a-z, 0-9, '-'; en fazla 32 karakter)" }
            if ($Sha256 -cnotmatch '^[0-9a-f]{64}\z') { throw "Geçersiz SHA-256 özeti" }
            if ($keys | Where-Object { $_.Name -eq $Name }) { throw "'$Name' adlı anahtar zaten var" }
            $keys += , ([pscustomobject]@{ Name = $Name; Sha256 = $Sha256 })
        }
        "Remove" {
            if ($Name -cnotmatch $script:NamePattern) { throw "Geçersiz anahtar adı '$Name'" }
            if (-not ($keys | Where-Object { $_.Name -eq $Name })) { throw "'$Name' adlı anahtar bulunamadı" }
            $keys = @($keys | Where-Object { $_.Name -ne $Name })
        }
    }

    return (Format-EnvContent ([pscustomobject]@{ Other = $other; Keys = $keys }))
}

# Ayrıştırılmış içeriği metne çevirir: önce diğer satırlar, sonra 0'dan ardışık anahtar kayıtları.
function Format-EnvContent($Parsed) {
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($l in $Parsed.Other) { $out.Add($l) }
    $keys = @($Parsed.Keys)
    for ($i = 0; $i -lt $keys.Count; $i++) {
        $out.Add("Upload__Keys__${i}__Name=$($keys[$i].Name)")
        $out.Add("Upload__Keys__${i}__Sha256=$($keys[$i].Sha256)")
    }
    if ($out.Count -eq 0) { return "" }
    return (($out -join "`n") + "`n")
}

# Kayıtlı anahtar adlarını indeks sırasıyla döndürür.
function Get-UploadKeyNames([string]$Content) {
    return @((ConvertFrom-EnvContent $Content).Keys | ForEach-Object { $_.Name })
}

# Sunucuda AWS-RunShellScript ile komut çalıştırır; bitene kadar bekler, invocation nesnesini döndürür.
function Invoke-RemoteShell([string]$InstanceId, [string[]]$Commands, [string]$Comment) {
    $request = [ordered]@{
        DocumentName   = "AWS-RunShellScript"
        InstanceIds    = @($InstanceId)
        TimeoutSeconds = 120
        Comment        = $Comment
        Parameters     = @{ commands = $Commands }
    }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $reqFile = Join-Path ([System.IO.Path]::GetTempPath()) "watchparty-keys-$stamp.json"
    [System.IO.File]::WriteAllText($reqFile, ($request | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    try {
        $sent = Invoke-Aws ssm send-command --cli-input-json ("file://" + ($reqFile -replace "\\", "/")) | ConvertFrom-Json
    } finally {
        Remove-Item $reqFile -Force -ErrorAction SilentlyContinue
    }
    $commandId = $sent.Command.CommandId

    Start-Sleep -Seconds 2
    $inv = $null
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $inv = Invoke-Aws ssm get-command-invocation --command-id $commandId --instance-id $InstanceId | ConvertFrom-Json
        } catch {
            # Komut henüz kaydedilmemiş olabilir (InvocationDoesNotExist); yeniden dene.
            $inv = $null
        }
        if ($inv -and $inv.Status -notin @("Pending", "InProgress", "Delayed")) { break }
        Start-Sleep -Seconds 2
    }
    # Zaman aşımı: komut sunucuda hâlâ çalışıyor ya da bitmiş olabilir; yazma işlemi gerçekleşmiş sayılmalı.
    if (-not $inv -or $inv.Status -in @("Pending", "InProgress", "Delayed")) {
        throw "SSM komutunun sonucu beklenirken zaman aşımı ($commandId); uzak işlem yine de tamamlanmış olabilir. Durumu -List ile kontrol edin; gerekirse -Remove"
    }
    return $inv
}

# Sunucudaki ortam dosyasının yalnızca Upload__ satırlarını okur.
function Read-RemoteUploadLines([string]$InstanceId) {
    $inv = Invoke-RemoteShell $InstanceId @("grep '^Upload__' $script:EnvFile || true") "WatchParty yükleme anahtarları: okuma"
    if ($inv.Status -ne "Success") {
        throw "Ortam dosyası okunamadı (durum: $($inv.Status)): $($inv.StandardErrorContent)"
    }
    return [string]$inv.StandardOutputContent
}

# Sunucuda çalışacak yazma script'i (LF): Upload__ satırlarını verilen içerikle değiştirir (diğer satırlar korunur),
# önceki dosyayı .bak olarak saklar, servisi yeniden başlatır ve sağlık kontrolü yapar.
# Sağlık kontrolü başarısızsa .bak geri yüklenir ve servis yeniden başlatılır.
# grep -v hiç satır kalmayınca 1 döner (normal); 2 (okuma/G-Ç hatası) set -e ile dosya değiştirilmeden durdurur.
function Get-RemoteWriteScript([string]$UploadLines) {
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($UploadLines))
    $f = $script:EnvFile
    $remote = @"
set -eu
F=$f
umask 077
cp -p "`$F" "`$F.bak"
grep -v '^Upload__' "`$F" > "`$F.new" || [ `$? -eq 1 ]
echo '$b64' | base64 -d >> "`$F.new"
chown root:root "`$F.new"
chmod 600 "`$F.new"
mv -f "`$F.new" "`$F"
systemctl restart watchparty
for i in `$(seq 1 20); do
  if curl -fsS --connect-timeout 2 --max-time 2 -o /dev/null http://localhost/api/health; then
    echo "Sağlık kontrolü başarılı."
    exit 0
  fi
  sleep 1
done
echo "HATA: sağlık kontrolü başarısız; önceki ortam dosyası geri yükleniyor."
cp -p "`$F.bak" "`$F"
systemctl restart watchparty
exit 1
"@
    return ($remote -replace "`r", "")
}

function Write-RemoteUploadLines([string]$InstanceId, [string]$UploadLines) {
    $inv = Invoke-RemoteShell $InstanceId @(Get-RemoteWriteScript $UploadLines) "WatchParty yükleme anahtarları: yazma"
    if ($inv.StandardOutputContent) { Write-Host $inv.StandardOutputContent.TrimEnd() }
    if ($inv.Status -ne "Success") {
        throw "Ortam dosyası güncellenemedi (durum: $($inv.Status)): $($inv.StandardErrorContent)"
    }
}

# Yeniden başlatma uyarısı; -Force yoksa onay ister.
function Confirm-Restart([bool]$Skip) {
    Write-Host "Bu işlem sunucuyu yeniden başlatır; açık lobiler düşer."
    if ($Skip) { return }
    $answer = Read-Host "Devam edilsin mi? (e/h)"
    if ($answer -notin @("e", "E", "evet", "Evet")) { throw "İptal edildi." }
}

function Invoke-UploadKeys {
    param(
        [switch]$Init,
        [string]$Add,
        [string]$Remove,
        [switch]$List,
        [switch]$Force
    )
    $actions = @($Init.IsPresent, [bool]$Add, [bool]$Remove, $List.IsPresent) | Where-Object { $_ }
    if (@($actions).Count -ne 1) { throw "Tam olarak bir işlem verin: -Init, -Add <ad>, -Remove <ad> ya da -List" }

    $outputs = Get-InfraOutputs
    $instanceId = $outputs.instance_id
    $current = Read-RemoteUploadLines $instanceId

    if ($List) {
        $names = Get-UploadKeyNames $current
        if ($names.Count -eq 0) { Write-Host "Kayıtlı yükleme anahtarı yok." }
        foreach ($n in $names) { Write-Host $n }
        return
    }

    if ($Init) {
        if (-not $outputs.PSObject.Properties["video_bucket"] -or -not $outputs.video_bucket) {
            throw "infra çıktıları eksik (video_bucket); önce terraform apply"
        }
        $new = Update-EnvContent -Content $current -Action Init -VideoBucket $outputs.video_bucket -PublicBaseUrl ("https://" + $outputs.cloudfront_domain)
        if ($new -eq (Format-EnvContent (ConvertFrom-EnvContent $current))) {
            Write-Host "Upload ayarları zaten güncel; değişiklik yok."
            return
        }
        Confirm-Restart $Force.IsPresent
        Write-RemoteUploadLines $instanceId $new
        Write-Host "Upload ayarları yazıldı."
        return
    }

    if ($Remove) {
        $new = Update-EnvContent -Content $current -Action Remove -Name $Remove
        Confirm-Restart $Force.IsPresent
        Write-RemoteUploadLines $instanceId $new
        Write-Host "Anahtar silindi ($Remove)."
        return
    }

    # -Add, -Init'ten önce çalıştırılırsa sunucu anahtarı kabul eder ama yükleme ayarları eksik kalır.
    if ($current -cnotmatch '(?m)^Upload__VideoBucket=') { throw "Önce -Init çalıştırın" }

    # -Add: açık anahtar yalnızca bu fonksiyonun yerel değişkeninde ve panoda durur.
    $key = New-UploadKey
    try {
        $new = Update-EnvContent -Content $current -Action Add -Name $Add -Sha256 (Get-Sha256Hex $key)
        Confirm-Restart $Force.IsPresent
        Write-RemoteUploadLines $instanceId $new
        Set-Clipboard -Value $key
        Write-Host "Anahtar panoya kopyalandı ($Add)"
    } finally {
        $key = $null
    }
}

# Test dosyası dot-source ettiğinde (. .\upload-keys.ps1) yalnızca fonksiyonlar tanımlanır.
if ($MyInvocation.InvocationName -ne ".") {
    try {
        Invoke-UploadKeys -Init:$Init -Add $Add -Remove $Remove -List:$List -Force:$Force
    } catch {
        Write-Host "HATA: $($_.Exception.Message)"
        exit 1
    }
}
