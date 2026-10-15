# AWS deploy runbook'u

Mimari: tarayıcı → CloudFront → (varsayılan) S3 site bucket'ı; `/api/*` ve `/hubs/*` → EC2 `t4g.small` (Kestrel :80, systemd). Altyapı `infra/` altında Terraform ile, deploy script'leri bu klasörde (PowerShell). Bölge `eu-north-1` (Stockholm): hesabın bağlı olduğu organizasyonun SCP'si yalnızca bu bölgeye izin veriyor. Alan adı/ACM henüz yok; adres `*.cloudfront.net`.

Tahmini maliyet ~16 $/ay (t4g.small ~12 $, public IPv4 ~3,6 $).

## 1. Araç kurulumu

```powershell
winget install Amazon.AWSCLI
winget install Hashicorp.Terraform
# İsteğe bağlı: aws ssm start-session için Session Manager eklentisi
winget install Amazon.SessionManagerPlugin
```

Kurulumdan sonra yeni bir terminal açın. Ayrıca .NET SDK (`global.json`) ve Node gerekir.

## 2. IAM kullanıcısı ve AWS profili

1. AWS konsolunda bir IAM kullanıcısı oluşturun (şimdilik `AdministratorAccess`; dar yetkili politika kapsam dışı) ve bir access key üretin.
2. Profili tanımlayın (bölge: `eu-north-1`; deploy script'leri bölgeyi profilden alır, Terraform'daki `region` ile aynı olmalı):
   ```powershell
   aws configure --profile watchparty
   aws sts get-caller-identity --profile watchparty   # hesap kimliğini doğrular
   ```

Terraform ve script'ler varsayılan olarak `watchparty` profilini kullanır (`aws_profile` değişkeni, script'lerde `-Profile`).

## 3. Altyapıyı kurma

