using WatchParty.Api.Lobbies;

namespace WatchParty.Api.Tests;

// Bekleme kayıtlarının saat parametreli birim testleri.
public class LobbyWaitingTests
{
    private static readonly DateTimeOffset T0 = DateTimeOffset.FromUnixTimeMilliseconds(1_000_000_000);

    private static Lobby PlayingLobby(double positionSec = 10)
    {
        var lobby = new Lobby("TEST22", "host");
        lobby.TryJoin(new Participant("c1", "Ali", "u1"));
        lobby.TryJoin(new Participant("c2", "Veli", "u2"));
        lobby.TryJoin(new Participant("c3", "Ayşe", "u3"));
        lobby.Playback = new PlaybackState("file", "https://cdn.example.com/a.mp4", true, positionSec, T0.ToUnixTimeMilliseconds());
        return lobby;
    }

    [Fact]
    public void PlaybackState_WaitingFor_defaults_to_empty()
    {
        Assert.Empty(PlaybackState.Empty.WaitingFor);
        Assert.Empty(new PlaybackState("file", "x", true, 0, 0).WaitingFor);
        Assert.Empty((PlaybackState.Empty with { PositionSec = 3 }).WaitingFor);
    }

    [Fact]
    public void StartWaiting_freezes_position()
    {
        var lobby = PlayingLobby(10);
        var now = T0.AddSeconds(2.5);

        var result = lobby.StartWaiting("c1", "u1", now);

        Assert.Equal(StartWaitingOutcome.Started, result.Outcome);
        Assert.Equal(12.5, result.Playback.PositionSec, 3);
        Assert.Equal(now.ToUnixTimeMilliseconds(), result.Playback.UpdatedAt);
        Assert.Equal(["c1"], result.Playback.WaitingFor);
        Assert.True(result.Playback.IsPlaying);
        Assert.Same(result.Playback, lobby.Playback);
    }

    [Fact]
    public void StartWaiting_second_waiter_does_not_recompute_position()
    {
        var lobby = PlayingLobby(10);
        lobby.StartWaiting("c1", "u1", T0.AddSeconds(2));

        var result = lobby.StartWaiting("c2", "u2", T0.AddSeconds(5));

        Assert.Equal(StartWaitingOutcome.Started, result.Outcome);
        Assert.Equal(12, result.Playback.PositionSec, 3);
        Assert.Equal(T0.AddSeconds(2).ToUnixTimeMilliseconds(), result.Playback.UpdatedAt);
        Assert.Equal(["c1", "c2"], result.Playback.WaitingFor);
    }

    [Fact]
    public void StartWaiting_already_waiting_is_unchanged()
    {
        var lobby = PlayingLobby();
        lobby.StartWaiting("c1", "u1", T0.AddSeconds(1));

        var result = lobby.StartWaiting("c1", "u1", T0.AddSeconds(2));

        Assert.Equal(StartWaitingOutcome.Unchanged, result.Outcome);
        Assert.Equal(["c1"], lobby.Playback.WaitingFor);
    }

    [Fact]
    public void StartWaiting_ignored_when_not_playing_or_no_media()
    {
        var paused = PlayingLobby();
        paused.Playback = paused.Playback with { IsPlaying = false };
        Assert.Equal(StartWaitingOutcome.Unchanged, paused.StartWaiting("c1", "u1", T0).Outcome);
        Assert.Empty(paused.Playback.WaitingFor);

        var empty = new Lobby("TEST22", "host");
        empty.TryJoin(new Participant("c1", "Ali", "u1"));
        Assert.Equal(StartWaitingOutcome.Unchanged, empty.StartWaiting("c1", "u1", T0).Outcome);
        Assert.Empty(empty.Playback.WaitingFor);
    }

    [Fact]
    public void StopWaiting_last_waiter_resumes_with_same_position_and_new_timestamp()
    {
        var lobby = PlayingLobby(10);
        lobby.StartWaiting("c1", "u1", T0.AddSeconds(2));
        lobby.StartWaiting("c2", "u2", T0.AddSeconds(3));

        var afterFirst = lobby.StopWaiting("c1", T0.AddSeconds(4));
        Assert.NotNull(afterFirst);
        Assert.Equal(["c2"], afterFirst.WaitingFor);
        Assert.Equal(T0.AddSeconds(2).ToUnixTimeMilliseconds(), afterFirst.UpdatedAt);

        var afterLast = lobby.StopWaiting("c2", T0.AddSeconds(6));
        Assert.NotNull(afterLast);
        Assert.Empty(afterLast.WaitingFor);
        Assert.Equal(12, afterLast.PositionSec, 3);
        Assert.Equal(T0.AddSeconds(6).ToUnixTimeMilliseconds(), afterLast.UpdatedAt);
        Assert.True(afterLast.IsPlaying);
    }

    [Fact]
    public void StopWaiting_not_waiting_returns_null()
    {
        var lobby = PlayingLobby();
        var before = lobby.Playback;

        Assert.Null(lobby.StopWaiting("c1", T0.AddSeconds(1)));
        Assert.Same(before, lobby.Playback);
    }

