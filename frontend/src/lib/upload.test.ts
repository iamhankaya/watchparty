import { describe, expect, test } from "vitest";
import {
  MAX_SUBTITLE_BYTES,
  MAX_VIDEO_BYTES,
  planParts,
  uploadKeyProblem,
  uploadSubtitle,
  uploadVideo,
  videoProblem,
  type UploadProgress,
} from "./upload";

const MB = 1024 * 1024;
const PART = 16 * MB;

/** Bellekte veri tutmayan sahte dosya: motor yalnızca name, size ve slice kullanır. */
function fakeFile(name: string, size: number): File {
  return {
    name,
    size,
    type: "",
    slice: (start: number, end: number) => ({ size: end - start, start, end }) as unknown as Blob,
  } as unknown as File;
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/**
 * Sahte sunucu + S3. `putHandler` S3'e giden parça PUT'larını yönetir;
 * varsayılanı hemen 200 ve ETag "etag-<parça>" döndürür.
 */
function fakeServer(opts: {
  size: number;
  partSize?: number;
  putHandler?: (part: number, call: Call, attempt: number) => Promise<Response> | Response;
  startStatus?: number;
  startBody?: unknown;
}) {
  const partSize = opts.partSize ?? PART;
  const partCount = Math.ceil(opts.size / partSize);
  const calls: Call[] = [];
  const attempts = new Map<number, number>();
  let urlVersion = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const call: Call = { method: init?.method ?? "GET", url, headers, body };
    calls.push(call);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");

    if (url === "/api/uploads/video") {
      if (opts.startStatus) return json(opts.startStatus, opts.startBody ?? {});
      return json(200, { key: "videolar/abc/film.mp4", uploadId: "up-1", partSize, partCount });
    }
    if (url === "/api/uploads/video/parts") {
      const nums = (body as { partNumbers: number[] }).partNumbers;
      urlVersion++;
      return json(200, { urls: nums.map((n) => ({ partNumber: n, url: `https://s3.test/part/${n}?v=${urlVersion}` })) });
    }
    if (url === "/api/uploads/video/complete") return json(200, { url: "https://cdn.test/videolar/abc/film.mp4" });
    if (url === "/api/uploads/video/abort") return new Response(null, { status: 204 });
    if (url.startsWith("https://s3.test/part/")) {
      const part = Number(url.slice("https://s3.test/part/".length).split("?")[0]);
      const attempt = (attempts.get(part) ?? 0) + 1;
      attempts.set(part, attempt);
      if (opts.putHandler) return opts.putHandler(part, call, attempt);
      return new Response(null, { status: 200, headers: { ETag: `"etag-${part}"` } });
    }
    if (url === "/api/uploads/subtitle") {
      return json(200, { key: "videolar/abc/altyazi.srt", putUrl: "https://s3.test/sub", url: "https://cdn.test/videolar/abc/altyazi.srt" });
    }
    if (url === "https://s3.test/sub") return new Response(null, { status: 200 });
    throw new Error("beklenmeyen istek " + url);
  }) as typeof fetch;
  return { fetchImpl, calls, attempts, partCount };
}

const noSleep = () => Promise.resolve();
const onProgress = () => {};

describe("planParts", () => {
  test("son parça kalan bayt kadar", () => {
    const parts = planParts(40 * MB + 5, PART);
    expect(parts).toEqual([
      { partNumber: 1, start: 0, end: PART },
      { partNumber: 2, start: PART, end: 2 * PART },
      { partNumber: 3, start: 2 * PART, end: 40 * MB + 5 },
    ]);
  });

  test("tam katlarda fazladan boş parça yok", () => {
    expect(planParts(2 * PART, PART)).toHaveLength(2);
  });
});

