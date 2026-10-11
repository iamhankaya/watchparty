using System.Threading.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace WatchParty.Api.Security;

// Hub çağrılarını bağlantı başına token bucket ile, bağlantıları IP başına sayaçla sınırlar.
public class HubRateLimitFilter(ConnectionCounter counter, IOptions<SecurityOptions> options) : IHubFilter
{
    private const string IpKey = "rl:ip";
    private const string ChatKey = "rl:chat";
    private const string PlaybackKey = "rl:playback";
    private const string OtherKey = "rl:other";

    private static readonly HashSet<string> PlaybackMethods = ["SetMedia", "Play", "Pause", "Seek", "SetControlMode"];

    public async Task OnConnectedAsync(HubLifetimeContext context, Func<HubLifetimeContext, Task> next)
    {
        var o = options.Value;
        var ip = ClientIp.Of(context.Context.GetHttpContext()!);
        if (!counter.TryAcquire(ip, o.MaxConnectionsPerIp))
            throw new HubException("Bu adresten çok fazla bağlantı var");

        var items = context.Context.Items;
        items[IpKey] = ip;

        try
        {
            // Bucket oluşturma da try içinde: fırlatırsa yuva ve oluşan limiter'lar bırakılır.
            items[ChatKey] = Bucket(o.ChatBurst, o.ChatPerSecond);
            items[PlaybackKey] = Bucket(o.PlaybackBurst, o.PlaybackPerSecond);
            items[OtherKey] = Bucket(o.OtherBurst, o.OtherPerSecond);

            await next(context);
        }
        catch
        {
            Cleanup(context.Context);
            throw;
        }
    }

    public async ValueTask<object?> InvokeMethodAsync(
        HubInvocationContext invocationContext, Func<HubInvocationContext, ValueTask<object?>> next)
    {
        var name = invocationContext.HubMethodName;
        var key = name == "SendChat" ? ChatKey
            : PlaybackMethods.Contains(name) ? PlaybackKey
            : OtherKey;

        if (invocationContext.Context.Items.TryGetValue(key, out var value)
            && value is TokenBucketRateLimiter limiter
            && !limiter.AttemptAcquire(1).IsAcquired)
            throw new HubException("Çok hızlı istek gönderiyorsun, biraz bekle");

        return await next(invocationContext);
    }

    public async Task OnDisconnectedAsync(
        HubLifetimeContext context, Exception? exception, Func<HubLifetimeContext, Exception?, Task> next)
    {
        try
        {
            await next(context, exception);
        }
        finally
        {
            Cleanup(context.Context);
        }
    }

    private static TokenBucketRateLimiter Bucket(int burst, int perSecond) => new(new TokenBucketRateLimiterOptions
    {
        TokenLimit = burst,
        TokensPerPeriod = perSecond,
        ReplenishmentPeriod = TimeSpan.FromSeconds(1),
        QueueLimit = 0,
        AutoReplenishment = true,
    });

    // Bağlantı reddedildiyse ya da kapandıysa yuva ve limiter'lar bırakılır; tekrar çağrılsa da zararsız.
    private void Cleanup(HubCallerContext context)
    {
        var items = context.Items;
        if (items.TryGetValue(IpKey, out var ip) && ip is string ipValue)
        {
            items.Remove(IpKey);
            counter.Release(ipValue);
        }

        foreach (var key in (string[])[ChatKey, PlaybackKey, OtherKey])
        {
            if (items.TryGetValue(key, out var limiter))
            {
                items.Remove(key);
                (limiter as IDisposable)?.Dispose();
            }
        }
    }
}
