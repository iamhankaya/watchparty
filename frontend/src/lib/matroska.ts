// Yükleme öncesi MKV iz okuma: minimal EBML ayrıştırıcı (Segment → Tracks → TrackEntry). Güvenlik
// denetimi değildir; okunamayan dosya yüklemeyi engellemez, yalnızca "okunamadı" bilgisi üretir.
// Kötü niyetli dosyaya karşı: okuma en çok iki dilim (MKV_HEADER_BYTES), her döngü sınırlı ve ilerler.

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

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEKHEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_TRACKS = 0x1654ae6b;
const ID_CLUSTER = 0x1f43b675;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_LANGUAGE = 0x22b59c;
const ID_NAME = 0x536e;

/** Bir düzeydeki en fazla öğe sayısı (bozuk dosyada sonsuz döngüye karşı). */
const MAX_ELEMENTS = 5000;

export const MKV_UNREADABLE_MESSAGE = "Uyumluluk doğrulanamadı: codec bilgisi okunamadı, dosya yine de yüklenebilir.";

class Malformed extends Error {}

interface Element {
  id: number;
  dataStart: number;
  /** Veri bitişi; boyutu bilinmeyen öğede null. */
  dataEnd: number | null;
}

/** Öğe kimliği (işaretçi bitleri dahil) ya da boyut (işaretçi atılmış; bilinmeyen = null). */
function readVint(buf: Uint8Array, pos: number, isId: boolean): { value: number | null; len: number } {
  if (pos >= buf.length) throw new Malformed();
  const first = buf[pos];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || (isId && len > 4) || pos + len > buf.length) throw new Malformed();
  const mask = 0x80 >> (len - 1);
  let value = isId ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value: !isId && allOnes ? null : value, len };
}

/** `[start, end)` aralığındaki öğeleri sırayla verir; boyutu aralıktan taşan öğe Malformed (`lenient`: olduğu gibi verilir, tarama biter). */
function* elements(buf: Uint8Array, start: number, end: number, lenient = false): Generator<Element> {
  let pos = start;
  for (let n = 0; pos < end && n < MAX_ELEMENTS; n++) {
    const id = readVint(buf, pos, true);
    const size = readVint(buf, pos + id.len, false);
    const dataStart = pos + id.len + size.len;
    const dataEnd = size.value === null ? null : dataStart + size.value;
    if (!lenient && dataEnd !== null && dataEnd > end) throw new Malformed();
    yield { id: id.value!, dataStart, dataEnd };
    if (dataEnd === null) return;
    pos = dataEnd;
  }
}

const readUint = (buf: Uint8Array, e: Element) => {
  let v = 0;
  for (let i = e.dataStart; i < e.dataEnd!; i++) v = v * 256 + buf[i];
  return v;
};
const readString = (buf: Uint8Array, e: Element) =>
  new TextDecoder().decode(buf.subarray(e.dataStart, e.dataEnd!)).replace(/\0+$/, "");

function audioCompatibility(codecId: string): AudioCompatibility {
  if (/^A_(AAC|OPUS|VORBIS|FLAC|MPEG\/L3|PCM)/.test(codecId)) return "plays";
  if (/^A_(AC3|EAC3|DTS|TRUEHD|MLP)/.test(codecId)) return "unsupported";
  return "unknown";
}

function parseTracks(buf: Uint8Array, tracks: Element): MkvTrack[] {
  const out: MkvTrack[] = [];
  for (const entry of elements(buf, tracks.dataStart, tracks.dataEnd!)) {
    if (entry.id !== ID_TRACK_ENTRY || entry.dataEnd === null) continue;
    const track: MkvTrack = { number: 0, type: "other", codecId: "", audio: "unknown" };
    for (const f of elements(buf, entry.dataStart, entry.dataEnd)) {
      if (f.dataEnd === null) throw new Malformed();
      if (f.id === ID_TRACK_NUMBER) track.number = readUint(buf, f);
      else if (f.id === ID_TRACK_TYPE) {
        const t = readUint(buf, f);
        track.type = t === 1 ? "video" : t === 2 ? "audio" : t === 17 ? "subtitle" : "other";
      } else if (f.id === ID_CODEC_ID) track.codecId = readString(buf, f);
      else if (f.id === ID_LANGUAGE) track.language = readString(buf, f);
      else if (f.id === ID_NAME) track.name = readString(buf, f);
    }
    if (track.type === "audio") track.audio = audioCompatibility(track.codecId);
    out.push(track);
  }
  if (out.length === 0) throw new Malformed();
  return out;
}

function tracksSeekPosition(buf: Uint8Array, seekHead: Element): number | undefined {
  for (const seek of elements(buf, seekHead.dataStart, seekHead.dataEnd!)) {
    if (seek.id !== ID_SEEK || seek.dataEnd === null) continue;
    let id: number | undefined;
    let position: number | undefined;
    for (const f of elements(buf, seek.dataStart, seek.dataEnd)) {
      if (f.dataEnd === null) throw new Malformed();
      if (f.id === ID_SEEK_ID) id = readUint(buf, f);
      else if (f.id === ID_SEEK_POSITION) position = readUint(buf, f);
    }
    if (id === ID_TRACKS) return position;
  }
  return undefined;
}

