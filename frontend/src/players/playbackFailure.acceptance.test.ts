import { describe, expect, test } from "vitest";
import { classifyMediaError, FAILURE_MESSAGES } from "./playbackFailure";

// Kabul testleri (T20261029-26), spec senaryo 8, 9 ve oynatıcı hata tablosu: MediaError.code → tür.
// FilePlayer'ın DOM `error` olayı simülasyonu bu projede vitest ortamı node olduğundan (jsdom yok) yazılamadı;
// bkz. kapanış raporu "Açık noktalar".

describe("classifyMediaError", () => {
  test("2 → network, 3 → decode, 4 → unsupported", () => {
    expect(classifyMediaError(2)).toBe("network");
    expect(classifyMediaError(3)).toBe("decode");
    expect(classifyMediaError(4)).toBe("unsupported");
  });

  test("1 (aborted), 0, bilinmeyen kod ve undefined ölümcül değil: null", () => {
    for (const code of [1, 0, 5, 99, -1, undefined]) expect(classifyMediaError(code), String(code)).toBeNull();
  });

  test("senaryo 8/9: desteksiz kaynak genel 'MP4 URL' mesajına düşmez", () => {
    const kind = classifyMediaError(4);
    expect(kind).toBe("unsupported");
    const msg = FAILURE_MESSAGES[kind!];
    expect(msg).toContain("bu tarayıcıda oynatılamıyor");
    expect(msg).not.toMatch(/MP4 dosyasına/);
  });

  test("ağ hatası codec hatası gibi sunulmaz", () => {
    expect(FAILURE_MESSAGES[classifyMediaError(2)!]).toBe("Video yüklenemedi.");
    expect(FAILURE_MESSAGES[classifyMediaError(2)!]).not.toMatch(/codec/i);
  });

  test("autoplay engeli sınıflandırmadan gelmez (MediaError değil)", () => {
    for (const code of [1, 2, 3, 4]) expect(classifyMediaError(code)).not.toBe("autoplay");
  });
});
