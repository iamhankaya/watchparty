/**
 * Backend olmadan geliştirme için sahte sunucu (npm run dev:mock).
 * Aynı tarayıcıdaki sekmeler localStorage + BroadcastChannel ile ortak bir "sunucu" paylaşır.
 * Hub'daki kurallar taklit edilir: 20 kişi sınırı, sadece-host modu, host devri, altyazı kuralları.
 */
import type { LobbyConnection, LobbyEvents } from "./connection";
import type { ChatMessage, JoinResult, MediaType, Participant, PlaybackState } from "./types";
import { MAX_MEDIA_ID, MAX_PARTICIPANTS } from "./types";

interface MockLobby {
  code: string;
  createdAt: string;
  hostClientId: string;
  hostOnlyControl: boolean;
  playback: PlaybackState;
  chat: ChatMessage[];
}

interface Presence {
  nickname: string;
  clientId: string;
  joinedAt: number;
  seen: number;
}

type Message =
  | { type: "participants"; code: string }
  | { type: "playback"; code: string; state: PlaybackState }
  | { type: "control"; code: string; hostOnly: boolean }
  | { type: "host"; code: string; nickname: string }
  | { type: "chat"; code: string; message: ChatMessage };

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PRESENCE_TIMEOUT = 6000;
const lobbyKey = (code: string) => `wpmock:lobby:${code}`;
const presenceKey = (code: string) => `wpmock:presence:${code}`;

function load<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as T) : null;
}
const save = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
// MediaValidator.ValidateSubtitle: mutlak https URL, baş/son boşluk yok.
function isHttpsUrl(s: string): boolean {
  if (s !== s.trim()) return false;
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}
const delay = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function activePresence(code: string): Record<string, Presence> {
  const all = load<Record<string, Presence>>(presenceKey(code)) ?? {};
  const now = Date.now();
  return Object.fromEntries(Object.entries(all).filter(([, p]) => now - p.seen < PRESENCE_TIMEOUT));
}

function participants(code: string): Participant[] {
  const lobby = load<MockLobby>(lobbyKey(code));
  return Object.entries(activePresence(code))
    .sort(([, a], [, b]) => a.joinedAt - b.joinedAt)
    .map(([id, p]) => ({ id, nickname: p.nickname, isHost: p.clientId === lobby?.hostClientId }));
}

export const mockApi = {
  async createLobby(clientId: string, hostOnlyControl: boolean): Promise<string> {
    await delay();
    let code: string;
    do {
      code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
    } while (load(lobbyKey(code)));
    const lobby: MockLobby = {
      code,
      createdAt: new Date().toISOString(),
      hostClientId: clientId,
      hostOnlyControl,
      playback: { mediaType: null, mediaId: null, isPlaying: false, positionSec: 0, updatedAt: Date.now(), subtitleUrl: null, waitingFor: [] },
      chat: [],
    };
    save(lobbyKey(code), lobby);
    return code;
  },

  async getLobby(code: string) {
    await delay();
    const lobby = load<MockLobby>(lobbyKey(code.toUpperCase()));
    if (!lobby) return null;
    const count = Object.keys(activePresence(lobby.code)).length;
    return { code: lobby.code, createdAt: lobby.createdAt, participantCount: count, isFull: count >= MAX_PARTICIPANTS };
  },
};

export class MockLobbyConnection implements LobbyConnection {
  private channel = new BroadcastChannel("wpmock");
  private tabId = Math.random().toString(36).slice(2);
  private code: string | null = null;
  private clientId = "";
  private heartbeat: number | undefined;

  constructor(private events: LobbyEvents) {
    this.channel.onmessage = (e: MessageEvent<Message>) => this.receive(e.data);
    window.addEventListener("beforeunload", this.leave);
  }

  private receive(msg: Message) {
    if (msg.code !== this.code) return;
    switch (msg.type) {
      case "participants":
        return this.events.participantsChanged(participants(msg.code));
      case "playback":
        return this.events.playbackUpdated(msg.state);
      case "control":
        return this.events.controlModeChanged(msg.hostOnly);
      case "host":
        return this.events.hostChanged(msg.nickname);
      case "chat":
        return this.events.chatMessage(msg.message);
    }
  }

  /** Clients.Group(...).SendAsync karşılığı: diğer sekmelere ve kendimize gönder. */
  private broadcast(msg: Message) {
    this.channel.postMessage(msg);
    this.receive(msg);
  }

  private lobby(): MockLobby {
    const lobby = this.code ? load<MockLobby>(lobbyKey(this.code)) : null;
    if (!lobby) throw new Error("HubException: Önce bir lobiye katıl");
    return lobby;
  }

  private beat = () => {
    if (!this.code) return;
    const before = JSON.stringify(participants(this.code));
    const all = load<Record<string, Presence>>(presenceKey(this.code)) ?? {};
    if (all[this.tabId]) all[this.tabId].seen = Date.now();
    save(presenceKey(this.code), all);
    this.transferHostIfGone();
    if (JSON.stringify(participants(this.code)) !== before) this.broadcast({ type: "participants", code: this.code });
  };

