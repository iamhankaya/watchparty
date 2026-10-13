// Backend'deki PlaybackState record'unun JSON hali (SignalR camelCase gönderir).
export type MediaType = "youtube" | "file";

export interface PlaybackState {
  mediaType: MediaType | null;
  mediaId: string | null;
  isPlaying: boolean;
  positionSec: number;
  updatedAt: number; // sunucu saati, unix ms
  subtitleUrl: string | null; // lobi genelinde ortak altyazı (yalnızca MP4)
  waitingFor: string[]; // takılıp beklenen katılımcıların id'leri; doluyken oynatma sanal olarak durur
}

export interface Participant {
  id: string; // JoinLobby'nin döndürdüğü selfId ile aynı
  nickname: string;
  isHost: boolean;
}

export interface ChatMessage {
  nickname: string;
  text: string;
  sentAt: number; // sunucu saati, unix ms
}

export interface JoinResult {
  selfId: string;
  isHost: boolean;
}

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export const MAX_PARTICIPANTS = 20;
export const MAX_NICKNAME = 30;
export const MAX_CHAT = 500;
export const MAX_MEDIA_ID = 200;

/**
 * Oynuyorsa geçen süreyi ekleyerek "şu an" olması gereken konumu hesaplar.
 * Takılan biri bekleniyorsa konum donmuştur (sunucu donma anında positionSec'i günceller).
 */
export function expectedPosition(state: PlaybackState, serverNow: number): number {
  if (!state.isPlaying || (state.waitingFor?.length ?? 0) > 0) return state.positionSec;
  return Math.max(0, state.positionSec + (serverNow - state.updatedAt) / 1000);
}
