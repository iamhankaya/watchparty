using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Configuration;

namespace WatchParty.Api.Tests;

public class WatchPartyFactory(Dictionary<string, string?>? overrides = null) : WebApplicationFactory<Program>
{
    private readonly Dictionary<string, string?> _settings = BuildSettings(overrides);

    private static Dictionary<string, string?> BuildSettings(Dictionary<string, string?>? overrides)
    {
        var settings = new Dictionary<string, string?>
        {
            ["Security:CreateLobbyPerMinute"] = "1000",
            ["Security:LookupLobbyPerMinute"] = "1000",
            ["Security:MaxConnectionsPerIp"] = "1000",
        };
        if (overrides is not null)
            foreach (var (key, value) in overrides)
                settings[key] = value;
        return settings;
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Production");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(_settings));
    }

    public async Task<HubConnection> ConnectAsync()
    {
        var connection = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/lobby", options =>
            {
                options.HttpMessageHandlerFactory = _ => Server.CreateHandler();
                options.Transports = HttpTransportType.LongPolling;
            })
            .Build();
        await connection.StartAsync();
        return connection;
    }

    public async Task<string> CreateLobbyAsync(string clientId, bool hostOnly = false)
    {
        using var client = CreateClient();
        var response = await client.PostAsJsonAsync("/api/lobbies", new { clientId, hostOnlyControl = hostOnly });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("code").GetString()!;
    }
}
