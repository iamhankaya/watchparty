import { describe, expect, test } from "vitest";
import { classifyMediaError, FAILURE_MESSAGES, type PlaybackFailureKind } from "./playbackFailure";

// Sözleşme (T20261029-25): hata türleri ve mesajlar; sınıflandırma mantığı uygulama fazında.
describe("playbackFailure sözleşmesi", () => {
  test("her tür için Türkçe mesaj var", () => {
    const kinds: PlaybackFailureKind[] = ["autoplay", "network", "unsupported", "decode"];
    for (const k of kinds) expect(FAILURE_MESSAGES[k].length).toBeGreaterThan(0);
    expect(Object.keys(FAILURE_MESSAGES).sort()).toEqual([...kinds].sort());
  });

  test("unsupported mesajı kesin codec iddiası taşımaz", () =>
    expect(FAILURE_MESSAGES.unsupported).toBe(
      "Bu video bu tarayıcıda oynatılamıyor. Dosya biçimi veya codec desteklenmiyor olabilir.",
    ));

  test("classifyMediaError imzası", () => expect(classifyMediaError).toBeTypeOf("function"));
});
