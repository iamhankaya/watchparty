using System.Threading.RateLimiting;
using Microsoft.Extensions.Options;

namespace WatchParty.Api.Security;

public static class HttpRateLimits
{
    public const string CreateLobby = "create-lobby";
    public const string LookupLobby = "lookup-lobby";
    public const string Upload = "upload";

    public static IServiceCollection AddHttpRateLimits(this IServiceCollection services)
    {
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.AddPolicy(CreateLobby, context => Partition(context, o => o.CreateLobbyPerMinute));
            options.AddPolicy(LookupLobby, context => Partition(context, o => o.LookupLobbyPerMinute));
            options.AddPolicy(Upload, context => Partition(context, o => o.UploadPerMinute));
        });
        return services;
    }

    // Ayarlar Build() sonrası çözülür, böylece test/ortam yapılandırması görünür; limit IP bölümü ilk oluşturulurken okunur.
    private static RateLimitPartition<string> Partition(HttpContext context, Func<SecurityOptions, int> limit)
    {
        var permitLimit = limit(context.RequestServices.GetRequiredService<IOptions<SecurityOptions>>().Value);
        return RateLimitPartition.GetFixedWindowLimiter(ClientIp.Of(context), _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = permitLimit,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        });
    }
}

/// <summary>
/// Yanlış yükleme anahtarı denemeleri için IP başına sabit pencere (10 dk'da 10). Yalnızca başarısız denemeler
/// izin harcar; sınır dolunca o IP pencere bitene kadar doğru anahtarla da 429 alır (aksi halde kaba kuvvet
/// 401/429 yerine 200 görerek doğru anahtarı öğrenebilirdi).
/// </summary>
public sealed class FailedUploadKeyLimiter : IDisposable
{
    public const int PermitLimit = 10;
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(10);

    private readonly PartitionedRateLimiter<string> _limiter = PartitionedRateLimiter.Create<string, string>(ip =>
        RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = PermitLimit,
            Window = Window,
            QueueLimit = 0,
        }));

    /// <summary>Bu IP'nin başarısız deneme hakkı bitti mi (izin harcamaz).</summary>
    public bool IsBlocked(HttpContext context)
    {
        using var lease = _limiter.AttemptAcquire(ClientIp.Of(context), 0);
        return !lease.IsAcquired;
    }

    /// <summary>Başarısız denemeyi sayar; sınır aşıldıysa false döner.</summary>
    public bool TryRecordFailure(HttpContext context)
    {
        using var lease = _limiter.AttemptAcquire(ClientIp.Of(context), 1);
        return lease.IsAcquired;
    }

    public void Dispose() => _limiter.Dispose();
}
