using System.ComponentModel.DataAnnotations;

namespace WatchParty.Api.Security;

public class SecurityOptions
{
    public const string Section = "Security";

    // CloudFront arkasında true olmalı; aksi halde X-Forwarded-For sahte olabilir. Araya başka bir proxy (ör. ALB) girerse ForwardLimit artırılmalı.
    public bool TrustForwardedHeaders { get; set; } = false;

    // CloudFront'un X-Origin-Verify header'ında gönderdiği gizli değer; boş/boşluk ise kontrol kapalı (loopback her zaman muaf).
    public string OriginSecret { get; set; } = "";

    // IP başına dakikalık HTTP limitleri
    [Range(1, int.MaxValue)] public int CreateLobbyPerMinute { get; set; } = 10;
    [Range(1, int.MaxValue)] public int LookupLobbyPerMinute { get; set; } = 60;

    // IP başına eşzamanlı hub bağlantısı
    [Range(1, int.MaxValue)] public int MaxConnectionsPerIp { get; set; } = 20;

    // Hub token bucket'ları (burst = kova kapasitesi, perSecond = dolum hızı)
    [Range(1, int.MaxValue)] public int ChatBurst { get; set; } = 5;
    [Range(1, int.MaxValue)] public int ChatPerSecond { get; set; } = 1;
    [Range(1, int.MaxValue)] public int PlaybackBurst { get; set; } = 10;
    [Range(1, int.MaxValue)] public int PlaybackPerSecond { get; set; } = 4;
    [Range(1, int.MaxValue)] public int OtherBurst { get; set; } = 20;
    [Range(1, int.MaxValue)] public int OtherPerSecond { get; set; } = 10;
    // Sesli sohbet: ICE adayları bağlantı başında topluca geldiği için kova geniş.
    [Range(1, int.MaxValue)] public int VoiceBurst { get; set; } = 60;
    [Range(1, int.MaxValue)] public int VoicePerSecond { get; set; } = 30;
}
