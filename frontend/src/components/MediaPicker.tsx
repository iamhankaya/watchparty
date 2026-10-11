import { useState, type FormEvent } from "react";
import { parseMediaInput } from "../lib/media";
import { MAX_MEDIA_ID, type MediaType } from "../lib/types";

interface Props {
  disabled: boolean;
  onSubmit(type: MediaType, id: string): void;
}

export function MediaPicker({ disabled, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const media = parseMediaInput(value);
    if (!media) return setProblem("Bu bir YouTube linki ya da https:// ile başlayan bir video adresi gibi görünmüyor.");
    if (media.id.length > MAX_MEDIA_ID) return setProblem(`Adres çok uzun (en fazla ${MAX_MEDIA_ID} karakter).`);
    onSubmit(media.type, media.id);
    setValue("");
  }

  return (
    <form className="media-picker" onSubmit={handleSubmit}>
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setProblem(null);
        }}
        placeholder="YouTube linki veya MP4 adresi (https://...)"
        disabled={disabled}
        aria-invalid={problem !== null}
      />
      <button className="primary" disabled={disabled || !value.trim()}>
        Herkese aç
      </button>
      {problem && <p className="error small">{problem}</p>}
    </form>
  );
}
