# Canlıya Çıkış Sertleştirmesi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend'i canlıya hazırlamak: HTTP ve hub rate limiting, IP başına bağlantı limiti, CloudFront arkasında gerçek IP, sunucu tarafı medya doğrulaması, test sayfasının prod'dan kaldırılması ve lobi durumundaki yarış koşullarının giderilmesi.

**Architecture:** Lobi durum değişiklikleri `Lobby` üzerindeki metotlara taşınır ve tek bir `Lock` altında yapılır; hub ve arka plan servisleri bu metotları çağırır. Güvenlik katmanı yeni `Security/` klasöründe: `SecurityOptions` (konfigürasyon), ASP.NET `RateLimiter` politikaları (HTTP), `IHubFilter` (hub çağrıları ve bağlantı sayısı). Testler yeni bir xUnit projesinde, entegrasyon testleri `WebApplicationFactory<Program>` + SignalR istemcisi (LongPolling, TestServer handler) ile.

**Tech Stack:** .NET 10 (SDK 10.0.401), ASP.NET Core minimal API, SignalR, `System.Threading.RateLimiting`, xUnit, `Microsoft.AspNetCore.Mvc.Testing`, `Microsoft.AspNetCore.SignalR.Client`; frontend TypeScript (sadece `media.ts`).

**Spec:** `docs/superpowers/specs/2026-10-12-production-hardening.md`

## Global Constraints

- Kod yorumları, `HubException` mesajları ve commit mesajları Türkçe. Mevcut hata mesajları birebir korunur (`Lobi bulunamadı`, `Lobi dolu`, `Sadece host kontrol edebilir` vb.); e2e bunların alt dizelerini kontrol ediyor.
- Yeni NuGet paketleri: sadece `Microsoft.AspNetCore.Mvc.Testing` ve `Microsoft.AspNetCore.SignalR.Client` (10.0.x), sadece test projesine. API projesine paket eklenmez.
- Konfigürasyon bölümü `Security`, prod varsayılanları `SecurityOptions` içinde:
  `TrustForwardedHeaders=false`, `CreateLobbyPerMinute=10`, `LookupLobbyPerMinute=60`, `MaxConnectionsPerIp=20`, `ChatBurst=5`, `ChatPerSecond=1`, `PlaybackBurst=10`, `PlaybackPerSecond=4`, `OtherBurst=20`, `OtherPerSecond=10`.
