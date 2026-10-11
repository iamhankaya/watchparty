using Microsoft.AspNetCore.SignalR;

namespace WatchParty.Api.Lobbies;

public class LobbyHub(ILobbyStore store) : Hub
{
    public async Task JoinLobby(string code, string nickname)
    {
        var lobby = store.Get(code);
        if (lobby is null)
            throw new HubException("Lobi bulunamadı");

        await Groups.AddToGroupAsync(Context.ConnectionId, lobby.Code);
        await Clients.Group(lobby.Code).SendAsync("UserJoined", nickname);
    }
}