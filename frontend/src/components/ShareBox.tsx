import { useState } from "react";
import type { ConnectionStatus } from "../lib/types";

export const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Bağlanıyor",
  connected: "Bağlı",
  reconnecting: "Yeniden bağlanıyor",
  disconnected: "Bağlantı koptu",
};

// Lobi kodunu ya da linkini panoya kopyalar; "copied" kısa süre son kopyalananı gösterir.
export function useCopy(code: string) {
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

export function ShareBox({ code, status }: { code: string; status: ConnectionStatus }) {
  const { copied, copy } = useCopy(code);

  return (
    <div className="card">
      <div className="share-head">
        <h3>Lobi</h3>
        <span className={`status status-${status}`}>{STATUS_TEXT[status]}</span>
      </div>
      <button className="code" onClick={() => copy("code")} title="Kodu kopyala">
        {code}
      </button>
      <div className="share-buttons">
        <button onClick={() => copy("code")}>{copied === "code" ? "Kopyalandı ✓" : "Kodu kopyala"}</button>
        <button onClick={() => copy("link")}>{copied === "link" ? "Kopyalandı ✓" : "Linki kopyala"}</button>
      </div>
      {status === "disconnected" && (
        <button className="full" onClick={() => window.location.reload()}>
          Yeniden bağlan
        </button>
      )}
    </div>
  );
}
