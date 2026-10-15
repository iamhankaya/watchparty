namespace WatchParty.Api.Uploads;

public sealed record UploadedPart(int PartNumber, string ETag);

/// <summary>Nesne deposu (üretimde S3). Dosyanın kendisi sunucudan geçmez; yalnızca izinler üretilir.</summary>
public interface IUploadStorage
{
    /// <summary>Multipart yükleme başlatır, uploadId döner.</summary>
    Task<string> StartMultipart(string key, string contentType, string cacheControl, CancellationToken ct = default);

    /// <summary>Tek parça için presigned UploadPart (PUT) adresi.</summary>
    Task<string> PresignPart(string key, string uploadId, int partNumber, TimeSpan expires);

    Task Complete(string key, string uploadId, IReadOnlyList<UploadedPart> parts, CancellationToken ct = default);

    Task Abort(string key, string uploadId, CancellationToken ct = default);

    /// <summary>Tek seferlik presigned PutObject adresi; istemci aynı Content-Type ve Cache-Control başlıklarını göndermeli.</summary>
    Task<string> PresignPut(string key, string contentType, string cacheControl, TimeSpan expires);
}
