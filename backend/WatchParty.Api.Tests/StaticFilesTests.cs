using System.Net;
using Microsoft.AspNetCore.Hosting;

namespace WatchParty.Api.Tests;

public class StaticFilesTests
{
    [Fact]
    public async Task Test_page_not_served_in_production()
    {
        await using var factory = new WatchPartyFactory();
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/test.html");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Test_page_served_in_development()
    {
        await using var factory = new WatchPartyFactory().WithWebHostBuilder(b => b.UseEnvironment("Development"));
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/test.html");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
