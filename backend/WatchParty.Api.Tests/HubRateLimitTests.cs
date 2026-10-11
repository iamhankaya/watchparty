using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace WatchParty.Api.Tests;

public class HubRateLimitTests
{
    private static Dictionary<string, string?> Limits(params (string Key, int Value)[] items) =>
        items.ToDictionary(i => $"Security:{i.Key}", i => (string?)i.Value.ToString());

    private static async Task<HubConnection> JoinAsync(WatchPartyFactory factory)
    {
        var code = await factory.CreateLobbyAsync("host");
        var connection = await factory.ConnectAsync();
        await connection.InvokeAsync<JsonElement>("JoinLobby", code, "u", "host");
        return connection;
    }

    private static async Task<bool> WaitUntilAsync(Func<Task<bool>> condition, int timeoutMs = 2000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            if (await condition()) return true;
            await Task.Delay(50);
        }
        return await condition();
    }

    // Reddedilene kadar (en çok 15 deneme) arka arkaya chat gönderir; zamanlayıcı dolumundan etkilenmez.
    private static async Task<(int Succeeded, HubException Rejection)> SendChatsUntilRejectedAsync(HubConnection connection)
    {
        for (var i = 0; i < 15; i++)
        {
            try
            {
                await connection.InvokeAsync("SendChat", $"m{i}");
            }
            catch (HubException ex) when (ex.Message.Contains("Çok hızlı"))
            {
                return (i, ex);
            }
        }
        throw new Xunit.Sdk.XunitException("15 chat denemesinde hiçbiri reddedilmedi");
    }

    [Fact]
    public async Task Chat_burst_over_limit_is_rejected()
    {
        await using var factory = new WatchPartyFactory(Limits(("ChatBurst", 5), ("ChatPerSecond", 1)));
        await using var connection = await JoinAsync(factory);

        var (succeeded, rejection) = await SendChatsUntilRejectedAsync(connection);

        Assert.True(succeeded >= 5, $"Reddedilmeden önce en az 5 chat başarılı olmalı, oldu: {succeeded}");
        Assert.Contains("Çok hızlı", rejection.Message);
    }

    [Fact]
    public async Task Playback_limit_independent_from_chat()
    {
        await using var factory = new WatchPartyFactory(Limits(("ChatBurst", 1), ("ChatPerSecond", 1)));
        await using var connection = await JoinAsync(factory);

        await connection.InvokeAsync("SetMedia", "youtube", "dQw4w9WgXcQ");
        await SendChatsUntilRejectedAsync(connection);

        await connection.InvokeAsync("Play", 0.0);
    }

    [Fact]
    public async Task Throttled_call_does_not_close_connection()
    {
        await using var factory = new WatchPartyFactory(Limits(("ChatBurst", 1), ("ChatPerSecond", 1)));
        await using var connection = await JoinAsync(factory);

        await SendChatsUntilRejectedAsync(connection);

        // Token geri gelene kadar yokla
        var recovered = await WaitUntilAsync(async () =>
        {
            try { await connection.InvokeAsync("SendChat", "tekrar"); return true; }
            catch (HubException) { return false; }
        }, 5000);
        Assert.True(recovered);
        Assert.Equal(HubConnectionState.Connected, connection.State);
    }

    [Fact]
    public async Task Startup_ping_burst_and_join_not_throttled()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var connection = await factory.ConnectAsync();

        for (var i = 0; i < 5; i++)
            await connection.InvokeAsync<long>("Ping");
        await connection.InvokeAsync<JsonElement>("JoinLobby", code, "u", "host");
        for (var i = 0; i < 3; i++)
            await connection.InvokeAsync<long>("Ping");
    }

    [Fact]
    public async Task Connections_over_limit_are_rejected()
    {
        await using var factory = new WatchPartyFactory(Limits(("MaxConnectionsPerIp", 3)));
        var open = new List<HubConnection>();
        try
        {
            for (var i = 0; i < 3; i++)
                open.Add(await factory.ConnectAsync());

            var rejected = false;
            try
            {
                var fourth = await factory.ConnectAsync();
                open.Add(fourth);
                // Bağlantı kurulduysa sunucu kapatmış olmalı ya da çağrılar başarısız olmalı
                rejected = !await WaitUntilAsync(async () =>
                {
                    if (fourth.State != HubConnectionState.Connected) return false;
                    try { await fourth.InvokeAsync<long>("Ping"); return true; }
                    catch { return false; }
                }, 1000);
            }
            catch
            {
                rejected = true;
            }

            Assert.True(rejected);
        }
        finally
        {
            foreach (var c in open) await c.DisposeAsync();
        }
    }

    [Fact]
    public async Task Connections_up_to_limit_succeed()
    {
        await using var factory = new WatchPartyFactory(Limits(("MaxConnectionsPerIp", 20)));
        var open = new List<HubConnection>();
        try
        {
            for (var i = 0; i < 20; i++)
                open.Add(await factory.ConnectAsync());

            foreach (var c in open)
                await c.InvokeAsync<long>("Ping");
        }
        finally
        {
            foreach (var c in open) await c.DisposeAsync();
        }
    }

    [Fact]
    public async Task Closed_connections_release_slots()
    {
        await using var factory = new WatchPartyFactory(Limits(("MaxConnectionsPerIp", 2)));
        var first = await factory.ConnectAsync();
        var second = await factory.ConnectAsync();
        await first.DisposeAsync();
        await second.DisposeAsync();

        var reopened = new List<HubConnection>();
        try
        {
            // Sunucunun disconnect'i işlemesini yoklayarak bekle
            var ok = await WaitUntilAsync(async () =>
            {
                try
                {
                    var c = await factory.ConnectAsync();
                    reopened.Add(c);
                    await c.InvokeAsync<long>("Ping");
                    return true;
                }
                catch { return false; }
            });
            Assert.True(ok);

            var again = await factory.ConnectAsync();
            reopened.Add(again);
            await again.InvokeAsync<long>("Ping");
        }
        finally
        {
            foreach (var c in reopened) await c.DisposeAsync();
        }
    }
}
