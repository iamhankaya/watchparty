# Videolar için ayrı bucket (spec)

Kaynak: 2026-10-13 brainstorming'i, `docs/BACKLOG.md`'deki "Videolar için ayrı bucket" maddesi. Bugün `tools/downloader` videoları site bucket'ına `videolar/` altına yüklüyor; CloudFront bunları varsayılan (site) behavior'ından veriyor.

## Kararlar

| Konu | Karar |
|------|-------|
| Depolama | Yeni private bucket `watchparty-videos-<ek>` (mevcut `random_id.bucket_suffix` ile aynı ek) |
| Erişim | Yalnızca CloudFront (mevcut OAC yeniden kullanılır), bucket policy yalnızca bu dağıtımın ARN'si |
| Link biçimi | Değişmez: `https://<cloudfront>/videolar/<...>.mp4`; CloudFront'ta `/videolar/*` yeni bucket'a gider, anahtarlar `videolar/` önekiyle aynen kalır |
| Yaşam döngüsü | Tüm nesneler 30 gün sonra silinir; yarım kalmış çok parçalı yüklemeler 2 gün sonra iptal edilir |
| Edge önbelleği | Videolar için ayrı cache policy, en fazla 1 gün: S3'te silinen bir video CloudFront'ta en geç 1 gün sonra erişilemez olur (nesneler `max-age=31536000, immutable` ile yükleniyor) |
| İndirme aracı | Kod değişmez (zaten `videolar/` önekiyle yüklüyor); yalnızca `--s3-bucket` olarak yeni bucket verilir. Kod diğer session'ın sahipliğinde |
| Uygulama zamanı | Kod şimdi; `terraform apply` ve taşıma, aktif izleme bittikten sonra ve kullanıcı onayıyla |
| CI deploy rolü | Video bucket'ına hiçbir izni yok |

## Kapsam

### 1. Terraform (`infra/videos.tf`, `infra/cdn.tf`, `infra/outputs.tf`)

- `aws_s3_bucket.videos`: `"${var.project}-videos-${random_id.bucket_suffix.hex}"`, `force_destroy = true`.
- `aws_s3_bucket_public_access_block.videos`: dört ayar `true`.
- `aws_s3_bucket_policy.videos`: site bucket'ındakiyle aynı biçim — `s3:GetObject` yalnızca `cloudfront.amazonaws.com` servis principal'ına, `AWS:SourceArn` = `aws_cloudfront_distribution.main.arn` (`StringEquals`).
- `aws_s3_bucket_lifecycle_configuration.videos`: kural `eski-videolari-sil` (tüm bucket, boş filtre) `expiration { days = 30 }`; kural `yarim-yuklemeleri-iptal-et` `abort_incomplete_multipart_upload { days_after_initiation = 2 }`.
- `aws_cloudfront_cache_policy.videos`: `name = "${var.project}-videos"`, `min_ttl = 0`, `default_ttl = 86400`, `max_ttl = 86400`; cache key'de header/cookie/query string yok; gzip/brotli kapalı (MP4 sıkıştırılmaz).
- `cdn.tf`: yeni origin `local.videos_origin_id = "videos"` (`aws_s3_bucket.videos.bucket_regional_domain_name`, mevcut `aws_cloudfront_origin_access_control.site`). Yeni `ordered_cache_behavior` mevcut `/api/*` ve `/hubs/*` bloklarından sonra eklenir (desenler çakışmadığı için sıra davranışı değiştirmez; mevcut bloklar yerinde kalır): `path_pattern = "/videolar/*"`, `allowed_methods`/`cached_methods` `["GET", "HEAD"]`, `viewer_protocol_policy = "redirect-to-https"`, `compress = false`, `cache_policy_id = aws_cloudfront_cache_policy.videos.id`, `response_headers_policy_id` = mevcut security policy. Function association yok (SPA yönlendirmesi videolara uygulanmaz).
- Çıktı `video_bucket` (`outputs.tf`).
- Beklenen plan: yeni kaynaklar eklenir, yalnızca `aws_cloudfront_distribution.main` yerinde güncellenir (`~ update in-place`); hiçbir şey silinmez ya da yeniden oluşturulmaz.