Terraform state'i S3'te durur (`infra/versions.tf` → `backend "s3"`, bucket `watchparty-tfstate-8b2f65c1`, kilit `use_lockfile`). Bu bucket mevcut; yalnızca **sıfırdan yeni bir hesapta** kurulum yapılıyorsa önce elle oluşturulmalı (Terraform kendi state bucket'ını yönetemez) ve adı `versions.tf`'te güncellenmeli:

```powershell
$b = "watchparty-tfstate-<rastgele-ek>"
aws s3api create-bucket --bucket $b --create-bucket-configuration LocationConstraint=eu-north-1 --profile watchparty
aws s3api put-public-access-block --bucket $b --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true --profile watchparty
aws s3api put-bucket-versioning --bucket $b --versioning-configuration Status=Enabled --profile watchparty
```

```powershell
terraform -chdir=infra init
terraform -chdir=infra apply
```

Çıktılar (`cloudfront_domain`, `distribution_id`, `site_bucket`, `video_bucket`, `deploy_bucket`, `instance_id`, `origin_domain`) script'ler tarafından `terraform output -json` ile okunur. Sunucu ilk açılışta .NET runtime'ı, `watchparty` kullanıcısını, ortam dosyasını ve systemd unit'ini kurar; ilk deploy'a kadar servis başlamaz.

**Videolar.** `tools/downloader` videoları ayrı private `video_bucket`'a yükler (`--s3-bucket (terraform -chdir=..\..\infra output -raw video_bucket)`, `tools/downloader` dizininden çalıştırılırken); CloudFront `/videolar/*` isteklerini oradan verir, link biçimi `https://<cloudfront>/videolar/...` aynı kalır. Yaşam döngüsü: nesneler 30 gün sonra otomatik silinir, yarım çok parçalı yüklemeler 2 günde iptal edilir; CloudFront'taki önbellek en fazla 1 gündür. `--gizli` linkleri tahmin edilemez klasörde durur; elle silmek için `aws s3 rm s3://<video_bucket>/videolar/<klasör>/ --recursive`, hemen kalkması gerekiyorsa ayrıca invalidation (aksi halde en geç 1 gün sonra edge'den düşer). CI deploy rolünün bu bucket'a izni yoktur.

**İlk deploy'dan önce cloud-init'i bekleyin.** Sunucu kurulumu (`user_data`) `apply` bittikten sonra birkaç dakika daha sürer. SSM oturumu açın:

```powershell
aws ssm start-session --target (terraform -chdir=infra output -raw instance_id) --profile watchparty
```

Oturumda kurulumun bitmesini bekleyin ve runtime'ı kontrol edin:

```bash
cloud-init status --wait                   # "status: done" görünmeli
/usr/share/dotnet/dotnet --list-runtimes   # Microsoft.AspNetCore.App 10.0.x görünmeli
```

cloud-init başarısız olduysa (ör. `status: error`) instance'ı yeniden oluşturarak toparlayın: `terraform -chdir=infra apply -replace=aws_instance.api` (EIP ve origin secret aynı kalır).

## 4. İlk deploy

Sıra önemli: önce backend, sonra frontend.

```powershell
deploy\deploy-backend.ps1     # dotnet test -> publish (linux-arm64) -> S3 -> SSM ile kurulum + sağlık kontrolü
deploy\deploy-frontend.ps1    # npm test + build -> S3 sync -> CloudFront invalidation
```

- `-Profile <ad>` ile AWS profili değiştirilebilir.
- `deploy-frontend.ps1 -DryRun` aws komutlarını çalıştırmadan yazdırır.
- Backend yeniden başlayınca bellekteki lobiler düşer (kabul edilmiş kesinti).
- Her backend sürümü `/opt/watchparty/releases/<zaman>/` altına açılır, `/opt/watchparty/current` symlink'i çevrilir; son 5 sürüm tutulur. `localhost/api/health` 20 sn içinde 200 dönmezse sunucu otomatik olarak önceki sürüme döner.

## 5. Smoke testi

```powershell
cd backend\e2e; npm install
$env:BASE_URL   = "https://$(terraform -chdir=..\..\infra output -raw cloudfront_domain)"
$env:ORIGIN_URL = "http://$(terraform -chdir=..\..\infra output -raw origin_domain)"
npm run smoke
Remove-Item Env:BASE_URL, Env:ORIGIN_URL
```

Env değişkenleri temizlenir çünkü `e2e.mjs` da `BASE_URL`'i okur; aynı terminalde yanlışlıkla canlıya karşı çalıştırılırsa prod limitlerine takılır.

Kontroller: `/api/health` 200, `/l/ABCDEF` HTML, `/api/lobbies/ZZZZZZ` 404, CSP header'ı, iki istemciyle SignalR sohbeti, `ORIGIN_URL`'e doğrudan erişimin kapalı olması (`ORIGIN_URL` verilmezse atlanır). Mevcut `e2e.mjs` canlıya karşı **çalıştırılmaz**: tek IP'den çok bağlantı açar ve prod limitlerine takılır.

`/api/health` 400 dönüyorsa `AllowedHosts` (origin DNS adı) uyuşmuyordur; bkz. CLAUDE.md.

## Tarayıcıdan yükleme

Anahtarı olan kişiler lobideki "Bilgisayardan yükle" düğmesiyle MP4 (+ isteğe bağlı altyazı) yükleyebilir. Dosya sunucudan geçmez: backend yükleme anahtarını (`X-Upload-Key`) doğrular ve S3'e kısa süreli (1 saat), dosyaya özel presigned URL'ler üretir; tarayıcı video bucket'ına doğrudan çok parçalı yükler (16 MB parça, 4 eşzamanlı).

- **Sınırlar:** video en fazla 6 GB, `.mp4`/`.m4v`; altyazı en fazla 2 MB, `.srt`/`.vtt`.
- **Konum:** `videolar/<32 hex gizli klasör>/<temizlenmiş ad>` (video bucket'ı); link `https://<cloudfront>/videolar/...`. Yaşam döngüsü aynen geçerli: 30 gün sonra silinir, yarım yüklemeler 2 günde iptal edilir. Elle silmek için yukarıdaki "Videolar" notuna bakın.
- **Yanlış anahtar:** IP başına 10 dakikada en fazla 10 başarısız deneme; sonrası 429.
- **Genel sınırlar:** `/api/uploads/*` istek gövdesi en fazla 64 KB (aşan 413), IP başına dakikada en fazla `Security:UploadPerMinute` istek (varsayılan 120; aşan 429). İkisi de anahtar kontrolünden önce uygulanır.
- **Anahtarlar:** her kişiye ayrı, rastgele 32 karakterlik anahtar. Sunucuda yalnızca ad + **SHA-256 özeti** durur (`/etc/watchparty/watchparty.env`, `Upload__Keys__<i>__Name/Sha256`); açık anahtar repoya, loga ya da konsola yazılmaz.

### İlk kurulum

```powershell
terraform -chdir=infra plan     # video bucket CORS, EC2 rolüne videolar/* yazma izni, CSP connect-src: yerinde güncelleme, 0 destroy
terraform -chdir=infra apply
deploy\deploy-backend.ps1       # yükleme uç noktalarını içeren sürüm
deploy\deploy-frontend.ps1
deploy\upload-keys.ps1 -Init    # ortam dosyasına Upload__VideoBucket ve Upload__PublicBaseUrl'i yazar (tekrar çalıştırılabilir)
deploy\upload-keys.ps1 -Add ayse
```

Anahtar eklenene kadar yükleme kapalıdır (uç noktalar 403 "Yükleme kapalı" döner).

### Anahtar yönetimi

```powershell
deploy\upload-keys.ps1 -Add <ad>      # yeni anahtar üretir
deploy\upload-keys.ps1 -Remove <ad>   # erişimi kaldırır
deploy\upload-keys.ps1 -List          # yalnızca adları listeler
```

Ortak seçenekler: `-Profile <ad>`, `-Force` (onay sorusunu atlar).

- `-Add` anahtarı **ekrana yazmaz**: panoya kopyalar ve yalnızca "Anahtar panoya kopyalandı" der. Kişiye özel bir kanaldan (birebir mesaj) iletin; başka bir şey kopyalamadan önce gönderin, kaybolursa `-Remove` + `-Add` ile yenisini üretin. Özet SSM ile sunucudaki ortam dosyasına yazılır.
- **Uyarı: her anahtar işlemi (`-Init`, `-Add`, `-Remove`) servisi yeniden başlatır ve açık lobileri düşürür.** Script önce uyarır ve onay ister; insanlar izlerken çalıştırmayın.
- Anahtarı kişiye ilettikten sonra panoyu ve Windows pano geçmişini temizleyin (Win+V → "Tümünü temizle"; ya da `Set-Clipboard -Value " "`).
- `-Add`, `-Init`'ten önce çalıştırılırsa "Önce -Init çalıştırın" hatası verir; hiçbir şey yazılmaz.
- **upload-keys.ps1'i aynı anda iki kez çalıştırmayın** (iki terminal ya da iki kişi): her çalıştırma sunucudaki satırları okuyup tamamını yeniden yazar, sonra yazan öncekinin değişikliğini siler.
- SSM sonucu beklenirken zaman aşımı olursa uzak yazma yine de gerçekleşmiş olabilir: durumu `-List` ile kontrol edin; yarım kalmış bir anahtar görürseniz `-Remove` ile silin.
- `-List` yeniden başlatmaz ve onay sormaz. `-Init` ayarlar zaten günceldeyse "zaten güncel" der ve yeniden başlatmaz.
- Yanlış anahtar sınırına takılan IP, doğru anahtarı girse bile 10 dakikalık pencere bitene kadar 429 alır.
- Güvenlik ağı: yazımdan sonra sağlık kontrolü başarısız olursa script önceki ortam dosyasını (`.bak`) geri yükler ve servisi yeniden başlatır.
- **EC2 instance yenilenirse** (`-replace=aws_instance.api` vb.) ortam dosyası `user_data`'dan sıfırdan oluşur ve `Upload__` satırları kaybolur: yükleme "Yükleme kapalı" (403) döner. `-Init` ve ardından anahtarları yeniden ekleyin (eski anahtarlar geri getirilemez; yenilerini verin).
- Kişi anahtarı tarayıcısında "Bu tarayıcıda hatırla" ile saklayabilir (`localStorage` `wp:uploadKey`).
- Sızan anahtar: `-Remove <ad>`, ardından gerekirse yeni `-Add`.
- CORS (yalnızca CloudFront origin'inden `PUT`, `ETag` açık) ve CSP `connect-src` (`https://<video_bucket>.s3.eu-north-1.amazonaws.com`) Terraform'dadır; yükleme tarayıcıda CORS/CSP hatası verirse önce `apply` yapıldığından emin olun.

## 6. Elle kontrol listesi

- [ ] İki farklı tarayıcıda aynı lobide YouTube videosu senkron oynuyor.
- [ ] Fontlar yükleniyor.
- [ ] Tarayıcı konsolunda CSP ihlali yok (WebSocket `wss://` `connect-src 'self'` ile geçmezse CSP'ye `wss://<cloudfront alanı>` eklenir).
- [ ] Bir telefonda deneme yapıldı.
- [ ] 10+ dakika açık kalan lobide WebSocket kopmuyor.

## 7. Rollback

```powershell
deploy\deploy-backend.ps1 -Rollback   # yeni paket yüklemeden current'ı bir önceki sürüme çevirir, sağlık kontrolü yapar
```

Frontend için rollback script'i yok; önceki commit'e geçip (git checkout) `deploy-frontend.ps1`'i yeniden çalıştırın (eski asset'ler bucket'ta kaldığı için açık sayfalar bozulmaz).

## GitHub Actions (CI ve deploy)

**CI** (`.github/workflows/ci.yml`) her push ve PR'da AWS'ye erişmeden dört işi paralel koşar: `backend` (`dotnet test backend/WatchParty.slnx`), `frontend` (`npm ci`, `npm test`, `npm run build`), `infra` (`terraform fmt -check`, `init -backend=false`, `validate`; `infra/tests` Node testleri; `deploy/tests/remote-deploy.test.sh`; `pwsh -NoProfile -File deploy/tests/common.test.ps1`) ve `downloader` (`python -m unittest`). Aynı daldaki eski koşu yeni push gelince iptal edilir.

**Deploy** (`.github/workflows/deploy.yml`) yalnızca elle başlar: GitHub → Actions → Deploy → Run workflow → `hedef` (`frontend` | `backend` | `ikisi`, varsayılan `frontend`). Yalnızca `master`'dan çalışır; sıra her zaman önce backend. İş `windows-latest` üzerinde mevcut `deploy\deploy-backend.ps1 -Profile ""` / `deploy\deploy-frontend.ps1 -Profile ""` script'lerini çalıştırır, ardından canlı smoke testini koşar. Aynı anda tek deploy çalışır. Backend'deki otomatik geri dönüş (sağlık kontrolü) CI'da da aynen geçerlidir.

- **Backend deploy'u bellekteki lobileri düşürür.** İnsanlar izlerken `backend` ya da `ikisi` başlatmayın. CI deploy'unu ilk denerken `hedef=frontend` seçin (lobilere dokunmaz).
- Script'ler `WP_OUTPUTS_FROM_SSM=1` ile çıktıları `terraform output` yerine SSM parametresi `/watchparty/infra-outputs`'tan okur (gizli değer içermez; Terraform her `apply`'da günceller). `-Profile ""` ise `--profile` eklenmemesini sağlar: aws CLI ortamdaki deploy kullanıcısı kimliğini (GitHub secret'ları) kullanır.

### İlk kurulum (tek seferlik)

```powershell
terraform -chdir=infra plan     # deploy kullanıcısı, politikası, SSM parametresi: yalnızca ekleme (N to add, 0 to change, 0 to destroy)
terraform -chdir=infra apply
```

Ardından access key oluşturulur ve **ekrana yazdırılmadan** doğrudan GitHub secret'larına aktarılır (anahtar Terraform state'ine de girmez):

```powershell
$k = aws iam create-access-key --user-name watchparty-github-deploy --profile watchparty --output json | ConvertFrom-Json
$k.AccessKey.AccessKeyId     | gh secret set AWS_ACCESS_KEY_ID
$k.AccessKey.SecretAccessKey | gh secret set AWS_SECRET_ACCESS_KEY
Remove-Variable k
```

Anahtar yenileme: yeni anahtarı aynı şekilde oluşturup secret'lara yazın, bir deploy ile deneyin, eskisini `aws iam delete-access-key --user-name watchparty-github-deploy --access-key-id <eski> --profile watchparty` ile silin (kullanıcı başına en fazla iki anahtar).

### Deploy kullanıcısının sınırları

`watchparty-github-deploy` (`infra/github.tf`) access key'i GitHub secret'larında (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) duran bir IAM kullanıcısıdır. Hesap AWS'nin yeni kayıt deneyiminin Free Tier planında; AWS'nin yönettiği SCP `iam:*Provider*` işlemlerini yasakladığı için anahtarsız OIDC kurulamıyor (hesap Paid Plan'a yükseltilince OIDC'ye dönülebilir, bkz. `docs/BACKLOG.md`).

- Secret'lar yalnızca bu private repodaki iş akışlarına açıktır; deploy iş akışı `master` dışından başlatılırsa ilk adımda durur. Anahtar sızarsa: `aws iam delete-access-key` ile hemen silin, yenisini oluşturun.
- Terraform state bucket'ına (`watchparty-tfstate-*`) hiçbir izni yoktur (state origin secret'ı içerir); `terraform apply` CI'dan çalıştırılmaz.
- `s3:DeleteObject` yoktur (frontend deploy'u hiçbir şey silmez; videolar ayrı bucket'tadır ve bu rol ona erişemez); deploy bucket'ında yalnızca `backend/*` altına yazar.
- Diğer izinler: site bucket'ına yükleme, bu dağıtımda invalidation, bu instance'a `AWS-RunShellScript` ile SSM komutu, yalnızca `/watchparty/infra-outputs` parametresini okuma.
- Kontrol: kullanıcının kendi politikası IAM simülatörüyle denenir. `simulate-principal-policy` bu hesapta kullanılamaz: AWS'nin yönettiği organizasyon kuralları yüzünden yönetici dahil her işlemi `explicitDeny` gösterir. Bunun yerine politika `simulate-custom-policy`'ye verilir (her kontrol ayrı çağrı; birden fazla kaynak verilince sonuçlar birleşir). İlk üç satır `implicitDeny`, sonuncusu `allowed` dönmeli:

  ```powershell
  $pol = (aws iam get-user-policy --user-name watchparty-github-deploy --policy-name deploy --profile watchparty --query PolicyDocument --output json) -join "`n"
  $req = Join-Path $env:TEMP "wp-sim.json"
  foreach ($c in @(
      @("s3:GetObject",    "arn:aws:s3:::watchparty-tfstate-8b2f65c1/watchparty/terraform.tfstate"),
      @("s3:ListBucket",   "arn:aws:s3:::watchparty-tfstate-8b2f65c1"),
      @("s3:DeleteObject", "arn:aws:s3:::watchparty-site-b554977f/index.html"),
      @("s3:PutObject",    "arn:aws:s3:::watchparty-site-b554977f/index.html"))) {
    @{ PolicyInputList = @($pol); ActionNames = @($c[0]); ResourceArns = @($c[1]) } | ConvertTo-Json | Set-Content -Encoding ascii $req
    $d = aws iam simulate-custom-policy --cli-input-json "file://$req" --profile watchparty --query "EvaluationResults[0].EvalDecision" --output text
    "{0,-16} {1,-14} {2}" -f $c[0], $d, $c[1]
  }
  Remove-Item $req
  ```

Lokal deploy aynen çalışmaya devam eder (`deploy\deploy-*.ps1`, varsayılan `-Profile watchparty`, çıktılar `terraform output`'tan). `deploy/common.ps1` testi: `powershell -NoProfile -File deploy/tests/common.test.ps1`.

## İzleme ve alarmlar

`infra/monitoring.tf` kurar; bildirimler SNS üzerinden `infra/terraform.tfvars` içindeki `alert_email` adresine gider (dosya gitignore'da; yeni makinede `alert_email = "..."` satırıyla oluşturun). AWS'nin gönderdiği abonelik onay e-postasındaki linke tıklanmadan bildirim gelmez.

- **`watchparty-site-down`**: `watchparty-health-check` Lambda'sı 5 dakikada bir `https://<cloudfront>/api/health`'i çağırır; art arda 2 başarısızlık ya da hiç çalışmama alarm verir. CloudFront + EC2 + uygulamayı birlikte sınar. (Organizasyon SCP'si yalnızca eu-north-1'e izin verdiği için Route 53 health check ve CloudFront metrikleri kullanılamıyor.)
- **`watchparty-ec2-system-check`**: AWS tarafı donanım sorunu; instance otomatik olarak sağlam bir makineye taşınır (`recover`, EIP ve disk aynı kalır).
- **`watchparty-ec2-instance-check`**: işletim sistemi tarafı sorun; yalnızca bildirim.
- **`watchparty-ec2-cpu-high`**: CPU 15 dakika %80 üstü.

Bildirim zincirini denemek için (gerçek durumu değiştirmez, bir sonraki ölçümde alarm OK'a döner):

```powershell
aws cloudwatch set-alarm-state --alarm-name watchparty-site-down --state-value ALARM --state-reason "Test" --profile watchparty
```

## 8. Log okuma

SSH portu yok; erişim SSM ile:

```powershell
aws ssm start-session --target (terraform -chdir=infra output -raw instance_id) --profile watchparty
```

```bash
sudo journalctl -u watchparty -n 200
sudo systemctl status watchparty
```

## Bakım: sunucu yapılandırması

`aws_instance.api` üzerinde `ignore_changes = [ami, user_data]` vardır; `user_data` değişiklikleri çalışan instance'a uygulanmaz. `deploy/watchparty.service` veya ortam dosyası şablonunu (ya da bootstrap script'ini) değiştirirseniz yeni halin sunucuya gelmesi için:

```powershell
terraform -chdir=infra apply -replace=aws_instance.api
```

EIP ve origin secret aynı kalır; bellekteki lobiler kaybolur, ardından backend'i yeniden deploy edin.

## Sesli sohbet (ICE sunucuları)

Sesli sohbet tarayıcılar arasında doğrudan (WebRTC) çalışır; sunucudan ses geçmez, ek bir port ya da servis gerekmez. Tarayıcılara verilecek ICE sunucuları `Voice:IceServers` ayarından gelir. Ayar verilmezse varsayılan tek STUN (`stun:stun.l.google.com:19302`) kullanılır. Sunucuda `/etc/watchparty/watchparty.env` içinde ortam değişkeniyle ayarlanır:

```
Voice__IceServers__0__Urls__0=stun:stun.l.google.com:19302
# TURN, varsayılan STUN'un yanına eklenecekse indeks 1 kullanılır (indeks 0 varsayılanı değiştirir):
Voice__IceServers__1__Urls__0=turn:turn.example.com:3478
Voice__IceServers__1__Username=kullanici
Voice__IceServers__1__Credential=sifre
```

Değişiklik için servisi yeniden başlatın (`sudo systemctl restart watchparty`). Başlangıçta doğrulanır: her sunucuda en az bir URL olmalı ve `stun:`, `stuns:`, `turn:` ya da `turns:` ile başlamalı; geçersizse servis açılmaz.

TURN sunucusunun kendisini kurmak (coturn ya da bir hizmet, güvenlik grubunda UDP/TCP 3478 ve ilişkili port aralığı) ayrı bir iştir ve yapılmadı (bkz. `docs/BACKLOG.md`). Şimdilik yalnızca STUN var; bazı ağlarda (simetrik NAT, kurumsal güvenlik duvarı) kişi "Bağlanamadı" görür.

## 9. Kaldırma

```powershell
terraform -chdir=infra destroy
```

Bucket'larda `force_destroy = true` olduğundan içerikleriyle birlikte silinir. State bucket'ı (`watchparty-tfstate-*`) Terraform'un dışında olduğu için `destroy` ile silinmez; artık gerekmiyorsa elle silin (versioning açık, önce tüm sürümleri silmek gerekir).

## Terraform state'i hassastır

State S3'tedir (`s3://watchparty-tfstate-8b2f65c1/watchparty/terraform.tfstate`): versioning açık (eski sürümler geri getirilebilir), sunucu tarafı şifreli, public erişim kapalı ve yalnızca HTTPS kabul edilir. Aynı anda iki `apply` çalışmasını S3 kilidi engeller. State düz metin **origin secret**'ı (`X-Origin-Verify`) içerdiğinden bu bucket'a erişim yetkisi olan herkes secret'ı okuyabilir; lokale indirilmemeli, paylaşılmamalı. `*.tfstate`, `*.tfvars` ve `infra/.terraform/` repoya girmez; `infra/.terraform.lock.hcl` girer.