/** Segment çocuklarını tarar: doğrudan Tracks ya da SeekHead'deki Tracks konumunu (Segment verisine göre) döner. */
function findTracks(buf: Uint8Array): { tracks?: Element; seekPosition?: number; segmentStart: number } {
  const [ebml] = elements(buf, 0, buf.length);
  if (ebml?.id !== ID_EBML || ebml.dataEnd === null) throw new Malformed();
  const [segment] = elements(buf, ebml.dataEnd, buf.length, true);
  if (segment?.id !== ID_SEGMENT) throw new Malformed();

  let seekPosition: number | undefined;
  try {
    for (const child of elements(buf, segment.dataStart, buf.length, true)) {
      if (child.id === ID_CLUSTER) break;
      if (child.id === ID_TRACKS) return { tracks: child, segmentStart: segment.dataStart };
      if (child.id === ID_SEEKHEAD && child.dataEnd !== null) seekPosition ??= tracksSeekPosition(buf, child);
    }
  } catch (e) {
    // Tampondan taşan öğe (ör. büyük ek dosya): Tracks yine SeekHead ile bulunabilir.
    if (!(e instanceof Malformed) || seekPosition === undefined) throw e;
  }
  return { seekPosition, segmentStart: segment.dataStart };
}

const slice = async (file: Blob, from: number, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const buf = new Uint8Array(await file.slice(from, from + MKV_HEADER_BYTES).arrayBuffer());
  signal?.throwIfAborted();
  return buf;
};

/**
 * Dosyanın başlığından iz listesini okur. `tracks` dosya sırasındadır (tarayıcı ilk ses izini çalar).
 * Bozuk/kesik dosya ya da okuma bütçesi aşımında reject ETMEZ, `status: "unreadable"` döner; yalnız
 * `signal` iptalinde `AbortError` ile reject eder.
 */
export async function readMatroskaTracks(file: Blob, signal?: AbortSignal): Promise<MkvInspection> {
  try {
    const head = await slice(file, 0, signal);
    const found = findTracks(head);
    if (found.tracks) return { status: "ok", tracks: parseTracks(head, found.tracks) };
    if (found.seekPosition === undefined) throw new Malformed();

    // Tracks ilk dilimin ötesinde: Segment verisine göre konumdan ikinci dilim okunur.
    const from = found.segmentStart + found.seekPosition;
    if (from >= file.size) throw new Malformed();
    const buf = await slice(file, from, signal);
    const [tracks] = elements(buf, 0, buf.length);
    if (tracks?.id !== ID_TRACKS || tracks.dataEnd === null) throw new Malformed();
    return { status: "ok", tracks: parseTracks(buf, tracks) };
  } catch (e) {
    if (e instanceof Malformed) return { status: "unreadable", tracks: [] };
    throw e;
  }
}

const CODEC_LABELS: [RegExp, string][] = [
  [/^A_AAC/, "AAC"],
  [/^A_OPUS/, "Opus"],
  [/^A_VORBIS/, "Vorbis"],
  [/^A_FLAC/, "FLAC"],
  [/^A_MPEG\/L3/, "MP3"],
  [/^A_EAC3/, "E-AC3"],
  [/^A_AC3/, "AC3"],
  [/^A_DTS/, "DTS"],
  [/^A_TRUEHD/, "TrueHD"],
];
const codecLabel = (codecId: string) => CODEC_LABELS.find(([re]) => re.test(codecId))?.[1] ?? codecId;
const trackLabel = (t: MkvTrack) => `${t.name || t.language || `iz ${t.number}`} (${codecLabel(t.codecId)})`;

/**
 * Tek birleşik uyarı metni (AC3 uyarısı ve çok izli ses listesi aynı metinde); gerekmiyorsa null.
 * Okunamayan dosya için `MKV_UNREADABLE_MESSAGE` döner. Yükleme asla engellenmez.
 */
export function audioWarning(inspection: MkvInspection): string | null {
  if (inspection.status === "unreadable") return MKV_UNREADABLE_MESSAGE;
  const audio = inspection.tracks.filter((t) => t.type === "audio");
  if (audio.length === 0) return null;
  const parts: string[] = [];
  if (audio[0].audio === "unsupported")
    parts.push(`Bu dosyanın sesi tarayıcıda çalmayabilir (${codecLabel(audio[0].codecId)}).`);
  if (audio.length > 1)
    parts.push(`Birden çok ses izi var; tarayıcı ilk sesi çalar (izlerde: ${audio.map(trackLabel).join(", ")}).`);
  return parts.length ? parts.join(" ") : null;
}
