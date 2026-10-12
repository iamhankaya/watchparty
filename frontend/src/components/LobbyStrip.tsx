import { useState } from "react";
import type { ConnectionStatus, Participant } from "../lib/types";
import { avatarTone } from "./Participants";
import { Icon } from "./Icon";
import { CodeBoard } from "./CodeBoard";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Bağlanıyor",
  connected: "Bağlı",
  reconnecting: "Yeniden bağlanıyor",
  disconnected: "Bağlantı koptu",
};

// Lobi kodunu ya da linkini panoya kopyalar; "copied" kısa süre son kopyalananı gösterir.
function useCopy(code: string) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const link = `${window.location.origin}/l/${code}`;

  async function copy(what: "code" | "link") {
    const text = what === "code" ? code : link;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      window.prompt("Kopyala:", text);
    }
  }

  return { copied, copy };
}

interface Props {
  code: string;
  status: ConnectionStatus;
  participants: Participant[];
}

const MAX_AVATARS = 5;

export function LobbyStrip({ code, status, participants }: Props) {
  const { copied, copy } = useCopy(code);
  const shown = participants.slice(0, MAX_AVATARS);
  const rest = participants.length - shown.length;

  return (
    <div className="cn-strip">
      <CodeBoard code={code} onClick={() => copy("code")} title={copied === "code" ? "Kopyalandı" : "Kodu kopyala"} />
      <div className="cn-strip-info">
        <span className={`cn-status cn-status-${status}`}>{copied === "code" ? "Kod kopyalandı" : STATUS_TEXT[status]}</span>
        {status === "disconnected" && (
          <button className="cn-link-btn" onClick={() => window.location.reload()}>
            Yeniden bağlan
          </button>
        )}
      </div>
      <ul className="cn-faces" aria-label={`${participants.length} kişi izliyor`}>
        {shown.map((p) => (
          <li key={p.id} className={`cn-face tone-${avatarTone(p.nickname)}`} title={p.isHost ? `${p.nickname} (host)` : p.nickname}>
            {p.nickname.slice(0, 1).toUpperCase()}
          </li>
        ))}
        {rest > 0 && <li className="cn-face cn-face-more">+{rest}</li>}
      </ul>
      <button className="cn-share" onClick={() => copy("link")}>
        <Icon name="link" />
        {copied === "link" ? "Link kopyalandı" : "Linki kopyala"}
      </button>
    </div>
  );
}
