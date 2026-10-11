using System.Collections.Concurrent;

namespace WatchParty.Api.Lobbies;

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

    private readonly Queue<ChatMessage> _chat = new();

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
