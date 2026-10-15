import * as signalR from "@microsoft/signalr";
import type {
  ChatMessage,
  ConnectionStatus,
  IceServer,
  JoinResult,
  MediaType,
  Participant,
  PlaybackState,
  VoiceMember,
  VoiceSignalKind,
} from "./types";
import { USE_MOCK } from "./api";
import { MockLobbyConnection } from "./mock";
import { describeConnectionError, toUserError } from "./errors";

/** Sunucudan gelen olaylar. İsimler hub'daki SendAsync("...") isimleriyle aynı. */
export interface LobbyEvents {
  participantsChanged(participants: Participant[]): void;
  playbackUpdated(state: PlaybackState): void;
  controlModeChanged(hostOnly: boolean): void;
  hostChanged(nickname: string): void;
  chatHistory(messages: ChatMessage[]): void;
  chatMessage(message: ChatMessage): void;
  /** Sürekli takılan biri bu pencere boyunca beklenmeyecek (lobiye bir kez bildirilir). */
  bufferingIgnored(nickname: string): void;
  /** Lobideki başka biri sohbete yazıyor (kendimize gelmez); id katılımcı kimliği, ad sunucudan. */
  userTyping(id: string, nickname: string): void;
  /** Sesli sohbet üye listesi değişti (katılma sırasıyla; tüm lobiye gelir). */
  voiceMembersChanged(members: VoiceMember[]): void;
  /** Başka bir sesli sohbet üyesinden WebRTC sinyali (fromId = onun katılımcı kimliği). */
  voiceSignal(fromId: string, kind: VoiceSignalKind, payload: string): void;
  /** İlk katılımda ve kopup yeniden bağlanınca (yeni selfId ile) çağrılır. */
  joined(result: JoinResult): void;
  statusChanged(status: ConnectionStatus): void;
  /** Bağlantı kullanıcı istemeden koptu (ya da yeniden katılım reddedildi); reason kullanıcıya gösterilecek metindir. */
  connectionLost(reason: string): void;
}

/** Hub'daki sunucu metotları. Gerçek SignalR ve sahte (mock) bağlantı aynı arayüzü uygular. */
export interface LobbyConnection {
  start(): Promise<void>;
  stop(): Promise<void>;
  join(code: string, nickname: string, clientId: string): Promise<JoinResult>;
  setMedia(type: MediaType, id: string): Promise<void>;
  /** null altyazıyı kaldırır. */
  setSubtitle(url: string | null): Promise<void>;
  play(positionSec: number): Promise<void>;
  pause(positionSec: number): Promise<void>;
  seek(positionSec: number): Promise<void>;
  setControlMode(hostOnly: boolean): Promise<void>;
  sendChat(text: string): Promise<void>;
  /** Otomatik takılma bildirimi; sunucu uygun değilse sessizce yok sayar. */
  reportBuffering(buffering: boolean): Promise<void>;
  /** "Beklemeden devam et": bekleme listesini boşaltır (kontrol kuralı oynat/durdur ile aynı). */
  skipWaiting(): Promise<void>;
  /** "Yazıyor" bildirimi; sunucu durum tutmaz, diğerlerine userTyping olarak iletir. */
  typing(): Promise<void>;
  ping(): Promise<number>;
  /** Sesli sohbete katılır (idempotent); üye listesi ve ICE sunucuları döner. */
  joinVoice(): Promise<VoiceJoinResult>;
  /** Üye değilse sunucu sessizce yok sayar. */
  leaveVoice(): Promise<void>;
  setVoiceMuted(muted: boolean): Promise<void>;
  /** Sinyal yalnızca iki taraf da aynı lobinin sesli üyesiyse iletilir; değilse sessizce düşer. */
  voiceSignal(toId: string, kind: VoiceSignalKind, payload: string): Promise<void>;
}

export interface VoiceJoinResult {
  members: VoiceMember[];
  iceServers: IceServer[];
}

/** Sunucu ayarlanmamış kullanıcı adı/şifreyi null gönderir; RTCConfiguration'a "null" metni gitmesin diye atılır. */
export function normalizeIceServers(raw: unknown): IceServer[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: { urls?: unknown; username?: unknown; credential?: unknown }) => {
    const server: IceServer = { urls: Array.isArray(s?.urls) ? s.urls.filter((u): u is string => typeof u === "string") : [] };
    if (typeof s?.username === "string") server.username = s.username;
    if (typeof s?.credential === "string") server.credential = s.credential;
    return server;
  });
}

class SignalRLobbyConnection implements LobbyConnection {
  private conn: signalR.HubConnection;
  private joinArgs: [string, string, string] | null = null;

