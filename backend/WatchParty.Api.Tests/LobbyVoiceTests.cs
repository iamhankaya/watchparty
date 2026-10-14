using WatchParty.Api.Lobbies;

namespace WatchParty.Api.Tests;

public class LobbyVoiceTests
{
    private static Lobby LobbyWith(int count)
    {
        var lobby = new Lobby("TEST22", "host");
        for (var i = 0; i < count; i++)
            lobby.TryJoin(new Participant($"c{i}", $"n{i}", $"u{i}"));
        return lobby;
    }

    [Fact]
    public void TryJoinVoice_adds_member_in_join_order()
    {
        var lobby = LobbyWith(3);

        Assert.Equal(VoiceJoinOutcome.Joined, lobby.TryJoinVoice("c2"));
        Assert.Equal(VoiceJoinOutcome.Joined, lobby.TryJoinVoice("c0"));

        Assert.Equal(
            [new VoiceMemberView("c2", "n2", false), new VoiceMemberView("c0", "n0", false)],
            lobby.VoiceMembers());
    }

    [Fact]
    public void TryJoinVoice_requires_participant()
    {
        var lobby = LobbyWith(1);

        Assert.Equal(VoiceJoinOutcome.NotInLobby, lobby.TryJoinVoice("yabanci"));
        Assert.Empty(lobby.VoiceMembers());
    }

    [Fact]
    public void TryJoinVoice_is_idempotent()
    {
        var lobby = LobbyWith(1);
        lobby.TryJoinVoice("c0");
        lobby.SetVoiceMuted("c0", true);

        Assert.Equal(VoiceJoinOutcome.AlreadyMember, lobby.TryJoinVoice("c0"));
        Assert.Equal([new VoiceMemberView("c0", "n0", true)], lobby.VoiceMembers());
    }

    [Fact]
    public void TryJoinVoice_returns_Full_at_MaxVoiceMembers()
    {
        var lobby = LobbyWith(Lobby.MaxVoiceMembers + 1);
        for (var i = 0; i < Lobby.MaxVoiceMembers; i++)
            Assert.Equal(VoiceJoinOutcome.Joined, lobby.TryJoinVoice($"c{i}"));

        Assert.Equal(VoiceJoinOutcome.Full, lobby.TryJoinVoice($"c{Lobby.MaxVoiceMembers}"));
        Assert.Equal(6, Lobby.MaxVoiceMembers);
        Assert.Equal(Lobby.MaxVoiceMembers, lobby.VoiceMembers().Length);
    }

    [Fact]
    public void LeaveVoice_returns_whether_member_was_removed()
    {
        var lobby = LobbyWith(2);
        lobby.TryJoinVoice("c0");

        Assert.True(lobby.LeaveVoice("c0"));
        Assert.False(lobby.LeaveVoice("c0"));
        Assert.False(lobby.LeaveVoice("c1"));
        Assert.Empty(lobby.VoiceMembers());
    }

    [Fact]
    public void SetVoiceMuted_only_for_members()
    {
        var lobby = LobbyWith(2);
        lobby.TryJoinVoice("c0");

        Assert.True(lobby.SetVoiceMuted("c0", true));
        Assert.False(lobby.SetVoiceMuted("c1", true));
        Assert.Equal([new VoiceMemberView("c0", "n0", true)], lobby.VoiceMembers());
    }

    [Fact]
    public void Leave_also_removes_voice_membership()
    {
        var lobby = LobbyWith(2);
        lobby.TryJoinVoice("c0");
        lobby.TryJoinVoice("c1");

        lobby.Leave("c0");

        Assert.Equal([new VoiceMemberView("c1", "n1", false)], lobby.VoiceMembers());
        Assert.False(lobby.IsVoiceMember("c0"));
        Assert.True(lobby.IsVoiceMember("c1"));
    }
}
