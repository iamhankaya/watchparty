import type { Player } from "../players/Player";
import type { ServerClock } from "./clock";
import { expectedPosition, type PlaybackState } from "./types";

const SEEK_THRESHOLD_PLAYING = 1.5; // mimari kararı: 1,5 sn üstü sapmada doğrudan seek
const SEEK_THRESHOLD_PAUSED = 0.15; // durmuşken seek ucuz, konum tam tutsun (HTML5)
const SEEK_THRESHOLD_PAUSED_COARSE = 0.5; // YouTube seek'i kare hassasiyetinde değil, döngüye girmesin
const RATE_THRESHOLD = 0.3; // 0,3-1,5 sn arası: HTML5'te hızla sessiz yakalama
const RATE_TARGET = 0.08; // yakalamaya başlayınca bu kadar yaklaşana kadar devam et
const SEEK_COOLDOWN_MS = 2000; // seek sonrası oynatıcı yüklenirken tekrar tekrar seek etmeyelim
const BLOCKED_AFTER_TICKS = 4;
const TICK_MS = 500;

/**
 * Sunucudaki doğru durumu yerel oynatıcıya uygular.
 * Oynatıcının kendi olaylarını hiç dinlemez: kullanıcı niyeti sadece bizim kontrol butonlarımızdan
 * sunucuya gider. Böylece "kodla yapılan seek'i tekrar sunucuya göndermek" döngüsü oluşamaz.
 */
export class SyncEngine {
  private player: Player | null = null;
  private state: PlaybackState | null = null;
  private timer: number | undefined;
  private lastSeekAt = 0;
  private notPlayingTicks = 0;
  private blocked = false;
  private rate = 1;

  constructor(
    private clock: ServerClock,
    private onBlockedChange: (blocked: boolean) => void,
  ) {}

  start() {
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  setPlayer(player: Player | null) {
    this.player = player;
    this.lastSeekAt = 0;
    this.notPlayingTicks = 0;
    this.tick();
  }

  setState(state: PlaybackState) {
    this.state = state;
    this.lastSeekAt = 0; // açık bir değişiklik geldi, bekleme süresini yok say
    this.notPlayingTicks = 0;
    this.tick();
  }

  /** Kontrol çubuğunun göstereceği "şu anki" konum. */
  currentPosition(): number {
    if (this.player?.isReady()) return this.player.getTime();
    return this.state ? expectedPosition(this.state, this.clock.now()) : 0;
  }

  duration(): number {
    return this.player?.isReady() ? this.player.getDuration() : 0;
  }

  /** Kullanıcı tıklamasıyla çağrılır; tarayıcının otomatik oynatma engelini kaldırır. */
  async unblock() {
    if (this.player && (await this.player.play())) this.setBlocked(false);
    this.notPlayingTicks = 0;
  }

  private setBlocked(blocked: boolean) {
    if (blocked !== this.blocked) {
      this.blocked = blocked;
      this.onBlockedChange(blocked);
    }
  }

  private tick() {
    const p = this.player;
    const s = this.state;
    if (!p || !s?.mediaId || !p.isReady()) return;

    const duration = p.getDuration();
    let target = expectedPosition(s, this.clock.now());
    const ended = duration > 0 && target >= duration - 0.25;
    if (ended) target = duration;
    const shouldPlay = s.isPlaying && !ended;

    if (shouldPlay) {
      if (p.isPlaying()) {
        this.notPlayingTicks = 0;
        this.setBlocked(false);
      } else {
        void p.play().then((ok) => {
          if (!ok) this.setBlocked(true);
        });
        if (++this.notPlayingTicks >= BLOCKED_AFTER_TICKS) this.setBlocked(true);
      }
    } else {
      if (p.isPlaying()) p.pause();
      this.notPlayingTicks = 0;
      this.setBlocked(false);
    }

    const drift = p.getTime() - target;
    const threshold = shouldPlay
      ? SEEK_THRESHOLD_PLAYING
      : p.supportsRate
        ? SEEK_THRESHOLD_PAUSED
        : SEEK_THRESHOLD_PAUSED_COARSE;
    const now = Date.now();
    if (Math.abs(drift) > threshold) {
      if (now - this.lastSeekAt > SEEK_COOLDOWN_MS) {
        p.seek(target);
        this.applyRate(p, 1);
        this.lastSeekAt = now;
      }
      return;
    }

    if (p.supportsRate) {
      // Histerezis: 0,3 sn'yi aşınca hızlan/yavaşla, 0,08 sn'ye inene kadar sürdür.
      const limit = this.rate === 1 ? RATE_THRESHOLD : RATE_TARGET;
      let rate = 1;
      if (shouldPlay && drift < -limit) rate = 1.05;
      else if (shouldPlay && drift > limit) rate = 0.95;
      this.applyRate(p, rate);
    }
  }

  private applyRate(p: Player, rate: number) {
    this.rate = rate;
    p.setRate(rate);
  }
}
