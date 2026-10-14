using Microsoft.AspNetCore.SignalR;

namespace WatchParty.Api.Lobbies;

// Hem hub'ın hem arka plan servisinin gönderdiği ortak mesajlar.
public static class LobbyEvents
{
    public static ParticipantView[] ParticipantsOf(Lobby lobby) =>
        lobby.Participants.Values
            .OrderBy(p => p.JoinedAt)
            .Select(p => new ParticipantView(p.ConnectionId, p.Nickname, p.ClientId == lobby.HostClientId))
            .ToArray();

    public static Task SendParticipants(IHubClients<IClientProxy> clients, Lobby lobby) =>
        clients.Group(lobby.Code).SendAsync("ParticipantsChanged", ParticipantsOf(lobby));

    public static Task SendVoiceMembers(IHubClients<IClientProxy> clients, Lobby lobby) =>
        clients.Group(lobby.Code).SendAsync("VoiceMembersChanged", lobby.VoiceMembers());
}
