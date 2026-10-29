// Yükleme öncesi MKV iz okuma sözleşmesi. Ayrıştırıcı (Segment → Tracks → TrackEntry) uygulama
// fazında yazılır; okunamayan dosya yüklemeyi engellemez, yalnızca "okunamadı" bilgisi üretir.

/** Başlık okuma bütçesi: dosyanın ilk 2 MiB'ı (Tracks daha sonraysa SeekHead ile ikinci okuma). */
export const MKV_HEADER_BYTES = 2 * 1024 * 1024;

/** Sesin tarayıcıda çalma tahmini: AC3/E-AC3/DTS/TrueHD Chrome'da hatasız sessiz oynar. */
export type AudioCompatibility = "plays" | "unsupported" | "unknown";

export interface MkvTrack {
  /** Matroska TrackNumber. */
  number: number;
  type: "video" | "audio" | "subtitle" | "other";
  /** Ham Matroska CodecID, ör. "A_AAC", "A_AC3", "V_MPEG4/ISO/AVC". */
  codecId: string;
  /** Yalnız ses izlerinde anlamlı; diğerlerinde "unknown". */
  audio: AudioCompatibility;
  language?: string;
  name?: string;
}

/**
 * `ok`: Tracks okundu. `unreadable`: bozuk/kesik ya da okuma bütçesi doldu; "codec desteklenmiyor"
 * anlamına gelmez, yükleme engellenmez.
 */
export interface MkvInspection {
  status: "ok" | "unreadable";
  tracks: MkvTrack[];
}

/** Dosyanın başlığından iz listesini okur; `signal` ile iptal edilir. Asla sonsuza dek okumaz. */
export function readMatroskaTracks(_file: Blob, _signal?: AbortSignal): Promise<MkvInspection> {
  return Promise.reject(new Error("Uygulama fazında yazılacak (T20261029-23)"));
}

/** Kullanıcıya gösterilecek uyarı metni; uyarı gerekmiyorsa null. Yükleme asla engellenmez. */
export function audioWarning(_inspection: MkvInspection): string | null {
  throw new Error("Uygulama fazında yazılacak (T20261029-23)");
}
