import { mockApi } from "./mock";

export const USE_MOCK = import.meta.env.VITE_MOCK === "true";

export interface LobbyInfo {
  code: string;
  createdAt: string;
  participantCount: number;
  isFull: boolean;
}

async function createLobbyHttp(clientId: string, hostOnlyControl: boolean): Promise<string> {
  const res = await fetch("/api/lobbies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, hostOnlyControl }),
  });
  if (!res.ok) throw new Error(`Lobi oluşturulamadı (HTTP ${res.status})`);
  const body = (await res.json()) as { code: string };
  return body.code;
}

async function getLobbyHttp(code: string): Promise<LobbyInfo | null> {
  const res = await fetch(`/api/lobbies/${encodeURIComponent(code)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sunucuya ulaşılamadı (HTTP ${res.status})`);
  return (await res.json()) as LobbyInfo;
}

export const createLobby = USE_MOCK ? mockApi.createLobby : createLobbyHttp;
export const getLobby = USE_MOCK ? mockApi.getLobby : getLobbyHttp;
