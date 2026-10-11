namespace WatchParty.Api.Lobbies;

public record PlaybackState(
    string? MediaType,
    string? MediaId,
    bool IsPlaying,
    double PositionSec,
    long UpdatedAt)
{
    public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public static PlaybackState Empty => new(null, null, false, 0, Now());
}
