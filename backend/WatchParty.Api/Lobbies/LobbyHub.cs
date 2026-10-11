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
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items.TryGetValue("lobbyCode", out var value)
            && value is string code
            && store.Get(code) is { } lobby)
        {
            lobby.Participants.TryRemove(Context.ConnectionId, out _);
            await Clients.Group(code).SendAsync("ParticipantsChanged", NicknamesOf(lobby));
        }

        await base.OnDisconnectedAsync(exception);
    }

    private static string[] NicknamesOf(Lobby lobby) =>
        lobby.Participants.Values.Select(p => p.Nickname).ToArray();
}