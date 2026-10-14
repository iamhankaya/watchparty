export const SPEAKING_THRESHOLD = 0.04; // RMS
export const SPEAKING_HOLD_MS = 300;
const SAMPLE_MS = 100;

/**
 * Saf karar fonksiyonu: seviye eşiğe ulaşırsa state.lastLoudAt = now olur; son yüksek
 * sesten bu yana holdMs geçmediyse konuşuyor sayılır (kelime aralarında gösterge titremesin).
 */
export function isSpeaking(
  state: { lastLoudAt: number },
  level: number,
  now: number,
  opts?: { threshold?: number; holdMs?: number },
): boolean {
  const threshold = opts?.threshold ?? SPEAKING_THRESHOLD;
  const holdMs = opts?.holdMs ?? SPEAKING_HOLD_MS;
  if (level >= threshold) state.lastLoudAt = now;
  return now - state.lastLoudAt < holdMs;
}

interface Watched {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  state: { lastLoudAt: number };
  speaking: boolean;
}

/**
 * Akışların konuşma durumunu yerelde hesaplar: tek AudioContext, akış başına AnalyserNode,
 * 100 ms'de bir RMS örneklemesi. Değişince onChange dinleyicileri çağrılır.
 * AudioContext yoksa (test/eski tarayıcı) sessizce hiçbir şey yapmaz.
 * İlk watch() kullanıcı etkileşiminden (sesli sohbete katıl tıklaması) çağrılmalı; aksi halde
 * tarayıcı AudioContext'i askıda başlatır (watch her çağrıda resume dener).
 * Not: Chrome'da uzak WebRTC akışı ayrıca bir <audio> öğesine bağlı değilse analyser sessizlik görür.
 */
export class SpeakingDetector {
  private ctx: AudioContext | null = null;
  private readonly watched = new Map<string, Watched>();
  private readonly listeners = new Set<(id: string, speaking: boolean) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  watch(id: string, stream: MediaStream): void {
    this.unwatch(id);
    const ctx = this.context();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // hoparlöre bağlanmaz; yalnızca ölçüm
      this.watched.set(id, {
        source,
        analyser,
        buf: new Float32Array(analyser.fftSize),
        state: { lastLoudAt: -Infinity },
        speaking: false,
      });
    } catch (err) {
      console.warn("Konuşma algılama başlatılamadı", err);
      return;
    }
    if (this.timer === null) this.timer = setInterval(() => this.sample(), SAMPLE_MS);
  }

  unwatch(id: string): void {
    const w = this.watched.get(id);
    if (!w) return;
    this.watched.delete(id);
    w.source.disconnect();
    w.analyser.disconnect();
    if (w.speaking) this.emit(id, false);
    if (this.watched.size === 0) this.clearTimer();
  }

  /** Dinleyici ekler; dönen fonksiyon dinleyiciyi kaldırır. */
  onChange(cb: (id: string, speaking: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  stop(): void {
    for (const id of [...this.watched.keys()]) this.unwatch(id);
    this.clearTimer();
    this.listeners.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof AudioContext === "undefined") return null;
    this.ctx = new AudioContext();
    return this.ctx;
  }

  private sample(): void {
    const now = performance.now();
    for (const [id, w] of this.watched) {
      w.analyser.getFloatTimeDomainData(w.buf);
      let sum = 0;
      for (const v of w.buf) sum += v * v;
      const rms = Math.sqrt(sum / w.buf.length);
      const speaking = isSpeaking(w.state, rms, now);
      if (speaking !== w.speaking) {
        w.speaking = speaking;
        this.emit(id, speaking);
      }
    }
  }

  private emit(id: string, speaking: boolean): void {
    for (const cb of this.listeners) cb(id, speaking);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
