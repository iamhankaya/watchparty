namespace WatchParty.Api.Security;

// IP başına eşzamanlı hub bağlantısı sayacı; sayaç 0'a inince anahtar silinir.
public class ConnectionCounter
{
    private readonly Dictionary<string, int> _counts = [];
    private readonly Lock _gate = new();

    public bool TryAcquire(string ip, int max)
    {
        lock (_gate)
        {
            _counts.TryGetValue(ip, out var current);
            if (current >= max)
                return false;

            _counts[ip] = current + 1;
            return true;
        }
    }

    public void Release(string ip)
    {
        lock (_gate)
        {
            if (!_counts.TryGetValue(ip, out var current))
                return;

            if (current <= 1)
                _counts.Remove(ip);
            else
                _counts[ip] = current - 1;
        }
    }
}
