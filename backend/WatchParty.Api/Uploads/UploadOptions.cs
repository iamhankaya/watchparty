using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using WatchParty.Api.Lobbies;

namespace WatchParty.Api.Uploads;

public class UploadKeyEntry
{
    // Loglarda görünen ad (kişinin adı); anahtarın kendisi sunucuda hiç durmaz.
    public string Name { get; set; } = "";

    // Açık anahtarın UTF-8 baytlarının SHA-256 özeti, 64 hex (büyük/küçük harf fark etmez).
    public string Sha256 { get; set; } = "";
}

public class UploadOptions
{
    public const string Section = "Upload";

    // Boşsa yükleme kapalıdır (403 "Yükleme kapalı").
    public List<UploadKeyEntry> Keys { get; set; } = [];

    public string VideoBucket { get; set; } = "";

    // Sonuç linklerinin tabanı (CloudFront adresi), ör. https://xxxx.cloudfront.net
    public string PublicBaseUrl { get; set; } = "";

    public long MaxVideoBytes { get; set; } = 6_442_450_944;
    public long MaxSubtitleBytes { get; set; } = 2_097_152;
    public long PartSizeBytes { get; set; } = 16_777_216;
    public int UrlLifetimeMinutes { get; set; } = 60;

    public bool Enabled => Keys.Count > 0;

    // Sondaki '/' atılmış taban adres.
    public string BaseUrl => PublicBaseUrl.TrimEnd('/');

    // S3 en fazla 10 000 parça kabul eder; en büyük video için gereken parça sayısı.
    public int MaxPartCount => (int)((MaxVideoBytes + PartSizeBytes - 1) / PartSizeBytes);
}

public partial class UploadOptionsValidator : IValidateOptions<UploadOptions>
{
    private const long S3MinPartSize = 5L * 1024 * 1024;
    private const long S3MaxPartSize = 5L * 1024 * 1024 * 1024;

    [GeneratedRegex(@"^[0-9a-fA-F]{64}\z")]
    private static partial Regex Sha256Hex();

    public ValidateOptionsResult Validate(string? name, UploadOptions o)
    {
        var errors = new List<string>();

        if (o.MaxVideoBytes < 1) errors.Add("Upload:MaxVideoBytes >= 1 olmalı");
        if (o.MaxSubtitleBytes < 1) errors.Add("Upload:MaxSubtitleBytes >= 1 olmalı");
        if (o.UrlLifetimeMinutes is < 1 or > 7 * 24 * 60) errors.Add("Upload:UrlLifetimeMinutes 1..10080 olmalı");
        if (o.PartSizeBytes is < S3MinPartSize or > S3MaxPartSize) errors.Add("Upload:PartSizeBytes 5 MB..5 GB olmalı");
        else if (o.MaxPartCount > 10_000) errors.Add("Upload: MaxVideoBytes / PartSizeBytes en fazla 10000 parça olmalı");

        for (var i = 0; i < o.Keys.Count; i++)
        {
            var k = o.Keys[i];
            if (string.IsNullOrWhiteSpace(k?.Name)) errors.Add($"Upload:Keys:{i}:Name boş olamaz");
            if (k?.Sha256 is null || !Sha256Hex().IsMatch(k.Sha256)) errors.Add($"Upload:Keys:{i}:Sha256 64 hex karakter olmalı");
        }

        if (o.Enabled)
        {
            if (string.IsNullOrWhiteSpace(o.VideoBucket)) errors.Add("Upload:VideoBucket boş olamaz");

            if (!Uri.TryCreate(o.PublicBaseUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
                || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
                errors.Add("Upload:PublicBaseUrl https:// ile başlayan bir adres olmalı");
            // En uzun dosya anahtarıyla bile sonuç linki MediaValidator'ın sınırına sığmalı.
            else if (o.BaseUrl.Length + 1 + FileNames.MaxKeyLength > MediaValidator.MaxIdLength)
                errors.Add($"Upload:PublicBaseUrl çok uzun (en fazla {MediaValidator.MaxIdLength - 1 - FileNames.MaxKeyLength} karakter)");
        }

        return errors.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(errors);
    }
}
