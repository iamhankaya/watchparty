using WatchParty.Api.Lobbies;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<ILobbyStore, InMemoryLobbyStore>();
builder.Services.AddSignalR();
builder.Services.AddHostedService<LobbyCleanupService>();
builder.Services.AddHostedService<LobbyTickService>();
var app = builder.Build();

app.UseStaticFiles();

app.MapGet("/api/health", () => new
{
    status = "ok",
    serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
});

app.MapPost("/api/lobbies", (CreateLobbyRequest req, ILobbyStore store) =>
{
    if (string.IsNullOrWhiteSpace(req.ClientId) || req.ClientId.Length > 100)
        return Results.BadRequest(new { error = "Geçersiz clientId" });

    var lobby = store.Create(req.ClientId, req.HostOnlyControl);
    return Results.Created($"/api/lobbies/{lobby.Code}", new { code = lobby.Code });
});

app.MapGet("/api/lobbies/{code}", (string code, ILobbyStore store) =>
{
    var lobby = store.Get(code);

    if (lobby is null)
        return Results.NotFound();

    return Results.Ok(new
    {
        code = lobby.Code,
        createdAt = lobby.CreatedAt,
        participantCount = lobby.Participants.Count,
        isFull = lobby.Participants.Count >= Lobby.MaxParticipants
    });
});

app.MapHub<LobbyHub>("/hubs/lobby");

app.Run();
