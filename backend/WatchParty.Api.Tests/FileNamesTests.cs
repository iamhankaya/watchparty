using WatchParty.Api.Uploads;

namespace WatchParty.Api.Tests;

public class FileNamesTests
{
    [Theory]
    [InlineData("Güzel Şarkı ÇOK iyi.mp4", "video", "guzel-sarki-cok-iyi.mp4")]
    [InlineData("İĞNE ığne öçü.MP4", "video", "igne-igne-ocu.mp4")]
    [InlineData("  film   (2024) -- final!!.m4v", "video", "film-2024-final.m4v")]
    [InlineData("C:\\fakepath\\Bölüm 1.srt", "altyazi", "bolum-1.srt")]
    [InlineData("klasör/alt/ders.vtt", "altyazi", "ders.vtt")]
    [InlineData("café.mp4", "video", "cafe.mp4")]
    [InlineData("çğ şü.srt", "altyazi", "cg-su.srt")]
    public void Clean_converts_to_ascii_lowercase_dashes(string input, string fallback, string expected)
    {
        Assert.Equal(expected, FileNames.Clean(input, fallback));
    }

    [Theory]
    [InlineData(".mp4", "video", "video.mp4")]
    [InlineData("!!!.mp4", "video", "video.mp4")]
    [InlineData("", "altyazi", "altyazi")]
    [InlineData("---.vtt", "altyazi", "altyazi.vtt")]
    public void Clean_uses_fallback_for_empty_names(string input, string fallback, string expected)
    {
        Assert.Equal(expected, FileNames.Clean(input, fallback));
    }

    [Fact]
    public void Clean_limits_name_to_80_chars_and_keeps_extension()
    {
        var input = new string('a', 79) + " " + new string('b', 200) + ".mp4";
        var result = FileNames.Clean(input, "video");

        Assert.EndsWith(".mp4", result);
        var name = result[..^4];
        Assert.True(name.Length <= 80);
        Assert.False(name.EndsWith('-'));
        Assert.Equal(new string('a', 79), name);
    }

    [Fact]
    public void New_key_matches_pattern()
    {
        var key = FileNames.NewKey("ders-1.mp4");
        Assert.Matches(@"^videolar/[0-9a-f]{32}/ders-1\.mp4$", key);
        Assert.True(FileNames.IsValidKey(key));
        Assert.NotEqual(key, FileNames.NewKey("ders-1.mp4"));
    }

    [Theory]
    [InlineData("videolar/0123456789abcdef0123456789abcdef/a.mp4", true)]
    [InlineData("videolar/0123456789abcdef0123456789abcdef/a-b-1.vtt", true)]
    [InlineData("videolar/0123456789ABCDEF0123456789abcdef/a.mp4", false)]
    [InlineData("videolar/0123456789abcdef0123456789abcde/a.mp4", false)]
    [InlineData("videolar/0123456789abcdef0123456789abcdef/../a.mp4", false)]
    [InlineData("baska/0123456789abcdef0123456789abcdef/a.mp4", false)]
    [InlineData("videolar/0123456789abcdef0123456789abcdef/a.exe", false)]
    [InlineData("videolar/0123456789abcdef0123456789abcdef/a.mp4\n", false)]
    [InlineData("/videolar/0123456789abcdef0123456789abcdef/a.mp4", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Key_pattern(string? key, bool valid)
    {
        Assert.Equal(valid, FileNames.IsValidKey(key));
    }
}
