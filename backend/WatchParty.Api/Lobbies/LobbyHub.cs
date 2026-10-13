using Microsoft.AspNetCore.SignalR;

namespace WatchParty.Api.Lobbies;

public class LobbyHub(ILobbyStore store) : Hub
{
    private const int MaxNicknameLength = 30;
    private const int MaxChatLength = 500;

    public async Task<JoinResult> JoinLobby(string code, string nickname, string clientId)
    {
        nickname = nickname?.Trim() ?? "";
        if (nickname.Length is 0 or > MaxNicknameLength)
            throw new HubException($"Takma ad 1-{MaxNicknameLength} karakter olmalı");
        if (string.IsNullOrWhiteSpace(clientId) || clientId.Length > 100)
            throw new HubException("Geçersiz clientId");
        if (Context.Items.ContainsKey("lobbyCode"))
            throw new HubException("Bu bağlantı zaten bir lobide");

        var lobby = store.Get(code ?? "");
        if (lobby is null)
            throw new HubException("Lobi bulunamadı");

        switch (lobby.TryJoin(new Participant(Context.ConnectionId, nickname, clientId)))
        {
            case JoinOutcome.Closed:
                throw new HubException("Lobi bulunamadı");
            case JoinOutcome.Full:
                throw new HubException("Lobi dolu");
        }

        Context.Items["lobbyCode"] = lobby.Code;
        Context.Items["clientId"] = clientId;

        await Groups.AddToGroupAsync(Context.ConnectionId, lobby.Code);
        await LobbyEvents.SendParticipants(Clients, lobby);
        await Clients.Caller.SendAsync("PlaybackUpdated", lobby.Playback);
        await Clients.Caller.SendAsync("ControlModeChanged", lobby.HostOnlyControl);
        await Clients.Caller.SendAsync("ChatHistory", lobby.ChatHistory());

        return new JoinResult(Context.ConnectionId, IsHost(lobby));
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var lobby = CurrentLobby();
        if (lobby is not null)
        {
            lobby.Leave(Context.ConnectionId);

            await LobbyEvents.SendParticipants(Clients, lobby);

            // Beklenen kişi gittiyse listeden çıkar; boşaldıysa oynatma devam eder.
            if (lobby.StopWaiting(Context.ConnectionId, DateTimeOffset.UtcNow) is { } resumed)
                await Clients.Group(lobby.Code).SendAsync("PlaybackUpdated", resumed);
        }

        await base.OnDisconnectedAsync(exception);
    }

    public Task SetMedia(string type, string id)
    {
        if (MediaValidator.Validate(type, id) is { } error)
            throw new HubException(error);

        return Update(s => s with { MediaType = type, MediaId = id, IsPlaying = false, PositionSec = 0, SubtitleUrl = null });
    }

    public Task Play(double positionSec) => Update(s => s with { IsPlaying = true, PositionSec = ValidPosition(positionSec) });
    public Task Pause(double positionSec) => Update(s => s with { IsPlaying = false, PositionSec = ValidPosition(positionSec) });
    public Task Seek(double positionSec) => Update(s => s with { PositionSec = ValidPosition(positionSec) });

    public async Task SetSubtitle(string? url)
    {
        // Boş değer altyazıyı kaldırır.
        if (string.IsNullOrEmpty(url))
            url = null;
        else if (MediaValidator.ValidateSubtitle(url) is { } error)
            throw new HubException(error);

        var lobby = CurrentLobby() ?? throw new HubException("Önce bir lobiye katıl");

        PlaybackState next;
        lock (lobby.Gate)
        {
            if (lobby.HostOnlyControl && !IsHost(lobby))
                throw new HubException("Sadece host kontrol edebilir");
            if (lobby.Playback.MediaId is null)
                throw new HubException("Önce bir medya seç");
            if (lobby.Playback.MediaType != "file")
                throw new HubException("Altyazı yalnızca MP4 videolarda kullanılabilir");

            // Konum ve UpdatedAt değişmez: aksi halde oynarken herkes geri atlardı.
            next = lobby.Playback with { SubtitleUrl = url };
            lobby.Playback = next;
        }

        await Clients.Group(lobby.Code).SendAsync("PlaybackUpdated", next);
    }

    // "Yazıyor..." bildirimi. Lobide değilse sessizce yok sayılır; takma ad istemciden değil
    // sunucudaki katılımcı kaydından alınır. Çağıran hariç lobiye iletilir.
    public async Task Typing()
    {
        var lobby = CurrentLobby();
        if (lobby is null || !lobby.Participants.TryGetValue(Context.ConnectionId, out var me))
            return;

        await Clients.OthersInGroup(lobby.Code).SendAsync("UserTyping", Context.ConnectionId, me.Nickname);
    }

