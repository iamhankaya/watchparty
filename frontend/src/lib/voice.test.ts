import { beforeEach, describe, expect, test, vi } from "vitest";
import type { IceServer, VoiceMember } from "./types";
import { VoiceSession, type VoiceCallbacks } from "./voice";

/** Elle yönetilen sahte RTCPeerConnection: olayları testler tetikler, çağrılar kaydedilir. */
class FakePeer {
  signalingState: RTCSignalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  ontrack: ((ev: { track: unknown; streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly config: RTCConfiguration;

  constructor(config: RTCConfiguration) {
    this.config = config;
  }

  addTrack = vi.fn();
  restartIce = vi.fn();
  close = vi.fn(() => {
    this.closed = true;
  });
  addIceCandidate = vi.fn(async (_c: RTCIceCandidateInit) => {});
  setLocalDescription = vi.fn(async (d?: RTCSessionDescriptionInit) => {
    const type = d?.type ?? (this.signalingState === "have-remote-offer" ? "answer" : "offer");
    this.localDescription = { type, sdp: `yerel-${type}` };
    this.signalingState = type === "offer" ? "have-local-offer" : "stable";
  });
  setRemoteDescription = vi.fn(async (d: RTCSessionDescriptionInit) => {
    // Gerçek tarayıcıdaki gibi: have-local-offer iken gelen offer örtük rollback yapar.
    this.remoteDescription = d;
    this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
  });

  setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

function fakeTrack() {
  return { kind: "audio", enabled: true, stop: vi.fn() };
}

function fakeStream(tracks = [fakeTrack()]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream;
}

function member(id: string, muted = false): VoiceMember {
  return { id, nickname: `kişi-${id}`, muted };
}

const ICE: IceServer[] = [{ urls: ["stun:stun.example:19302"] }];
const flush = () => new Promise((r) => setTimeout(r, 0));

let peers: FakePeer[];
let cb: { [K in keyof VoiceCallbacks]: ReturnType<typeof vi.fn> };
let session: VoiceSession;
let track: ReturnType<typeof fakeTrack>;
let stream: MediaStream;

function setup(selfId: string) {
  peers = [];
  cb = {
    sendSignal: vi.fn(),
    onRemoteStream: vi.fn(),
    onPeerState: vi.fn(),
    onPeerClosed: vi.fn(),
  };
  session = new VoiceSession(
    {
      createPeer: (config) => {
        const p = new FakePeer(config);
        peers.push(p);
        return p as unknown as RTCPeerConnection;
      },
    },
    cb as unknown as VoiceCallbacks,
  );
  track = fakeTrack();
  stream = fakeStream([track]);
  session.start(stream, ICE, selfId);
}

function sentOf(kind: string) {
  return cb.sendSignal.mock.calls.filter((c) => c[1] === kind);
}

describe("VoiceSession üyelik", () => {
  beforeEach(() => setup("b"));

  test("yeni üye için bağlantı açılır, yerel izler eklenir; kendisi için açılmaz", () => {
    session.setMembers([member("b"), member("c")]);
    expect(peers).toHaveLength(1);
    expect(peers[0].config.iceServers).toEqual([{ urls: ["stun:stun.example:19302"] }]);
    expect(peers[0].addTrack).toHaveBeenCalledWith(track, stream);
    expect(cb.onPeerState).toHaveBeenCalledWith("c", "connecting");
  });

  test("aynı liste tekrar gelince yeni bağlantı açılmaz", () => {
    session.setMembers([member("b"), member("c")]);
    session.setMembers([member("b"), member("c", true)]);
    expect(peers).toHaveLength(1);
  });

  test("listeden çıkan üyenin bağlantısı kapanır ve onPeerClosed çağrılır", () => {
    session.setMembers([member("b"), member("c"), member("d")]);
    session.setMembers([member("b"), member("d")]);
    expect(peers[0].close).toHaveBeenCalled();
    expect(peers[1].close).not.toHaveBeenCalled();
    expect(cb.onPeerClosed).toHaveBeenCalledWith("c");
    expect(cb.onPeerClosed).toHaveBeenCalledTimes(1);
  });

  test("start'tan önce gelen üye listesi start'ta uygulanır", () => {
    peers = [];
    const s = new VoiceSession(
      {
        createPeer: (config) => {
          const p = new FakePeer(config);
          peers.push(p);
          return p as unknown as RTCPeerConnection;
        },
      },
      cb as unknown as VoiceCallbacks,
    );
    s.setMembers([member("b"), member("c")]);
    expect(peers).toHaveLength(0);
    s.start(stream, ICE, "b");
    expect(peers).toHaveLength(1);
  });

  test("uzak iz gelince onRemoteStream çağrılır", () => {
    session.setMembers([member("c")]);
    const remote = fakeStream();
    peers[0].ontrack?.({ track: fakeTrack(), streams: [remote] });
    expect(cb.onRemoteStream).toHaveBeenCalledWith("c", remote);
  });
});

describe("VoiceSession sinyal", () => {
  test("onnegotiationneeded → offer gönderilir", async () => {
    setup("b");
    session.setMembers([member("c")]);
    peers[0].onnegotiationneeded?.();
    await flush();
    const offers = sentOf("offer");
    expect(offers).toHaveLength(1);
    expect(offers[0][0]).toBe("c");
    expect(JSON.parse(offers[0][2])).toEqual({ type: "offer", sdp: "yerel-offer" });
  });

  test("ICE adayları iletilir; null aday (bitti) gönderilmez", () => {
    setup("b");
    session.setMembers([member("c")]);
    const candidate = { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    peers[0].onicecandidate?.({ candidate });
    peers[0].onicecandidate?.({ candidate: null });
    const sent = sentOf("candidate");
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe("c");
    expect(JSON.parse(sent[0][2])).toEqual(candidate);
  });

  test("gelen aday addIceCandidate'e verilir", async () => {
    setup("b");
    session.setMembers([member("c")]);
    const candidate = { candidate: "x", sdpMid: "0", sdpMLineIndex: 0 };
    await session.handleSignal("c", "candidate", JSON.stringify(candidate));
    expect(peers[0].addIceCandidate).toHaveBeenCalledWith(candidate);
  });

  test("çakışma yokken gelen offer kabul edilip answer gönderilir", async () => {
    setup("b");
    session.setMembers([member("c")]);
    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "uzak" }));
    expect(peers[0].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "uzak" });
    const answers = sentOf("answer");
    expect(answers).toHaveLength(1);
    expect(answers[0][0]).toBe("c");
    expect(JSON.parse(answers[0][2])).toEqual({ type: "answer", sdp: "yerel-answer" });
  });

  test("gelen answer uzak tanım olarak uygulanır", async () => {
    setup("b");
    session.setMembers([member("c")]);
    peers[0].onnegotiationneeded?.();
    await flush();
    await session.handleSignal("c", "answer", JSON.stringify({ type: "answer", sdp: "uzak" }));
    expect(peers[0].setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "uzak" });
    expect(peers[0].signalingState).toBe("stable");
  });

  test("bilinmeyen kişiden gelen offer için bağlantı açılır (üye listesi geride kalmış olabilir)", async () => {
    setup("b");
    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "uzak" }));
    expect(peers).toHaveLength(1);
    expect(sentOf("answer")).toHaveLength(1);
  });

  test("kendinden ya da bozuk payload ile gelen sinyal yok sayılır", async () => {
    setup("b");
    session.setMembers([member("c")]);
    await session.handleSignal("b", "offer", JSON.stringify({ type: "offer", sdp: "x" }));
    await session.handleSignal("c", "offer", "{bozuk");
    expect(peers).toHaveLength(1);
    expect(peers[0].setRemoteDescription).not.toHaveBeenCalled();
    expect(cb.sendSignal).not.toHaveBeenCalled();
  });
});

