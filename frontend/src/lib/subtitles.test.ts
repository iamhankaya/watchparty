import { describe, expect, test } from "vitest";
import { decodeSubtitle, parseSubtitles } from "./subtitles";

const buf = (b: number[]) => new Uint8Array(b).buffer as ArrayBuffer;

describe("decodeSubtitle", () => {
  test("UTF-8 metni çözer", () =>
    expect(decodeSubtitle(new TextEncoder().encode("ğüşıöçĞÜŞİÖÇ").buffer as ArrayBuffer)).toBe("ğüşıöçĞÜŞİÖÇ"));
  test("baştaki BOM'u atar", () =>
    expect(decodeSubtitle(buf([0xef, 0xbb, 0xbf, 0x61, 0x62]))).toBe("ab"));
  test("geçersiz UTF-8 ise Windows-1254'e düşer", () =>
    expect(decodeSubtitle(buf([0xf0, 0xfc, 0xfe, 0xfd, 0xf6, 0xe7]))).toBe("ğüşıöç"));
});

describe("parseSubtitles", () => {
  test("SRT: iki blok", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,500\nMerhaba\n\n2\n00:00:03,000 --> 00:00:04,000\nDünya\n";
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 2.5, text: "Merhaba" },
      { start: 3, end: 4, text: "Dünya" },
    ]);
  });
  test("çok satırlı metin \n ile korunur", () =>
    expect(parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\nBir\nİki\n")[0].text).toBe("Bir\nİki"));
  test("VTT: başlık, NOTE bloğu ve cue ayarları", () => {
    const vtt = "WEBVTT\n\nNOTE bu bir not\nikinci satır\n\n00:01.000 --> 00:02.000 align:start\nSelam\n";
    expect(parseSubtitles(vtt)).toEqual([{ start: 1, end: 2, text: "Selam" }]);
  });
  test("CRLF ve yalnız CR", () => {
    const expected = [{ start: 1, end: 2, text: "A" }, { start: 3, end: 4, text: "B" }];
    expect(parseSubtitles("1\r\n00:00:01,000 --> 00:00:02,000\r\nA\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nB\r\n")).toEqual(expected);
    expect(parseSubtitles("1\r00:00:01,000 --> 00:00:02,000\rA\r\r2\r00:00:03,000 --> 00:00:04,000\rB\r")).toEqual(expected);
  });
  test("saat kısmı olmayan zaman", () =>
    expect(parseSubtitles("01:02.500 --> 01:03.000\nx")).toEqual([{ start: 62.5, end: 63, text: "x" }]));
  test("bozuk zaman satırlı blok atlanır, diğerleri kalır", () => {
    const s = "1\n00:00:01,000 --> abc\nbozuk\n\n2\n00:00:03,000 --> 00:00:04,000\niyi\n";
    expect(parseSubtitles(s)).toEqual([{ start: 3, end: 4, text: "iyi" }]);
  });
  test("{\an8} silinir, <i> kalır", () =>
    expect(parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\n{\an8}<i>Üst</i>\n")[0].text).toBe("<i>Üst</i>"));
  test("boş metin → []", () => {
    expect(parseSubtitles("")).toEqual([]);
    expect(parseSubtitles("\n\n  \n")).toEqual([]);
  });
  test("end <= start olan blok atlanır", () => {
    const s = "1\n00:00:02,000 --> 00:00:02,000\na\n\n2\n00:00:03,000 --> 00:00:01,000\nb\n";
    expect(parseSubtitles(s)).toEqual([]);
  });
});
