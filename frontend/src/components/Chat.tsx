import { useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_CHAT, type ChatMessage } from "../lib/types";
import { TypingThrottle } from "../lib/typing";
import { Icon } from "./Icon";

interface Props {
  messages: ChatMessage[];
  myNickname: string;
  onSend(text: string): Promise<unknown> | void;
  /** "Yazıyor" bildirimi (en fazla 3 sn'de bir çağrılır); hatası yutulur. */
  onTyping(): Promise<unknown> | void;
  /** Diğerlerinin "yazıyor…" ifadesi; kimse yazmıyorsa null. */
  typingLabel: string | null;
  soundOn: boolean;
  onToggleSound(): void;
}

const timeFormat = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" });

export function Chat({ messages, myNickname, onSend, onTyping, typingLabel, soundOn, onToggleSound }: Props) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const throttleRef = useRef(new TypingThrottle());

  // Yeni mesaj gelince en alta kaydır.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleChange(value: string) {
    setText(value);
    // Boş kutuda bildirim gitmez; hata (ör. hız limiti, kopuk bağlantı) kullanıcıya gösterilmez.
    if (!value.trim() || !throttleRef.current.shouldSend(Date.now())) return;
    try {
      void Promise.resolve(onTyping()).catch(() => {});
    } catch {
      // yut
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    // Gönderim başarısız olursa (ör. hız limiti) metni geri koy; kutuda yeni yazı varsa dokunma.
    void Promise.resolve(onSend(value)).catch(() => setText((current) => (current === "" ? value : current)));
  }

  return (
    <div className="card chat">
      <div className="chat-head">
        <h3>Sohbet</h3>
        <button
          type="button"
          className={`chat-bell${soundOn ? " active" : ""}`}
          aria-pressed={soundOn}
          title="Bildirim sesi"
          onClick={onToggleSound}
        >
          <Icon name={soundOn ? "bell" : "bellOff"} />
        </button>
      </div>
      <ul className="chat-list" ref={listRef}>
        {messages.length === 0 && <li className="muted small">Henüz mesaj yok.</li>}
        {messages.map((m, i) => (
          <li key={`${m.sentAt}-${i}`} className={m.nickname === myNickname ? "mine" : undefined}>
            <span className="chat-meta">
              <strong>{m.nickname}</strong> <span className="muted">{timeFormat.format(m.sentAt)}</span>
            </span>
            <span className="chat-text">{m.text}</span>
          </li>
        ))}
      </ul>
      {/* Sabit yükseklikte: ifade gelip gidince liste ve kutu zıplamaz. */}
      <p className="chat-typing" aria-live="polite">
        {typingLabel}
      </p>
      <form className="chat-form" onSubmit={handleSubmit}>
        <input value={text} onChange={(e) => handleChange(e.target.value)} maxLength={MAX_CHAT} placeholder="Mesaj yaz..." />
        <button disabled={!text.trim()}>Gönder</button>
      </form>
    </div>
  );
}
