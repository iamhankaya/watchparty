using Microsoft.AspNetCore.SignalR;

namespace WatchParty.Api.Lobbies;

// Saniyede bir çalışır:
// - Host'un bağlantısı HostGracePeriod'dan uzun süredir yoksa hostluğu en eski katılımcıya devreder.
// - Her PlaybackRebroadcastEvery'de güncel oynatma durumunu yeniden yayınlar; geride kalan sekmeler kendini düzeltir.
public class LobbyTickService(ILobbyStore store, IHubContext<LobbyHub> hub, ILogger<LobbyTickService> logger) : BackgroundService
{
    private static readonly TimeSpan HostGracePeriod = TimeSpan.FromSeconds(10);
    private const int PlaybackRebroadcastEvery = 10; // saniye

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        var tick = 0;
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            tick++;
            foreach (var lobby in store.All())
            {
                if (lobby.Participants.IsEmpty)
                    continue;

                try
                {
                    await TransferHostIfAway(lobby);

                    if (tick % PlaybackRebroadcastEvery == 0 && lobby.Playback.MediaId is not null)
                        await hub.Clients.Group(lobby.Code).SendAsync("PlaybackUpdated", lobby.Playback, stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogError(ex, "Lobi {Code} için periyodik iş başarısız", lobby.Code);
                }
            }
        }
    }

    private async Task TransferHostIfAway(Lobby lobby)
    {
        if (lobby.HostAwaySince is not { } since || DateTimeOffset.UtcNow - since < HostGracePeriod)
            return;
        if (lobby.IsConnected(lobby.HostClientId))
        {
            lobby.HostAwaySince = null;
            return;
        }

        var nextHost = lobby.Participants.Values.OrderBy(p => p.JoinedAt).FirstOrDefault();
        if (nextHost is null)
            return;

        lobby.HostClientId = nextHost.ClientId;
        lobby.HostAwaySince = null;
        logger.LogInformation("Lobi {Code}: hostluk {Nickname} kişisine geçti", lobby.Code, nextHost.Nickname);

        await hub.Clients.Group(lobby.Code).SendAsync("HostChanged", nextHost.Nickname);
        await LobbyEvents.SendParticipants(hub.Clients, lobby);
    }
}
