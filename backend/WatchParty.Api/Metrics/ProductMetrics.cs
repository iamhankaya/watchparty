namespace WatchParty.Api.Metrics;

// Bellek içi günlük ürün sayaçları (UTC gün). Yeniden başlatmada sıfırlanır; hiçbir kimlik dışarı verilmez, yalnız sayılar.
public class ProductMetrics(TimeProvider time)
{
    private readonly Lock _gate = new();
    private DateOnly _day = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
    private int _lobbiesCreated;
    // Bugün katılan farklı clientId'ler (yenileme/ikinci sekme tek kişi sayılır). Yalnız bellekte, gün dönünce atılır.
    private readonly HashSet<string> _activeClients = [];

    public void RecordLobbyCreated()
    {
        lock (_gate)
        {
            Roll();
            _lobbiesCreated++;
        }
    }

    public void RecordJoin(string clientId)
    {
        lock (_gate)
        {
            Roll();
            _activeClients.Add(clientId);
        }
    }

    public int SignupsToday()
    {
        lock (_gate)
        {
            Roll();
            return _lobbiesCreated;
        }
    }

    public int ActiveToday()
    {
        lock (_gate)
        {
            Roll();
            return _activeClients.Count;
        }
    }

    // Gate altında çağrılır.
    private void Roll()
    {
        var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
        if (today == _day)
            return;
        _day = today;
        _lobbiesCreated = 0;
        _activeClients.Clear();
    }
}
