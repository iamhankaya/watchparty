# Ertelenen review bulguları (spec)

Kaynak: `2026-10-12-production-hardening` planının task review'ları ve son genel review'ı. Bunlar merge'i engellemeyen, sonraya bırakılan bulgular.

## Kapsam

1. **Bağlantı reddi kullanıcıya görünmüyor.** IP başına bağlantı limiti handshake'ten sonra uygulanıyor. İlk katılımda kullanıcı bazen İngilizce bir SignalR hatası görüyor ("Cannot send data if the connection is not in the 'Connected' State"). Otomatik yeniden bağlanmada `JoinLobby` reddedilirse durum sessizce "disconnected" oluyor ve tekrar denenmiyor. Ağ kopmasında sunucu eski bağlantıyı ~30 sn tuttuğu için büyük bir NAT arkasındaki kullanıcılar bu duruma düşebilir.
   İstenen: bağlantı kalıcı olarak koptuğunda kullanıcı Türkçe bir sebep ve bir "Yeniden bağlan" düğmesi görür. Bilinmeyen/İngilizce SignalR hataları genel bir Türkçe mesaja çevrilir.
2. **Bağlantı başına üç zamanlayıcı.** `TokenBucketRateLimiter` ile `AutoReplenishment` her bağlantıya üç timer açıyor; zamanlayıcıya bağlı testler de bu yüzden kırılgandı. İstenen: zamanlayıcısız, istek anında tembel dolan bir token bucket; zaman `TimeProvider` ile verilir, testler sahte saatle deterministik olur.
3. **Bucket bulunamazsa çağrı limitsiz geçiyor.** İstenen: kapalı başarısızlık (çağrı reddedilir).
4. **Geçersiz limit ayarı.** `*Burst`, `*PerSecond`, `*PerMinute`, `MaxConnectionsPerIp` için 0 veya negatif değer, HTTP isteklerinde 500'e ya da hub'da sızıntıya yol açıyor. İstenen: uygulama açılışta doğrulama hatasıyla durur.
5. **Lobi kapsüllemesi.** `HostClientId`, `EmptySince`, `HostAwaySince` dışarıdan yazılabiliyor; ileride kilit dışında yazılıp yarışlar geri gelebilir. İstenen: sadece `Lobby` içinden yazılabilir.
6. **Host devri testi zaman damgasına bağlı.** Aynı `JoinedAt` değerinde sıra belirsiz. İstenen: testler `JoinedAt`'i açıkça verebilir.
7. **Medya id boşlukları.** `Uri.TryCreate` baştaki/sondaki boşluğu tolere ediyor, kırpılmamış değer saklanıp yayınlanıyor. İstenen: baş/son boşluklu id reddedilir. Eksik sınır testleri (tam 200 karakter, null tip/id) eklenir.
8. **Yanıltıcı yorumlar ve doküman.** `HttpRateLimits.cs`'deki "yapılandırma Build()'dan sonra da değişebilir" yorumu; `SecurityOptions.cs` ve `Program.cs`'deki "CloudFront/ALB" ifadeleri (ALB eklenirse `ForwardLimit` değişmeli); `CLAUDE.md`'de GET rotası `/api/lobbies/{code}` olmalı ve "All limits" yerine "rate/connection limits" denmeli.

## Kapsam dışı (gerekçeyle)

- **Reddedilen her bağlantı için Error seviyesinde SignalR logu.** Azaltmak için bir framework log kategorisini bastırmak gerekiyor; bu kategori gerçek hataları da raporluyor. Log hacmi gerçekten sorun olursa yeniden ele alınır.
- **`ControlModeChanged` yayınlarının sırası.** Aynı host iki sekmeden aynı anda mod değiştirirse yayınlar ters sırada gidebilir. Bu, branch'ten önce de vardı ve çok nadir.
- **Handshake'i tamamlamayan bağlantıların sayılmaması.** SignalR handshake zaman aşımı (15 sn) bunları zaten sınırlıyor.
- **`lib/mock.ts`'nin yeni doğrulama ve limitleri taklit etmemesi.** Mock sadece arayüz geliştirme aracı.
- **Test csproj'unda dosya sonu satır sonu eksikliği.** Mevcut dosyaların stiliyle aynı.

## Kabul

- `dotnet test backend/WatchParty.slnx` geçer, build 0 uyarı.
- Frontend'e `vitest` eklenir; `npm test` ve `npm run build` geçer.
- e2e (`backend/e2e`) Development backend'e karşı 0 hata ile geçer.
- Mevcut `HubException` mesajları birebir korunur.
