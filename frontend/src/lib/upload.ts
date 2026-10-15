// Tarayıcıdan S3'e doğrudan yükleme. Sunucu yalnızca yükleme anahtarını doğrular ve kısa süreli
// imzalı (presigned) adresler üretir; dosyanın kendisi sunucudan geçmez.
//
// Video: çok parçalı (multipart) yükleme. Parça boyutu ve sayısı sunucudan gelir; parça adresleri
// gerektikçe en fazla 50'lik partilerle istenir; aynı anda en fazla 4 parça gider; başarısız parça
// artan beklemeyle (1, 2, 4 sn) 3 kez yeniden denenir. Kesin hata ya da iptalde sunucuya `abort`
// çağrılır ki S3'te yarım parça kalmasın.
//
// İlerleme: fetch yükleme ilerlemesi bildirmediği için `loaded` yalnızca **tamamlanan** parçaları
// sayar (16 MB'lık adımlarla artar). Hız son ~5 sn'de tamamlanan baytlardan hesaplanır.

export const MAX_VIDEO_BYTES = 6_442_450_944; // 6 GB, sunucudaki Upload:MaxVideoBytes
export const MAX_SUBTITLE_BYTES = 2_097_152; // 2 MB, sunucudaki Upload:MaxSubtitleBytes
export const UPLOAD_KEY_STORAGE = "wp:uploadKey";

const CONCURRENCY = 4;
const URL_BATCH = 50;
const RETRY_DELAYS_MS = [1000, 2000, 4000]; // ilk denemeden sonra 3 yeniden deneme
const SPEED_WINDOW_MS = 5000;
const CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface UploadProgress {
  loaded: number;
  total: number;
  bytesPerSecond: number;
  /** Hız henüz ölçülemediyse null. */
  secondsLeft: number | null;
}

export interface UploadOptions {
  onProgress(p: UploadProgress): void;
  signal?: AbortSignal;
  /** Sunucu başlatma isteğini kabul edince (anahtar doğrulandı) bir kez çağrılır. */
  onStarted?(): void;
  fetchImpl?: typeof fetch;
  /** Testler için: yeniden deneme beklemesi ve saat. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PartPlan {
  partNumber: number;
  start: number;
  end: number;
}

/** Dosyayı `partSize`'lık parçalara böler; son parça kalan bayt kadardır. */
export function planParts(size: number, partSize: number): PartPlan[] {
  const parts: PartPlan[] = [];
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    parts.push({ partNumber: n, start, end: Math.min(size, start + partSize) });
  }
  return parts;
}

const extension = (name: string) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
};

// upload-keys.ps1'in ürettiği biçim (32 karakter base62); biçimsiz anahtar sunucuya hiç gönderilmez.
export function uploadKeyProblem(key: string): string | null {
  return /^[A-Za-z0-9]{32}$/.test(key) ? null : "Yükleme anahtarı geçersiz";
}

// Sunucudaki doğrulamayla aynı metinler.
export function videoProblem(file: File): string | null {
  if (!["mp4", "m4v"].includes(extension(file.name))) return "Yalnızca .mp4 veya .m4v yüklenebilir";
  if (file.size <= 0) return "Dosya boş";
  if (file.size > MAX_VIDEO_BYTES) return "Dosya çok büyük";
  return null;
}

export function subtitleFileProblem(file: File): string | null {
  if (!["srt", "vtt"].includes(extension(file.name))) return "Yalnızca .srt veya .vtt yüklenebilir";
  if (file.size <= 0) return "Dosya boş";
  if (file.size > MAX_SUBTITLE_BYTES) return "Dosya çok büyük";
  return null;
}

const abortError = () => new DOMException("Yükleme iptal edildi", "AbortError");
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Sunucu hata gövdesi: `{ error }` (ya da ProblemDetails); JSON değilse durum koduna düşer. */
async function errorFromResponse(res: Response): Promise<Error> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // gövde okunamadı
  }
  if (text) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const msg = [body.error, body.message, body.detail, body.title].find((v) => typeof v === "string" && v);
      if (msg) return new Error(msg as string);
    } catch {
      // JSON değil
    }
  }
  if (res.status === 429) return new Error("Çok fazla deneme, biraz bekleyip tekrar deneyin (HTTP 429)");
  return new Error(`İstek başarısız (HTTP ${res.status}${res.statusText ? " " + res.statusText : ""})`);
}

