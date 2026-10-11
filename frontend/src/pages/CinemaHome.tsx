import { MAX_NICKNAME } from "../lib/types";
import type { HomeForm } from "./HomePage";

// Sinema tasarımının ana sayfası: solda başlık, sağda iki yarısı olan bir bilet.
export function CinemaHome({ form }: { form: HomeForm }) {
  const { nickname, setNickname, hostOnly, setHostOnly, joinCode, setJoinCode, busy, error, handleCreate, handleJoin } = form;
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
