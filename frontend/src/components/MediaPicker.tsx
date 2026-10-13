import { useState, type FormEvent } from "react";
import { parseMediaInput } from "../lib/media";
import { MAX_MEDIA_ID, type MediaType, type PlaybackState } from "../lib/types";

interface Props {
  disabled: boolean;
  playback: PlaybackState | null;
  /** Hata olursa reddeder (hata metnini çağıran gösterir). */
  onSetMedia(type: MediaType, id: string): Promise<void>;
  onSetSubtitle(url: string | null): Promise<void>;
}

// Sunucudaki MediaValidator.ValidateSubtitle ile aynı kontrol (aynı metinler).
function subtitleProblem(url: string): string | null {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // geçersiz adres: aşağıda https hatası verilir
  }
  if (parsed?.protocol !== "https:") return "Altyazı adresi https:// ile başlamalı";
  if (url.length > MAX_MEDIA_ID) return `Altyazı adresi en fazla ${MAX_MEDIA_ID} karakter olmalı`;
  return null;
}

export function MediaPicker({ disabled, playback, onSetMedia, onSetSubtitle }: Props) {
  const [value, setValue] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const sub = subtitle.trim();
    const media = value.trim() ? parseMediaInput(value) : null;

    if (value.trim()) {
      if (!media) return setProblem("Bu bir YouTube linki ya da https:// ile başlayan bir video adresi gibi görünmüyor.");
      if (media.id.length > MAX_MEDIA_ID) return setProblem(`Adres çok uzun (en fazla ${MAX_MEDIA_ID} karakter).`);
    }
    if (sub) {
      const p = subtitleProblem(sub);
      if (p) return setProblem(p);
      const type = media ? media.type : playback?.mediaId ? playback.mediaType : null;
      if (!type) return setProblem("Önce bir medya seç");
      if (type !== "file") return setProblem("Altyazı yalnızca MP4 videolarda kullanılabilir");
    }

    setBusy(true);
    try {
      // Önce video (sunucu yeni videoda altyazıyı sıfırlar), başarılıysa altyazı.
      if (media) {
        await onSetMedia(media.type, media.id);
        setValue("");
      }
      if (sub) {
        await onSetSubtitle(sub);
        setSubtitle("");
      }
    } catch {
      // Hata metnini çağıran gösterdi; alanlar düzeltilebilsin diye silinmez.
    } finally {
      setBusy(false);
    }
  }

  const change = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setProblem(null);
  };

  return (
    <form className="media-picker" onSubmit={handleSubmit}>
      <input
        value={value}
        onChange={change(setValue)}
        placeholder="YouTube linki veya MP4 adresi (https://...)"
        disabled={disabled}
        aria-invalid={problem !== null}
      />
      <button className="primary" disabled={disabled || busy || (!value.trim() && !subtitle.trim())}>
        Herkese aç
      </button>
      <div className="subtitle-row">
        <input
          value={subtitle}
          onChange={change(setSubtitle)}
          placeholder="Altyazı linki (.vtt / .srt, isteğe bağlı)"
          disabled={disabled}
          aria-invalid={problem !== null}
        />
        {playback?.subtitleUrl && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              setProblem(null);
              onSetSubtitle(null).catch(() => {});
            }}
          >
            Altyazıyı kaldır
          </button>
        )}
      </div>
      {problem && <p className="error small">{problem}</p>}
    </form>
  );
}
