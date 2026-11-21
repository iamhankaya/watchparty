using System.Net;
using WatchParty.Api.Lobbies;
using WatchParty.Api.Security;

namespace WatchParty.Api.Metrics;

public static class InternalMetricsEndpoint
{
    // spc ajanı (aynı sunucuda, http://localhost/internal/metrics) okur. Yanıt düz JSON, yalnız sayı alanları:
    // ad, lobi kodu, IP, dosya adı dönmez. Hesap olmadığından product_users_total yoktur.
    public static IEndpointRouteBuilder MapInternalMetrics(this IEndpointRouteBuilder app)
    {
        app.MapGet("/internal/metrics", (HttpContext context, ILobbyStore store, ProductMetrics metrics, ConnectionCounter connections) =>
        {
            if (!IsLocal(context))
                return Results.NotFound();

            return Results.Ok(new Dictionary<string, int>
            {
                ["product_sessions_open"] = store.All().Count(l => !l.IsClosed),
                ["ws_connections"] = connections.Total(),
                ["product_active_today"] = metrics.ActiveToday(),
                ["product_signups_today"] = metrics.SignupsToday(),
            });
        });
        return app;
    }

    // Yalnız doğrudan loopback bağlantısı. Forwarded/origin başlıklarına güvenilmez: proxy üzerinden gelen
    // (başlığı olan) istek loopback görünse de reddedilir; UseForwardedHeaders RemoteIpAddress'i değiştirmiş olabilir.
    private static bool IsLocal(HttpContext context)
    {
        var ip = context.Connection.RemoteIpAddress;
        if (ip is null || !IPAddress.IsLoopback(ip))
            return false;

        var headers = context.Request.Headers;
        return !headers.ContainsKey("X-Forwarded-For")
            && !headers.ContainsKey("X-Original-For")
            && !headers.ContainsKey(OriginVerification.HeaderName);
    }
}
