// Mobilde tam ekrana geçince ekranı yataya kilitler (Android Chrome). Yön kilidi yalnızca tam ekranda
// çalışır; masaüstünde ve iPhone Safari'de desteklenmez, oralarda hata sessizce yok sayılır.

// TypeScript'in DOM tiplerinde ScreenOrientation.lock yok; kullandığımız kadarı burada tanımlı.
interface LockableOrientation {
  lock?(orientation: "landscape"): Promise<void>;
  unlock?(): void;
}

export interface OrientationEnv {
  isTouch(): boolean;
  orientation: LockableOrientation | undefined;
}

function browserEnv(): OrientationEnv {
  return {
    isTouch: () => window.matchMedia?.("(pointer: coarse)").matches ?? false,
    orientation: screen.orientation as LockableOrientation | undefined,
  };
}

let locked = false;

export function lockLandscape(env: OrientationEnv = browserEnv()): void {
  if (!env.isTouch() || !env.orientation?.lock) return;
  try {
    locked = true;
    env.orientation.lock("landscape").catch(() => {
      locked = false;
    });
  } catch {
    locked = false;
  }
}

export function unlockOrientation(env: OrientationEnv = browserEnv()): void {
  if (!locked) return;
  locked = false;
  try {
    env.orientation?.unlock?.();
  } catch {
    // Kilit zaten kalkmış olabilir.
  }
}
