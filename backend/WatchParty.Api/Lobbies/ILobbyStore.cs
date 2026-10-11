namespace WatchParty.Api.Lobbies;

public interface ILobbyStore
{
    Lobby Create(string hostClientId, bool hostOnlyControl);
    Lobby? Get(string code);
    IEnumerable<Lobby> All();
    int RemoveExpired(DateTimeOffset cutoff);
}
