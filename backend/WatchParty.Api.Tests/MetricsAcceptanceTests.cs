using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using WatchParty.Api.Lobbies;
using WatchParty.Api.Metrics;

namespace WatchParty.Api.Tests;

// Doğrulama fazı (T20261121-67): /internal/metrics için bağımsız kabul/hata avı testleri.
// MetricsFactory (MetricsTests.cs) TestServer'da uzak IP'yi X-Test-Remote-Ip başlığıyla belirler.
public class MetricsAcceptanceTests
{
    private static readonly string[] Names =
        ["product_sessions_open", "ws_connections", "product_active_today", "product_signups_today"];

    private static HttpRequestMessage Req(string? remoteIp, HttpMethod? method = null, string path = "/internal/metrics")
    {
        var request = new HttpRequestMessage(method ?? HttpMethod.Get, path);
        if (remoteIp is not null)
            request.Headers.Add(MetricsFactory.RemoteHeader, remoteIp);
        return request;
    }

    private static async Task<JsonElement> ReadOk(HttpClient client)
    {
        var response = await client.SendAsync(Req("127.0.0.1"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    [Fact]
    public async Task IPv4_eslemeli_IPv6_loopback_200()
    {
        // Linux'ta çift yığınlı Kestrel, 127.0.0.1'den gelen curl'ü ::ffff:127.0.0.1 olarak görebilir.
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Req("::ffff:127.0.0.1"))).StatusCode);
    }

    [Fact]
    public async Task Ayni_makinenin_loopback_olmayan_adresi_404()
    {
        // Yerel arayüz IP'si (ör. 10.0.0.5 / 172.31.x.x) loopback sayılmaz; yalnız 127/8 ve ::1.
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Req("::ffff:10.0.0.5"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Req("0.0.0.0"))).StatusCode);
    }

    [Fact]
    public async Task Guvenilen_XFF_tek_degerle_loopback_taklidi_404()
    {
        // Gerçek saldırı biçimi: dışarıdan gelen istek XFF: 127.0.0.1 ile RemoteIpAddress'i loopback'e çevirtmeye çalışır.
        // UseForwardedHeaders adresi değiştirir; uç yine de 404 vermelidir.
        await using var factory = new MetricsFactory(new() { ["Security:TrustForwardedHeaders"] = "true" });
        using var client = factory.CreateClient();
        var request = Req("203.0.113.7");
        request.Headers.Add("X-Forwarded-For", "127.0.0.1");
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task Guvenilen_XFF_IPv6_loopback_taklidi_404()
    {
        await using var factory = new MetricsFactory(new() { ["Security:TrustForwardedHeaders"] = "true" });
        using var client = factory.CreateClient();
        var request = Req("203.0.113.7");
        request.Headers.Add("X-Forwarded-For", "::1");
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task Dogru_origin_secret_ile_bile_loopback_disi_404()
    {
        // CloudFront üzerinden gelen meşru istek (doğru X-Origin-Verify) OriginVerification'ı geçer ama uç 404 vermeli.
        await using var factory = new MetricsFactory(new() { ["Security:OriginSecret"] = "gizli" });
        using var client = factory.CreateClient();
        var request = Req("203.0.113.7");
        request.Headers.Add("X-Origin-Verify", "gizli");
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task Origin_secret_acikken_loopback_olmayan_ve_basliksiz_istek_404_degil_403_kalir()
    {
        // Mevcut OriginVerification davranışı bozulmamış olmalı (uç onu atlatmamalı).
        await using var factory = new MetricsFactory(new() { ["Security:OriginSecret"] = "gizli" });
        using var client = factory.CreateClient();
        var response = await client.SendAsync(Req("203.0.113.7"));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Loopback_disi_404_bilinmeyen_rotadan_ayirt_edilemez()
    {
        // Ucun varlığı sızmasın: aynı durum kodu ve aynı gövde.
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var hidden = await client.SendAsync(Req("203.0.113.7"));
        var unknown = await client.SendAsync(Req("203.0.113.7", path: "/internal/yok"));
        Assert.Equal(unknown.StatusCode, hidden.StatusCode);
        Assert.Equal(await unknown.Content.ReadAsStringAsync(), await hidden.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("POST")]
    [InlineData("PUT")]
    [InlineData("DELETE")]
    public async Task Loopback_GET_disi_metot_200_vermez(string method)
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var response = await client.SendAsync(Req("127.0.0.1", new HttpMethod(method)));
        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain("product_", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Yanit_tam_olarak_dort_negatif_olmayan_tam_sayi_alandir()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var body = await ReadOk(client);

        Assert.Equal(Names.Order(), body.EnumerateObject().Select(p => p.Name).Order());
        Assert.All(body.EnumerateObject(), p =>
        {
            Assert.Equal(JsonValueKind.Number, p.Value.ValueKind);
            Assert.True(p.Value.TryGetInt64(out var n), p.Name);
            Assert.True(n >= 0, p.Name);
        });
    }

    [Fact]
    public async Task Gizlilik_yanitta_kod_takma_ad_clientId_medya_yok()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var code = await factory.CreateLobbyAsync("gizli-client-xyz");
        await using var c = await factory.ConnectAsync();
        await c.InvokeAsync("JoinLobby", code, "GizliTakmaAd", "gizli-client-xyz");
        await c.InvokeAsync("SetMedia", "file", "https://x.example/videolar/gizli-dosya.mp4");

        var response = await client.SendAsync(Req("127.0.0.1"));
        var text = await response.Content.ReadAsStringAsync();

        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.DoesNotContain(code, text);
        Assert.DoesNotContain("GizliTakmaAd", text);
        Assert.DoesNotContain("gizli-client-xyz", text);
        Assert.DoesNotContain("gizli-dosya", text);
        Assert.DoesNotContain("127.0.0.1", text);
        Assert.Equal(4, JsonDocument.Parse(text).RootElement.EnumerateObject().Count());
    }

    [Fact]
    public async Task Cok_uzun_clientId_ile_katilma_reddedilir_ve_aktif_sayilmaz()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var code = await factory.CreateLobbyAsync("host-x");
        var before = (await ReadOk(client)).GetProperty("product_active_today").GetInt32();

        await using var c = await factory.ConnectAsync();
        await Assert.ThrowsAsync<HubException>(() => c.InvokeAsync("JoinLobby", code, "Ali", new string('a', 101)));

        Assert.Equal(before, (await ReadOk(client)).GetProperty("product_active_today").GetInt32());
    }

    [Fact]
    public async Task Ikinci_JoinLobby_ayni_baglantida_reddedilir_ve_ikinci_kez_sayilmaz()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var code = await factory.CreateLobbyAsync("host-y");
        await using var c = await factory.ConnectAsync();
        await c.InvokeAsync("JoinLobby", code, "Ali", "host-y");
        var before = (await ReadOk(client)).GetProperty("product_active_today").GetInt32();

        await Assert.ThrowsAsync<HubException>(() => c.InvokeAsync("JoinLobby", code, "Ali", "baska-biri"));

        Assert.Equal(before, (await ReadOk(client)).GetProperty("product_active_today").GetInt32());
    }

    [Fact]
    public async Task Kapanan_lobi_product_sessions_open_sayisindan_duser()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var before = (await ReadOk(client)).GetProperty("product_sessions_open").GetInt32();
        var code = await factory.CreateLobbyAsync("host-z");
        Assert.Equal(before + 1, (await ReadOk(client)).GetProperty("product_sessions_open").GetInt32());

        // Boş lobiyi temizlik servisinin yaptığı gibi kapat (gelecekteki bir eşikle).
        var store = factory.Services.GetRequiredService<ILobbyStore>();
        store.RemoveExpired(DateTimeOffset.UtcNow.AddDays(1));

        Assert.Null(store.Get(code));
        Assert.Equal(before, (await ReadOk(client)).GetProperty("product_sessions_open").GetInt32());
    }

    [Fact]
    public async Task Sayac_ayni_anda_cok_sayida_istekte_tutarli()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var before = (await ReadOk(client)).GetProperty("product_signups_today").GetInt32();

        await Task.WhenAll(Enumerable.Range(0, 40).Select(i => factory.CreateLobbyAsync($"h-{i}")));

        var body = await ReadOk(client);
        Assert.Equal(before + 40, body.GetProperty("product_signups_today").GetInt32());
        Assert.Equal(40, body.GetProperty("product_sessions_open").GetInt32());
    }
}

