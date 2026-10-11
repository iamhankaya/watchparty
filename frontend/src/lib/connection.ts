import * as signalR from "@microsoft/signalr";
import type { ChatMessage, ConnectionStatus, JoinResult, MediaType, Participant, PlaybackState } from "./types";
import { USE_MOCK } from "./api";
import { MockLobbyConnection } from "./mock";
import { describeConnectionError } from "./errors";

/** Sunucudan gelen olaylar. İsimler hub'daki SendAsync("...") isimleriyle aynı. */
export interface LobbyEvents {
  participantsChanged(participants: Participant[]): void;
  playbackUpdated(state: PlaybackState): void;
  controlModeChanged(hostOnly: boolean): void;
  hostChanged(nickname: string): void;
  chatHistory(messages: ChatMessage[]): void;
  chatMessage(message: ChatMessage): void;
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
  play(positionSec: number): Promise<void>;
  pause(positionSec: number): Promise<void>;
  seek(positionSec: number): Promise<void>;
  setControlMode(hostOnly: boolean): Promise<void>;
  sendChat(text: string): Promise<void>;
  ping(): Promise<number>;
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

  setMedia = (type: MediaType, id: string) => this.conn.invoke<void>("SetMedia", type, id);
  play = (pos: number) => this.conn.invoke<void>("Play", pos);
  pause = (pos: number) => this.conn.invoke<void>("Pause", pos);
  seek = (pos: number) => this.conn.invoke<void>("Seek", pos);
  setControlMode = (hostOnly: boolean) => this.conn.invoke<void>("SetControlMode", hostOnly);
  sendChat = (text: string) => this.conn.invoke<void>("SendChat", text);
  ping = () => this.conn.invoke<number>("Ping");
}

export function createLobbyConnection(events: LobbyEvents): LobbyConnection {
  return USE_MOCK ? new MockLobbyConnection(events) : new SignalRLobbyConnection(events);
}