function makeApi(fetchImpl: typeof fetch, uploadKey: string) {
  return async function api<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Upload-Key": uploadKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (isAbort(e) || signal?.aborted) throw abortError();
      throw new Error("Sunucuya ulaşılamadı");
    }
    if (!res.ok) throw await errorFromResponse(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Son ~5 sn'deki tamamlanan baytlardan hız ve kalan süre. */
function progressMeter(total: number, now: () => number, onProgress: (p: UploadProgress) => void) {
  const samples: { t: number; loaded: number }[] = [{ t: now(), loaded: 0 }];
  let loaded = 0;
  onProgress({ loaded: 0, total, bytesPerSecond: 0, secondsLeft: null });
  return (bytes: number) => {
    loaded += bytes;
    const t = now();
    samples.push({ t, loaded });
    // Pencere dışındakileri at, ama hız hesaplanabilsin diye en az iki örnek kalsın.
    while (samples.length > 2 && samples[0].t < t - SPEED_WINDOW_MS) samples.shift();
    const first = samples[0];
    const dt = (t - first.t) / 1000;
    const bytesPerSecond = dt > 0 ? (loaded - first.loaded) / dt : 0;
    const secondsLeft = bytesPerSecond > 0 ? (total - loaded) / bytesPerSecond : null;
    onProgress({ loaded, total, bytesPerSecond, secondsLeft });
  };
}

class PartError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly expired = false,
  ) {
    super(message);
  }
}

