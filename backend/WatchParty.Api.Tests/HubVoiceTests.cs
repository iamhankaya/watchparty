using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Options;

namespace WatchParty.Api.Tests;

public class HubVoiceTests
{
    private sealed record Signal(string FromId, string Kind, string Payload);

    private sealed class Client(HubConnection connection, string selfId, Channel<JsonElement> members, Channel<Signal> signals) : IAsyncDisposable
    {
        public HubConnection Connection { get; } = connection;
        public string SelfId { get; } = selfId;

        public Task Invoke(string method, params object?[] args) => Connection.InvokeCoreAsync(method, args);

        public Task<JsonElement> JoinVoice() => Connection.InvokeAsync<JsonElement>("JoinVoice");

        /// <summary>Sıradaki VoiceMembersChanged yayınını bekler.</summary>
        public async Task<JsonElement> NextMembers() =>
            await members.Reader.ReadAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);

        public async Task<Signal> NextSignal() =>
            await signals.Reader.ReadAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);

        public bool HasPendingMembers => members.Reader.TryPeek(out _);
        public bool HasPendingSignal => signals.Reader.TryPeek(out _);

        public ValueTask DisposeAsync() => Connection.DisposeAsync();
    }

    private static async Task<Client> ConnectAsync(WatchPartyFactory factory)
    {
        var connection = await factory.ConnectAsync();
        var members = Channel.CreateUnbounded<JsonElement>();
        var signals = Channel.CreateUnbounded<Signal>();
        connection.On<JsonElement>("VoiceMembersChanged", m => members.Writer.TryWrite(m));
        connection.On<string, string, string>("VoiceSignal", (from, kind, payload) => signals.Writer.TryWrite(new Signal(from, kind, payload)));
        return new Client(connection, connection.ConnectionId!, members, signals);
    }

    private static async Task<Client> JoinAsync(WatchPartyFactory factory, string code, string clientId)
    {
        var client = await ConnectAsync(factory);
        var join = await client.Connection.InvokeAsync<JsonElement>("JoinLobby", code, clientId, clientId);
        Assert.Equal(client.SelfId, join.GetProperty("selfId").GetString());
        return client;
    }

    private static string[] Ids(JsonElement members) =>
        members.EnumerateArray().Select(m => m.GetProperty("id").GetString()!).ToArray();

    // Sessizce düşen bir şeyin gelmediğini görmek için önce gelen bir mesajı bekleyip biraz daha bekler.
    private static Task Settle() => Task.Delay(200);

    [Fact]
    public async Task JoinVoice_returns_members_and_ice_servers_and_broadcasts()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");
        await using var b = await JoinAsync(factory, code, "Mehmet");

        var result = await a.JoinVoice();

        var member = Assert.Single(result.GetProperty("members").EnumerateArray());
        Assert.Equal(a.SelfId, member.GetProperty("id").GetString());
        Assert.Equal("Ayse", member.GetProperty("nickname").GetString());
        Assert.False(member.GetProperty("muted").GetBoolean());

        var ice = Assert.Single(result.GetProperty("iceServers").EnumerateArray());
        Assert.Equal(["stun:stun.l.google.com:19302"], ice.GetProperty("urls").EnumerateArray().Select(u => u.GetString()));

        // Sesli sohbette olmayan lobi üyesi de listeyi alır.
        Assert.Equal([a.SelfId], Ids(await b.NextMembers()));
        Assert.Equal([a.SelfId], Ids(await a.NextMembers()));

        var second = await b.JoinVoice();
        Assert.Equal([a.SelfId, b.SelfId], Ids(second.GetProperty("members")));
        Assert.Equal([a.SelfId, b.SelfId], Ids(await a.NextMembers()));
    }

    [Fact]
    public async Task JoinVoice_without_lobby_throws()
    {
        await using var factory = new WatchPartyFactory();
        await using var client = await ConnectAsync(factory);

        var ex = await Assert.ThrowsAsync<HubException>(() => client.JoinVoice());

        Assert.Contains("Önce bir lobiye katıl", ex.Message);
    }

    [Fact]
    public async Task JoinVoice_seventh_member_is_rejected()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        var clients = new List<Client>();
        try
        {
            for (var i = 0; i < 7; i++)
                clients.Add(await JoinAsync(factory, code, $"u{i}"));
            for (var i = 0; i < 6; i++)
                await clients[i].JoinVoice();

            var ex = await Assert.ThrowsAsync<HubException>(() => clients[6].JoinVoice());

            Assert.Contains("Sesli sohbet dolu", ex.Message);
        }
        finally
        {
            foreach (var c in clients)
                await c.DisposeAsync();
        }
    }

    [Fact]
    public async Task JoinVoice_twice_is_idempotent()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");

        var first = await a.JoinVoice();
        var second = await a.JoinVoice();

        Assert.Equal(first.GetRawText(), second.GetRawText());
        Assert.Single(second.GetProperty("members").EnumerateArray());
    }

    [Fact]
    public async Task LeaveVoice_broadcasts_and_is_silent_for_non_member()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");
        await using var b = await JoinAsync(factory, code, "Mehmet");
        await a.JoinVoice();
        await b.JoinVoice();
        await a.NextMembers();
        await a.NextMembers();

        await b.Invoke("LeaveVoice");
        Assert.Equal([a.SelfId], Ids(await a.NextMembers()));

        // Artık üye değil: hata yok, yayın yok.
        await b.Invoke("LeaveVoice");
        await Settle();
        Assert.False(a.HasPendingMembers);
    }

    [Fact]
    public async Task SetVoiceMuted_broadcasts_and_is_silent_for_non_member()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");
        await using var b = await JoinAsync(factory, code, "Mehmet");
        await a.JoinVoice();
        await b.NextMembers();

        await a.Invoke("SetVoiceMuted", true);
        var members = await b.NextMembers();
        Assert.True(Assert.Single(members.EnumerateArray()).GetProperty("muted").GetBoolean());

        await b.Invoke("SetVoiceMuted", true);
        await Settle();
        Assert.False(b.HasPendingMembers);
    }

    [Fact]
    public async Task VoiceSignal_is_forwarded_between_members()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");
        await using var b = await JoinAsync(factory, code, "Mehmet");
        await a.JoinVoice();
        await b.JoinVoice();

        await a.Invoke("VoiceSignal", b.SelfId, "offer", "{\"sdp\":\"x\"}");

        Assert.Equal(new Signal(a.SelfId, "offer", "{\"sdp\":\"x\"}"), await b.NextSignal());
        Assert.False(a.HasPendingSignal);
    }

    [Fact]
    public async Task VoiceSignal_to_or_from_non_member_is_dropped()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");
        await using var b = await JoinAsync(factory, code, "Mehmet");
        await using var c = await JoinAsync(factory, code, "Can");
        await a.JoinVoice();
        await b.JoinVoice();

        // Üye olmayana gitmez, üye olmayandan gelmez; hata da yok.
        await a.Invoke("VoiceSignal", c.SelfId, "offer", "x");
        await c.Invoke("VoiceSignal", a.SelfId, "offer", "x");
        await a.Invoke("VoiceSignal", b.SelfId, "candidate", "y");

        Assert.Equal("y", (await b.NextSignal()).Payload);
        await Settle();
        Assert.False(a.HasPendingSignal);
        Assert.False(c.HasPendingSignal);
    }

    [Fact]
    public async Task VoiceSignal_to_member_of_other_lobby_is_dropped()
    {
        await using var factory = new WatchPartyFactory();
        var code1 = await factory.CreateLobbyAsync("host1");
        var code2 = await factory.CreateLobbyAsync("host2");
        await using var a = await JoinAsync(factory, code1, "Ayse");
        await using var a2 = await JoinAsync(factory, code1, "Ali");
        await using var b = await JoinAsync(factory, code2, "Mehmet");
        await a.JoinVoice();
        await a2.JoinVoice();
        await b.JoinVoice();

        await a.Invoke("VoiceSignal", b.SelfId, "offer", "x");
        await a.Invoke("VoiceSignal", a2.SelfId, "offer", "z");

        Assert.Equal("z", (await a2.NextSignal()).Payload);
        await Settle();
        Assert.False(b.HasPendingSignal);
    }

    [Theory]
    [InlineData("bye")]
    [InlineData("")]
    [InlineData("Offer")]
    public async Task VoiceSignal_invalid_kind_throws(string kind)
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");
        await using var b = await JoinAsync(factory, code, "Mehmet");
        await a.JoinVoice();
        await b.JoinVoice();

        var ex = await Assert.ThrowsAsync<HubException>(() => a.Invoke("VoiceSignal", b.SelfId, kind, "x"));

        Assert.Contains("Geçersiz ses sinyali", ex.Message);
    }

    [Fact]
    public async Task VoiceSignal_payload_too_large_throws()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");
        await using var b = await JoinAsync(factory, code, "Mehmet");
        await a.JoinVoice();
        await b.JoinVoice();

        // Sınırdaki değer geçer.
        await a.Invoke("VoiceSignal", b.SelfId, "offer", new string('x', 16384));
        Assert.Equal(16384, (await b.NextSignal()).Payload.Length);

        var ex = await Assert.ThrowsAsync<HubException>(() => a.Invoke("VoiceSignal", b.SelfId, "offer", new string('x', 16385)));
        Assert.Contains("Ses sinyali çok büyük", ex.Message);
    }

    [Fact]
    public async Task Disconnect_removes_voice_member_and_broadcasts()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");
        var b = await JoinAsync(factory, code, "Mehmet");
        await a.JoinVoice();
        await b.JoinVoice();
        await a.NextMembers();
        await a.NextMembers();

        await b.Connection.StopAsync();
        await b.DisposeAsync();

        Assert.Equal([a.SelfId], Ids(await a.NextMembers()));
    }

    [Fact]
    public async Task Disconnect_of_non_voice_member_does_not_broadcast()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");
        var b = await JoinAsync(factory, code, "Mehmet");
        await a.JoinVoice();
        await a.NextMembers();

        await b.Connection.StopAsync();
        await b.DisposeAsync();
        await Settle();

        Assert.False(a.HasPendingMembers);
    }

    [Fact]
    public async Task Voice_ice_servers_come_from_configuration()
    {
        await using var factory = new WatchPartyFactory(new()
        {
            ["Voice:IceServers:0:Urls:0"] = "turn:turn.example.com:3478",
            ["Voice:IceServers:0:Username"] = "kullanici",
            ["Voice:IceServers:0:Credential"] = "sifre",
        });
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");

        var result = await a.JoinVoice();

        var ice = Assert.Single(result.GetProperty("iceServers").EnumerateArray());
        Assert.Equal(["turn:turn.example.com:3478"], ice.GetProperty("urls").EnumerateArray().Select(u => u.GetString()));
        Assert.Equal("kullanici", ice.GetProperty("username").GetString());
        Assert.Equal("sifre", ice.GetProperty("credential").GetString());
    }

    [Theory]
    [InlineData("http://example.com")]
    [InlineData("")]
    public void Voice_invalid_ice_url_stops_startup(string url)
    {
        using var factory = new WatchPartyFactory(new() { ["Voice:IceServers:0:Urls:0"] = url });

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.NotNull(FindOptionsValidationException(exception));
    }

    [Fact]
    public async Task Voice_methods_use_their_own_rate_limit_bucket()
    {
        await using var factory = new WatchPartyFactory(new()
        {
            ["Security:VoiceBurst"] = "2",
            ["Security:VoicePerSecond"] = "1",
        });
        var code = await factory.CreateLobbyAsync("host");
        await using var a = await JoinAsync(factory, code, "Ayse");

        HubException? rejection = null;
        for (var i = 0; i < 10 && rejection is null; i++)
        {
            try { await a.Invoke("SetVoiceMuted", true); }
            catch (HubException ex) { rejection = ex; }
        }

        Assert.NotNull(rejection);
        Assert.Contains("Çok hızlı", rejection.Message);
        // Diğer kovalar etkilenmez.
        await a.Invoke("SendChat", "merhaba");
        await a.Invoke("Typing");
    }

    [Fact]
    public void Voice_zero_limit_stops_startup()
    {
        using var factory = new WatchPartyFactory(new() { ["Security:VoiceBurst"] = "0" });

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.NotNull(FindOptionsValidationException(exception));
    }

    private static OptionsValidationException? FindOptionsValidationException(Exception? exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
            if (current is OptionsValidationException validation)
                return validation;
        return null;
    }
}
