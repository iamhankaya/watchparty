using System.Net;
using System.Net.Http.Json;

namespace WatchParty.Api.Tests;

public class HttpRateLimitTests
{
    private static Task<HttpResponseMessage> PostLobbyAsync(HttpClient client, string? forwardedFor = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/lobbies")
        {
            Content = JsonContent.Create(new { clientId = "c1", hostOnlyControl = false })
        };
        if (forwardedFor is not null)
            request.Headers.Add("X-Forwarded-For", forwardedFor);
        return client.SendAsync(request);
    }

    [Fact]
    public async Task Create_lobby_over_limit_returns_429()
    {
        using var factory = new WatchPartyFactory(new() { ["Security:CreateLobbyPerMinute"] = "3" });
        using var client = factory.CreateClient();

        for (var i = 0; i < 3; i++)
            Assert.Equal(HttpStatusCode.Created, (await PostLobbyAsync(client)).StatusCode);

        Assert.Equal(HttpStatusCode.TooManyRequests, (await PostLobbyAsync(client)).StatusCode);
    }

    [Fact]
    public async Task Lookup_over_limit_returns_429()
    {
        using var factory = new WatchPartyFactory(new() { ["Security:LookupLobbyPerMinute"] = "3" });
        using var client = factory.CreateClient();

        for (var i = 0; i < 3; i++)
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/lobbies/ZZZZZZ")).StatusCode);

        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.GetAsync("/api/lobbies/ZZZZZZ")).StatusCode);
    }

    [Fact]
    public async Task Health_is_not_limited()
    {
        using var factory = new WatchPartyFactory(new()
        {
            ["Security:LookupLobbyPerMinute"] = "1",
            ["Security:CreateLobbyPerMinute"] = "1",
        });
        using var client = factory.CreateClient();

        for (var i = 0; i < 5; i++)
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/health")).StatusCode);
    }

    [Fact]
    public async Task Forwarded_ip_partitions_limit_when_trusted()
    {
        using var factory = new WatchPartyFactory(new()
        {
            ["Security:TrustForwardedHeaders"] = "true",
            ["Security:CreateLobbyPerMinute"] = "1",
        });
        using var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.Created, (await PostLobbyAsync(client, "203.0.113.1")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await PostLobbyAsync(client, "203.0.113.1")).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await PostLobbyAsync(client, "203.0.113.2")).StatusCode);
    }

    [Fact]
    public async Task Forwarded_header_ignored_when_not_trusted()
    {
        using var factory = new WatchPartyFactory(new()
        {
            ["Security:TrustForwardedHeaders"] = "false",
            ["Security:CreateLobbyPerMinute"] = "1",
        });
        using var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.Created, (await PostLobbyAsync(client, "203.0.113.1")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await PostLobbyAsync(client, "203.0.113.2")).StatusCode);
    }
}
