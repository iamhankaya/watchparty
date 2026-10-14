using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using WatchParty.Api.Lobbies;
using WatchParty.Api.Uploads;

namespace WatchParty.Api.Tests;

/// <summary>S3'e gitmeyen sahte depo: çağrıları kaydeder.</summary>
public class FakeUploadStorage : IUploadStorage
{
    public ConcurrentQueue<string> Calls { get; } = new();
    public bool Fail { get; set; }
    public string? LastContentType { get; private set; }
    public string? LastCacheControl { get; private set; }
    public TimeSpan? LastExpires { get; private set; }
    public IReadOnlyList<UploadedPart>? CompletedParts { get; private set; }

    private void Check()
    {
        if (Fail) throw new InvalidOperationException("S3 GIZLI AYRINTI");
    }

    public Task<string> StartMultipart(string key, string contentType, string cacheControl, CancellationToken ct = default)
    {
        Check();
        LastContentType = contentType;
        LastCacheControl = cacheControl;
        Calls.Enqueue($"start {key}");
        return Task.FromResult("upload-123");
    }

    public Task<string> PresignPart(string key, string uploadId, int partNumber, TimeSpan expires)
    {
        Check();
        LastExpires = expires;
        Calls.Enqueue($"part {key} {uploadId} {partNumber}");
        return Task.FromResult($"https://s3.example/{key}?uploadId={uploadId}&partNumber={partNumber}");
    }

    public Task Complete(string key, string uploadId, IReadOnlyList<UploadedPart> parts, CancellationToken ct = default)
    {
        Check();
        CompletedParts = parts;
        Calls.Enqueue($"complete {key} {uploadId}");
        return Task.CompletedTask;
    }

    public Task Abort(string key, string uploadId, CancellationToken ct = default)
    {
        Check();
        Calls.Enqueue($"abort {key} {uploadId}");
        return Task.CompletedTask;
    }

    public Task<string> PresignPut(string key, string contentType, string cacheControl, TimeSpan expires)
    {
        Check();
        LastContentType = contentType;
        LastCacheControl = cacheControl;
        LastExpires = expires;
        Calls.Enqueue($"put {key}");
        return Task.FromResult($"https://s3.example/{key}?put");
    }
}

public class LogCapture : ILoggerProvider
{
    public ConcurrentQueue<string> Lines { get; } = new();
    public ILogger CreateLogger(string categoryName) => new Logger(this);
    public void Dispose() { }

    private sealed class Logger(LogCapture owner) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => owner.Lines.Enqueue(formatter(state, exception) + (exception is null ? "" : " " + exception));
    }
}

public class UploadFactory(Dictionary<string, string?>? overrides = null) : WatchPartyFactory(overrides)
{
    public FakeUploadStorage Storage { get; } = new();
    public LogCapture Logs { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureLogging(l => l.AddProvider(Logs));
        builder.ConfigureTestServices(s => s.AddSingleton<IUploadStorage>(Storage));
    }
}

public class UploadTests
{
    private const string AliKey = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    private const string VeliKey = "Zy9xWv8uTs7rQp6oNm5lKj4iHg3fEd2c";
    private const string Base = "https://cdn.example.net";

    private static string Sha(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();

    private static Dictionary<string, string?> Settings(bool withKeys = true)
    {
        var d = new Dictionary<string, string?>
        {
            ["Upload:VideoBucket"] = "test-bucket",
            ["Upload:PublicBaseUrl"] = Base,
        };
        if (withKeys)
        {
            d["Upload:Keys:0:Name"] = "ali";
            d["Upload:Keys:0:Sha256"] = Sha(AliKey);
            d["Upload:Keys:1:Name"] = "veli";
            d["Upload:Keys:1:Sha256"] = Sha(VeliKey).ToUpperInvariant();
        }
        return d;
    }

    private static Task<HttpResponseMessage> Post(HttpClient client, string path, object body, string? key = AliKey)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        if (key is not null)
            request.Headers.Add("X-Upload-Key", key);
        return client.SendAsync(request);
    }

