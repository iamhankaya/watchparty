using WatchParty.Api.Lobbies;

namespace WatchParty.Api.Tests;

public class MediaValidatorTests
{
    [Theory]
    [InlineData("youtube", "dQw4w9WgXcQ")]
    [InlineData("file", "https://cdn.example.com/film.mp4")]
    [InlineData("file", "https://cdn.example.com/f.mp4?X-Amz-Signature=abc&X-Amz-Expires=3600")]
    public void Accepts_valid(string type, string id) => Assert.Null(MediaValidator.Validate(type, id));

    [Theory]
    [InlineData("vimeo", "x", "Medya tipi")]
    [InlineData("youtube", "", "Geçersiz medya id")]
    [InlineData("youtube", "dQw4w9WgXc", "YouTube")] // 10 karakter
    [InlineData("youtube", "dQw4w9WgXcQ!", "YouTube")]
    [InlineData("youtube", "<script>xx>", "YouTube")]
    [InlineData("youtube", "dQw4w9WgXcQ\n", "YouTube")] // sondaki satır sonu
    [InlineData("file", "http://cdn.example.com/a.mp4", "https")]
    [InlineData("file", "javascript:alert(1)", "https")]
    [InlineData("file", "/relative/a.mp4", "https")]
    public void Rejects_invalid(string type, string id, string messagePart) =>
        Assert.Contains(messagePart, MediaValidator.Validate(type, id));

    [Fact]
    public void Rejects_url_over_200_chars()
    {
        var url = "https://a.com/" + new string('a', 187); // 201 karakter
        Assert.Equal(201, url.Length);
        Assert.Equal("Geçersiz medya id", MediaValidator.Validate("file", url));
    }
}
