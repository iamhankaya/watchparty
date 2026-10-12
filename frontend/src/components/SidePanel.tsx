import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  chat: ReactNode;
  people: ReactNode;
  peopleCount: number;
  messageCount: number;
}

type Tab = "chat" | "people";

// Sağ panel: sohbet ve kişiler aynı yüksekliği paylaşan iki sekme.
export function SidePanel({ chat, people, peopleCount, messageCount }: Props) {
  const [tab, setTab] = useState<Tab>("chat");
  const [unread, setUnread] = useState(false);
  const seen = useRef(messageCount);

  // Kişiler sekmesindeyken yeni mesaj gelirse sohbet sekmesinde işaret göster.
  useEffect(() => {
    if (tab === "chat") seen.current = messageCount;
    else if (messageCount > seen.current) setUnread(true);
  }, [messageCount, tab]);

  function open(next: Tab) {
    setTab(next);
    if (next === "chat") setUnread(false);
  }

  return (
    <aside className="cn-panel">
      <div className="cn-panel-inner">
        <div className="cn-tabs" role="tablist">
          <button role="tab" id="cn-tab-chat" aria-selected={tab === "chat"} aria-controls="cn-pane" onClick={() => open("chat")}>
            Sohbet
            {unread && <span className="cn-unread" aria-label="yeni mesaj var" />}
          </button>
          <button role="tab" id="cn-tab-people" aria-selected={tab === "people"} aria-controls="cn-pane" onClick={() => open("people")}>
            Kişiler <span className="cn-count">{peopleCount}</span>
          </button>
        </div>
        <div className="cn-pane" id="cn-pane" role="tabpanel" aria-labelledby={tab === "chat" ? "cn-tab-chat" : "cn-tab-people"}>
          {tab === "chat" ? chat : people}
        </div>
      </div>
    </aside>
  );
}
