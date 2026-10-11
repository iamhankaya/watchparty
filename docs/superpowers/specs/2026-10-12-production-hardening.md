# Canlıya çıkış sertleştirmesi (spec)

Kaynak: 2026-10-12 kod incelemesi, "Canlıdan önce mutlaka yapılmalı" ve "Eşzamanlılık hataları" bölümleri.

## Kapsam

1. **HTTP rate limiting** — `POST /api/lobbies` ve `GET /api/lobbies/{code}` için IP başına sabit pencere limiti; aşılınca `429`.
2. **Hub rate limiting** — WebSocket üzerinden gelen hub çağrıları HTTP limiter'ından geçmez. Bağlantı başına token bucket (`IHubFilter`), üç grup:
   - sohbet: `SendChat`
   - oynatma: `SetMedia`, `Play`, `Pause`, `Seek`, `SetControlMode`
   - diğer: `JoinLobby`, `Ping` (istemci açılışta art arda 5 `Ping` atıyor, bu yüzden geniş tutulur)
   Limit aşımı bağlantıyı koparmaz, sadece o çağrı `HubException` ile reddedilir.
3. **IP başına eşzamanlı hub bağlantısı limiti.**
4. **Gerçek istemci IP'si** — CloudFront arkasında `X-Forwarded-For`'un en sağdaki değeri (CloudFront'un eklediği) kullanılır. Sadece konfigürasyonla açılır (`Security:TrustForwardedHeaders`), çünkü origin'e doğrudan erişilebiliyorsa header sahtelenebilir.
5. **Sunucu tarafı medya doğrulaması** — `youtube`: `^[A-Za-z0-9_-]{11}$`. `file`: mutlak `https://` URL, en fazla 200 karakter. Frontend de `file` için `http:` kabul etmeyi bırakır.
6. **`wwwroot/test.html` sadece Development'ta servis edilir.**
7. **Lobi başına kilit** — katılma/ayrılma/temizlik/host devri/oynatma/kontrol modu değişiklikleri tek kilit altında. Düzeltilecek yarışlar: 20 kişi sınırının aşılması, silinen lobiye katılma, host devrinin hub ile çakışması.

Bütün limitler `Security` konfigürasyon bölümünden okunur. Development'ta e2e'nin geçmesi için yüksek değerler kullanılır.

## Kapsam dışı (deploy zamanı ayarı, kod değil)

- `AllowedHosts`: deploy'da ortam değişkeniyle gerçek alan adı verilir.
- EC2 security group'unun sadece CloudFront managed prefix list'ini kabul etmesi.
- CloudFront response headers policy (CSP `frame-src` YouTube, HSTS, `X-Content-Type-Options`).
- RBAC/kick/şifre, host token, Redis — ayrı planlar.

## Kabul

- Mevcut e2e (`backend/e2e`) Development konfigürasyonuyla değişmeden geçer (hata mesajları aynı kalır).
- Yeni xUnit test projesi her maddeyi test eder.
