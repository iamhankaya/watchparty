/**
 * Sunucu saatine olan farkı tahmin eder (basit NTP).
 * offset = sunucuSaati - (t0 + t1) / 2. En kısa gidiş-dönüşlü ölçüm en güvenilir olanıdır.
 */
export class ServerClock {
  private offset = 0;
  private bestRtt = Infinity;

  now(): number {
    return Date.now() + this.offset;
  }

  async sync(ping: () => Promise<number>, samples = 5): Promise<void> {
    let best = { rtt: Infinity, offset: 0 };
    for (let i = 0; i < samples; i++) {
      const t0 = Date.now();
      const server = await ping();
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (rtt < best.rtt) best = { rtt, offset: server - (t0 + t1) / 2 };
    }
    // Ağ geçici olarak yavaşsa eski ve daha iyi ölçümü bozmayalım (ama çok eskiyse yine güncelle).
    if (best.rtt <= this.bestRtt * 1.5 || !Number.isFinite(this.bestRtt)) {
      this.offset = best.offset;
      this.bestRtt = best.rtt;
    } else {
      this.bestRtt *= 1.2;
    }
  }
}
