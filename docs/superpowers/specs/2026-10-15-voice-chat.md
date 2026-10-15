# Sesli sohbet (spec)

Kaynak: 2026-10-15 brainstorming'i. Aynı lobidekiler isterse yazılı sohbetin yanında sesli sohbete katılıp konuşarak izleyebilsin (Discord benzeri). Tipik kullanım 2–4 kişi, bilgisayardan. Ses tarayıcılar arasında doğrudan (WebRTC, herkes herkese — "mesh") gider; sunucu yalnızca tanıştırır (sinyal).

## Kararlar

| Konu | Karar |
|------|-------|
| Topoloji | Mesh (herkes herkese), en fazla **6** kişi sesli sohbette |
| Sinyal | Mevcut SignalR hub'ı; sunucu ses verisi görmez |
| ICE sunucuları | Backend'den gelir (`Voice:IceServers` ayarı); varsayılan yalnızca STUN `stun:stun.l.google.com:19302`. TURN yok; sonra yalnızca ayar + sunucu kurulumu ile eklenir, istemci değişmez |
| Bağlanamama | Sessiz başarısızlık yok: o kişinin yanında "Bağlanamadı" görünür |
| Konuşma göstergesi | Her istemci aldığı ses akışlarından ve kendi mikrofonundan yerelde hesaplar (sunucu trafiği yok) |
| Sessize alma | Yerel (`track.enabled = false`) + durum herkese yayınlanır (simge için) |
| Ses düzeyi | Kişi başı, yalnızca kendi ekranında; film sesinden ayrı |
| Yankı | `echoCancellation`, `noiseSuppression`, `autoGainControl` açık; katılma ekranında kulaklık notu; bas-konuş yok |
| Kapsam | Görüntü, ekran paylaşımı, 6+ kişi, TURN yok |

## Kapsam

### 1. Sunucu

**Durum.** `Lobby`'de sesli sohbet üyeleri: bağlantı kimliği → `{ Muted }` (yalnızca `Gate` altında, `Lobby` metotlarıyla: `TryJoinVoice(connectionId)`, `LeaveVoice(connectionId)`, `SetVoiceMuted(connectionId, bool)`, `VoiceMembers()` — salt okunur görünüm). Lobiden ayrılan/kopan kişi sesli sohbetten de çıkar (`Lobby.Leave` içinde ya da hemen ardından).

**Hub metotları:**
- `JoinVoice()` → `VoiceJoinResult(VoiceMemberView[] Members, IceServerView[] IceServers)`. Lobi yoksa `"Önce bir lobiye katıl"`; 6 dolu ise `"Sesli sohbet dolu"`; zaten üyeyse aynı sonucu döner (idempotent). Başarıda (tekrar katılmada da, bayat listeler düzelsin diye) tüm lobiye `VoiceMembersChanged(members)`.
- `LeaveVoice()` → üyelikten çıkar, `VoiceMembersChanged`. Üye değilse sessiz.
- `SetVoiceMuted(bool muted)` → üye değilse ya da değer değişmediyse sessiz; değiştiyse `VoiceMembersChanged`.
- `VoiceSignal(string toId, string kind, string payload)` → yalnızca **gönderen ve alıcı aynı lobide ve ikisi de sesli sohbet üyesiyse** alıcıya `VoiceSignal(fromId, kind, payload)` iletilir; değilse sessizce düşer (yarış durumları normal). `kind` ∈ `offer`, `answer`, `candidate`; başka değer → `"Geçersiz ses sinyali"`; `payload` en fazla **16 384** karakter → aşarsa `"Ses sinyali çok büyük"`.
- `VoiceMemberView(string Id, string Nickname, bool Muted)`; `IceServerView(string[] Urls, string? Username, string? Credential)` (TURN eklenirse kullanıcı adı/şifre buradan gelir).

**Ayar.** `Voice` bölümü (`VoiceOptions`, başlangıçta doğrulanır): `IceServers` dizisi (`Urls`, isteğe bağlı `Username`/`Credential`), varsayılan tek STUN. `MaxVoiceMembers` sabiti 6 (`Lobby`).

**Rate limit.** Yeni `voice` kovası (`HubRateLimitFilter`): `VoiceSignal`, `JoinVoice`, `LeaveVoice`, `SetVoiceMuted`. `SecurityOptions`: `VoiceBurst` = 60, `VoicePerSecond` = 30 (ICE adayları bağlantı başında topluca gelir). Development aynı varsayılanları kullanır.

### 2. İstemci

- `types.ts`: `VoiceMember { id; nickname; muted }`, `IceServer { urls: string[]; username?: string; credential?: string }`, `MAX_VOICE = 6`.
- `LobbyConnection`: `joinVoice(): Promise<{ members: VoiceMember[]; iceServers: IceServer[] }>`, `leaveVoice()`, `setVoiceMuted(muted)`, `voiceSignal(toId, kind, payload)`; olaylar `voiceMembersChanged(members)`, `voiceSignal(fromId, kind, payload)`. Mock: aynı kurallar ve metinler, sinyaller BroadcastChannel ile ilgili sekmeye iletilir (aynı tarayıcıdaki sekmeler arasında gerçek WebRTC çalışır).
- `lib/voice.ts` — `VoiceSession` (DOM/WebRTC bağımlılıkları kurucuya enjekte edilir ki birim testlenebilsin):
  - `start(localStream, iceServers, selfId)`, `stop()`, `setMembers(members)`, `handleSignal(fromId, kind, payload)`, `setMuted(bool)`, olay geri çağırmaları: `onRemoteStream(id, stream)`, `onPeerState(id, "connecting" | "connected" | "failed")`, `sendSignal(toId, kind, payload)`.
  - Eş başına bir `RTCPeerConnection`; "perfect negotiation" kalıbı: `selfId < peerId` olan taraf **polite**. Üye listesinde yeni görünen eş için bağlantı açılır; listeden çıkan eşin bağlantısı kapatılır.
  - `iceConnectionState`/`connectionState` `failed` → `onPeerState(id, "failed")` (bir kez `restartIce()` denenir).
