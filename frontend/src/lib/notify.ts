// Sohbet bildirimi: karar fonksiyonları ve küçük ses yardımcısı.

const MIN_SOUND_GAP_MS = 2000;

export function shouldNotify(opts: {
  fromSelf: boolean;
  history: boolean;
  visible: boolean;
  soundOn: boolean;
  lastSoundAt: number;
  now: number;
}): boolean {
  if (opts.fromSelf || opts.history || opts.visible || !opts.soundOn) return false;
  return opts.now - opts.lastSoundAt >= MIN_SOUND_GAP_MS;
}

// Sohbet kullanıcının gözü önünde mi: sekme açık, odakta ve (tam ekrandaysa) sohbet paneli açık.
export function isChatVisible(opts: {
  hidden: boolean;
  focused: boolean;
  fullscreen: boolean;
  chatOpen: boolean;
}): boolean {
  if (opts.hidden || !opts.focused) return false;
  return !opts.fullscreen || opts.chatOpen;
}

export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

let ctx: AudioContext | null = null;

// Kısa, yumuşak bir tık sesi. Tarayıcı izin vermezse ya da AudioContext yoksa sessiz kalır.
export function playBlip(): void {
  try {
    const Ctor: typeof AudioContext | undefined =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    const c = ctx;
    void Promise.resolve(c.resume?.()).catch(() => {});
    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.13);
  } catch {
    // ses çalınamazsa sessizce geç
  }
}