describe("VoiceSession perfect negotiation", () => {
  test("selfId < peerId olan taraf polite: çakışan offer'ı rollback ile kabul eder", async () => {
    setup("a"); // "a" < "c" → polite
    session.setMembers([member("c")]);
    peers[0].onnegotiationneeded?.();
    await flush();
    expect(peers[0].signalingState).toBe("have-local-offer");
    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "uzak" }));
    expect(peers[0].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "uzak" });
    expect(sentOf("answer")).toHaveLength(1);
  });

  test("impolite taraf çakışan offer'ı yok sayar, aday hatalarını da yutar", async () => {
    setup("d"); // "d" > "c" → impolite
    session.setMembers([member("c")]);
    peers[0].onnegotiationneeded?.();
    await flush();
    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "uzak" }));
    expect(peers[0].setRemoteDescription).not.toHaveBeenCalled();
    expect(sentOf("answer")).toHaveLength(0);
    expect(peers[0].signalingState).toBe("have-local-offer");

    peers[0].addIceCandidate.mockRejectedValueOnce(new Error("uzak tanım yok"));
    await expect(
      session.handleSignal("c", "candidate", JSON.stringify({ candidate: "x", sdpMid: "0" })),
    ).resolves.toBeUndefined();
  });

  test("offer hazırlanırken (makingOffer) gelen offer da çakışma sayılır", async () => {
    setup("d"); // impolite
    session.setMembers([member("c")]);
    let release!: () => void;
    peers[0].setLocalDescription.mockImplementationOnce(
      () => new Promise<void>((r) => (release = r)),
    );
    peers[0].onnegotiationneeded?.();
    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "uzak" }));
    expect(peers[0].setRemoteDescription).not.toHaveBeenCalled();
    release();
    await flush();
  });
});

describe("VoiceSession bağlantı durumu", () => {
  beforeEach(() => setup("b"));

  test("connected bildirilir", () => {
    session.setMembers([member("c")]);
    peers[0].setState("connected");
    expect(cb.onPeerState).toHaveBeenCalledWith("c", "connected");
  });

  test("failed → bir kez restartIce, ikinci failed → onPeerState(failed)", () => {
    session.setMembers([member("c")]);
    peers[0].setState("failed");
    expect(peers[0].restartIce).toHaveBeenCalledTimes(1);
    expect(cb.onPeerState).not.toHaveBeenCalledWith("c", "failed");
    peers[0].setState("connecting");
    peers[0].setState("failed");
    expect(peers[0].restartIce).toHaveBeenCalledTimes(1);
    expect(cb.onPeerState).toHaveBeenCalledWith("c", "failed");
  });
});

describe("VoiceSession sessize alma ve durdurma", () => {
  beforeEach(() => setup("b"));

  test("setMuted yerel ses izlerini kapatıp açar", () => {
    session.setMuted(true);
    expect(track.enabled).toBe(false);
    session.setMuted(false);
    expect(track.enabled).toBe(true);
  });

  test("stop tüm bağlantıları kapatır, yerel izleri durdurmaz", async () => {
    session.setMembers([member("c"), member("d")]);
    session.stop();
    expect(peers.every((p) => p.closed)).toBe(true);
    expect(cb.onPeerClosed).toHaveBeenCalledWith("c");
    expect(cb.onPeerClosed).toHaveBeenCalledWith("d");
    expect(track.stop).not.toHaveBeenCalled();
    // Kapandıktan sonra gelen olay ve sinyaller etkisiz.
    peers[0].onicecandidate?.({ candidate: { candidate: "x" } });
    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "x" }));
    expect(cb.sendSignal).not.toHaveBeenCalled();
    expect(peers).toHaveLength(2);
  });
});
