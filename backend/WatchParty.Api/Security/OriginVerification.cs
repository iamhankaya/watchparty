using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace WatchParty.Api.Security;

public static class OriginVerification
{
    public const string HeaderName = "X-Origin-Verify";

    // CloudFront'un eklediği gizli header olmadan gelen istekleri 403 ile reddeder.
    // Secret boşsa kontrol kapalıdır; loopback (yerel geliştirme, sunucu içi sağlık kontrolü) muaftır.
    public static IApplicationBuilder UseOriginVerification(this IApplicationBuilder app)
    {
        var secret = app.ApplicationServices.GetRequiredService<IOptions<SecurityOptions>>().Value.OriginSecret;
        if (string.IsNullOrWhiteSpace(secret))
            return app;

        var expected = Encoding.UTF8.GetBytes(secret);
        return app.Use(async (context, next) =>
        {
            var ip = context.Connection.RemoteIpAddress;
            if (ip is not null && IPAddress.IsLoopback(ip))
            {
                await next(context);
                return;
            }

            var values = context.Request.Headers[HeaderName];
            if (values.Count != 1 || values[0] is not { } value
                || !CryptographicOperations.FixedTimeEquals(expected, Encoding.UTF8.GetBytes(value)))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }

            await next(context);
        });
    }
}
