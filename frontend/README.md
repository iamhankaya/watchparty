# WatchParty frontend

React + TypeScript + Vite. Lobi oluşturma/katılma, YouTube ve MP4 oynatıcı, SignalR ile senkron, sohbet.

## Çalıştırma

Node.js 20.19+ veya 22.12+ gerekir (`node -v`).

```powershell
cd C:\dev\watchparty\frontend
npm install
npm run dev
```

Tarayıcıda http://localhost:5173 açılır. `/api` ve `/hubs` istekleri Vite proxy'si ile
`http://localhost:5205`'teki .NET backend'e gider, bu yüzden backend'in de çalışıyor olması gerekir
(`cd backend\WatchParty.Api; dotnet watch`). Backend başka porttaysa:
`$env:BACKEND_URL="http://localhost:5123"; npm run dev`.

**Backend olmadan:** `npm run dev:mock`. Aynı tarayıcıdaki sekmeler sahte bir sunucuyu paylaşır
(her sekme ayrı kişi sayılır). Arayüz üzerinde çalışmak için.

**Prod build:** `npm run build` → `dist/` klasörü. AWS adımında S3'e bu klasör yüklenecek.

**Test:** `npm test` (vitest).

## Yapı

```
src/
  lib/
    api.ts          REST: POST/GET /api/lobbies
    connection.ts   SignalR hub istemcisi (/hubs/lobby), yeniden bağlanınca otomatik JoinLobby
    mock.ts         backend'siz geliştirme için sahte sunucu
    clock.ts        Ping ile sunucu saat farkı (en düşük gidiş-dönüşlü ölçüm)
    sync.ts         SyncEngine: sunucu durumunu oynatıcıya uygular
    identity.ts     localStorage'da clientId ve takma ad
    media.ts        YouTube linki / MP4 URL ayrıştırma
    subtitles.ts    altyazı kodlama tespiti (decodeSubtitle) ve SRT/VTT ayrıştırma (parseSubtitles)
    theme.ts        koyu/açık tema (localStorage, yoksa sistem tercihi)
  players/          Player arayüzü, YouTubePlayer (IFrame API), FilePlayer (<video>)
  components/       Kontroller, medya seçici, katılımcılar, sohbet, ikonlar,
                    LobbyStrip (kod panosu, durum, davet linki), SidePanel (Sohbet/Kişiler sekmeleri)
  pages/            HomePage, LobbyPage
  styles.css        tek stil dosyası; renkler :root ve :root[data-theme="light"] token'larında
```

## Senkron nasıl çalışıyor

- Sunucu tek doğru durumu tutar (`PlaybackState`). İstemci beklenen konumu hesaplar:
  oynuyorsa `positionSec + (sunucuŞimdi - updatedAt) / 1000`.
- `SyncEngine` her 500 ms'de oynatıcıyı bu duruma çeker: sapma 1,5 sn'den büyükse seek;
  MP4'te 0,3-1,5 sn arası ise hızı 0,95/1,05 yaparak sessizce yakalar. YouTube'da sadece seek.
- Oynatıcının kendi kontrolleri kapalı (YouTube `controls=0`, üstünde tıklama kalkanı). Oynat/durdur/sar
  sadece bizim butonlardan sunucuya gider; oynatıcı olayları hiç sunucuya geri gönderilmez.
  Bu, "kodla yapılan seek'in tekrar herkese yayılması" döngüsünü tamamen engeller.
