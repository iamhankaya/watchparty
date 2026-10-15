/**
 * Backend olmadan geliştirme için sahte sunucu (npm run dev:mock).
 * Aynı tarayıcıdaki sekmeler localStorage + BroadcastChannel ile ortak bir "sunucu" paylaşır.
 * Hub'daki kurallar taklit edilir: 20 kişi sınırı, sadece-host modu, host devri, altyazı kuralları,
 * takılana göre bekleme (Lobby.StartWaiting/StopWaiting/ClearWaiting/ExpireWaits), sesli sohbet
 * (en fazla 6 üye, idempotent katılma, sinyaller BroadcastChannel ile yalnızca hedef sekmeye; aynı
 * tarayıcıdaki sekmeler arasında gerçek WebRTC bağlantısı kurulur).
 */
import type { LobbyConnection, LobbyEvents, VoiceJoinResult } from "./connection";
import type { ChatMessage, IceServer, JoinResult, MediaType, Participant, PlaybackState, VoiceMember, VoiceSignalKind } from "./types";
import { MAX_MEDIA_ID, MAX_PARTICIPANTS, MAX_VOICE } from "./types";

interface MockLobby {
  code: string;
  createdAt: string;
  hostClientId: string;
  hostOnlyControl: boolean;
  playback: PlaybackState;
  chat: ChatMessage[];
  // Bekleme kayıtları (Lobby.cs ile aynı); eski localStorage verisinde olmayabilir.
  /** Aktif beklemeler: bağlantı (sekme) kimliği -> başlangıç (ms). */
  waits?: Record<string, number>;
  /** Tekrar sayacı: clientId -> STRIKE_WINDOW içindeki bekleme başlangıçları (eskiden yeniye). */
  strikes?: Record<string, number[]>;
  /** Yok sayılma bildirildi: clientId -> pencerenin sonu (ms). */
  ignoredUntil?: Record<string, number>;
  /** Sesli sohbet üyeleri, katılma sırasıyla (eski localStorage verisinde olmayabilir). */
  voice?: { id: string; muted: boolean }[];
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
  | { type: "chat"; code: string; message: ChatMessage }
  | { type: "bufferingIgnored"; code: string; nickname: string }
  | { type: "typing"; code: string; id: string; nickname: string }
  // Liste mesajın içinde gelir: alıcının localStorage'ı yazan sekmeninkinin gerisinde kalabilir.
  | { type: "voice"; code: string; members: VoiceMember[] }
  | { type: "voiceSignal"; code: string; to: string; from: string; kind: VoiceSignalKind; payload: string };

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PRESENCE_TIMEOUT = 6000;
// Lobby.MaxWait, StrikeWindow, MaxStrikes ile aynı.
const MAX_WAIT = 10_000;
const STRIKE_WINDOW = 5 * 60_000;
const MAX_STRIKES = 3;
// LobbyHub.VoiceSignalKinds, MaxVoiceSignalLength ve appsettings.json'daki varsayılan ICE sunucusu ile aynı.
const VOICE_SIGNAL_KINDS: readonly string[] = ["offer", "answer", "candidate"];
const MAX_VOICE_SIGNAL = 16384;
const ICE_SERVERS: IceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];
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

