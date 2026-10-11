namespace WatchParty.Api.Lobbies;

public interface ILobbyStore
{
    Lobby Create(string hostClientId);
    Lobby? Get(string code);
}