# Sohbet Bildirimi ve "Yazıyor…" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Görünmeyen yeni mesajda kısa ses + sekme başlığında sayaç; sohbette "X yazıyor…".

**Architecture:** Sunucu yalnızca `Typing()` → `UserTyping(id, nickname)` iletir (durum yok). İstemcide saf karar fonksiyonları (`lib/notify.ts`, `lib/typing.ts`) ve `LobbyPage`/`Chat` bağlantısı; ses Web Audio ile üretilir.

**Tech Stack:** .NET 10 / SignalR / xUnit, React 19 + TypeScript / Vitest, Node e2e.

**Spec:** `docs/superpowers/specs/2026-10-13-chat-notify-typing.md` (bekleme işi `master`'a girdikten sonra başlanır)

## Global Constraints

- Türkçe yorum/UI/commit; commit sonu `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; CLAUDE.md İngilizce.
- Adlar: hub `Typing()`, olay `UserTyping(string id, string nickname)`; TS `LobbyConnection.typing(): Promise<void>`, olay `userTyping(id: string, nickname: string)`; `lib/notify.ts`: `shouldNotify`, `isChatVisible`, `titleWithCount`, `playBlip` (imzalar spec 2. bölümde); `lib/identity.ts`: `getChatSoundOn(): boolean`, `saveChatSoundOn(on: boolean): void` (`wp:chatSound`, varsayılan `true`); `lib/typing.ts`: `TypingTracker` (`add(id, nickname, now)`, `remove(id)`, `active(now): string[]`, `label(names: string[]): string | null`), `TypingThrottle` (`shouldSend(now): boolean`); `Icon` adları `bell`, `bellOff`.
- Sabitler: ses aralığı 2000 ms; gönderim aralığı 3000 ms; gösterim süresi 5000 ms.
- Metinler: "`<ad>` yazıyor…", "`<ad1>` ve `<ad2>` yazıyor…", "`<n>` kişi yazıyor…"; zil title "Bildirim sesi"; başlık biçimi `(<n>) <özgün başlık>`.
- `Typing` lobisizken hata fırlatmaz; `other` rate limit kovasında; istemci `typing()` hatasını yutar.
- Ses dosyası yok, CSP değişmez.

## Review Focus

- **Geçmiş mesajlarda ses çalmamalı** (`ChatHistory`). → Task 2 `shouldNotify` testi + Task 3 bağlantısı.
- **Kendi mesajında ses yok** (takma ad ölçütü). → Task 2.
- **Başlık sayacı sayfaya dönünce sıfırlanmalı ve özgün başlık korunmalı.** → Task 2 `titleWithCount` + Task 3 elle doğrulama.
- **"Yazıyor" kalıcı takılı kalmamalı** (5 sn, mesaj, ayrılma). → Task 2 `TypingTracker`.
- **Hızlı yazan sohbet kovasını tüketmemeli.** → Task 1 rate limit kovası.

---

### Task 1: Backend `Typing`

**Files:** Modify `Lobbies/LobbyHub.cs` (+ gerekiyorsa `Security/HubRateLimitFilter.cs` yalnızca doğrulama); Test: `backend/WatchParty.Api.Tests/HubTypingTests.cs`.

- [ ] **Step 1: Başarısız testler** — `Typing_forwards_to_others_with_server_nickname`, `Typing_not_sent_to_caller`, `Typing_without_lobby_does_not_throw`.
- [ ] **Step 2:** `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~Typing"` → FAIL.
- [ ] **Step 3: Uygula** — spec 1. bölüm.
- [ ] **Step 4:** `dotnet test backend/WatchParty.slnx` → geçer.
- [ ] **Step 5: Commit** — `Sohbet: Typing hub metodu`.

### Task 2: İstemci saf fonksiyonları

**Files:** Create `frontend/src/lib/notify.ts`, `lib/notify.test.ts`, `lib/typing.ts`, `lib/typing.test.ts`; Modify `lib/identity.ts` (`getChatSoundOn/saveChatSoundOn`).

- [ ] **Step 1: Başarısız testler** — spec "Doğrulama" Vitest maddeleri (`playBlip` hariç).
- [ ] **Step 2:** `npx vitest run src/lib/notify.test.ts src/lib/typing.test.ts` → FAIL.
- [ ] **Step 3: Uygula** — spec 2. bölüm; `playBlip`: tek `AudioContext`, `OscillatorNode` + `GainNode` ile ~120 ms yumuşak tık, tüm hatalar yutulur.
- [ ] **Step 4:** `npm test`, `npm run build` → geçer.
- [ ] **Step 5: Commit** — `Sohbet: bildirim ve "yazıyor" karar fonksiyonları`.

### Task 3: Bağlantı ve arayüz

Depends on: Task 2.

**Files:** Modify `lib/connection.ts`, `lib/mock.ts`, `pages/LobbyPage.tsx`, `components/Chat.tsx`, `components/Icon.tsx`, `styles.css`.

- [ ] **Step 1:** Bağlantı + mock (`typing()`, `userTyping`; mock diğer sekmelere iletir).
- [ ] **Step 2:** `LobbyPage` ve `Chat` — spec 2. bölüm (ses kararı, sayaç + `visibilitychange`/`focus`, tracker + 1 sn tazeleme, zil düğmesi, "yazıyor" satırı).
- [ ] **Step 3: Doğrula** — `npm test`, `npm run build`; `npm run dev:mock` + `playwright-core` (repo dışında, `channel: "chrome"`): iki sekme; arka plandaki sekmede başlık "(1) …" olur, öne gelince sıfırlanır; yazarken diğer sekmede "yazıyor…" görünür, 5 sn sonra/mesajla kalkar; ses çağrısı `AudioContext` üzerinde gözlenir (gerçek sesi doğrulamak mümkün değilse rapora yaz). Süreç bırakma.
- [ ] **Step 4: Commit** — `Sohbet: bildirim sesi, sekme sayacı ve "yazıyor" göstergesi`.

### Task 4: e2e ve belgeler

Depends on: Task 1.

**Files:** Modify `backend/e2e/e2e.mjs`, `CLAUDE.md`, `frontend/README.md`.

- [ ] **Step 1:** e2e — spec "Doğrulama" e2e maddesi.
- [ ] **Step 2:** Development backend + e2e → tüm PASS; backend kapatılır.
- [ ] **Step 3:** Belgeler — spec 3. bölüm.
- [ ] **Step 4: Commit** — `Sohbet: e2e kontrolü ve belgeler`.

---

## Yürütme

Task 1 ∥ Task 2; sonra Task 3 ∥ Task 4. `chat` dalında birleşir; tam test. Deploy kullanıcı onayıyla, kimse izlemiyorken.
