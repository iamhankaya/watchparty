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
  players/          Player arayüzü, YouTubePlayer (IFrame API), FilePlayer (<video>)
  components/       Kontroller, medya seçici, katılımcılar, sohbet, davet kutusu
  pages/            HomePage, LobbyPage
```

## Senkron nasıl çalışıyor

- Sunucu tek doğru durumu tutar (`PlaybackState`). İstemci beklenen konumu hesaplar:
  oynuyorsa `positionSec + (sunucuŞimdi - updatedAt) / 1000`.
- `SyncEngine` her 500 ms'de oynatıcıyı bu duruma çeker: sapma 1,5 sn'den büyükse seek;
  MP4'te 0,3-1,5 sn arası ise hızı 0,95/1,05 yaparak sessizce yakalar. YouTube'da sadece seek.
- Oynatıcının kendi kontrolleri kapalı (YouTube `controls=0`, üstünde tıklama kalkanı). Oynat/durdur/sar
  sadece bizim butonlardan sunucuya gider; oynatıcı olayları hiç sunucuya geri gönderilmez.
  Bu, "kodla yapılan seek'in tekrar herkese yayılması" döngüsünü tamamen engeller.
- Tarayıcı otomatik oynatmayı engellerse oynatıcının üstünde "Oynatmayı başlatmak için tıkla" çıkar.

## Bilinen sınırlar

- Backend medya id'sini en fazla 200 karakter kabul ediyor; çok uzun (ör. imzalı) film URL'leri reddedilir.
  S3/CloudFront adımında burada URL yerine film id'si gönderilecek.
- Prod'da S3/CloudFront'ta `/l/KOD` gibi adresler için 403/404 → `index.html` yönlendirmesi gerekecek (SPA).
