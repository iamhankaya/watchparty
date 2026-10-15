import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { IceServer, VoiceMember } from "./types";
import { VOICE_WATCHDOG_MS, VOICE_WATCHDOG_POLITE_EXTRA_MS, VoiceSession, type VoiceCallbacks } from "./voice";

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

  /** Tarayıcı gibi: stable iken iz eklenince negotiationneeded (sonraki mikro görevde) tetiklenir. */
  addTrack = vi.fn(() => {
    if (this.signalingState === "stable") queueMicrotask(() => this.onnegotiationneeded?.());
  });
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
    // Gerçek tarayıcıdaki gibi: have-local-offer iken gelen offer örtük rollback yapar;
    // beklenen offer yokken gelen answer hata verir.
    if (d.type === "answer" && this.signalingState !== "have-local-offer") {
      throw new Error(`answer için yanlış durum: ${this.signalingState}`);
    }
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

  test("yeni üye için bağlantı açılır, impolite taraf yerel izleri ekler; kendisi için açılmaz", () => {
    session.setMembers([member("b"), member("a")]); // "b" > "a" → impolite
    expect(peers).toHaveLength(1);
    expect(peers[0].config.iceServers).toEqual([{ urls: ["stun:stun.example:19302"] }]);
    expect(peers[0].addTrack).toHaveBeenCalledWith(track, stream);
    expect(cb.onPeerState).toHaveBeenCalledWith("a", "connecting");
  });

  test("polite taraf ilk offer gelene kadar iz eklemez ve teklif yapmaz", async () => {
    session.setMembers([member("b"), member("c")]); // "b" < "c" → polite
    await flush();
    expect(peers).toHaveLength(1);
    expect(peers[0].addTrack).not.toHaveBeenCalled();
    expect(sentOf("offer")).toHaveLength(0);

    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "uzak" }));
    await flush();
    // İzler uzak offer uygulandıktan sonra, answer'dan önce eklenir (offer'ın transceiver'ına bağlanır).
    expect(peers[0].addTrack).toHaveBeenCalledWith(track, stream);
    const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0];
    expect(order(peers[0].addTrack)).toBeGreaterThan(order(peers[0].setRemoteDescription));
    expect(order(peers[0].addTrack)).toBeLessThan(order(peers[0].setLocalDescription));
    expect(sentOf("answer")).toHaveLength(1);
    expect(sentOf("offer")).toHaveLength(0);
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

  test("start'tan önce gelen offer tamponlanır, start'ta işlenip answer gönderilir", async () => {
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
    cb.sendSignal.mockClear();
    await s.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "uzak" }));
    expect(peers).toHaveLength(0);
    s.setMembers([member("b"), member("c")]);
    s.start(fakeStream(), ICE, "b");
    await flush();
    expect(peers).toHaveLength(1);
    expect(peers[0].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "uzak" });
    expect(sentOf("answer")).toHaveLength(1);
  });

  test("bilinmeyen kişiden offer, ardından onu içeren üye listesi → tek bağlantı, kapanmaz", async () => {
    setup("b");
    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "uzak" }));
    session.setMembers([member("b"), member("c")]);
    expect(peers).toHaveLength(1);
    expect(peers[0].close).not.toHaveBeenCalled();
    expect(cb.onPeerClosed).not.toHaveBeenCalled();
  });

  test("bilinmeyen kişiden answer/aday yok sayılır, bağlantı açılmaz", async () => {
    setup("b");
    await session.handleSignal("c", "answer", JSON.stringify({ type: "answer", sdp: "x" }));
    await session.handleSignal("c", "candidate", JSON.stringify({ candidate: "x" }));
    expect(peers).toHaveLength(0);
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

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      peers[0].addIceCandidate.mockRejectedValueOnce(new Error("uzak tanım yok"));
      await session.handleSignal("c", "candidate", JSON.stringify({ candidate: "x", sdpMid: "0" }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("offer yok sayılmamışken aday hatası uyarı olarak loglanır", async () => {
    setup("b");
    session.setMembers([member("c")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      peers[0].addIceCandidate.mockRejectedValueOnce(new Error("bozuk aday"));
      await session.handleSignal("c", "candidate", JSON.stringify({ candidate: "x", sdpMid: "0" }));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("iki oturum aynı anda teklif yapınca (glare) kilitlenmeden stable'a ulaşır", async () => {
    const make = (selfId: string, list: FakePeer[], other: () => VoiceSession) =>
      new VoiceSession(
        {
          createPeer: (config) => {
            const p = new FakePeer(config);
            list.push(p);
            return p as unknown as RTCPeerConnection;
          },
        },
        {
          sendSignal: (_to, kind, payload) => {
            sent.push(`${selfId}:${kind}`);
            setTimeout(() => void other().handleSignal(selfId, kind, payload), 0);
          },
          onRemoteStream: () => {},
          onPeerState: () => {},
          onPeerClosed: () => {},
        },
      );
    const sent: string[] = [];
    const peersA: FakePeer[] = [];
    const peersB: FakePeer[] = [];
    const a: VoiceSession = make("a", peersA, () => b);
    const b: VoiceSession = make("b", peersB, () => a);
    a.start(fakeStream(), ICE, "a");
    b.start(fakeStream(), ICE, "b");
    a.setMembers([member("a"), member("b")]);
    b.setMembers([member("a"), member("b")]);
    // İki taraf da aynı anda müzakere ister.
    peersA[0].onnegotiationneeded?.();
    peersB[0].onnegotiationneeded?.();
    for (let i = 0; i < 10; i++) await flush();

    expect(peersA[0].signalingState).toBe("stable");
    expect(peersB[0].signalingState).toBe("stable");
    // Polite "a" rollback yapıp "b"nin teklifini yanıtlar; impolite "b" "a"nın teklifini yok sayar.
    expect(sent).toContain("a:answer");
    expect(sent).not.toContain("b:answer");
    expect(peersB[0].setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: "answer" }),
    );
  });

  test("teklif hazırlanırken rollback olduysa eski localDescription offer diye gönderilmez", async () => {
    setup("a"); // polite
    session.setMembers([member("c")]);
    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "ilk" }));
    await flush();
    cb.sendSignal.mockClear();
    // Sonraki bir müzakere (ör. restartIce): sLD sürerken karşıdan offer gelir ve rollback olur.
    let release!: () => void;
    peers[0].setLocalDescription.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = () => {
            // Tarayıcıda sLD tamamlanır ama ardından kuyruktaki sRD(offer) rollback yapıp yanıtlar.
            peers[0].signalingState = "stable";
            peers[0].localDescription = { type: "answer", sdp: "yerel-answer" };
            r();
          };
        }),
    );
    peers[0].onnegotiationneeded?.();
    release();
    await flush();
    expect(sentOf("offer")).toHaveLength(0);
  });

  test("iki oturum aynı anda bağlanınca çakışma (rollback) olmaz: yalnızca impolite teklif yapar", async () => {
    const sent: string[] = [];
    const make = (selfId: string, list: FakePeer[], other: () => VoiceSession) =>
      new VoiceSession(
        {
          createPeer: (config) => {
            const p = new FakePeer(config);
            list.push(p);
            return p as unknown as RTCPeerConnection;
          },
        },
        {
          sendSignal: (_to, kind, payload) => {
            sent.push(`${selfId}:${kind}`);
            setTimeout(() => void other().handleSignal(selfId, kind, payload), 0);
          },
          onRemoteStream: () => {},
          onPeerState: () => {},
          onPeerClosed: () => {},
        },
      );
    const peersA: FakePeer[] = [];
    const peersB: FakePeer[] = [];
    const a: VoiceSession = make("a", peersA, () => b);
    const b: VoiceSession = make("b", peersB, () => a);
    a.start(fakeStream(), ICE, "a");
    b.start(fakeStream(), ICE, "b");
    a.setMembers([member("a"), member("b")]);
    b.setMembers([member("a"), member("b")]);
    for (let i = 0; i < 10; i++) await flush();

    // Chrome'da teklif sürerken yapılan rollback ICE'ı bazen kilitliyor; ilk bağlantıda hiç olmamalı.
    expect(sent.filter((x) => x.endsWith(":offer"))).toEqual(["b:offer"]);
    expect(sent).toContain("a:answer");
    expect(peersA[0].setLocalDescription).toHaveBeenCalledTimes(1); // yalnızca answer
    expect(peersA[0].signalingState).toBe("stable");
    expect(peersB[0].signalingState).toBe("stable");
    expect(peersA[0].addTrack).toHaveBeenCalledTimes(1);
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
    setup("d"); // "d" > "c" → impolite: yeniden başlatan taraf
    session.setMembers([member("c")]);
    peers[0].setState("failed");
    expect(peers[0].restartIce).toHaveBeenCalledTimes(1);
    expect(cb.onPeerState).not.toHaveBeenCalledWith("c", "failed");
    peers[0].setState("connecting");
    peers[0].setState("failed");
    expect(peers[0].restartIce).toHaveBeenCalledTimes(1);
    expect(cb.onPeerState).toHaveBeenCalledWith("c", "failed");
  });

  test("connected olunca restartIce hakkı yenilenir", () => {
    setup("d"); // impolite
    session.setMembers([member("c")]);
    peers[0].setState("failed");
    peers[0].setState("connected");
    peers[0].setState("failed");
    expect(peers[0].restartIce).toHaveBeenCalledTimes(2);
    expect(cb.onPeerState).not.toHaveBeenCalledWith("c", "failed");
    peers[0].setState("failed");
    expect(peers[0].restartIce).toHaveBeenCalledTimes(2);
    expect(cb.onPeerState).toHaveBeenCalledWith("c", "failed");
  });

  test("polite taraf failed'da restartIce yapmaz (çakışma olmasın), ikinci failed'da bildirir", () => {
    session.setMembers([member("c")]); // "b" < "c" → polite
    peers[0].setState("failed");
    expect(peers[0].restartIce).not.toHaveBeenCalled();
    expect(cb.onPeerState).not.toHaveBeenCalledWith("c", "failed");
    peers[0].setState("connecting"); // impolite tarafın yeni offer'ı geldi
    peers[0].setState("failed");
    expect(peers[0].restartIce).not.toHaveBeenCalled();
    expect(cb.onPeerState).toHaveBeenCalledWith("c", "failed");
  });

  test("disconnected → connecting bildirilir", () => {
    session.setMembers([member("c")]);
    peers[0].setState("connected");
    cb.onPeerState.mockClear();
    peers[0].setState("disconnected");
    expect(cb.onPeerState).toHaveBeenCalledWith("c", "connecting");
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

  test("stop üye listesini de temizler: yeniden start eski üyelere bağlanmaz", () => {
    session.setMembers([member("c")]);
    session.stop();
    session.start(stream, ICE, "b");
    expect(peers).toHaveLength(1);
  });
});

