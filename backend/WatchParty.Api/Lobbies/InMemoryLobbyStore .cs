using System.Collections.Concurrent;

namespace WatchParty.Api.Lobbies;

public class InMemoryLobbyStore : ILobbyStore
{
    private readonly ConcurrentDictionary<string, Lobby> _lobbies = new();

    public Lobby Create(string hostClientId, bool hostOnlyControl)
{
    while (true)
    {
        var lobby = new Lobby
        {
            Code = LobbyCodeGenerator.Generate(),
            HostClientId = hostClientId,
            HostOnlyControl = hostOnlyControl
        };

        if (_lobbies.TryAdd(lobby.Code, lobby))
            return lobby;
        // kod doluysa döngü başa döner, yeni kod denenir
    }
}

    public Lobby? Get(string code)
    {
        _lobbies.TryGetValue(code, out var lobby);
        return lobby;
    }
}