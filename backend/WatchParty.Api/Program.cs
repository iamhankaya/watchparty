using WatchParty.Api.Lobbies;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<ILobbyStore, InMemoryLobbyStore>();
var app = builder.Build();

app.MapGet("/", () => "Hello World!");
app.MapGet("/api/health", () => new
{
    status = "ok",
    serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
});
app.Run();
