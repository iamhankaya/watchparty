using System.Net;
using WatchParty.Api.Security;

namespace WatchParty.Api.Tests;

public class ClientIpTests
{
    private static string Key(string? ip) => ClientIp.Key(ip is null ? null : IPAddress.Parse(ip));

    [Fact]
    public void Ipv6_addresses_in_same_64_share_key() =>
        Assert.Equal(Key("2001:db8:1:2:aaaa::1"), Key("2001:db8:1:2:bbbb::2"));

    [Fact]
    public void Ipv6_addresses_in_different_64_have_different_keys() =>
        Assert.NotEqual(Key("2001:db8:1:2::1"), Key("2001:db8:1:3::1"));

    [Fact]
    public void Ipv4_mapped_address_is_keyed_as_plain_ipv4()
    {
        Assert.Equal("203.0.113.5", Key("::ffff:203.0.113.5"));
        Assert.Equal("203.0.113.5", Key("203.0.113.5"));
        Assert.NotEqual(Key("::ffff:203.0.113.5"), Key("::ffff:203.0.113.6"));
    }

    [Fact]
    public void Null_address_is_unknown() => Assert.Equal("unknown", Key(null));
}
