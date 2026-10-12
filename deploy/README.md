# AWS deploy runbook'u

Mimari: tarayıcı → CloudFront → (varsayılan) S3 site bucket'ı; `/api/*` ve `/hubs/*` → EC2 `t4g.small` (Kestrel :80, systemd). Altyapı `infra/` altında Terraform ile, deploy script'leri bu klasörde (PowerShell). Bölge `eu-central-1`. Alan adı/ACM henüz yok; adres `*.cloudfront.net`.

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
2. Profili tanımlayın (bölge: `eu-central-1`):
   ```powershell
   aws configure --profile watchparty
   aws sts get-caller-identity --profile watchparty   # hesap kimliğini doğrular
   ```

Terraform ve script'ler varsayılan olarak `watchparty` profilini kullanır (`aws_profile` değişkeni, script'lerde `-Profile`).

## 3. Altyapıyı kurma

```powershell
terraform -chdir=infra init
terraform -chdir=infra apply
```

Çıktılar (`cloudfront_domain`, `distribution_id`, `site_bucket`, `deploy_bucket`, `instance_id`, `origin_domain`) script'ler tarafından `terraform output -json` ile okunur. Sunucu ilk açılışta .NET runtime'ı, `watchparty` kullanıcısını, ortam dosyasını ve systemd unit'ini kurar; ilk deploy'a kadar servis başlamaz.

**Runtime kontrolü** (ilk `apply`'dan birkaç dakika sonra, aşağıdaki SSM oturumunda):

```bash
/usr/share/dotnet/dotnet --list-runtimes   # Microsoft.AspNetCore.App 10.0.x görünmeli
```

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
```

Kontroller: `/api/health` 200, `/l/ABCDEF` HTML, `/api/lobbies/ZZZZZZ` 404, CSP header'ı, iki istemciyle SignalR sohbeti, `ORIGIN_URL`'e doğrudan erişimin kapalı olması (`ORIGIN_URL` verilmezse atlanır). Mevcut `e2e.mjs` canlıya karşı **çalıştırılmaz**: tek IP'den çok bağlantı açar ve prod limitlerine takılır.

`/api/health` 400 dönüyorsa `AllowedHosts` (origin DNS adı) uyuşmuyordur; bkz. CLAUDE.md.

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

Frontend için rollback script'i yok; önceki commit'i çıkış yapıp `deploy-frontend.ps1`'i yeniden çalıştırın (eski asset'ler bucket'ta kaldığı için açık sayfalar bozulmaz).

## 8. Log okuma

SSH portu yok; erişim SSM ile:

```powershell
aws ssm start-session --target (terraform -chdir=infra output -raw instance_id) --profile watchparty
```

```bash
sudo journalctl -u watchparty -n 200
sudo systemctl status watchparty
```

## 9. Kaldırma

```powershell
terraform -chdir=infra destroy
```

Bucket'larda `force_destroy = true` olduğundan içerikleriyle birlikte silinir.

## Terraform state'i hassastır

State lokaldir (`infra/terraform.tfstate`, gitignore'da) ve düz metin **origin secret**'ı (`X-Origin-Verify`) içerir. Repoya girmemeli, paylaşılmamalı ve güvenli bir yere yedeklenmelidir; kaybedilirse Terraform mevcut kaynakları yönetemez. `*.tfvars` ve `infra/.terraform/` de repoya girmez; `infra/.terraform.lock.hcl` girer.
