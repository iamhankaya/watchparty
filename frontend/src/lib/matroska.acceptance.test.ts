import { describe, expect, test } from "vitest";
import { audioWarning, MKV_HEADER_BYTES, readMatroskaTracks, type MkvTrack } from "./matroska";
import { mkvBytes, type MkvFixtureName } from "../test-fixtures/mkvFixtures";

// MKV kabul testleri (T20261029-26): sözleşmeye (matroska.ts imzaları + spec senaryoları 1-5) karşı yazıldı,
// uygulamaya bakılmadan. Fixture'lar gerçek ffmpeg çıktısıdır (bkz. test-fixtures/mkvFixtures.ts başlığı).

type Shape = Pick<MkvTrack, "type" | "codecId" | "audio"> & { language?: string };

const blobOf = (name: MkvFixtureName) => new Blob([mkvBytes(name) as BlobPart]);
const inspect = (name: MkvFixtureName) => readMatroskaTracks(blobOf(name));

const AVC: Shape = { type: "video", codecId: "V_MPEG4/ISO/AVC", audio: "unknown" };

/** ffprobe ile doğrulanmış iz listeleri (dosya sırasıyla). */
const EXPECTED: Record<MkvFixtureName, Shape[]> = {
  h264_aac: [AVC, { type: "audio", codecId: "A_AAC", audio: "plays" }],
  h264_opus: [AVC, { type: "audio", codecId: "A_OPUS", audio: "plays" }],
  h264_ac3: [AVC, { type: "audio", codecId: "A_AC3", audio: "unsupported" }],
  h264_eac3: [AVC, { type: "audio", codecId: "A_EAC3", audio: "unsupported" }],
  h264_dts: [AVC, { type: "audio", codecId: "A_DTS", audio: "unsupported" }],
  multi_aac_aac: [
    AVC,
    { type: "audio", codecId: "A_AAC", audio: "plays", language: "tur" },
    { type: "audio", codecId: "A_AAC", audio: "plays", language: "eng" },
  ],
  multi_ac3_aac: [
    AVC,
    { type: "audio", codecId: "A_AC3", audio: "unsupported", language: "eng" },
    { type: "audio", codecId: "A_AAC", audio: "plays", language: "tur" },
  ],
  h264_aac_srt: [
    AVC,
    { type: "audio", codecId: "A_AAC", audio: "plays" },
    { type: "subtitle", codecId: "S_TEXT/UTF8", audio: "unknown" },
  ],
};

const shapeOf = ({ type, codecId, audio, language }: MkvTrack): Shape => ({
  type,
  codecId,
  audio,
  ...(language ? { language } : {}),
});

describe("readMatroskaTracks: gerçek fixture başlıkları", () => {
  for (const [name, expected] of Object.entries(EXPECTED) as [MkvFixtureName, Shape[]][]) {
    test(`${name}: iz listesi dosya sırasında`, async () => {
      const r = await inspect(name);
      expect(r.status).toBe("ok");
      expect(r.tracks.map(shapeOf)).toEqual(expected);
    });
  }

  test("tam dosya ile 4 KB'lık baş pencere aynı sonucu verir", async () => {
    const full = mkvBytes("h264_aac");
    const head = await readMatroskaTracks(new Blob([full.subarray(0, 4096) as BlobPart]));
    const all = await readMatroskaTracks(new Blob([full as BlobPart]));
    expect(head).toEqual(all);
  });

  test("iz numaraları dosyadaki sırayla 1, 2, 3", async () => {
    const { tracks } = await inspect("multi_ac3_aac");
    expect(tracks.map((t) => t.number)).toEqual([1, 2, 3]);
  });
});

