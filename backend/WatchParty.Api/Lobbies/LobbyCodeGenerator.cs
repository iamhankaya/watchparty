namespace WatchParty.Api.Lobbies;

public static class LobbyCodeGenerator
{
    // 0/O ve 1/I karışmasın diye yok
    private const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public static string Generate()
    {
        return new string(Random.Shared.GetItems(Alphabet.AsSpan(), 6));
    }
}
