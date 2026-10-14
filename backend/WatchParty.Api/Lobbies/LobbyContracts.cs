namespace WatchParty.Api.Lobbies;

public record CreateLobbyRequest(string ClientId, bool HostOnlyControl = false);

// Katılımcı listesinde herkese giden bilgi. ClientId bilerek yok: onu bilen kendini o kişi gibi tanıtabilir.
public record ParticipantView(string Id, string Nickname, bool IsHost);

public record JoinResult(string SelfId, bool IsHost);

// Sesli sohbet üyesi; Id katılımcı kimliğidir (bağlantı kimliği).
public record VoiceMemberView(string Id, string Nickname, bool Muted);

// Tarayıcının RTCIceServer biçimi. TURN eklenirse kullanıcı adı/şifre buradan gelir.
public record IceServerView(string[] Urls, string? Username, string? Credential);

public record VoiceJoinResult(VoiceMemberView[] Members, IceServerView[] IceServers);
