namespace WatchParty.Api.Lobbies;

public class Lobby
{
    public required string Code { get; init; }
    public required string HostClientId { get; set; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
}