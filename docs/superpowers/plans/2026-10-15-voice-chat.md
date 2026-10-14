# Sesli Sohbet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lobidekiler isterse sesli sohbete katılıp (en fazla 6 kişi, WebRTC mesh) konuşarak izleyebilsin.

**Architecture:** Sunucu yalnızca üyelik ve sinyal iletimi yapar (`JoinVoice`/`LeaveVoice`/`SetVoiceMuted`/`VoiceSignal`, `VoiceMembersChanged`); ICE sunucuları `Voice:IceServers` ayarından gelir. İstemcide `VoiceSession` eş başına `RTCPeerConnection` yönetir (perfect negotiation), `SpeakingDetector` konuşmayı yerelde hesaplar; arayüz ses şeridi, kişiler listesindeki mikrofon simgeleri ve kişi başı ses düzeyi.

**Tech Stack:** .NET 10 / SignalR / xUnit, React 19 + TypeScript / Vitest, WebRTC, Web Audio, Node e2e.

**Spec:** `docs/superpowers/specs/2026-10-15-voice-chat.md`

## Global Constraints

- Türkçe yorum/UI/hata/commit; commit sonu `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; CLAUDE.md İngilizce.
- Adlar (birebir): hub `JoinVoice()` → `VoiceJoinResult(VoiceMemberView[] Members, IceServerView[] IceServers)`, `LeaveVoice()`, `SetVoiceMuted(bool muted)`, `VoiceSignal(string toId, string kind, string payload)`; olaylar `VoiceMembersChanged(VoiceMemberView[])`, `VoiceSignal(string fromId, string kind, string payload)`; `VoiceMemberView(string Id, string Nickname, bool Muted)`, `IceServerView(string[] Urls, string? Username, string? Credential)`; `VoiceOptions` (`Voice` bölümü, `IceServers`); `Lobby` metotları `TryJoinVoice`, `LeaveVoice`, `SetVoiceMuted`, `VoiceMembers`; `Lobby.MaxVoiceMembers = 6`; `SecurityOptions.VoiceBurst = 60`, `VoicePerSecond = 30`.
- TS: `VoiceMember { id: string; nickname: string; muted: boolean }`, `IceServer { urls: string[]; username?: string; credential?: string }`, `MAX_VOICE = 6`; `LobbyConnection.joinVoice(): Promise<{ members: VoiceMember[]; iceServers: IceServer[] }>`, `leaveVoice(): Promise<void>`, `setVoiceMuted(muted: boolean): Promise<void>`, `voiceSignal(toId: string, kind: VoiceSignalKind, payload: string): Promise<void>`, olaylar `voiceMembersChanged(members: VoiceMember[])`, `voiceSignal(fromId: string, kind: VoiceSignalKind, payload: string)`; `type VoiceSignalKind = "offer" | "answer" | "candidate"`.
- `lib/voice.ts`: `export class VoiceSession` — kurucu `(deps: VoiceDeps, callbacks: VoiceCallbacks)`; `VoiceDeps = { createPeer(config: RTCConfiguration): RTCPeerConnection }` (testte sahte); `VoiceCallbacks = { sendSignal(toId, kind, payload): void; onRemoteStream(id: string, stream: MediaStream): void; onPeerState(id: string, state: "connecting" | "connected" | "failed"): void; onPeerClosed(id: string): void }`; metotlar `start(localStream: MediaStream, iceServers: IceServer[], selfId: string): void`, `setMembers(members: VoiceMember[]): void`, `handleSignal(fromId, kind, payload): Promise<void>`, `setMuted(muted: boolean): void`, `stop(): void`.
- `lib/speaking.ts`: `export function isSpeaking(state: { lastLoudAt: number }, level: number, now: number, opts?: { threshold?: number; holdMs?: number }): boolean` (varsayılan eşik 0.04 RMS, tutma 300 ms; `level >= threshold` ise `lastLoudAt = now`), `export class SpeakingDetector` (`watch(id: string, stream: MediaStream)`, `unwatch(id)`, `onChange(cb: (id: string, speaking: boolean) => void)`, `stop()`; 100 ms örnekleme, tek `AudioContext`).
- Metinler: `"Sesli sohbet dolu"`, `"Geçersiz ses sinyali"`, `"Ses sinyali çok büyük"`, `"Önce bir lobiye katıl"`, `"Mikrofon izni verilmedi"`, `"Mikrofon bulunamadı"`, `"Bağlanamadı"`, `"Bağlantı koptu; sesli sohbetten çıkıldı"`, düğmeler `"Sesli sohbete katıl"`, `"Ayrıl"`, not `"Hoparlörden izliyorsan kulaklık önerilir."`.
- Payload sınırı 16 384 karakter; `kind` yalnızca `offer|answer|candidate`.
- Ses verisi sunucudan geçmez; oynatıcı olayları kuralı değişmez; yeni renkler token (iki tema).

## Review Focus

- **Glare (iki taraf aynı anda offer):** perfect negotiation doğru polite/impolite seçimi. → Task 2 testi.
- **Üye olmayan / başka lobideki hedefe sinyal:** sessizce düşmeli. → Task 1 testi.
- **Kopma:** sunucu üyeliği düşürür ve yayınlar; istemci otomatik katılmaz, mikrofonu kapatır. → Task 1 + Task 3.
- **Mikrofon izni reddi / cihaz yok:** Türkçe hata, şerit katılmamış duruma döner. → Task 3.
- **Kaynak sızıntısı:** ayrılınca tüm `RTCPeerConnection`, mikrofon izi, `AudioContext` ve `<audio>` öğeleri kapanır. → Task 2/3.

---

### Task 1: Sunucu

**Files:** Modify `Lobbies/Lobby.cs`, `Lobbies/LobbyHub.cs`, `Lobbies/LobbyContracts.cs`, `Program.cs` (VoiceOptions bağlama + doğrulama), `Security/SecurityOptions.cs`, `Security/HubRateLimitFilter.cs` (`voice` kovası), `appsettings.json` (varsayılan `Voice:IceServers`); Create `Lobbies/VoiceOptions.cs`; Test: `backend/WatchParty.Api.Tests/HubVoiceTests.cs` (+ `Lobby` birim testleri mevcut kalıpla).

- [ ] **Step 1: Başarısız testler** — spec "Doğrulama" xUnit maddelerinin her biri.
- [ ] **Step 2:** `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~Voice"` → FAIL.
- [ ] **Step 3: Uygula** — spec 1. bölüm. Üyelik `Gate` altında `Lobby` metotlarında; `OnDisconnectedAsync`'te `Leave` sonrası sesli üyelikten çıkarma ve değiştiyse `VoiceMembersChanged`. `VoiceSignal` iletimi `Clients.Client(toId)`; gönderen ve alıcı aynı lobinin sesli üyesi değilse sessiz.
- [ ] **Step 4:** `dotnet test backend/WatchParty.slnx` → tümü geçer.
- [ ] **Step 5: Commit** — `Sesli sohbet: sunucu (üyelik, sinyal iletimi, ICE ayarı)`.

