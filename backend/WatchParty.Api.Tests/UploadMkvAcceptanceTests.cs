using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WatchParty.Api.Lobbies;
using WatchParty.Api.Uploads;

namespace WatchParty.Api.Tests;

/// <summary>
/// MKV kabul testleri (T20261029-26): sözleşme ve spec senaryoları 1, 2, 6, 7, 11 ile güvenlik notları.
/// Uygulamaya bakılmadan yazıldı; uygulama fazı bitene kadar kırmızı olması beklenir.
/// Yalnız sahte depo (FakeUploadStorage) kullanılır, gerçek S3'e gidilmez.
/// </summary>
public class UploadMkvAcceptanceTests
{
    private const string AliKey = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    private const string Hex = "0123456789abcdef0123456789abcdef";
    private const string Error = "Yalnızca .mp4, .m4v veya .mkv yüklenebilir";

    private static string Sha(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();

    private static Dictionary<string, string?> Settings() => new()
    {
        ["Upload:VideoBucket"] = "test-bucket",
        ["Upload:PublicBaseUrl"] = "https://cdn.example.net",
        ["Upload:Keys:0:Name"] = "ali",
        ["Upload:Keys:0:Sha256"] = Sha(AliKey),
    };

    private static Task<HttpResponseMessage> Post(HttpClient client, string path, object body, string? key = AliKey)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        if (key is not null)
            request.Headers.Add("X-Upload-Key", key);
        return client.SendAsync(request);
    }

    private static async Task<JsonElement> Ok(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task AssertError(HttpResponseMessage response, HttpStatusCode status, string error)
    {
        Assert.Equal(status, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(error, body.GetProperty("error").GetString());
    }

    // --- Senaryo 1/2: başlatma ve içerik türü -------------------------------------------------

    [Fact]
    public async Task Mkv_start_returns_mkv_key_and_matroska_content_type()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var body = await Ok(await Post(c, "/api/uploads/video", new { fileName = "Güzel Film.MKV", size = 16_777_216L * 2 + 5 }));

        var key = body.GetProperty("key").GetString()!;
        Assert.Matches(@"^videolar/[0-9a-f]{32}/guzel-film\.mkv$", key);
        Assert.Equal("upload-123", body.GetProperty("uploadId").GetString());
        Assert.Equal(3, body.GetProperty("partCount").GetInt32());
        Assert.Equal("video/x-matroska", f.Storage.LastContentType);
        Assert.Equal("public, max-age=31536000, immutable", f.Storage.LastCacheControl);
        Assert.Equal([$"start {key}"], f.Storage.Calls);
    }

    [Theory]
    [InlineData("a.mp4", "video/mp4")]
    [InlineData("a.m4v", "video/mp4")]
    [InlineData("a.mkv", "video/x-matroska")]
    public async Task Content_type_follows_the_extension(string fileName, string contentType)
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await Ok(await Post(c, "/api/uploads/video", new { fileName, size = 10 }));
        Assert.Equal(contentType, f.Storage.LastContentType);
    }

