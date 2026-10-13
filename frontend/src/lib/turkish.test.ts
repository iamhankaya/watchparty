import { describe, expect, it } from "vitest";
import { genitive } from "./turkish";

describe("genitive", () => {
  it.each([
    ["Ali", "Ali'nin"],
    ["Bora", "Bora'nın"],
    ["Can", "Can'ın"],
    ["Ömer", "Ömer'in"],
    ["Ayşe", "Ayşe'nin"],
    ["Mehmet", "Mehmet'in"],
    ["Umut", "Umut'un"],
    ["Gül", "Gül'ün"],
    ["Doğu", "Doğu'nun"],
    ["ALİ", "ALİ'nin"],
    ["ALI", "ALI'nın"],
  ])("%s -> %s", (name, expected) => {
    expect(genitive(name)).toBe(expected);
  });

  it("ünlüsüz adda null", () => {
    expect(genitive("X1")).toBeNull();
    expect(genitive("🎬")).toBeNull();
  });
});
