using System.Collections.Concurrent;

namespace WatchParty.Api.Lobbies;

public enum JoinOutcome { Joined, Full, Closed }

public class Lobby
{
    public const int MaxParticipants = 20;
    public const int MaxChatHistory = 50;

    public required string Code { get; init; }
    public required string HostClientId { get; set; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    public ConcurrentDictionary<string, Participant> Participants { get; } = new();
    public PlaybackState Playback { get; set; } = PlaybackState.Empty;
    public bool HostOnlyControl { get; set; }
    public DateTimeOffset? EmptySince { get; set; } = DateTimeOffset.UtcNow;

    // Host'un bağlantısı koptuğu an. Kısa bir süre içinde geri dönmezse hostluk devredilir.
    public DateTimeOffset? HostAwaySince { get; set; }

    // Katılma/ayrılma, host devri, kapanma ve oynatma durumu değişiklikleri bu kilit altında yapılır.
    public Lock Gate { get; } = new();

    // Temizlik tarafından kapatılan lobiye artık kimse katılamaz.
    public bool IsClosed { get; private set; }

    private readonly Queue<ChatMessage> _chat = new();

    public JoinOutcome TryJoin(Participant participant)
    {
        lock (Gate)
        {
            if (IsClosed)
                return JoinOutcome.Closed;
            if (Participants.Count >= MaxParticipants)
                return JoinOutcome.Full;

            Participants[participant.ConnectionId] = participant;
            EmptySince = null;
            if (participant.ClientId == HostClientId)
                HostAwaySince = null;
            return JoinOutcome.Joined;
        }
    }

    public Participant? Leave(string connectionId)
    {
        lock (Gate)
        {
            Participants.TryRemove(connectionId, out var leaving);

            // Host'un son bağlantısı gittiyse hostluğu hemen devretmiyoruz: sayfa yenileme olabilir.
            // LobbyTickService kısa bir bekleme süresinden sonra devreder.
            if (leaving is not null && leaving.ClientId == HostClientId && !IsConnected(HostClientId))
                HostAwaySince = DateTimeOffset.UtcNow;

            if (Participants.IsEmpty)
                EmptySince = DateTimeOffset.UtcNow;

            return leaving;
        }
    }

    public bool TryClose(DateTimeOffset cutoff)
    {
        lock (Gate)
        {
            if (!Participants.IsEmpty || EmptySince is not { } since || since >= cutoff)
                return false;

            IsClosed = true;
            return true;
        }
    }

    public Participant? TryTransferHost(DateTimeOffset now, TimeSpan grace)
    {
        lock (Gate)
        {
            if (HostAwaySince is not { } since || now - since < grace)
                return null;
            if (IsConnected(HostClientId))
            {
                HostAwaySince = null;
                return null;
            }

            var nextHost = Participants.Values.OrderBy(p => p.JoinedAt).FirstOrDefault();
            if (nextHost is null)
                return null;

            HostClientId = nextHost.ClientId;
            HostAwaySince = null;
            return nextHost;
        }
    }

    public void AddChat(ChatMessage message)
    {
        lock (_chat)
        {
            _chat.Enqueue(message);
            while (_chat.Count > MaxChatHistory)
                _chat.Dequeue();
        }
    }

    public ChatMessage[] ChatHistory()
    {
        lock (_chat)
            return _chat.ToArray();
    }

    public bool IsConnected(string clientId) =>
        Participants.Values.Any(p => p.ClientId == clientId);
}

public record Participant(string ConnectionId, string Nickname, string ClientId)
{
    public DateTimeOffset JoinedAt { get; } = DateTimeOffset.UtcNow;
}

public record ChatMessage(string Nickname, string Text, long SentAt);