### 2. Taşıma (izleme bittikten sonra, kullanıcı onayıyla; sıra önemli)

1. Site bucket'ındaki `videolar/` içeriğinin listesi alınır.
2. Önce yalnızca bucket kurulur, CloudFront'a dokunulmaz: `terraform apply -target=aws_s3_bucket.videos -target=aws_s3_bucket_public_access_block.videos -target=aws_s3_bucket_lifecycle_configuration.videos`. Bucket policy bu adımda **hedeflenmez**: dağıtımın ARN'sine bağlı olduğu için `-target` dağıtımın kendisini de (yeni behavior'la birlikte) güncellerdi. Plan çıktısında `aws_cloudfront_distribution.main` görünürse durulur.
3. Nesneler yeni bucket'a **sunucu tarafında** kopyalanır: `aws s3 cp s3://<site>/videolar/ s3://<videos>/videolar/ --recursive` (Content-Type ve Cache-Control korunur; 2 GB'lık dosya ev bağlantısından geçmez). Kopyanın tamamlandığı `aws s3 ls` ile boyutlar karşılaştırılarak doğrulanır.
4. Tam `terraform apply` (bucket policy, cache policy, origin, `/videolar/*` behavior). Policy dağıtım güncellemesinden saniyeler sonra oluşur; CloudFront'un yeni yapılandırmayı edge'lere yayması dakikalar sürdüğü için arada 403 görülmez. Video bu noktada iki bucket'ta da durduğu için CloudFront'un yayılması sırasında hangi origin'e gidilirse gidilsin link çalışır.
5. Doğrulama (dağıtım durumu `Deployed` olduktan sonra): mevcut video linki `curl -sI` ile 200 ve `Content-Type: video/mp4` döner, yanıt yeni origin'den gelir (`x-cache` alanı ilk istekte `Miss from cloudfront`); `Range: bytes=0-99` isteği 206 döner; bir uydurma yol (`/videolar/yok.mp4`) 403 döner (OAC'li private bucket, liste izni yok); site (`/`, `/l/ABCDEF`) ve smoke testi etkilenmez.
6. Site bucket'ındaki `videolar/` silinir. Yeni bucket'taki kopya taşıma günü başlayan 30 günlük ömre sahiptir.

### 3. Belgeler

- `CLAUDE.md` "Video downloader" bölümü: yüklemeler video bucket'ına; örnek komutta `--s3-bucket` yeni bucket (`terraform -chdir=infra output -raw video_bucket`); 30 günlük silme ve 1 günlük edge önbelleği; "site bucket'ı / `deploy-frontend.ps1` never deletes" notu güncellenir.
- `deploy/README.md`: altyapı çıktıları listesine `video_bucket`; kısa "Videolar" notu (yaşam döngüsü, `--gizli` linkleri, elle silme: `aws s3 rm` + gerekirse invalidation).
- `docs/BACKLOG.md`: "Videolar için ayrı bucket" maddesi silinir.
- `tools/downloader/README.md` diğer session'ın dosyası; genel örnekler (`benim-bucket`) zaten doğru, değiştirilmez.

## Doğrulama

- `terraform fmt -check`, `validate`; `node --test "infra/tests/*.test.mjs"` (SPA function değişmez).
- Tam `terraform plan` çıktısı 1. bölümdeki beklentiyle aynı (ekleme + dağıtımda yerinde güncelleme, 0 destroy).
- 2. bölüm 5. adımdaki canlı kontroller; ardından smoke 6/6.

## Kapsam dışı

- Video linklerini imzalı URL/cookie ile koruma.
- Downloader'ın varsayılan bucket'ını değiştirme (kod değişikliği; diğer session).
- Videoların ayrı bir alan adından verilmesi.
