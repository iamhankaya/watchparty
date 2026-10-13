# Altyazı Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MP4 lobilerine ortak bir altyazı linki eklenebilsin; her izleyici CC ile kendi ekranında açıp kapatsın.

**Architecture:** `PlaybackState`'e `SubtitleUrl` alanı ve yeni hub metodu `SetSubtitle` (konum/zaman damgasına dokunmadan). Tarayıcı dosyayı `fetch` eder, kodlamasını çözer, VTT/SRT'yi ayrıştırıp `addTextTrack` + `VTTCue` ile ekler (CSP'yi gevşetmeden).

**Tech Stack:** .NET 10 / SignalR / xUnit, React 19 + TypeScript / Vitest, Node e2e (`@microsoft/signalr`).

**Spec:** `docs/superpowers/specs/2026-10-13-subtitles.md`

## Global Constraints

- Kod yorumları, UI metinleri, hata mesajları, commit mesajları Türkçe; commit mesajları `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` ile biter. CLAUDE.md İngilizce.
- Hata metinleri birebir: `"Altyazı adresi https:// ile başlamalı"`, `"Altyazı adresi en fazla 200 karakter olmalı"`, `"Altyazı yalnızca MP4 videolarda kullanılabilir"`, `"Önce bir medya seç"`, `"Sadece host kontrol edebilir"`; istemci: `"Altyazı yüklenemedi: yalnızca bu sitedeki dosyalar açılabiliyor"`, `"Altyazı yüklenemedi (HTTP <kod>)"`, `"Altyazı dosyası okunamadı"`.
- Adlar: C# `PlaybackState.SubtitleUrl` (son alan), hub `SetSubtitle(string? url)`, `MediaValidator.ValidateSubtitle(string? url)`; TS `subtitleUrl: string | null`, `LobbyConnection.setSubtitle(url: string | null): Promise<void>`, `lib/subtitles.ts` → `decodeSubtitle(bytes: ArrayBuffer): string`, `parseSubtitles(text: string): Cue[]`, `export interface Cue { start: number; end: number; text: string }`; `lib/identity.ts` → `getSubtitlesOn(): boolean`, `saveSubtitlesOn(on: boolean): void` (anahtar `wp:subtitles`, varsayılan `true`); `Icon` adı `cc`.
- Uzunluk sınırı 200 (`MediaValidator.MaxIdLength`, `MAX_MEDIA_ID`); backend, `types.ts` ve `lib/mock.ts` kuralları eş.
- `SetSubtitle` `PositionSec`, `IsPlaying` ve `UpdatedAt`'i değiştirmez.
- Oynatıcı olaylarından sunucuya hiçbir şey gönderilmez (CLAUDE.md senkron kuralı).
- Yeni renkler `styles.css`'te iki temada token.

## Review Focus

- **Oynarken altyazı eklemek herkesi geri atlatır mı?** `UpdatedAt` değişmemeli. → Task 1 testi `SetSubtitle_does_not_touch_position_or_timestamp`.
- **Windows-1254 SRT** ("ÅŸ" bozulması). → Task 2 testi `decodeSubtitle` 1254 vakası.
- **Altyazı değişince eski cue'lar kalmamalı / video değişince altyazı izi temizlenmeli.** → Task 3 Step'te açıkça; canlı denemede kontrol.
- **Başka alandaki altyazı linki**: istek atılmadan Türkçe hata. → Task 3.
- **Sonradan katılan / yeniden bağlanan** altyazıyı görür (durum `JoinLobby` ve tick yayınıyla gelir). → Task 4 e2e.

---

### Task 1: Backend — `SubtitleUrl`, `SetSubtitle`, doğrulama

**Files:**
- Modify: `backend/WatchParty.Api/Lobbies/PlaybackState.cs`, `Lobbies/LobbyHub.cs`, `Lobbies/MediaValidator.cs`, `Security/HubRateLimitFilter.cs` (`PlaybackMethods`'a `"SetSubtitle"`)
- Test: mevcut hub/validator test dosyalarının yanında (`backend/WatchParty.Api.Tests/`; mevcut adlandırma ve `WatchPartyFactory` kalıbı)

**Interfaces:**
- Produces: hub metodu `SetSubtitle(string? url)`; `PlaybackUpdated` yükünde `subtitleUrl`.

- [ ] **Step 1: Başarısız testleri yaz** — spec "Doğrulama" xUnit maddeleri, adlar: `SetSubtitle_sets_url_and_broadcasts`, `SetSubtitle_null_or_empty_removes`, `SetSubtitle_rejects_invalid_url` (http, 201 karakter, baş/son boşluk → ilgili Türkçe metin), `SetSubtitle_requires_media`, `SetSubtitle_rejects_youtube`, `SetSubtitle_host_only_rejects_non_host`, `SetMedia_clears_subtitle`, `SetSubtitle_does_not_touch_position_or_timestamp` (oynarken çağrılır; `PositionSec`, `IsPlaying`, `UpdatedAt` önceki yayınla aynı).
- [ ] **Step 2:** `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~Subtitle"` → FAIL.
- [ ] **Step 3: Uygula** — spec 1. bölüm. `SetSubtitle` `Update(...)`'i kullanmaz; `lock (lobby.Gate)` içinde aynı kural sırası (lobi → host-only → medya var → medya `file`) ve yalnızca `lobby.Playback = lobby.Playback with { SubtitleUrl = ... }`; boş string `null`'a çevrilir. `SetMedia`'nın `with`'ine `SubtitleUrl = null`.
- [ ] **Step 4:** `dotnet test backend/WatchParty.slnx` → tümü geçer.
- [ ] **Step 5: Commit** — `Altyazı: PlaybackState.SubtitleUrl ve SetSubtitle hub metodu`.

### Task 2: Frontend — altyazı çözme ve ayrıştırma (`lib/subtitles.ts`)

**Files:**
- Create: `frontend/src/lib/subtitles.ts`, `frontend/src/lib/subtitles.test.ts`

**Interfaces:**
- Produces: `decodeSubtitle`, `parseSubtitles`, `Cue` (Global Constraints'teki imzalar).

- [ ] **Step 1: Başarısız testleri yaz** — `decodeSubtitle`: UTF-8 "ğüşıöçĞÜŞİÖÇ", BOM'lu UTF-8 (BOM atılır), Windows-1254 baytları (`0xF0 0xFC 0xFE 0xFD 0xF6 0xE7` → "ğüşıöç"). `parseSubtitles`: SRT iki blok (`00:00:01,000 --> 00:00:02,500` → `{start:1, end:2.5}`), çok satırlı metin `\n` ile korunur; VTT (`WEBVTT` başlığı, `NOTE` bloğu atlanır, `00:01.000 --> 00:02.000 align:start` ayarları yok sayılır); CRLF ve yalnız-CR; saat kısmı olmayan zaman; bozuk zaman satırlı blok atlanır, diğerleri kalır; `{\an8}` silinir, `<i>` kalır; boş metin → `[]`; `end <= start` olan blok atlanır.
- [ ] **Step 2:** `cd frontend; npx vitest run src/lib/subtitles.test.ts` → FAIL.
- [ ] **Step 3: Uygula** — `TextDecoder("utf-8", { fatal: true })`, hata → `TextDecoder("windows-1254")`; ayrıştırıcı boş satırla bloklara böler, `-->` içeren satırı zaman satırı sayar.
- [ ] **Step 4:** `npm test` → geçer; `npm run build` → geçer.
- [ ] **Step 5: Commit** — `Altyazı: SRT/VTT ayrıştırma ve kodlama tespiti`.

### Task 3: Frontend — bağlantı, oynatıcı, seçici, CC düğmesi

Depends on: Task 2 (merge edilmiş halde başlar).

**Files:**
- Modify: `frontend/src/lib/types.ts`, `lib/connection.ts`, `lib/mock.ts`, `lib/identity.ts`, `players/FilePlayer.tsx`, `components/PlayerArea.tsx`, `components/MediaPicker.tsx`, `components/Controls.tsx`, `components/Icon.tsx`, `pages/LobbyPage.tsx`, `styles.css`

**Interfaces:**
- Consumes: Task 2 `decodeSubtitle`, `parseSubtitles`, `Cue`; Task 1 hub `SetSubtitle` (ad ve kurallar Global Constraints'te).

- [ ] **Step 1: Mock ve bağlantı** — `setSubtitle` gerçek (`"SetSubtitle"`) ve mock; mock Task 1'in kural sırasını ve Türkçe metinleri birebir uygular, `setMedia` mock'ta `subtitleUrl`'i sıfırlar. `types.ts`'e alan.
- [ ] **Step 2: Oynatıcı** — `FilePlayer` `subtitleUrl` ve `subtitlesOn` prop'ları. `subtitleUrl` değişince: önceki iz `mode = "disabled"` ve tüm cue'ları silinir; `new URL(url).origin !== location.origin` ise istek atmadan Türkçe hata; değilse `fetch` (`AbortController` ile, URL değişince/unmount'ta iptal) → `decodeSubtitle` → `parseSubtitles` → boşsa hata; doluysa tek bir `addTextTrack("subtitles", "Altyazı", "tr")` izi yeniden kullanılır, `VTTCue`'lar eklenir. `subtitlesOn` → `mode = "showing" | "hidden"`. `url` (video) değişince iz temizlenir.
- [ ] **Step 3: Seçici ve kontroller** — `MediaPicker` ikinci alan (placeholder `"Altyazı linki (.vtt / .srt, isteğe bağlı)"`), spec 2. bölümdeki gönderim sırası; altyazı varken `"Altyazıyı kaldır"` düğmesi (`setSubtitle(null)`). `Controls`: `mediaType === "file" && subtitleUrl` iken `cc` düğmesi (`aria-pressed`, title `"Altyazı"`); durum `getSubtitlesOn/saveSubtitlesOn`. `Icon`'a `cc`.
- [ ] **Step 4: Stil** — `::cue` (uygulama fontu, token'lı zemin/yazı rengi), `.theater.is-fullscreen` altında büyük boyut.
- [ ] **Step 5: Doğrula** — `npm test`, `npm run build` geçer; `npm run dev:mock` ile iki sekmede: `frontend/public/` altına geçici bir `test.srt` (Windows-1254 Türkçe) koyup bir MP4 lobisinde altyazı ekle → iki sekmede görünür, CC aç/kapa kişisel, video değişince kaybolur, başka alan linki hata verir. Geçici dosyayı commit'leme. (Tarayıcı otomasyonu yoksa bu adımı rapora "yapılmadı" diye yaz.)
- [ ] **Step 6: Commit** — `Altyazı: seçici, oynatıcı ve CC düğmesi`.

### Task 4: e2e ve belgeler

Depends on: Task 1.

**Files:**
- Modify: `backend/e2e/e2e.mjs`, `frontend/README.md`, `CLAUDE.md`

- [ ] **Step 1: e2e** — mevcut kalıpla iki kontrol: (a) host `SetMedia("file", "https://example.com/a.mp4")` + `SetSubtitle("https://example.com/a.srt")` → ikinci istemcinin `PlaybackUpdated`'inde `subtitleUrl` eşit; sonradan katılan üçüncü istemcinin `JoinLobby` sonrası aldığı durumda da var. (b) YouTube medyada `SetSubtitle` → hata metni `"yalnızca MP4"` içerir.
- [ ] **Step 2:** Development modunda backend'i başlat (`cd backend\WatchParty.Api; dotnet run --launch-profile http`), `cd backend\e2e; npm test` → tüm PASS; backend'i kapat.
- [ ] **Step 3: Belgeler** — spec 3. bölüm.
- [ ] **Step 4: Commit** — `Altyazı: e2e kontrolleri ve belgeler`.

---

## Yürütme

Task 1 ∥ Task 2 (ayrık dosyalar). Task 2 bitince Task 3; Task 1 bitince Task 4 (Task 3 ∥ Task 4). Hepsi `subtitles` dalında birleşir; tam test seti (`dotnet test`, `npm test`, `npm run build`, e2e) birleşik halde koşar. Deploy (backend + frontend) kullanıcı onayıyla ve **kimse izlemiyorken** (backend deploy'u lobileri düşürür).
