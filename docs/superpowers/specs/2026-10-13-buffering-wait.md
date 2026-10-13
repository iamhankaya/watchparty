# Takılana göre bekleme (spec)

Kaynak: 2026-10-13 brainstorming'i. Bir izleyicinin oynatıcısı oynaması gerekirken takılırsa (buffering) lobideki herkes otomatik olarak bekler; o yetişince herkes aynı yerden devam eder. Sürekli takılan biri grubu kilitleyemez. Altyazı işinin (`PlaybackState.SubtitleUrl`) üstüne kurulur; o dal `master`'a girdikten sonra başlanır.

## Kararlar

| Konu | Karar |
|------|-------|
| Davranış | Takılan varken oynatma sanal olarak durur (konum donar); takılan yetişince herkes donan konumdan devam eder |
| Algılama eşiği | Oynaması gerekirken **1 sn**'den uzun takılma |
| Tek seferlik bekleme sınırı | Aynı kişi için en fazla **10 sn**; dolunca o kişi listeden çıkar |
| Tekrar sınırı | Aynı kişi (clientId) **5 dakika** içinde **3** kez beklenmişse 4. ve sonraki bildirimleri o pencere boyunca yok sayılır; lobiye bir kez "`<ad>`'nin bağlantısı yavaş; beklenmeyecek" bildirilir |
| Kim bildirir | Her izleyicinin kendi istemcisi, otomatik; host-only modda da (kontrol eylemi değil) |
| Elle bitirme | Oynatmayı kontrol edebilen herkes (host-only'de yalnızca host) "Beklemeden devam et" diyebilir |
| Oynatıcı olayları kuralı | Yalnızca "takıldım / yetiştim" bildirimi gider; konum, seek, oynat/durdur olayları yine gönderilmez |
| Ayar | Yok; her zaman açık |

## Kapsam

### 1. Sunucu

**Durum.** `PlaybackState`'e `IReadOnlyList<string> WaitingFor` eklenir (bekleniyor olan katılımcıların bağlantı kimlikleri, yani istemcilerin gördüğü participant `id`; JSON `waitingFor`, boş liste varsayılan). Anlamı: `IsPlaying` doğruyken `WaitingFor` boş değilse konum **donmuştur**: beklenen konum `PositionSec`'tir (zaman ilerlemez).

**Bekleme kayıtları.** `Lobby`'de (yalnızca `Gate` altında değişen, dışarıya salt okunur):
- Aktif beklemeler: bağlantı kimliği → başlangıç zamanı.
- Tekrar sayacı: clientId → son 5 dakikadaki bekleme başlangıçları.
- Yok sayılanlar bildirildi mi: clientId → pencere sonu (tekrar bildirim yapılmasın).

**Hub metodu `ReportBuffering(bool buffering)`** (rate limit: playback kovası; hata fırlatmaz, uygun değilse sessizce yok sayar — otomatik bildirim kullanıcıya hata göstermemeli):
- Lobi yok / medya yok / `IsPlaying` yanlış → yok say.
- `buffering = true`, kişi zaten beklenmiyorsa:
  - Tekrar sayacında son 5 dakikada 3 başlangıç varsa yok say; bu pencere için ilk kezse `BufferingIgnored(nickname)` yayınla.
  - Değilse: liste boşken başlıyorsa önce konum dondurulur: `PositionSec = PositionSec + (now - UpdatedAt)/1000`, `UpdatedAt = now`. Kişi listeye ve sayaca eklenir.
- `buffering = false` ve kişi listedeyse çıkarılır; liste boşaldıysa devam: `PositionSec` aynı, `UpdatedAt = now`.
- Her değişiklikte `PlaybackUpdated` yayınlanır.

**Liste temizliği.**
- `Play`, `Pause`, `Seek`, `SetMedia` listeyi boşaltır (yeni komut beklemeyi bitirir; konumu komut belirler).
- Yeni hub metodu `SkipWaiting()`: kontrol kuralı `Update` ile aynı (host-only'de `"Sadece host kontrol edebilir"`); liste boşaltılıp devam edilir (`UpdatedAt = now`). Liste zaten boşsa yok say.
- Ayrılan/kopan katılımcı listeden çıkarılır (`OnDisconnectedAsync`); boşaldıysa devam.
- `LobbyTickService` her saniye: 10 sn'yi aşan beklemeleri listeden çıkarır; boşaldıysa devam; değişiklik varsa `PlaybackUpdated`.
- Bu işlemler `Lobby` üzerinde `Gate` alan metotlarla yapılır (ör. `StartWaiting`, `StopWaiting`, `ClearWaiting`, `ExpireWaits(now)`); saat parametre olarak verilir ki xUnit'te zaman sabitlenebilsin.

**Sınırlar** `Lobby` ya da ayrı bir sabitler sınıfında: `BufferingReportThreshold` (istemci tarafı, bkz. 2.), `MaxWait = 10 sn`, `StrikeWindow = 5 dk`, `MaxStrikes = 3`; `lib/mock.ts` aynı değerleri kullanır.

### 2. İstemci

- `Player`'a `isBuffering(): boolean`:
  - MP4: oynatılmak istenirken (`!video.paused`) `waiting` olayı geldi ve henüz `playing` gelmedi; ya da `readyState < HAVE_FUTURE_DATA`.
  - YouTube: `getPlayerState() === BUFFERING`.
- `types.ts`: `PlaybackState.waitingFor: string[]`; `expectedPosition`: `isPlaying && waitingFor.length > 0` ise `positionSec`.
- `SyncEngine` (`setSelfId(id)` ile kendi kimliğini bilir; yeni geri çağırma `onBuffering(buffering: boolean)`):
  - Oynaması gerekirken (`shouldPlay`) ve otomatik oynatma engeli yokken `isBuffering()` art arda **1 sn** sürerse bir kez `onBuffering(true)`.
  - Kendisi `waitingFor`'daysa: donmuş konuma göre sapma düzeltmesi (seek/hız) **yapılmaz**, yalnızca oynatmaya devam eder; `onBuffering(false)` yalnızca oynatıcı donmuş hedefe yetişince (oynatıcı konumu >= donmuş hedef − 0,3 sn) ve oynuyorken bir kez gönderilir. Devam eden istemci donmuş konumun biraz gerisindedir; MP4'te hız düzeltmesi farkı kapatır, YouTube'da ~0,3–0,5 sn fark kalabilir.
  - Başkaları bekleniyorsa: hedef konum donar (`expectedPosition`), oynatıcı mevcut mantıkla duraklar ve konumu tutar.
  - Medya/oynatıcı değişince ve bağlantı kopunca iç sayaçlar sıfırlanır; yeniden bağlanınca sunucu kişiyi zaten listeden çıkarmıştır.
- `LobbyConnection`: `reportBuffering(buffering)`, `skipWaiting()`, olay `bufferingIgnored(nickname)`. Mock aynı kuralları uygular.
- Arayüz: oynatıcının üstünde bekleme şeridi (lost-banner gibi): bir kişi → "`<ad>`'nin videosu yükleniyor…", birden fazla → "`<n>` kişi bekleniyor…"; kendi bağlantın bekleniyorsa "Videon yükleniyor, herkes seni bekliyor…". Kontrol edebilenlere "Beklemeden devam et" düğmesi. `bufferingIgnored` → toast "`<ad>`'nin bağlantısı yavaş; beklenmeyecek". Adlar katılımcı listesinden (`id` → `nickname`). Renkler token, iki tema.

### 3. Belgeler

- `CLAUDE.md` mimari bölümü: `WaitingFor` anlamı (konum donar), `ReportBuffering`/`SkipWaiting`, sınırlar ve "oynatıcı olayı gönderilmez" kuralının tek istisnası olarak buffering bildirimi.
- `frontend/README.md` senkron bölümü: algılama, kendi beklemesinde düzeltmenin kapalı olması.

## Doğrulama

- xUnit: dondurma konumu doğru hesaplanır; ikinci kişi eklenince konum yeniden hesaplanmaz; son kişi çıkınca `UpdatedAt` yenilenir, konum aynı; `Play/Pause/Seek/SetMedia/SkipWaiting` listeyi boşaltır; host-only'de host olmayan `SkipWaiting` reddedilir ama `ReportBuffering` kabul edilir; `IsPlaying` yanlışken ve medya yokken rapor yok sayılır; ayrılan kişi listeden çıkar; `ExpireWaits` 10 sn sonra çıkarır; 5 dk'da 3 bekleme sonrası 4. yok sayılır ve `BufferingIgnored` bir kez yayınlanır.
- Vitest: `expectedPosition` donma; `SyncEngine` sahte oynatıcı ve sahte saatle: 1 sn eşiği (0,9 sn'de bildirmez), bir kez bildirir, kendi beklemesinde seek yapmaz, yetişince `false` bildirir, engelli (autoplay) durumda bildirmez.
- e2e: iki istemci; biri `ReportBuffering(true)` → diğeri `waitingFor`'u görür ve konum donar; `false` → devam; `SkipWaiting` host-only'de host olmayana hata.
- Canlı: iki tarayıcıdan birinde DevTools ağ kısıtlamasıyla (Slow 3G) takılma; diğerinin beklediğini, şeridi ve devamı görmek; sürekli takılmada 3. seferden sonra beklenmediğini görmek.

## Kapsam dışı

- Lobi ayarı olarak açıp kapama, eşiklerin kullanıcıca değiştirilmesi, takılma istatistikleri, kalite düşürme.
