using System.Collections.Concurrent;

namespace WatchParty.Api.Lobbies;

public enum JoinOutcome { Joined, Full, Closed }

// Unchanged: değişiklik yok (oynamıyor, medya yok, kişi yok ya da zaten bekleniyor).
// Started: kişi bekleme listesine eklendi, PlaybackUpdated yayınlanmalı.
// Ignored: tekrar sınırı dolu, bu pencerede daha önce bildirildi; yayın yok.
// IgnoredFirstTime: tekrar sınırı dolu, bu pencerede ilk kez; BufferingIgnored yayınlanmalı.
public enum StartWaitingOutcome { Unchanged, Started, Ignored, IgnoredFirstTime }

public record StartWaitingResult(StartWaitingOutcome Outcome, PlaybackState Playback);

public enum VoiceJoinOutcome { Joined, AlreadyMember, Full, NotInLobby }

public class Lobby
{
    public const int MaxParticipants = 20;
    public const int MaxChatHistory = 50;
    public const int MaxVoiceMembers = 6;

    // Takılan biri için tek seferde en fazla bu kadar beklenir.
    public static readonly TimeSpan MaxWait = TimeSpan.FromSeconds(10);
    // Aynı clientId bu pencere içinde MaxStrikes kez beklendiyse sonraki bildirimleri yok sayılır.
    public static readonly TimeSpan StrikeWindow = TimeSpan.FromMinutes(5);
    public const int MaxStrikes = 3;

    public Lobby(string code, string hostClientId, bool hostOnlyControl = false)
    {
        Code = code;
        HostClientId = hostClientId;
        HostOnlyControl = hostOnlyControl;
        EmptySince = CreatedAt;
    }

    public string Code { get; }
    public string HostClientId { get; private set; }
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
    public ConcurrentDictionary<string, Participant> Participants { get; } = new();
    public PlaybackState Playback { get; set; } = PlaybackState.Empty;
    public bool HostOnlyControl { get; set; }
    public DateTimeOffset? EmptySince { get; private set; }

    // Host'un bağlantısı koptuğu an. Kısa bir süre içinde geri dönmezse hostluk devredilir.
    public DateTimeOffset? HostAwaySince { get; private set; }

    // Katılma/ayrılma, host devri, kapanma ve oynatma durumu değişiklikleri bu kilit altında yapılır.
    public Lock Gate { get; } = new();

    // Temizlik tarafından kapatılan lobiye artık kimse katılamaz.
    public bool IsClosed { get; private set; }

    private readonly Queue<ChatMessage> _chat = new();

    // Bekleme kayıtları; yalnızca Gate altında değişir.
    // Aktif beklemeler: bağlantı kimliği -> başlangıç zamanı.
    private readonly Dictionary<string, DateTimeOffset> _waits = new();
    // Tekrar sayacı: clientId -> StrikeWindow içindeki bekleme başlangıçları (eskiden yeniye).
    private readonly Dictionary<string, List<DateTimeOffset>> _strikes = new();
    // Yok sayılma bildirildi: clientId -> bildirimin geçerli olduğu pencerenin sonu.
    private readonly Dictionary<string, DateTimeOffset> _ignoredUntil = new();

    // Sesli sohbet üyeleri, katılma sırasıyla: bağlantı kimliği ve sessizde mi. Yalnızca Gate altında değişir.
    private readonly List<VoiceMember> _voice = [];

    private sealed class VoiceMember(string connectionId)
    {
        public string ConnectionId { get; } = connectionId;
        public bool Muted { get; set; }
    }

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
            // Lobiden ayrılan sesli sohbetten de çıkar.
            _voice.RemoveAll(v => v.ConnectionId == connectionId);

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

            var nextHost = Participants.Values.OrderBy(p => p.JoinedAt).ThenBy(p => p.ConnectionId, StringComparer.Ordinal).FirstOrDefault();
            if (nextHost is null)
                return null;

