namespace WatchParty.Api.Security;

public static class ClientIp
{
    // UseForwardedHeaders çalıştıysa RemoteIpAddress zaten gerçek istemci IP'sidir.
    public static string Of(HttpContext context) =>
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}
