using System.Net;
using Microsoft.AspNetCore.Http;

namespace WatchParty.Api.Tests;

public class OriginVerificationTests
{
    private static readonly IPAddress External = IPAddress.Parse("203.0.113.5");

    private static WatchPartyFactory WithSecret(string secret = "s3cret", bool trustForwarded = false)
    {
        var settings = new Dictionary<string, string?> { ["Security:OriginSecret"] = secret };
        if (trustForwarded)
            settings["Security:TrustForwardedHeaders"] = "true";
        return new WatchPartyFactory(settings);
    }

    private static async Task<int> SendAsync(WatchPartyFactory factory, IPAddress ip, Action<HttpContext>? configure = null,
        string method = "GET", string path = "/api/health", string? query = null)
    {
        var ctx = await factory.Server.SendAsync(c =>
        {
            c.Connection.RemoteIpAddress = ip;
            c.Request.Method = method;
            c.Request.Path = path;
            if (query is not null)
                c.Request.QueryString = new QueryString(query);
            configure?.Invoke(c);
        });
        return ctx.Response.StatusCode;
    }

    [Fact]
    public async Task Missing_header_is_rejected()
    {
        await using var factory = WithSecret();
        Assert.Equal(403, await SendAsync(factory, External));
    }

    [Fact]
    public async Task Wrong_header_is_rejected()
    {
        await using var factory = WithSecret();
        Assert.Equal(403, await SendAsync(factory, External, c => c.Request.Headers["X-Origin-Verify"] = "nope"));
    }

    [Fact]
    public async Task Case_differs_is_rejected()
    {
        await using var factory = WithSecret();
        Assert.Equal(403, await SendAsync(factory, External, c => c.Request.Headers["X-Origin-Verify"] = "S3CRET"));
    }

    [Fact]
    public async Task Duplicate_header_values_are_rejected()
    {
        await using var factory = WithSecret();
        var status = await SendAsync(factory, External, c =>
        {
            c.Request.Headers.Append("X-Origin-Verify", "s3cret");
            c.Request.Headers.Append("X-Origin-Verify", "s3cret");
        });
        Assert.Equal(403, status);
    }

    [Fact]
    public async Task Correct_header_passes()
    {
        await using var factory = WithSecret();
        Assert.Equal(200, await SendAsync(factory, External, c => c.Request.Headers["X-Origin-Verify"] = "s3cret"));
    }

    [Fact]
    public async Task Loopback_skips_check()
    {
        await using var factory = WithSecret();
        Assert.Equal(200, await SendAsync(factory, IPAddress.Loopback));
        Assert.Equal(200, await SendAsync(factory, IPAddress.IPv6Loopback));
    }

    [Fact]
    public async Task Hub_negotiate_is_checked()
    {
        await using var factory = WithSecret();
        const string query = "?negotiateVersion=1";
        Assert.Equal(403, await SendAsync(factory, External, method: "POST", path: "/hubs/lobby/negotiate", query: query));
        Assert.Equal(200, await SendAsync(factory, External, c => c.Request.Headers["X-Origin-Verify"] = "s3cret",
            method: "POST", path: "/hubs/lobby/negotiate", query: query));
    }

    [Fact]
    public async Task Empty_secret_disables_check()
    {
        await using var factory = new WatchPartyFactory();
        Assert.Equal(200, await SendAsync(factory, External));
    }

    [Fact]
    public async Task Whitespace_secret_disables_check()
    {
        await using var factory = WithSecret("  ");
        Assert.Equal(200, await SendAsync(factory, External));
    }

    [Fact]
    public async Task Forwarded_for_does_not_fake_loopback()
    {
        await using var factory = WithSecret(trustForwarded: true);
        Assert.Equal(403, await SendAsync(factory, External, c => c.Request.Headers["X-Forwarded-For"] = "127.0.0.1"));
    }
}
