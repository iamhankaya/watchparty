import { useState, type FormEvent } from "react";
import { createLobby } from "../lib/api";
import { getClientId, getNickname, saveNickname } from "../lib/identity";
import { MAX_NICKNAME } from "../lib/types";

interface Props {
  navigate(to: string): void;
}

// Ana sayfanın durumu ve işlemleri.
function useHomeForm(navigate: Props["navigate"]) {
  const [nickname, setNickname] = useState(getNickname());
  const [hostOnly, setHostOnly] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const nick = nickname.trim();
    if (!nick) return setError("Önce bir takma ad yaz.");
    setBusy(true);
    setError(null);
    try {
      saveNickname(nick);
      const code = await createLobby(getClientId(), hostOnly);
      navigate(`/l/${code}?join=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function handleJoin(e: FormEvent) {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) return;
    if (nickname.trim()) saveNickname(nickname.trim());
    navigate(`/l/${code}`);
  }

  return { nickname, setNickname, hostOnly, setHostOnly, joinCode, setJoinCode, busy, error, handleCreate, handleJoin };
}

// Solda başlık, sağda iki yarısı olan bir bilet: üstte lobi oluşturma, altta kodla katılma.
export function HomePage({ navigate }: Props) {
  const { nickname, setNickname, hostOnly, setHostOnly, joinCode, setJoinCode, busy, error, handleCreate, handleJoin } = useHomeForm(navigate);
  return (
    <main className="cn-home">
      <section className="cn-hero">
        <h1>
          Aynı film,
          <br />
          aynı saniye.
        </h1>
        <p>Bir lobi aç, linki arkadaşlarına gönder. YouTube videosu ya da MP4 dosyası herkeste aynı anda oynar, yanında sohbet edersiniz.</p>
      </section>

      <div className="cn-ticket">
        <form className="cn-ticket-main" onSubmit={handleCreate}>
          <label className="field">
            <span>Takma ad</span>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={MAX_NICKNAME} placeholder="ör. Metehan" autoFocus />
          </label>
          <label className="check">
            <input type="checkbox" checked={hostOnly} onChange={(e) => setHostOnly(e.target.checked)} />
            <span>
              Sadece ben kontrol edeyim
              <small className="muted">Kapalıysa herkes oynatıp durdurabilir. Sonra da değiştirebilirsin.</small>
            </span>
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Oluşturuluyor..." : "Lobi oluştur"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>

        <form className="cn-ticket-stub" onSubmit={handleJoin}>
          <label className="field">
            <span>Davet kodun varsa</span>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="K7Q2MX"
              className="code-input"
              aria-label="Lobi kodu"
            />
          </label>
          <button disabled={!joinCode.trim()}>Lobiye katıl</button>
        </form>
      </div>
    </main>
  );
}
