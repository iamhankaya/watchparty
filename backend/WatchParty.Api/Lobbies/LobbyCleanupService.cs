namespace WatchParty.Api.Lobbies;

public class LobbyCleanupService(ILobbyStore store, ILogger<LobbyCleanupService> logger) : BackgroundService
{
    private static readonly TimeSpan EmptyLobbyTtl = TimeSpan.FromMinutes(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            var removed = store.RemoveExpired(DateTimeOffset.UtcNow - EmptyLobbyTtl);
            if (removed > 0)
                logger.LogInformation("{Count} boş lobi silindi", removed);
        }
    }
}
