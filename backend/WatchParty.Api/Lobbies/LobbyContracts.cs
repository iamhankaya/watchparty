namespace WatchParty.Api.Lobbies;

public record CreateLobbyRequest(string ClientId, bool HostOnlyControl = false);

// Katılımcı listesinde herkese giden bilgi. ClientId bilerek yok: onu bilen kendini o kişi gibi tanıtabilir.
public record ParticipantView(string Id, string Nickname, bool IsHost);

public record JoinResult(string SelfId, bool IsHost);
