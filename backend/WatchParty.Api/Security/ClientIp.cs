using System.Net;
using System.Net.Sockets;

namespace WatchParty.Api.Security;

public static class ClientIp
{
    // UseForwardedHeaders çalıştıysa RemoteIpAddress zaten gerçek istemci IP'sidir.
    public static string Of(HttpContext context) => Key(context.Connection.RemoteIpAddress);

    // IPv4-mapped adresler (::ffff:a.b.c.d) düz IPv4'e çevrilir; gerçek IPv6 istemciler /64 önekiyle anahtarlanır,
    // böylece aynı /64 içinde adres değiştirerek limitler aşılamaz.
    public static string Key(IPAddress? address)
    {
        if (address is null) return "unknown";

        if (address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();

        if (address.AddressFamily != AddressFamily.InterNetworkV6)
            return address.ToString();

        Span<byte> bytes = stackalloc byte[16];
        address.TryWriteBytes(bytes, out _);
        bytes[8..].Clear();
        return $"{new IPAddress(bytes)}/64";
    }
}
