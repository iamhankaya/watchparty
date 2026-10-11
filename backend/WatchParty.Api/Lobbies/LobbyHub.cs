using Microsoft.AspNetCore.SignalR;

namespace WatchParty.Api.Lobbies;

public class LobbyHub(ILobbyStore store) : Hub
{
    public async Task JoinLobby(string code, string nickname)
    {
        var lobby = store.Get(code);
        if (lobby is null)
            throw new HubException("Lobi bulunamadı");

        lobby.Participants[Context.ConnectionId] = new Participant(Context.ConnectionId, nickname);
        Context.Items["lobbyCode"] = lobby.Code;

        await Groups.AddToGroupAsync(Context.ConnectionId, lobby.Code);
        await Clients.Group(lobby.Code).SendAsync("ParticipantsChanged", NicknamesOf(lobby));
        await Clients.Caller.SendAsync("PlaybackUpdated", lobby.Playback);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var currentLobby = CurrentLobby();
        if (currentLobby is not null)
        {
            currentLobby.Participants.TryRemove(Context.ConnectionId, out _);
            await Clients.Group(currentLobby.Code).SendAsync("ParticipantsChanged", NicknamesOf(currentLobby));
        }

        await base.OnDisconnectedAsync(exception);
    }
    public Task SetMedia(string type, string id) =>
    Update(s => s with { MediaType = type, MediaId = id, IsPlaying = false, PositionSec = 0 });

public Task Play(double positionSec) => Update(s => s with { IsPlaying = true, PositionSec = positionSec });
public Task Pause(double positionSec) => Update(s => s with { IsPlaying = false, PositionSec = positionSec });
public Task Seek(double positionSec) => Update(s => s with { PositionSec = positionSec });

private async Task Update(Func<PlaybackState, PlaybackState> change)
{
    var lobby = CurrentLobby() ?? throw new HubException("Önce bir lobiye katıl");

    PlaybackState next;
    lock (lobby)
    {
        next = change(lobby.Playback) with { UpdatedAt = PlaybackState.Now() };
        lobby.Playback = next;
    }

    await Clients.Group(lobby.Code).SendAsync("PlaybackUpdated", next);
}

private Lobby? CurrentLobby() =>
    Context.Items.TryGetValue("lobbyCode", out var v) && v is string code ? store.Get(code) : null;
    private static string[] NicknamesOf(Lobby lobby) =>
        lobby.Participants.Values.Select(p => p.Nickname).ToArray();
}