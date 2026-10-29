import { describe, expect, test } from "vitest";
import { audioWarning, MKV_HEADER_BYTES, readMatroskaTracks } from "./matroska";

// Sentetik EBML ile ayrıştırıcı testleri (gerçek ffmpeg çıktısı değil; yalnız Tracks yapısı).
const bytes = (...n: number[]) => Uint8Array.from(n);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** 8 baytlık boyut alanı (0x01 işaretçisi + 7 bayt). */
const size8 = (n: number) => {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
};
const el = (id: number[], payload: Uint8Array) => cat(bytes(...id), size8(payload.length), payload);
const uint = (id: number[], n: number) => el(id, bytes(n));
const str = (id: number[], s: string) => el(id, new TextEncoder().encode(s));

const entry = (number: number, type: number, codec: string, extra: Uint8Array[] = []) =>
  el([0xae], cat(uint([0xd7], number), uint([0x83], type), str([0x86], codec), ...extra));
const tracks = (...entries: Uint8Array[]) => el([0x16, 0x54, 0xae, 0x6b], cat(...entries));
const header = el([0x1a, 0x45, 0xdf, 0xa3], str([0x42, 0x82], "matroska"));
const segment = (...children: Uint8Array[]) => el([0x18, 0x53, 0x80, 0x67], cat(...children));
const cluster = el([0x1f, 0x43, 0xb6, 0x75], new Uint8Array(32));
const mkv = (...entries: Uint8Array[]) => new Blob([cat(header, segment(tracks(...entries), cluster))]);

const video = entry(1, 1, "V_MPEG4/ISO/AVC");
const named = (n: string) => str([0x53, 0x6e], n);

