import { useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_CHAT, type ChatMessage } from "../lib/types";

interface Props {
  messages: ChatMessage[];
  myNickname: string;
  onSend(text: string): Promise<unknown> | void;
}

const timeFormat = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" });

export function Chat({ messages, myNickname, onSend }: Props) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLUListElement>(null);

  // Yeni mesaj gelince en alta kaydır.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

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
      <h3>Sohbet</h3>
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
      <form className="chat-form" onSubmit={handleSubmit}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_CHAT} placeholder="Mesaj yaz..." />
        <button disabled={!text.trim()}>Gönder</button>
      </form>
    </div>
  );
}
