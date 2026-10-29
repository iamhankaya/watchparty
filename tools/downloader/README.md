# Video indirme aracı

Bir videoyu [yt-dlp](https://github.com/yt-dlp/yt-dlp) ile indirir, ffmpeg ile web'e uygun MP4'e (H.264 + AAC + `faststart`) çevirir, S3'e yükler ve WatchParty lobisine yapıştırılacak `https://` linkini yazdırır.

Yalnızca hakkı sizde olan ya da indirilmesine izin verilen içerik için kullanın. DRM'li içerik (Netflix vb.) indirilemez.

## Kurulum

```powershell
winget install Gyan.FFmpeg          # ffmpeg + ffprobe; sonra terminali yeniden açın
cd tools\downloader
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
aws configure                       # ya da AWS_PROFILE / AWS_ACCESS_KEY_ID ayarlayın
```

YouTube için PATH'te Node (frontend için zaten gerekli) ya da Deno bulunmalı; yt-dlp JS doğrulamalarını onunla çözer.

AWS kullanıcısının hedef bucket için `s3:PutObject` ve (`--bolge` verilmezse) `s3:GetBucketLocation` izni olmalı.

## Kullanım

```powershell
python indir.py <url> --s3-bucket benim-bucket --cdn-url https://dxxxx.cloudfront.net
python indir.py <url> --maks-yukseklik 720 --s3-bucket benim-bucket   # 720p'ye küçült
python indir.py <url> --sadece-indir                                   # yükleme yok, dosya indirilenler\ altında
```

| Seçenek | Ortam değişkeni | Açıklama |
|---|---|---|
| `--s3-bucket` | `WP_S3_BUCKET` | Hedef bucket |
| `--s3-onek` | `WP_S3_ONEK` | Anahtar öneki, varsayılan `videolar` |
| `--cdn-url` | `WP_CDN_URL` | CloudFront adresi; verilirse link bunun üzerinden kurulur |
| `--bolge` | `AWS_REGION` | Bucket bölgesi; verilmezse sorgulanır |
| `--maks-yukseklik` | | Daha yüksek çözünürlükleri küçültür |
| `--crf` | | x264 kalitesi (varsayılan 23; küçük = daha kaliteli, daha büyük dosya) |
| `--cikti` | | Yerel klasör, varsayılan `indirilenler` |
| `--dosya` | | URL yerine hazır bir videoyu (MP4/MKV) yükler; indirme yapılmaz, yalnızca ses uyumsuzsa `--ses-donustur` uygulanır |
| `--ses-donustur` | | `otomatik` (varsayılan) ya da `hayir`. `--dosya` için: ses E-AC3/AC3/DTS/TrueHD ise `<ad>-aac.mp4` üretilip o yüklenir, uyumluysa dosyaya dokunulmaz |
| `--gizli` | | Anahtara tahmin edilemez bir klasör ekler; link bilinmeden dosya bulunamaz |

Dönüşüm planı üç türlüdür: kaynak zaten H.264/AAC ise video yeniden kodlanmaz, sadece `faststart` ile kopyalanır (saniyeler sürer); video uygun ama ses AAC değilse video aynen kopyalanır, yalnızca ses AAC stereo 192k'ya çevrilir (dakikalar); ikisi de uygun değilse x264 ile kodlanır, 1,5 saatlik bir film CPU'ya göre 15-60 dakika sürebilir. Ses dönüşümü [`tools/converter`](../converter/README.md) ile ortaktır (aynı argümanlar, aynı süre doğrulaması); dönüşüm sonrası çıktı süresi girdiyle karşılaştırılır, kesikse çıktı silinir ve girdi korunur. S3 `ContentType` uzantıya göre seçilir (`.mkv` → `video/x-matroska`, aksi `video/mp4`).

Link CloudFront üzerinden verilmelidir: S3'ten doğrudan indirme hem daha pahalıdır hem de bucket'ın herkese açık olmasını gerektirir. WatchParty en fazla 200 karakterlik link kabul eder.

## Testler

```powershell
cd tools\downloader; python -m unittest
```
