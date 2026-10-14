import { describe, expect, test } from "vitest";
import { isSpeaking, SpeakingDetector } from "./speaking";

describe("isSpeaking", () => {
  test("eşik altı ses konuşma sayılmaz", () => {
    const state = { lastLoudAt: -Infinity };
    expect(isSpeaking(state, 0.039, 1000)).toBe(false);
    expect(state.lastLoudAt).toBe(-Infinity);
  });

  test("eşik ve üstü konuşmadır, lastLoudAt güncellenir", () => {
    const state = { lastLoudAt: -Infinity };
    expect(isSpeaking(state, 0.04, 1000)).toBe(true);
    expect(state.lastLoudAt).toBe(1000);
  });

  test("ses kesildikten sonra 300 ms boyunca konuşuyor kalır", () => {
    const state = { lastLoudAt: -Infinity };
    isSpeaking(state, 0.2, 1000);
    expect(isSpeaking(state, 0, 1100)).toBe(true);
    expect(isSpeaking(state, 0, 1299)).toBe(true);
    expect(isSpeaking(state, 0, 1300)).toBe(false);
  });

  test("eşik ve tutma süresi değiştirilebilir", () => {
    const state = { lastLoudAt: -Infinity };
    expect(isSpeaking(state, 0.05, 0, { threshold: 0.1 })).toBe(false);
    expect(isSpeaking(state, 0.1, 0, { threshold: 0.1, holdMs: 50 })).toBe(true);
    expect(isSpeaking(state, 0, 49, { threshold: 0.1, holdMs: 50 })).toBe(true);
    expect(isSpeaking(state, 0, 50, { threshold: 0.1, holdMs: 50 })).toBe(false);
  });
});

describe("SpeakingDetector", () => {
  test("AudioContext olmayan ortamda kurulup kullanılabilir (hata atmaz)", () => {
    const d = new SpeakingDetector();
    const off = d.onChange(() => {});
    expect(() => d.watch("a", {} as MediaStream)).not.toThrow();
    d.unwatch("a");
    off();
    d.stop();
  });
});
