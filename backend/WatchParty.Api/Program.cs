using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Options;
using WatchParty.Api.Lobbies;
using WatchParty.Api.Security;

var builder = WebApplication.CreateBuilder(args);
builder.Services.Configure<SecurityOptions>(builder.Configuration.GetSection(SecurityOptions.Section));
builder.Services.AddHttpRateLimits();
builder.Services.AddSingleton<ILobbyStore, InMemoryLobbyStore>();
builder.Services.AddSignalR();
builder.Services.AddHostedService<LobbyCleanupService>();
builder.Services.AddHostedService<LobbyTickService>();
var app = builder.Build();

// Ayar Build() sonrası okunur; test/ortam yapılandırması da böylece görünür.
if (app.Services.GetRequiredService<IOptions<SecurityOptions>>().Value.TrustForwardedHeaders)
{
    var forwarded = new ForwardedHeadersOptions
    {
        ForwardedHeaders = ForwardedHeaders.XForwardedFor,
        ForwardLimit = 1,
    };
    // Proxy CloudFront/ALB olduğundan IP aralıkları sabit listelenemez; zinciri tek atlama ile sınırla.
    forwarded.KnownIPNetworks.Clear();
    forwarded.KnownProxies.Clear();
    app.UseForwardedHeaders(forwarded);
}

app.UseRateLimiter();

// test.html yalnızca geliştirme ortamında servis edilir
if (app.Environment.IsDevelopment())
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
}).RequireRateLimiting(HttpRateLimits.CreateLobby);

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
}).RequireRateLimiting(HttpRateLimits.LookupLobby);

app.MapHub<LobbyHub>("/hubs/lobby");

app.Run();

public partial class Program;
