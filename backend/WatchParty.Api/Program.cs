using WatchParty.Api.Lobbies;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<ILobbyStore, InMemoryLobbyStore>();
builder.Services.AddSignalR();  
var app = builder.Build();

app.MapGet("/", () => "Hello World!");
app.MapGet("/api/health", () => new
{
    status = "ok",
    serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
});
app.MapPost("/api/lobbies", (CreateLobbyRequest req, ILobbyStore store) =>
{
    var lobby = store.Create(req.ClientId, req.HostOnlyControl);
    return Results.Created($"/api/lobbies/{lobby.Code}", new { code = lobby.Code });
});
app.MapGet("/api/lobbies/{code}", (string code, ILobbyStore store) =>
{
    var lobby = store.Get(code);

    if (lobby is null)
        return Results.NotFound();

    return Results.Ok(new { code = lobby.Code, createdAt = lobby.CreatedAt });
});
app.UseStaticFiles();
app.MapHub<LobbyHub>("/hubs/lobby");
app.Run();
