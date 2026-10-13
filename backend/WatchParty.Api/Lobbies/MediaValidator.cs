using System.Text.RegularExpressions;

namespace WatchParty.Api.Lobbies;

public static partial class MediaValidator
{
    public const int MaxIdLength = 200;

    [GeneratedRegex(@"^[A-Za-z0-9_-]{11}\z")]
    private static partial Regex YouTubeId();

    /// <summary>Geçerliyse null, değilse Türkçe hata mesajı döner.</summary>
    public static string? Validate(string? type, string? id)
    {
        if (type is not ("youtube" or "file"))
            return "Medya tipi 'youtube' ya da 'file' olmalı";
        // Baş/son boşluk (satır sonu dahil) reddedilir; biçim kontrollerinden önce yapılır.
        if (string.IsNullOrWhiteSpace(id) || id.Length > MaxIdLength || id != id.Trim())
            return "Geçersiz medya id";

        if (type == "youtube")
            return YouTubeId().IsMatch(id) ? null : "Geçersiz YouTube video id";

        return Uri.TryCreate(id, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps
            ? null
            : "Video adresi https:// ile başlamalı";
    }

    /// <summary>Altyazı adresi geçerliyse null, değilse Türkçe hata mesajı döner. Boş değer çağıran tarafça kaldırma sayılır.</summary>
    public static string? ValidateSubtitle(string? url)
    {
        if (url is null || url != url.Trim() || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            return "Altyazı adresi https:// ile başlamalı";
        if (url.Length > MaxIdLength)
            return "Altyazı adresi en fazla 200 karakter olmalı";
        return null;
    }
}
