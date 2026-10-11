using System.Threading.RateLimiting;
using Microsoft.Extensions.Options;

namespace WatchParty.Api.Security;

public static class HttpRateLimits
{
    public const string CreateLobby = "create-lobby";
    public const string LookupLobby = "lookup-lobby";

    public static IServiceCollection AddHttpRateLimits(this IServiceCollection services)
    {
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.AddPolicy(CreateLobby, context => Partition(context, o => o.CreateLobbyPerMinute));
            options.AddPolicy(LookupLobby, context => Partition(context, o => o.LookupLobbyPerMinute));
        });
        return services;
    }

    // Limit ayarlardan istek anında okunur (yapılandırma Build()'dan sonra da değişebilir).
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
