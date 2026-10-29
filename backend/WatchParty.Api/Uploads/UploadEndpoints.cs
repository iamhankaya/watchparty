using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using WatchParty.Api.Security;

namespace WatchParty.Api.Uploads;

public record StartUploadRequest(string? FileName, long Size);
public record PartsRequest(string? Key, string? UploadId, int[]? PartNumbers);
public record PartDto(int PartNumber, string? ETag);
public record CompleteRequest(string? Key, string? UploadId, PartDto[]? Parts);
public record AbortRequest(string? Key, string? UploadId);

/// <summary>
/// Tarayıcıdan S3'e doğrudan yükleme: sunucu yalnızca yükleme anahtarını doğrular ve kısa süreli izinler üretir,
/// dosyanın kendisi buradan geçmez. Loglara anahtar adı, dosya anahtarı ve boyut yazılır; yükleme anahtarı asla.
/// </summary>
public static partial class UploadEndpoints
{
    public const string KeyHeader = "X-Upload-Key";
    public const string CacheControl = "public, max-age=31536000, immutable";
    public const int MaxPartsPerRequest = 50;
    public const long MaxRequestBodyBytes = 64 * 1024;
    // complete tüm parçaların ETag'ini taşır (~60 bayt/parça, en fazla 10000 parça); grup sınırını aşar.
    public const long MaxCompleteBodyBytes = 1024 * 1024;

    private const string KeyNameItem = "uploadKeyName";
    private const string LogCategory = "WatchParty.Api.Uploads";

    [GeneratedRegex(@"^[\x21-\x7E]{1,1024}\z")]
    private static partial Regex PrintableToken();

    public static IServiceCollection AddUploads(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<UploadOptions>()
            .Bind(configuration.GetSection(UploadOptions.Section))
            .ValidateOnStart();
        services.AddSingleton<IValidateOptions<UploadOptions>, UploadOptionsValidator>();
        services.AddSingleton<UploadKeys>();
        services.AddSingleton<FailedUploadKeyLimiter>();
        services.AddSingleton<IUploadStorage, S3UploadStorage>();
        return services;
    }

    public static IEndpointRouteBuilder MapUploadEndpoints(this IEndpointRouteBuilder app)
    {
        // Gövde sınırı ve IP başına hız sınırı model bağlamadan önce uygulanır; anahtar filtresi ise bağlamadan sonra
        // çalıştığından anahtarsız istekler gövdeyi okutmadan burada durdurulur.
        var group = app.MapGroup("/api/uploads")
            .WithMetadata(new RequestSizeLimitAttribute(MaxRequestBodyBytes))
            .RequireRateLimiting(HttpRateLimits.Upload)
            .AddEndpointFilter(RequireUploadKey);

        group.MapPost("/video", StartVideo);
        group.MapPost("/video/parts", PresignParts);
        group.MapPost("/video/complete", CompleteVideo).WithMetadata(new RequestSizeLimitAttribute(MaxCompleteBodyBytes));
        group.MapPost("/video/abort", AbortVideo);
        group.MapPost("/subtitle", StartSubtitle);
        return app;
    }

    private static IResult Error(int status, string message) => Results.Json(new { error = message }, statusCode: status);
    private static IResult BadRequest(string message) => Results.BadRequest(new { error = message });

    private static ILogger Logger(HttpContext context) =>
        context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(LogCategory);

    private static string KeyName(HttpContext context) => (string)context.Items[KeyNameItem]!;

    // Tüm uç noktalar için: kapalıysa 403, kilitli IP 429, yanlış anahtar 401 (ve başarısız deneme sayılır).
    private static async ValueTask<object?> RequireUploadKey(EndpointFilterInvocationContext invocation, EndpointFilterDelegate next)
    {
        var context = invocation.HttpContext;
        var keys = context.RequestServices.GetRequiredService<UploadKeys>();
        if (!keys.Enabled)
            return Error(StatusCodes.Status403Forbidden, "Yükleme kapalı");

        var limiter = context.RequestServices.GetRequiredService<FailedUploadKeyLimiter>();
        if (limiter.IsBlocked(context))
            return Results.StatusCode(StatusCodes.Status429TooManyRequests);

        var name = keys.Match(context.Request.Headers[KeyHeader].ToString());
        if (name is null)
        {
            Logger(context).LogWarning("Geçersiz yükleme anahtarı denemesi (IP {Ip})", ClientIp.Of(context));
            return limiter.TryRecordFailure(context)
                ? Error(StatusCodes.Status401Unauthorized, "Yükleme anahtarı geçersiz")
                : Results.StatusCode(StatusCodes.Status429TooManyRequests);
        }

        context.Items[KeyNameItem] = name;
        return await next(invocation);
    }

    // S3 hataları: ayrıntı yalnızca logda, istemciye 502.
    private static async Task<IResult> Storage(HttpContext context, string action, string key, Func<Task<IResult>> run)
    {
        try
        {
            return await run();
        }
        catch (Exception ex) when (!context.RequestAborted.IsCancellationRequested)
        {
            Logger(context).LogError(ex, "Yükleme deposu hatası ({Action}): anahtar {KeyName}, dosya {ObjectKey}", action, KeyName(context), key);
            return Error(StatusCodes.Status502BadGateway, "Yükleme tamamlanamadı");
        }
    }

    private static string? ValidateFile(string? fileName, long size, long maxBytes, string[] extensions, string extensionError)
    {
        if (!extensions.Contains(FileNames.Extension(fileName)))
            return extensionError;
        if (size <= 0)
            return "Dosya boş";
        if (size > maxBytes)
            return "Dosya çok büyük";
        return null;
    }

