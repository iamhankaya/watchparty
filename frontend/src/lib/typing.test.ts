import { describe, expect, it } from "vitest";
import { TypingThrottle, TypingTracker } from "./typing";

describe("TypingTracker", () => {
  it("eklenen kişiyi 5 sn boyunca aktif sayar", () => {
    const t = new TypingTracker();
    t.add("a", "Ali", 1000);
    expect(t.active(1000)).toEqual(["Ali"]);
    expect(t.active(5999)).toEqual(["Ali"]);
    expect(t.active(6000)).toEqual([]);
  });
  it("tekrar eklemek süreyi yeniler", () => {
    const t = new TypingTracker();
    t.add("a", "Ali", 0);
    t.add("a", "Ali", 4000);
    expect(t.active(8000)).toEqual(["Ali"]);
  });
  it("remove kişiyi kaldırır", () => {
    const t = new TypingTracker();
    t.add("a", "Ali", 0);
    t.add("b", "Veli", 0);
    t.remove("a");
    expect(t.active(1)).toEqual(["Veli"]);
  });
  it("etiket metinleri", () => {
    const t = new TypingTracker();
    expect(t.label([])).toBeNull();
    expect(t.label(["Ali"])).toBe("Ali yazıyor…");
    expect(t.label(["Ali", "Veli"])).toBe("Ali ve Veli yazıyor…");
    expect(t.label(["Ali", "Veli", "Ayşe"])).toBe("3 kişi yazıyor…");
  });
});

describe("TypingThrottle", () => {
  it("3 sn'de bir izin verir", () => {
    const th = new TypingThrottle();
    expect(th.shouldSend(10_000)).toBe(true);
    expect(th.shouldSend(11_000)).toBe(false);
    expect(th.shouldSend(12_999)).toBe(false);
    expect(th.shouldSend(13_000)).toBe(true);
  });
});
