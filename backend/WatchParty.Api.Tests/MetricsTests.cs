using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using WatchParty.Api.Metrics;

namespace WatchParty.Api.Tests;

// TestServer'da RemoteIpAddress boştur; test başlığı bağlantı adresini belirler (yalnız bu fabrikada).
public class MetricsFactory(Dictionary<string, string?>? overrides = null) : WatchPartyFactory(overrides)
{
    public const string RemoteHeader = "X-Test-Remote-Ip";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureServices(services => services.AddTransient<IStartupFilter, RemoteIpFilter>());
    }

    private sealed class RemoteIpFilter : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use((context, nextMiddleware) =>
            {
                if (context.Request.Headers.TryGetValue(RemoteHeader, out var ip) && IPAddress.TryParse(ip, out var parsed))
                    context.Connection.RemoteIpAddress = parsed;
                return nextMiddleware(context);
            });
            next(app);
        };
    }
}

public class ProductMetricsTests
{
    [Fact]
    public void Ayni_clientId_gunde_bir_kez_sayilir()
    {
        var metrics = new ProductMetrics(new FakeTimeProvider());
        metrics.RecordJoin("a");
        metrics.RecordJoin("a");
        metrics.RecordJoin("b");
        Assert.Equal(2, metrics.ActiveToday());
    }

    [Fact]
    public void Lobi_olusturma_sayilir()
    {
        var metrics = new ProductMetrics(new FakeTimeProvider());
        metrics.RecordLobbyCreated();
        metrics.RecordLobbyCreated();
        Assert.Equal(2, metrics.SignupsToday());
    }

    [Fact]
    public void Gun_UTC_gece_yarisi_donunce_sayaclar_sifirlanir()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(DateTimeOffset.UtcNow.Date, TimeSpan.Zero).AddHours(23).AddMinutes(59));
        var metrics = new ProductMetrics(time);
        metrics.RecordJoin("a");
        metrics.RecordLobbyCreated();

        time.Advance(TimeSpan.FromMinutes(2));

        Assert.Equal(0, metrics.ActiveToday());
        Assert.Equal(0, metrics.SignupsToday());
        metrics.RecordJoin("a");
        Assert.Equal(1, metrics.ActiveToday());
    }
}

