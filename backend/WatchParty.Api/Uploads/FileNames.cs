using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace WatchParty.Api.Uploads;

public static partial class FileNames
{
    public const int MaxNameLength = 80;

    // "videolar/" + 32 hex + "/" + ad (en fazla 80) + "." + uzantı (en fazla 3)
    public const int MaxKeyLength = 9 + 32 + 1 + MaxNameLength + 1 + 3;

    [GeneratedRegex(@"^videolar/[0-9a-f]{32}/[a-z0-9-]{1,80}\.(mp4|m4v|srt|vtt)\z")]
    private static partial Regex KeyPattern();

    [GeneratedRegex("[^a-z0-9]+")]
    private static partial Regex NonAlnum();

    /// <summary>İstemcinin gönderdiği dosya anahtarı bu sunucunun ürettiği biçimde mi.</summary>
    public static bool IsValidKey(string? key) => key is not null && KeyPattern().IsMatch(key);

    /// <summary>Küçük harfli uzantı (noktasız); yoksa boş.</summary>
    public static string Extension(string? fileName)
    {
        var name = BaseName(fileName);
        var dot = name.LastIndexOf('.');
        return dot < 0 ? "" : name[(dot + 1)..].ToLowerInvariant();
    }

    /// <summary>
    /// Adı ASCII'ye çevirir (Türkçe karakterler dahil), küçük harf yapar, [a-z0-9] dışını tek '-' yapar,
    /// en fazla 80 karakterle sınırlar ve uzantıyı korur. Ad boş kalırsa <paramref name="fallback"/> kullanılır.
    /// </summary>
    public static string Clean(string? fileName, string fallback)
    {
        var name = BaseName(fileName);
        var dot = name.LastIndexOf('.');
        var stem = dot < 0 ? name : name[..dot];
        var ext = dot < 0 ? "" : NonAlnum().Replace(name[(dot + 1)..].ToLowerInvariant(), "");

        var cleaned = NonAlnum().Replace(ToAscii(stem), "-").Trim('-');
        if (cleaned.Length > MaxNameLength)
            cleaned = cleaned[..MaxNameLength].TrimEnd('-');
        if (cleaned.Length == 0)
            cleaned = fallback;

        return ext.Length == 0 ? cleaned : $"{cleaned}.{ext}";
    }

    /// <summary>Tahmin edilemeyen gizli klasörle yeni dosya anahtarı: videolar/&lt;32 hex&gt;/&lt;ad&gt;.</summary>
    public static string NewKey(string cleanedName) =>
        $"videolar/{RandomNumberGenerator.GetHexString(32, lowercase: true)}/{cleanedName}";

    // Tarayıcıların eklediği "C:\fakepath\" gibi yol bileşenleri atılır.
    private static string BaseName(string? fileName)
    {
        if (string.IsNullOrEmpty(fileName)) return "";
        var slash = fileName.LastIndexOfAny(['/', '\\']);
        return slash < 0 ? fileName : fileName[(slash + 1)..];
    }

    private static string ToAscii(string s)
    {
        // ı/İ ayrıştırılamaz (ya da kültüre göre yanlış küçülür); önce elle çevrilir.
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s)
            sb.Append(ch switch { 'ı' or 'İ' => 'i', _ => ch });

        // ğ, ü, ş, ö, ç ve diğer aksanlı harfler: taban harf + birleşik işaret; işaretler atılır.
        var decomposed = sb.ToString().Normalize(NormalizationForm.FormD);
        sb.Clear();
        foreach (var ch in decomposed)
            if (CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark)
                sb.Append(ch);
        return sb.ToString().ToLowerInvariant();
    }
}
