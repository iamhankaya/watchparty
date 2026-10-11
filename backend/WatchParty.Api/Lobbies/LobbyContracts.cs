namespace WatchParty.Api.Lobbies;

public record CreateLobbyRequest(string ClientId, bool HostOnlyControl = false);