public class InternalMetricsTests
{
    private static HttpRequestMessage Get(string? remoteIp)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/internal/metrics");
        if (remoteIp is not null)
            request.Headers.Add(MetricsFactory.RemoteHeader, remoteIp);
        return request;
    }

    private static async Task<JsonElement> Read(HttpClient client, string ip = "127.0.0.1")
    {
        var response = await client.SendAsync(Get(ip));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    private static int Num(JsonElement body, string name) => body.GetProperty(name).GetInt32();

    [Fact]
    public async Task Loopback_200_ve_yalniz_sayi_alanlari()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();

        var body = await Read(client);

        foreach (var name in new[] { "product_sessions_open", "ws_connections", "product_active_today", "product_signups_today" })
        {
            Assert.True(body.TryGetProperty(name, out var value), name);
            Assert.Equal(JsonValueKind.Number, value.ValueKind);
        }
        Assert.False(body.TryGetProperty("product_users_total", out _));
        // Gizlilik: yalnız sayılar; ad, kod, IP, dosya adı yok.
        Assert.All(body.EnumerateObject(), p => Assert.Equal(JsonValueKind.Number, p.Value.ValueKind));
        Assert.All(body.EnumerateObject(), p => Assert.Matches("^[a-z][a-z0-9_]{0,63}$", p.Name));
    }

    [Fact]
    public async Task IPv6_loopback_200()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Get("::1"))).StatusCode);
    }

    [Theory]
    [InlineData("203.0.113.7")]
    [InlineData("10.0.0.5")]
    [InlineData(null)] // adres bilinmiyor
    public async Task Loopback_disi_404(string? ip)
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(Get(ip))).StatusCode);
    }

    [Theory]
    [InlineData("X-Forwarded-For")]
    [InlineData("X-Original-For")]
    [InlineData("X-Origin-Verify")]
    public async Task Proxy_basligi_varsa_loopback_olsa_da_404(string header)
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var request = Get("127.0.0.1");
        request.Headers.Add(header, "127.0.0.1");
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task Forwarded_header_guvenilirse_sahte_XFF_loopback_yapmaz()
    {
        await using var factory = new MetricsFactory(new() { ["Security:TrustForwardedHeaders"] = "true" });
        using var client = factory.CreateClient();
        var request = Get("203.0.113.7");
        request.Headers.Add("X-Forwarded-For", "127.0.0.1, 203.0.113.7");
        Assert.Equal(HttpStatusCode.NotFound, (await client.SendAsync(request)).StatusCode);
    }

    [Fact]
    public async Task Origin_secret_acikken_loopback_yine_200()
    {
        await using var factory = new MetricsFactory(new() { ["Security:OriginSecret"] = "gizli" });
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Get("127.0.0.1"))).StatusCode);
    }

    [Fact]
    public async Task Lobi_olusturma_katilma_ayrilma_sayaclari_degistirir()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var before = await Read(client);

        var code = await factory.CreateLobbyAsync("host-1");
        await using var c1 = await factory.ConnectAsync();
        await using var c2 = await factory.ConnectAsync();
        await c1.InvokeAsync("JoinLobby", code, "Ali", "host-1");
        await c2.InvokeAsync("JoinLobby", code, "Veli", "viewer-1");
        // Aynı kişi ikinci sekmeyle katılırsa farklı kişi sayılmaz.
        await using var c3 = await factory.ConnectAsync();
        await c3.InvokeAsync("JoinLobby", code, "Ali2", "host-1");

        var during = await Read(client);
        Assert.Equal(Num(before, "product_sessions_open") + 1, Num(during, "product_sessions_open"));
        Assert.Equal(Num(before, "product_signups_today") + 1, Num(during, "product_signups_today"));
        Assert.Equal(Num(before, "product_active_today") + 2, Num(during, "product_active_today"));
        Assert.Equal(Num(before, "ws_connections") + 3, Num(during, "ws_connections"));

        await c1.StopAsync();
        await c2.StopAsync();
        await c3.StopAsync();
        await WaitFor(async () => Num(await Read(client), "ws_connections") == Num(before, "ws_connections"));

        // Ayrılmak "bugün aktif" ve "bugün oluşturulan" sayısını düşürmez; lobi 10 dk boş kalmadıkça açık sayılır.
        var after = await Read(client);
        Assert.Equal(Num(during, "product_active_today"), Num(after, "product_active_today"));
        Assert.Equal(Num(during, "product_signups_today"), Num(after, "product_signups_today"));
        Assert.Equal(Num(during, "product_sessions_open"), Num(after, "product_sessions_open"));
    }

    [Fact]
    public async Task Basarisiz_katilma_aktif_sayilmaz()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var before = await Read(client);

        await using var c = await factory.ConnectAsync();
        await Assert.ThrowsAsync<HubException>(() => c.InvokeAsync("JoinLobby", "YOKYOK", "Ali", "x-1"));

        Assert.Equal(Num(before, "product_active_today"), Num(await Read(client), "product_active_today"));
    }

    [Fact]
    public async Task Gecersiz_lobi_istegi_signup_sayilmaz()
    {
        await using var factory = new MetricsFactory();
        using var client = factory.CreateClient();
        var before = await Read(client);

        var response = await client.PostAsJsonAsync("/api/lobbies", new { clientId = "" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        Assert.Equal(Num(before, "product_signups_today"), Num(await Read(client), "product_signups_today"));
    }

    private static async Task WaitFor(Func<Task<bool>> condition)
    {
        for (var i = 0; i < 50; i++)
        {
            if (await condition()) return;
            await Task.Delay(100);
        }
        Assert.True(await condition(), "Koşul 5 sn içinde sağlanmadı");
    }
}
