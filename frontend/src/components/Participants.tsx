import { MAX_PARTICIPANTS, type Participant, type VoiceMember } from "../lib/types";
import type { PeerState } from "../lib/voice";
import { Icon } from "./Icon";

// Takma addan sabit bir renk seçer; aynı kişi her ekranda aynı renkte görünür.
export function avatarTone(nickname: string): number {
  let h = 0;
  for (const ch of nickname) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}

/** Kişiler listesinde gösterilecek sesli sohbet bilgisi. */
export interface VoiceView {
  members: VoiceMember[];
  /** Ben sesli sohbetteysem: konuşma, bağlantı durumu ve ses düzeyi yalnızca o zaman anlamlı. */
  joined: boolean;
  selfMuted: boolean;
  speaking: ReadonlySet<string>;
  peerStates: Record<string, PeerState>;
  volumes: Record<string, number>;
  onVolume(id: string, value: number): void;
}

interface Props {
  participants: Participant[];
  selfId: string | null;
  voice: VoiceView;
}

export function Participants({ participants, selfId, voice }: Props) {
  const inVoice = new Map(voice.members.map((m) => [m.id, m]));
  return (
    <div className="card">
      <h3>
        Katılımcılar <span className="muted">{participants.length}/{MAX_PARTICIPANTS}</span>
      </h3>
      <ul className="people">
        {participants.map((p) => {
          const member = inVoice.get(p.id);
          const self = p.id === selfId;
          // Kendi sessiz durumum yerelde anında değişir; sunucu yayını sonra gelir.
          const muted = self && voice.joined ? voice.selfMuted : !!member?.muted;
          const speaking = !!member && voice.joined && !muted && voice.speaking.has(p.id);
          const failed = !!member && voice.joined && !self && voice.peerStates[p.id] === "failed";
          const volume = voice.volumes[p.id] ?? 100;
          const voiceLabel = failed ? "Bağlanamadı" : muted ? "Mikrofonu kapalı" : speaking ? "Konuşuyor" : "Sesli sohbette";
          return (
            <li key={p.id} className={speaking ? "is-speaking" : undefined}>
              <span className={`avatar tone-${avatarTone(p.nickname)}`}>{p.nickname.slice(0, 1).toUpperCase()}</span>
              <span className="name">{p.nickname}</span>
              {self && <span className="muted small">(sen)</span>}
              <span className="people-end">
                {member && (
                  <span
                    className={`voice-state${speaking ? " speaking" : ""}${muted ? " muted-mic" : ""}${failed ? " failed" : ""}`}
                    role="img"
                    aria-label={voiceLabel}
                    title={voiceLabel}
                    data-voice-id={p.id}
                  >
                    <Icon name={failed ? "alert" : muted ? "micOff" : "mic"} />
                  </span>
                )}
                {p.isHost && (
                  <span className="host" title="Host">
                    <Icon name="crown" />
                  </span>
                )}
              </span>
              {member && voice.joined && !self && (
                <label className="people-volume" title={`${p.nickname} ses düzeyi`}>
                  <Icon name={volume === 0 ? "mute" : "volume"} />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={volume}
                    onChange={(e) => voice.onVolume(p.id, Number(e.target.value))}
                    aria-label={`${p.nickname} ses düzeyi`}
                  />
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