- `lib/speaking.ts` — `SpeakingDetector`: `AnalyserNode` ile RMS; eşik ve 300 ms tutma süresiyle konuşuyor/konuşmuyor; 100 ms'de bir örnekleme. Saf karar fonksiyonu (`isSpeaking(levels, now)`) birim testli.
- Mikrofon: `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`. İzin reddedilirse Türkçe hata: `"Mikrofon izni verilmedi"`; cihaz yoksa `"Mikrofon bulunamadı"`.
- Uzak sesler: kişi başı gizli `<audio autoplay>` öğesi (`srcObject`), ses düzeyi kişi başı (0–100, `localStorage` yok, oturumluk).
- Arayüz:
  - Yan panelin üstünde **ses şeridi**: katılmadan önce "Sesli sohbete katıl" (+ "Hoparlörden izliyorsan kulaklık önerilir."); katıldıktan sonra mikrofon aç/kapat, "Ayrıl", katılımcı sayısı `n/6`. Dolu iken düğme devre dışı, title "Sesli sohbet dolu".
  - "Kişiler" listesinde sesli sohbetteki kişilerin yanında mikrofon simgesi: konuşurken vurgulu, sessizde üstü çizili, bağlanamadıysa uyarı simgesi ve title "Bağlanamadı"; kendi satırı dışındakilerde ses düzeyi kaydırıcısı.
  - Tam ekranda kontrol çubuğunda mikrofon aç/kapat düğmesi (yalnızca sesli sohbetteyken).
  - Yeni `Icon` adları: `mic`, `micOff`, `headphones`, `phoneOff` (ya da eşdeğerleri). Renkler token, iki tema.
- Lobiden çıkınca / sayfa kapanınca: `LeaveVoice` (mümkünse), tüm bağlantılar ve mikrofon izi kapatılır. Yeniden bağlanınca (SignalR reconnect) sesli sohbet üyeliği sunucuda düşmüş olur; istemci otomatik yeniden katılmaz, şerit "Sesli sohbete katıl" durumuna döner ve kısa bir bildirim gösterir: `"Bağlantı koptu; sesli sohbetten çıkıldı"`.

### 3. Belgeler

- `CLAUDE.md`: hub metotları, `Voice` ayarı, `voice` rate limit kovası, 6 sınırının üç yerde (backend, `types.ts`, `mock.ts`) eş tutulduğu; ses verisinin sunucudan geçmediği.
- `frontend/README.md`: sesli sohbet akışı, perfect negotiation, konuşma göstergesi, TURN'ün nasıl ekleneceği (yalnızca `Voice:IceServers`).
- `deploy/README.md`: `Voice__IceServers__0__Urls__0` gibi ortam değişkeniyle ayar; TURN eklemek ayrı bir iş (backlog).
- `docs/BACKLOG.md`: TURN (coturn ya da hizmet), bas-konuş, 6+ kişi için SFU.

## Doğrulama

- xUnit: `JoinVoice` sonuç ve yayın; 7. kişiye `"Sesli sohbet dolu"`; idempotent tekrar katılma; `LeaveVoice`/`SetVoiceMuted` yayınları; üye olmayana `VoiceSignal` iletilmez (sessiz); aynı lobide olmayan hedefe iletilmez; geçersiz `kind` ve 16 385 karakterlik payload hataları; kopan kişi üyelikten çıkar ve yayın yapılır; `IceServers` ayardan gelir.
- Vitest: `VoiceSession` sahte `RTCPeerConnection` ile — yeni üye için bağlantı açılır, çıkan üyenin kapanır, polite/impolite seçimi, offer çakışmasında impolite tarafın teklifi yok sayması, `failed` → `restartIce` bir kez → `onPeerState("failed")`; `isSpeaking` eşik/tutma.
- e2e: iki istemci `JoinVoice` → `VoiceMembersChanged` iki üye; A→B `VoiceSignal` iletilir, üye olmayan C'ye/C'den iletilmez; dolu kontrolü için 7 bağlantı (Development limitleri yeterli).
- Canlı (tarayıcı): iki ayrı tarayıcı bağlamı, Chrome `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` (sahte mikrofon tonu); A katılır, B katılır → her iki tarafta bağlantı `connected`, karşı tarafın `<audio>` öğesinde ses akışı var ve konuşma göstergesi yanıyor; A sessize alınca B'de gösterge söner ve simge üstü çizili olur; A ayrılınca B'de kalkar.

## Kapsam dışı

- Görüntülü sohbet, ekran paylaşımı, 6'dan fazla kişi (SFU), TURN sunucusu, bas-konuş, kayıt.
