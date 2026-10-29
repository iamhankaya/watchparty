using WatchParty.Api.Uploads;

namespace WatchParty.Api.Tests;

// MKV desteği sözleşmesi (T20261029-25): şekil ve mevcut davranışın korunması; iş mantığı yok.
public class FileNamesContractTests
{
    [Fact]
    public void Video_extensions_are_the_agreed_set()
    {
        Assert.Equal(["m4v", "mkv", "mp4"], FileNames.VideoExtensions.Order());
    }

    [Fact]
    public void Video_extension_error_lists_every_video_extension()
    {
        Assert.Equal("Yalnızca .mp4, .m4v veya .mkv yüklenebilir", FileNames.VideoExtensionError);
        foreach (var ext in FileNames.VideoExtensions)
            Assert.Contains("." + ext, FileNames.VideoExtensionError);
    }

    [Fact]
    public void Content_type_helper_has_the_agreed_signature()
    {
        var method = typeof(FileNames).GetMethod(nameof(FileNames.ContentTypeFor), [typeof(string)]);
        Assert.NotNull(method);
        Assert.Equal(typeof(string), method!.ReturnType);
        Assert.True(method.IsPublic && method.IsStatic);
    }

    [Fact]
    public void Matroska_content_type_constant_is_x_matroska()
    {
        // Spec önerisi video/x-matroska; Chromium ikisini de tanır, seçim burada sabitlenir.
        Assert.Equal("video/x-matroska", FileNames.MatroskaContentType);
    }

    [Fact]
    public void Mp4_content_type_constant_is_video_mp4()
    {
        Assert.Equal("video/mp4", FileNames.Mp4ContentType);
    }

    [Theory]
    [InlineData("videolar/0123456789abcdef0123456789abcdef/a.mp4")]
    [InlineData("videolar/0123456789abcdef0123456789abcdef/a.m4v")]
    [InlineData("videolar/0123456789abcdef0123456789abcdef/a.srt")]
    [InlineData("videolar/0123456789abcdef0123456789abcdef/a.vtt")]
    public void Existing_extensions_stay_valid_keys(string key)
    {
        Assert.True(FileNames.IsValidKey(key));
    }

    [Theory]
    [InlineData("mp4", "video/mp4")]
    [InlineData("m4v", "video/mp4")]
    [InlineData("mkv", "video/x-matroska")]
    public void Content_type_follows_extension(string ext, string expected)
    {
        Assert.Equal(expected, FileNames.ContentTypeFor(ext));
    }

    [Theory]
    [InlineData("MKV")]
    [InlineData(".mkv")]
    [InlineData("srt")]
    [InlineData("avi")]
    [InlineData("")]
    public void Content_type_rejects_everything_else(string ext)
    {
        Assert.Throws<ArgumentException>(() => FileNames.ContentTypeFor(ext));
    }

    [Fact]
    public void Content_type_rejects_null()
    {
        Assert.Throws<ArgumentException>(() => FileNames.ContentTypeFor(null!));
    }

    [Fact]
    public void Every_video_extension_makes_a_valid_key_and_lookalikes_are_not()
    {
        foreach (var ext in FileNames.VideoExtensions)
        {
            Assert.True(FileNames.IsValidKey($"videolar/0123456789abcdef0123456789abcdef/a.{ext}"), ext);
            Assert.Equal(ext == "mkv" ? "video/x-matroska" : "video/mp4", FileNames.ContentTypeFor(ext));
        }
        Assert.False(FileNames.IsValidKey("videolar/0123456789abcdef0123456789abcdef/a.mkvx"));
        Assert.False(FileNames.IsValidKey("videolar/0123456789abcdef0123456789abcdef/a.mkv.exe"));
        Assert.False(FileNames.IsValidKey("videolar/0123456789abcdef0123456789abcdef/a.MKV"));
    }
}