/** Lobby.VoiceMembers: katılma sırasıyla, takma ad katılımcı kaydından; düşmüş (sekmesi kapanmış) kişiler sayılmaz. */
function voiceMembers(code: string): VoiceMember[] {
  const lobby = load<MockLobby>(lobbyKey(code));
  const active = activePresence(code);
  return (lobby?.voice ?? []).filter((v) => active[v.id]).map((v) => ({ id: v.id, nickname: active[v.id].nickname, muted: v.muted }));
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
  private waitTimer: number | undefined;
  /** Bildiğimiz son sesli üye listesi (VoiceSignal üyelik kontrolü için; localStorage'dan okumak gecikmeli olabilir). */
  private voiceIds = new Set<string>();

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
      case "bufferingIgnored":
        return this.events.bufferingIgnored(msg.nickname);
      case "typing":
        return this.events.userTyping(msg.id, msg.nickname);
      case "voice":
        this.voiceIds = new Set(msg.members.map((m) => m.id));
        return this.events.voiceMembersChanged(msg.members);
      case "voiceSignal":
        // Clients.Client(toId): yalnızca hedef sekme alır.
        if (msg.to === this.tabId) this.events.voiceSignal(msg.from, msg.kind, msg.payload);
        return;
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

  /**
   * Lobby.RemoveWaiters: verilen kişileri listeden çıkarır; liste boşalırsa devam
   * (konum aynı, updatedAt = şimdi). Kaydeder; liste değiştiyse yayınlar.
   */
  private removeWaiters(lobby: MockLobby, ids: string[]) {
    const waits = (lobby.waits ??= {});
    for (const id of ids) delete waits[id];
    const before = lobby.playback.waitingFor ?? [];
    const remaining = before.filter((id) => !ids.includes(id));
    const changed = remaining.length !== before.length;
    if (changed)
      lobby.playback =
        remaining.length === 0
          ? { ...lobby.playback, waitingFor: [], updatedAt: Date.now() }
          : { ...lobby.playback, waitingFor: remaining };
    save(lobbyKey(lobby.code), lobby);
    if (changed) this.broadcast({ type: "playback", code: lobby.code, state: lobby.playback });
  }

  /**
   * LobbyTickService/ExpireWaits karşılığı (katılmış her sekme saniyede bir çalıştırır): MAX_WAIT'i
   * dolduran beklemeler ve lobiden düşmüş (sekmesi kapanmış) kişiler listeden çıkar.
   */
  private expireWaits = () => {
    if (!this.code) return;
    const lobby = load<MockLobby>(lobbyKey(this.code));
    if (!lobby?.waits) return;
    const now = Date.now();
    const active = activePresence(lobby.code);
    const gone = Object.entries(lobby.waits)
      .filter(([id, start]) => now - start >= MAX_WAIT || !active[id])
      .map(([id]) => id);
    if (gone.length > 0) this.removeWaiters(lobby, gone);
  };

  private beat = () => {
    if (!this.code) return;
    const before = JSON.stringify(participants(this.code));
    const all = load<Record<string, Presence>>(presenceKey(this.code)) ?? {};
    if (all[this.tabId]) all[this.tabId].seen = Date.now();
    save(presenceKey(this.code), all);
    this.transferHostIfGone();
    if (JSON.stringify(participants(this.code)) !== before) this.broadcast({ type: "participants", code: this.code });
    this.pruneVoice();
  };

  /** OnDisconnectedAsync karşılığı: sekmesi kapanmış (varlığı düşmüş) sesli üyeler çıkarılır ve yayınlanır. */
  private pruneVoice() {
    const lobby = this.code ? load<MockLobby>(lobbyKey(this.code)) : null;
    if (!lobby?.voice?.length) return;
    const active = activePresence(lobby.code);
    const kept = lobby.voice.filter((v) => active[v.id]);
    if (kept.length === lobby.voice.length) return;
    lobby.voice = kept;
    save(lobbyKey(lobby.code), lobby);
    this.broadcast({ type: "voice", code: lobby.code, members: voiceMembers(lobby.code) });
  }

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
    // OnDisconnectedAsync: ayrılan kişi bekleme listesinden çıkar (katılımcı listesinden sonra).
    const lobby = load<MockLobby>(lobbyKey(this.code));
    // Sesli sohbetten de çıkar (katılımcı listesinden sonra, hub'daki sırayla).
    if (lobby?.voice?.some((v) => v.id === this.tabId)) {
      lobby.voice = lobby.voice.filter((v) => v.id !== this.tabId);
      save(lobbyKey(lobby.code), lobby);
      this.channel.postMessage({ type: "voice", code: lobby.code, members: voiceMembers(lobby.code) } satisfies Message);
    }
    if (lobby?.waits?.[this.tabId] !== undefined) this.removeWaiters(lobby, [this.tabId]);
  };

  async start() {
    this.events.statusChanged("connecting");
    await delay();
    this.events.statusChanged("connected");
  }

  async stop() {
    this.leave();
    clearInterval(this.heartbeat);
    clearInterval(this.waitTimer);
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
    clearInterval(this.waitTimer);
    this.waitTimer = window.setInterval(this.expireWaits, 1000);

    this.broadcast({ type: "participants", code });
    this.events.playbackUpdated(lobby.playback);
    this.events.controlModeChanged(lobby.hostOnlyControl);
    this.events.chatHistory(lobby.chat);
    const result = { selfId: this.tabId, isHost: clientId === lobby.hostClientId };
    this.events.joined(result);
    // Hub gibi: katılana o anki sesli üye listesini gönder (bir sonraki değişikliği beklemesin).
    const voice = voiceMembers(code);
    this.voiceIds = new Set(voice.map((m) => m.id));
    this.events.voiceMembersChanged(voice);
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

  /** Hub.Typing: durum tutmaz, hata fırlatmaz; Clients.OthersInGroup gibi yalnızca diğer sekmelere iletir. */
  async typing() {
    await delay();
    const me = this.code ? activePresence(this.code)[this.tabId] : undefined;
    if (!this.code || !me) return;
    this.channel.postMessage({ type: "typing", code: this.code, id: this.tabId, nickname: me.nickname } satisfies Message);
  }

  private async update(change: (s: PlaybackState) => Partial<PlaybackState>) {
    await delay();
    const lobby = this.lobby();
    if (lobby.hostOnlyControl && lobby.hostClientId !== this.clientId)
      throw new Error("HubException: Sadece host kontrol edebilir");
    if (!lobby.playback.mediaId && !change(lobby.playback).mediaId) throw new Error("HubException: Önce bir medya seç");
    // Yeni komut beklemeyi bitirir; konumu komut belirler.
    lobby.waits = {};
    lobby.playback = { ...lobby.playback, waitingFor: [], ...change(lobby.playback), updatedAt: Date.now() };
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

  /** Hub.ReportBuffering: hiç hata fırlatmaz, uygun değilse sessizce yok sayar. */
  async reportBuffering(buffering: boolean) {
    await delay();
    const lobby = this.code ? load<MockLobby>(lobbyKey(this.code)) : null;
    if (!lobby) return;
    if (!buffering) {
      // Lobby.StopWaiting
      if (lobby.waits?.[this.tabId] !== undefined) this.removeWaiters(lobby, [this.tabId]);
      return;
    }

    // Lobby.StartWaiting
    const me = activePresence(lobby.code)[this.tabId];
    const waits = (lobby.waits ??= {});
    if (!lobby.playback.mediaId || !lobby.playback.isPlaying || !me || waits[this.tabId] !== undefined) return;

    const now = Date.now();
    const strikes = ((lobby.strikes ??= {})[this.clientId] ?? []).filter((t) => now - t < STRIKE_WINDOW);
    lobby.strikes[this.clientId] = strikes;
    if (strikes.length >= MAX_STRIKES) {
      const ignoredUntil = (lobby.ignoredUntil ??= {});
      if ((ignoredUntil[this.clientId] ?? 0) > now) return save(lobbyKey(lobby.code), lobby);
      // En eski başlangıç pencereden çıkana kadar tekrar bildirilmez.
      ignoredUntil[this.clientId] = strikes[0] + STRIKE_WINDOW;
      save(lobbyKey(lobby.code), lobby);
      this.broadcast({ type: "bufferingIgnored", code: lobby.code, nickname: me.nickname });
      return;
    }

    let playback = lobby.playback;
    const waitingFor = playback.waitingFor ?? [];
    // Liste boşken başlıyorsa konum o ana dondurulur; sonraki kişiler yeniden hesaplamaz.
    if (waitingFor.length === 0)
      playback = { ...playback, positionSec: playback.positionSec + (now - playback.updatedAt) / 1000, updatedAt: now };
    waits[this.tabId] = now;
    strikes.push(now);
    lobby.playback = { ...playback, waitingFor: [...waitingFor, this.tabId] };
    save(lobbyKey(lobby.code), lobby);
    this.broadcast({ type: "playback", code: lobby.code, state: lobby.playback });
  }

  /** Hub.SkipWaiting: kontrol kuralı Update ile aynı; liste zaten boşsa yayın yok. */
  async skipWaiting() {
    await delay();
    const lobby = this.lobby();
    if (lobby.hostOnlyControl && lobby.hostClientId !== this.clientId)
      throw new Error("HubException: Sadece host kontrol edebilir");
    lobby.waits = {};
    this.removeWaiters(lobby, lobby.playback.waitingFor ?? []);
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

  /** Hub.JoinVoice: lobi yoksa hata; zaten üyeyse aynı sonuç (yine yayınlanır); 6 doluysa hata. */
  async joinVoice(): Promise<VoiceJoinResult> {
    await delay();
    const lobby = this.lobby();
    const active = activePresence(lobby.code);
    if (!active[this.tabId]) throw new Error("HubException: Önce bir lobiye katıl");
    const voice = (lobby.voice ?? []).filter((v) => active[v.id]);
    if (!voice.some((v) => v.id === this.tabId)) {
      if (voice.length >= MAX_VOICE) throw new Error("HubException: Sesli sohbet dolu");
      lobby.voice = [...voice, { id: this.tabId, muted: false }];
      save(lobbyKey(lobby.code), lobby);
    }
    // Hub gibi tekrar katılmada da yayın: listesi bayatlamış sekmeler düzelsin.
    this.broadcast({ type: "voice", code: lobby.code, members: voiceMembers(lobby.code) });
    return { members: voiceMembers(lobby.code), iceServers: ICE_SERVERS.map((s) => ({ urls: [...s.urls] })) };
  }

  /** Hub.LeaveVoice: üye değilse sessiz. */
  async leaveVoice() {
    await delay();
    const lobby = this.code ? load<MockLobby>(lobbyKey(this.code)) : null;
    if (!lobby?.voice?.some((v) => v.id === this.tabId)) return;
    lobby.voice = lobby.voice.filter((v) => v.id !== this.tabId);
    save(lobbyKey(lobby.code), lobby);
    this.broadcast({ type: "voice", code: lobby.code, members: voiceMembers(lobby.code) });
  }

  /** Hub.SetVoiceMuted: üye değilse ya da değer değişmediyse sessiz; değiştiyse yayınlar. */
  async setVoiceMuted(muted: boolean) {
    await delay();
    const lobby = this.code ? load<MockLobby>(lobbyKey(this.code)) : null;
    const me = lobby?.voice?.find((v) => v.id === this.tabId);
    if (!lobby || !me || me.muted === muted) return; // hub gibi: değişmediyse yayın yok
    me.muted = muted;
    save(lobbyKey(lobby.code), lobby);
    this.broadcast({ type: "voice", code: lobby.code, members: voiceMembers(lobby.code) });
  }

  /** Hub.VoiceSignal: önce doğrulama; sonra iki taraf da bu lobinin sesli üyesi değilse sessizce düşer. */
  async voiceSignal(toId: string, kind: VoiceSignalKind, payload: string) {
    await delay(5);
    if (!VOICE_SIGNAL_KINDS.includes(kind) || payload == null) throw new Error("HubException: Geçersiz ses sinyali");
    if (payload.length > MAX_VOICE_SIGNAL) throw new Error("HubException: Ses sinyali çok büyük");
    const lobby = this.code ? load<MockLobby>(lobbyKey(this.code)) : null;
    if (!lobby || !toId || toId === this.tabId) return;
    if (!this.voiceIds.has(this.tabId) || !this.voiceIds.has(toId)) return;
    this.channel.postMessage({ type: "voiceSignal", code: lobby.code, to: toId, from: this.tabId, kind, payload } satisfies Message);
  }
}
