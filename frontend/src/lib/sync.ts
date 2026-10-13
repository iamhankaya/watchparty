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
const BUFFERING_REPORT_MS = 1000; // oynaması gerekirken bu kadar art arda takılan "takıldım" bildirir
const CATCH_UP_MARGIN = 0.3; // kendi beklemesinde donmuş konuma bu kadar yaklaşınca "yetiştim" denir
const TICK_MS = 500;

/**
 * Sunucudaki doğru durumu yerel oynatıcıya uygular.
 * Oynatıcının kendi olaylarını hiç dinlemez: kullanıcı niyeti sadece bizim kontrol butonlarımızdan
 * sunucuya gider. Böylece "kodla yapılan seek'i tekrar sunucuya göndermek" döngüsü oluşamaz.
 * Tek istisna takılma bildirimidir (onBuffering): konum/seek/oynat-durdur değil, yalnızca
 * "takıldım / yetiştim" bilgisi gider.
 */
export class SyncEngine {
  private player: Player | null = null;
  private state: PlaybackState | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSeekAt = 0;
  private notPlayingTicks = 0;
  private blocked = false;
  private rate = 1;
  private selfId: string | null = null;
  private bufferingSince: number | null = null; // art arda takılmanın başladığı an (Date.now)
  private reportedBuffering = false; // onBuffering(true) gönderildi, henüz false gönderilmedi
  private recoverySent = false; // listede olduğumuz durum için false gönderildi; sonraki setState'te temizlenir

  constructor(
    private clock: ServerClock,
    private onBlockedChange: (blocked: boolean) => void,
    private onBuffering: (buffering: boolean) => void,
  ) {}

  start() {
    this.timer = globalThis.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Kendi katılımcı kimliğimiz (JoinLobby'nin selfId'si); waitingFor içinde kendimizi tanımak için. */
  setSelfId(id: string | null) {
    this.selfId = id;
    // Kimlik değişti (yeniden bağlanma): sunucu eski kimliği listeden zaten çıkarmıştır.
    this.bufferingSince = null;
    this.reportedBuffering = false;
  }

  setPlayer(player: Player | null) {
    this.player = player;
    this.lastSeekAt = 0;
    this.notPlayingTicks = 0;
    this.bufferingSince = null;
    this.tick();
  }

  setState(state: PlaybackState) {
    const prev = this.state;
    if (!prev || prev.mediaId !== state.mediaId || prev.isPlaying !== state.isPlaying) {
      // Yeni medya ya da oynat/durdur: takılma sayacı baştan başlar; sunucu listeyi zaten boşaltmıştır.
      this.bufferingSince = null;
      this.reportedBuffering = false;
    }
    this.state = state;
    this.recoverySent = false;
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
    if (!p || !s?.mediaId || !p.isReady()) {
      // Oynatıcı hazır değilken eski bir başlangıç anı kalırsa hazır olunca anında bildirim giderdi.
      this.bufferingSince = null;
      return;
    }

    const duration = p.getDuration();
    let target = expectedPosition(s, this.clock.now());
    const ended = duration > 0 && target >= duration - 0.25;
    if (ended) target = duration;
    const waitingFor = s.waitingFor ?? [];
    const selfWaiting = this.selfId !== null && waitingFor.includes(this.selfId);
    // Başkası bekleniyorsa hedef donmuştur ve oynatıcı durup konumu tutar; kendimiz bekleniyorsak
    // yüklemeye devam etmek için oynamayı sürdürürüz.
    const shouldPlay = s.isPlaying && !ended && (waitingFor.length === 0 || selfWaiting);

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

    this.trackBuffering(p, shouldPlay, selfWaiting, target);

    if (selfWaiting) {
      // Herkes bizi bekliyor: donmuş konuma göre seek/hız düzeltmesi yapma, sadece yüklemeye devam et.
      // Devam sonrası küçük sapmayı normal hız düzeltmesi toplar.
      if (p.supportsRate && this.rate !== 1) this.applyRate(p, 1);
      return;
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

  /**
   * Art arda BUFFERING_REPORT_MS takılmada bir kez true bildirir. Takılma bitip oynayınca bir kez false
   * bildirir; listede (waitingFor) olduğumuzda ise ancak donmuş konuma yetişince. Listede olmak da
   * "bildirilmiş" sayılır: başka birinin yayını bizimkinden önce gelip bayrağı kaybettirse bile false gider.
   */
  private trackBuffering(p: Player, shouldPlay: boolean, selfWaiting: boolean, target: number) {
    if (!shouldPlay) {
      // Oynaması gerekmiyorsa (durdu, bitti, başkası bekleniyor) takılma sayılmaz. Bildirim bayrağı
      // korunur; yalnızca medya/oynat-durdur değişimi ve setSelfId sıfırlar.
      this.bufferingSince = null;
      return;
    }
    const now = Date.now();
    if (!this.blocked && p.isBuffering()) {
      this.bufferingSince ??= now;
      if (
        !this.reportedBuffering &&
        !selfWaiting &&
        now - this.bufferingSince >= BUFFERING_REPORT_MS
      ) {
        this.reportedBuffering = true;
        this.onBuffering(true);
      }
      return;
    }
    this.bufferingSince = null;
    if (!p.isPlaying() || p.isBuffering()) return;
    if (selfWaiting) {
      // Sunucu konumu diğerlerinin bulunduğu yerde dondurdu; oraya yetişmeden devam dersek geride kalırız
      // (YouTube'da yakalama seek'i yeniden takılır). Beklemenin üst sınırı sunucudaki MaxWait.
      if (this.recoverySent || p.getTime() < target - CATCH_UP_MARGIN) return;
      this.recoverySent = true;
      this.reportedBuffering = false;
      this.onBuffering(false);
    } else if (this.reportedBuffering) {
      this.reportedBuffering = false;
      this.onBuffering(false);
    }
  }

  private applyRate(p: Player, rate: number) {
    this.rate = rate;
    p.setRate(rate);
  }
}
