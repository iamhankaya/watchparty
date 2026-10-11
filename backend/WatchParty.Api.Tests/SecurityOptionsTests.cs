using System.Net;
using Microsoft.Extensions.Options;

namespace WatchParty.Api.Tests;

public class SecurityOptionsTests
{
    [Fact]
    public async Task Defaults_pass_validation()
    {
        using var factory = new WatchPartyFactory();
        using var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/health")).StatusCode);
    }

    [Theory]
    [InlineData("Security:ChatBurst")]
    [InlineData("Security:OtherPerSecond")]
    [InlineData("Security:CreateLobbyPerMinute")]
    [InlineData("Security:MaxConnectionsPerIp")]
    public void Zero_limit_stops_startup(string key)
    {
        using var factory = new WatchPartyFactory(new() { [key] = "0" });

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.NotNull(FindOptionsValidationException(exception));
    }

    private static OptionsValidationException? FindOptionsValidationException(Exception? exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
            if (current is OptionsValidationException validation)
                return validation;
        return null;
    }
}
