import { MAX_PARTICIPANTS, type Participant } from "../lib/types";

interface Props {
  participants: Participant[];
  selfId: string | null;
}

export function Participants({ participants, selfId }: Props) {
  return (
    <div className="card">
      <h3>
        Katılımcılar <span className="muted">{participants.length}/{MAX_PARTICIPANTS}</span>
      </h3>
      <ul className="people">
        {participants.map((p) => (
          <li key={p.id}>
            <span className="avatar">{p.nickname.slice(0, 1).toUpperCase()}</span>
            <span className="name">{p.nickname}</span>
            {p.id === selfId && <span className="muted small">(sen)</span>}
            {p.isHost && (
              <span className="host" title="Host">
                👑
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
