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
        _lobbies.TryGetValue(code.ToUpperInvariant(), out var lobby);
        return lobby;
    }

    public IEnumerable<Lobby> All() => _lobbies.Values;

    public int RemoveExpired(DateTimeOffset cutoff)
    {
        var removed = 0;
        foreach (var (code, lobby) in _lobbies)
        {
            if (lobby.EmptySince is { } since && since < cutoff && _lobbies.TryRemove(code, out _))
                removed++;
        }
        return removed;
    }
}