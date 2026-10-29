# Ses dönüştürücü

Tarayıcıda (Chrome) çalmayan sesi — E-AC3, AC3, DTS, TrueHD — AAC'ye çevirir. Video akışına dokunulmaz (`-c:v copy`), yalnızca **ilk ses izi** AAC stereo 192k olur; sonuç `<ad>-aac.mp4` (`+faststart`) olarak yazılır. Orijinal dosya korunur. Ses zaten uyumluysa (AAC, sessiz) dosyaya dokunulmaz. Video H.264 değilse dosya atlanır (araç videoyu yeniden kodlamaz). Yalnızca yerelde çalışır, sunucuyla ilgisi yoktur.

Çıktı zaten varsa asla ezilmez: süresi kaynakla eşleşiyorsa (aynı eşik: max 2 sn ya da %1) yeniden kullanılır (`atlandi`); eşleşmiyorsa ya da okunamıyorsa aynı adlı başka bir kaynağın çıktısı olabilir, hata verilir (silin ya da başka `--cikti` verin). `indir.py --dosya` da bunu izler.

## Kurulum

Yalnızca ffmpeg ve ffprobe gerekir (`winget install Gyan.FFmpeg`, sonra terminali yeniden açın). Python bağımlılığı yok.

## Kullanım

```powershell
cd tools\converter
python donustur.py film.mkv                       # film-aac.mp4, filmin yanına
python donustur.py D:\filmler                     # dizindeki .mkv/.mp4/.m4v dosyaları (alt dizinler taranmaz)
python donustur.py D:\filmler --cikti D:\hazir    # çıktıları başka klasöre yaz
python donustur.py film.mkv --dry-run             # yalnız planı yazdır
```

Çıkış kodu: hata yoksa 0, en az bir dosya başarısızsa 1.

## Güvenlik ve doğrulama

- ffmpeg/ffprobe argüman dizisiyle çağrılır, shell yoktur.
- Çıktı önce `<ad>-aac.mp4.tmp` olarak yazılır; ffmpeg 0 ile çıksa da çıktı süresi girdiden `max(2 sn, %1)`'den fazla kısaysa (kesik girdi) çıktı silinir ve dosya hata sayılır. Doğrulanınca `-aac.mp4`'e taşınır.
- Var olan `-aac.mp4` ezilmez.
- Stereo karıştırma ffmpeg varsayılanıdır; 5.1'de diyalog kısık kalırsa kullanıcı şikâyetine göre ayrıca ayarlanır.

## Testler

```powershell
cd tools\converter; python -m unittest   # ffmpeg yoksa gerçek dosya testleri atlanır
```

`tools/downloader` dönüşüm için bu aracı kullanır.
