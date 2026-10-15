namespace WatchParty.Api.Lobbies;

// Sesli sohbet ayarları ("Voice" bölümü). Ses verisi sunucudan geçmez; sunucu yalnızca
// istemcilere hangi ICE (STUN/TURN) sunucularını kullanacaklarını söyler.
public class VoiceOptions
{
    public const string Section = "Voice";

    public static readonly IceServerOptions DefaultStun = new() { Urls = ["stun:stun.l.google.com:19302"] };

    // Varsayılan appsettings.json'da. Dizi varsayılanı burada verilmez: yapılandırma bağlayıcısı
    // dizileri değiştirmek yerine sonuna eklediği için ayardaki sunucular varsayılanla karışırdı.
    // Hiç ayar yoksa Program.cs varsayılan STUN'u ekler.
    public IceServerOptions[] IceServers { get; set; } = [];

    private static readonly string[] Schemes = ["stun:", "stuns:", "turn:", "turns:"];

    // Başlangıçta doğrulanır: her sunucuda en az bir adres, adresler stun/stuns/turn/turns ile başlar.
    public bool IsValid() =>
        IceServers.Length > 0 &&
        IceServers.All(s =>
            s.Urls.Length > 0 &&
            s.Urls.All(u => !string.IsNullOrWhiteSpace(u) && u.Length <= 500 &&
                            Schemes.Any(p => u.StartsWith(p, StringComparison.OrdinalIgnoreCase))));

    public IceServerView[] ToViews() =>
        IceServers.Select(s => new IceServerView(s.Urls, NullIfEmpty(s.Username), NullIfEmpty(s.Credential))).ToArray();

    private static string? NullIfEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;
}

public class IceServerOptions
{
    public string[] Urls { get; set; } = [];
    public string? Username { get; set; }
    public string? Credential { get; set; }
}