    // İstemcinin otomatik "takıldım / yetiştim" bildirimi. Kullanıcıya hata göstermemek için
    // hiçbir durumda HubException fırlatmaz; uygun değilse sessizce yok sayar. Host-only modda da kabul edilir.
    public async Task ReportBuffering(bool buffering)
    {
        var lobby = CurrentLobby();
        if (lobby is null || !Context.Items.TryGetValue("clientId", out var v) || v is not string clientId)
            return;

        var now = DateTimeOffset.UtcNow;
        if (!buffering)
        {
            if (lobby.StopWaiting(Context.ConnectionId, now) is { } resumed)
                await Clients.Group(lobby.Code).SendAsync("PlaybackUpdated", resumed);
            return;
        }

        var result = lobby.StartWaiting(Context.ConnectionId, clientId, now);
        switch (result.Outcome)
        {
            case StartWaitingOutcome.Started:
                await Clients.Group(lobby.Code).SendAsync("PlaybackUpdated", result.Playback);
                break;
            case StartWaitingOutcome.IgnoredFirstTime when lobby.Participants.TryGetValue(Context.ConnectionId, out var me):
                await Clients.Group(lobby.Code).SendAsync("BufferingIgnored", me.Nickname);
                break;
        }
    }

    // "Beklemeden devam et": listeyi boşaltır, donan konumdan devam edilir. Liste boşsa yok sayılır.
    public async Task SkipWaiting()
    {
        var lobby = CurrentLobby() ?? throw new HubException("Önce bir lobiye katıl");

        PlaybackState? next;
        lock (lobby.Gate)
        {
            if (lobby.HostOnlyControl && !IsHost(lobby))
                throw new HubException("Sadece host kontrol edebilir");

            next = lobby.ClearWaiting(DateTimeOffset.UtcNow);
        }

        if (next is not null)
            await Clients.Group(lobby.Code).SendAsync("PlaybackUpdated", next);
    }

    public async Task SetControlMode(bool hostOnly)
    {
        var lobby = CurrentLobby() ?? throw new HubException("Önce bir lobiye katıl");
        lock (lobby.Gate)
        {
            if (!IsHost(lobby))
                throw new HubException("Kontrol modunu sadece host değiştirebilir");

            lobby.HostOnlyControl = hostOnly;
        }

        await Clients.Group(lobby.Code).SendAsync("ControlModeChanged", hostOnly);
    }

    public async Task SendChat(string text)
    {
        var lobby = CurrentLobby() ?? throw new HubException("Önce bir lobiye katıl");
        text = text?.Trim() ?? "";
        if (text.Length is 0 or > MaxChatLength)
            throw new HubException($"Mesaj 1-{MaxChatLength} karakter olmalı");
        if (!lobby.Participants.TryGetValue(Context.ConnectionId, out var me))
            throw new HubException("Önce bir lobiye katıl");

        var message = new ChatMessage(me.Nickname, text, PlaybackState.Now());
        lobby.AddChat(message);
        await Clients.Group(lobby.Code).SendAsync("ChatMessage", message);
    }

    public long Ping() => PlaybackState.Now();

    private async Task Update(Func<PlaybackState, PlaybackState> change)
    {
        var lobby = CurrentLobby() ?? throw new HubException("Önce bir lobiye katıl");

        PlaybackState next;
        lock (lobby.Gate)
        {
            if (lobby.HostOnlyControl && !IsHost(lobby))
                throw new HubException("Sadece host kontrol edebilir");
            if (lobby.Playback.MediaId is null && change(lobby.Playback).MediaId is null)
                throw new HubException("Önce bir medya seç");

            // Yeni komut beklemeyi bitirir; konumu komut belirler.
            var now = DateTimeOffset.UtcNow;
            lobby.ClearWaiting(now);
            next = change(lobby.Playback) with { UpdatedAt = now.ToUnixTimeMilliseconds() };
            lobby.Playback = next;
        }

        await Clients.Group(lobby.Code).SendAsync("PlaybackUpdated", next);
    }

    private static double ValidPosition(double positionSec) =>
        double.IsFinite(positionSec) && positionSec >= 0
            ? positionSec
            : throw new HubException("Geçersiz konum");

    private Lobby? CurrentLobby() =>
        Context.Items.TryGetValue("lobbyCode", out var v) && v is string code ? store.Get(code) : null;

    private bool IsHost(Lobby lobby) =>
        Context.Items.TryGetValue("clientId", out var v) && v is string id && id == lobby.HostClientId;
}
