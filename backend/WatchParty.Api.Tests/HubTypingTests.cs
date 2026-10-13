using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR.Client;

namespace WatchParty.Api.Tests;

public class HubTypingTests
{
    private sealed record Typed(string ConnectionId, string Nickname);

    private static async Task<(HubConnection conn, string selfId, Channel<Typed> typed)> JoinAsync(
        WatchPartyFactory factory, string code, string clientId, string nickname)
    {
        var connection = await factory.ConnectAsync();
        var typed = Channel.CreateUnbounded<Typed>();
        connection.On<string, string>("UserTyping", (id, nick) => typed.Writer.TryWrite(new Typed(id, nick)));
        var join = await connection.InvokeAsync<System.Text.Json.JsonElement>("JoinLobby", code, nickname, clientId);
        return (connection, join.GetProperty("selfId").GetString()!, typed);
    }

    private static async Task<Typed> Next(Channel<Typed> ch) =>
        await ch.Reader.ReadAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);

    [Fact]
    public async Task Typing_forwards_to_others_with_server_nickname()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        var (host, hostId, _) = await JoinAsync(factory, code, "host", "Ayse");
        var (guest, _, guestTyped) = await JoinAsync(factory, code, "guest", "Mehmet");
        await using var _h = host;
        await using var _g = guest;

        await host.InvokeCoreAsync("Typing", []);

        var msg = await Next(guestTyped);
        Assert.Equal(hostId, msg.ConnectionId);
        Assert.Equal("Ayse", msg.Nickname);
    }

    [Fact]
    public async Task Typing_not_sent_to_caller()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        var (host, _, hostTyped) = await JoinAsync(factory, code, "host", "Ayse");
        var (guest, _, guestTyped) = await JoinAsync(factory, code, "guest", "Mehmet");
        await using var _h = host;
        await using var _g = guest;

        await host.InvokeCoreAsync("Typing", []);
        await Next(guestTyped); // yayın tamamlandı; çağırana gelmemeli
        await Task.Delay(200);

        Assert.False(hostTyped.Reader.TryPeek(out _));
    }

    [Fact]
    public async Task Typing_without_lobby_does_not_throw()
    {
        await using var factory = new WatchPartyFactory();
        await using var connection = await factory.ConnectAsync();

        await connection.InvokeCoreAsync("Typing", []);
    }
}
