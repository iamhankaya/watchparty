# AWS'ye deploy (spec)

Kaynak: 2026-10-12 deployment brainstorming'i. Hedef CLAUDE.md'de "planned, not yet in the repo" olarak duran kurulum: `dist/` S3 + CloudFront'tan, backend EC2'den; CloudFront `/api` ve `/hubs`'ı EC2'ye yönlendirir (CORS yok).

## Kararlar

| Konu | Karar |
|------|-------|
| AWS hesabı | Var; bu makinede AWS CLI henüz kurulu/yapılandırılmış değil |
| Alan adı | Şimdilik yok; `*.cloudfront.net` adresi. Alan adı/ACM sonradan eklenecek şekilde değişkenle hazırlanır |
| Altyapı | Terraform (`infra/`), lokal state |
| Backend çalıştırma | systemd + framework-dependent publish, sunucuda ASP.NET Core 10 runtime |
| Bölge / sunucu | `eu-central-1`, `t4g.small` (ARM, 2 GB), Amazon Linux 2023; publish `linux-arm64` |
| CloudFront → EC2 | HTTP:80; güvenlik grubu yalnızca CloudFront origin-facing prefix list; gizli `X-Origin-Verify` header'ı |
| Ortam | Tek prod |
| Deploy | Lokal PowerShell script'leri (`deploy/`) |
| Sunucu erişimi | SSM (SSH portu yok) |
| Deploy kesintisi | Kabul: backend yeniden başlayınca bellekteki lobiler düşer |

## Kapsam

### 1. AWS yapısı (`infra/`, Terraform)

```
Tarayıcı ──HTTPS──> CloudFront (xxxx.cloudfront.net)
                     ├─ varsayılan  → S3 site bucket (private, OAC)
                     │    └─ CloudFront Function (viewer-request): uzantısız yollar → /index.html
                     ├─ /api/*  ┐
                     └─ /hubs/* ┴─HTTP:80 + X-Origin-Verify──> EC2 t4g.small (Elastic IP)
                                                                Kestrel :80, systemd
```

