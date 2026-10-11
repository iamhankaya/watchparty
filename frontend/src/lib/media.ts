import type { MediaType } from "./types";

export interface ParsedMedia {
  type: MediaType;
  id: string;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** YouTube linki/ID'si veya doğrudan bir video URL'sini (MP4) ayırt eder. */
export function parseMediaInput(input: string): ParsedMedia | null {
  const text = input.trim();
  if (!text) return null;
  if (YOUTUBE_ID.test(text)) return { type: "youtube", id: text };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1, 12);
    return YOUTUBE_ID.test(id) ? { type: "youtube", id } : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = url.searchParams.get("v");
    if (v && YOUTUBE_ID.test(v)) return { type: "youtube", id: v };
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    return m ? { type: "youtube", id: m[1] } : null;
  }

  // YouTube değilse film URL'si kabul edilir (şimdilik doğrudan URL; ileride S3/CloudFront film id'si).
  return { type: "file", id: url.toString() };
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
