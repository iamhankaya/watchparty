using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace WatchParty.Api.Uploads;

/// <summary>Yükleme anahtarlarını SHA-256 özetleri üzerinden sabit zamanlı karşılaştırır.</summary>
public class UploadKeys
{
    // Gerçek anahtarlar 32 karakter; çok uzun başlıkları özetlemeye gerek yok.
    private const int MaxPresentedLength = 256;

    private readonly (string Name, byte[] Hash)[] _entries;

    public UploadKeys(IOptions<UploadOptions> options)
    {
        _entries = options.Value.Keys
            .Select(k => (k.Name, Convert.FromHexString(k.Sha256)))
            .ToArray();
    }

    public bool Enabled => _entries.Length > 0;

    /// <summary>Anahtar geçerliyse kaydın adını, değilse null döner.</summary>
    public string? Match(string? presented)
    {
        if (string.IsNullOrEmpty(presented) || presented.Length > MaxPresentedLength)
            return null;

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(presented));
        string? match = null;
        // Erken çıkılmaz: süre hangi kaydın eşleştiğine bağlı olmasın.
        foreach (var (name, expected) in _entries)
            if (CryptographicOperations.FixedTimeEquals(hash, expected))
                match ??= name;
        return match;
    }
}
