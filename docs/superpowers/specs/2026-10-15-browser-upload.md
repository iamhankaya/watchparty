# Tarayıcıdan video yükleme (spec)

Kaynak: 2026-10-15 brainstorming'i. Uygulamayı kullanan arkadaşlar da (komut satırı aracı olmadan) bilgisayarlarından MP4 ve isteğe bağlı altyazı yükleyebilsin; ama yalnızca yükleme anahtarı olanlar. Dosya sunucudan geçmez: sunucu anahtarı doğrular ve S3'e kısa süreli, dosyaya özel yükleme izinleri (presigned URL) üretir; tarayıcı doğrudan video bucket'ına çok parçalı yükler.

## Kararlar

| Konu | Karar |
|------|-------|
| Yetki | Kişiye özel, rastgele, 32 karakterlik (base62) yükleme anahtarları; sunucuda yalnızca **SHA-256 özeti + ad** durur |
| Anahtar yönetimi | `deploy/upload-keys.ps1` (`-Add <ad>` / `-Remove <ad>` / `-List`): anahtarı üretir, açık halini konsola **yazmaz**: Windows panosuna kopyalar (`Set-Clipboard`) ve yalnızca "panoya kopyalandı" der — böylece script Claude tarafından çalıştırılsa bile anahtar sohbet geçmişine girmez —, özeti SSM ile sunucudaki `/etc/watchparty/watchparty.env`'e yazar ve servisi yeniden başlatır (lobiler düşer; kullanıcı uyarılır). Açık anahtar repoya, loga, sohbete girmez |
| Doğrulama | Her yükleme başlangıcında; sabit zamanlı karşılaştırma; yanlış denemeler IP başına **10 dk'da 10** |
| Yükleme yolu | Tarayıcı → S3 doğrudan, multipart: parça 16 MB, aynı anda 4 parça, parça başına 3 yeniden deneme; izinler 1 saat geçerli, partiler halinde istenir |
| Sınırlar | Video ≤ **6 GB**, `.mp4`/`.m4v`/`.mkv`; altyazı ≤ **2 MB**, `.srt`/`.vtt` |
| Konum | `videolar/<32 hex>/<temizlenmiş ad>` (gizli klasör), video bucket'ı (30 gün yaşam döngüsü geçerli) |
| Sonuç | `https://<cloudfront>/videolar/...` linkleri; "Lobide aç" (video + altyazı) |
| Kayıt | Sunucu logu: anahtar adı, dosya anahtarı, boyut (anahtarın kendisi asla) |
| Dönüştürme | Yok; pencerede H.264/AAC notu |

## Kapsam

### 1. Sunucu

- `UploadOptions` (`Upload` bölümü, başlangıçta doğrulanır): `Keys` dizisi (`Name`, `Sha256` — 64 hex), `VideoBucket`, `PublicBaseUrl` (CloudFront adresi), `MaxVideoBytes` = 6 442 450 944, `MaxSubtitleBytes` = 2 097 152, `PartSizeBytes` = 16 777 216, `UrlLifetimeMinutes` = 60. `Keys` boşsa yükleme kapalıdır: uç noktalar 403 `"Yükleme kapalı"` döner.
- Anahtar doğrulama: istek başlığı `X-Upload-Key`; SHA-256 özeti `CryptographicOperations.FixedTimeEquals` ile tüm kayıtlarla karşılaştırılır. Yanlışsa 401 `"Yükleme anahtarı geçersiz"`; IP başına başarısız deneme sınırı (10 / 10 dk, `HttpRateLimits` kalıbıyla ayrı politika) aşılırsa 429.
- Uç noktalar (`/api/uploads/...`, JSON, mevcut CSP/CORS düzeniyle aynı origin):
  - `POST /api/uploads/video` `{ fileName, size }` → doğrulama (uzantı, boyut ≤ sınır, >0) → `CreateMultipartUpload` (`ContentType: video/mp4`, `CacheControl: public, max-age=31536000, immutable`) → `{ key, uploadId, partSize, partCount }`.
  - `POST /api/uploads/video/parts` `{ key, uploadId, partNumbers: number[] }` (en fazla 50) → `{ urls: { partNumber, url }[] }` (presigned `UploadPart`, `UrlLifetimeMinutes`).
  - `POST /api/uploads/video/complete` `{ key, uploadId, parts: { partNumber, eTag }[] }` → `CompleteMultipartUpload` → `{ url }`.
  - `POST /api/uploads/video/abort` `{ key, uploadId }` → `AbortMultipartUpload`.
  - `POST /api/uploads/subtitle` `{ fileName, size }` → presigned tek `PutObject` (`Content-Type` uzantıya göre: `text/vtt` / `application/x-subrip`, `CacheControl` aynı) → `{ key, putUrl, url }`.
  - Hepsi `X-Upload-Key` ister; `key` parametreleri yalnızca `videolar/` önekli ve bu sunucunun ürettiği biçimde (`videolar/[0-9a-f]{32}/[a-z0-9-]+\.(mp4|m4v|mkv|srt|vtt)`) kabul edilir → aksi 400 `"Geçersiz dosya anahtarı"`.