    private static async Task AssertError(HttpResponseMessage response, HttpStatusCode status, string error)
    {
        Assert.Equal(status, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(error, body.GetProperty("error").GetString());
    }

    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private const string ValidKey = "videolar/0123456789abcdef0123456789abcdef/film.mp4";

    [Fact]
    public async Task Missing_key_returns_401()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await AssertError(await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 10 }, key: null),
            HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
        Assert.Empty(f.Storage.Calls);
    }

    [Fact]
    public async Task Wrong_key_returns_401_on_every_endpoint()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var wrong = AliKey[..^1] + "Q";
        await AssertError(await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 10 }, wrong), HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
        await AssertError(await Post(c, "/api/uploads/video/parts", new { key = ValidKey, uploadId = "u", partNumbers = new[] { 1 } }, wrong), HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
        await AssertError(await Post(c, "/api/uploads/video/complete", new { key = ValidKey, uploadId = "u", parts = new[] { new { partNumber = 1, eTag = "\"e\"" } } }, wrong), HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
        await AssertError(await Post(c, "/api/uploads/video/abort", new { key = ValidKey, uploadId = "u" }, wrong), HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
        await AssertError(await Post(c, "/api/uploads/subtitle", new { fileName = "a.srt", size = 10 }, wrong), HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
        Assert.Empty(f.Storage.Calls);
    }

    [Fact]
    public async Task Correct_key_starts_multipart_upload()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var size = 16_777_216L * 2 + 5;
        var body = await Json(await Post(c, "/api/uploads/video", new { fileName = "Güzel Film.MP4", size }));

        var key = body.GetProperty("key").GetString()!;
        Assert.Matches(@"^videolar/[0-9a-f]{32}/guzel-film\.mp4$", key);
        Assert.Equal("upload-123", body.GetProperty("uploadId").GetString());
        Assert.Equal(16_777_216, body.GetProperty("partSize").GetInt64());
        Assert.Equal(3, body.GetProperty("partCount").GetInt32());
        Assert.Equal("video/mp4", f.Storage.LastContentType);
        Assert.Equal("public, max-age=31536000, immutable", f.Storage.LastCacheControl);
        Assert.Equal([$"start {key}"], f.Storage.Calls);
    }

    [Fact]
    public async Task Second_key_with_uppercase_hash_also_works()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await Json(await Post(c, "/api/uploads/video", new { fileName = "a.m4v", size = 1 }, VeliKey));
        Assert.Equal("video/mp4", f.Storage.LastContentType);
    }

    [Fact]
    public async Task Eleventh_wrong_attempt_returns_429_and_blocks_even_correct_key()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();

        // Doğru anahtarlı istekler sayılmaz.
        for (var i = 0; i < 3; i++)
            await Json(await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 1 }));

        for (var i = 0; i < 10; i++)
            Assert.Equal(HttpStatusCode.Unauthorized, (await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 1 }, "yanlis" + i)).StatusCode);

        Assert.Equal(HttpStatusCode.TooManyRequests, (await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 1 }, "yanlis")).StatusCode);
        // Kilitliyken doğru anahtar da 429 alır; aksi halde kaba kuvvet 429/200 farkından sonucu öğrenirdi.
        Assert.Equal(HttpStatusCode.TooManyRequests, (await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 1 })).StatusCode);
    }

    [Fact]
    public async Task Failed_key_limit_is_per_forwarded_ip()
    {
        var s = Settings();
        s["Security:TrustForwardedHeaders"] = "true";
        using var f = new UploadFactory(s);
        using var c = f.CreateClient();

        async Task<HttpStatusCode> Send(string ip, string key)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, "/api/uploads/video") { Content = JsonContent.Create(new { fileName = "a.mp4", size = 1 }) };
            request.Headers.Add("X-Upload-Key", key);
            request.Headers.Add("X-Forwarded-For", ip);
            return (await c.SendAsync(request)).StatusCode;
        }

        for (var i = 0; i < 10; i++)
            Assert.Equal(HttpStatusCode.Unauthorized, await Send("203.0.113.1", "yanlis"));
        Assert.Equal(HttpStatusCode.TooManyRequests, await Send("203.0.113.1", "yanlis"));
        Assert.Equal(HttpStatusCode.Unauthorized, await Send("203.0.113.2", "yanlis"));
        Assert.Equal(HttpStatusCode.OK, await Send("203.0.113.2", AliKey));
    }

    [Fact]
    public async Task Empty_keys_returns_403_upload_closed()
    {
        using var f = new UploadFactory(Settings(withKeys: false));
        using var c = f.CreateClient();
        await AssertError(await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 1 }), HttpStatusCode.Forbidden, "Yükleme kapalı");
        await AssertError(await Post(c, "/api/uploads/subtitle", new { fileName = "a.srt", size = 1 }, key: null), HttpStatusCode.Forbidden, "Yükleme kapalı");
        await AssertError(await Post(c, "/api/uploads/video/abort", new { key = ValidKey, uploadId = "u" }), HttpStatusCode.Forbidden, "Yükleme kapalı");
        Assert.Empty(f.Storage.Calls);
    }

    [Fact]
    public async Task Upload_closed_by_default_without_configuration()
    {
        using var f = new UploadFactory();
        using var c = f.CreateClient();
        await AssertError(await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 1 }), HttpStatusCode.Forbidden, "Yükleme kapalı");
    }

    [Theory]
    [InlineData("a.mp4", 6_442_450_945L, "Dosya çok büyük")]
    [InlineData("a.mp4", 0L, "Dosya boş")]
    [InlineData("a.mp4", -5L, "Dosya boş")]
    [InlineData("a.avi", 10L, "Yalnızca .mp4 veya .m4v yüklenebilir")]
    [InlineData("mp4", 10L, "Yalnızca .mp4 veya .m4v yüklenebilir")]
    [InlineData("a.srt", 10L, "Yalnızca .mp4 veya .m4v yüklenebilir")]
    [InlineData(null, 10L, "Yalnızca .mp4 veya .m4v yüklenebilir")]
    public async Task Video_validation_errors(string? fileName, long size, string error)
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await AssertError(await Post(c, "/api/uploads/video", new { fileName, size }), HttpStatusCode.BadRequest, error);
        Assert.Empty(f.Storage.Calls);
    }

    [Fact]
    public async Task Video_at_exact_limit_is_accepted()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var body = await Json(await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 6_442_450_944L }));
        Assert.Equal(384, body.GetProperty("partCount").GetInt32());
    }

    [Theory]
    [InlineData("a.srt", 2_097_153L, "Dosya çok büyük")]
    [InlineData("a.srt", 0L, "Dosya boş")]
    [InlineData("a.txt", 10L, "Yalnızca .srt veya .vtt yüklenebilir")]
    [InlineData("a.mp4", 10L, "Yalnızca .srt veya .vtt yüklenebilir")]
    public async Task Subtitle_validation_errors(string fileName, long size, string error)
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await AssertError(await Post(c, "/api/uploads/subtitle", new { fileName, size }), HttpStatusCode.BadRequest, error);
        Assert.Empty(f.Storage.Calls);
    }

    [Theory]
    [InlineData("Türkçe Altyazı.SRT", "turkce-altyazi.srt", "application/x-subrip")]
    [InlineData("ders.vtt", "ders.vtt", "text/vtt")]
    public async Task Subtitle_returns_presigned_put(string fileName, string cleaned, string contentType)
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var body = await Json(await Post(c, "/api/uploads/subtitle", new { fileName, size = 2_097_152 }));

        var key = body.GetProperty("key").GetString()!;
        Assert.Matches($@"^videolar/[0-9a-f]{{32}}/{System.Text.RegularExpressions.Regex.Escape(cleaned)}$", key);
        Assert.Equal($"https://s3.example/{key}?put", body.GetProperty("putUrl").GetString());
        Assert.Equal($"{Base}/{key}", body.GetProperty("url").GetString());
        Assert.Equal(contentType, f.Storage.LastContentType);
        Assert.Equal("public, max-age=31536000, immutable", f.Storage.LastCacheControl);
        Assert.Equal(TimeSpan.FromMinutes(60), f.Storage.LastExpires);
    }

    public static TheoryData<string?> BadKeys() => new()
    {
        null,
        "",
        "baska/0123456789abcdef0123456789abcdef/film.mp4",
        "videolar/0123456789abcdef0123456789abcdef/../film.mp4",
        "videolar/0123456789ABCDEF0123456789abcdef/film.mp4",
        "videolar/0123456789abcdef0123456789abcdef/film.mp4/x",
        "videolar/0123456789abcdef0123456789abcdef/film.srt",
        "videolar/0123456789abcdef0123456789abcdef/" + new string('a', 81) + ".mp4",
    };

    [Theory]
    [MemberData(nameof(BadKeys))]
    public async Task Invalid_file_key_returns_400(string? key)
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        const string error = "Geçersiz dosya anahtarı";
        await AssertError(await Post(c, "/api/uploads/video/parts", new { key, uploadId = "u", partNumbers = new[] { 1 } }), HttpStatusCode.BadRequest, error);
        await AssertError(await Post(c, "/api/uploads/video/complete", new { key, uploadId = "u", parts = new[] { new { partNumber = 1, eTag = "e" } } }), HttpStatusCode.BadRequest, error);
        await AssertError(await Post(c, "/api/uploads/video/abort", new { key, uploadId = "u" }), HttpStatusCode.BadRequest, error);
        Assert.Empty(f.Storage.Calls);
    }

    [Fact]
    public async Task Parts_returns_presigned_urls_up_to_50()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var numbers = Enumerable.Range(1, 50).ToArray();
        var body = await Json(await Post(c, "/api/uploads/video/parts", new { key = ValidKey, uploadId = "u1", partNumbers = numbers }));

        var urls = body.GetProperty("urls").EnumerateArray().ToList();
        Assert.Equal(50, urls.Count);
        Assert.Equal(7, urls[6].GetProperty("partNumber").GetInt32());
        Assert.Equal($"https://s3.example/{ValidKey}?uploadId=u1&partNumber=7", urls[6].GetProperty("url").GetString());
        Assert.Equal(TimeSpan.FromMinutes(60), f.Storage.LastExpires);
    }

    [Fact]
    public async Task Parts_rejects_more_than_50_none_or_out_of_range()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(c, "/api/uploads/video/parts", new { key = ValidKey, uploadId = "u", partNumbers = Enumerable.Range(1, 51).ToArray() })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(c, "/api/uploads/video/parts", new { key = ValidKey, uploadId = "u", partNumbers = Array.Empty<int>() })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(c, "/api/uploads/video/parts", new { key = ValidKey, uploadId = "u", partNumbers = new[] { 0 } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(c, "/api/uploads/video/parts", new { key = ValidKey, uploadId = "u", partNumbers = new[] { 385 } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(c, "/api/uploads/video/parts", new { key = ValidKey, uploadId = "", partNumbers = new[] { 1 } })).StatusCode);
        Assert.Empty(f.Storage.Calls);
    }

    [Fact]
    public async Task Complete_calls_storage_with_sorted_parts_and_returns_url()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var parts = new[] { new { partNumber = 2, eTag = "\"b\"" }, new { partNumber = 1, eTag = "\"a\"" } };
        var body = await Json(await Post(c, "/api/uploads/video/complete", new { key = ValidKey, uploadId = "u9", parts }));

        var url = body.GetProperty("url").GetString()!;
        Assert.Equal($"{Base}/{ValidKey}", url);
        Assert.Null(MediaValidator.Validate("file", url));
        Assert.Equal([$"complete {ValidKey} u9"], f.Storage.Calls);
        Assert.Equal([new UploadedPart(1, "\"a\""), new UploadedPart(2, "\"b\"")], f.Storage.CompletedParts!);
    }

    [Fact]
    public async Task Complete_rejects_empty_or_duplicate_parts()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(c, "/api/uploads/video/complete", new { key = ValidKey, uploadId = "u", parts = Array.Empty<object>() })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(c, "/api/uploads/video/complete", new { key = ValidKey, uploadId = "u", parts = new[] { new { partNumber = 1, eTag = "a" }, new { partNumber = 1, eTag = "b" } } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(c, "/api/uploads/video/complete", new { key = ValidKey, uploadId = "u", parts = new[] { new { partNumber = 1, eTag = "" } } })).StatusCode);
        Assert.Empty(f.Storage.Calls);
    }

    [Fact]
    public async Task Abort_calls_storage_and_returns_204()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var response = await Post(c, "/api/uploads/video/abort", new { key = ValidKey, uploadId = "u5" });
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([$"abort {ValidKey} u5"], f.Storage.Calls);
    }

    [Fact]
    public async Task Storage_failure_returns_502_without_details()
    {
        using var f = new UploadFactory(Settings());
        f.Storage.Fail = true;
        using var c = f.CreateClient();
        var response = await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 1 });
        var text = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("GIZLI", text);
        await AssertError(response, HttpStatusCode.BadGateway, "Yükleme tamamlanamadı");
        await AssertError(await Post(c, "/api/uploads/video/complete", new { key = ValidKey, uploadId = "u", parts = new[] { new { partNumber = 1, eTag = "a" } } }), HttpStatusCode.BadGateway, "Yükleme tamamlanamadı");
        Assert.Contains(f.Logs.Lines, l => l.Contains("GIZLI"));
    }

    [Fact]
    public async Task Long_name_result_url_fits_media_validator()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var body = await Json(await Post(c, "/api/uploads/subtitle", new { fileName = new string('ş', 300) + ".vtt", size = 1 }));
        var url = body.GetProperty("url").GetString()!;
        Assert.True(url.Length <= MediaValidator.MaxIdLength);
        Assert.Null(MediaValidator.ValidateSubtitle(url));
    }

    [Fact]
    public async Task Logs_contain_key_name_but_never_the_upload_key()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var body = await Json(await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 12345 }));
        var key = body.GetProperty("key").GetString()!;
        await Json(await Post(c, "/api/uploads/video/complete", new { key, uploadId = "u", parts = new[] { new { partNumber = 1, eTag = "a" } } }));
        await Post(c, "/api/uploads/video", new { fileName = "a.mp4", size = 1 }, VeliKey[..^1] + "X");

        var all = string.Join("\n", f.Logs.Lines);
        Assert.Contains("anahtar ali", all);
        Assert.Contains(key, all);
        Assert.Contains("12345", all);
        Assert.DoesNotContain(AliKey, all);
        Assert.DoesNotContain(VeliKey[..^1], all);
        Assert.DoesNotContain(Sha(AliKey), all, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("Upload:Keys:0:Sha256", "abc")]
    [InlineData("Upload:Keys:0:Name", "")]
    [InlineData("Upload:VideoBucket", "")]
    [InlineData("Upload:PublicBaseUrl", "http://cdn.example.net")]
    [InlineData("Upload:PublicBaseUrl", "https://cdn.example.net/" + "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")]
    [InlineData("Upload:PartSizeBytes", "1000")]
    public void Invalid_configuration_fails_at_startup(string setting, string value)
    {
        var s = Settings();
        s[setting] = value;
        using var f = new UploadFactory(s);
        Assert.ThrowsAny<Exception>(() => f.CreateClient());
    }
}
