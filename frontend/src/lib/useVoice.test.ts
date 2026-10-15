import { describe, expect, it } from "vitest";
import { normalizeIceServers } from "./connection";
import { MIC_CONSTRAINTS, micErrorMessage } from "./useVoice";

describe("micErrorMessage", () => {
  it("izin reddi ve cihaz yokluğu için Türkçe metin", () => {
    expect(micErrorMessage(new DOMException("x", "NotAllowedError"))).toBe("Mikrofon izni verilmedi");
    expect(micErrorMessage(new DOMException("x", "NotFoundError"))).toBe("Mikrofon bulunamadı");
    expect(micErrorMessage(new Error("başka"))).toBe("Mikrofon açılamadı");
    expect(micErrorMessage(null)).toBe("Mikrofon açılamadı");
  });

  it("yankı önleme, gürültü bastırma ve otomatik kazanç açık", () => {
    expect(MIC_CONSTRAINTS).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  });
});

describe("normalizeIceServers", () => {
  it("null kullanıcı adı/şifre atılır, metinler korunur", () => {
    expect(
      normalizeIceServers([
        { urls: ["stun:a"], username: null, credential: null },
        { urls: ["turn:b"], username: "u", credential: "p" },
      ]),
    ).toEqual([{ urls: ["stun:a"] }, { urls: ["turn:b"], username: "u", credential: "p" }]);
  });

  it("dizi değilse boş liste", () => {
    expect(normalizeIceServers(null)).toEqual([]);
  });
});