- Dosya adı temizleme: Türkçe karakterler ASCII'ye (`ğ→g, ü→u, ş→s, ı→i, ö→o, ç→c`), küçük harf, `[a-z0-9]` dışı tek `-`, en fazla 80 karakter, uzantı korunur; boşsa `video`/`altyazi`. Sonuç linki `MediaValidator`'ın 200 karakter sınırına sığar (doğrulanır).
- Hatalar Türkçe: `"Dosya çok büyük"`, `"Yalnızca .mp4, .m4v veya .mkv yüklenebilir"`, `"Yalnızca .srt veya .vtt yüklenebilir"`, `"Yükleme tamamlanamadı"` (S3 hatası, ayrıntı yalnızca logda).
- AWS: `AWSSDK.S3`; kimlik bilgisi EC2 instance rolünden (yerelde `AWS_PROFILE`); bölge `eu-north-1`.

### 2. Altyapı (Terraform)

- Video bucket'ına CORS: `AllowedOrigins = ["https://<cloudfront>"]` (+ ayrı değişkenle isteğe bağlı geliştirme origin'i), `AllowedMethods = ["PUT"]`, `AllowedHeaders = ["*"]`, `ExposeHeaders = ["ETag"]`, `MaxAgeSeconds = 3000`.
- EC2 rolüne politika: `s3:PutObject`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts` yalnızca `arn:aws:s3:::<videos>/videolar/*`.
- CSP `connect-src`'e video bucket'ının bölgesel adresi: `https://<videos>.s3.eu-north-1.amazonaws.com`.
- Ortam dosyası şablonu: `Upload__VideoBucket`, `Upload__PublicBaseUrl` (Terraform çıktılarından); anahtar özetleri script'le eklenir (şablonda yok).
- `apply` öncesi plan kullanıcıya gösterilir.

### 3. İstemci

- `lib/upload.ts` (saf + enjekte edilebilir `fetch`/`PUT`): `uploadVideo(file, key, { onProgress, signal })`, `uploadSubtitle(file, key, ...)`; parça planlama, 4'lü eşzamanlılık, parça başına 3 yeniden deneme (artan bekleme), iptalde `abort` çağrısı; ilerleme: yüklenen bayt, hız (son 5 sn), kalan süre. ETag'ler PUT yanıt başlığından.
- `components/UploadDialog.tsx`: anahtar alanı (+ "Bu tarayıcıda hatırla" → `localStorage` `wp:uploadKey`, try/catch), MP4 ve altyazı seçiciler (istemcide uzantı/boyut kontrolü, sunucu metinleriyle), "Yükle", ilerleme çubuğu/yüzde/hız/kalan süre, "İptal", bitince linkler (kopyala) ve `canControl` iken "Lobide aç" (`setMedia("file", url)` sonra varsa `setSubtitle(url)`). Not metni: "En iyi sonuç için H.264 video ve AAC ses içeren MP4 kullanın."
- `MediaPicker`'a "Bilgisayardan yükle" düğmesi.
- Mock modu: yükleme gerçek sunucu gerektirir; `dev:mock`'ta düğme gizli (ya da "Mock modunda yükleme yok" notu).

### 4. Belgeler

- `deploy/README.md`: anahtar ekleme/çıkarma/listeleme, servis yeniden başlatma uyarısı, CORS/CSP notu.
- `CLAUDE.md`: uç noktalar, `Upload` ayarı, anahtar özetleri, dosya sunucudan geçmez.
- `frontend/README.md`: yükleme akışı.

## Doğrulama

- xUnit (S3 istemcisi sahte arayüzle — `IUploadStorage`): anahtar yok/yanlış → 401; doğru → başlar; 11. yanlış deneme → 429; boyut/uzantı hataları; geçersiz `key` deseni → 400; `Keys` boş → 403 `"Yükleme kapalı"`; ad temizleme (Türkçe karakter, boşluk, uzun ad, boş ad); parça URL'si en fazla 50; tamamla/iptal sahte depoya doğru çağrıları yapar; log anahtarı içermez.
- Vitest: parça planlama (6 GB sınırı, son parça), eşzamanlılık 4, yeniden deneme ve iptal, ilerleme/hız/kalan süre hesabı.
- Canlı (gerçek AWS, deploy sonrası, kullanıcı onayıyla): bir test anahtarıyla küçük (≈50 MB) MP4 + SRT tarayıcıdan yüklenir; link 200/206 döner, lobide oynar, altyazı görünür; yanlış anahtar 401; test anahtarı sonra silinir; test dosyası silinir.

## Kapsam dışı

- Tarayıcıda dönüştürme, sayfa yenilemeden sonra devam, yönetim ekranı, kullanıcı hesapları.