- Takılana göre bekleme: oynaması gerekirken (`shouldPlay`, otomatik oynatma engeli yokken) `Player.isBuffering()`
  art arda 1 sn doğruysa `SyncEngine` bir kez `onBuffering(true)` der ve istemci bunu sunucuya `reportBuffering` ile iletir;
  `false`'u ise oynatıcı donmuş konuma yetiştiğinde (oynatıcı konumu >= donmuş hedef − 0,3 sn) ve oynuyorken bildirir. Sunucu `waitingFor` doluyken konumu dondurur (`expectedPosition` donmuş `positionSec` döner),
  diğer izleyiciler duraklayıp konumu tutar. Kendi bağlantın `waitingFor`'dayken sapma düzeltmesi (seek/hız) **yapılmaz**,
  yalnızca oynatmaya devam edilir. Takılan istemci donmuş konumun gerisindedir; herkes donukken ona yetişir,
  `false` gelince de herkes aynı yerden devam eder.
  "Beklemeden devam et"ten veya 10 sn sınırından sonra hâlâ takılı olan izleyici, medya ya da oynatma durumu değişene kadar tekrar bildirmez (normal sapma senkronu sürer).
  Bu, "oynatıcı olayları sunucuya gitmez" kuralının tek istisnasıdır (yalnızca "takıldım / yetiştim"; konum, seek, oynat/durdur gitmez).
  Bekleme bir kişi için en fazla 10 sn sürer; aynı kişi 5 dk içinde 3 kez beklenirse sonrakiler yok sayılır ve lobiye
  "bağlantısı yavaş; beklenmeyecek" bildirilir. Not: bir kullanıcının tamponlanmamış bir yere seek yapması herkesin 1 sn'den uzun takılıp bildirmesine ve
  herkesin 5 dk'daki 3 hakkından birini harcamasına yol açabilir. Kontrol edebilenler "Beklemeden devam et" ile beklemeyi bitirebilir.
- Tarayıcı otomatik oynatmayı engellerse oynatıcının üstünde "Oynatmayı başlatmak için tıkla" çıkar.

## Altyazı

- Sadece MP4 için; YouTube'un kendi altyazı menüsü var. Altyazı linki (`.vtt` / `.srt`) lobi genelinde ortaktır:
  `PlaybackState.subtitleUrl` ile sunucudan gelir, host-only modda yalnızca host değiştirir, yeni video seçilince sıfırlanır.
  Link `MediaPicker`'daki isteğe bağlı alandan (videoyla birlikte ya da sonradan) gönderilir.
- `FilePlayer` dosyayı tarayıcıda `fetch` ile okur, `decodeSubtitle` ve `parseSubtitles` ile ayrıştırır, `video.addTextTrack("subtitles")` +
  `VTTCue` ile ekler (`<track>`/blob URL yok: CSP `media-src` `blob:` içermiyor).
- Kodlama: önce UTF-8 (`fatal`), olmazsa Windows-1254 (Türkçe SRT'lerin çoğu böyle); baştaki BOM atılır.
- Aynı alan kısıtı: CSP `connect-src 'self'` olduğundan yalnızca sitenin kendi alanındaki dosyalar açılır (S3/CloudFront'a yüklenenler).
  Başka alandaki link sunucuda kabul edilir ama tarayıcı "Altyazı yüklenemedi: yalnızca bu sitedeki dosyalar açılabiliyor" der; CSP gevşetilmez.
- Dosyayı sitenin alanına almak: altyazıyı videonun yanına yükle, örn.
  `aws s3 cp film.srt s3://<site_bucket>/videolar/<gizli-klasör>/film.srt --profile watchparty`, link
  `https://<cloudfront>/videolar/<gizli-klasör>/film.srt`.
- Düzeltilmiş dosyayı YENİ bir adla yükle: CloudFront 24 saate kadar önbelleğe alır ve istemciler aynı URL'yi yeniden çekmez
  (ya da önbelleği invalidate et).
- Yerel geliştirmede yalnızca `frontend/public` içindeki dosyalar aynı alandadır.
- Kişisel ayar: **CC** düğmesi altyazıyı bu izleyici için açar/kapar (`localStorage` `wp:subtitles`, varsayılan açık); herkesin ekranını etkilemez.

## Bilinen sınırlar

- Backend medya id'sini en fazla 200 karakter kabul ediyor; çok uzun (ör. imzalı) film URL'leri reddedilir.
  S3/CloudFront adımında burada URL yerine film id'si gönderilecek.
- SPA yönlendirmesi: CloudFront Function (`infra/spa-rewrite.js`) uzantısız yolları `index.html`'e yazar; custom error response kullanılmaz çünkü API'nin 404'ünü bozar.
- Fontlar (Big Shoulders Display, Instrument Sans) Google Fonts'tan yüklenir. Prod CSP'sinde
  `style-src` için `fonts.googleapis.com`, `font-src` için `fonts.gstatic.com` izinli olmalı.