export async function uploadVideo(file: File, uploadKey: string, opts: UploadOptions): Promise<{ url: string }> {
  const problem = videoProblem(file);
  if (problem) throw new Error(problem);
  if (opts.signal?.aborted) throw abortError();

  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const now = opts.now ?? (() => performance.now());
  const api = makeApi(fetchImpl, uploadKey);

  // İç denetleyici: kullanıcı iptali ya da kesin hata kalan tüm istekleri durdurur.
  const inner = new AbortController();
  const onUserAbort = () => inner.abort();
  opts.signal?.addEventListener("abort", onUserAbort, { once: true });
  const signal = inner.signal;
  const sleep = opts.sleep ?? ((ms: number) => defaultSleep(ms, signal));

  let start: { key: string; uploadId: string; partSize: number; partCount: number };
  try {
    start = await api("/api/uploads/video", { fileName: file.name, size: file.size }, signal);
  } catch (e) {
    opts.signal?.removeEventListener("abort", onUserAbort);
    throw e;
  }
  opts.onStarted?.();
  const { key, uploadId } = start;
  const parts = planParts(file.size, start.partSize);

  // Parça adresleri: 50'lik partiler, ilk ihtiyaç anında istenir.
  const urls = new Map<number, string>();
  const batches = new Map<number, Promise<void>>();
  const requestUrls = async (partNumbers: number[]) => {
    const res = await api<{ urls: { partNumber: number; url: string }[] }>(
      "/api/uploads/video/parts",
      { key, uploadId, partNumbers },
      signal,
    );
    for (const u of res.urls) urls.set(u.partNumber, u.url);
  };
  const urlFor = async (n: number) => {
    const b = Math.floor((n - 1) / URL_BATCH);
    if (!urls.has(n)) {
      let p = batches.get(b);
      if (!p) {
        const from = b * URL_BATCH + 1;
        const to = Math.min(parts.length, from + URL_BATCH - 1);
        const nums = Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((x) => !urls.has(x));
        p = requestUrls(nums);
        batches.set(b, p);
        // Başarısız parti sonraki denemede yeniden istenebilsin
        p.catch(() => batches.delete(b));
      }
      await p;
    }
    const url = urls.get(n);
    if (!url) throw new PartError(`${n}. parçanın adresi alınamadı`, true);
    return url;
  };

  const putPart = async (part: PartPlan): Promise<string> => {
    const url = await urlFor(part.partNumber);
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "PUT", body: file.slice(part.start, part.end), signal });
    } catch (e) {
      if (signal.aborted || isAbort(e)) throw abortError();
      throw new PartError(`${part.partNumber}. parça yüklenemedi (ağ hatası)`, true);
    }
    if (!res.ok) {
      throw new PartError(`${part.partNumber}. parça yüklenemedi (HTTP ${res.status})`, true, res.status === 403);
    }
    const eTag = res.headers.get("ETag");
    // ETag okunamıyorsa bucket CORS'u başlığı göstermiyor: yeniden denemek işe yaramaz.
    if (!eTag) throw new PartError("Yükleme yanıtında ETag yok (S3 CORS ayarı)", false);
    return eTag;
  };

  const uploadPart = async (part: PartPlan): Promise<string> => {
    let refreshed = false;
    for (let attempt = 0; ; ) {
      if (signal.aborted) throw abortError();
      try {
        return await putPart(part);
      } catch (e) {
        if (signal.aborted || isAbort(e)) throw abortError();
        // Süresi dolmuş adres: bir kez yenile, deneme hakkı harcamadan tekrar dene
        if (e instanceof PartError && e.expired && !refreshed) {
          refreshed = true;
          urls.delete(part.partNumber);
          await requestUrls([part.partNumber]);
          continue;
        }
        const retryable = !(e instanceof PartError) || e.retryable;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw e;
        await sleep(RETRY_DELAYS_MS[attempt]);
        attempt++;
      }
    }
  };

  const report = progressMeter(file.size, now, opts.onProgress);
  const eTags = new Map<number, string>();
  let next = 0;
  let failure: unknown = null;

  const worker = async () => {
    while (!failure && next < parts.length) {
      const part = parts[next++];
      try {
        eTags.set(part.partNumber, await uploadPart(part));
        report(part.end - part.start);
      } catch (e) {
        if (!failure) failure = e;
        inner.abort(); // diğer parçalar da dursun
      }
    }
  };

  try {
    if (parts.length !== start.partCount) throw new Error("Sunucunun parça planı dosyayla uyuşmuyor");
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parts.length) }, worker));
    if (opts.signal?.aborted) throw abortError();
    if (failure) throw failure;
    return await api<{ url: string }>(
      "/api/uploads/video/complete",
      { key, uploadId, parts: parts.map((p) => ({ partNumber: p.partNumber, eTag: eTags.get(p.partNumber)! })) },
      signal,
    );
  } catch (e) {
    // En iyi çaba: S3'te yarım parça bırakma (kalırsa yaşam döngüsü kuralı temizler).
    await api("/api/uploads/video/abort", { key, uploadId }).catch(() => {});
    throw opts.signal?.aborted ? abortError() : e;
  } finally {
    opts.signal?.removeEventListener("abort", onUserAbort);
  }
}

export async function uploadSubtitle(file: File, uploadKey: string, opts: UploadOptions): Promise<{ url: string }> {
  const problem = subtitleFileProblem(file);
  if (problem) throw new Error(problem);
  if (opts.signal?.aborted) throw abortError();

  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const api = makeApi(fetchImpl, uploadKey);
  const now = opts.now ?? (() => performance.now());
  const report = progressMeter(file.size, now, opts.onProgress);

  const start = await api<{ key: string; putUrl: string; url: string }>(
    "/api/uploads/subtitle",
    { fileName: file.name, size: file.size },
    opts.signal,
  );
  const contentType = extension(file.name) === "vtt" ? "text/vtt" : "application/x-subrip";
  let res: Response;
  try {
    res = await fetchImpl(start.putUrl, {
      method: "PUT",
      // Content-Type imzalı adresle aynı olmalı; Cache-Control nesneye üstveri olarak yazılır.
      headers: { "Content-Type": contentType, "Cache-Control": CACHE_CONTROL },
      body: file,
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted || isAbort(e)) throw abortError();
    throw new Error("Altyazı yüklenemedi (ağ hatası)");
  }
  if (!res.ok) throw new Error(`Altyazı yüklenemedi (HTTP ${res.status})`);
  report(file.size);
  return { url: start.url };
}