describe("readMatroskaTracks", () => {
  test("H.264 + AAC: iki iz, ses çalar, uyarı yok", async () => {
    const r = await readMatroskaTracks(mkv(video, entry(2, 2, "A_AAC")));
    expect(r.status).toBe("ok");
    expect(r.tracks.map((t) => [t.number, t.type, t.codecId, t.audio])).toEqual([
      [1, "video", "V_MPEG4/ISO/AVC", "unknown"],
      [2, "audio", "A_AAC", "plays"],
    ]);
    expect(audioWarning(r)).toBeNull();
  });

  test("Opus, Vorbis, FLAC, MP3 uyarı üretmez", async () => {
    for (const codec of ["A_OPUS", "A_VORBIS", "A_FLAC", "A_MPEG/L3"]) {
      const r = await readMatroskaTracks(mkv(video, entry(2, 2, codec)));
      expect(r.tracks[1].audio).toBe("plays");
      expect(audioWarning(r)).toBeNull();
    }
  });

  test("AC3 / E-AC3 / DTS / TrueHD: uyarı codec adını söyler", async () => {
    const cases: [string, string][] = [
      ["A_AC3", "AC3"],
      ["A_EAC3", "E-AC3"],
      ["A_DTS/EXPRESS", "DTS"],
      ["A_TRUEHD", "TrueHD"],
    ];
    for (const [codec, label] of cases) {
      const r = await readMatroskaTracks(mkv(video, entry(2, 2, codec)));
      expect(r.tracks[1].audio).toBe("unsupported");
      expect(audioWarning(r)).toContain(`çalmayabilir (${label})`);
    }
  });

  test("dil ve ad okunur; altyazı izi tanınır", async () => {
    const r = await readMatroskaTracks(
      mkv(video, entry(2, 2, "A_AAC", [str([0x22, 0xb5, 0x9c], "tur"), named("Türkçe")]), entry(3, 17, "S_TEXT/UTF8")),
    );
    expect(r.tracks[1]).toMatchObject({ language: "tur", name: "Türkçe" });
    expect(r.tracks[2].type).toBe("subtitle");
  });

  test("çok ses izi: dosya sırasıyla listelenir, ilk ses çalar uyarısı", async () => {
    const r = await readMatroskaTracks(mkv(video, entry(2, 2, "A_AAC", [named("Türkçe")]), entry(3, 2, "A_AC3", [named("English")])));
    const w = audioWarning(r)!;
    expect(w).toContain("ilk sesi çalar");
    expect(w.indexOf("Türkçe (AAC)")).toBeGreaterThan(-1);
    expect(w.indexOf("Türkçe (AAC)")).toBeLessThan(w.indexOf("English (AC3)"));
  });

  test("ilk iz AC3, ikincisi AAC: hem çalmayabilir hem iz listesi", async () => {
    const w = audioWarning(await readMatroskaTracks(mkv(video, entry(2, 2, "A_AC3"), entry(3, 2, "A_AAC"))))!;
    expect(w).toContain("çalmayabilir (AC3)");
    expect(w).toContain("izlerde");
  });

  test("ses izi olmayan dosya uyarı üretmez", async () => {
    expect(audioWarning(await readMatroskaTracks(mkv(video)))).toBeNull();
  });

  test("boyutu bilinmeyen Segment okunur", async () => {
    const seg = cat(bytes(0x18, 0x53, 0x80, 0x67), bytes(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), tracks(video, entry(2, 2, "A_AAC")), cluster);
    const r = await readMatroskaTracks(new Blob([cat(header, seg)]));
    expect(r.status).toBe("ok");
    expect(r.tracks).toHaveLength(2);
  });

  test("Tracks başlık bütçesinin ötesinde: SeekHead ile bulunur", async () => {
    const t = tracks(video, entry(2, 2, "A_AC3"));
    const gap = el([0xec], new Uint8Array(MKV_HEADER_BYTES + 1000));
    // SeekPosition Segment verisinin başına göredir; SeekHead sabit boyutlu olduğundan konum önceden bilinir.
    const seekHead = (pos: number) =>
      el([0x11, 0x4d, 0x9b, 0x74], el([0x4d, 0xbb], cat(el([0x53, 0xab], bytes(0x16, 0x54, 0xae, 0x6b)), el([0x53, 0xac], bytes(0, 0, 0, 0, 0, pos >> 16, (pos >> 8) & 255, pos & 255)))));
    const pos = seekHead(0).length + gap.length;
    const r = await readMatroskaTracks(new Blob([cat(header, segment(seekHead(pos), gap, t, cluster))]));
    expect(r.status).toBe("ok");
    expect(r.tracks[1].codecId).toBe("A_AC3");
  });

  test("Tracks hiç yoksa unreadable", async () => {
    expect(await readMatroskaTracks(new Blob([cat(header, segment(cluster))]))).toEqual({ status: "unreadable", tracks: [] });
  });

  test("kesik dosya unreadable (reject etmez)", async () => {
    const full = cat(header, segment(tracks(video, entry(2, 2, "A_AAC")), cluster));
    expect(await readMatroskaTracks(new Blob([full.slice(0, header.length + 40)]))).toEqual({ status: "unreadable", tracks: [] });
  });

  test("MKV olmayan ve boş dosya unreadable", async () => {
    expect((await readMatroskaTracks(new Blob([new TextEncoder().encode("ftypisom mp4 gibi bir dosya")]))).status).toBe("unreadable");
    expect((await readMatroskaTracks(new Blob([]))).status).toBe("unreadable");
  });

  test("devasa boyut alanı ve rastgele bayt takılmadan unreadable", async () => {
    const hugeSize = bytes(0x01, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff);
    const huge = cat(header, bytes(0x18, 0x53, 0x80, 0x67), hugeSize, bytes(0x16, 0x54, 0xae, 0x6b), hugeSize);
    expect((await readMatroskaTracks(new Blob([huge]))).status).toBe("unreadable");
    const noise = new Uint8Array(4096).map((_, i) => (i * 131) & 255);
    expect((await readMatroskaTracks(new Blob([cat(header, noise)]))).status).toBe("unreadable");
  });

  test("iptal AbortError ile reject eder", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(readMatroskaTracks(mkv(video), ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("audioWarning", () => {
  test("okunamayan dosya engellemeyen bilgi metni verir", () => {
    const w = audioWarning({ status: "unreadable", tracks: [] })!;
    expect(w).toContain("Uyumluluk doğrulanamadı");
    expect(w).toContain("yüklenebilir");
  });
});
