namespace WatchParty.Api.Security;

// Zamanlayıcısız token bucket: dolum, her TryTake'te geçen süreye göre tembel hesaplanır.
public sealed class TokenBucket(int burst, int perSecond, TimeProvider time)
{
    private readonly Lock _gate = new();
    private double _tokens = burst;
    private long _last = time.GetTimestamp();

    public bool TryTake()
    {
        lock (_gate)
        {
            var now = time.GetTimestamp();
            // Saat geri giderse geçen süre 0 sayılır; _last geriye çekilmez, geri gidilen süre jeton kazandırmaz.
            if (now > _last)
            {
                var elapsed = time.GetElapsedTime(_last, now);
                _tokens = Math.Min(burst, _tokens + elapsed.TotalSeconds * perSecond);
                _last = now;
            }

            if (_tokens < 1)
                return false;

            _tokens -= 1;
            return true;
        }
    }
}