  constructor(private events: LobbyEvents) {
    this.conn = new signalR.HubConnectionBuilder()
      .withUrl("/hubs/lobby")
      .withAutomaticReconnect([0, 1000, 2000, 5000, 10000, 10000, 30000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    this.conn.on("ParticipantsChanged", (list: Participant[]) => events.participantsChanged(list));
    this.conn.on("PlaybackUpdated", (s: PlaybackState) => events.playbackUpdated(s));
    this.conn.on("ControlModeChanged", (hostOnly: boolean) => events.controlModeChanged(hostOnly));
    this.conn.on("HostChanged", (nickname: string) => events.hostChanged(nickname));
    this.conn.on("ChatHistory", (messages: ChatMessage[]) => events.chatHistory(messages));
    this.conn.on("ChatMessage", (message: ChatMessage) => events.chatMessage(message));
    this.conn.on("BufferingIgnored", (nickname: string) => events.bufferingIgnored(nickname));
    this.conn.on("UserTyping", (id: string, nickname: string) => events.userTyping(id, nickname));
    this.conn.on("VoiceMembersChanged", (members: VoiceMember[]) => events.voiceMembersChanged(members));
    this.conn.on("VoiceSignal", (fromId: string, kind: VoiceSignalKind, payload: string) =>
      events.voiceSignal(fromId, kind, payload),
    );

    this.conn.onreconnecting(() => events.statusChanged("reconnecting"));
    this.conn.onreconnected(async () => {
      // Yeni bağlantıda sunucu bizi tanımaz (Context.Items sıfırlanır), aynı clientId ile yeniden katılırız.
      // Sunucu host'a 10 sn tanıdığı için hostluk korunur.
      if (this.joinArgs) {
        try {
          events.joined(await this.conn.invoke<JoinResult>("JoinLobby", ...this.joinArgs));
        } catch (e) {
          // Lobi silinmiş ya da dolmuş olabilir; sebebi bildirip bağlantıyı kapatırız.
          events.statusChanged("disconnected");
          events.connectionLost(describeConnectionError(e));
          this.joinArgs = null;
          void this.conn.stop();
          return;
        }
      }
      events.statusChanged("connected");
    });
    this.conn.onclose((error) => {
      // Kullanıcı kendisi stop() ettiyse (joinArgs === null) sebep göstermeyiz.
      events.statusChanged("disconnected");
      if (this.joinArgs) events.connectionLost(describeConnectionError(error));
    });
  }

  async start() {
    this.events.statusChanged("connecting");
    await this.conn.start();
    this.events.statusChanged("connected");
  }

  stop() {
    this.joinArgs = null;
    return this.conn.stop();
  }

  async join(code: string, nickname: string, clientId: string) {
    const result = await this.conn.invoke<JoinResult>("JoinLobby", code, nickname, clientId);
    this.joinArgs = [code, nickname, clientId];
    this.events.joined(result);
    return result;
  }

  // Kopuk bağlantıda SignalR'ın İngilizce hata metni kullanıcıya sızmasın.
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    try {
      return await this.conn.invoke<T>(method, ...args);
    } catch (e) {
      throw toUserError(e);
    }
  }

  setMedia = (type: MediaType, id: string) => this.call<void>("SetMedia", type, id);
  setSubtitle = (url: string | null) => this.call<void>("SetSubtitle", url);
  play = (pos: number) => this.call<void>("Play", pos);
  pause = (pos: number) => this.call<void>("Pause", pos);
  seek = (pos: number) => this.call<void>("Seek", pos);
  setControlMode = (hostOnly: boolean) => this.call<void>("SetControlMode", hostOnly);
  sendChat = (text: string) => this.call<void>("SendChat", text);
  reportBuffering = (buffering: boolean) => this.call<void>("ReportBuffering", buffering);
  skipWaiting = () => this.call<void>("SkipWaiting");
  typing = () => this.call<void>("Typing");
  ping = () => this.call<number>("Ping");
  joinVoice = async (): Promise<VoiceJoinResult> => {
    const r = await this.call<{ members: VoiceMember[]; iceServers: unknown }>("JoinVoice");
    return { members: r.members, iceServers: normalizeIceServers(r.iceServers) };
  };
  leaveVoice = () => this.call<void>("LeaveVoice");
  setVoiceMuted = (muted: boolean) => this.call<void>("SetVoiceMuted", muted);
  voiceSignal = (toId: string, kind: VoiceSignalKind, payload: string) => this.call<void>("VoiceSignal", toId, kind, payload);
}

export function createLobbyConnection(events: LobbyEvents): LobbyConnection {
  return USE_MOCK ? new MockLobbyConnection(events) : new SignalRLobbyConnection(events);
}