            HostClientId = nextHost.ClientId;
            HostAwaySince = null;
            return nextHost;
        }
    }

    // Kişiyi bekleme listesine ekler. Liste boşken başlıyorsa konum o ana dondurulur;
    // sonraki kişiler konumu yeniden hesaplamaz.
    public StartWaitingResult StartWaiting(string connectionId, string clientId, DateTimeOffset now)
    {
        lock (Gate)
        {
            var playback = Playback;
            if (playback.MediaId is null || !playback.IsPlaying || !Participants.ContainsKey(connectionId) || _waits.ContainsKey(connectionId))
                return new(StartWaitingOutcome.Unchanged, playback);

            if (!_strikes.TryGetValue(clientId, out var strikes))
                _strikes[clientId] = strikes = [];
            strikes.RemoveAll(t => now - t >= StrikeWindow);

            if (strikes.Count >= MaxStrikes)
            {
                if (_ignoredUntil.TryGetValue(clientId, out var until) && until > now)
                    return new(StartWaitingOutcome.Ignored, playback);

                // En eski başlangıç pencereden çıkana kadar tekrar bildirilmez.
                _ignoredUntil[clientId] = strikes[0] + StrikeWindow;
                return new(StartWaitingOutcome.IgnoredFirstTime, playback);
            }

            var nowMs = now.ToUnixTimeMilliseconds();
            if (playback.WaitingFor.Count == 0)
                playback = playback with
                {
                    PositionSec = playback.PositionSec + (nowMs - playback.UpdatedAt) / 1000.0,
                    UpdatedAt = nowMs,
                };

            _waits[connectionId] = now;
            strikes.Add(now);
            Playback = playback with { WaitingFor = [.. playback.WaitingFor, connectionId] };
            return new(StartWaitingOutcome.Started, Playback);
        }
    }

    // Kişiyi listeden çıkarır. Değişiklik yoksa null; varsa yayınlanacak yeni durum.
    public PlaybackState? StopWaiting(string connectionId, DateTimeOffset now)
    {
        lock (Gate)
        {
            if (!_waits.Remove(connectionId))
                return null;
            return RemoveWaiters([connectionId], now);
        }
    }

    // Listeyi boşaltır (oynatma komutu ya da "Beklemeden devam et"). Liste zaten boşsa null.
    public PlaybackState? ClearWaiting(DateTimeOffset now)
    {
        lock (Gate)
        {
            _waits.Clear();
            if (Playback.WaitingFor.Count == 0)
                return null;
            return RemoveWaiters(Playback.WaitingFor, now);
        }
    }

    // MaxWait'i dolduran beklemeleri çıkarır. Değişiklik yoksa null.
    public PlaybackState? ExpireWaits(DateTimeOffset now)
    {
        lock (Gate)
        {
            var expired = _waits.Where(w => now - w.Value >= MaxWait).Select(w => w.Key).ToList();
            if (expired.Count == 0)
                return null;
            foreach (var id in expired)
                _waits.Remove(id);
            return RemoveWaiters(expired, now);
        }
    }

    // Gate altında çağrılır. Liste boşalırsa devam: konum aynı, UpdatedAt = now.
    private PlaybackState RemoveWaiters(IReadOnlyCollection<string> ids, DateTimeOffset now)
    {
        var remaining = Playback.WaitingFor.Where(id => !ids.Contains(id)).ToArray();
        Playback = remaining.Length == 0
            ? Playback with { WaitingFor = [], UpdatedAt = now.ToUnixTimeMilliseconds() }
            : Playback with { WaitingFor = remaining };
        return Playback;
    }

    // Sesli sohbete katılır. Zaten üyeyse durum değişmez (AlreadyMember).
    public VoiceJoinOutcome TryJoinVoice(string connectionId)
    {
        lock (Gate)
        {
            if (!Participants.ContainsKey(connectionId))
                return VoiceJoinOutcome.NotInLobby;
            if (FindVoice(connectionId) is not null)
                return VoiceJoinOutcome.AlreadyMember;
            if (_voice.Count >= MaxVoiceMembers)
                return VoiceJoinOutcome.Full;

            _voice.Add(new VoiceMember(connectionId));
            return VoiceJoinOutcome.Joined;
        }
    }

    // Üyeyse çıkarır ve true döner; üye değilse false.
    public bool LeaveVoice(string connectionId)
    {
        lock (Gate)
            return _voice.RemoveAll(v => v.ConnectionId == connectionId) > 0;
    }

    // Üyeyse sessiz durumunu ayarlar ve true döner; üye değilse false.
    public bool SetVoiceMuted(string connectionId, bool muted)
    {
        lock (Gate)
        {
            if (FindVoice(connectionId) is not { } member)
                return false;
            member.Muted = muted;
            return true;
        }
    }

    public bool IsVoiceMember(string connectionId)
    {
        lock (Gate)
            return FindVoice(connectionId) is not null;
    }

    // Salt okunur görünüm, katılma sırasıyla. Takma ad katılımcı kaydından alınır.
    public VoiceMemberView[] VoiceMembers()
    {
        lock (Gate)
            return _voice
                .Select(v => Participants.TryGetValue(v.ConnectionId, out var p) ? new VoiceMemberView(v.ConnectionId, p.Nickname, v.Muted) : null)
                .OfType<VoiceMemberView>()
                .ToArray();
    }

    // Gate altında çağrılır.
    private VoiceMember? FindVoice(string connectionId) => _voice.Find(v => v.ConnectionId == connectionId);

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
    public DateTimeOffset JoinedAt { get; init; } = DateTimeOffset.UtcNow;
}

public record ChatMessage(string Nickname, string Text, long SentAt);