describe("readMatroskaTracks: bozuk ve sınır girdiler (reject etmez, unreadable döner)", () => {
  const unreadable = { status: "unreadable", tracks: [] };

  test("boş dosya", async () => expect(await readMatroskaTracks(new Blob([]))).toEqual(unreadable));

  test("MKV olmayan bayt (ftyp başlıklı MP4 benzeri)", async () => {
    const bytes = new Uint8Array(512);
    bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(await readMatroskaTracks(new Blob([bytes as BlobPart]))).toEqual(unreadable);
  });

  test("EBML başlığının ortasında kesilmiş dosya", async () => {
    const cut = mkvBytes("h264_ac3").subarray(0, 40);
    expect(await readMatroskaTracks(new Blob([cut as BlobPart]))).toEqual(unreadable);
  });

  test("Tracks'ın ortasında kesilmiş dosya: yarım iz listesi dönmez", async () => {
    const full = mkvBytes("multi_aac_aac");
    const at = full.findIndex((_, i) => full[i] === 0x16 && full[i + 1] === 0x54 && full[i + 2] === 0xae && full[i + 3] === 0x6b);
    expect(at).toBeGreaterThan(0);
    const r = await readMatroskaTracks(new Blob([full.subarray(0, at + 30) as BlobPart]));
    expect(r).toEqual(unreadable);
  });

  test("EBML sihirli baytıyla başlayan 0xFF çöpü", async () => {
    const junk = new Uint8Array(4096).fill(0xff);
    junk.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect(await readMatroskaTracks(new Blob([junk as BlobPart]))).toEqual(unreadable);
  });

  test("başlıkta rastgele bozulma reject etmez", async () => {
    const bad = mkvBytes("h264_ac3").slice();
    for (let i = 30; i < 400; i += 7) bad[i] = 0xff;
    const r = await readMatroskaTracks(new Blob([bad as BlobPart]));
    expect(["ok", "unreadable"]).toContain(r.status);
  });

  test("önceden iptal edilmiş sinyal AbortError ile reject eder", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(readMatroskaTracks(blobOf("h264_aac"), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("readMatroskaTracks: okuma bütçesi", () => {
  /** Gerçek başlık + sıfırla dolu sanal büyük dosya; yalnız istenen pencere gerçekten üretilir. */
  function virtualFile(head: Uint8Array, size: number) {
    const reads: [number, number][] = [];
    const file = {
      size,
      slice(start = 0, end = size) {
        const e = Math.min(end, size);
        reads.push([start, e]);
        const buf = new Uint8Array(Math.max(0, e - start));
        if (start < head.length) buf.set(head.subarray(start, Math.min(head.length, e)), 0);
        return new Blob([buf as BlobPart]);
      },
    } as unknown as Blob;
    return { file, reads };
  }

  test("6 GB'lık dosyada tek okuma 2 MiB'ı aşmaz", async () => {
    const { file, reads } = virtualFile(mkvBytes("h264_ac3"), 6_000_000_000);
    const r = await readMatroskaTracks(file);
    expect(r.status).toBe("ok");
    expect(r.tracks.map((t) => t.codecId)).toEqual(["V_MPEG4/ISO/AVC", "A_AC3"]);
    expect(reads.length).toBeGreaterThan(0);
    for (const [s, e] of reads) expect(e - s).toBeLessThanOrEqual(MKV_HEADER_BYTES);
  });

  test("geçerli başlık yoksa sınırlı sayıda okuyup unreadable döner", async () => {
    const { file, reads } = virtualFile(new Uint8Array(0), 6_000_000_000);
    expect(await readMatroskaTracks(file)).toEqual({ status: "unreadable", tracks: [] });
    expect(reads.length).toBeLessThanOrEqual(8);
    for (const [s, e] of reads) expect(e - s).toBeLessThanOrEqual(MKV_HEADER_BYTES);
  });
});

describe("audioWarning: spec senaryoları 1-5", () => {
  const warn = async (name: MkvFixtureName) => audioWarning(await inspect(name));

  test("senaryo 1/2: AAC ve Opus için uyarı yok", async () => {
    expect(await warn("h264_aac")).toBeNull();
    expect(await warn("h264_opus")).toBeNull();
  });

  test("senaryo 3: AC3 uyarısı codec adını ve 'çalmayabilir' ifadesini taşır", async () => {
    const w = await warn("h264_ac3");
    expect(w).toContain("Bu dosyanın sesi tarayıcıda çalmayabilir");
    expect(w).toContain("AC3");
  });

  test("senaryo 3: E-AC3 ve DTS de uyarır ve kendi adlarını verir", async () => {
    expect(await warn("h264_eac3")).toMatch(/E-?AC-?3/);
    expect(await warn("h264_dts")).toContain("DTS");
  });

  test("senaryo 4: çok sesli dosyada uyarı ilk iz kuralını söyler", async () => {
    const w = await warn("multi_aac_aac");
    expect(w).not.toBeNull();
    expect(w).toMatch(/ilk/i);
  });

  test("senaryo 4: ilk iz AC3, ikinci AAC ise AC3 uyarısı verilir (AAC var diye güvenli sayılmaz)", async () => {
    const w = await warn("multi_ac3_aac");
    expect(w).toContain("AC3");
    expect(w).toContain("çalmayabilir");
  });

  test("altyazı izi ses uyarısı üretmez", async () => {
    expect(await warn("h264_aac_srt")).toBeNull();
  });

  test("senaryo 5: unreadable inceleme 'çalmayabilir' hükmü vermez", () => {
    const w = audioWarning({ status: "unreadable", tracks: [] });
    // Sözleşme null ya da "okunamadı" bilgisine izin verir (açık nokta); asla codec'in desteklenmediğini iddia etmez.
    expect(w === null || (!w.includes("çalmayabilir") && /okunamad|doğrulanamad/i.test(w))).toBe(true);
  });

  test("ses izi hiç yoksa uyarı yok", () => {
    expect(
      audioWarning({ status: "ok", tracks: [{ number: 1, type: "video", codecId: "V_VP9", audio: "unknown" }] }),
    ).toBeNull();
  });
});
