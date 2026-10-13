// Hesap sistemi yok: tarayıcıya kalıcı bir clientId ve son kullanılan takma ad kaydedilir.
const CLIENT_ID_KEY = "wp:clientId";
const NICKNAME_KEY = "wp:nickname";

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Mock modda sekmeler aynı tarayıcıda farklı kişiler gibi davransın diye clientId sekmeye özel tutulur.
const idStorage = () => (import.meta.env.VITE_MOCK === "true" ? sessionStorage : localStorage);

function read(key: string, storage: () => Storage = () => localStorage): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string, storage: () => Storage = () => localStorage) {
  try {
    storage().setItem(key, value);
  } catch {
    // Gizli sekme vb. durumlarda kalıcılık olmadan devam edilir.
  }
}

let memoryClientId: string | null = null;

export function getClientId(): string {
  const stored = read(CLIENT_ID_KEY, idStorage);
  if (stored) return stored;
  memoryClientId ??= randomId();
  write(CLIENT_ID_KEY, memoryClientId, idStorage);
  return memoryClientId;
}

export const getNickname = () => read(NICKNAME_KEY) ?? "";
export const saveNickname = (nickname: string) => write(NICKNAME_KEY, nickname);

export interface VolumeSetting {
  volume: number; // 0-100
  muted: boolean;
}

export function getVolume(): VolumeSetting {
  try {
    const v = JSON.parse(read("wp:volume") ?? "") as VolumeSetting;
    if (typeof v.volume === "number" && typeof v.muted === "boolean") return v;
  } catch {
    // kayıt yoksa varsayılan
  }
  return { volume: 80, muted: false };
}

export const saveVolume = (v: VolumeSetting) => write("wp:volume", JSON.stringify(v));

// Altyazı açık/kapalı kişiye özel; varsayılan açık.
export const getSubtitlesOn = () => read("wp:subtitles") !== "false";
export const saveSubtitlesOn = (on: boolean) => write("wp:subtitles", String(on));

// Sohbet bildirim sesi kişiye özel; varsayılan açık.
export const getChatSoundOn = () => read("wp:chatSound") !== "false";
export const saveChatSoundOn = (on: boolean) => write("wp:chatSound", String(on));
