using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace WatchParty.Api.Tests;

public class HubSubtitleTests
{
    private const string Vtt = "https://cdn.example.com/a.vtt";
    private const string Video = "https://cdn.example.com/film.mp4";

    private sealed class Client(HubConnection connection, Channel<JsonElement> updates) : IAsyncDisposable
    {
        public HubConnection Connection { get; } = connection;

        public Task Invoke(string method, params object?[] args) =>
            Connection.InvokeCoreAsync(method, args);

        /// <summary>Sıradaki PlaybackUpdated yayınını bekler.</summary>
        public async Task<JsonElement> NextUpdate() =>
            await updates.Reader.ReadAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);

        public ValueTask DisposeAsync() => Connection.DisposeAsync();
    }

    private static async Task<Client> JoinAsync(WatchPartyFactory factory, string code, string clientId)
    {
        var connection = await factory.ConnectAsync();
        var updates = Channel.CreateUnbounded<JsonElement>();
        connection.On<JsonElement>("PlaybackUpdated", s => updates.Writer.TryWrite(s));
        await connection.InvokeAsync<JsonElement>("JoinLobby", code, clientId, clientId);
        var client = new Client(connection, updates);
        await client.NextUpdate(); // JoinLobby sonrası ilk durum
        return client;
    }

    private static async Task<(Client host, Client guest)> LobbyWithVideoAsync(WatchPartyFactory factory, bool hostOnly = false)
    {
        var code = await factory.CreateLobbyAsync("host", hostOnly);
        var host = await JoinAsync(factory, code, "host");
        var guest = await JoinAsync(factory, code, "guest");
        await host.Invoke("SetMedia", "file", Video);
        await host.NextUpdate();
        await guest.NextUpdate();
        return (host, guest);
    }

    [Fact]
    public async Task SetSubtitle_sets_url_and_broadcasts()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyWithVideoAsync(factory);
        await using var _h = host;
        await using var _g = guest;

        await host.Invoke("SetSubtitle", Vtt);

        Assert.Equal(Vtt, (await host.NextUpdate()).GetProperty("subtitleUrl").GetString());
        Assert.Equal(Vtt, (await guest.NextUpdate()).GetProperty("subtitleUrl").GetString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public async Task SetSubtitle_null_or_empty_removes(string? value)
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyWithVideoAsync(factory);
        await using var _h = host;
        await using var _g = guest;
        await host.Invoke("SetSubtitle", Vtt);
        await host.NextUpdate();
        await guest.NextUpdate();

        await host.Invoke("SetSubtitle", value);

        Assert.Equal(JsonValueKind.Null, (await guest.NextUpdate()).GetProperty("subtitleUrl").ValueKind);
    }

    [Theory]
    [InlineData("http://cdn.example.com/a.vtt", "Altyazı adresi https:// ile başlamalı")]
    [InlineData(" https://cdn.example.com/a.vtt", "Altyazı adresi https:// ile başlamalı")]
    [InlineData("https://cdn.example.com/a.vtt ", "Altyazı adresi https:// ile başlamalı")]
    public async Task SetSubtitle_rejects_invalid_url(string url, string message)
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyWithVideoAsync(factory);
        await using var _h = host;
        await using var _g = guest;

        var ex = await Assert.ThrowsAsync<HubException>(() => host.Invoke("SetSubtitle", url));
        Assert.Contains(message, ex.Message);
    }

    [Fact]
    public async Task SetSubtitle_rejects_invalid_url_too_long()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyWithVideoAsync(factory);
        await using var _h = host;
        await using var _g = guest;
        var url = "https://cdn.example.com/" + new string('a', 201 - "https://cdn.example.com/".Length);
        Assert.Equal(201, url.Length);

        var ex = await Assert.ThrowsAsync<HubException>(() => host.Invoke("SetSubtitle", url));
        Assert.Contains("Altyazı adresi en fazla 200 karakter olmalı", ex.Message);
    }

    [Fact]
    public async Task SetSubtitle_requires_media()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var host = await JoinAsync(factory, code, "host");

        var ex = await Assert.ThrowsAsync<HubException>(() => host.Invoke("SetSubtitle", Vtt));
        Assert.Contains("Önce bir medya seç", ex.Message);
    }

    [Fact]
    public async Task SetSubtitle_rejects_youtube()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var host = await JoinAsync(factory, code, "host");
        await host.Invoke("SetMedia", "youtube", "dQw4w9WgXcQ");
        await host.NextUpdate();

        var ex = await Assert.ThrowsAsync<HubException>(() => host.Invoke("SetSubtitle", Vtt));
        Assert.Contains("Altyazı yalnızca MP4 videolarda kullanılabilir", ex.Message);
    }

    [Fact]
    public async Task SetSubtitle_host_only_rejects_non_host()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyWithVideoAsync(factory, hostOnly: true);
        await using var _h = host;
        await using var _g = guest;

        var ex = await Assert.ThrowsAsync<HubException>(() => guest.Invoke("SetSubtitle", Vtt));
        Assert.Contains("Sadece host kontrol edebilir", ex.Message);
    }

    [Fact]
    public async Task SetMedia_clears_subtitle()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyWithVideoAsync(factory);
        await using var _h = host;
        await using var _g = guest;
        await host.Invoke("SetSubtitle", Vtt);
        await host.NextUpdate();
        await guest.NextUpdate();

        await host.Invoke("SetMedia", "file", "https://cdn.example.com/other.mp4");

        Assert.Equal(JsonValueKind.Null, (await guest.NextUpdate()).GetProperty("subtitleUrl").ValueKind);
    }

    [Fact]
    public async Task SetSubtitle_does_not_touch_position_or_timestamp()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyWithVideoAsync(factory);
        await using var _h = host;
        await using var _g = guest;
        await host.Invoke("Play", 42.5);
        var before = await host.NextUpdate();
        await guest.NextUpdate();
        await Task.Delay(50); // Now() değişseydi fark edilsin

        await host.Invoke("SetSubtitle", Vtt);
        var after = await guest.NextUpdate();

        Assert.Equal(before.GetProperty("positionSec").GetDouble(), after.GetProperty("positionSec").GetDouble());
        Assert.Equal(before.GetProperty("isPlaying").GetBoolean(), after.GetProperty("isPlaying").GetBoolean());
        Assert.True(after.GetProperty("isPlaying").GetBoolean());
        Assert.Equal(before.GetProperty("updatedAt").GetInt64(), after.GetProperty("updatedAt").GetInt64());
    }
}
