using Amazon;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Options;

namespace WatchParty.Api.Uploads;

/// <summary>
/// S3 uygulaması. Kimlik bilgisi varsayılan zincirden gelir (sunucuda EC2 instance rolü, yerelde AWS_PROFILE).
/// İstemci ilk kullanımda oluşturulur; yükleme kapalıyken AWS'ye hiç dokunulmaz.
/// </summary>
public sealed class S3UploadStorage(IOptions<UploadOptions> options) : IUploadStorage, IDisposable
{
    // Hesabın SCP'si yalnızca bu bölgeye izin verir.
    public static readonly RegionEndpoint Region = RegionEndpoint.EUNorth1;

    private readonly Lazy<AmazonS3Client> _client = new(() => new AmazonS3Client(new AmazonS3Config
    {
        RegionEndpoint = Region,
        // Yeni SDK varsayılanı (WHEN_SUPPORTED) multipart'a CRC32 sağlama toplamı ekler; o zaman tarayıcının
        // her parça için checksum göndermesi gerekirdi. Yalnızca zorunlu olduğunda hesaplansın.
        RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
        ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
    }));

    private string Bucket => options.Value.VideoBucket;
    private AmazonS3Client Client => _client.Value;

    public async Task<string> StartMultipart(string key, string contentType, string cacheControl, CancellationToken ct = default)
    {
        var request = new InitiateMultipartUploadRequest
        {
            BucketName = Bucket,
            Key = key,
            ContentType = contentType,
        };
        request.Headers.CacheControl = cacheControl;
        var response = await Client.InitiateMultipartUploadAsync(request, ct);
        return response.UploadId;
    }

    public Task<string> PresignPart(string key, string uploadId, int partNumber, TimeSpan expires) =>
        Client.GetPreSignedURLAsync(new GetPreSignedUrlRequest
        {
            BucketName = Bucket,
            Key = key,
            Verb = HttpVerb.PUT,
            UploadId = uploadId,
            PartNumber = partNumber,
            Expires = DateTime.UtcNow.Add(expires),
            Protocol = Protocol.HTTPS,
        });

    public async Task Complete(string key, string uploadId, IReadOnlyList<UploadedPart> parts, CancellationToken ct = default)
    {
        await Client.CompleteMultipartUploadAsync(new CompleteMultipartUploadRequest
        {
            BucketName = Bucket,
            Key = key,
            UploadId = uploadId,
            PartETags = parts.Select(p => new PartETag(p.PartNumber, p.ETag)).ToList(),
        }, ct);
    }

    public async Task Abort(string key, string uploadId, CancellationToken ct = default)
    {
        await Client.AbortMultipartUploadAsync(new AbortMultipartUploadRequest
        {
            BucketName = Bucket,
            Key = key,
            UploadId = uploadId,
        }, ct);
    }

    public Task<string> PresignPut(string key, string contentType, string cacheControl, TimeSpan expires)
    {
        // Content-Type ve Cache-Control imzaya girer: tarayıcı PUT'ta bu iki başlığı birebir göndermeli.
        var request = new GetPreSignedUrlRequest
        {
            BucketName = Bucket,
            Key = key,
            Verb = HttpVerb.PUT,
            ContentType = contentType,
            Expires = DateTime.UtcNow.Add(expires),
            Protocol = Protocol.HTTPS,
        };
        request.Headers.CacheControl = cacheControl;
        return Client.GetPreSignedURLAsync(request);
    }

    public void Dispose()
    {
        if (_client.IsValueCreated)
            _client.Value.Dispose();
    }
}
