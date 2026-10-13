# Sohbet bildirimi ve "yazıyor…" (spec)

Kaynak: 2026-10-13 brainstorming'i. Mesajı göremiyorken gelen mesaj için kısa bir ses ve sekme başlığında okunmamış sayacı; sohbette "X yazıyor…" göstergesi. Altyazı ve takılana göre bekleme işlerinden sonra yapılır (aynı `connection.ts` / `mock.ts` / `LobbyPage.tsx` dosyalarına dokunur).

## Kararlar

| Konu | Karar |
|------|-------|
| Ses ne zaman | Başkasının **yeni** mesajı gelince ve mesaj görünmüyorken: `document.hidden` **veya** `!document.hasFocus()` **veya** tam ekranda sohbet kapalı |
| Ses ne zaman çalmaz | Kendi mesajın, `ChatHistory` (katılırken gelen geçmiş), sohbet görünürken |
| Ses | Web Audio API ile üretilen kısa, yumuşak bir "tık" (~120 ms); ses dosyası ve CSP değişikliği yok |
| Sıklık | 2 sn içinde en fazla bir ses |
| Kapatma | Sohbet başlığında zil düğmesi; kişisel, `localStorage` `wp:chatSound`, varsayılan açık |
| Sekme sayacı | Sayfa gizliyken ya da odakta değilken gelen başkalarının mesajları sayılır; başlık `(<n>) <özgün başlık>`; sayfa görünür ve odakta olunca sıfırlanır (ses kapalıyken de çalışır) |
| "Yazıyor" gönderimi | Sohbet kutusunda metin değişince, en fazla **3 sn**'de bir `Typing()`; boş kutuda gönderilmez |
| "Yazıyor" sunucu | Durum tutmaz; çağıranın bağlantı kimliği ve takma adıyla `UserTyping(id, nickname)` lobideki **diğerlerine** iletilir |
| "Yazıyor" rate limit | `other` kovası (sohbet kovası tükenmesin) |
| Gösterim süresi | Son bildirimden **5 sn** sonra; o kişiden mesaj gelince ya da katılımcı listesinden çıkınca hemen kalkar |
| Metin | 1 kişi "`<ad>` yazıyor…", 2 kişi "`<ad1>` ve `<ad2>` yazıyor…", 3+ "`<n>` kişi yazıyor…" |

## Kapsam

### 1. Sunucu

- Hub metodu `Typing()`: lobi yoksa yok sayılır (hata fırlatmaz); varsa `Clients.OthersInGroup(lobby.Code).SendAsync("UserTyping", Context.ConnectionId, nickname)`. Takma ad lobideki katılımcı kaydından alınır (istemciden gelmez).
- `HubRateLimitFilter`: `Typing` `other` kovasında (varsayılan dal; yalnızca doğrulanır). Rate limit aşımında mevcut davranış (HubException) korunur; istemci bu hatayı yutar.

### 2. İstemci

- `LobbyConnection`: `typing(): Promise<void>` (hub `"Typing"`), olay `userTyping(id: string, nickname: string)`. Mock: diğer sekmelere iletir, kendi sekmesine iletmez.
- `lib/notify.ts` (saf karar fonksiyonları + küçük yan etkili yardımcılar, birim testli):
  - `shouldNotify(opts: { fromSelf: boolean; history: boolean; visible: boolean; soundOn: boolean; lastSoundAt: number; now: number }): boolean` — 2 sn kuralı dahil.
  - `isChatVisible(opts: { hidden: boolean; focused: boolean; fullscreen: boolean; chatOpen: boolean }): boolean`.
  - `titleWithCount(base: string, count: number): string` — `count` 0 ise `base`.
  - `playBlip(): void` — tek bir `AudioContext` tembel oluşturulur, `resume()` hatası yutulur (tarayıcı izin vermezse sessiz kalır).
  - `getChatSoundOn()/saveChatSoundOn(on)` (`wp:chatSound`, try/catch) — `lib/identity.ts`'teki `getVolume` kalıbıyla aynı dosyada.
- `lib/typing.ts`: `TypingTracker` — `add(id, nickname, now)`, `remove(id)`, `active(now): string[]` (5 sn kuralı), `label(names): string | null` (Kararlar'daki metinler); gönderim tarafı için `TypingThrottle` — `shouldSend(now): boolean` (3 sn).
- `LobbyPage`: `chatMessage` geldiğinde: kendi mesajı mı (`nickname === me.nickname`; mevcut `Chat` ile aynı ölçüt), görünürlük, ses ayarı → `playBlip`; görünmüyorsa sayaç artar. `visibilitychange`/`focus` ile sayaç sıfırlanır ve başlık güncellenir. `userTyping` → tracker; o kişiden mesaj gelince ya da `participantsChanged`'te yoksa kaldırılır; 1 sn'lik bir zamanlayıcı ifadeyi tazeler.
- `Chat`: metin değişince `TypingThrottle` izin verirse `onTyping()` (hata yutulur); listenin altında "yazıyor" satırı (yer kaplamayacak şekilde sabit yükseklik, `aria-live="polite"`); başlıkta zil düğmesi (`aria-pressed`, title "Bildirim sesi"; yeni `Icon` adları `bell`, `bellOff`).
- Stil: yeni renkler token, iki tema.

### 3. Belgeler

- `CLAUDE.md`: hub metot listesine `Typing`/`UserTyping`; `frontend/README.md`: bildirim kuralları ve "yazıyor" zamanlamaları.

## Doğrulama

- xUnit: `Typing` diğerlerine `UserTyping(id, nickname)` iletir, çağırana iletmez; lobisizken hata fırlatmaz.
- Vitest: `shouldNotify` (kendi/geçmiş/görünür/ses kapalı/2 sn), `isChatVisible` (gizli, odak yok, tam ekran sohbet kapalı/açık), `titleWithCount`, `TypingTracker` (5 sn, kaldırma, etiket metinleri 1/2/3+), `TypingThrottle` (3 sn).
- e2e: iki istemci; biri `Typing` çağırır → diğeri `UserTyping`'i doğru ad ile alır, çağıran almaz.
- Canlı/elle: iki sekme; biri arka plandayken diğerinden mesaj → ses ve başlıkta "(1)"; sekmeye dönünce sıfırlanır; zil kapalıyken ses yok ama sayaç var; tam ekranda sohbet kapalıyken ses; yazarken diğer sekmede "yazıyor…" görünür ve 5 sn sonra / mesajla kalkar.

## Kapsam dışı

- Masaüstü (OS) bildirimleri, ses seçimi/ses düzeyi, okundu bilgisi, "Kişiler" sekmesindeyken ses (sohbet panelde gizli ama sayfa odakta).
