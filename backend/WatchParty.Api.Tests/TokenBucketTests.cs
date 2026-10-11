using System.Diagnostics;
using Microsoft.Extensions.Time.Testing;
using WatchParty.Api.Security;

namespace WatchParty.Api.Tests;

public class TokenBucketTests
{
    private static int Drain(TokenBucket bucket)
    {
        var n = 0;
        while (n < 1000 && bucket.TryTake()) n++;
        return n;
    }

    [Fact]
    public void Starts_full_and_rejects_after_burst()
    {
        var bucket = new TokenBucket(5, 1, new FakeTimeProvider());

        for (var i = 0; i < 5; i++) Assert.True(bucket.TryTake());
        Assert.False(bucket.TryTake());
    }

    [Fact]
    public void Refills_at_rate()
    {
        var time = new FakeTimeProvider();
        var bucket = new TokenBucket(5, 1, time);
        Drain(bucket);

        time.Advance(TimeSpan.FromSeconds(1));
        Assert.True(bucket.TryTake());
        Assert.False(bucket.TryTake());

        time.Advance(TimeSpan.FromMilliseconds(500));
        Assert.False(bucket.TryTake());
        time.Advance(TimeSpan.FromMilliseconds(500));
        Assert.True(bucket.TryTake());
    }

    [Fact]
    public void Refill_never_exceeds_burst()
    {
        var time = new FakeTimeProvider();
        var bucket = new TokenBucket(5, 1, time);
        Drain(bucket);

        time.Advance(TimeSpan.FromHours(1));

        Assert.Equal(5, Drain(bucket));
    }

    [Fact]
    public void Negative_elapsed_time_is_ignored()
    {
        // FakeTimeProvider geri gidemediği için geri gidebilen basit bir saat kullanılır.
        var time = new SteppableTimeProvider();
        var bucket = new TokenBucket(5, 1, time);
        Drain(bucket);

        time.Shift(TimeSpan.FromSeconds(-10));
        Assert.False(bucket.TryTake());

        time.Shift(TimeSpan.FromSeconds(10));
        Assert.False(bucket.TryTake());

        time.Shift(TimeSpan.FromSeconds(1));
        Assert.True(bucket.TryTake());
        Assert.False(bucket.TryTake());
    }

    private sealed class SteppableTimeProvider : TimeProvider
    {
        private long _ticks = Stopwatch.Frequency * 100;

        public override long TimestampFrequency => Stopwatch.Frequency;
        public override long GetTimestamp() => _ticks;
        public void Shift(TimeSpan delta) => _ticks += (long)(delta.TotalSeconds * Stopwatch.Frequency);
    }
}