    private static bool IsVideoKey(string? key) =>
        FileNames.IsValidKey(key) && FileNames.VideoExtensions.Contains(key![(key.LastIndexOf('.') + 1)..]);

    private static bool IsValidUploadId(string? uploadId) => uploadId is not null && PrintableToken().IsMatch(uploadId);

    private static Task<IResult> StartVideo(StartUploadRequest req, HttpContext context, IOptions<UploadOptions> options, IUploadStorage storage)
    {
        var o = options.Value;
        var error = ValidateFile(req.FileName, req.Size, o.MaxVideoBytes, [.. FileNames.VideoExtensions], FileNames.VideoExtensionError);
        if (error is not null)
            return Task.FromResult(BadRequest(error));

        var key = FileNames.NewKey(FileNames.Clean(req.FileName, "video"));
        var partCount = (int)((req.Size + o.PartSizeBytes - 1) / o.PartSizeBytes);

        return Storage(context, "başlat", key, async () =>
        {
            var uploadId = await storage.StartMultipart(key, FileNames.ContentTypeFor(FileNames.Extension(key)), CacheControl, context.RequestAborted);
            Logger(context).LogInformation("Video yükleme başladı: anahtar {KeyName}, dosya {ObjectKey}, boyut {Size}", KeyName(context), key, req.Size);
            return Results.Ok(new { key, uploadId, partSize = o.PartSizeBytes, partCount });
        });
    }

    private static Task<IResult> PresignParts(PartsRequest req, HttpContext context, IOptions<UploadOptions> options, IUploadStorage storage)
    {
        var o = options.Value;
        if (!IsVideoKey(req.Key))
            return Task.FromResult(BadRequest("Geçersiz dosya anahtarı"));
        if (!IsValidUploadId(req.UploadId) || req.PartNumbers is not { Length: >= 1 and <= MaxPartsPerRequest }
            || req.PartNumbers.Any(n => n < 1 || n > o.MaxPartCount))
            return Task.FromResult(BadRequest("Geçersiz istek"));

        var expires = TimeSpan.FromMinutes(o.UrlLifetimeMinutes);
        return Storage(context, "parça", req.Key!, async () =>
        {
            var urls = new List<object>(req.PartNumbers.Length);
            foreach (var partNumber in req.PartNumbers)
                urls.Add(new { partNumber, url = await storage.PresignPart(req.Key!, req.UploadId!, partNumber, expires) });
            return Results.Ok(new { urls });
        });
    }

    private static Task<IResult> CompleteVideo(CompleteRequest req, HttpContext context, IOptions<UploadOptions> options, IUploadStorage storage)
    {
        var o = options.Value;
        if (!IsVideoKey(req.Key))
            return Task.FromResult(BadRequest("Geçersiz dosya anahtarı"));
        if (!IsValidUploadId(req.UploadId) || req.Parts is null || req.Parts.Length < 1 || req.Parts.Length > o.MaxPartCount
            || req.Parts.Any(p => p.PartNumber < 1 || p.PartNumber > o.MaxPartCount || p.ETag is null || p.ETag.Length > 200 || !PrintableToken().IsMatch(p.ETag))
            || req.Parts.Select(p => p.PartNumber).Distinct().Count() != req.Parts.Length)
            return Task.FromResult(BadRequest("Geçersiz istek"));

        var parts = req.Parts.OrderBy(p => p.PartNumber).Select(p => new UploadedPart(p.PartNumber, p.ETag!)).ToList();
        return Storage(context, "tamamla", req.Key!, async () =>
        {
            await storage.Complete(req.Key!, req.UploadId!, parts, context.RequestAborted);
            Logger(context).LogInformation("Video yükleme tamamlandı: anahtar {KeyName}, dosya {ObjectKey}, {PartCount} parça", KeyName(context), req.Key, parts.Count);
            return Results.Ok(new { url = $"{o.BaseUrl}/{req.Key}" });
        });
    }

    private static Task<IResult> AbortVideo(AbortRequest req, HttpContext context, IUploadStorage storage)
    {
        if (!IsVideoKey(req.Key))
            return Task.FromResult(BadRequest("Geçersiz dosya anahtarı"));
        if (!IsValidUploadId(req.UploadId))
            return Task.FromResult(BadRequest("Geçersiz istek"));

        return Storage(context, "iptal", req.Key!, async () =>
        {
            await storage.Abort(req.Key!, req.UploadId!, context.RequestAborted);
            Logger(context).LogInformation("Video yükleme iptal edildi: anahtar {KeyName}, dosya {ObjectKey}", KeyName(context), req.Key);
            return Results.NoContent();
        });
    }

    private static Task<IResult> StartSubtitle(StartUploadRequest req, HttpContext context, IOptions<UploadOptions> options, IUploadStorage storage)
    {
        var o = options.Value;
        var error = ValidateFile(req.FileName, req.Size, o.MaxSubtitleBytes, ["srt", "vtt"], "Yalnızca .srt veya .vtt yüklenebilir");
        if (error is not null)
            return Task.FromResult(BadRequest(error));

        var key = FileNames.NewKey(FileNames.Clean(req.FileName, "altyazi"));
        var contentType = key.EndsWith(".vtt", StringComparison.Ordinal) ? "text/vtt" : "application/x-subrip";

        return Storage(context, "altyazı", key, async () =>
        {
            var putUrl = await storage.PresignPut(key, contentType, CacheControl, TimeSpan.FromMinutes(o.UrlLifetimeMinutes));
            Logger(context).LogInformation("Altyazı yükleme izni: anahtar {KeyName}, dosya {ObjectKey}, boyut {Size}", KeyName(context), key, req.Size);
            return Results.Ok(new { key, putUrl, url = $"{o.BaseUrl}/{key}" });
        });
    }
}
