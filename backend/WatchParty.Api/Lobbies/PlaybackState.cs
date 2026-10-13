namespace WatchParty.Api.Lobbies;

// WaitingFor: beklenen katılımcıların bağlantı kimlikleri (istemcilerin gördüğü participant id).
// IsPlaying doğruyken liste boş değilse konum donmuştur: beklenen konum PositionSec'tir.
public record PlaybackState(
    string? MediaType,
    string? MediaId,
    bool IsPlaying,
    double PositionSec,
    long UpdatedAt,
    string? SubtitleUrl = null,
    IReadOnlyList<string>? WaitingFor = null)
{
    // Varsayılan değer derleme zamanı sabiti olamadığı için null gelir; burada boş listeye çevrilir.
    public IReadOnlyList<string> WaitingFor { get; init; } = WaitingFor ?? [];

    public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public static PlaybackState Empty => new(null, null, false, 0, Now(), null);
}