    [Fact]
    public void ClearWaiting_empties_list_and_resumes()
    {
        var lobby = PlayingLobby(10);
        lobby.StartWaiting("c1", "u1", T0.AddSeconds(1));
        lobby.StartWaiting("c2", "u2", T0.AddSeconds(2));

        var result = lobby.ClearWaiting(T0.AddSeconds(5));

        Assert.NotNull(result);
        Assert.Empty(result.WaitingFor);
        Assert.Equal(11, result.PositionSec, 3);
        Assert.Equal(T0.AddSeconds(5).ToUnixTimeMilliseconds(), result.UpdatedAt);
        // Aktif kayıtlar da temizlendi: tekrar başlayabilir.
        Assert.Null(lobby.StopWaiting("c1", T0.AddSeconds(6)));
    }

    [Fact]
    public void ClearWaiting_empty_list_returns_null()
    {
        var lobby = PlayingLobby();
        Assert.Null(lobby.ClearWaiting(T0.AddSeconds(1)));
    }

    [Fact]
    public void ExpireWaits_removes_after_MaxWait()
    {
        var lobby = PlayingLobby(10);
        lobby.StartWaiting("c1", "u1", T0);
        lobby.StartWaiting("c2", "u2", T0.AddSeconds(4));

        Assert.Null(lobby.ExpireWaits(T0 + Lobby.MaxWait - TimeSpan.FromMilliseconds(1)));

        var first = lobby.ExpireWaits(T0 + Lobby.MaxWait);
        Assert.NotNull(first);
        Assert.Equal(["c2"], first.WaitingFor);

        var second = lobby.ExpireWaits(T0.AddSeconds(4) + Lobby.MaxWait);
        Assert.NotNull(second);
        Assert.Empty(second.WaitingFor);
        Assert.Equal(10, second.PositionSec, 3);
        Assert.Equal((T0.AddSeconds(4) + Lobby.MaxWait).ToUnixTimeMilliseconds(), second.UpdatedAt);
    }

    [Fact]
    public void Fourth_wait_in_window_is_ignored_and_reported_once()
    {
        var lobby = PlayingLobby();
        var t = T0;
        for (var i = 0; i < Lobby.MaxStrikes; i++)
        {
            Assert.Equal(StartWaitingOutcome.Started, lobby.StartWaiting("c1", "u1", t).Outcome);
            lobby.StopWaiting("c1", t.AddSeconds(1));
            t = t.AddSeconds(10);
        }

        Assert.Equal(StartWaitingOutcome.IgnoredFirstTime, lobby.StartWaiting("c1", "u1", t).Outcome);
        Assert.Empty(lobby.Playback.WaitingFor);
        Assert.Equal(StartWaitingOutcome.Ignored, lobby.StartWaiting("c1", "u1", t.AddSeconds(5)).Outcome);

        // Başka kişi etkilenmez.
        Assert.Equal(StartWaitingOutcome.Started, lobby.StartWaiting("c2", "u2", t.AddSeconds(6)).Outcome);
    }

    [Fact]
    public void Strikes_are_per_client_across_connections()
    {
        var lobby = PlayingLobby();
        lobby.TryJoin(new Participant("c1b", "Ali", "u1"));
        var t = T0;
        for (var i = 0; i < Lobby.MaxStrikes; i++)
        {
            lobby.StartWaiting(i % 2 == 0 ? "c1" : "c1b", "u1", t);
            lobby.ClearWaiting(t.AddSeconds(1));
            t = t.AddSeconds(10);
        }

        Assert.Equal(StartWaitingOutcome.IgnoredFirstTime, lobby.StartWaiting("c1b", "u1", t).Outcome);
    }

    [Fact]
    public void Strikes_expire_after_StrikeWindow()
    {
        var lobby = PlayingLobby();
        for (var i = 0; i < Lobby.MaxStrikes; i++)
        {
            lobby.StartWaiting("c1", "u1", T0.AddSeconds(i));
            lobby.StopWaiting("c1", T0.AddSeconds(i + 0.5));
        }
        Assert.Equal(StartWaitingOutcome.IgnoredFirstTime, lobby.StartWaiting("c1", "u1", T0.AddSeconds(10)).Outcome);

        // İlk başlangıç pencereden çıkınca tekrar beklenir.
        Assert.Equal(StartWaitingOutcome.Started, lobby.StartWaiting("c1", "u1", T0 + Lobby.StrikeWindow).Outcome);
        lobby.StopWaiting("c1", T0 + Lobby.StrikeWindow + TimeSpan.FromSeconds(0.2));

        // Yeni pencerede tekrar dolarsa bildirim yine bir kez yapılır.
        Assert.Equal(StartWaitingOutcome.IgnoredFirstTime, lobby.StartWaiting("c1", "u1", T0 + Lobby.StrikeWindow + TimeSpan.FromSeconds(0.5)).Outcome);
    }
}