public class ProductMetricsAcceptanceTests
{
    [Fact]
    public async Task Paralel_RecordJoin_ve_RecordLobbyCreated_kayip_olmadan_sayar()
    {
        var metrics = new ProductMetrics(new FakeTimeProvider());
        await Task.WhenAll(Enumerable.Range(0, 2000).Select(i => Task.Run(() =>
        {
            metrics.RecordJoin($"c-{i % 500}");
            metrics.RecordLobbyCreated();
        })));

        Assert.Equal(500, metrics.ActiveToday());
        Assert.Equal(2000, metrics.SignupsToday());
    }

    [Fact]
    public void Birden_fazla_gun_atlayinca_da_sifirlanir_ve_yeni_gun_yeniden_sayilir()
    {
        var time = new FakeTimeProvider(DateTimeOffset.UtcNow.AddDays(-10));
        var metrics = new ProductMetrics(time);
        metrics.RecordJoin("a");
        metrics.RecordLobbyCreated();

        time.Advance(TimeSpan.FromDays(3));

        Assert.Equal(0, metrics.SignupsToday());
        Assert.Equal(0, metrics.ActiveToday());
        metrics.RecordJoin("a"); // dünkü kişi yeni günde yeniden sayılır
        Assert.Equal(1, metrics.ActiveToday());
    }

    [Fact]
    public void Ayni_gun_icinde_saat_ilerlemesi_sifirlamaz()
    {
        // Gün başlangıcına göre göreli: UTC günün başı + 1 sa -> + 22 sa.
        var dayStart = new DateTimeOffset(DateTimeOffset.UtcNow.Date, TimeSpan.Zero);
        var time = new FakeTimeProvider(dayStart.AddHours(1));
        var metrics = new ProductMetrics(time);
        metrics.RecordJoin("a");
        metrics.RecordLobbyCreated();

        time.Advance(TimeSpan.FromHours(22));

        Assert.Equal(1, metrics.ActiveToday());
        Assert.Equal(1, metrics.SignupsToday());
    }

    [Fact]
    public void Sinirda_23_59_59_ile_00_00_00_arasi_gecis_tam_gece_yarisinda_olur()
    {
        var midnight = new DateTimeOffset(DateTimeOffset.UtcNow.Date, TimeSpan.Zero).AddDays(1);
        var time = new FakeTimeProvider(midnight.AddSeconds(-1));
        var metrics = new ProductMetrics(time);
        metrics.RecordLobbyCreated();
        Assert.Equal(1, metrics.SignupsToday());

        time.Advance(TimeSpan.FromSeconds(1));

        Assert.Equal(0, metrics.SignupsToday());
    }
}
