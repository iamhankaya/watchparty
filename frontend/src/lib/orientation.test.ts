import { describe, expect, it, vi } from "vitest";
import { lockLandscape, unlockOrientation, type OrientationEnv } from "./orientation";

function env(isTouch: boolean, lock?: () => Promise<void>) {
  const unlock = vi.fn();
  const e: OrientationEnv = { isTouch: () => isTouch, orientation: { lock: lock && vi.fn(lock), unlock } };
  return { e, unlock };
}

describe("yön kilidi", () => {
  it("dokunmatik cihazda yataya kilitler, çıkışta kilidi kaldırır", () => {
    const { e, unlock } = env(true, () => Promise.resolve());
    lockLandscape(e);
    expect(e.orientation?.lock).toHaveBeenCalledWith("landscape");
    unlockOrientation(e);
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it("fare kullanılan cihazda kilitlemez ve kilit kaldırmaz", () => {
    const { e, unlock } = env(false, () => Promise.resolve());
    lockLandscape(e);
    unlockOrientation(e);
    expect(e.orientation?.lock).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
  });

  it("reddedilen kilit isteği hata fırlatmaz, sonra unlock çağrılmaz", async () => {
    const { e, unlock } = env(true, () => Promise.reject(new Error("NotSupportedError")));
    expect(() => lockLandscape(e)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    unlockOrientation(e);
    expect(unlock).not.toHaveBeenCalled();
  });

  it("senkron hata fırlatan ya da hiç olmayan API'de sessiz kalır", () => {
    const { e } = env(true, () => {
      throw new Error("yok");
    });
    expect(() => lockLandscape(e)).not.toThrow();
    expect(() => lockLandscape({ isTouch: () => true, orientation: undefined })).not.toThrow();
    expect(() => unlockOrientation({ isTouch: () => true, orientation: undefined })).not.toThrow();
  });

  it("çıkışta kilit kaldırmanın hatası yutulur", () => {
    const e: OrientationEnv = {
      isTouch: () => true,
      orientation: {
        lock: () => Promise.resolve(),
        unlock: () => {
          throw new Error("InvalidStateError");
        },
      },
    };
    lockLandscape(e);
    expect(() => unlockOrientation(e)).not.toThrow();
  });
});
