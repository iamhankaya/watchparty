# WatchParty

Arkadaşlarla aynı videoyu aynı anda izlemek için lobiler. Bir lobi açılır, 6 karakterlik kod paylaşılır, katılan herkesin oynatıcısı sunucuyla senkron tutulur.

## Özellikler

- **Senkron izleme:** YouTube linki veya MP4 URL'si; oynat/duraklat/ileri sar herkese yansır, tamponlayan izleyici beklenir. İsteğe bağlı olarak kontrolü yalnızca host'a bırakma.
- **Sohbet:** lobi içi mesajlaşma ve "yazıyor…" göstergesi.
- **Altyazı:** MP4 videolar için SRT/VTT altyazı.
- **Sesli sohbet:** WebRTC mesh, en fazla 6 kişi; ses sunucudan geçmez.
- **Tarayıcıdan yükleme:** video doğrudan tarayıcıdan S3'e parçalı yüklenir (kişiye özel yükleme anahtarıyla).

## Stack ve gereksinimler

- **Backend:** .NET 10, ASP.NET Core minimal API + SignalR, durum bellekte (kalıcı değil). SDK sürümü `global.json`'da sabit: **.NET SDK 10.0.401**.
- **Frontend:** React 19 + TypeScript + Vite. **Node 20.19+ veya 22.12+**.
- **Altyapı:** AWS (CloudFront + S3 + EC2), Terraform ve PowerShell deploy script'leri.

## Hızlı başlangıç

Backend (http://localhost:5205):

```powershell
cd backend\WatchParty.Api
dotnet watch
```

Frontend (http://localhost:5173; `/api` ve `/hubs` istekleri backend'e yönlendirilir):

```powershell
cd frontend
npm install
npm run dev
```

Backend olmadan yalnızca arayüz üzerinde çalışmak için:

```powershell
cd frontend
npm run dev:mock   # aynı tarayıcıdaki sekmeler sahte bir sunucuyu paylaşır
```

## Testler

```powershell
dotnet test backend\WatchParty.slnx   # backend xUnit entegrasyon testleri
cd frontend; npm test                 # frontend birim testleri (vitest)
cd frontend; npm run build            # tip kontrolü + prod build
```

Uçtan uca test, **çalışan** bir backend'e (Development ortamında) karşı koşar, ~30 sn sürer:

```powershell
cd backend\e2e
npm install
npm test   # BASE_URL ile adres değiştirilebilir (varsayılan http://localhost:5205)
```

`e2e.mjs`'i canlı ortama karşı çalıştırmayın; canlı kontrol için `npm run smoke` var (bkz. `deploy/README.md`).

## Klasör yapısı

| Klasör | İçerik |
| --- | --- |
| `backend/` | `WatchParty.Api` (REST + SignalR hub), `WatchParty.Api.Tests` (xUnit), `e2e/` (uçtan uca ve smoke script'leri) |
| `frontend/` | React uygulaması: oynatıcılar, senkron motoru, sohbet, sesli sohbet, yükleme |
| `infra/` | Terraform: CloudFront, S3, EC2, izleme alarmları |
| `deploy/` | Backend/frontend deploy ve yükleme anahtarı script'leri, systemd unit, runbook |
| `docs/` | Backlog, tasarım spec'leri ve uygulama planları (`docs/superpowers/`) |
| `tools/downloader/` | Video indirip web uyumlu MP4'e çeviren ve S3'e yükleyen Python aracı |

## Daha fazlası

- [`frontend/README.md`](frontend/README.md): frontend yapısı ve senkron modeli
- [`deploy/README.md`](deploy/README.md): AWS kurulumu, deploy, geri alma, loglar
- [`docs/BACKLOG.md`](docs/BACKLOG.md): yapılacaklar
- [`tools/downloader/README.md`](tools/downloader/README.md): video indirme aracı
- [`CLAUDE.md`](CLAUDE.md): mimarinin ayrıntılı anlatımı
