# Tarayıcıdan Video Yükleme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Yükleme anahtarı olan kişiler lobiden MP4 (+ altyazı) yükleyebilsin; dosya tarayıcıdan doğrudan S3'e gitsin.

**Architecture:** Backend `/api/uploads/*` uç noktaları `X-Upload-Key`'i SHA-256 özetleriyle doğrular ve `IUploadStorage` (S3) üzerinden multipart başlatır, presigned parça URL'leri üretir, tamamlar/iptal eder. Terraform video bucket'ına CORS, EC2 rolüne `videolar/*` yazma izni, CSP'ye S3 adresi ekler. İstemcide `lib/upload.ts` parçalı yükleme motoru ve `UploadDialog`.

**Tech Stack:** .NET 10 minimal API + AWSSDK.S3 / xUnit, Terraform (aws ~> 6.0), PowerShell 5.1, React 19 + TypeScript / Vitest.

**Spec:** `docs/superpowers/specs/2026-10-15-browser-upload.md`

## Global Constraints

- Türkçe yorum/UI/hata/commit; commit sonu `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; CLAUDE.md İngilizce.
- Uç noktalar ve JSON (camelCase), birebir:
  - `POST /api/uploads/video` `{ fileName: string, size: number }` → `{ key: string, uploadId: string, partSize: number, partCount: number }`
  - `POST /api/uploads/video/parts` `{ key, uploadId, partNumbers: number[] }` (1..50 adet) → `{ urls: { partNumber: number, url: string }[] }`
  - `POST /api/uploads/video/complete` `{ key, uploadId, parts: { partNumber: number, eTag: string }[] }` → `{ url: string }`
  - `POST /api/uploads/video/abort` `{ key, uploadId }` → 204
  - `POST /api/uploads/subtitle` `{ fileName, size }` → `{ key: string, putUrl: string, url: string }`
  - Başlık `X-Upload-Key` zorunlu (tümünde).
- Durum kodları/metinler: 401 `"Yükleme anahtarı geçersiz"`, 403 `"Yükleme kapalı"`, 429 (mevcut 429 gövdesiyle aynı biçim), 400 `"Dosya çok büyük"`, `"Yalnızca .mp4 veya .m4v yüklenebilir"`, `"Yalnızca .srt veya .vtt yüklenebilir"`, `"Geçersiz dosya anahtarı"`, 502 `"Yükleme tamamlanamadı"`. Hata gövdesi mevcut API'lerdeki biçim (`{ error: "..." }` ya da `Program.cs`'teki mevcut kalıp — uygulayıcı mevcudu izler ve raporlar).
- `UploadOptions` (`Upload` bölümü): `Keys: { Name, Sha256 }[]`, `VideoBucket`, `PublicBaseUrl`, `MaxVideoBytes = 6442450944`, `MaxSubtitleBytes = 2097152`, `PartSizeBytes = 16777216`, `UrlLifetimeMinutes = 60`. Ortam değişkenleri `Upload__Keys__<i>__Name`, `Upload__Keys__<i>__Sha256`, `Upload__VideoBucket`, `Upload__PublicBaseUrl`.
- `IUploadStorage` arayüzü (S3 uygulaması `S3UploadStorage`, testte sahte): `StartMultipart(key, contentType, cacheControl)`, `PresignPart(key, uploadId, partNumber, expires)`, `Complete(key, uploadId, parts)`, `Abort(key, uploadId)`, `PresignPut(key, contentType, cacheControl, expires)`.
- Dosya anahtarı deseni: `^videolar/[0-9a-f]{32}/[a-z0-9-]{1,80}\.(mp4|m4v|srt|vtt)$`.
- Yanlış anahtar sınırı: IP başına 10 deneme / 10 dk (yalnızca başarısızlar sayılır).
- İstemci: `lib/upload.ts` → `uploadVideo(file: File, uploadKey: string, opts: { onProgress(p: UploadProgress): void; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<{ url: string }>`, `uploadSubtitle(file, uploadKey, opts): Promise<{ url: string }>`, `UploadProgress = { loaded: number; total: number; bytesPerSecond: number; secondsLeft: number | null }`; eşzamanlılık 4, parça başına 3 deneme; `localStorage` anahtarı `wp:uploadKey`.
- UI metinleri: düğme `"Bilgisayardan yükle"`, `"Yükle"`, `"İptal"`, `"Lobide aç"`, `"Bu tarayıcıda hatırla"`, not `"En iyi sonuç için H.264 video ve AAC ses içeren MP4 kullanın."`.
- Açık yükleme anahtarı asla repoya, loga, konsol çıktısına ya da sohbete girmez.

## Review Focus

- **Anahtar sızıntısı:** loglarda, hata mesajlarında, script çıktısında açık anahtar yok. → Task 1 log testi, Task 2 script.
- **Başka yola yazma:** istemcinin verdiği `key` yalnızca desene uyan ve `videolar/` altında. → Task 1 testi.
- **Kaba kuvvet:** 11. yanlış deneme 429. → Task 1 testi.
- **Son parça boyutu / 6 GB sınırı / 0 bayt.** → Task 1 + Task 3 testleri.
- **İptal edilen yükleme S3'te yarım parça bırakmaz** (abort çağrılır; kalırsa yaşam döngüsü 2 günde temizler). → Task 3 testi.

---

### Task 1: Backend — uç noktalar, anahtar doğrulama, S3

**Files:** Create `backend/WatchParty.Api/Uploads/UploadOptions.cs`, `Uploads/UploadKeys.cs` (özet + sabit zamanlı karşılaştırma), `Uploads/FileNames.cs` (temizleme), `Uploads/IUploadStorage.cs`, `Uploads/S3UploadStorage.cs`, `Uploads/UploadEndpoints.cs`; Modify `Program.cs`, `WatchParty.Api.csproj` (`AWSSDK.S3`), `Security/HttpRateLimits.cs` (başarısız anahtar politikası), `appsettings.json` (boş `Upload` varsayılanları); Test: `backend/WatchParty.Api.Tests/UploadTests.cs`, `FileNamesTests.cs`.

- [ ] **Step 1: Başarısız testler** — spec "Doğrulama" xUnit maddeleri (sahte `IUploadStorage` `WatchPartyFactory` üzerinden enjekte).
- [ ] **Step 2:** `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~Upload|FullyQualifiedName~FileNames"` → FAIL.
- [ ] **Step 3: Uygula** — spec 1. bölüm. Log: anahtar **adı**, dosya anahtarı, boyut.
- [ ] **Step 4:** `dotnet test backend/WatchParty.slnx` → tümü geçer; `dotnet list backend/WatchParty.Api package --vulnerable` temiz.
- [ ] **Step 5: Commit** — `Yükleme: anahtar doğrulama ve S3 multipart uç noktaları`.

### Task 2: Altyapı ve anahtar script'i

**Files:** Modify `infra/videos.tf` (CORS), `infra/compute.tf` (EC2 rol politikası), `infra/cdn.tf` (CSP `connect-src`), `infra/variables.tf` (isteğe bağlı `upload_dev_origin`, varsayılan boş); Create `deploy/upload-keys.ps1`, `deploy/tests/upload-keys.test.ps1`.

- [ ] **Step 1:** Terraform — spec 2. bölüm. `fmt -check`, `init -backend=false`, `validate`; `node --test "infra/tests/*.test.mjs"`. Plan/apply YOK (controller ana ağaçta yapar).
- [ ] **Step 2:** `deploy/upload-keys.ps1` (PowerShell 5.1, BOM'lu UTF-8, `common.ps1` dot-source): `-Init` (ortam dosyasında `Upload__VideoBucket` ve `Upload__PublicBaseUrl`'i Terraform çıktılarından yazar, idempotent), `-Add <ad>` (32 karakter base62 anahtar `RandomNumberGenerator` ile; SHA-256 hex; ortam dosyasına sıradaki indeksle `Upload__Keys__<i>__Name/Sha256` ekler; aynı ad varsa hata; anahtarı `Set-Clipboard` ile panoya kopyalar, konsola yalnızca "Anahtar panoya kopyalandı"), `-Remove <ad>` (kaydı siler, indeksleri sıkıştırır), `-List` (yalnızca adlar). Sunucudaki dosyayı SSM ile okuyup yazar (`/etc/watchparty/watchparty.env`, izin 600, root), ardından `systemctl restart watchparty` ve sağlık kontrolü; başta "Bu işlem açık lobileri düşürür" uyarısı ve `-Force` olmadan onay sorusu. Ortam dosyası düzenleme mantığı saf bir fonksiyonda (`Update-EnvContent`) ki testlenebilsin.
- [ ] **Step 3:** `deploy/tests/upload-keys.test.ps1` (common.test.ps1 kalıbı): `Update-EnvContent` ekle/sil/indeks sıkıştırma/aynı ad hatası/Init idempotent; anahtar üretimi 32 karakter base62; çıktıda anahtar yok (Write-Host yakalanarak). `powershell -NoProfile -File deploy/tests/upload-keys.test.ps1` → hepsi geçer.
- [ ] **Step 4: Commit** — `Yükleme: CORS, EC2 izni, CSP ve anahtar script'i`.

### Task 3: İstemci — yükleme motoru ve pencere

**Files:** Create `frontend/src/lib/upload.ts`, `lib/upload.test.ts`, `components/UploadDialog.tsx`; Modify `components/MediaPicker.tsx` (düğme + pencere), `components/Icon.tsx` (`upload`), `styles.css`.

- [ ] **Step 1: Başarısız testler** (sahte `fetchImpl`): parça planlama (son parça, 6 GB+1 → istemci hatası, 0 bayt hata), parça URL'lerinin 50'lik partilerle istenmesi, eşzamanlılık en fazla 4, başarısız parça 3 deneme sonra hata + `abort` çağrısı, `signal` iptali → `abort`, ETag'lerin `complete`'e sırayla gitmesi, ilerleme/hız/kalan süre, `X-Upload-Key` her istekte, 401 metninin hata olarak yüzeye çıkması, altyazı tek PUT.
- [ ] **Step 2:** `npx vitest run src/lib/upload.test.ts` → FAIL.
- [ ] **Step 3: Uygula** — spec 3. bölüm. "Lobide aç": `MediaPicker`'ın mevcut `onSubmit`/altyazı geri çağırmaları kullanılır (LobbyPage'e dokunmadan). Mock modunda (`import.meta.env.VITE_MOCK`) düğme gizli.
- [ ] **Step 4:** `npm test`, `npm run build` → geçer. Görsel kontrol: `npm run dev:mock`'ta düğmenin gizli olduğu; gerçek akış Task 1 ile birleşik dalda controller'ın canlı denemesinde.
- [ ] **Step 5: Commit** — `Yükleme: parçalı yükleme motoru ve yükleme penceresi`.

### Task 4: Belgeler

Depends on: Task 1–3 (adlar sabit, paralel başlayabilir).

**Files:** Modify `deploy/README.md`, `CLAUDE.md`, `frontend/README.md`.

- [ ] **Step 1:** Spec 4. bölüm; anahtar işlemlerinin lobileri düşürdüğü uyarısı; ilk kurulum: `terraform apply`, `deploy\upload-keys.ps1 -Init`, `-Add <ad>`.
- [ ] **Step 2: Commit** — `Yükleme: belgeler`.

---

## Yürütme

Task 1 ∥ Task 2 ∥ Task 3 ∥ Task 4 (ayrık dosyalar, adlar sabit). `upload` dalında birleşir (sesli sohbet `master`'a girdikten sonra `master` ile güncellenir); tam test. Canlıya alma (controller, kullanıcı onayıyla): `terraform plan` (CORS + IAM + CSP; `aws_cloudfront_response_headers_policy` yerinde güncelleme, 0 destroy) → apply → backend+frontend deploy → `upload-keys.ps1 -Init` + test anahtarı → küçük dosyayla canlı deneme → test anahtarı ve dosyası silinir → kullanıcının istediği adlar için anahtarlar.
