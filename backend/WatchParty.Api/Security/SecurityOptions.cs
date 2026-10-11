using System.ComponentModel.DataAnnotations;

namespace WatchParty.Api.Security;

public class SecurityOptions
{
    public const string Section = "Security";

    // CloudFront/ALB arkasında true olmalı; aksi halde X-Forwarded-For sahte olabilir.
    public bool TrustForwardedHeaders { get; set; } = false;

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
}
