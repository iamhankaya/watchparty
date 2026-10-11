import { useState, type FormEvent } from "react";
import { createLobby } from "../lib/api";
import { getClientId, getNickname, saveNickname } from "../lib/identity";
import { MAX_NICKNAME } from "../lib/types";
import { useAppearance } from "../lib/appearance";
import { CinemaHome } from "./CinemaHome";

interface Props {
  navigate(to: string): void;
}

export type HomeForm = ReturnType<typeof useHomeForm>;

// Ana sayfanın durumu ve işlemleri; iki tasarım da aynı mantığı kullanır.
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

export function HomePage({ navigate }: Props) {
  const form = useHomeForm(navigate);
  const { design } = useAppearance();
  return design === "cinema" ? <CinemaHome form={form} /> : <ClassicHome form={form} />;
}

function ClassicHome({ form }: { form: HomeForm }) {
  const { nickname, setNickname, hostOnly, setHostOnly, joinCode, setJoinCode, busy, error, handleCreate, handleJoin } = form;
  return (
    <main className="home">
      <section className="hero">
        <h1>Birlikte izleyin, aynı anda.</h1>
        <p className="muted">Bir lobi aç, linki paylaş, YouTube videosunu ya da filmi herkes aynı saniyede izlesin.</p>
      </section>

      <div className="home-grid">
        <form className="card" onSubmit={handleCreate}>
          <h2>Lobi oluştur</h2>
          <label className="field">
            <span>Takma ad</span>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={MAX_NICKNAME} placeholder="ör. Metehan" autoFocus />
          </label>
          <label className="check">
            <input type="checkbox" checked={hostOnly} onChange={(e) => setHostOnly(e.target.checked)} />
            <span>
              Sadece ben kontrol edeyim
              <small className="muted">Kapalıysa herkes oynat, durdur ve ileri sar yapabilir. Sonra da değiştirebilirsin.</small>
            </span>
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Oluşturuluyor..." : "Lobi oluştur"}
          </button>
        </form>

        <form className="card" onSubmit={handleJoin}>
          <h2>Lobiye katıl</h2>
          <label className="field">
            <span>Lobi kodu</span>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="K7Q2MX"
              className="code-input"
            />
          </label>
          <button disabled={!joinCode.trim()}>Katıl</button>
        </form>
      </div>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
