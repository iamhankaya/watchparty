# Ertelenen Bulgular Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-hardening review'larından ertelenen bulguları kapatmak: bağlantı kopmasında kullanıcıya sebep gösterme, zamanlayıcısız token bucket, limit ayarlarının açılışta doğrulanması, lobi kapsüllemesi, medya id sıkılaştırması ve doküman düzeltmeleri.

**Architecture:** Backend'de `Security/` altına zamanı `TimeProvider`'dan okuyan küçük bir `TokenBucket` sınıfı gelir ve `HubRateLimitFilter` onu kullanır; `SecurityOptions` DataAnnotations + `ValidateOnStart` ile doğrulanır. `Lobby` yapıcı (constructor) ile kurulur, durum alanları sadece içeriden yazılır. Frontend'de bağlantı hatalarını Türkçe mesaja çeviren saf bir fonksiyon `vitest` ile test edilir; `LobbyConnection` kalıcı kopmayı yeni bir `connectionLost(reason)` olayıyla bildirir, `LobbyPage` sebebi ve bir "Yeniden bağlan" düğmesini gösterir.

**Tech Stack:** .NET 10, ASP.NET Core, SignalR, xUnit, `Microsoft.Extensions.TimeProvider.Testing` (sadece test projesi); React 19 + TypeScript + Vite, `vitest` (sadece frontend devDependency).

**Spec:** `docs/superpowers/specs/2026-10-12-deferred-findings.md`

## Global Constraints

