import { MAX_VOICE } from "../lib/types";
import type { VoicePhase } from "../lib/useVoice";
import { Icon } from "./Icon";

interface Props {
  phase: VoicePhase;
  count: number;
  muted: boolean;
  /** Sunucu bağlantısı yokken katılma düğmesi kapalı. */
  online: boolean;
  onJoin(): void;
  onLeave(): void;
  onToggleMute(): void;
}

// Yan panelin üstündeki ses şeridi: katılmadan önce katılma düğmesi ve kulaklık notu, sonra mikrofon ve "Ayrıl".
export function VoiceBar({ phase, count, muted, online, onJoin, onLeave, onToggleMute }: Props) {
  const countLabel = (
    <span className="voice-count muted small" title="Sesli sohbetteki kişi sayısı">
      {count}/{MAX_VOICE}
    </span>
  );

  if (phase !== "joined") {
    const full = count >= MAX_VOICE;
    return (
      <div className="voice-bar">
        <div className="voice-row">
          <button
            className="voice-join"
            disabled={full || !online || phase === "joining"}
            title={full ? "Sesli sohbet dolu" : undefined}
            onClick={onJoin}
          >
            <Icon name="headphones" />
            {phase === "joining" ? "Bağlanıyor..." : "Sesli sohbete katıl"}
          </button>
          {count > 0 && countLabel}
        </div>
        <p className="voice-note muted small">Hoparlörden izliyorsan kulaklık önerilir.</p>
      </div>
    );
  }

  return (
    <div className="voice-bar is-joined">
      <div className="voice-row">
        <button
          className={`icon voice-mic${muted ? " is-muted" : ""}`}
          onClick={onToggleMute}
          aria-pressed={muted}
          title={muted ? "Mikrofonu aç" : "Mikrofonu kapat"}
        >
          <Icon name={muted ? "micOff" : "mic"} />
        </button>
        <span className="voice-live small">Sesli sohbettesin</span>
        {countLabel}
        <button className="voice-leave" onClick={onLeave}>
          <Icon name="phoneOff" />
          Ayrıl
        </button>
      </div>
    </div>
  );
}
