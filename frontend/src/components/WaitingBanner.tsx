import type { Participant, PlaybackState } from "../lib/types";

interface Props {
  playback: PlaybackState | null;
  participants: Participant[];
  selfId: string | null;
  canControl: boolean;
  onSkip(): void;
}

/** Şerit metni; bekleyen yoksa null. Listede henüz/artık katılımcı listesinde olmayan kimlikler ada çevrilmez, yalnızca sayılır. */
export function waitingText(waitingFor: string[], participants: Participant[], selfId: string | null): string | null {
  if (waitingFor.length === 0) return null;
  if (selfId && waitingFor.includes(selfId)) return "Videon yükleniyor, herkes seni bekliyor…";
  const others = waitingFor.filter((id) => id !== selfId);
  if (others.length === 1) {
    const name = participants.find((p) => p.id === others[0])?.nickname;
    if (name) return `${name}'nin videosu yükleniyor…`;
  }
  return `${others.length} kişi bekleniyor…`;
}

/** Oynatıcının üstünde: takılan biri bekleniyorken konumun neden donduğunu söyler. */
export function WaitingBanner({ playback, participants, selfId, canControl, onSkip }: Props) {
  const text = playback?.isPlaying ? waitingText(playback.waitingFor ?? [], participants, selfId) : null;
  if (!text) return null;
  return (
    <div className="waiting-banner" role="status">
      <p>{text}</p>
      {canControl && <button onClick={onSkip}>Beklemeden devam et</button>}
    </div>
  );
}
