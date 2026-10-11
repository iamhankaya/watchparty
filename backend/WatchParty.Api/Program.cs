using WatchParty.Api.Lobbies;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => "Hello World!");
app.MapGet("/api/health", () => new
{
    status = true,
    serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
});
app.MapGet("/api/debug/code", () => LobbyCodeGenerator.Generate());
app.Run();
