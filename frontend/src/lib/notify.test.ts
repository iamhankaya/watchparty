import { describe, expect, it } from "vitest";
import { isChatVisible, playBlip, shouldNotify, titleWithCount } from "./notify";

const base = { fromSelf: false, history: false, visible: false, soundOn: true, lastSoundAt: 0, now: 10_000 };

describe("shouldNotify", () => {
  it("görünmeyen sohbette gelen mesajda çalar", () => {
    expect(shouldNotify(base)).toBe(true);
  });
  it("kendi mesajında çalmaz", () => {
    expect(shouldNotify({ ...base, fromSelf: true })).toBe(false);
  });
  it("geçmiş mesajında çalmaz", () => {
    expect(shouldNotify({ ...base, history: true })).toBe(false);
  });
  it("sohbet görünürken çalmaz", () => {
    expect(shouldNotify({ ...base, visible: true })).toBe(false);
  });
  it("ses kapalıyken çalmaz", () => {
    expect(shouldNotify({ ...base, soundOn: false })).toBe(false);
  });
  it("2 sn içinde tekrar çalmaz, 2 sn dolunca çalar", () => {
    expect(shouldNotify({ ...base, lastSoundAt: 9_001 })).toBe(false);
    expect(shouldNotify({ ...base, lastSoundAt: 8_000 })).toBe(true);
  });
});

describe("isChatVisible", () => {
  const v = { hidden: false, focused: true, fullscreen: false, chatOpen: false };
  it("sekme açık ve odakta ise görünür", () => {
    expect(isChatVisible(v)).toBe(true);
  });
  it("sekme gizliyse görünmez", () => {
    expect(isChatVisible({ ...v, hidden: true })).toBe(false);
  });
  it("odak yoksa görünmez", () => {
    expect(isChatVisible({ ...v, focused: false })).toBe(false);
  });
  it("tam ekranda sohbet kapalıysa görünmez, açıksa görünür", () => {
    expect(isChatVisible({ ...v, fullscreen: true, chatOpen: false })).toBe(false);
    expect(isChatVisible({ ...v, fullscreen: true, chatOpen: true })).toBe(true);
  });
});

describe("titleWithCount", () => {
  it("0 iken başlığı aynen döndürür", () => {
    expect(titleWithCount("WatchParty", 0)).toBe("WatchParty");
  });
  it("sayıyı öne ekler", () => {
    expect(titleWithCount("WatchParty", 3)).toBe("(3) WatchParty");
  });
});

describe("playBlip", () => {
  it("AudioContext yokken hata fırlatmaz", () => {
    expect(() => playBlip()).not.toThrow();
  });
});
