import type { PlaybackState } from "../lib/types";
import type { Player } from "../players/Player";
import { FilePlayer } from "../players/FilePlayer";
import { YouTubePlayer } from "../players/YouTubePlayer";

interface Props {
  playback: PlaybackState | null;
  blocked: boolean;
  canControl: boolean;
  subtitlesOn: boolean;
  onTogglePlay(): void;
  onPlayer(player: Player | null): void;
  onError(message: string): void;
  onUnblock(): void;
}

export function PlayerArea({ playback, blocked, canControl, subtitlesOn, onTogglePlay, onPlayer, onError, onUnblock }: Props) {
  const type = playback?.mediaType;
  const id = playback?.mediaId;

  return (
    <div className="player">
      {!id && (
        <div className="player-empty">
          <p>Henüz bir şey seçilmedi.</p>
          <p className="muted small">Aşağıya bir YouTube linki ya da MP4 adresi yapıştır.</p>
        </div>
      )}
      {/* key: medya değişince oynatıcı baştan kurulur */}
      {id && type === "youtube" && <YouTubePlayer key={id} videoId={id} onPlayer={onPlayer} onError={onError} />}
      {id && type === "file" && (
        <FilePlayer
          key={id}
          url={id}
          subtitleUrl={playback?.subtitleUrl ?? null}
          subtitlesOn={subtitlesOn}
          onPlayer={onPlayer}
          onError={onError}
        />
      )}
      {/* YouTube'un kendi tıklamalarını yakalar: tıklama oynatıcıya değil sunucuya gider (oynat/durdur),
          böylece herkes aynı anda oynar. Oynatma engellendiyse tıklama engeli kaldırır. */}
      {id && (
        <div
          className={`player-shield${canControl || blocked ? " clickable" : ""}`}
          onClick={() => (blocked ? onUnblock() : canControl && onTogglePlay())}
          title={canControl ? (playback?.isPlaying ? "Durdur" : "Oynat") : undefined}
        />
      )}
      {blocked && (
        <button className="unblock" onClick={onUnblock}>
          ▶ Oynatmayı başlatmak için tıkla
        </button>
      )}
    </div>
  );
}