    [Fact]
    public async Task Client_cannot_choose_the_content_type()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await Ok(await Post(c, "/api/uploads/video", new { fileName = "a.mkv", size = 10, contentType = "text/html", type = "text/html" }));
        Assert.Equal("video/x-matroska", f.Storage.LastContentType);
    }

    // --- Senaryo 6: yanlış uzantılar ----------------------------------------------------------

    [Theory]
    [InlineData("a.avi")]
    [InlineData("mkv")]
    [InlineData("a.mkv.exe")]
    [InlineData("a.mkvx")]
    [InlineData("a.mkv.html")]
    [InlineData("a.webm")]
    [InlineData("a.srt")]
    [InlineData(null)]
    public async Task Start_rejects_other_extensions_with_the_new_message(string? fileName)
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await AssertError(await Post(c, "/api/uploads/video", new { fileName, size = 10 }), HttpStatusCode.BadRequest, Error);
        Assert.Empty(f.Storage.Calls);
    }

    // --- Senaryo 11: boyut sınırı mkv için de geçerli -----------------------------------------

    [Theory]
    [InlineData(6_442_450_945L, "Dosya çok büyük")]
    [InlineData(0L, "Dosya boş")]
    [InlineData(-5L, "Dosya boş")]
    public async Task Size_limits_apply_to_mkv(long size, string error)
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await AssertError(await Post(c, "/api/uploads/video", new { fileName = "a.mkv", size }), HttpStatusCode.BadRequest, error);
        Assert.Empty(f.Storage.Calls);
    }

    [Fact]
    public async Task Exactly_6_GB_mkv_is_accepted()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await Ok(await Post(c, "/api/uploads/video", new { fileName = "a.mkv", size = 6_442_450_944L }));
        Assert.Equal("video/x-matroska", f.Storage.LastContentType);
    }

    // --- Senaryo 7: anahtar doğrulaması (parts / complete / abort) ----------------------------

    private static readonly string MkvKey = $"videolar/{Hex}/a.mkv";

    [Fact]
    public async Task Mkv_key_is_accepted_by_parts_complete_and_abort()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();

        var parts = await Ok(await Post(c, "/api/uploads/video/parts", new { key = MkvKey, uploadId = "u1", partNumbers = new[] { 1, 2 } }));
        Assert.Equal(2, parts.GetProperty("urls").GetArrayLength());

        var done = await Ok(await Post(c, "/api/uploads/video/complete",
            new { key = MkvKey, uploadId = "u1", parts = new[] { new { partNumber = 1, eTag = "\"a\"" }, new { partNumber = 2, eTag = "\"b\"" } } }));
        Assert.Equal($"https://cdn.example.net/{MkvKey}", done.GetProperty("url").GetString());

        await Ok(await Post(c, "/api/uploads/video/abort", new { key = MkvKey, uploadId = "u1" }));
        Assert.Equal(
            [$"part {MkvKey} u1 1", $"part {MkvKey} u1 2", $"complete {MkvKey} u1", $"abort {MkvKey} u1"],
            f.Storage.Calls.ToArray());
    }

    public static TheoryData<string> BadMkvKeys() => new()
    {
        $"videolar/{Hex}/a.mkvx",
        $"videolar/{Hex}/a.mkv.exe",
        $"videolar/{Hex}/a.MKV",
        $"videolar/{Hex}/A.mkv",
        $"videolar/{Hex}/.mkv",
        $"videolar/{Hex}/a..mkv",
        $"videolar/{Hex}/a.mkv/x",
        $"videolar/{Hex}/../a.mkv",
        $"videolar/{Hex}/{new string('a', 81)}.mkv",
        $"videolar/{Hex.ToUpperInvariant()}/a.mkv",
        $"baska/{Hex}/a.mkv",
        $"videolar/{Hex}/a.mkv\n",
        $"videolar/{Hex}/a.mkv%00.exe",
    };

    [Theory]
    [MemberData(nameof(BadMkvKeys))]
    public async Task Malformed_mkv_keys_are_rejected_everywhere(string key)
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
    public async Task Mkv_key_is_not_a_subtitle_key_and_subtitle_endpoint_still_rejects_mkv()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        await AssertError(await Post(c, "/api/uploads/subtitle", new { fileName = "a.mkv", size = 10 }), HttpStatusCode.BadRequest, "Yalnızca .srt veya .vtt yüklenebilir");
        Assert.Empty(f.Storage.Calls);
    }

    // --- Güvenlik: anahtar zorunluluğu mkv için de geçerli ------------------------------------

    [Fact]
    public async Task Mkv_endpoints_still_require_the_upload_key()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var wrong = AliKey[..^1] + "Q";
        foreach (var key in new string?[] { null, wrong })
        {
            await AssertError(await Post(c, "/api/uploads/video", new { fileName = "a.mkv", size = 10 }, key), HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
            await AssertError(await Post(c, "/api/uploads/video/parts", new { key = MkvKey, uploadId = "u", partNumbers = new[] { 1 } }, key), HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
            await AssertError(await Post(c, "/api/uploads/video/complete", new { key = MkvKey, uploadId = "u", parts = new[] { new { partNumber = 1, eTag = "e" } } }, key), HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
            await AssertError(await Post(c, "/api/uploads/video/abort", new { key = MkvKey, uploadId = "u" }, key), HttpStatusCode.Unauthorized, "Yükleme anahtarı geçersiz");
        }
        Assert.Empty(f.Storage.Calls);
    }

    // --- Uçtan uca akış (S3 sahte): başlat → parça adresleri → tamamla → lobiye uygun URL ------

    [Fact]
    public async Task Full_mkv_upload_flow_yields_a_lobby_acceptable_url()
    {
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        var start = await Ok(await Post(c, "/api/uploads/video", new { fileName = "Film.mkv", size = 16_777_216L + 1 }));
        var key = start.GetProperty("key").GetString()!;
        var uploadId = start.GetProperty("uploadId").GetString()!;
        Assert.True(FileNames.IsValidKey(key));

        var urls = await Ok(await Post(c, "/api/uploads/video/parts", new { key, uploadId, partNumbers = new[] { 1, 2 } }));
        Assert.Equal(2, urls.GetProperty("urls").GetArrayLength());

        var done = await Ok(await Post(c, "/api/uploads/video/complete",
            new { key, uploadId, parts = new[] { new { partNumber = 1, eTag = "\"a\"" }, new { partNumber = 2, eTag = "\"b\"" } } }));
        var url = done.GetProperty("url").GetString()!;

        Assert.EndsWith(".mkv", url);
        Assert.True(url.Length <= 200);
        Assert.Null(MediaValidator.Validate("file", url));
        Assert.Equal("video/x-matroska", f.Storage.LastContentType);
    }

    [Fact]
    public async Task Every_declared_video_extension_starts_an_upload_and_yields_a_valid_key()
    {
        // Senkron testi: VideoExtensions, regex ve uç nokta aynı kümeyi bilmeli.
        using var f = new UploadFactory(Settings());
        using var c = f.CreateClient();
        foreach (var ext in FileNames.VideoExtensions)
        {
            var body = await Ok(await Post(c, "/api/uploads/video", new { fileName = $"x.{ext}", size = 10 }));
            Assert.True(FileNames.IsValidKey(body.GetProperty("key").GetString()), ext);
            Assert.True(FileNames.IsValidKey($"videolar/{Hex}/a.{ext}"), ext);
            Assert.Equal(FileNames.ContentTypeFor(ext), f.Storage.LastContentType);
        }
    }

    // --- FileNames birim sözleşmesi -----------------------------------------------------------

    [Theory]
    [InlineData("mp4", "video/mp4")]
    [InlineData("m4v", "video/mp4")]
    [InlineData("mkv", "video/x-matroska")]
    public void ContentTypeFor_maps_known_video_extensions(string ext, string expected)
        => Assert.Equal(expected, FileNames.ContentTypeFor(ext));

    [Theory]
    [InlineData("MKV")]
    [InlineData(".mkv")]
    [InlineData("avi")]
    [InlineData("srt")]
    [InlineData("vtt")]
    [InlineData("mkv ")]
    [InlineData("")]
    [InlineData(null)]
    public void ContentTypeFor_rejects_everything_else_instead_of_defaulting_to_mp4(string? ext)
        => Assert.ThrowsAny<ArgumentException>(() => FileNames.ContentTypeFor(ext!));

    [Theory]
    [InlineData("a.mkv", true)]
    [InlineData("a.mp4", true)]
    [InlineData("a.m4v", true)]
    [InlineData("a.srt", true)]
    [InlineData("a.vtt", true)]
    [InlineData("a.mkvx", false)]
    [InlineData("a.mkv.exe", false)]
    [InlineData("a.MKV", false)]
    [InlineData("a.avi", false)]
    [InlineData("a.webm", false)]
    public void IsValidKey_extension_set(string name, bool valid)
        => Assert.Equal(valid, FileNames.IsValidKey($"videolar/{Hex}/{name}"));

    [Fact]
    public void Clean_keeps_the_mkv_extension_and_lowercases_it()
    {
        Assert.Equal("guzel-film.mkv", FileNames.Clean("Güzel Film.MKV", "video"));
        Assert.Equal("video.mkv", FileNames.Clean("???.mkv", "video"));
    }

    [Fact]
    public void Longest_mkv_key_fits_MaxKeyLength()
    {
        var key = $"videolar/{Hex}/{new string('a', FileNames.MaxNameLength)}.mkv";
        Assert.True(FileNames.IsValidKey(key));
        Assert.True(key.Length <= FileNames.MaxKeyLength);
    }

    // --- Lobi: elle yapıştırılan MKV URL'si ---------------------------------------------------

    [Fact]
    public void Lobby_media_validator_accepts_https_mkv_and_rejects_plain_http()
    {
        Assert.Null(MediaValidator.Validate("file", $"https://cdn.example.net/videolar/{Hex}/a.mkv"));
        Assert.NotNull(MediaValidator.Validate("file", $"http://cdn.example.net/videolar/{Hex}/a.mkv"));
    }
}
