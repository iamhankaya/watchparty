import { MAX_PARTICIPANTS, type Participant } from "../lib/types";
import { useAppearance } from "../lib/appearance";
import { Icon } from "./Icon";

// Takma addan sabit bir renk seçer; aynı kişi her ekranda aynı renkte görünür.
export function avatarTone(nickname: string): number {
  let h = 0;
  for (const ch of nickname) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}

interface Props {
  participants: Participant[];
  selfId: string | null;
}

export function Participants({ participants, selfId }: Props) {
  const { design } = useAppearance();
  return (
    <div className="card">
      <h3>
        Katılımcılar <span className="muted">{participants.length}/{MAX_PARTICIPANTS}</span>
      </h3>
      <ul className="people">
        {participants.map((p) => (
          <li key={p.id}>
            <span className={`avatar tone-${avatarTone(p.nickname)}`}>{p.nickname.slice(0, 1).toUpperCase()}</span>
            <span className="name">{p.nickname}</span>
            {p.id === selfId && <span className="muted small">(sen)</span>}
            {p.isHost && (
              <span className="host" title="Host">
                {design === "cinema" ? <Icon name="crown" /> : "👑"}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
