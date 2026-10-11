namespace WatchParty.Api.Security;

public class SecurityOptions
{
    public const string Section = "Security";

    // CloudFront/ALB arkasında true olmalı; aksi halde X-Forwarded-For sahte olabilir.
    public bool TrustForwardedHeaders { get; set; } = false;

    // IP başına dakikalık HTTP limitleri
    public int CreateLobbyPerMinute { get; set; } = 10;
    public int LookupLobbyPerMinute { get; set; } = 60;

    // IP başına eşzamanlı hub bağlantısı
    public int MaxConnectionsPerIp { get; set; } = 20;

    // Hub token bucket'ları (burst = kova kapasitesi, perSecond = dolum hızı)
    public int ChatBurst { get; set; } = 5;
    public int ChatPerSecond { get; set; } = 1;
    public int PlaybackBurst { get; set; } = 10;
    public int PlaybackPerSecond { get; set; } = 4;
    public int OtherBurst { get; set; } = 20;
    public int OtherPerSecond { get; set; } = 10;
}