- `appsettings.Development.json`: `CreateLobbyPerMinute=1000`, `LookupLobbyPerMinute=1000`, `MaxConnectionsPerIp=1000` (e2e tek IP'den 22+ bağlantı açıyor).
- IP anahtarı her yerde `ClientIp.Of(HttpContext)`: `RemoteIpAddress?.ToString() ?? "unknown"`.
- Commit mesajları `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` satırıyla biter.

## Review Focus

- **Aynı NAT arkasındaki gerçek kullanıcılar** (yurt, ofis, aynı evden iki cihaz) bağlantı limitine takılmamalı: 20 bağlantıya kadar sorunsuz. Task 4 `Connections_up_to_limit_succeed` testi.
- **İstemcinin açılış patlaması** (5 art arda `Ping` + `JoinLobby`, ardından 3'lü `Ping`) hiç reddedilmemeli. Task 4 `Startup_ping_burst_and_join_not_throttled` testi.
- **Limit aşımı bağlantıyı öldürmemeli**: reddedilen çağrıdan sonra bucket dolunca aynı bağlantıda çağrı tekrar başarılı olur. Task 4 `Throttled_call_does_not_close_connection` testi.
- **Bağlantı sayacı sızıntısı**: kapanan bağlantılar sayacı düşürmeli, yoksa bir IP kalıcı olarak kilitlenir. Task 4 `Closed_connections_release_slots` testi.
- **İmzalı/uzun ama geçerli medya URL'leri** (sorgu dizesi olan `https` URL ≤200 karakter) kabul edilmeli; `http:`, `javascript:`, göreli yol reddedilmeli. Task 2 testleri.

---

### Task 1: Test projesi ve lobi başına kilit

**Files:**
- Create: `backend/WatchParty.Api.Tests/WatchParty.Api.Tests.csproj` (`dotnet new xunit`)
- Create: `backend/WatchParty.Api.Tests/WatchPartyFactory.cs`
- Create: `backend/WatchParty.Api.Tests/LobbyTests.cs`
- Create: `backend/WatchParty.Api.Tests/HubConcurrencyTests.cs`
- Modify: `backend/WatchParty.slnx` (test projesini ekle)
- Modify: `backend/WatchParty.Api/Program.cs` (sona `public partial class Program;`)
- Modify: `backend/WatchParty.Api/Lobbies/Lobby.cs`
- Modify: `backend/WatchParty.Api/Lobbies/InMemoryLobbyStore .cs` (dosya adında boşluk var)
- Modify: `backend/WatchParty.Api/Lobbies/LobbyHub.cs`
- Modify: `backend/WatchParty.Api/Lobbies/LobbyTickService.cs`

**Interfaces:**
- Produces (Lobby.cs):
  - `public enum JoinOutcome { Joined, Full, Closed }`
  - `Lobby.Gate` : `System.Threading.Lock` (public get) — hub'daki `Update` ve `SetControlMode` bunu kullanır; mevcut `lock (lobby)` kaldırılır.
  - `Lobby.IsClosed` : `bool` (private set)
  - `JoinOutcome TryJoin(Participant participant)` — kilit altında: kapalıysa `Closed`, `Participants.Count >= MaxParticipants` ise `Full`; değilse ekler, `EmptySince = null`, katılan host ise `HostAwaySince = null`.
  - `Participant? Leave(string connectionId)` — kilit altında: çıkarır; çıkan hostun son bağlantısıysa `HostAwaySince = UtcNow`; boş kaldıysa `EmptySince = UtcNow`.
  - `bool TryClose(DateTimeOffset cutoff)` — kilit altında: boşsa ve `EmptySince < cutoff` ise `IsClosed = true`, `true` döner.
  - `Participant? TryTransferHost(DateTimeOffset now, TimeSpan grace)` — kilit altında: `HostAwaySince` yok ya da süre dolmadıysa `null`; host geri döndüyse `HostAwaySince = null`, `null`; aksi halde en eski katılımcıyı (`JoinedAt`) host yapar, `HostAwaySince = null`, onu döner.
- Produces (tests): `WatchPartyFactory : WebApplicationFactory<Program>`, ctor `WatchPartyFactory(Dictionary<string, string?>? overrides = null)`; varsayılan olarak `Security:CreateLobbyPerMinute`, `Security:LookupLobbyPerMinute`, `Security:MaxConnectionsPerIp` değerlerini `1000` yapar, `overrides` bunların üstüne yazılır; ortam `Development` değil `Production`. Yardımcılar:
  - `Task<HubConnection> ConnectAsync()` — `HttpMessageHandlerFactory = _ => Server.CreateHandler()`, `Transports = HttpTransportType.LongPolling`, url `http://localhost/hubs/lobby`, başlatılmış döner.
  - `Task<string> CreateLobbyAsync(string clientId, bool hostOnly = false)` — `POST /api/lobbies`, kodu döner.

- [ ] **Step 1: Test projesini oluştur**

`backend/` altında `dotnet new xunit -n WatchParty.Api.Tests`, API projesine referans, iki paketi ekle, `dotnet sln WatchParty.slnx add WatchParty.Api.Tests/WatchParty.Api.Tests.csproj`. `Program.cs` sonuna `public partial class Program;`. `WatchPartyFactory`'yi yaz (`ConfigureWebHost` içinde `UseEnvironment("Production")` ve `ConfigureAppConfiguration` → `AddInMemoryCollection`). Şablonun ürettiği `UnitTest1.cs`'i sil.

Run: `dotnet build backend/WatchParty.slnx`
Expected: Build succeeded, 0 error.

- [ ] **Step 2: Lobby birim testlerini yaz** (`LobbyTests.cs`)

Yardımcı: `static Participant P(string conn, string client) => new(conn, conn, client);` ve `new Lobby { Code = "TEST22", HostClientId = "host" }`.

```csharp
[Fact] public void TryJoin_returns_Full_at_MaxParticipants()      // 20 kez Joined, 21. Full, Participants.Count == 20
[Fact] public void TryJoin_returns_Closed_after_TryClose()         // yeni lobi: TryClose(UtcNow.AddMinutes(1)) true; TryJoin -> Closed; Participants boş
[Fact] public void TryClose_false_when_participants_present()      // bir kişi katıldı; TryClose(UtcNow.AddMinutes(1)) false; IsClosed false
[Fact] public void Leave_last_participant_sets_EmptySince()        // katıl -> EmptySince null; Leave -> EmptySince not null; dönen Participant'ın ConnectionId'si doğru
[Fact] public void Leave_host_with_other_host_tab_keeps_HostAwaySince_null() // host iki bağlantıyla; biri Leave -> HostAwaySince null; ikincisi Leave -> not null
[Fact] public void TryJoin_by_host_clears_HostAwaySince()
[Fact] public void TryTransferHost_null_within_grace()             // host ayrıldı; TryTransferHost(UtcNow, 10 sn) null; HostClientId "host"
[Fact] public void TryTransferHost_picks_oldest_after_grace()      // host, a, b sırayla katıldı; host ayrıldı; TryTransferHost(UtcNow.AddSeconds(11), 10 sn) -> a; HostClientId == a.ClientId; HostAwaySince null
[Fact] public void RemoveExpired_closes_lobby_and_removes_from_store() // InMemoryLobbyStore.Create -> RemoveExpired(UtcNow.AddMinutes(1)) == 1; Get null; lobby.IsClosed true
```

- [ ] **Step 3: Testleri çalıştır, derlenmediğini gör**

Run: `dotnet test backend/WatchParty.slnx`
Expected: FAIL — `TryJoin`, `JoinOutcome`, `Leave`, `TryClose`, `TryTransferHost`, `IsClosed` tanımlı değil.

- [ ] **Step 4: Lobby metotlarını uygula ve çağıranları taşı**

- `Lobby.cs`: Interfaces'teki üyeler. `IsConnected` kilit içinden de çağrılabilir (kilit `Lock`, aynı thread'de tekrar girilebilir).
- `InMemoryLobbyStore.RemoveExpired`: `lobby.TryClose(cutoff)` true ise `TryRemove`.
- `LobbyHub.JoinLobby`: `store.Get` sonrası `lobby.TryJoin(...)`; `Closed` → `"Lobi bulunamadı"`, `Full` → `"Lobi dolu"`. `Context.Items` ataması ve gruba ekleme yalnızca `Joined` sonrası.
- `LobbyHub.OnDisconnectedAsync`: `lobby.Leave(Context.ConnectionId)`.
- `LobbyHub.Update`: host-only kontrolü, medya kontrolü ve durum değişikliği birlikte `lock (lobby.Gate)` içinde; `HubException` kilit içinden atılabilir. Broadcast kilit dışında.
- `LobbyHub.SetControlMode`: host kontrolü ve atama `lock (lobby.Gate)` içinde.
- `LobbyTickService.TransferHostIfAway`: `lobby.TryTransferHost(DateTimeOffset.UtcNow, HostGracePeriod)`; dönüş `null` değilse log + `HostChanged` + `SendParticipants` (kilit dışında).

- [ ] **Step 5: Birim testlerini çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS, 9 test.

- [ ] **Step 6: Eşzamanlı katılım entegrasyon testini yaz** (`HubConcurrencyTests.cs`)

```csharp
[Fact] public async Task Parallel_joins_never_exceed_MaxParticipants()
// factory = new WatchPartyFactory(); code = await CreateLobbyAsync("h");
// 30 bağlantı aç; Task.WhenAll ile hepsi aynı anda InvokeAsync<JoinResult-benzeri JsonElement>("JoinLobby", code, $"u{i}", $"c{i}")
// başarılı == 20; başarısızların hepsi HubException ve mesajı "Lobi dolu" içeriyor
// GET /api/lobbies/{code} -> participantCount == 20
```

- [ ] **Step 7: Çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS, 10 test. (Kilitsiz eski kodla bu test aralıklı olarak 20'den fazla başarı verir; geçmesi kilidin işe yaradığını gösterir.)

- [ ] **Step 8: Commit**

```bash
git add backend/WatchParty.slnx backend/WatchParty.Api backend/WatchParty.Api.Tests
git commit -m "Lobi durumunu tek kilit altına al, test projesi ekle"
```

---

### Task 2: Sunucu tarafı medya doğrulaması

**Files:**
- Create: `backend/WatchParty.Api/Lobbies/MediaValidator.cs`
- Create: `backend/WatchParty.Api.Tests/MediaValidatorTests.cs`
- Modify: `backend/WatchParty.Api/Lobbies/LobbyHub.cs` (`SetMedia`, `MediaTypes` dizisi kalkar)
- Modify: `frontend/src/lib/media.ts`

**Interfaces:**
- Produces: `public static class MediaValidator { public const int MaxIdLength = 200; public static string? Validate(string? type, string? id); }` — geçerliyse `null`, değilse Türkçe hata mesajı. `SetMedia` mesaj `null` değilse `HubException(mesaj)` atar.
- Mesajlar: tip hatalıysa mevcut `"Medya tipi 'youtube' ya da 'file' olmalı"`; boş/uzunsa mevcut `"Geçersiz medya id"`; youtube biçimi hatalıysa `"Geçersiz YouTube video id"`; file `https` mutlak URL değilse `"Video adresi https:// ile başlamalı"`.

- [ ] **Step 1: Testleri yaz**

```csharp
[Theory]
[InlineData("youtube", "dQw4w9WgXcQ")]
[InlineData("file", "https://cdn.example.com/film.mp4")]
[InlineData("file", "https://cdn.example.com/f.mp4?X-Amz-Signature=abc&X-Amz-Expires=3600")]
public void Accepts_valid(string type, string id) => Assert.Null(MediaValidator.Validate(type, id));

[Theory]
[InlineData("vimeo", "x", "Medya tipi")]
[InlineData("youtube", "", "Geçersiz medya id")]
[InlineData("youtube", "dQw4w9WgXc", "YouTube")]       // 10 karakter
[InlineData("youtube", "dQw4w9WgXcQ!", "YouTube")]
[InlineData("youtube", "<script>xx>", "YouTube")]
[InlineData("file", "http://cdn.example.com/a.mp4", "https")]
[InlineData("file", "javascript:alert(1)", "https")]
[InlineData("file", "/relative/a.mp4", "https")]
public void Rejects_invalid(string type, string id, string messagePart) =>
    Assert.Contains(messagePart, MediaValidator.Validate(type, id));

[Fact] public void Rejects_url_over_200_chars()   // "https://a.com/" + 187 'a' -> 201 karakter -> "Geçersiz medya id"
```

- [ ] **Step 2: Çalıştır, derlenmediğini gör**

Run: `dotnet test backend/WatchParty.slnx`
Expected: FAIL — `MediaValidator` tanımlı değil.

- [ ] **Step 3: `MediaValidator.Validate` yaz, `SetMedia`'yı ona bağla**

YouTube: `^[A-Za-z0-9_-]{11}$` (`[GeneratedRegex]` ya da statik `Regex`). File: `Uri.TryCreate(id, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps`. Uzunluk kontrolü biçimden önce.

- [ ] **Step 4: Çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS.

- [ ] **Step 5: Frontend'i hizala**

`frontend/src/lib/media.ts` `parseMediaInput`: YouTube dışındaki URL'lerde `url.protocol !== "https:"` ise `null`. YouTube linkleri `http:` ile de kabul edilmeye devam eder (sadece ID alınıyor).

Run: `cd frontend; npm run build`
Expected: hata yok.

- [ ] **Step 6: Commit**

```bash
git add backend frontend/src/lib/media.ts
git commit -m "Medya id'sini sunucuda doğrula, dosya için https zorunlu"
```

---

### Task 3: Güvenlik ayarları, gerçek IP ve HTTP rate limiting

**Files:**
- Create: `backend/WatchParty.Api/Security/SecurityOptions.cs`
- Create: `backend/WatchParty.Api/Security/ClientIp.cs`
- Create: `backend/WatchParty.Api/Security/HttpRateLimits.cs`
- Create: `backend/WatchParty.Api.Tests/HttpRateLimitTests.cs`
- Modify: `backend/WatchParty.Api/Program.cs`
- Modify: `backend/WatchParty.Api/appsettings.Development.json`

**Interfaces:**
- Produces:
  - `public class SecurityOptions { public const string Section = "Security"; ... }` — Global Constraints'teki 10 özellik, aynı adlar ve varsayılanlar (`bool`/`int`).
  - `public static class ClientIp { public static string Of(HttpContext context); }`
  - `public static class HttpRateLimits { public const string CreateLobby = "create-lobby"; public const string LookupLobby = "lookup-lobby"; public static IServiceCollection AddHttpRateLimits(this IServiceCollection services); }` — `AddRateLimiter`, iki `FixedWindowRateLimiter` politikası (pencere 1 dk, `QueueLimit = 0`, partition `ClientIp.Of`), limitler `IOptions<SecurityOptions>`'tan (politika içinde `context.RequestServices` ile çözülür), `RejectionStatusCode = 429`.
  - `Program.cs`: `builder.Services.Configure<SecurityOptions>(builder.Configuration.GetSection(SecurityOptions.Section))`; `AddHttpRateLimits()`; pipeline'ın en başında `TrustForwardedHeaders` true ise `UseForwardedHeaders` (`ForwardedHeaders.XForwardedFor`, `ForwardLimit = 1`, `KnownIPNetworks` ve `KnownProxies` temizlenmiş); ardından `UseRateLimiter()`; POST'a `.RequireRateLimiting(HttpRateLimits.CreateLobby)`, GET'e `.RequireRateLimiting(HttpRateLimits.LookupLobby)`. `/api/health` limitsiz.

- [ ] **Step 1: Testleri yaz** (`HttpRateLimitTests.cs`)

```csharp
[Fact] public async Task Create_lobby_over_limit_returns_429()
// overrides: CreateLobbyPerMinute=3. 3 POST -> 201; 4. -> 429
[Fact] public async Task Lookup_over_limit_returns_429()
// LookupLobbyPerMinute=3. 3 GET /api/lobbies/ZZZZZZ -> 404; 4. -> 429
[Fact] public async Task Health_is_not_limited()
// LookupLobbyPerMinute=1, CreateLobbyPerMinute=1; 5 GET /api/health -> hepsi 200
[Fact] public async Task Forwarded_ip_partitions_limit_when_trusted()
// TrustForwardedHeaders=true, CreateLobbyPerMinute=1. X-Forwarded-For: 203.0.113.1 -> 201; tekrar -> 429; X-Forwarded-For: 203.0.113.2 -> 201
[Fact] public async Task Forwarded_header_ignored_when_not_trusted()
// TrustForwardedHeaders=false, CreateLobbyPerMinute=1. XFF .1 -> 201; XFF .2 -> 429
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `dotnet test backend/WatchParty.slnx`
Expected: FAIL — derleme hatası ya da 429 beklenen yerde 201/404.

- [ ] **Step 3: Interfaces'teki tipleri ve `Program.cs` değişikliklerini uygula; `appsettings.Development.json`'a Global Constraints'teki `Security` değerlerini ekle**

- [ ] **Step 4: Çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS (önceki task'ların testleri dahil).

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "HTTP rate limiting ve CloudFront arkasında gerçek IP"
```

---

### Task 4: Hub rate limiting ve IP başına bağlantı limiti

**Files:**
- Create: `backend/WatchParty.Api/Security/ConnectionCounter.cs`
- Create: `backend/WatchParty.Api/Security/HubRateLimitFilter.cs`
- Create: `backend/WatchParty.Api.Tests/HubRateLimitTests.cs`
- Modify: `backend/WatchParty.Api/Program.cs`

**Interfaces:**
- Consumes: `SecurityOptions`, `ClientIp.Of` (Task 3); `WatchPartyFactory.ConnectAsync`, `CreateLobbyAsync` (Task 1).
- Produces:
  - `public class ConnectionCounter { public bool TryAcquire(string ip, int max); public void Release(string ip); }` — singleton; sayaç 0'a inince anahtar silinir.
  - `public class HubRateLimitFilter(ConnectionCounter counter, IOptions<SecurityOptions> options) : IHubFilter` — `AddSignalR(o => o.AddFilter<HubRateLimitFilter>())`, `ConnectionCounter` singleton.
    - `OnConnectedAsync`: IP = `ClientIp.Of(context.Context.GetHttpContext()!)`; `TryAcquire` başarısızsa `HubException("Bu adresten çok fazla bağlantı var")`. Başarılıysa IP'yi `Context.Items["rl:ip"]`'e yaz, üç `TokenBucketRateLimiter`'ı (`TokenLimit = Burst`, `TokensPerPeriod = PerSecond`, `ReplenishmentPeriod = 1 sn`, `QueueLimit = 0`, `AutoReplenishment = true`) `Context.Items`'a koy; `next` hata atarsa `Release` + limiter'ları dispose et ve yeniden at.
    - `InvokeMethodAsync`: metot adına göre grup (Chat: `SendChat`; Playback: `SetMedia`, `Play`, `Pause`, `Seek`, `SetControlMode`; diğer her şey Other); `AttemptAcquire(1)` başarısızsa `HubException("Çok hızlı istek gönderiyorsun, biraz bekle")`.
    - `OnDisconnectedAsync`: `rl:ip` varsa `Release`; limiter'ları dispose et; `next` çağrılır.

- [ ] **Step 1: Testleri yaz** (`HubRateLimitTests.cs`)

```csharp
[Fact] public async Task Chat_burst_over_limit_is_rejected()
// ChatBurst=5, ChatPerSecond=1. Katıl; 5 SendChat başarılı; 6. HubException, mesaj "Çok hızlı" içeriyor
[Fact] public async Task Playback_limit_independent_from_chat()
// ChatBurst=1. SetMedia("youtube","dQw4w9WgXcQ"); 1 chat; 2. chat reddedilir; Play(0) yine başarılı
[Fact] public async Task Throttled_call_does_not_close_connection()
// ChatBurst=1, ChatPerSecond=1. chat ok; chat reddedilir; 1,2 sn bekle; chat ok; connection.State == Connected
[Fact] public async Task Startup_ping_burst_and_join_not_throttled()
// prod varsayılanları (override yok, sadece factory'nin 1000'lik IP limitleri). 5 Ping + JoinLobby + 3 Ping -> hepsi başarılı
[Fact] public async Task Connections_over_limit_are_rejected()
// MaxConnectionsPerIp=3. 3 ConnectAsync başarılı; 4.'de ConnectAsync istisna atar ya da bağlantı kapanır (StartAsync sonrası State != Connected veya Ping hata verir — hangisi olursa onu doğrula)
[Fact] public async Task Connections_up_to_limit_succeed()
// MaxConnectionsPerIp=20. 20 bağlantı açılır ve her biri Ping'e cevap verir
[Fact] public async Task Closed_connections_release_slots()
// MaxConnectionsPerIp=2. 2 aç, ikisini DisposeAsync; sunucunun disconnect'i işlemesini bekle (≤2 sn yoklayarak); 2 yeni bağlantı başarılı
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `dotnet test backend/WatchParty.slnx`
Expected: FAIL — `HubRateLimitFilter` yok / limitler uygulanmıyor.

- [ ] **Step 3: `ConnectionCounter` ve `HubRateLimitFilter`'ı uygula, `Program.cs`'e kaydet**

- [ ] **Step 4: Çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS, tüm testler.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "Hub çağrılarına rate limit ve IP başına bağlantı limiti"
```

---

### Task 5: Test sayfası sadece Development, e2e ve doküman

**Files:**
- Modify: `backend/WatchParty.Api/Program.cs`
- Create: `backend/WatchParty.Api.Tests/StaticFilesTests.cs`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `WatchPartyFactory` (Production ortamı, Task 1).

- [ ] **Step 1: Test yaz**

```csharp
[Fact] public async Task Test_page_not_served_in_production()   // GET /test.html -> 404
[Fact] public async Task Test_page_served_in_development()      // factory'yi WithWebHostBuilder(b => b.UseEnvironment("Development")) ile türet; GET /test.html -> 200
```

- [ ] **Step 2: Çalıştır, ilk testin başarısız olduğunu gör**

Run: `dotnet test backend/WatchParty.slnx`
Expected: FAIL — `Test_page_not_served_in_production` 200 aldı.

- [ ] **Step 3: `app.UseStaticFiles()`'ı `if (app.Environment.IsDevelopment())` içine al**

- [ ] **Step 4: Çalıştır**

Run: `dotnet test backend/WatchParty.slnx`
Expected: PASS.

- [ ] **Step 5: E2E regresyonu**

Backend'i arka planda başlat: `cd backend/WatchParty.Api; dotnet run --launch-profile http` (Development). Sonra `cd backend/e2e; npm install; npm test`.
Expected: son satır `N passed, 0 failed`. Backend'i durdur.

- [ ] **Step 6: `CLAUDE.md` güncelle**

Commands'a `dotnet test backend/WatchParty.slnx` ve tek test için `--filter "FullyQualifiedName~<TestAdı>"`; "no unit tests" cümlesini düzelt. Architecture'a: `Security/` (HTTP limiter + hub filtresi, limitler `Security` bölümünden, Development'ta yüksek), `Lobby` durum değişikliklerinin `Lobby` metotlarında `Gate` kilidi altında yapıldığı, `MediaValidator`, `test.html`'in sadece Development'ta servis edildiği. Deploy notu: `Security:TrustForwardedHeaders=true` sadece origin yalnızca CloudFront'tan erişilebiliyorsa; `AllowedHosts` ortam değişkeniyle verilir.

- [ ] **Step 7: Commit**

```bash
git add backend CLAUDE.md
git commit -m "Test sayfasını sadece Development'ta servis et, dokümanı güncelle"
```
