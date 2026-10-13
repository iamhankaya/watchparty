# Videolar İçin Ayrı Bucket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Videoları site bucket'ından ayrı, 30 günde kendiliğinden silinen private bir bucket'tan, aynı `/videolar/...` linkleriyle vermek.

**Architecture:** `infra/videos.tf` bucket'ı, policy'sini, yaşam döngüsünü ve 1 günlük cache policy'yi kurar; `cdn.tf`'e ikinci bir S3 origin'i ve `/videolar/*` behavior'ı eklenir. Kod şimdi yazılır; `apply` ve taşıma izleme bittikten sonra kullanıcı onayıyla, spec'teki sırayla yapılır.

**Tech Stack:** Terraform (hashicorp/aws ~> 6.0), CloudFront, S3.

**Spec:** `docs/superpowers/specs/2026-10-13-video-bucket.md`

## Global Constraints

- Kod yorumları, commit mesajları ve dokümanlar Türkçe (CLAUDE.md İngilizce). Commit mesajları `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` ile biter.
- Adlar: bucket `"${var.project}-videos-${random_id.bucket_suffix.hex}"` (`aws_s3_bucket.videos`), cache policy `"${var.project}-videos"` (`aws_cloudfront_cache_policy.videos`), origin id `"videos"` (`local.videos_origin_id`), çıktı `video_bucket`.
- Yaşam döngüsü: `eski-videolari-sil` 30 gün; `yarim-yuklemeleri-iptal-et` 2 gün. Cache: `min_ttl = 0`, `default_ttl = 86400`, `max_ttl = 86400`.
- Mevcut OAC (`aws_cloudfront_origin_access_control.site`) ve security headers policy yeniden kullanılır; SPA function `/videolar/*`'a bağlanmaz.
- `tools/downloader/` dosyalarına dokunulmaz (başka bir session'ın sahipliğinde).
- Worktree'de `terraform plan/apply` ve AWS çağrısı yok; yalnızca `init -backend=false`, `fmt -check -recursive`, `validate`.

## Review Focus

- **Behavior sırası/deseni:** `/videolar/*` deseni `/api/*`, `/hubs/*` ve SPA yönlendirmesini etkilememeli; `/videolar` önekli olmayan yollar site bucket'ına gitmeye devam etmeli. → Task 1 Step 2 `grep`/okuma kontrolü + canlıda smoke.
- **Policy yalnızca bu dağıtım:** `AWS:SourceArn` `StringEquals` ile `aws_cloudfront_distribution.main.arn`. → Task 1 Step 2.
- **MP4 sıkıştırılmamalı ve Range istekleri çalışmalı:** `compress = false`, cache key'de header yok. → canlı doğrulama (`Range` → 206).
- **Lifecycle filtresi tüm bucket'ı kapsamalı** (boş `filter {}`), yalnızca bir öneki değil. → Task 1 Step 2.

---

### Task 1: Terraform — video bucket'ı ve CloudFront behavior'ı

**Files:**
- Create: `infra/videos.tf`
- Modify: `infra/cdn.tf` (locals'a `videos_origin_id`, yeni `origin`, yeni `ordered_cache_behavior` mevcut `/hubs/*` bloğundan sonra), `infra/outputs.tf` (`video_bucket`)

**Interfaces:**
- Consumes: `random_id.bucket_suffix`, `aws_cloudfront_distribution.main`, `aws_cloudfront_origin_access_control.site`, `aws_cloudfront_response_headers_policy.security`.
- Produces: `aws_s3_bucket.videos`, çıktı `video_bucket`.

- [ ] **Step 1: Kaynakları yaz** — spec 1. bölüm birebir (`aws_s3_bucket.videos`, `aws_s3_bucket_public_access_block.videos`, `aws_s3_bucket_policy.videos` + policy document, `aws_s3_bucket_lifecycle_configuration.videos` iki kuralla, `aws_cloudfront_cache_policy.videos` — `parameters_in_cache_key_and_forwarded_to_origin` içinde cookie/header/query string `none`, `enable_accept_encoding_gzip = false`, `enable_accept_encoding_brotli = false`). Stil ve yorum yoğunluğu `infra/storage.tf` gibi.
- [ ] **Step 2: Doğrula.**
  Run: `terraform -chdir=infra fmt -check -recursive` → çıkış 0.
  Run: `terraform -chdir=infra init -backend=false && terraform -chdir=infra validate` → `Success! The configuration is valid.`
  Run: `node --test "infra/tests/*.test.mjs"` → geçer (SPA function değişmedi).
  Kontrol: `grep -n "videolar\|videos" infra/cdn.tf` → yeni behavior'da `function_association` yok, `compress = false`; `infra/videos.tf`'de lifecycle `filter {}` boş, `AWS:SourceArn` `StringEquals`.
- [ ] **Step 3: Commit** — mesaj: `Altyapı: videolar için ayrı bucket (30 gün yaşam döngüsü) ve /videolar/* behavior'ı`.

### Task 2: Belgeler

**Files:**
- Modify: `CLAUDE.md` ("Video downloader" bölümü), `deploy/README.md` (çıktılar listesi + kısa "Videolar" notu), `docs/BACKLOG.md` (maddeyi sil)

**Interfaces:**
- Consumes: çıktı `video_bucket`, spec 3. bölüm.

- [ ] **Step 1: Belgeleri spec 3. bölüme göre güncelle.** CLAUDE.md'deki örnek komutta `--s3-bucket watchparty-site-b554977f` yerine `--s3-bucket <video_bucket>` (`terraform -chdir=infra output -raw video_bucket`); "Uploads currently go to the site bucket..." cümlesi video bucket'ını, 30 günlük silmeyi ve 1 günlük edge önbelleğini anlatacak şekilde; `--gizli` notundaki "delete the object (plus a CloudFront invalidation, objects are cached immutable)" kısmı: silinen video edge'de en geç 1 gün sonra kaybolur, hemen gerekirse invalidation.
- [ ] **Step 2: Commit** — mesaj: `Belgeler: video bucket'ı`.

---

## Canlıya alma (controller, ana çalışma ağacında, izleme bittikten sonra ve kullanıcı onayıyla)

Spec 2. bölümdeki sıra birebir: listeleme → hedefli apply (yalnızca bucket, public access block, lifecycle; plan'da dağıtım görünürse dur) → sunucu tarafı kopya + boyut kontrolü → bucket policy'yi elle koy (`aws s3api put-bucket-policy`, spec 2. bölüm 4. adım) → tam plan (ekleme + dağıtımda yerinde güncelleme, 0 destroy) ve apply → `Deployed` bekle → doğrulama (200 + `video/mp4`, Range 206, `/videolar/yok.mp4` 403, smoke 6/6) → site bucket'ındaki `videolar/` silinir.

Task 1 ve 2 ayrı dosyalara dokunur; paralel worktree'lerde yürütülür. CI/CD dalı (`ci-cd`) master'a girdikten sonra başlatılır (`infra/outputs.tf` iki planda da değişiyor).
