import type { IceServer, VoiceMember, VoiceSignalKind } from "./types";

/** DOM/WebRTC bağımlılıkları dışarıdan verilir ki birim testlerde sahtesi kullanılabilsin. */
export interface VoiceDeps {
  createPeer(config: RTCConfiguration): RTCPeerConnection;
}

export type PeerState = "connecting" | "connected" | "failed";

export interface VoiceCallbacks {
  /** Sinyali hub üzerinden karşı tarafa iletir (payload JSON metni). */
  sendSignal(toId: string, kind: VoiceSignalKind, payload: string): void;
  onRemoteStream(id: string, stream: MediaStream): void;
  onPeerState(id: string, state: PeerState): void;
  onPeerClosed(id: string): void;
}

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  restarted: boolean; // restartIce bir kez denendi mi
}

/**
 * Sesli sohbetin istemci çekirdeği: her eş için bir RTCPeerConnection (mesh) ve
 * MDN'deki "perfect negotiation" kalıbı. selfId < peerId olan taraf polite'tir:
 * çakışan offer'da kendi teklifini geri alıp (örtük rollback) karşı tarafınkini kabul eder;
 * impolite taraf çakışan offer'ı yok sayar.
 *
 * Yerel mikrofon akışının sahibi çağıran taraftır: stop() bağlantıları kapatır ama
 * akışın izlerini durdurmaz (mikrofonu kapatmak çağıranın işi).
 */
export class VoiceSession {
  private readonly deps: VoiceDeps;
  private readonly cb: VoiceCallbacks;
  private readonly peers = new Map<string, Peer>();
  private members: VoiceMember[] = [];
  private localStream: MediaStream | null = null;
  private config: RTCConfiguration = {};
  private selfId = "";
  private muted = false;

  constructor(deps: VoiceDeps, callbacks: VoiceCallbacks) {
    this.deps = deps;
    this.cb = callbacks;
  }

  start(localStream: MediaStream, iceServers: IceServer[], selfId: string): void {
    this.stop();
    this.localStream = localStream;
    this.selfId = selfId;
    this.config = {
      iceServers: iceServers.map((s) => {
        const server: RTCIceServer = { urls: s.urls };
        if (s.username !== undefined) server.username = s.username;
        if (s.credential !== undefined) server.credential = s.credential;
        return server;
      }),
    };
    this.applyMuted();
    this.sync();
  }

  /** Sunucunun bildirdiği üye listesi: yeni eşlere bağlantı açılır, çıkanlarınki kapanır. */
  setMembers(members: VoiceMember[]): void {
    this.members = members;
    this.sync();
  }

  async handleSignal(fromId: string, kind: VoiceSignalKind, payload: string): Promise<void> {
    if (!this.localStream || fromId === this.selfId) return;
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return; // bozuk sinyal: yok say
    }
    if (typeof data !== "object" || data === null) return;

    // Üye listesi sinyalin gerisinde kalmış olabilir: bilinmeyen eş için bağlantı aç.
    // Gerçekten üye değilse bir sonraki setMembers kapatır.
    const peer = this.peers.get(fromId) ?? this.openPeer(fromId);
    const pc = peer.pc;

    try {
      if (kind === "offer" || kind === "answer") {
        const sdp = (data as { sdp?: unknown }).sdp;
        if (typeof sdp !== "string") return;
        const readyForOffer =
          !peer.makingOffer && (pc.signalingState === "stable" || peer.settingRemoteAnswer);
        const offerCollision = kind === "offer" && !readyForOffer;
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        peer.settingRemoteAnswer = kind === "answer";
        try {
          // Polite tarafta have-local-offer iken bu çağrı örtük rollback yapar.
          await pc.setRemoteDescription({ type: kind, sdp });
        } finally {
          peer.settingRemoteAnswer = false;
        }
        if (kind === "offer") {
          await pc.setLocalDescription();
          if (this.peers.get(fromId) !== peer) return; // bu arada kapandı
          this.cb.sendSignal(fromId, "answer", JSON.stringify(pc.localDescription));
        }
      } else if (kind === "candidate") {
        try {
          await pc.addIceCandidate(data as RTCIceCandidateInit);
        } catch (err) {
          // Yok sayılan offer'ın adayları hata verir; bu beklenen durumdur.
          if (!peer.ignoreOffer) console.warn("ICE adayı eklenemedi", err);
        }
      }
    } catch (err) {
      console.warn("Ses sinyali işlenemedi", err);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMuted();
  }

  /** Tüm bağlantıları kapatır (her eş için onPeerClosed). Yerel akışın izlerini durdurmaz. */
  stop(): void {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.localStream = null;
  }

  private applyMuted(): void {
    for (const t of this.localStream?.getAudioTracks() ?? []) t.enabled = !this.muted;
  }

  private sync(): void {
    if (!this.localStream) return;
    const wanted = new Set(this.members.map((m) => m.id).filter((id) => id !== this.selfId));
    for (const id of [...this.peers.keys()]) if (!wanted.has(id)) this.closePeer(id);
    for (const id of wanted) if (!this.peers.has(id)) this.openPeer(id);
  }

  private openPeer(id: string): Peer {
    const stream = this.localStream!;
    const pc = this.deps.createPeer(this.config);
    const peer: Peer = {
      id,
      pc,
      polite: this.selfId < id,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      restarted: false,
    };
    this.peers.set(id, peer);
    const alive = () => this.peers.get(id) === peer;

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (!alive()) return;
        this.cb.sendSignal(id, "offer", JSON.stringify(pc.localDescription));
      } catch (err) {
        console.warn("Ses teklifi oluşturulamadı", err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && alive()) this.cb.sendSignal(id, "candidate", JSON.stringify(ev.candidate));
    };
    pc.ontrack = (ev) => {
      if (!alive()) return;
      const remote = ev.streams[0] ?? new MediaStream([ev.track]);
      this.cb.onRemoteStream(id, remote);
    };
    pc.onconnectionstatechange = () => {
      if (!alive()) return;
      switch (pc.connectionState) {
        case "connecting":
          this.cb.onPeerState(id, "connecting");
          break;
        case "connected":
          this.cb.onPeerState(id, "connected");
          break;
        case "failed":
          if (!peer.restarted) {
            peer.restarted = true;
            pc.restartIce(); // negotiationneeded tetikler, yeni offer gider
          } else {
            this.cb.onPeerState(id, "failed");
          }
          break;
      }
    };

    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    this.cb.onPeerState(id, "connecting");
    return peer;
  }

  private closePeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    const pc = peer.pc;
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
    this.cb.onPeerClosed(id);
  }
}
