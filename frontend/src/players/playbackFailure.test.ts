import { describe, expect, test } from "vitest";
import { classifyMediaError, FAILURE_MESSAGES, MKV_HINT, playbackMessage, type PlaybackFailureKind } from "./playbackFailure";

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

  test("MediaError kodları türe çevrilir", () => {
    expect(classifyMediaError(2)).toBe("network");
    expect(classifyMediaError(3)).toBe("decode");
    expect(classifyMediaError(4)).toBe("unsupported");
  });

  test("playbackMessage: tür mesajı, MKV'de tarayıcı ipucu, bilinmeyen kodda genel mesaj", () => {
    expect(playbackMessage(4, "https://x.test/videolar/a/b.mp4")).toBe(FAILURE_MESSAGES.unsupported);
    expect(playbackMessage(4, "https://x.test/videolar/a/b.mkv?x=1")).toBe(
      `${FAILURE_MESSAGES.unsupported} ${MKV_HINT}`,
    );
    expect(playbackMessage(3, "https://x.test/B.MKV")).toContain(MKV_HINT);
    expect(playbackMessage(2, "https://x.test/b.mkv")).toBe(FAILURE_MESSAGES.network);
    expect(playbackMessage(undefined, "https://x.test/b.mp4")).toBe(FAILURE_MESSAGES.network);
  });

  test("aborted, bilinmeyen ve eksik kod null", () => {
    expect(classifyMediaError(1)).toBeNull();
    expect(classifyMediaError(99)).toBeNull();
    expect(classifyMediaError(undefined)).toBeNull();
  });
});
