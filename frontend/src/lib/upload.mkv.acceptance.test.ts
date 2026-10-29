import { describe, expect, test } from "vitest";
import { MAX_VIDEO_BYTES, uploadVideo, VIDEO_EXTENSION_ERROR, VIDEO_EXTENSIONS, videoProblem } from "./upload";

// MKV kabul testleri (T20261029-26), spec senaryo 1, 6, 11: yükleme öncesi istemci doğrulaması.

const fakeFile = (name: string, size: number) => ({ name, size, type: "", slice: () => new Blob([]) }) as unknown as File;
const noop = () => {};

describe("videoProblem: MKV", () => {
  test("senaryo 1: .mkv kabul edilir, büyük/küçük harf fark etmez", () => {
    expect(videoProblem(fakeFile("film.mkv", 10))).toBeNull();
    expect(videoProblem(fakeFile("FILM.MKV", 10))).toBeNull();
    expect(videoProblem(fakeFile("Güzel Film.Mkv", 10))).toBeNull();
  });

  test("mevcut uzantılar kabul edilmeye devam eder", () => {
    expect(videoProblem(fakeFile("a.mp4", 10))).toBeNull();
    expect(videoProblem(fakeFile("a.m4v", 10))).toBeNull();
  });

  test("senaryo 6: avi, çift uzantı ve uzantısız ad yeni metinle reddedilir", () => {
    for (const name of ["a.avi", "a.mkv.exe", "mkv", "a.mkvx", "a.mp4.mkv.txt", "a.webm", ""]) {
      expect(videoProblem(fakeFile(name, 10)), name).toBe("Yalnızca .mp4, .m4v veya .mkv yüklenebilir");
    }
  });

  test("hata metni sunucudakiyle aynı sabit", () => {
    expect(VIDEO_EXTENSION_ERROR).toBe("Yalnızca .mp4, .m4v veya .mkv yüklenebilir");
    expect(videoProblem(fakeFile("a.avi", 10))).toBe(VIDEO_EXTENSION_ERROR);
  });

  test("VIDEO_EXTENSIONS'taki her uzantı kabul edilir (senkron testi)", () => {
    for (const ext of VIDEO_EXTENSIONS) expect(videoProblem(fakeFile(`x.${ext}`, 10)), ext).toBeNull();
  });

  test("senaryo 11: boyut sınırı mkv için de geçerli", () => {
    expect(videoProblem(fakeFile("a.mkv", MAX_VIDEO_BYTES))).toBeNull();
    expect(videoProblem(fakeFile("a.mkv", MAX_VIDEO_BYTES + 1))).toBe("Dosya çok büyük");
    expect(videoProblem(fakeFile("a.mkv", 0))).toBe("Dosya boş");
  });
});

describe("uploadVideo: MKV", () => {
  test("senaryo 11: 6 GB üstü mkv sunucuya hiç gitmeden reddedilir", async () => {
    let calls = 0;
    const fetchImpl = (() => (calls++, Promise.reject(new Error("gitmemeli")))) as unknown as typeof fetch;
    await expect(uploadVideo(fakeFile("a.mkv", MAX_VIDEO_BYTES + 1), "k", { onProgress: noop, fetchImpl })).rejects.toThrow(
      "Dosya çok büyük",
    );
    expect(calls).toBe(0);
  });

  test("senaryo 6: .avi sunucuya hiç gitmeden yeni uzantı metniyle reddedilir", async () => {
    let calls = 0;
    const fetchImpl = (() => (calls++, Promise.reject(new Error("gitmemeli")))) as unknown as typeof fetch;
    await expect(uploadVideo(fakeFile("a.avi", 10), "k", { onProgress: noop, fetchImpl })).rejects.toThrow(VIDEO_EXTENSION_ERROR);
    expect(calls).toBe(0);
  });

  test("senaryo 1: mkv için başlatma isteği özgün dosya adı ve boyutuyla gider", async () => {
    const seen: { url: string; body: unknown; key: string | null }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen.push({
        url,
        body: JSON.parse(String(init.body)),
        key: new Headers(init.headers).get("X-Upload-Key"),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ error: "durdur" }), { status: 400, headers: { "Content-Type": "application/json" } }),
      );
    }) as unknown as typeof fetch;

    await expect(uploadVideo(fakeFile("Film.mkv", 1234), "k".repeat(32), { onProgress: noop, fetchImpl })).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/uploads/video");
    expect(seen[0].body).toEqual({ fileName: "Film.mkv", size: 1234 });
    expect(seen[0].key).toBe("k".repeat(32));
  });
});