### Task 2: İstemci çekirdeği — `VoiceSession` ve konuşma algılama

**Files:** Create `frontend/src/lib/voice.ts`, `lib/voice.test.ts`, `lib/speaking.ts`, `lib/speaking.test.ts`; Modify `lib/types.ts` (yalnızca `VoiceMember`, `IceServer`, `VoiceSignalKind`, `MAX_VOICE`).

- [ ] **Step 1: Başarısız testler** — sahte `RTCPeerConnection` (olay tetiklenebilir, `createOffer/Answer`, `setLocal/RemoteDescription`, `addIceCandidate`, `restartIce`, `close` kaydı): yeni üye → bağlantı açılır ve `addTrack` yapılır; listeden çıkan → `close` + `onPeerClosed`; `selfId < peerId` polite; impolite taraf gelen çakışan offer'ı yok sayar, polite taraf rollback ile kabul eder; `onnegotiationneeded` → offer `sendSignal`; candidate iletimi; `connectionState` `failed` → bir kez `restartIce`, ikinci kez `onPeerState("failed")`; `setMuted` izleri `enabled=false`; `stop` hepsini kapatır. `isSpeaking`: eşik altı/üstü, 300 ms tutma.
- [ ] **Step 2:** `npx vitest run src/lib/voice.test.ts src/lib/speaking.test.ts` → FAIL.
- [ ] **Step 3: Uygula** — spec 2. bölüm; payload JSON (`RTCSessionDescriptionInit` / `RTCIceCandidateInit`).
- [ ] **Step 4:** `npm test`, `npm run build` → geçer.
- [ ] **Step 5: Commit** — `Sesli sohbet: VoiceSession (perfect negotiation) ve konuşma algılama`.

### Task 3: Bağlantı, mock ve arayüz

Depends on: Task 2 (merge edilmiş halde) ve Task 1'in adları.

**Files:** Modify `lib/connection.ts`, `lib/mock.ts`, `pages/LobbyPage.tsx`, `components/Participants.tsx`, `components/Controls.tsx`, `components/Icon.tsx`, `styles.css`; Create `components/VoiceBar.tsx` (+ gerekiyorsa `lib/useVoice.ts`).

- [ ] **Step 1:** Bağlantı + mock (mock spec 1. bölüm kurallarını ve metinleri birebir uygular; sinyaller BroadcastChannel ile hedef sekmeye).
- [ ] **Step 2:** Arayüz — spec 2. bölüm (ses şeridi, kişiler listesinde simge/konuşma/“Bağlanamadı”/ses düzeyi, tam ekranda mikrofon düğmesi, mikrofon hataları, kopmada çıkış bildirimi, temizlik).
- [ ] **Step 3: Doğrula** — `npm test`, `npm run build`; `npm run dev:mock -- --port 5174 --strictPort` + `playwright-core` (repo dışında geçici kurulum, `chromium.launch({ channel: "chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] })`), aynı bağlamda iki sayfa: ikisi de katılır → iki tarafta `connected`, karşı `<audio>` öğesinde `srcObject` ve konuşma göstergesi; sessize alma ve ayrılma. Süreç ve geçici dosya bırakma.
- [ ] **Step 4: Commit** — `Sesli sohbet: bağlantı, mock ve arayüz`.

### Task 4: e2e ve belgeler

Depends on: Task 1.

**Files:** Modify `backend/e2e/e2e.mjs`, `CLAUDE.md`, `frontend/README.md`, `deploy/README.md`, `docs/BACKLOG.md`.

- [ ] **Step 1:** e2e — spec "Doğrulama" e2e maddesi (kendi lobisi; 7 bağlantılık dolu kontrolü).
- [ ] **Step 2:** Development backend + e2e → tüm PASS; backend kapatılır.
- [ ] **Step 3:** Belgeler — spec 3. bölüm.
- [ ] **Step 4: Commit** — `Sesli sohbet: e2e ve belgeler`.

---

## Yürütme

Task 1 ∥ Task 2; sonra Task 3 ∥ Task 4. `voice` dalında birleşir; tam test + gerçek backend'le iki tarayıcılı canlı deneme (sahte mikrofon). **Deploy yok** — kullanıcı ayrıca isteyene kadar dal `master`'a girmez.
