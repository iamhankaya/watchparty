// Altyazı dosyası çözme ve ayrıştırma (SRT / WebVTT). Saf fonksiyonlar.

export interface Cue {
  start: number; // saniye
  end: number;
  text: string;
}

/** Baytları metne çevirir: önce UTF-8 (katı), olmazsa Windows-1254 (Türkçe). Baştaki BOM atılır. */
export function decodeSubtitle(bytes: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1254").decode(bytes);
  }
  return text.replace(/^\uFEFF/, "");
}

// [ss:]dd:ss[.,]ttt — saat kısmı isteğe bağlı
const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;

function parseTime(s: string): number | null {
  const m = TIME.exec(s);
  if (!m) return null;
  const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

/** SRT veya VTT metnini cue listesine çevirir; bozuk bloklar atlanır. */
export function parseSubtitles(text: string): Cue[] {
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}|\n[ \t]*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue; // WEBVTT başlığı, NOTE/STYLE blokları vb.
    const [a, rest] = lines[i].split("-->");
    const start = parseTime(a.trim());
    const end = parseTime(rest.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;
    const body = lines.slice(i + 1).join("\n").replace(/\{\\[^}]*\}/g, "").trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}