describe("videoProblem", () => {
  test("6 GB + 1 bayt çok büyük, 6 GB geçer", () => {
    expect(videoProblem(fakeFile("a.mp4", MAX_VIDEO_BYTES + 1))).toBe("Dosya çok büyük");
    expect(videoProblem(fakeFile("a.mp4", MAX_VIDEO_BYTES))).toBeNull();
  });
  test("0 bayt ve yanlış uzantı", () => {
    expect(videoProblem(fakeFile("a.mp4", 0))).toBe("Dosya boş");
    expect(videoProblem(fakeFile("a.mkv", 10))).toBe("Yalnızca .mp4 veya .m4v yüklenebilir");
    expect(videoProblem(fakeFile("A.M4V", 10))).toBeNull();
  });
});

describe("uploadVideo", () => {
  test("6 GB + 1 bayt sunucuya hiç gitmeden reddedilir", async () => {
    const s = fakeServer({ size: 1 });
    await expect(
      uploadVideo(fakeFile("a.mp4", MAX_VIDEO_BYTES + 1), "k", { onProgress, fetchImpl: s.fetchImpl }),
    ).rejects.toThrow("Dosya çok büyük");
    expect(s.calls).toHaveLength(0);
  });

  test("0 bayt reddedilir", async () => {
    const s = fakeServer({ size: 1 });
    await expect(uploadVideo(fakeFile("a.mp4", 0), "k", { onProgress, fetchImpl: s.fetchImpl })).rejects.toThrow("Dosya boş");
    expect(s.calls).toHaveLength(0);
  });

  test("başarılı akış: X-Upload-Key her sunucu isteğinde, ETag'ler complete'e sırayla", async () => {
    const size = 3 * PART + 100;
    // Parçalar ters sırada bitsin: önce yüksek numaralı parça
    const s = fakeServer({
      size,
      putHandler: (part) =>
        new Promise((r) => setTimeout(() => r(new Response(null, { status: 200, headers: { ETag: `"etag-${part}"` } })), (5 - part) * 5)),
    });
    const res = await uploadVideo(fakeFile("film.mp4", size), "gizli-anahtar", { onProgress, fetchImpl: s.fetchImpl, sleep: noSleep });
    expect(res).toEqual({ url: "https://cdn.test/videolar/abc/film.mp4" });

    const api = s.calls.filter((c) => c.url.startsWith("/api/"));
    expect(api.length).toBeGreaterThan(0);
    for (const c of api) {
      expect(c.headers["x-upload-key"]).toBe("gizli-anahtar");
      expect(c.method).toBe("POST");
    }
    // S3'e anahtar gitmez
    for (const c of s.calls.filter((c) => c.url.startsWith("https://s3.test"))) {
      expect(c.headers["x-upload-key"]).toBeUndefined();
      expect(c.method).toBe("PUT");
    }
    expect(api[0].body).toEqual({ fileName: "film.mp4", size });

    const complete = s.calls.find((c) => c.url === "/api/uploads/video/complete")!;
    expect(complete.body).toEqual({
      key: "videolar/abc/film.mp4",
      uploadId: "up-1",
      parts: [1, 2, 3, 4].map((n) => ({ partNumber: n, eTag: `"etag-${n}"` })),
    });
    // Her parça doğru dilimle gönderilir
    const put4 = s.calls.find((c) => c.url.startsWith("https://s3.test/part/4"))!;
    expect(put4.body).toMatchObject({ start: 3 * PART, end: size });
    expect(s.calls.some((c) => c.url === "/api/uploads/video/abort")).toBe(false);
  });

  test("parça URL'leri en fazla 50'lik partilerle istenir", async () => {
    const size = 120 * MB + 1; // 1 MB parça => 121 parça
    const s = fakeServer({ size, partSize: MB });
    await uploadVideo(fakeFile("film.mp4", size), "k", { onProgress, fetchImpl: s.fetchImpl, sleep: noSleep });
    const batches = s.calls
      .filter((c) => c.url === "/api/uploads/video/parts")
      .map((c) => (c.body as { partNumbers: number[] }).partNumbers);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(50);
    const all = batches.flat().sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 121 }, (_, i) => i + 1));
    expect(batches).toHaveLength(3);
  });

  test("aynı anda en fazla 4 parça", async () => {
    let inFlight = 0;
    let max = 0;
    const size = 12 * PART;
    const s = fakeServer({
      size,
      putHandler: async (part) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return new Response(null, { status: 200, headers: { ETag: `"e${part}"` } });
      },
    });
    await uploadVideo(fakeFile("film.mp4", size), "k", { onProgress, fetchImpl: s.fetchImpl, sleep: noSleep });
    expect(max).toBe(4);
  });

  test("geçici hata yeniden denenir (artan bekleme)", async () => {
    const waits: number[] = [];
    const s = fakeServer({
      size: 2 * PART,
      putHandler: (part, _c, attempt) =>
        part === 2 && attempt < 3
          ? new Response(null, { status: 500 })
          : new Response(null, { status: 200, headers: { ETag: `"e${part}"` } }),
    });
    const res = await uploadVideo(fakeFile("film.mp4", 2 * PART), "k", {
      onProgress,
      fetchImpl: s.fetchImpl,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(res.url).toContain("film.mp4");
    expect(s.attempts.get(2)).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  test("ağ hatası da yeniden denenir", async () => {
    const s = fakeServer({
      size: PART,
      putHandler: (part, _c, attempt) => {
        if (attempt === 1) throw new TypeError("Failed to fetch");
        return new Response(null, { status: 200, headers: { ETag: `"e${part}"` } });
      },
    });
    await uploadVideo(fakeFile("film.mp4", PART), "k", { onProgress, fetchImpl: s.fetchImpl, sleep: noSleep });
    expect(s.attempts.get(1)).toBe(2);
  });

  test("parça 3 yeniden denemeden sonra da başarısızsa hata + abort", async () => {
    const waits: number[] = [];
    const s = fakeServer({
      size: 2 * PART,
      putHandler: (part) =>
        part === 1 ? new Response(null, { status: 500 }) : new Response(null, { status: 200, headers: { ETag: `"e${part}"` } }),
    });
    await expect(
      uploadVideo(fakeFile("film.mp4", 2 * PART), "k", { onProgress, fetchImpl: s.fetchImpl, sleep: async (ms) => void waits.push(ms) }),
    ).rejects.toThrow(/yüklenemedi/);
    expect(s.attempts.get(1)).toBe(4); // ilk deneme + 3 yeniden deneme
    expect(waits).toEqual([1000, 2000, 4000]);
    const abort = s.calls.find((c) => c.url === "/api/uploads/video/abort");
    expect(abort?.body).toEqual({ key: "videolar/abc/film.mp4", uploadId: "up-1" });
    expect(abort?.headers["x-upload-key"]).toBe("k");
    expect(s.calls.some((c) => c.url === "/api/uploads/video/complete")).toBe(false);
  });

  test("403 (süresi dolmuş URL) o parçanın URL'sini yeniler", async () => {
    const s = fakeServer({
      size: 2 * PART,
      putHandler: (part, call) =>
        part === 2 && call.url.endsWith("v=1")
          ? new Response("<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>", { status: 403 })
          : new Response(null, { status: 200, headers: { ETag: `"e${part}"` } }),
    });
    await uploadVideo(fakeFile("film.mp4", 2 * PART), "k", { onProgress, fetchImpl: s.fetchImpl, sleep: noSleep });
    const batches = s.calls
      .filter((c) => c.url === "/api/uploads/video/parts")
      .map((c) => (c.body as { partNumbers: number[] }).partNumbers);
    expect(batches).toEqual([[1, 2], [2]]);
  });

  test("signal iptali: hata + abort çağrısı, complete yok", async () => {
    const ctrl = new AbortController();
    const s = fakeServer({
      size: 8 * PART,
      putHandler: (part) =>
        new Promise((resolve, reject) => {
          if (part === 2) setTimeout(() => ctrl.abort(), 0);
          const t = setTimeout(() => resolve(new Response(null, { status: 200, headers: { ETag: `"e${part}"` } })), 20);
          ctrl.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    await expect(
      uploadVideo(fakeFile("film.mp4", 8 * PART), "k", { onProgress, fetchImpl: s.fetchImpl, signal: ctrl.signal, sleep: noSleep }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(s.calls.some((c) => c.url === "/api/uploads/video/abort")).toBe(true);
    expect(s.calls.some((c) => c.url === "/api/uploads/video/complete")).toBe(false);
  });

  test("baştan iptal edilmiş sinyalle hiç yükleme başlamaz", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const s = fakeServer({ size: PART });
    await expect(
      uploadVideo(fakeFile("film.mp4", PART), "k", { onProgress, fetchImpl: s.fetchImpl, signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(s.calls.some((c) => c.url.startsWith("https://s3.test"))).toBe(false);
  });

  test("401 metni hata olarak yüzeye çıkar", async () => {
    const s = fakeServer({ size: PART, startStatus: 401, startBody: { error: "Yükleme anahtarı geçersiz" } });
    await expect(uploadVideo(fakeFile("film.mp4", PART), "yanlis", { onProgress, fetchImpl: s.fetchImpl })).rejects.toThrow(
      "Yükleme anahtarı geçersiz",
    );
  });

  test("onStarted yalnızca başlatma isteği başarılıysa çağrılır", async () => {
    let started = 0;
    const bad = fakeServer({ size: PART, startStatus: 401, startBody: { error: "Yükleme anahtarı geçersiz" } });
    await expect(
      uploadVideo(fakeFile("film.mp4", PART), "k", { onProgress, fetchImpl: bad.fetchImpl, onStarted: () => started++ }),
    ).rejects.toThrow();
    expect(started).toBe(0);

    const ok = fakeServer({ size: PART });
    await uploadVideo(fakeFile("film.mp4", PART), "k", { onProgress, fetchImpl: ok.fetchImpl, sleep: noSleep, onStarted: () => started++ });
    expect(started).toBe(1);
  });

  test("JSON olmayan hata gövdesinde durum koduna düşer", async () => {
    const fetchImpl = (async () => new Response("", { status: 429, statusText: "Too Many Requests" })) as typeof fetch;
    await expect(uploadVideo(fakeFile("film.mp4", PART), "k", { onProgress, fetchImpl })).rejects.toThrow(/429/);
  });

  test("ilerleme: yüklenen bayt, hız ve kalan süre", async () => {
    let now = 0;
    const size = 4 * PART;
    const s = fakeServer({
      size,
      // Her parça 2 sn sürüyor gibi: PUT çağrısı saati ilerletir
      putHandler: async (part) => {
        await new Promise((r) => setTimeout(r, part)); // sıralı bitsin
        now += 1000;
        return new Response(null, { status: 200, headers: { ETag: `"e${part}"` } });
      },
    });
    const seen: UploadProgress[] = [];
    await uploadVideo(fakeFile("film.mp4", size), "k", {
      onProgress: (p) => seen.push(p),
      fetchImpl: s.fetchImpl,
      sleep: noSleep,
      now: () => now,
    });
    expect(seen[0]).toEqual({ loaded: 0, total: size, bytesPerSecond: 0, secondsLeft: null });
    const last = seen[seen.length - 1];
    expect(last.loaded).toBe(size);
    expect(last.secondsLeft).toBe(0);
    // İkinci parça bittiğinde (t=2 sn) 2 parça yüklü: hız 1 parça/sn, kalan 2 sn
    const two = seen.find((p) => p.loaded === 2 * PART)!;
    expect(two.bytesPerSecond).toBeCloseTo(PART, 0);
    expect(two.secondsLeft).toBeCloseTo(2, 5);
    for (let i = 1; i < seen.length; i++) expect(seen[i].loaded).toBeGreaterThanOrEqual(seen[i - 1].loaded);
  });

  test("hız yalnızca son ~5 saniyeye bakar", async () => {
    let now = 0;
    const size = 8 * PART;
    const s = fakeServer({
      size,
      putHandler: async (part) => {
        await new Promise((r) => setTimeout(r, part * 2));
        // İlk 4 parça 10'ar sn (yavaş), sonrakiler 1'er sn
        now += part <= 4 ? 10_000 : 1000;
        return new Response(null, { status: 200, headers: { ETag: `"e${part}"` } });
      },
    });
    const seen: UploadProgress[] = [];
    await uploadVideo(fakeFile("film.mp4", size), "k", {
      onProgress: (p) => seen.push(p),
      fetchImpl: s.fetchImpl,
      sleep: noSleep,
      now: () => now,
    });
    const seven = seen.find((p) => p.loaded === 7 * PART)!;
    // Ortalama (7 parça / 43 sn) değil, son pencere: ~1 parça/sn
    expect(seven.bytesPerSecond).toBeGreaterThan(0.7 * PART);
  });
});

describe("uploadKeyProblem", () => {
  test("32 karakter base62 kabul edilir, diğerleri reddedilir", () => {
    expect(uploadKeyProblem("Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z")).toBeNull();
    for (const k of ["", "kisa", "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z0", "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4-", "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4ç"])
      expect(uploadKeyProblem(k)).toBe("Yükleme anahtarı geçersiz");
  });
});

describe("uploadSubtitle", () => {
  test("tek PUT, uzantıya göre Content-Type, link döner", async () => {
    const s = fakeServer({ size: 1 });
    const file = fakeFile("Altyazı.srt", 1234);
    const res = await uploadSubtitle(file, "k", { onProgress, fetchImpl: s.fetchImpl });
    expect(res).toEqual({ url: "https://cdn.test/videolar/abc/altyazi.srt" });
    const start = s.calls.find((c) => c.url === "/api/uploads/subtitle")!;
    expect(start.body).toEqual({ fileName: "Altyazı.srt", size: 1234 });
    expect(start.headers["x-upload-key"]).toBe("k");
    const puts = s.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe("https://s3.test/sub");
    expect(puts[0].headers["content-type"]).toBe("application/x-subrip");
    expect(puts[0].headers["x-upload-key"]).toBeUndefined();
    expect(puts[0].body).toBe(file);
  });

  test("vtt için text/vtt", async () => {
    const s = fakeServer({ size: 1 });
    await uploadSubtitle(fakeFile("a.VTT", 10), "k", { onProgress, fetchImpl: s.fetchImpl });
    expect(s.calls.find((c) => c.method === "PUT")!.headers["content-type"]).toBe("text/vtt");
  });

  test("istemci doğrulaması: uzantı, boyut, boş", async () => {
    const s = fakeServer({ size: 1 });
    const up = (f: File) => uploadSubtitle(f, "k", { onProgress, fetchImpl: s.fetchImpl });
    await expect(up(fakeFile("a.txt", 10))).rejects.toThrow("Yalnızca .srt veya .vtt yüklenebilir");
    await expect(up(fakeFile("a.srt", MAX_SUBTITLE_BYTES + 1))).rejects.toThrow("Dosya çok büyük");
    await expect(up(fakeFile("a.srt", 0))).rejects.toThrow("Dosya boş");
    expect(s.calls).toHaveLength(0);
  });

  test("S3 PUT hatası yüzeye çıkar", async () => {
    const base = fakeServer({ size: 1 });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "https://s3.test/sub" ? new Response(null, { status: 403 }) : base.fetchImpl(input, init)) as typeof fetch;
    await expect(uploadSubtitle(fakeFile("a.srt", 10), "k", { onProgress, fetchImpl })).rejects.toThrow(/Altyazı yüklenemedi/);
  });
});