- Kod yorumları, `HubException` mesajları ve commit mesajları Türkçe. Mevcut `HubException` mesajları birebir korunur (e2e alt dizelerini kontrol ediyor).
- Yeni paketler sadece: test projesine `Microsoft.Extensions.TimeProvider.Testing` (10.0.x; yoksa en güncel 9.x), frontend'e devDependency `vitest`. API projesine paket eklenmez.
- Build 0 uyarı. `dotnet test backend/WatchParty.slnx` her task sonunda tamamen geçer.
- Commit mesajları `Co-Authored-By:` satırıyla biter (commit'i yazan modelin adıyla).
- Paralel çalıştırma: Task 1-5 birbirinden bağımsız, ayrı worktree'lerde paralel çalışabilir. Task 1 ve 2 `Program.cs`'te farklı satırlara dokunur (birleştirmede küçük çakışma olabilir). Task 6 hepsi birleştikten sonra çalışır.

## Review Focus

- **Uzun boşta kalma sonrası bucket taşması:** saatlerce boşta kalan bir bağlantı `Burst`'ten fazla jeton biriktirmemeli. Task 2 `Refill_never_exceeds_burst` testi.
- **Saat geri gitmesi:** `TimeProvider` zaman damgası geriye giderse (negatif geçen süre) jeton eksiye düşmemeli ya da patlamamalı. Task 2 `Negative_elapsed_time_is_ignored` testi.
- **Eksik ayar anahtarı değil, sıfır değer:** `appsettings` hiç `Security` bölümü içermiyorsa varsayılanlarla açılmalı; sadece açıkça 0/negatif verilen değer açılışı durdurmalı. Task 1 `Defaults_pass_validation` testi.
- **Kullanıcı yeniden bağlanırken eski mesaj:** "Yeniden bağlan" sonrası başarılı katılımda önceki kopma sebebi ekrandan kalkmalı. Task 5 Step 5'teki manuel kontrol.
- **Bilinmeyen hata metni:** SignalR'ın İngilizce ya da boş hata mesajları kullanıcıya ham gösterilmemeli. Task 5 `describeConnectionError` testleri.

---

### Task 1: Limit ayarlarının açılışta doğrulanması ve yorum düzeltmeleri

**Files:**
- Modify: `backend/WatchParty.Api/Security/SecurityOptions.cs`
- Modify: `backend/WatchParty.Api/Program.cs` (`Configure<SecurityOptions>` satırı ve "CloudFront/ALB" yorumu)
- Modify: `backend/WatchParty.Api/Security/HttpRateLimits.cs` (sadece yorum)
- Create: `backend/WatchParty.Api.Tests/SecurityOptionsTests.cs`

**Interfaces:**
- Produces: `SecurityOptions`'taki 9 `int` özelliğin her biri `[Range(1, int.MaxValue)]`. `Program.cs`: `builder.Services.AddOptions<SecurityOptions>().Bind(builder.Configuration.GetSection(SecurityOptions.Section)).ValidateDataAnnotations().ValidateOnStart();` (mevcut `Configure<SecurityOptions>(...)` satırının yerine).

- [ ] **Step 1: Testleri yaz** (`SecurityOptionsTests.cs`)

```csharp
[Fact] public void Defaults_pass_validation()
// new WatchPartyFactory() ile CreateClient(); GET /api/health -> 200

[Theory]
[InlineData("Security:ChatBurst")]
[InlineData("Security:OtherPerSecond")]
[InlineData("Security:CreateLobbyPerMinute")]
[InlineData("Security:MaxConnectionsPerIp")]
public void Zero_limit_stops_startup(string key)
// new WatchPartyFactory(new() { [key] = "0" }).CreateClient() -> OptionsValidationException fırlatır
// (Assert.Throws ile; istisna iç içe gelirse InnerException zincirinde OptionsValidationException ara)
```

- [ ] **Step 2: Çalıştır, `Zero_limit_stops_startup`'ın başarısız olduğunu gör**

Run: `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~SecurityOptionsTests"`
Expected: FAIL — 0 değeriyle uygulama açılıyor, istisna yok.

- [ ] **Step 3: `[Range]` attribute'larını ve `AddOptions...ValidateOnStart()` kaydını ekle; yorumları düzelt**

- `HttpRateLimits.cs`: "yapılandırma Build()'dan sonra da değişebilir" yerine: ayarlar `Build()` sonrası çözülür ki test/ortam yapılandırması görünsün; limit, IP bölümü ilk oluşturulurken okunur.
- `Program.cs` ve `SecurityOptions.cs`'teki "CloudFront/ALB" ifadeleri: CloudFront ile uygulama arasına başka bir proxy (ör. ALB) girerse `ForwardLimit` artırılmalı.

- [ ] **Step 4: Çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS, tüm testler.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "Limit ayarlarını açılışta doğrula, yanıltıcı yorumları düzelt"
```

---

### Task 2: Zamanlayıcısız token bucket

**Files:**
- Create: `backend/WatchParty.Api/Security/TokenBucket.cs`
- Modify: `backend/WatchParty.Api/Security/HubRateLimitFilter.cs`
- Modify: `backend/WatchParty.Api/Program.cs` (`TimeProvider` kaydı)
- Modify: `backend/WatchParty.Api.Tests/WatchParty.Api.Tests.csproj` (paket)
- Create: `backend/WatchParty.Api.Tests/TokenBucketTests.cs`

**Interfaces:**
- Produces: `public sealed class TokenBucket(int burst, int perSecond, TimeProvider time) { public bool TryTake(); }` — dolu başlar; her `TryTake`'te geçen süre kadar (`perSecond` jeton/sn, kesirli) dolar, `burst`'ü aşmaz; ≥1 jeton varsa 1 düşer ve `true`. Son dolum zamanı `max(son, şimdi)` olarak tutulur; saat geri giderse geçen süre 0 sayılır ve geri gelinen süre jeton kazandırmaz. İç durum bir `Lock` ile korunur. Timer yok, `IDisposable` değil.
- `HubRateLimitFilter(ConnectionCounter counter, IOptions<SecurityOptions> options, TimeProvider time)`; `Program.cs`: `builder.Services.AddSingleton(TimeProvider.System);`
- `InvokeMethodAsync`: bucket `Items`'ta yoksa `InvalidOperationException("Bağlantının rate limit durumu bulunamadı")` atar (kapalı başarısızlık). Reddedilen çağrının mesajı aynı kalır: `"Çok hızlı istek gönderiyorsun, biraz bekle"`.
- `Cleanup`'tan limiter dispose kısmı kalkar; sadece `Items` anahtarları temizlenir ve IP yuvası bırakılır.

- [ ] **Step 1: Testleri yaz** (`TokenBucketTests.cs`, `FakeTimeProvider` ile)

```csharp
[Fact] public void Starts_full_and_rejects_after_burst()      // burst 5, perSecond 1: 5 kez true, 6. false (zaman ilerlemeden)
[Fact] public void Refills_at_rate()                          // boşalt; Advance(1 sn) -> 1 true, 1 false; Advance(500 ms) x2 -> 1 true
[Fact] public void Refill_never_exceeds_burst()               // boşalt; Advance(1 saat) -> tam 5 true, 6. false
[Fact] public void Negative_elapsed_time_is_ignored()         // boşalt; SetUtcNow(şimdi - 10 sn) -> false; Advance(10 sn) -> false (geri gidiş jeton kazandırmaz); Advance(1 sn) -> 1 true, sonra false
```

- [ ] **Step 2: Paketi ekle, çalıştır, derlenmediğini gör**

Run: `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~TokenBucketTests"`
Expected: FAIL — `TokenBucket` tanımlı değil.

- [ ] **Step 3: `TokenBucket`'ı yaz; filtreyi ona geçir, `TimeProvider`'ı kaydet**

- [ ] **Step 4: Çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS — `HubRateLimitTests` dahil (davranış aynı, zamanlayıcı yok).

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "Hub rate limit: zamanlayıcısız token bucket, eksik bucket'ta reddet"
```

---

### Task 3: Lobi kapsüllemesi ve deterministik katılma zamanı

**Files:**
- Modify: `backend/WatchParty.Api/Lobbies/Lobby.cs`
- Modify: `backend/WatchParty.Api/Lobbies/InMemoryLobbyStore .cs` (dosya adında boşluk var)
- Modify: `backend/WatchParty.Api.Tests/LobbyTests.cs`

**Interfaces:**
- Produces: `public Lobby(string code, string hostClientId, bool hostOnlyControl = false)`; `Code` ve `CreatedAt` sadece get; `HostClientId`, `EmptySince`, `HostAwaySince` `{ get; private set; }`. `required` üyeler kalkar. `HostOnlyControl` ve `Playback` olduğu gibi kalır (hub `Gate` altında yazıyor).
- `Participant` record'unda `JoinedAt` `{ get; init; } = DateTimeOffset.UtcNow`.

- [ ] **Step 1: Testleri yeni yapıcıya geçir ve yeni testi ekle**

`NewLobby()` → `new Lobby("TEST22", "host")`.

```csharp
[Fact] public void TryTransferHost_orders_by_JoinedAt_not_insertion()
// t0 = UtcNow; host katılır; b = P("b","cb") with { JoinedAt = t0.AddSeconds(1) } ÖNCE eklenir,
// a = P("a","ca") with { JoinedAt = t0 } SONRA eklenir; host ayrılır;
// TryTransferHost(UtcNow.AddSeconds(11), 10 sn) -> a; HostClientId == "ca"
```

`TryTransferHost_picks_oldest_after_grace` testinde katılımcılara açık ve farklı `JoinedAt` verilir.

- [ ] **Step 2: Çalıştır, derlenmediğini gör**

Run: `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~LobbyTests"`
Expected: FAIL — `Lobby(string, string)` yapıcısı yok, `JoinedAt` init edilemiyor.

- [ ] **Step 3: `Lobby` yapıcısını ve erişimcileri uygula; `InMemoryLobbyStore.Create`'i yapıcıya geçir**

- [ ] **Step 4: Çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "Lobi durum alanlarını sadece içeriden yazılabilir yap"
```

---

### Task 4: Medya id sıkılaştırması ve sınır testleri

**Files:**
- Modify: `backend/WatchParty.Api/Lobbies/MediaValidator.cs`
- Modify: `backend/WatchParty.Api.Tests/MediaValidatorTests.cs`

**Interfaces:**
- Produces: `MediaValidator.Validate` imzası aynı. Baş/son boşluklu id (`id != id.Trim()`) mevcut `"Geçersiz medya id"` mesajıyla reddedilir; bu kontrol uzunluk kontrolüyle aynı yerde, biçim kontrollerinden önce.

- [ ] **Step 1: Testleri ekle**

```csharp
[InlineData("file", " https://cdn.example.com/a.mp4", "Geçersiz medya id")]   // Rejects_invalid'e
[InlineData("file", "https://cdn.example.com/a.mp4 ", "Geçersiz medya id")]
[InlineData("youtube", " dQw4w9WgXcQ", "Geçersiz medya id")]
[InlineData(null, "dQw4w9WgXcQ", "Medya tipi")]
[InlineData("youtube", null, "Geçersiz medya id")]
[Fact] public void Accepts_url_of_exactly_200_chars()   // "https://a.com/" + 186 'a' -> 200 karakter -> null
```

- [ ] **Step 2: Çalıştır, boşluk testlerinin başarısız olduğunu gör**

Run: `dotnet test backend/WatchParty.slnx --filter "FullyQualifiedName~MediaValidator"`
Expected: FAIL — `" https://..."` ve `"https://... "` kabul ediliyor (ya da YouTube durumu "YouTube" mesajıyla dönüyor).

- [ ] **Step 3: Boşluk kontrolünü ekle**

- [ ] **Step 4: Çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "Medya id'sinde baş/son boşluğu reddet, sınır testleri"
```

---

### Task 5: Bağlantı kopmasında sebep ve yeniden bağlanma (frontend)

**Files:**
- Modify: `frontend/package.json` (devDependency `vitest`, script `"test": "vitest run"`)
- Modify: `frontend/src/lib/errors.ts`
- Create: `frontend/src/lib/errors.test.ts`
- Modify: `frontend/src/lib/connection.ts`
- Modify: `frontend/src/lib/mock.ts` (sadece arayüz uyumu gerekiyorsa)
- Modify: `frontend/src/pages/LobbyPage.tsx`

**Interfaces:**
- Produces:
  - `export function describeConnectionError(e: unknown): string` (`errors.ts`): `HubException: ` içeren mesajlarda `errorMessage` ile aynı sonucu döner (sunucunun Türkçe metni). Diğer her durumda (boş, `undefined`, İngilizce SignalR metni) `"Sunucuyla bağlantı kesildi"` döner.
  - `LobbyEvents`'e `connectionLost(reason: string): void` eklenir. `SignalRLobbyConnection`: `onclose(error)` → `statusChanged("disconnected")` ve `connectionLost(describeConnectionError(error))`; `onreconnected` içindeki `JoinLobby` başarısız olursa aynı ikisi (hata nesnesiyle) çağrılır ve bağlantı `stop()` edilir. Kullanıcı kendisi `stop()` ettiğinde (`joinArgs === null`) `connectionLost` çağrılmaz.
  - `LobbyPage`: `connectionLost` gelince sebep metni, `phase === "joined"` iken bağlantı durumunun yanında kalıcı bir uyarı olarak ve altında **"Yeniden bağlan"** düğmesiyle gösterilir. Düğme mevcut `join(nick)` akışını yeniden çalıştırır (eski bağlantıyı ve motoru kapatarak). Başarılı katılımda uyarı kalkar. İlk katılımdaki hata yolu (`setFatal(errorMessage(e))`) `describeConnectionError` kullanır.

- [ ] **Step 1: `vitest`'i ekle ve testleri yaz** (`errors.test.ts`)

```ts
test("sunucu mesajını HubException'dan çıkarır", () =>
  expect(describeConnectionError(new Error("An unexpected error occurred invoking 'JoinLobby' on the server. HubException: Bu adresten çok fazla bağlantı var")))
    .toBe("Bu adresten çok fazla bağlantı var"));
test("İngilizce SignalR metnini genel mesaja çevirir", () =>
  expect(describeConnectionError(new Error("Cannot send data if the connection is not in the 'Connected' State."))).toBe("Sunucuyla bağlantı kesildi"));
test("undefined için genel mesaj", () => expect(describeConnectionError(undefined)).toBe("Sunucuyla bağlantı kesildi"));
test("sunucunun kapatma mesajındaki HubException metni", () =>
  expect(describeConnectionError(new Error("Server returned an error on close: Connection closed with an error. HubException: Bu adresten çok fazla bağlantı var")))
    .toBe("Bu adresten çok fazla bağlantı var"));
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `cd frontend; npm test`
Expected: FAIL — `describeConnectionError` export edilmiyor.

- [ ] **Step 3: `describeConnectionError`'ı, `connectionLost` olayını ve `LobbyPage` arayüzünü uygula**

- [ ] **Step 4: Çalıştır**

Run: `cd frontend; npm test; npm run build`
Expected: testler PASS, build hatasız.

- [ ] **Step 5: Manuel kontrol (backend Development'ta)**

Backend'i `Security__MaxConnectionsPerIp=1` ortam değişkeniyle başlat (`cd backend/WatchParty.Api; dotnet run --launch-profile http`), `npm run dev`. İki sekmede aynı lobiye gir: ikinci sekme "Bu adresten çok fazla bağlantı var" görür (İngilizce metin değil). İlk sekmeyi kapat, ikinci sekmede "Yeniden bağlan"a bas: katılım başarılı olur ve uyarı kalkar. Backend'i durdur.
Expected: her iki gözlem de doğru; sonuçları rapora yaz.

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "Bağlantı kopmasında sebebi göster, yeniden bağlan düğmesi"
```

---

### Task 6: Doküman ve son doğrulama

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1-5'in birleşmiş hali.

- [ ] **Step 1: `CLAUDE.md`'yi güncelle**

- REST satırındaki rate limit açıklaması: `POST /api/lobbies` ve `GET /api/lobbies/{code}`.
- "All limits come from the `Security` config section" → "All rate/connection limits come from the `Security` config section (validated at startup; values must be ≥ 1)".
- `HubRateLimitFilter` artık `TokenBucket` kullanıyor (zamanlayıcısız, `TimeProvider` ile; testlerde `FakeTimeProvider`).
- Frontend komutlarına `npm test` (vitest) eklenir; "there is no linter" cümlesi `npm run build`'in tek tip kontrolü olduğunu söylemeye devam eder.
- `Lobby` artık yapıcıyla kurulur; durum alanları sadece `Lobby` metotlarından yazılır.

- [ ] **Step 2: Tam doğrulama**

Run: `dotnet test backend/WatchParty.slnx`, `cd frontend; npm test; npm run build`, sonra backend'i Development'ta başlatıp `cd backend/e2e; npm test`.
Expected: tüm xUnit ve vitest testleri geçer, build hatasız, e2e son satırı `N passed, 0 failed`. Backend'i durdur.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md: ertelenen bulgu düzeltmeleri"
```
