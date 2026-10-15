import { describe, expect, it, vi } from "vitest";
import { normalizeIceServers, type VoiceJoinResult } from "./connection";
import { joinVoiceBuffered, lostVoiceMembership, MIC_CONSTRAINTS, micErrorMessage } from "./useVoice";
import { VoiceSession } from "./voice";

describe("micErrorMessage", () => {
  it("izin reddi ve cihaz yokluğu için Türkçe metin", () => {
    expect(micErrorMessage(new DOMException("x", "NotAllowedError"))).toBe("Mikrofon izni verilmedi");
    expect(micErrorMessage(new DOMException("x", "NotFoundError"))).toBe("Mikrofon bulunamadı");
    expect(micErrorMessage(new Error("başka"))).toBe("Mikrofon açılamadı");
    expect(micErrorMessage(null)).toBe("Mikrofon açılamadı");
  });

  it("yankı önleme, gürültü bastırma ve otomatik kazanç açık", () => {
    expect(MIC_CONSTRAINTS).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  });
});

describe("normalizeIceServers", () => {
  it("null kullanıcı adı/şifre atılır, metinler korunur", () => {
    expect(
      normalizeIceServers([
        { urls: ["stun:a"], username: null, credential: null },
        { urls: ["turn:b"], username: "u", credential: "p" },
      ]),
    ).toEqual([{ urls: ["stun:a"] }, { urls: ["turn:b"], username: "u", credential: "p" }]);
  });

  it("dizi değilse boş liste", () => {
    expect(normalizeIceServers(null)).toEqual([]);
  });
});

describe("lostVoiceMembership", () => {
  const me = { id: "me", nickname: "Ben", muted: false };
  const other = { id: "o", nickname: "O", muted: false };
  it("sesli sohbetteyken listede kendimiz yoksa üyelik düşmüştür", () => {
    expect(lostVoiceMembership("joined", "me", [other])).toBe(true);
    expect(lostVoiceMembership("joined", "me", [])).toBe(true);
  });
  it("listede varsak ya da katılmadıysak düşmüş sayılmaz", () => {
    expect(lostVoiceMembership("joined", "me", [other, me])).toBe(false);
    expect(lostVoiceMembership("joining", "me", [other])).toBe(false);
    expect(lostVoiceMembership("idle", "me", [])).toBe(false);
    expect(lostVoiceMembership("joined", null, [])).toBe(false);
  });
});

describe("joinVoiceBuffered", () => {
  const RESULT: VoiceJoinResult = {
    members: [
      { id: "a", nickname: "A", muted: false },
      { id: "b", nickname: "B", muted: false },
    ],
    iceServers: [],
  };

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function fakeConn() {
    const join = deferred<VoiceJoinResult>();
    return {
      join,
      conn: { joinVoice: vi.fn(() => join.promise), leaveVoice: vi.fn(async () => {}) },
    };
  }

  function makeSession() {
    const peers: { setRemoteDescription: ReturnType<typeof vi.fn> }[] = [];
    const sendSignal = vi.fn();
    const session = new VoiceSession(
      {
        createPeer: () => {
          const p = {
            signalingState: "stable" as RTCSignalingState,
            connectionState: "new",
            localDescription: null as RTCSessionDescriptionInit | null,
            addTrack: vi.fn(),
            close: vi.fn(),
            restartIce: vi.fn(),
            addIceCandidate: vi.fn(async () => {}),
            setRemoteDescription: vi.fn(async (d: RTCSessionDescriptionInit) => {
              p.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
            }),
            setLocalDescription: vi.fn(async () => {
              p.localDescription = { type: "answer", sdp: "yerel-answer" };
              p.signalingState = "stable";
            }),
          };
          peers.push(p);
          return p as unknown as RTCPeerConnection;
        },
      },
      { sendSignal, onRemoteStream: vi.fn(), onPeerState: vi.fn(), onPeerClosed: vi.fn() },
    );
    return { session, peers, sendSignal };
  }

  const stream = { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
  const OFFER = JSON.stringify({ type: "offer", sdp: "uzak" });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("JoinVoice sonucu beklenirken gelen offer kaybolmaz: start'ta işlenip yanıtlanır", async () => {
    const { conn, join } = fakeConn();
    const { session, peers, sendSignal } = makeSession();
    const target: { current: VoiceSession | null } = { current: null };

    const pending = joinVoiceBuffered(conn, session, target, () => true);
    expect(target.current).toBe(session); // sinyaller artık oturuma gider
    // Karşı tarafın (impolite) offer'ı JoinVoice sonucundan önce gelir.
    await target.current?.handleSignal("b", "candidate", JSON.stringify({ candidate: "x" }));
    await target.current?.handleSignal("b", "offer", OFFER);
    expect(peers).toHaveLength(0);

    join.resolve(RESULT);
    const result = await pending;
    expect(result).toBe(RESULT);
    expect(target.current).toBe(session);
    session.setMembers(result!.members);
    session.start(stream, result!.iceServers, "a"); // "a" < "b" → polite, offer'ı bekler
    await flush();
    expect(peers).toHaveLength(1);
    expect(peers[0].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "uzak" });
    expect(sendSignal.mock.calls.filter((c) => c[1] === "answer")).toHaveLength(1);
    session.stop();
  });

  it("katılma başarısızsa oturum durur, tampon atılır, hedef temizlenir", async () => {
    const { conn, join } = fakeConn();
    const { session, peers, sendSignal } = makeSession();
    const target: { current: VoiceSession | null } = { current: null };

    const pending = joinVoiceBuffered(conn, session, target, () => true);
    await target.current?.handleSignal("b", "offer", OFFER);
    join.reject(new Error("Sesli sohbet dolu"));
    await expect(pending).rejects.toThrow("Sesli sohbet dolu");
    expect(target.current).toBeNull();
    expect(conn.leaveVoice).not.toHaveBeenCalled();

    // Tampon atıldı: oturum sonradan başlatılsa bile eski offer işlenmez.
    session.start(stream, [], "a");
    await flush();
    expect(peers).toHaveLength(0);
    expect(sendSignal).not.toHaveBeenCalled();
    session.stop();
  });

  it("bu arada bayatladıysa oturum durur, üyelik geri alınır, null döner", async () => {
    const { conn, join } = fakeConn();
    const { session, peers } = makeSession();
    const target: { current: VoiceSession | null } = { current: null };
    let current = true;

    const pending = joinVoiceBuffered(conn, session, target, () => current);
    await target.current?.handleSignal("b", "offer", OFFER);
    current = false; // ör. kullanıcı ayrıldı ya da bağlantı değişti
    join.resolve(RESULT);
    expect(await pending).toBeNull();
    expect(target.current).toBeNull();
    expect(conn.leaveVoice).toHaveBeenCalledTimes(1);
    session.start(stream, [], "a");
    await flush();
    expect(peers).toHaveLength(0);
    session.stop();
  });

  it("hedef bu arada başka oturuma geçtiyse ona dokunulmaz", async () => {
    const { conn, join } = fakeConn();
    const { session } = makeSession();
    const other = makeSession().session;
    const target: { current: VoiceSession | null } = { current: null };

    const pending = joinVoiceBuffered(conn, session, target, () => false);
    target.current = other;
    join.resolve(RESULT);
    expect(await pending).toBeNull();
    expect(target.current).toBe(other);
  });
});