- **Site bucket:** private, erişim yalnızca CloudFront OAC ile. Varsayılan behavior `CachingOptimized` (origin'in `Cache-Control`'ü geçerli).
- **SPA yönlendirmesi:** yalnızca varsayılan (S3) behavior'a bağlı CloudFront Function; son path segmentinde nokta olmayan istekleri `/index.html`'e yeniden yazar. CloudFront custom error response (403/404 → index.html) **kullanılmaz**: dağıtımın tamamına uygulandığı için `GET /api/lobbies/{code}`'un 404'ünü 200 HTML'e çevirir ve `lib/api.ts`'in "lobi bulunamadı" akışını bozar.
- **`/api/*` ve `/hubs/*` behavior'ları:** cache policy `CachingDisabled`, origin request policy `AllViewerExceptHostHeader` (SignalR `?id=`, `Sec-WebSocket-*` header'ları ve cookie'ler origin'e gider), tüm HTTP metodları, viewer protokolü `redirect-to-https`. Origin custom header: `X-Origin-Verify: <secret>`.
- **Response headers policy (tüm behavior'lar):**
  - `Content-Security-Policy`:
    `default-src 'self'; script-src 'self' https://www.youtube.com; frame-src https://www.youtube.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
    (WebSocket `wss://` bağlantısının `connect-src 'self'` ile kabul edildiği canlıda doğrulanır; gerekirse `wss://<cloudfront alanı>` eklenir.)
  - `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- **EC2:** Amazon Linux 2023 arm64 AMI (SSM parametresinden en güncel), `t4g.small`, Elastic IP (CloudFront origin adı = EIP'nin public DNS'i, durdur/başlat sonrası değişmez).
  - Güvenlik grubu inbound: TCP 80 yalnızca `com.amazonaws.global.cloudfront.origin-facing` managed prefix list'ten. Başka inbound yok. Outbound: tümü.
  - IAM instance profile: `AmazonSSMManagedInstanceCore` + deploy bucket'ından `s3:GetObject`.
  - `user_data` (ilk açılış): `dotnet-install.sh --runtime aspnetcore --channel 10.0` ile `/usr/share/dotnet`; `watchparty` sistem kullanıcısı; `/opt/watchparty/releases/`; `/etc/watchparty/watchparty.env` (mod 600, root); systemd unit kurulumu ve `enable`. İlk sürüm henüz yüklenmediği için servis ilk deploy'a kadar başlamaz.
- **Deploy bucket:** ayrı, private; `backend/<zaman>.zip` paketleri. 30 gün sonra silen lifecycle kuralı.
- **Sırlar:** origin secret `random_password` ile üretilir; Terraform state'inde düz metin durur, bu yüzden state ve `*.tfvars` gitignore'dadır ve state dosyası hassastır.
- **Çıktılar:** `cloudfront_domain`, `distribution_id`, `site_bucket`, `deploy_bucket`, `instance_id`, `origin_domain`. Deploy script'leri bunları `terraform output -json` ile okur.
- **Kaldırma:** `terraform destroy`; bucket'larda `force_destroy = true`.
- **Tahmini maliyet:** ~16 $/ay (t4g.small ~12 $, public IPv4 ~3,6 $, S3/CloudFront düşük trafikte cent düzeyinde).

### 2. Backend değişiklikleri

- **Origin doğrulaması** (`Security/` altında yeni middleware):
  - Yeni ayar `Security:OriginSecret` (`SecurityOptions`, varsayılan boş).
  - Ayar doluysa: `X-Origin-Verify` header'ı ayarla eşleşmeyen her istek **403** alır (WebSocket upgrade ve hub negotiate dahil). Karşılaştırma `CryptographicOperations.FixedTimeEquals` ile.
  - Bağlantının gerçek uzak adresi loopback ise kontrol atlanır (sunucu içinden `curl localhost/api/health`). Bu yüzden middleware `UseForwardedHeaders`'tan **önce** çalışır; `X-Forwarded-For` uzak adresi değiştirmeden karar verilir.
  - Pipeline'ın ilk middleware'idir; reddedilen istekler rate limiter'a ve hub'a ulaşmaz.
  - Ayar boşsa davranış değişmez (geliştirme, xUnit testleri, e2e).
- **Prod yapılandırması kodda değil**, sunucudaki ortam dosyasında (`/etc/watchparty/watchparty.env`, Terraform `user_data` ile yazılır):
  ```
  ASPNETCORE_ENVIRONMENT=Production
  ASPNETCORE_URLS=http://0.0.0.0:80
  Security__TrustForwardedHeaders=true
  Security__OriginSecret=<random_password>
  AllowedHosts=<EIP public DNS>;localhost
  ```
  `AllowedHosts` kullanıcının gördüğü CloudFront adresi değil, origin adıdır: `AllViewerExceptHostHeader` ile CloudFront origin'e Host olarak origin alan adını gönderir.
- **systemd unit** (`deploy/watchparty.service`): `User=watchparty`, `AmbientCapabilities=CAP_NET_BIND_SERVICE` (root olmadan :80), `EnvironmentFile=/etc/watchparty/watchparty.env`, `WorkingDirectory=/opt/watchparty/current`, `ExecStart=/usr/share/dotnet/dotnet WatchParty.Api.dll`, `Restart=always`, loglar journald'a.
- **Sürümleme:** her deploy `/opt/watchparty/releases/<zaman>/` altına açılır, `/opt/watchparty/current` symlink'i çevrilir; son 5 sürüm tutulur.

### 3. Frontend değişikliği

- `index.html`'deki inline tema script'i `public/theme-init.js`'e taşınır ve `<head>`'de senkron `<script src="/theme-init.js">` olarak yüklenir (async/defer/module değil; sayfa çizilmeden çalışmaya devam eder). Böylece CSP'de inline script hash'i gerekmez.

### 4. Deploy script'leri (`deploy/`, PowerShell)

Ortak: AWS profili `watchparty` (parametreyle değiştirilebilir); değerler `terraform -chdir=infra output -json`'dan okunur.

- **`deploy-backend.ps1`:**
  1. `dotnet test backend/WatchParty.slnx`; başarısızsa durur.
  2. `dotnet publish backend/WatchParty.Api -c Release -r linux-arm64 --self-contained false` → zip → `s3://<deploy>/backend/<zaman>.zip`.
  3. `aws ssm send-command` (`AWS-RunShellScript`): zip'i indir, `releases/<zaman>`'a aç, sahipliği `watchparty`'ye ver, önceki `current` hedefini kaydet, `current`'ı çevir, `systemctl restart watchparty`, `localhost/api/health` 20 sn içinde 200 dönmezse `current`'ı önceki hedefe geri çevirip yeniden başlat ve hata koduyla çık; başarılıysa eski sürümleri 5'e indir.
  4. Komut bitene kadar bekler, çıktısını yazdırır, sunucudaki hata kodunu kendi çıkış koduna yansıtır.
  - `-Rollback`: yeni paket yüklemeden `current`'ı bir önceki sürüme çevirir ve sağlık kontrolü yapar.
- **`deploy-frontend.ps1`:**
  1. `npm test` ve `npm run build` (`frontend/`).
  2. `aws s3 sync dist/assets s3://<site>/assets --cache-control "public, max-age=31536000, immutable"` (`--delete` yok; açık sayfaların eski JS'i yükleyebilmesi için eski asset'ler kalır).
  3. Kalan dosyalar (`index.html`, `theme-init.js`) `--cache-control "no-cache"` ile.
  4. `aws cloudfront create-invalidation --paths /index.html /theme-init.js`.
- **Sıra:** ikisi birden değiştiyse önce backend, sonra frontend.

### 5. Doğrulama

- **`backend/e2e/smoke.mjs`** (yeni; `BASE_URL` = CloudFront adresi, `ORIGIN_URL` = EC2 adresi):
  - `GET /api/health` → 200.
  - `GET /l/ABCDEF` → 200 ve HTML (`index.html`).
  - `GET /api/lobbies/ZZZZZZ` → 404 (SPA yönlendirmesi API'yi bozmamış).
  - Ana sayfa yanıtında `content-security-policy` header'ı var.
  - SignalR: lobi oluştur, iki istemciyle katıl, sohbet mesajı karşı tarafa ulaşır.
  - `ORIGIN_URL`'e doğrudan istek 5 sn içinde bağlantı kuramaz (güvenlik grubu).
  - Mevcut `e2e.mjs` canlıya karşı çalıştırılmaz: tek IP'den çok bağlantı açar ve prod limitlerine takılır.
- **Elle kontrol listesi (runbook'ta):** iki farklı tarayıcıda aynı lobide YouTube videosu senkron oynar; fontlar yüklenir; tarayıcı konsolunda CSP ihlali yok; bir telefon testi; 10+ dakika açık kalan lobide WebSocket kopmuyor.

### 6. Dokümantasyon

- `deploy/README.md` runbook'u: AWS CLI v2, Terraform ve (isteğe bağlı) Session Manager eklentisi kurulumu; IAM kullanıcısı ve `aws configure --profile watchparty`; ilk `terraform init/apply`; deploy; rollback; log okuma (`journalctl` SSM üzerinden); `terraform destroy`; elle kontrol listesi.
- CLAUDE.md: "planned, not yet in the repo" satırı yerine gerçek deploy bölümü (dosyalar, komutlar, origin secret, AllowedHosts ilişkisi).
- `frontend/README.md` "Bilinen sınırlar": SPA yönlendirmesinin CloudFront Function ile yapıldığı notu.
- `.gitignore`e eklenir: `infra/.terraform/`, `*.tfstate`, `*.tfstate.*`, `*.tfvars`. `infra/.terraform.lock.hcl` ise commit'lenir (sağlayıcı sürümlerini sabitler).

## Kapsam dışı

- Alan adı ve ACM sertifikası (Terraform'da opsiyonel değişkenler için yer bırakılır, uygulanmaz).
- CI/CD (GitHub Actions); repoda henüz remote yok.
- CloudWatch alarmları, log toplama, izleme.
- Remote Terraform state (S3 + kilit).
- Admin yerine dar yetkili IAM politikası.
- Deploy öncesi lobilere uyarı mesajı.
- Medya id 200 karakter sınırı (README "Bilinen sınırlar").

## Riskler

- **.NET 10 runtime AL2023 arm64 kurulumu** `dotnet-install.sh` ile; ilk `apply` sonrası SSM ile `dotnet --list-runtimes` doğrulanır.
- **CloudFront üzerinden uzun süreli WebSocket:** SignalR'ın 15 sn keep-alive'ı CloudFront'un idle süresinin altında; canlıda 10+ dakika test edilir.
- **`AllowedHosts` uyuşmazlığı:** yanlış değer tüm isteklere 400 döndürür; smoke testin ilk adımı (`/api/health`) bunu yakalar.

## Kabul

- `terraform validate` ve `terraform fmt -check` temiz.
- `dotnet test backend/WatchParty.slnx` geçer; origin doğrulaması için yeni testler: header yok → 403, yanlış → 403, doğru → 200, ayar boş → geçer, hub negotiate'i de kapsanır.
- `cd frontend; npm test; npm run build` geçer; tema açılışta yanıp sönmeden uygulanmaya devam eder.
- Lokal e2e (`backend/e2e`, Development) değişmeden 0 hatayla geçer.
- Canlıda `smoke.mjs` 0 hatayla geçer ve elle kontrol listesi tamamlanır.
