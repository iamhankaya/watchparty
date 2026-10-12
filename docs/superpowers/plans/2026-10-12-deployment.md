# AWS Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WatchParty'yi S3 + CloudFront (frontend) ve EC2 (backend) üzerinde, Terraform ve lokal PowerShell deploy script'leriyle yayına almak.

**Architecture:** Terraform (`infra/`) private S3 site bucket'ı, OAC'li CloudFront dağıtımını (SPA yönlendirmesi CloudFront Function ile, `/api/*` ve `/hubs/*` EC2'ye), Elastic IP'li tek bir t4g.small EC2'yi ve deploy bucket'ını kurar. Backend'e CloudFront'un gizli header'ını doğrulayan bir middleware eklenir. Deploy script'leri `terraform output`'tan değerleri okur; backend SSM üzerinden release klasörü + symlink + sağlık kontrolü + otomatik geri dönüşle yüklenir.

**Tech Stack:** Terraform (hashicorp/aws ~> 6.0, hashicorp/random ~> 3.6), CloudFront Functions (cloudfront-js-2.0), Amazon Linux 2023 arm64, systemd, ASP.NET Core 10, PowerShell 5.1, bash, Node 22 (smoke test, `node --test`).

**Spec:** `docs/superpowers/specs/2026-10-12-deployment.md`

## Global Constraints

- Kod yorumları, commit mesajları, script çıktıları ve dokümanlar Türkçe.
- Bölge `eu-central-1`, instance `t4g.small`, AMI SSM parametresi `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`, publish `-r linux-arm64 --self-contained false`.
- AWS profili varsayılanı `watchparty` (script parametresi ve Terraform değişkeni `aws_profile`).
- Gizli header adı `X-Origin-Verify`; ayar adı `Security:OriginSecret` (ortam değişkeni `Security__OriginSecret`).
- Sunucu yolları: `/opt/watchparty/releases/<zaman>/`, `/opt/watchparty/current` (symlink), `/etc/watchparty/watchparty.env` (600, root), `/usr/share/dotnet/dotnet`, servis adı `watchparty`, kullanıcı `watchparty`.
- CSP metni spec'teki ile birebir: `default-src 'self'; script-src 'self' https://www.youtube.com; frame-src https://www.youtube.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
- Mevcut `HubException` mesajları ve e2e (`backend/e2e/e2e.mjs`) değişmez.
- Terraform state, `*.tfvars`, `infra/.terraform/` repoya girmez; `infra/.terraform.lock.hcl` girer.
- Satır sonları: `.sh`, `.service`, `.tftpl` dosyaları LF olmalı (sunucuda çalışır). `.gitattributes`'a `*.sh text eol=lf`, `*.service text eol=lf`, `*.tftpl text eol=lf` eklenir (Task 3).

## Review Focus

- **İlk deploy'da geri dönülecek önceki sürüm yok:** sağlık kontrolü başarısızsa script çökmemeli; servis durdurulur, `current` kaldırılır, hata koduyla çıkılır. → Task 4 `first_deploy_failure_leaves_no_current` testi.
- **Aynı header iki kez ya da yanlış büyük/küçük harfli değerle gelir:** tek ve birebir eşit değer dışındaki her şey 403. → Task 1 `Duplicate_header_values_are_rejected`.
- **Ayar yalnızca boşluk (`"  "`):** kapalı sayılır (`string.IsNullOrWhiteSpace`), istekler geçer. → Task 1 `Whitespace_secret_disables_check`.
- **`/l/ABCDEF/` (sonda slash) ve `/l/abcdef` gibi deep link'ler:** `index.html`'e yeniden yazılır; `/assets/x.js`, `/theme-init.js`, `/favicon.ico` dokunulmaz. → Task 3 `spa-rewrite.test.mjs`.
- **Frontend deploy sırası:** `assets/` her zaman `index.html`'den önce yüklenir; aksi halde kısa süre yeni index olmayan asset'i ister. → Task 4 Step 5'teki sıra ve dry-run çıktısındaki sıra kontrolü.

## Paralel çalıştırma

Task 1, 2, 3, 4, 5 farklı dosyalara dokunur ve birbirlerinin kodunu kullanmaz (Task 4, Task 3'ün çıktı **adlarını** kullanır; adlar bu planda sabit). Hepsi ayrı worktree'lerde paralel çalışabilir. Task 6 (dokümanlar) hepsi birleştikten sonra; Task 7 (canlıya ilk kurulum) kullanıcıyla birlikte, ana session'da.

---

### Task 1: Origin doğrulama middleware'i

**Files:**
- Create: `backend/WatchParty.Api/Security/OriginVerification.cs`
- Modify: `backend/WatchParty.Api/Security/SecurityOptions.cs` (yeni özellik)
- Modify: `backend/WatchParty.Api/Program.cs` (`var app = builder.Build();` satırından hemen sonra, `UseForwardedHeaders` bloğundan önce)
- Test: `backend/WatchParty.Api.Tests/OriginVerificationTests.cs`

**Interfaces:**
- Produces: `SecurityOptions.OriginSecret` (`string`, varsayılan `""`); `public static class OriginVerification { public const string HeaderName = "X-Origin-Verify"; public static IApplicationBuilder UseOriginVerification(this IApplicationBuilder app); }`. Task 3 env dosyasında `Security__OriginSecret` kullanır.

- [ ] **Step 1: Testleri yaz**

Testler `WatchPartyFactory(new() { ["Security:OriginSecret"] = "s3cret" })` kullanır ve istekleri `factory.Server.SendAsync(ctx => { ... })` ile gönderir; her testte `ctx.Connection.RemoteIpAddress` açıkça verilir (dış adres `IPAddress.Parse("203.0.113.5")`, loopback `IPAddress.Loopback`).

```csharp
[Fact] Missing_header_is_rejected()            // dış IP, GET /api/health, header yok -> 403
[Fact] Wrong_header_is_rejected()              // dış IP, X-Origin-Verify: "nope" -> 403
[Fact] Case_differs_is_rejected()              // dış IP, "S3CRET" -> 403
[Fact] Duplicate_header_values_are_rejected()  // dış IP, Headers.Append iki kez "s3cret" -> 403
[Fact] Correct_header_passes()                 // dış IP, "s3cret" -> 200
[Fact] Loopback_skips_check()                  // IPAddress.Loopback ve IPv6Loopback, header yok -> 200
[Fact] Hub_negotiate_is_checked()              // dış IP, POST /hubs/lobby/negotiate?negotiateVersion=1, header yok -> 403; doğru header -> 200
[Fact] Empty_secret_disables_check()           // OriginSecret yok (varsayılan factory), dış IP, header yok -> 200
[Fact] Whitespace_secret_disables_check()      // OriginSecret = "  ", dış IP, header yok -> 200
[Fact] Forwarded_for_does_not_fake_loopback()  // TrustForwardedHeaders=true + secret; dış IP, X-Forwarded-For: 127.0.0.1, header yok -> 403
```

- [ ] **Step 2: Testleri çalıştır, derlenmediğini/başarısız olduğunu gör**

Run: `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~OriginVerificationTests"`
Expected: derleme hatası ya da 403 bekleyen testler FAIL.

- [ ] **Step 3: `SecurityOptions.OriginSecret` ve `OriginVerification.UseOriginVerification` yaz, `Program.cs`'e ekle**

Middleware ayarı `IOptions<SecurityOptions>`'tan bir kez okur; `IsNullOrWhiteSpace` ise `next`'e geçer. `RemoteIpAddress` loopback ise (`IPAddress.IsLoopback`, IPv4-mapped IPv6 dahil) geçer; `null` loopback sayılmaz. Header değerleri tam olarak bir tane değilse ya da `CryptographicOperations.FixedTimeEquals(UTF8(beklenen), UTF8(gelen))` false ise 403 döner, gövde yazmaz. `Program.cs`'te `UseForwardedHeaders`'tan önce çağrılır, yanına kısa bir Türkçe yorum: neden ilk sırada (forwarded header'lar uzak adresi değiştirmeden ve rate limiter'dan önce karar).

- [ ] **Step 4: Tüm backend testlerini çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: tümü PASS (önceki 59 + yeni 10).

- [ ] **Step 5: Commit**

```bash
git add backend/WatchParty.Api backend/WatchParty.Api.Tests
git commit -m "CloudFront origin doğrulaması: X-Origin-Verify header'ı"
```

---

### Task 2: Tema script'ini dosyaya taşı

**Files:**
- Create: `frontend/public/theme-init.js`
- Modify: `frontend/index.html` (inline `<script>` bloğu ve üstündeki yorum)

**Interfaces:**
- Produces: build çıktısında `dist/theme-init.js` (hash'siz). Task 4 bunu `no-cache` ile yükler.

- [ ] **Step 1: Inline script'in gövdesini `public/theme-init.js`'e taşı**

Davranış aynı kalır (localStorage `wp:theme` → yoksa `prefers-color-scheme` → `document.documentElement.dataset.theme`). Dosyanın başına bir satır yorum: CSP inline script'e izin vermediği için ayrı dosya, senkron yüklenmeli.

- [ ] **Step 2: `index.html`'de inline bloğu `<script src="/theme-init.js"></script>` ile değiştir**

`async`, `defer`, `type="module"` yok; Google Fonts `<link>`'lerinden önce durur. Yorum: "Tema sayfa çizilmeden uygulanır (senkron script)".

- [ ] **Step 3: Build ve inline script kontrolü**

Run: `cd frontend; npm test; npm run build; Select-String -Path dist/index.html -Pattern '<script>' ; Test-Path dist/theme-init.js`
Expected: testler PASS, build başarılı, `Select-String` eşleşme döndürmez, `Test-Path` True.

- [ ] **Step 4: Tarayıcıda tema doğrulaması**

`npm run dev:mock` ile aç; localStorage `wp:theme=light` iken sayfayı yenile: ilk çizimde `document.documentElement.dataset.theme === "light"` (Playwright `page.evaluate` sayfa yüklenir yüklenmez) ve tema butonu çalışıyor. Sunucuyu kapat.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/public/theme-init.js
git commit -m "Tema başlatma script'ini dosyaya taşı (CSP için)"
```

---

### Task 3: Terraform altyapısı

**Files:**
- Create: `infra/versions.tf` (terraform >= 1.6, aws ~> 6.0, random ~> 3.6; provider `aws` `region = var.region`, `profile = var.aws_profile`, `default_tags { Project = "watchparty" }`)
- Create: `infra/variables.tf` (`region` = "eu-central-1", `aws_profile` = "watchparty", `instance_type` = "t4g.small", `project` = "watchparty")
- Create: `infra/storage.tf` (site bucket, deploy bucket + 30 gün lifecycle `backend/` prefix, ikisi de `force_destroy = true`, public access block; site bucket policy yalnızca bu dağıtımın OAC'si)
- Create: `infra/cdn.tf` (OAC, CloudFront Function, response headers policy, distribution)
- Create: `infra/compute.tf` (default VPC, SG, IAM role/profile, EIP + association, instance, `random_password`)
- Create: `infra/outputs.tf`
- Create: `infra/spa-rewrite.js`
- Create: `infra/user_data.sh.tftpl`
- Create: `deploy/watchparty.service`
- Create: `infra/tests/spa-rewrite.test.mjs`
- Modify: `.gitignore` (sona: `infra/.terraform/`, `*.tfstate`, `*.tfstate.*`, `*.tfvars`), `.gitattributes` (yoksa oluştur; Global Constraints'teki eol satırları)

**Interfaces:**
- Consumes: Task 1'in `Security__OriginSecret` adı.
- Produces: `terraform output -json` anahtarları (Task 4 ve Task 5 kullanır): `cloudfront_domain` (string, ör. `d123.cloudfront.net`), `distribution_id`, `site_bucket`, `deploy_bucket`, `instance_id`, `origin_domain` (EIP public DNS).

- [ ] **Step 1: CloudFront Function testi yaz (`infra/tests/spa-rewrite.test.mjs`, `node:test`)**

Dosya `spa-rewrite.js` metnini okur, `new Function(src + "; return handler;")()` ile `handler`'ı alır (CloudFront Function'lar modül değildir). `event = { request: { uri } }`.

```js
test("/l/ABCDEF -> /index.html")
test("/l/ABCDEF/ -> /index.html")
test("/l/abcdef -> /index.html")
test("/ -> /index.html")
test("/assets/index-abc.js değişmez")
test("/theme-init.js değişmez")
test("/favicon.ico değişmez")
```

Run: `node --test infra/tests/` → FAIL (dosya yok).

- [ ] **Step 2: `infra/spa-rewrite.js` yaz**

`function handler(event)`: son path segmentinde `.` yoksa `request.uri = "/index.html"`; request'i döndürür. `export`/`module` yok. Run: `node --test infra/tests/` → PASS.

- [ ] **Step 3: `cdn.tf`**

- OAC: `signing_behavior = "always"`, `signing_protocol = "sigv4"`, `origin_access_control_origin_type = "s3"`.
- `aws_cloudfront_function`: `runtime = "cloudfront-js-2.0"`, `code = file("${path.module}/spa-rewrite.js")`, `publish = true`.
- Managed policy'ler data source ile adla: cache `Managed-CachingOptimized`, `Managed-CachingDisabled`; origin request `Managed-AllViewerExceptHostHeader`.
- `aws_cloudfront_response_headers_policy`: CSP (Global Constraints metni, `override = true`), HSTS `access_control_max_age_sec = 31536000`, `content_type_options`, `referrer_policy = "strict-origin-when-cross-origin"`.
- Distribution: `enabled`, `default_root_object = "index.html"`, `price_class = "PriceClass_All"`, `viewer_certificate { cloudfront_default_certificate = true }`, `is_ipv6_enabled = true`.
  - Origin `s3`: site bucket regional domain + OAC.
  - Origin `api`: `domain_name = aws_eip.api.public_dns`, `custom_origin_config { http_port = 80, https_port = 443, origin_protocol_policy = "http-only", origin_ssl_protocols = ["TLSv1.2"] }`, `custom_header { name = "X-Origin-Verify", value = random_password.origin_secret.result }`.
  - Default behavior → `s3`, GET/HEAD, CachingOptimized, function association `viewer-request`, `redirect-to-https`, response headers policy.
  - Ordered behavior `/api/*` ve `/hubs/*` → `api`, tüm 7 metod (cached GET/HEAD), CachingDisabled, AllViewerExceptHostHeader, `redirect-to-https`, response headers policy.
  - `custom_error_response` **yok** (spec: API 404'ünü bozar).

- [ ] **Step 4: `storage.tf` ve site bucket policy**

Bucket policy: `s3:GetObject` yalnızca `cloudfront.amazonaws.com` principal'ına, `AWS:SourceArn = distribution ARN` koşuluyla. Bucket adları `"${var.project}-site-${random_id}"` / `"${var.project}-deploy-${random_id}"` (`random_id` 4 byte hex; global benzersizlik).

- [ ] **Step 5: `compute.tf`, `user_data.sh.tftpl`, `deploy/watchparty.service`**

- `random_password.origin_secret`: `length = 40`, `special = false`.
- SG: inbound TCP 80 `prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]` (`name = "com.amazonaws.global.cloudfront.origin-facing"`); egress all.
- IAM role (EC2 assume), `AmazonSSMManagedInstanceCore` attachment, inline policy `s3:GetObject` on `${deploy_bucket_arn}/backend/*`.
- `aws_eip.api` (`domain = "vpc"`), `aws_eip_association`.
- Instance: AMI SSM parametresinden, `metadata_options { http_tokens = "required" }`, root volume gp3 8 GB, `user_data = templatefile(...)`, `user_data_replace_on_change = false`.
- `user_data.sh.tftpl` (bash, `set -euo pipefail`): `dnf install -y libicu unzip`; `dotnet-install.sh --runtime aspnetcore --channel 10.0 --install-dir /usr/share/dotnet`; `useradd --system --no-create-home --shell /sbin/nologin watchparty`; `/opt/watchparty/releases` (sahip watchparty); env dosyası (Global Constraints yolu, 600) içeriği spec Bölüm 2'deki beş satır, `AllowedHosts=${origin_domain};localhost`; servis dosyasını `/etc/systemd/system/watchparty.service`'e yaz (içerik `templatefile` değişkeni `service_unit = file("${path.module}/../deploy/watchparty.service")`); `systemctl daemon-reload && systemctl enable watchparty` (start yok).
- `deploy/watchparty.service`: spec Bölüm 2'deki alanlar + `After=network-online.target`, `Wants=network-online.target`, `[Install] WantedBy=multi-user.target`.
- `user_data` EIP DNS'ini `aws_eip.api.public_dns`'ten alır (EIP instance'tan önce oluşur, association ayrı kaynak — döngü yok).

- [ ] **Step 6: `outputs.tf`** — Interfaces'teki altı ad.

- [ ] **Step 7: Doğrulama**

Terraform kurulu değilse: `winget install --id Hashicorp.Terraform -e`.
Run: `terraform -chdir=infra init -backend=false; terraform -chdir=infra fmt -check -recursive; terraform -chdir=infra validate; node --test infra/tests/`
Expected: `fmt` çıktısız, `Success! The configuration is valid.`, node testleri PASS. (`plan`/`apply` AWS kimliği ister; Task 7.)

- [ ] **Step 8: Commit** (`infra/.terraform.lock.hcl` dahil, `.terraform/` hariç)

```bash
git add infra deploy/watchparty.service .gitignore .gitattributes
git commit -m "Terraform: S3, CloudFront, EC2 altyapısı"
```

---

### Task 4: Deploy script'leri

**Files:**
- Create: `deploy/common.ps1` (`Get-InfraOutputs` ve `Invoke-Aws` yardımcıları)
- Create: `deploy/remote-deploy.sh`
- Create: `deploy/deploy-backend.ps1`
- Create: `deploy/deploy-frontend.ps1`
- Test: `deploy/tests/remote-deploy.test.sh`

**Interfaces:**
- Consumes: Task 3 output adları; Global Constraints'teki sunucu yolları ve servis adı.
- Produces: `deploy-backend.ps1 [-Profile watchparty] [-Rollback]`, `deploy-frontend.ps1 [-Profile watchparty] [-DryRun]`. `remote-deploy.sh deploy <s3-uri> <release>` | `remote-deploy.sh rollback`; çıkış kodu 0 başarı, 1 hata.

- [ ] **Step 1: `remote-deploy.sh` için testleri yaz**

`remote-deploy.sh` yolları ve komutları ortam değişkeniyle değiştirilebilir: `WP_ROOT` (varsayılan `/opt/watchparty`), `WP_SYSTEMCTL` (varsayılan `systemctl`), `WP_HEALTH` (varsayılan `curl -fsS -o /dev/null http://localhost/api/health`), `WP_FETCH` (varsayılan `aws s3 cp`), `WP_HEALTH_TIMEOUT` (varsayılan 20), `WP_CHOWN` (varsayılan `chown -R watchparty:watchparty`). Test (Git Bash'te çalışır) geçici dizinde sahte `fetch` (yerel zip kopyalar), `systemctl` (çağrıları bir log dosyasına yazar), `health` (`true`/`false`), `chown` (`true`) kullanır, `WP_HEALTH_TIMEOUT=1`.

```bash
test_deploy_success_switches_current        # current -> releases/r2, restart çağrıldı, çıkış 0
test_failed_health_rolls_back               # önce r1 başarılı; r2'de health false -> current -> r1, iki restart, çıkış 1
test_first_deploy_failure_leaves_no_current # hiç release yokken health false -> current yok, "stop" çağrıldı, çıkış 1
test_keeps_last_five_releases               # 7 başarılı deploy -> releases/ altında 5 klasör, en eskiler silinmiş
test_rollback_command                       # r1, r2 başarılı; "rollback" -> current -> r1, çıkış 0; tek release varken rollback -> çıkış 1
```

Run: `bash deploy/tests/remote-deploy.test.sh` → FAIL.

- [ ] **Step 2: `remote-deploy.sh` yaz** (`set -euo pipefail`; zip'i `releases/<release>`'e aç, chown, önceki `current` hedefini `readlink` ile sakla, `ln -sfn`, restart, `WP_HEALTH_TIMEOUT` saniye boyunca saniyede bir health dene; başarısızsa önceki hedef varsa ona dön + restart, yoksa `current`'ı sil + stop; Türkçe log satırları). Run test → PASS.

- [ ] **Step 3: `common.ps1`**

`Get-InfraOutputs`: `terraform -chdir=<repo>/infra output -json` → `[pscustomobject]` (`.cloudfront_domain.value` vb. düzleştirilmiş). `Invoke-Aws`: `aws @args --profile $Profile --output json`, çıkış kodu sıfır değilse `throw`. `$ErrorActionPreference = "Stop"`.

- [ ] **Step 4: `deploy-backend.ps1`**

Sıra: `dotnet test` (başarısızsa dur) → `dotnet publish backend/WatchParty.Api -c Release -r linux-arm64 --self-contained false -o <temp>` → zip (aşağıdaki nota bak) → `aws s3 cp` `s3://<deploy_bucket>/backend/<yyyyMMdd-HHmmss>.zip` → `aws ssm send-command --document-name AWS-RunShellScript --instance-ids <instance_id>`; komut: `remote-deploy.sh` içeriği base64 olarak gönderilir, sunucuda `echo <b64> | base64 -d > /tmp/remote-deploy.sh && bash /tmp/remote-deploy.sh deploy <s3-uri> <release>` → `aws ssm wait command-executed` (hata verirse de devam edip sonucu oku) → `get-command-invocation` ile stdout/stderr yazdır, `Status` `Success` değilse `exit 1`. `-Rollback`: publish/yükleme atlanır, `rollback` komutu gönderilir. Not: PS 5.1'deki `Compress-Archive` yol ayırıcısı olarak `\` yazar ve Linux'ta `unzip` dosyaları bozuk açar; bunun yerine `Add-Type -AssemblyName System.IO.Compression.FileSystem` + `[System.IO.Compression.ZipFile]::CreateFromDirectory` kullan (`/` yazar).

- [ ] **Step 5: `deploy-frontend.ps1`**

Sıra (Review Focus): `npm test` → `npm run build` → `aws s3 sync dist/assets s3://<site>/assets --cache-control "public, max-age=31536000, immutable"` → `aws s3 cp dist/index.html` ve `dist/theme-init.js` `--cache-control "no-cache"` (ayrı `cp`; `dist` kökündeki diğer dosyalar da `no-cache` ile) → `aws cloudfront create-invalidation --distribution-id <id> --paths /index.html /theme-init.js` → sonda `https://<cloudfront_domain>` yazdır. `-DryRun`: AWS komutlarını çalıştırmaz, sırayla yazdırır.

- [ ] **Step 6: Statik doğrulama**

Run:
```powershell
foreach ($f in Get-ChildItem deploy/*.ps1) { $e=$null; [System.Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$null,[ref]$e) | Out-Null; if ($e) { $e; exit 1 } }
bash -n deploy/remote-deploy.sh
bash deploy/tests/remote-deploy.test.sh
```
Expected: parse hatası yok, testler PASS. `deploy-frontend.ps1 -DryRun` çalıştırılırsa (Task 3 `terraform output` olmadan) anlamlı bir Türkçe hata verir: "infra çıktıları okunamadı; önce terraform apply".

- [ ] **Step 7: Commit**

```bash
git add deploy
git commit -m "Deploy script'leri: SSM ile backend, S3/CloudFront ile frontend"
```

---

### Task 5: Canlı smoke testi

**Files:**
- Create: `backend/e2e/smoke.mjs`
- Modify: `backend/e2e/package.json` (`"smoke": "node smoke.mjs"`)

**Interfaces:**
- Consumes: `BASE_URL` (CloudFront `https://...`), opsiyonel `ORIGIN_URL` (`http://<origin_domain>`).
- Produces: `npm run smoke`; çıkış kodu = başarısız kontrol sayısı > 0 ise 1. e2e.mjs'in `ok()` / PASS-FAIL çıktı biçimi.

- [ ] **Step 1: `smoke.mjs` yaz** — kontroller spec Bölüm 5 sırasıyla:

```
PASS health                      GET /api/health -> 200, status "ok"
PASS spa deep link               GET /l/ABCDEF -> 200, content-type text/html
PASS api 404 korunuyor           GET /api/lobbies/ZZZZZZ -> 404
PASS csp header                  GET / -> content-security-policy içinde "frame-src https://www.youtube.com"   (yalnız BASE_URL https ise; değilse "SKIP csp header")
PASS hub sohbet                  lobi oluştur, iki SignalR istemcisi JoinLobby, biri SendChat("smoke"), diğeri ChatMessage alır (3 sn içinde), bağlantıları kapat
PASS origin kapalı               ORIGIN_URL varsa: fetch ORIGIN_URL/api/health, AbortSignal.timeout(5000) -> hata (bağlanamaz); yoksa "SKIP origin kapalı"
```

- [ ] **Step 2: Lokal çalıştır**

Backend (Development, 5205) ve `npm run dev` (5173) açıkken: `cd backend/e2e; $env:BASE_URL="http://localhost:5173"; npm run smoke`
Expected: health, spa deep link (Vite index.html döner), api 404, hub sohbet PASS; csp ve origin SKIP; çıkış kodu 0.

- [ ] **Step 3: Commit**

```bash
git add backend/e2e
git commit -m "Canlı ortam için smoke testi"
```

---

### Task 6: Dokümanlar (Task 1-5 birleştikten sonra)

**Files:**
- Create: `deploy/README.md`
- Modify: `CLAUDE.md` (Deployment target + Deploy notes bölümleri), `frontend/README.md` (Bilinen sınırlar: SPA yönlendirmesi notu)

- [ ] **Step 1: `deploy/README.md` runbook'u** — spec Bölüm 6'daki başlıklar sırayla: araç kurulumu (`winget install Amazon.AWSCLI`, `winget install Hashicorp.Terraform`, isteğe bağlı Session Manager eklentisi), IAM kullanıcısı + access key + `aws configure --profile watchparty` (+ `aws sts get-caller-identity` kontrolü), `terraform -chdir=infra init/apply`, ilk deploy (önce backend, sonra frontend), `npm run smoke` (BASE_URL/ORIGIN_URL `terraform output`'tan), elle kontrol listesi (spec Bölüm 5), rollback (`deploy-backend.ps1 -Rollback`), log (`aws ssm start-session` + `journalctl -u watchparty -n 200`), runtime kontrolü (`/usr/share/dotnet/dotnet --list-runtimes`), `terraform destroy`, state dosyasının hassas olduğu ve yedeklenmesi gerektiği.

- [ ] **Step 2: CLAUDE.md** — "Deployment target (planned, not yet in the repo)" satırını gerçek bölümle değiştir: `infra/` ve `deploy/` ne içerir, deploy komutları, `Security:OriginSecret`/`X-Origin-Verify` ve loopback muafiyeti, `AllowedHosts` = origin DNS (CloudFront adı değil), SPA yönlendirmesinin CloudFront Function'da olduğu (custom error response kullanma), smoke testi. Mevcut "Deploy notes" maddelerini bununla birleştir, tekrar etme.

- [ ] **Step 3: `frontend/README.md`** — "Prod'da ... 403/404 → index.html yönlendirmesi gerekecek" maddesini: "CloudFront Function (`infra/spa-rewrite.js`) uzantısız yolları `index.html`'e yazar; custom error response kullanılmaz çünkü API'nin 404'ünü bozar" ile değiştir.

- [ ] **Step 4: Tam doğrulama**

Run: `dotnet test backend/WatchParty.slnx; cd frontend; npm test; npm run build; cd ..; node --test infra/tests/; bash deploy/tests/remote-deploy.test.sh; terraform -chdir=infra validate`; Development backend açıkken `cd backend/e2e; npm test`.
Expected: hepsi PASS, e2e "33 passed, 0 failed".

- [ ] **Step 5: Commit**

```bash
git add deploy/README.md CLAUDE.md frontend/README.md
git commit -m "Deploy runbook'u ve doküman güncellemeleri"
```

---

### Task 7: İlk canlı kurulum (ana session, kullanıcıyla)

Bu task subagent'a verilmez: AWS kimlik bilgisi kullanıcıdan gelir ve gerçek kaynak oluşturur (maliyet). Her `apply`/deploy öncesi kullanıcı onayı alınır.

- [ ] **Step 1:** Kullanıcı AWS CLI'ı kurar ve `aws configure --profile watchparty` yapar; `aws sts get-caller-identity --profile watchparty` başarılı.
- [ ] **Step 2:** `terraform -chdir=infra init; terraform -chdir=infra plan -out tfplan` → plan özeti kullanıcıya gösterilir (oluşacak kaynaklar, ~16 $/ay) → onayla `terraform -chdir=infra apply tfplan`.
- [ ] **Step 3:** SSM ile runtime doğrulaması: `aws ssm send-command ... "/usr/share/dotnet/dotnet --list-runtimes"` → `Microsoft.AspNetCore.App 10.x` görünür. (user_data bitmemişse birkaç dakika beklenir; `/var/log/cloud-init-output.log`.)
- [ ] **Step 4:** `deploy/deploy-backend.ps1` → "Sağlık kontrolü başarılı". Ardından `deploy/deploy-frontend.ps1`.
- [ ] **Step 5:** `cd backend/e2e; $env:BASE_URL="https://<cloudfront_domain>"; $env:ORIGIN_URL="http://<origin_domain>"; npm run smoke` → 0 hata.
- [ ] **Step 6:** Kullanıcıyla elle kontrol listesi (runbook). Bulunan sorunlar ayrı düzeltme commit'leri olur.
