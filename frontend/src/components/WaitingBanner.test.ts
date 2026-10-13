import { describe, expect, it } from "vitest";
import { waitingText } from "./WaitingBanner";

const people = [
  { id: "a", nickname: "Ayşe", isHost: true },
  { id: "b", nickname: "Ben", isHost: false },
  { id: "c", nickname: "Can", isHost: false },
];

describe("waitingText", () => {
  it("bekleyen yoksa null", () => {
    expect(waitingText([], people, "a")).toBeNull();
  });

  it("tek kişi adıyla", () => {
    expect(waitingText(["c"], people, "a")).toBe("Can'nin videosu yükleniyor…");
  });

  it("birden fazla kişi sayıyla", () => {
    expect(waitingText(["b", "c"], people, "a")).toBe("2 kişi bekleniyor…");
  });

  it("kendisi listedeyse kendi metni", () => {
    expect(waitingText(["c", "a"], people, "a")).toBe("Videon yükleniyor, herkes seni bekliyor…");
  });

  it("katılımcı listesinde olmayan kimlik ada çevrilmez ama sayılır", () => {
    expect(waitingText(["x"], people, "a")).toBe("1 kişi bekleniyor…");
    expect(waitingText(["x", "c"], people, "a")).toBe("2 kişi bekleniyor…");
  });

  it("selfId yokken (kopuk) herkes başkası sayılır", () => {
    expect(waitingText(["a"], people, null)).toBe("Ayşe'nin videosu yükleniyor…");
  });
});