  private transferHostIfGone() {
    const lobby = this.lobby();
    const active = Object.values(activePresence(lobby.code)).sort((a, b) => a.joinedAt - b.joinedAt);
    if (active.length === 0 || active.some((p) => p.clientId === lobby.hostClientId)) return;
    lobby.hostClientId = active[0].clientId;
    save(lobbyKey(lobby.code), lobby);
    this.broadcast({ type: "host", code: lobby.code, nickname: active[0].nickname });
    this.broadcast({ type: "participants", code: lobby.code });
  }

  private leave = () => {
    if (!this.code) return;
    const all = load<Record<string, Presence>>(presenceKey(this.code)) ?? {};
    delete all[this.tabId];
    save(presenceKey(this.code), all);
    this.channel.postMessage({ type: "participants", code: this.code } satisfies Message);
  };

  async start() {
    this.events.statusChanged("connecting");
    await delay();
    this.events.statusChanged("connected");
  }

  async stop() {
    this.leave();
    clearInterval(this.heartbeat);
    window.removeEventListener("beforeunload", this.leave);
    this.code = null;
    this.channel.close();
  }

  async join(code: string, nickname: string, clientId: string): Promise<JoinResult> {
    await delay();
    code = code.toUpperCase();
    const lobby = load<MockLobby>(lobbyKey(code));
    if (!lobby) throw new Error("HubException: Lobi bulunamadı");
    const active = activePresence(code);
    if (Object.keys(active).length >= MAX_PARTICIPANTS) throw new Error("HubException: Lobi dolu");

    active[this.tabId] = { nickname, clientId, joinedAt: Date.now(), seen: Date.now() };
    save(presenceKey(code), active);
    this.code = code;
    this.clientId = clientId;
    clearInterval(this.heartbeat);
    this.heartbeat = window.setInterval(this.beat, 2000);

    this.broadcast({ type: "participants", code });
    this.events.playbackUpdated(lobby.playback);
    this.events.controlModeChanged(lobby.hostOnlyControl);
    this.events.chatHistory(lobby.chat);
    const result = { selfId: this.tabId, isHost: clientId === lobby.hostClientId };
    this.events.joined(result);
    return result;
  }

  async sendChat(text: string) {
    await delay();
    const lobby = this.lobby();
    const me = activePresence(lobby.code)[this.tabId];
    text = text.trim();
    if (!me) throw new Error("HubException: Önce bir lobiye katıl");
    if (!text || text.length > 500) throw new Error("HubException: Mesaj 1-500 karakter olmalı");
    const message = { nickname: me.nickname, text, sentAt: Date.now() };
    lobby.chat = [...lobby.chat, message].slice(-50);
    save(lobbyKey(lobby.code), lobby);
    this.broadcast({ type: "chat", code: lobby.code, message });
  }

  private async update(change: (s: PlaybackState) => Partial<PlaybackState>) {
    await delay();
    const lobby = this.lobby();
    if (lobby.hostOnlyControl && lobby.hostClientId !== this.clientId)
      throw new Error("HubException: Sadece host kontrol edebilir");
    if (!lobby.playback.mediaId && !change(lobby.playback).mediaId) throw new Error("HubException: Önce bir medya seç");
    lobby.playback = { ...lobby.playback, ...change(lobby.playback), updatedAt: Date.now() };
    save(lobbyKey(lobby.code), lobby);
    this.broadcast({ type: "playback", code: lobby.code, state: lobby.playback });
  }

  setMedia = (type: MediaType, id: string) =>
    this.update(() => ({ mediaType: type, mediaId: id, isPlaying: false, positionSec: 0, subtitleUrl: null }));
  play = (pos: number) => this.update(() => ({ isPlaying: true, positionSec: pos }));
  pause = (pos: number) => this.update(() => ({ isPlaying: false, positionSec: pos }));
  seek = (pos: number) => this.update(() => ({ positionSec: pos }));

  /** Hub'daki SetSubtitle ile aynı kural sırası: doğrulama → lobi → sadece-host → medya var → medya MP4. */
  async setSubtitle(url: string | null) {
    await delay();
    if (!url) url = null;
    else if (!isHttpsUrl(url)) throw new Error("HubException: Altyazı adresi https:// ile başlamalı");
    else if (url.length > MAX_MEDIA_ID) throw new Error("HubException: Altyazı adresi en fazla 200 karakter olmalı");
    const lobby = this.lobby();
    if (lobby.hostOnlyControl && lobby.hostClientId !== this.clientId)
      throw new Error("HubException: Sadece host kontrol edebilir");
    if (!lobby.playback.mediaId) throw new Error("HubException: Önce bir medya seç");
    if (lobby.playback.mediaType !== "file") throw new Error("HubException: Altyazı yalnızca MP4 videolarda kullanılabilir");
    // Konum ve updatedAt değişmez: aksi halde oynarken herkes geri atlardı.
    lobby.playback = { ...lobby.playback, subtitleUrl: url };
    save(lobbyKey(lobby.code), lobby);
    this.broadcast({ type: "playback", code: lobby.code, state: lobby.playback });
  }

  async setControlMode(hostOnly: boolean) {
    await delay();
    const lobby = this.lobby();
    if (lobby.hostClientId !== this.clientId) throw new Error("HubException: Kontrol modunu sadece host değiştirebilir");
    lobby.hostOnlyControl = hostOnly;
    save(lobbyKey(lobby.code), lobby);
    this.broadcast({ type: "control", code: lobby.code, hostOnly });
  }

  async ping() {
    await delay(10);
    return Date.now();
  }
}
