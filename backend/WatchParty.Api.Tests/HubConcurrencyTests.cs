using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using WatchParty.Api.Lobbies;

namespace WatchParty.Api.Tests;

public class HubConcurrencyTests
{
    [Fact]
    public async Task Parallel_joins_never_exceed_MaxParticipants()
    {
        await using var factory = new WatchPartyFactory();
        var code = await factory.CreateLobbyAsync("h");

        const int total = 30;
        var connections = new List<HubConnection>();
        try
        {
            for (var i = 0; i < total; i++)
                connections.Add(await factory.ConnectAsync());

            var results = await Task.WhenAll(connections.Select(async (connection, i) =>
            {
                try
                {
                    await connection.InvokeAsync<JsonElement>("JoinLobby", code, $"u{i}", $"c{i}");
                    return (Exception?)null;
                }
                catch (Exception ex)
                {
                    return ex;
                }
            }));

            Assert.Equal(Lobby.MaxParticipants, results.Count(e => e is null));
            Assert.All(results.Where(e => e is not null), e =>
            {
                Assert.IsType<HubException>(e);
                Assert.Contains("Lobi dolu", e!.Message);
            });

            using var client = factory.CreateClient();
            var lobby = await client.GetFromJsonAsync<JsonElement>($"/api/lobbies/{code}");
            Assert.Equal(Lobby.MaxParticipants, lobby.GetProperty("participantCount").GetInt32());
        }
        finally
        {
            foreach (var connection in connections)
                await connection.DisposeAsync();
        }
    }
}
