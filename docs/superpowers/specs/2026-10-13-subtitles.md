# Altyazı (spec)

Kaynak: 2026-10-13 brainstorming'i. MP4 videolara lobi genelinde ortak bir altyazı (link) eklenir; her izleyici kendi ekranında açıp kapatır. YouTube kapsam dışı (kendi altyazı menüsü var, biz kontrol etmiyoruz).

## Kararlar

| Konu | Karar |
|------|-------|
| Kaynak | Link (`https://`), lobi genelinde ortak; dosya S3'e (videoyla aynı yere) yüklenir |
| Biçim | `.vtt` ve `.srt` |
| Kodlama | Önce UTF-8 (`fatal`), olmazsa Windows-1254 (Türkçe SRT'lerin çoğu böyle) |
| Erişim | Altyazı dosyası tarayıcıda `fetch` ile okunur; CSP `connect-src 'self'` olduğundan **yalnızca sitenin kendi alanındaki** (`https://<cloudfront>/...`) dosyalar açılır. CSP gevşetilmez. Başka alandaki link sunucuda kabul edilir ama tarayıcı "yalnızca bu sitedeki dosyalar" hatası gösterir |
| Gösterim | `<track>`/blob URL yok (CSP `media-src` `blob:` içermiyor): dosya ayrıştırılır, `video.addTextTrack("subtitles")` + `VTTCue` ile eklenir |
| Kim değiştirir | `SetMedia` ile aynı kural: host-only modda yalnızca host |
| Ne zaman | Video seçilirken ya da oynarken sonradan; yeni video seçilince altyazı sıfırlanır |
| Kişisel ayar | CC düğmesi; açık/kapalı `localStorage` (`wp:subtitles`), varsayılan açık |

## Kapsam

### 1. Backend

- `PlaybackState`'e son alan olarak `string? SubtitleUrl` eklenir (JSON `subtitleUrl`); `Empty`'de `null`.
- `SetMedia` `SubtitleUrl`'i `null` yapar (imzası değişmez; e2e etkilenmez).
- Yeni hub metodu `SetSubtitle(string? url)`:
  - `null`/boş string altyazıyı kaldırır.
  - Doğrulama `MediaValidator.ValidateSubtitle(string? url)`: mutlak `https` URL, en fazla 200 karakter (`MaxIdLength`), baş/son boşluk yok. Hata metinleri: `"Altyazı adresi https:// ile başlamalı"`, `"Altyazı adresi en fazla 200 karakter olmalı"`.
  - Medya yoksa `"Önce bir medya seç"`; medya `youtube` ise `"Altyazı yalnızca MP4 videolarda kullanılabilir"`.
  - Host-only modda host değilse `"Sadece host kontrol edebilir"` (mevcut metin).
  - **Konum ve `UpdatedAt` değişmez**: oynarken `UpdatedAt` yenilenip `PositionSec` aynı kalsaydı herkes geri atlardı. Bu yüzden `Update(...)` yardımcısı kullanılmaz; aynı kilit/kural sırasıyla yalnızca `SubtitleUrl` değiştirilip `PlaybackUpdated` yayınlanır.
  - Hub rate limit: playback kovası — `Security/HubRateLimitFilter.cs` `PlaybackMethods` kümesine `"SetSubtitle"` eklenir.
- `LobbyTickService`'in 10 sn'lik yeniden yayını ve `JoinLobby` sonrası durum zaten `PlaybackState`'in tamamını taşır; sonradan katılan altyazıyı alır.

### 2. Frontend

- `types.ts` `PlaybackState`'e `subtitleUrl: string | null`; `MAX_MEDIA_ID` altyazı için de kullanılır.
- `LobbyConnection`'a `setSubtitle(url: string | null): Promise<void>` (gerçek: `"SetSubtitle"`; mock: aynı kurallar ve Türkçe metinler — `lib/mock.ts`).
- `lib/subtitles.ts` (saf fonksiyonlar, birim testli):
  - `decodeSubtitle(bytes: ArrayBuffer): string` — UTF-8 `fatal`, hata olursa `windows-1254`; baştaki BOM atılır.
  - `parseSubtitles(text: string): Cue[]` (`Cue = { start: number; end: number; text: string }`) — VTT (`WEBVTT` başlığı, `NOTE`/`STYLE` blokları atlanır, cue ayarları yok sayılır) ve SRT (sıra numarası, `00:00:01,000 --> 00:00:02,500`); `\r\n` ve `\r` normalize; saat kısmı isteğe bağlı (`mm:ss.ttt`); bozuk bloklar atlanır; satır içi `<i>`/`<b>` gibi etiketler metinde kalır (VTTCue işler), SRT `{\an8}` gibi ASS etiketleri silinir.
- `FilePlayer`: `subtitleUrl` prop'u. Değişince önceki altyazı izi devre dışı kalır, yenisi için `fetch` → `decodeSubtitle` → `parseSubtitles` → `addTextTrack("subtitles", "Altyazı")` + `VTTCue`'lar. Mod `showing`/`hidden` kişisel ayara göre. Hata durumları `onError` ile Türkçe: erişim/CSP (`"Altyazı yüklenemedi: yalnızca bu sitedeki dosyalar açılabiliyor"` — URL origin'i `location.origin` değilse istek atmadan), HTTP hatası (`"Altyazı yüklenemedi (HTTP <kod>)"`), boş/ayrıştırılamayan (`"Altyazı dosyası okunamadı"`).
- `MediaPicker`: isteğe bağlı ikinci alan "Altyazı linki (.vtt / .srt, isteğe bağlı)". Video ile birlikte gönderilirse önce `setMedia`, başarılıysa `setSubtitle`. Video seçiliyken yalnızca altyazı alanı doldurulup gönderilebilir (`setSubtitle`); mevcut altyazıyı kaldırma düğmesi ("Altyazıyı kaldır") altyazı varken görünür. Uzunluk/https kontrolü istemcide de yapılır.
- `Controls`: medya `file` ve `subtitleUrl` varken **CC** düğmesi (yeni `Icon` adı `cc`), `aria-pressed`. Ayar `lib/identity.ts` içinde, `getVolume`/`saveVolume` gibi: `getSubtitlesOn()/saveSubtitlesOn()` (`wp:subtitles`, try/catch).
- Stil: cue'lar `::cue` ile (font ailesi uygulamanınki, yarı saydam koyu zemin); tam ekranda daha büyük. Renkler token olarak iki temada.

### 3. Belgeler

- `frontend/README.md` (senkron/oynatıcı bölümü): altyazı akışı, kodlama tespiti, aynı alan kısıtı.
- `CLAUDE.md`: hub metot listesine `SetSubtitle`, `PlaybackState`'teki yeni alan, sınırların üç yerde (backend, `types.ts`, `mock.ts`) eş tutulduğu notu zaten var.
- `tools/downloader` değişmez (başka session'ın).

## Doğrulama

- xUnit: `SetSubtitle` başarı ve yayın; `null` ile kaldırma; https olmayan / 201 karakter / boşluklu → doğru Türkçe hata; medya yokken ve YouTube'dayken hata; host-only'de host olmayan reddedilir; `SetMedia` altyazıyı sıfırlar; `SetSubtitle` oynarken `PositionSec` ve `UpdatedAt`'i değiştirmez.
- Vitest: `decodeSubtitle` (UTF-8, BOM'lu UTF-8, Windows-1254 "ğüşıöç"), `parseSubtitles` (SRT, VTT, CRLF, saat yok, bozuk blok, ASS etiketi, boş dosya).
- e2e (`backend/e2e/e2e.mjs`): host altyazı ekler, ikinci istemci `PlaybackUpdated`'de `subtitleUrl`'i görür; YouTube'da hata metni "yalnızca MP4".
- Canlı: S3'e bir `.srt` (Windows-1254) yükleyip bir MP4 lobisinde iki sekmede görünürlüğü, CC aç/kapa ve tam ekranı denemek.

## Kapsam dışı

- YouTube altyazıları, altyazı zaman kaydırma, birden fazla dil, başka alandaki altyazılar (CSP), indirme aracının altyazı indirmesi.