describe("VoiceSession bekçi (sessiz başarısızlık yok)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "queueMicrotask"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  // Sahte saat, bir zamanlayıcı içinde kurulan 0 ms'lik zamanlayıcıyı 1 ms sonraya koyar.
  const settle = async () => {
    for (let i = 0; i < 10; i++) await tick(1);
  };
  const failedCalls = () => cb.onPeerState.mock.calls.filter((c) => c[1] === "failed");

  test("impolite: teklif yanıtsız kalırsa süre dolunca aynı offer yeniden gönderilir", async () => {
    setup("d"); // impolite
    session.setMembers([member("c")]);
    await tick(0); // addTrack → negotiationneeded → offer
    expect(sentOf("offer")).toHaveLength(1);
    expect(peers[0].signalingState).toBe("have-local-offer");

    await tick(VOICE_WATCHDOG_MS - 1);
    expect(sentOf("offer")).toHaveLength(1);
    await tick(1);
    const offers = sentOf("offer");
    expect(offers).toHaveLength(2);
    expect(offers[1][0]).toBe("c");
    expect(JSON.parse(offers[1][2])).toEqual({ type: "offer", sdp: "yerel-offer" });
    expect(failedCalls()).toHaveLength(0);
  });

  test("impolite: ikinci süre de dolarsa onPeerState(failed)", async () => {
    setup("d");
    session.setMembers([member("c")]);
    await tick(VOICE_WATCHDOG_MS);
    expect(failedCalls()).toHaveLength(0);
    await tick(VOICE_WATCHDOG_MS);
    expect(failedCalls()).toEqual([["c", "failed"]]);
  });

  test("impolite: müzakere bitti ama bağlantı kurulmadıysa restartIce", async () => {
    setup("d");
    session.setMembers([member("c")]);
    await tick(0);
    await session.handleSignal("c", "answer", JSON.stringify({ type: "answer", sdp: "uzak" }));
    expect(peers[0].signalingState).toBe("stable");
    await tick(VOICE_WATCHDOG_MS);
    expect(peers[0].restartIce).toHaveBeenCalledTimes(1);
    expect(sentOf("offer")).toHaveLength(1); // yeniden gönderme değil, ICE yenileme
  });

  test("polite: hiç offer gelmezse (uzatılmış) süre dolunca izleri ekleyip kendisi teklif eder", async () => {
    setup("b");
    session.setMembers([member("c")]); // polite
    await tick(VOICE_WATCHDOG_MS);
    expect(peers[0].addTrack).not.toHaveBeenCalled(); // impolite tarafa yeniden gönderme fırsatı
    await tick(VOICE_WATCHDOG_POLITE_EXTRA_MS);
    expect(peers[0].addTrack).toHaveBeenCalledTimes(1);
    await tick(0);
    expect(sentOf("offer")).toHaveLength(1);
    expect(sentOf("offer")[0][0]).toBe("c");

    // Answer gelir, iki taraf stable; bağlantı yine de kurulmazsa ikinci sürede failed.
    await session.handleSignal("c", "answer", JSON.stringify({ type: "answer", sdp: "uzak" }));
    expect(peers[0].signalingState).toBe("stable");
    await tick(VOICE_WATCHDOG_MS);
    expect(failedCalls()).toEqual([["c", "failed"]]);
  });

  test("polite: offer almışsa süre dolunca teklif etmez, ikinci sürede failed", async () => {
    setup("b");
    session.setMembers([member("c")]);
    await session.handleSignal("c", "offer", JSON.stringify({ type: "offer", sdp: "uzak" }));
    await tick(0);
    await tick(VOICE_WATCHDOG_MS + VOICE_WATCHDOG_POLITE_EXTRA_MS);
    expect(sentOf("offer")).toHaveLength(0);
    expect(peers[0].restartIce).not.toHaveBeenCalled();
    expect(failedCalls()).toHaveLength(0);
    await tick(VOICE_WATCHDOG_MS);
    expect(failedCalls()).toEqual([["c", "failed"]]);
  });

  test("polite'ın kendi teklifi impolite'ın yeniden gönderdiği teklifle çakışırsa perfect negotiation çözer", async () => {
    const sent: string[] = [];
    const make = (selfId: string, list: FakePeer[], other: () => VoiceSession) =>
      new VoiceSession(
        {
          createPeer: (config) => {
            const p = new FakePeer(config);
            list.push(p);
            return p as unknown as RTCPeerConnection;
          },
        },
        {
          sendSignal: (_to, kind, payload) => {
            sent.push(`${selfId}:${kind}`);
            setTimeout(() => void other().handleSignal(selfId, kind, payload), 0);
          },
          onRemoteStream: () => {},
          onPeerState: () => {},
          onPeerClosed: () => {},
        },
      );
    const peersA: FakePeer[] = [];
    const peersB: FakePeer[] = [];
    const a: VoiceSession = make("a", peersA, () => b); // polite
    const b: VoiceSession = make("b", peersB, () => a); // impolite
    a.start(fakeStream(), ICE, "a");
    b.start(fakeStream(), ICE, "b");
    // Impolite taraf polite'ı henüz üye olarak görmüyor (ör. bağlantıyı kapatıp yeniden açtı).
    a.setMembers([member("a"), member("b")]);
    b.setMembers([member("b")]);
    await tick(VOICE_WATCHDOG_MS + VOICE_WATCHDOG_POLITE_EXTRA_MS); // polite kendisi teklif eder
    await settle();
    // Impolite bilinmeyen eşten gelen offer'ı kabul eder (sahte eşte ardından zararsız bir yeniden müzakere olabilir).
    expect(sent.slice(0, 2)).toEqual(["a:offer", "b:answer"]);
    expect(peersA[0].signalingState).toBe("stable");
    expect(peersB[0].signalingState).toBe("stable");

    // Sonra iki taraf aynı anda yeniden müzakere ister: polite rollback ile kabul eder.
    sent.length = 0;
    peersA[0].onnegotiationneeded?.();
    peersB[0].onnegotiationneeded?.();
    await settle();
    expect(sent).toContain("a:answer");
    expect(sent).not.toContain("b:answer");
    expect(peersA[0].signalingState).toBe("stable");
    expect(peersB[0].signalingState).toBe("stable");
    a.stop();
    b.stop();
  });

  test("kaybolan ilk offer: impolite yeniden gönderir, polite yanıtlar, polite ayrıca teklif etmez", async () => {
    const sent: string[] = [];
    let dropFirstOffer = true;
    const make = (selfId: string, list: FakePeer[], other: () => VoiceSession) =>
      new VoiceSession(
        {
          createPeer: (config) => {
            const p = new FakePeer(config);
            list.push(p);
            return p as unknown as RTCPeerConnection;
          },
        },
        {
          sendSignal: (_to, kind, payload) => {
            sent.push(`${selfId}:${kind}`);
            if (kind === "offer" && dropFirstOffer) {
              dropFirstOffer = false; // ilk offer kaybolur
              return;
            }
            setTimeout(() => void other().handleSignal(selfId, kind, payload), 0);
          },
          onRemoteStream: () => {},
          onPeerState: () => {},
          onPeerClosed: () => {},
        },
      );
    const peersA: FakePeer[] = [];
    const peersB: FakePeer[] = [];
    const a: VoiceSession = make("a", peersA, () => b); // polite
    const b: VoiceSession = make("b", peersB, () => a); // impolite
    a.start(fakeStream(), ICE, "a");
    b.start(fakeStream(), ICE, "b");
    a.setMembers([member("a"), member("b")]);
    b.setMembers([member("a"), member("b")]);
    await tick(0);
    expect(sent).toEqual(["b:offer"]); // kayboldu
    expect(peersB[0].signalingState).toBe("have-local-offer");

    await tick(VOICE_WATCHDOG_MS); // impolite yeniden gönderir, polite yanıtlar
    await settle();
    expect(sent).toEqual(["b:offer", "b:offer", "a:answer"]);
    expect(peersA[0].signalingState).toBe("stable");
    expect(peersB[0].signalingState).toBe("stable");
    expect(peersA[0].addTrack).toHaveBeenCalledTimes(1);

    // Polite'ın uzatılmış süresi dolduğunda izleri zaten vardır: ek teklif yapmaz.
    await tick(VOICE_WATCHDOG_POLITE_EXTRA_MS);
    expect(sent.filter((x) => x === "a:offer")).toHaveLength(0);
    a.stop();
    b.stop();
  });

  test("connected olunca bekçi durur; kopunca yeniden kurulur", async () => {
    setup("d");
    session.setMembers([member("c")]);
    await tick(0);
    peers[0].setState("connected");
    await tick(VOICE_WATCHDOG_MS * 3);
    expect(sentOf("offer")).toHaveLength(1);
    expect(failedCalls()).toHaveLength(0);

    peers[0].setState("disconnected");
    await tick(VOICE_WATCHDOG_MS * 2);
    expect(failedCalls()).toEqual([["c", "failed"]]);
  });

  test("stop ve eşin kapanması bekçiyi temizler", async () => {
    setup("d");
    session.setMembers([member("c"), member("e")]);
    await tick(0);
    session.setMembers([member("e")]); // c kapanır
    session.stop();
    expect(vi.getTimerCount()).toBe(0);
    await tick(VOICE_WATCHDOG_MS * 3);
    expect(failedCalls()).toHaveLength(0);
  });
});
