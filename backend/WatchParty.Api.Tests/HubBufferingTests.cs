using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace WatchParty.Api.Tests;

public class HubBufferingTests
{
    private const string Video = "https://cdn.example.com/film.mp4";

    private sealed class Client(HubConnection connection, string selfId, Channel<JsonElement> updates, Channel<string> ignored) : IAsyncDisposable
    {
        public HubConnection Connection { get; } = connection;
        public string SelfId { get; } = selfId;

        public Task Invoke(string method, params object?[] args) =>
            Connection.InvokeCoreAsync(method, args);

        /// <summary>Sıradaki PlaybackUpdated yayınını bekler.</summary>
        public async Task<JsonElement> NextUpdate() =>
            await updates.Reader.ReadAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);

        public async Task<string> NextIgnored() =>
            await ignored.Reader.ReadAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);

        public bool HasPendingUpdate => updates.Reader.TryPeek(out _);
        public bool HasPendingIgnored => ignored.Reader.TryPeek(out _);

        public ValueTask DisposeAsync() => Connection.DisposeAsync();
    }

    private static async Task<Client> JoinAsync(WatchPartyFactory factory, string code, string clientId)
    {
        var connection = await factory.ConnectAsync();
        var updates = Channel.CreateUnbounded<JsonElement>();
        var ignored = Channel.CreateUnbounded<string>();
        connection.On<JsonElement>("PlaybackUpdated", s => updates.Writer.TryWrite(s));
        connection.On<string>("BufferingIgnored", n => ignored.Writer.TryWrite(n));
        var join = await connection.InvokeAsync<JsonElement>("JoinLobby", code, clientId, clientId);
        var client = new Client(connection, join.GetProperty("selfId").GetString()!, updates, ignored);
        await client.NextUpdate(); // JoinLobby sonrası ilk durum
        return client;
    }

    private static async Task<(Client host, Client guest)> LobbyAsync(WatchPartyFactory factory, bool hostOnly = false, bool playing = true)
    {
        var code = await factory.CreateLobbyAsync("host", hostOnly);
        var host = await JoinAsync(factory, code, "host");
        var guest = await JoinAsync(factory, code, "guest");
        await host.Invoke("SetMedia", "file", Video);
        await host.NextUpdate();
        await guest.NextUpdate();
        if (playing)
        {
            await host.Invoke("Play", 30.0);
            await host.NextUpdate();
            await guest.NextUpdate();
        }
        return (host, guest);
    }

    private static string[] WaitingFor(JsonElement state) =>
        state.GetProperty("waitingFor").EnumerateArray().Select(e => e.GetString()!).ToArray();

    [Fact]
    public async Task ReportBuffering_freezes_and_broadcasts_waitingFor()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyAsync(factory);
        await using var _h = host;
        await using var _g = guest;
        await Task.Delay(200);

        await guest.Invoke("ReportBuffering", true);

        var frozen = await host.NextUpdate();
        Assert.Equal([guest.SelfId], WaitingFor(frozen));
        Assert.True(frozen.GetProperty("isPlaying").GetBoolean());
        Assert.True(frozen.GetProperty("positionSec").GetDouble() > 30.1);
        Assert.Equal([guest.SelfId], WaitingFor(await guest.NextUpdate()));

        await Task.Delay(50);
        await guest.Invoke("ReportBuffering", false);

        var resumed = await host.NextUpdate();
        Assert.Empty(WaitingFor(resumed));
        Assert.Equal(frozen.GetProperty("positionSec").GetDouble(), resumed.GetProperty("positionSec").GetDouble());
        Assert.True(resumed.GetProperty("updatedAt").GetInt64() > frozen.GetProperty("updatedAt").GetInt64());
    }

    [Fact]
    public async Task PlaybackUpdated_always_has_waitingFor_array()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyAsync(factory, playing: false);
        await using var _h = host;
        await using var _g = guest;

        await host.Invoke("Seek", 5.0);

        var state = await guest.NextUpdate();
        Assert.Equal(JsonValueKind.Array, state.GetProperty("waitingFor").ValueKind);
        Assert.Empty(WaitingFor(state));
    }

    [Fact]
    public async Task ReportBuffering_ignored_when_paused()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyAsync(factory, playing: false);
        await using var _h = host;
        await using var _g = guest;

        await guest.Invoke("ReportBuffering", true);
        await host.Invoke("Seek", 7.0);

        var next = await host.NextUpdate();
        Assert.Equal(7.0, next.GetProperty("positionSec").GetDouble());
        Assert.Empty(WaitingFor(next));
    }

    [Fact]
    public async Task ReportBuffering_ignored_without_media_or_lobby()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var host = await JoinAsync(factory, code, "host");

        await host.Invoke("ReportBuffering", true); // hata fırlatmaz
        await host.Invoke("ReportBuffering", false);
        await host.Invoke("SetMedia", "file", Video);

        Assert.Empty(WaitingFor(await host.NextUpdate()));

        await using var outsider = await factory.ConnectAsync();
        await outsider.InvokeCoreAsync("ReportBuffering", [true]); // lobi yok: sessizce yok sayılır
    }

    [Theory]
    [InlineData("Play")]
    [InlineData("Pause")]
    [InlineData("Seek")]
    [InlineData("SetMedia")]
    [InlineData("SkipWaiting")]
    public async Task Commands_clear_waiting(string method)
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyAsync(factory);
        await using var _h = host;
        await using var _g = guest;
        await guest.Invoke("ReportBuffering", true);
        await host.NextUpdate();

        object?[] args = method switch
        {
            "SetMedia" => ["file", "https://cdn.example.com/other.mp4"],
            "SkipWaiting" => [],
            _ => [12.0],
        };
        await host.Invoke(method, args);

        Assert.Empty(WaitingFor(await host.NextUpdate()));

        // Kayıt da temizlendi: aynı kişi yeniden bildirirse tekrar eklenir (oynuyorsa).
        if (method is "Play" or "Seek" or "SkipWaiting")
        {
            await guest.Invoke("ReportBuffering", true);
            Assert.Equal([guest.SelfId], WaitingFor(await host.NextUpdate()));
        }
    }

    [Fact]
    public async Task SkipWaiting_with_empty_list_is_ignored()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyAsync(factory);
        await using var _h = host;
        await using var _g = guest;

        await host.Invoke("SkipWaiting");
        await host.Invoke("Seek", 3.0);

        Assert.Equal(3.0, (await host.NextUpdate()).GetProperty("positionSec").GetDouble());
    }

    [Fact]
    public async Task HostOnly_rejects_non_host_SkipWaiting_but_accepts_ReportBuffering()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyAsync(factory, hostOnly: true);
        await using var _h = host;
        await using var _g = guest;

        await guest.Invoke("ReportBuffering", true);
        Assert.Equal([guest.SelfId], WaitingFor(await host.NextUpdate()));

        var ex = await Assert.ThrowsAsync<HubException>(() => guest.Invoke("SkipWaiting"));
        Assert.Contains("Sadece host kontrol edebilir", ex.Message);

        await host.Invoke("SkipWaiting");
        Assert.Empty(WaitingFor(await host.NextUpdate()));
    }

    [Fact]
    public async Task Disconnect_removes_from_waiting()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyAsync(factory);
        await using var _h = host;
        await guest.Invoke("ReportBuffering", true);
        Assert.Equal([guest.SelfId], WaitingFor(await host.NextUpdate()));

        await guest.DisposeAsync();

        Assert.Empty(WaitingFor(await host.NextUpdate()));
    }

    [Fact]
    public async Task Fourth_buffering_is_ignored_and_BufferingIgnored_sent_once()
    {
        await using var factory = new WatchPartyFactory();
        var (host, guest) = await LobbyAsync(factory);
        await using var _h = host;
        await using var _g = guest;

        for (var i = 0; i < 3; i++)
        {
            await guest.Invoke("ReportBuffering", true);
            Assert.NotEmpty(WaitingFor(await host.NextUpdate()));
            await guest.Invoke("ReportBuffering", false);
            Assert.Empty(WaitingFor(await host.NextUpdate()));
        }

        await guest.Invoke("ReportBuffering", true);
        Assert.Equal("guest", await host.NextIgnored());
        Assert.Equal("guest", await guest.NextIgnored());

        await guest.Invoke("ReportBuffering", true);
        await host.Invoke("Seek", 4.0);
        var next = await host.NextUpdate();
        Assert.Equal(4.0, next.GetProperty("positionSec").GetDouble());
        Assert.Empty(WaitingFor(next));
        Assert.False(host.HasPendingIgnored);
    }
}
