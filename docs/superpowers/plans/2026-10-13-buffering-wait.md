# Takılana Göre Bekleme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Biri takılınca lobi otomatik beklesin, o yetişince herkes donan konumdan devam etsin; sürekli takılan grubu kilitlemesin.

**Architecture:** `PlaybackState.WaitingFor` (bağlantı kimlikleri) doluyken beklenen konum donar. İstemci `SyncEngine` 1 sn'lik takılmayı `ReportBuffering(true/false)` ile bildirir; sunucu bekleme kayıtlarını `Lobby`'de `Gate` altında tutar, 10 sn ve "5 dk'da 3" sınırlarını uygular.

**Tech Stack:** .NET 10 / SignalR / xUnit, React 19 + TypeScript / Vitest, Node e2e.

**Spec:** `docs/superpowers/specs/2026-10-13-buffering-wait.md` (altyazı işi `master`'a girdikten sonra başlanır)

## Global Constraints

- Türkçe yorum/UI/commit; commit sonu `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; CLAUDE.md İngilizce.
- Adlar: C# `PlaybackState.WaitingFor` (`IReadOnlyList<string>`, boş varsayılan, JSON `waitingFor`), hub `ReportBuffering(bool buffering)`, `SkipWaiting()`, olay `BufferingIgnored(string nickname)`; `Lobby` metotları `StartWaiting(string connectionId, string clientId, DateTimeOffset now)`, `StopWaiting(string connectionId, DateTimeOffset now)`, `ClearWaiting(DateTimeOffset now)`, `ExpireWaits(DateTimeOffset now)` — hepsi `Gate` altında, dönüş değerleri yayın gerekip gerekmediğini ve (StartWaiting için) "yok sayıldı/ilk kez yok sayıldı" bilgisini verir (uygulayıcı tasarlar, Interfaces'te yazar). TS: `PlaybackState.waitingFor: string[]`, `Player.isBuffering(): boolean`, `SyncEngine.setSelfId(id: string | null)`, `SyncEngine` kurucusuna `onBuffering: (buffering: boolean) => void`, `LobbyConnection.reportBuffering(buffering: boolean)`, `skipWaiting()`, olay `bufferingIgnored(nickname: string)`.
- Sabitler: istemci eşiği 1000 ms; `MaxWait` 10 sn; `StrikeWindow` 5 dk; `MaxStrikes` 3 — backend ve `lib/mock.ts` aynı.
- Metinler: şerit "`<ad>`'nin videosu yükleniyor…", "`<n>` kişi bekleniyor…", "Videon yükleniyor, herkes seni bekliyor…"; düğme "Beklemeden devam et"; toast "`<ad>`'nin bağlantısı yavaş; beklenmeyecek"; `SkipWaiting` reddi "Sadece host kontrol edebilir".
- `ReportBuffering` hiçbir durumda HubException fırlatmaz (rate limit filtresininki hariç).
- Oynatıcı olaylarından yalnızca takılma bildirimi gider; seek/play/pause olayları gönderilmez.
- `Lobby` durumu yalnızca `Lobby` metotlarıyla ya da hub'da `lock (lobby.Gate)` altında değişir (CLAUDE.md).

## Review Focus

- **Ses/yeniden başlama döngüsü:** takılan kendi beklemesinde duraklatılmamalı ve seek edilmemeli. → Task 2 testi.
- **Dondurma matematiği:** ilk kişi eklenince konum bir kez hesaplanır; ikinci kişi eklenince yeniden hesaplanmaz. → Task 1 testi.
- **Kopan takılan** sonsuz bekletmemeli (disconnect + 10 sn). → Task 1 testleri.
- **Durdurulmuşken / medya yokken** gelen bildirim hata göstermemeli. → Task 1.
- **Otomatik oynatma engeli** takılma sayılmamalı. → Task 2 testi.

---

### Task 1: Backend

**Files:** Modify `Lobbies/PlaybackState.cs`, `Lobbies/Lobby.cs`, `Lobbies/LobbyHub.cs`, `Lobbies/LobbyTickService.cs`, `Security/HubRateLimitFilter.cs` (`ReportBuffering`, `SkipWaiting` → playback kovası); Test: `backend/WatchParty.Api.Tests/` (yeni `HubBufferingTests.cs` + `Lobby` birim testleri mevcut kalıpla).

**Interfaces:** Produces hub `ReportBuffering`, `SkipWaiting`, olay `BufferingIgnored`, `waitingFor` alanı.

- [ ] **Step 1: Başarısız testler** — spec "Doğrulama" xUnit maddelerinin her biri ayrı test (`Lobby` saat parametreli metotlar için birim testi; hub davranışları için `WatchPartyFactory`).
- [ ] **Step 2:** `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~Buffering|FullyQualifiedName~Waiting"` → FAIL.
- [ ] **Step 3: Uygula** — spec 1. bölüm. `Play/Pause/Seek/SetMedia` mevcut `Update` içinde `WaitingFor` boşaltılır (ve `Lobby` aktif bekleme kayıtları temizlenir). Disconnect: `lobby.Leave` sonrası `StopWaiting`; değiştiyse `PlaybackUpdated`. Tick: her saniye `ExpireWaits(UtcNow)`; değiştiyse yayın.
- [ ] **Step 4:** `dotnet test backend/WatchParty.slnx` → tümü geçer.
- [ ] **Step 5: Commit** — `Bekleme: sunucu tarafı (WaitingFor, ReportBuffering, SkipWaiting)`.

### Task 2: İstemci çekirdeği — algılama ve senkron

**Files:** Modify `frontend/src/players/Player.ts`, `players/FilePlayer.tsx`, `players/YouTubePlayer.tsx`, `lib/types.ts` (`waitingFor`, `expectedPosition`), `lib/sync.ts`; Create `frontend/src/lib/sync.test.ts`.

**Interfaces:** Produces `Player.isBuffering`, `SyncEngine.setSelfId`, `onBuffering` geri çağırması.

- [ ] **Step 1: Başarısız testler** (`vi.useFakeTimers`, sahte `Player` ve sahte `ServerClock`): `expectedPosition` beklemede donar; 900 ms takılma bildirmez, 1000 ms+ bir kez `onBuffering(true)`; engelli (autoplay) iken bildirmez; kendi beklemesinde (`waitingFor` içinde self) donmuş hedeften 3 sn uzak olsa da `seek` çağrılmaz ve `pause` çağrılmaz; yetişince bir kez `onBuffering(false)`; başkası beklenirken `pause` çağrılır ve hedef donar; oynatıcı değişince sayaç sıfırlanır.
- [ ] **Step 2:** `npx vitest run src/lib/sync.test.ts` → FAIL.
- [ ] **Step 3: Uygula** — spec 2. bölüm. `FilePlayer`: `waiting` → bayrak true, `playing`/`pause`/`seeked`/`emptied` → false; `isBuffering = !paused && (bayrak || readyState < HAVE_FUTURE_DATA)`. `YouTubePlayer`: `getPlayerState() === YT.PlayerState.BUFFERING`.
- [ ] **Step 4:** `npm test`, `npm run build` → geçer.
- [ ] **Step 5: Commit** — `Bekleme: takılma algılama ve senkron motoru`.

### Task 3: İstemci bağlantısı ve arayüz

Depends on: Task 2 (ve Task 1'in kural metinleri; adlar Global Constraints'te).

**Files:** Modify `lib/connection.ts`, `lib/mock.ts`, `pages/LobbyPage.tsx`, `styles.css` (+ gerekiyorsa küçük bir `components/WaitingBanner.tsx`).

- [ ] **Step 1:** Bağlantı + mock (mock spec 1. bölüm kurallarını, sabitleri ve metinleri birebir uygular; mock'ta zaman `Date.now()`).
- [ ] **Step 2:** `LobbyPage`: `SyncEngine`'e `setSelfId(selfId)`, `onBuffering → conn.reportBuffering(b)` (hata yutulur); şerit (adlar `participants`'tan), "Beklemeden devam et" (`canControl` iken) → `skipWaiting()`, `bufferingIgnored` → toast. Renkler token.
- [ ] **Step 3: Doğrula** — `npm test`, `npm run build`; `npm run dev:mock` + `playwright-core` (repo dışında geçici kurulum, kurulu Chrome `channel: "chrome"`) ile iki sekme: bir sekmede sahte takılma (DevTools Network throttling `Slow 3G`, CDP `Network.emulateNetworkConditions`) ya da doğrudan `reportBuffering(true)`; diğerinde şerit ve donma, devam; "Beklemeden devam et". Geçici dosya ve süreç bırakma.
- [ ] **Step 4: Commit** — `Bekleme: bağlantı, mock ve bekleme şeridi`.

### Task 4: e2e ve belgeler

Depends on: Task 1.

**Files:** Modify `backend/e2e/e2e.mjs`, `CLAUDE.md`, `frontend/README.md`.

- [ ] **Step 1:** e2e — spec "Doğrulama" e2e maddesi (kendi lobisi; sınırlı bekleme süreleriyle).
- [ ] **Step 2:** Development backend + `npm test` (e2e) → tüm PASS; backend kapatılır, port 5205 boş.
- [ ] **Step 3:** Belgeler — spec 3. bölüm.
- [ ] **Step 4: Commit** — `Bekleme: e2e kontrolleri ve belgeler`.

---

## Yürütme

Task 1 ∥ Task 2; sonra Task 3 (Task 2 + Task 1 birleşik) ∥ Task 4 (Task 1 üstünde). `buffering` dalında birleşir; tam test (`dotnet test`, `npm test`, `npm run build`, e2e). Deploy kullanıcı onayıyla, kimse izlemiyorken.
