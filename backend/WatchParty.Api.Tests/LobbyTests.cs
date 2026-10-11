using WatchParty.Api.Lobbies;

namespace WatchParty.Api.Tests;

public class LobbyTests
{
    private static Participant P(string conn, string client) => new(conn, conn, client);

    private static Lobby NewLobby() => new() { Code = "TEST22", HostClientId = "host" };

    [Fact]
    public void TryJoin_returns_Full_at_MaxParticipants()
    {
        var lobby = NewLobby();
        for (var i = 0; i < Lobby.MaxParticipants; i++)
            Assert.Equal(JoinOutcome.Joined, lobby.TryJoin(P($"c{i}", $"u{i}")));

        Assert.Equal(JoinOutcome.Full, lobby.TryJoin(P("extra", "uExtra")));
        Assert.Equal(Lobby.MaxParticipants, lobby.Participants.Count);
    }

    [Fact]
    public void TryJoin_returns_Closed_after_TryClose()
    {
        var lobby = NewLobby();

        Assert.True(lobby.TryClose(DateTimeOffset.UtcNow.AddMinutes(1)));
        Assert.Equal(JoinOutcome.Closed, lobby.TryJoin(P("c1", "u1")));
        Assert.Empty(lobby.Participants);
    }

    [Fact]
    public void TryClose_false_when_participants_present()
    {
        var lobby = NewLobby();
        lobby.TryJoin(P("c1", "u1"));

        Assert.False(lobby.TryClose(DateTimeOffset.UtcNow.AddMinutes(1)));
        Assert.False(lobby.IsClosed);
    }

    [Fact]
    public void Leave_last_participant_sets_EmptySince()
    {
        var lobby = NewLobby();
        lobby.TryJoin(P("c1", "u1"));
        Assert.Null(lobby.EmptySince);

        var left = lobby.Leave("c1");

        Assert.NotNull(lobby.EmptySince);
        Assert.Equal("c1", left?.ConnectionId);
    }

    [Fact]
    public void Leave_host_with_other_host_tab_keeps_HostAwaySince_null()
    {
        var lobby = NewLobby();
        lobby.TryJoin(P("h1", "host"));
        lobby.TryJoin(P("h2", "host"));

        lobby.Leave("h1");
        Assert.Null(lobby.HostAwaySince);

        lobby.Leave("h2");
        Assert.NotNull(lobby.HostAwaySince);
    }

    [Fact]
    public void TryJoin_by_host_clears_HostAwaySince()
    {
        var lobby = NewLobby();
        lobby.TryJoin(P("h1", "host"));
        lobby.Leave("h1");
        Assert.NotNull(lobby.HostAwaySince);

        lobby.TryJoin(P("h2", "host"));

        Assert.Null(lobby.HostAwaySince);
    }

    [Fact]
    public void TryTransferHost_null_within_grace()
    {
        var lobby = NewLobby();
        lobby.TryJoin(P("h1", "host"));
        lobby.TryJoin(P("a1", "a"));
        lobby.Leave("h1");

        Assert.Null(lobby.TryTransferHost(DateTimeOffset.UtcNow, TimeSpan.FromSeconds(10)));
        Assert.Equal("host", lobby.HostClientId);
    }

    [Fact]
    public void TryTransferHost_picks_oldest_after_grace()
    {
        var lobby = NewLobby();
        lobby.TryJoin(P("h1", "host"));
        var a = P("a1", "a");
        lobby.TryJoin(a);
        lobby.TryJoin(P("b1", "b"));
        lobby.Leave("h1");

        var next = lobby.TryTransferHost(DateTimeOffset.UtcNow.AddSeconds(11), TimeSpan.FromSeconds(10));

        Assert.Equal(a, next);
        Assert.Equal(a.ClientId, lobby.HostClientId);
        Assert.Null(lobby.HostAwaySince);
    }

    [Fact]
    public void RemoveExpired_closes_lobby_and_removes_from_store()
    {
        var store = new InMemoryLobbyStore();
        var lobby = store.Create("host", false);

        Assert.Equal(1, store.RemoveExpired(DateTimeOffset.UtcNow.AddMinutes(1)));
        Assert.Null(store.Get(lobby.Code));
        Assert.True(lobby.IsClosed);
    }
}
