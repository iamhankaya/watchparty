import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { LobbyConnection, VoiceJoinResult } from "./connection";
import { errorMessage } from "./errors";
import { SpeakingDetector } from "./speaking";
import type { VoiceMember, VoiceSignalKind } from "./types";
import { VoiceSession, type PeerState } from "./voice";

export type VoicePhase = "idle" | "joining" | "joined";

export const VOICE_LOST_TEXT = "Bağlantı koptu; sesli sohbetten çıkıldı";

/** Mikrofon hatası → kullanıcıya gösterilecek Türkçe metin. */
export function micErrorMessage(e: unknown): string {
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Mikrofon izni verilmedi";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Mikrofon bulunamadı";
  return "Mikrofon açılamadı";
}

/**
 * Sesli sohbetteyken gelen üye listesinde kendimiz yoksa sunucu bizi düşürmüştür
 * (ör. bağlantı başka yoldan yenilendi); yerel oturum da kapanmalı.
 */
export function lostVoiceMembership(phase: VoicePhase, selfId: string | null, members: VoiceMember[]): boolean {
  return phase === "joined" && !!selfId && !members.some((m) => m.id === selfId);
}

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

/**
 * JoinVoice'u, oturumu önceden sinyal hedefi yaparak çağırır. Karşı tarafın ilk offer'ı JoinVoice
 * sonucundan önce gelebilir (ör. aynı SignalR paketinde, long polling'de sık); oturum start()'tan
 * önce gelen sinyalleri tamponlayıp start'ta işler, böylece düşmez. Katılma başarısızsa ya da bu
 * arada bayatladıysa (isCurrent false) oturum durdurulur, tamponu atılır ve hedef temizlenir;
 * bayatlamada sunucudaki üyelik de geri alınır. Başarıda hedef oturumda kalır (start çağıranın işi).
 */
export async function joinVoiceBuffered(
  conn: Pick<LobbyConnection, "joinVoice" | "leaveVoice">,
  session: Pick<VoiceSession, "stop">,
  target: { current: unknown },
  isCurrent: () => boolean,
): Promise<VoiceJoinResult | null> {
  target.current = session;
  const release = () => {
    if (target.current === session) target.current = null;
    session.stop();
  };
  let result: VoiceJoinResult;
  try {
    result = await conn.joinVoice();
  } catch (e) {
    release();
    throw e;
  }
  if (!isCurrent()) {
    release();
    conn.leaveVoice().catch(() => {});
    return null;
  }
  return result;
}

interface Options {
  connRef: RefObject<LobbyConnection | null>;
  selfId: string | null;
  notify(text: string, kind: "error" | "info"): void;
}

/** Bir sesli sohbet oturumunun kaynakları; ayrılınca hepsi kapanır. */
interface Active {
  stream: MediaStream;
  session: VoiceSession;
  detector: SpeakingDetector;
  audios: Map<string, HTMLAudioElement>;
}

/**
 * Sesli sohbet durumu ve kaynakları (mikrofon, VoiceSession, konuşma algılama, eş başına gizli <audio>).
 * Bağlantı olayları onMembers/onSignal/onConnectionDown ile içeri verilir; bunlar kararlıdır.
 */
export function useVoice({ connRef, selfId, notify }: Options) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [members, setMembers] = useState<VoiceMember[]>([]);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(new Set());
  const [peerStates, setPeerStates] = useState<Record<string, PeerState>>({});
  // Kişi başı ses düzeyi (0-100), yalnızca bu oturumda; localStorage'a yazılmaz.
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  const activeRef = useRef<Active | null>(null);
  // Gelen sinyallerin hedefi: katılma sürerken (JoinVoice beklenirken) de dolu, sinyaller tamponlanır.
  const sessionRef = useRef<VoiceSession | null>(null);
  // Her katılma/ayrılma bir kuşak; bekleyen katılma işi eski kuşaktaysa kaynaklarını bırakır.
  const genRef = useRef(0);
  const selfIdRef = useRef(selfId);
  const volumesRef = useRef(volumes);
  const notifyRef = useRef(notify);
  const phaseRef = useRef(phase);
  const mutedRef = useRef(muted);
  // Olay ve async işler güncel değerleri ref'lerden okur.
  selfIdRef.current = selfId;
  volumesRef.current = volumes;
  notifyRef.current = notify;
  phaseRef.current = phase;
  mutedRef.current = muted;

  const teardown = useCallback(() => {
    genRef.current++;
    const a = activeRef.current;
    activeRef.current = null;
    sessionRef.current?.stop(); // katılma sürerken oluşturulmuş oturum ve tamponu
    sessionRef.current = null;
    if (a) {
      a.session.stop(); // her eş için onPeerClosed → <audio> kaldırılır
      for (const t of a.stream.getTracks()) t.stop(); // mikrofonun sahibi biziz
      a.detector.stop();
      for (const audio of a.audios.values()) removeAudio(audio);
      a.audios.clear();
    }
    phaseRef.current = "idle";
    setPhase("idle");
    setMuted(false);
    setSpeaking(new Set());
    setPeerStates({});
  }, []);

  const join = useCallback(async () => {
    if (activeRef.current || phaseRef.current !== "idle") return;
    const gen = ++genRef.current;
    phaseRef.current = "joining"; // render beklemeden: çift tıklama ikinci kez katılmasın
    setPhase("joining");
    // Algılayıcının AudioContext'i tıklama anında, ilk await'ten önce açılır: iOS Safari gibi
    // tarayıcılar yalnızca kullanıcı etkileşimi sırasında açılan/sürdürülen sesi çalıştırır.
    const detector = new SpeakingDetector();
    detector.prime();

    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia yok");
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (e) {
      detector.stop();
      if (gen !== genRef.current) return;
      phaseRef.current = "idle";
      setPhase("idle");
      notifyRef.current(micErrorMessage(e), "error");
      return;
    }
    const stopStream = () => stream.getTracks().forEach((t) => t.stop());

    const conn = connRef.current;
    const me = selfIdRef.current;
    if (gen !== genRef.current || !conn || !me) {
      stopStream();
      detector.stop();
      if (gen === genRef.current) {
        phaseRef.current = "idle";
        setPhase("idle");
      }
      return;
    }

    const audios = new Map<string, HTMLAudioElement>();
    const session = new VoiceSession(
      { createPeer: (config) => new RTCPeerConnection(config) },
      {
        sendSignal: (toId, kind, payload) => {
          conn.voiceSignal(toId, kind, payload).catch((err) => console.warn("Ses sinyali gönderilemedi", err));
        },
        onRemoteStream: (id, remote) => {
          let audio = audios.get(id);
          if (!audio) {
            audio = createAudio(id);
            audios.set(id, audio);
          }
          audio.volume = (volumesRef.current[id] ?? 100) / 100;
          audio.srcObject = remote;
          audio.play().catch(() => {});
          detector.watch(id, remote);
        },
        onPeerState: (id, state) => setPeerStates((s) => (s[id] === state ? s : { ...s, [id]: state })),
        onPeerClosed: (id) => {
          const audio = audios.get(id);
          if (audio) removeAudio(audio);
          audios.delete(id);
          detector.unwatch(id);
          setPeerStates((s) => {
            if (!(id in s)) return s;
            const next = { ...s };
            delete next[id];
            return next;
          });
        },
      },
    );

    // Bu arada ayrıldık, bağlantı koptu ya da değişti: sunucudaki üyelik geri alınır.
    const isCurrent = () => gen === genRef.current && connRef.current === conn && selfIdRef.current === me;
    let result: VoiceJoinResult | null;
    try {
      result = await joinVoiceBuffered(conn, session, sessionRef, isCurrent);
    } catch (e) {
      stopStream();
      detector.stop();
      if (gen !== genRef.current) return;
      phaseRef.current = "idle";
      setPhase("idle");
      notifyRef.current(errorMessage(e), "error");
      return;
    }
    if (!result) {
      stopStream();
      detector.stop();
      if (gen === genRef.current) {
        phaseRef.current = "idle";
        setPhase("idle");
      }
      return;
    }

    detector.onChange((id, on) =>
      setSpeaking((s) => {
        if (s.has(id) === on) return s;
        const next = new Set(s);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    );
    activeRef.current = { stream, session, detector, audios };
    // Sonuç gelir gelmez (aynı tikte) başlat: tampondaki sinyaller start'ta işlenir.
    session.setMembers(result.members);
    session.start(stream, result.iceServers, me);
    detector.watch(me, stream);
    setMembers(result.members);
    setMuted(false);
    phaseRef.current = "joined";
    setPhase("joined");
  }, [connRef]);

  const leave = useCallback(() => {
    if (activeRef.current || phaseRef.current !== "idle") connRef.current?.leaveVoice().catch(() => {});
    teardown();
  }, [connRef, teardown]);

  const toggleMute = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    const next = !mutedRef.current;
    a.session.setMuted(next); // yerelde hemen; durum herkese simge için yayınlanır
    setMuted(next);
    connRef.current?.setVoiceMuted(next).catch((e) => {
      // Sunucu kabul etmedi: başkaları eski durumu görüyor, yereli de geri al (oturum hâlâ aynıysa).
      if (activeRef.current === a && mutedRef.current === next) {
        a.session.setMuted(!next);
        mutedRef.current = !next;
        setMuted(!next);
      }
      notifyRef.current(errorMessage(e), "error");
    });
  }, [connRef]);

  const setVolume = useCallback((id: string, value: number) => {
    setVolumes((v) => ({ ...v, [id]: value }));
    const audio = activeRef.current?.audios.get(id);
    if (audio) audio.volume = value / 100;
  }, []);

  // Bağlantı olayları (LobbyPage'deki bağlantı kurulurken bir kez bağlanır, bu yüzden kararlı).
  const onMembers = useCallback(
    (list: VoiceMember[]) => {
      setMembers(list);
      if (lostVoiceMembership(phaseRef.current, selfIdRef.current, list)) {
        teardown();
        notifyRef.current(VOICE_LOST_TEXT, "info");
        return;
      }
      sessionRef.current?.setMembers(list);
    },
    [teardown],
  );

  const onSignal = useCallback((fromId: string, kind: VoiceSignalKind, payload: string) => {
    // Katılma sürerken de oturuma gider: start()'tan önce gelenler tamponlanır.
    void sessionRef.current?.handleSignal(fromId, kind, payload);
  }, []);

  /** SignalR koptu ya da yeniden bağlanıyor: sunucu üyeliği düşürür, biz de kapatırız (otomatik katılma yok). */
  const onConnectionDown = useCallback(() => {
    // Liste bayatladı (n/6 ve dolu düğmesi yanlış kalmasın); tazesi yeniden JoinLobby'de gelir.
    setMembers([]);
    if (!activeRef.current && phaseRef.current === "idle") return;
    teardown();
    notifyRef.current(VOICE_LOST_TEXT, "info");
  }, [teardown]);

  // Sayfadan çıkınca: LeaveVoice (mümkünse) ve tüm kaynaklar.
  useEffect(
    () => () => {
      if (activeRef.current) connRef.current?.leaveVoice().catch(() => {});
      teardown();
    },
    [connRef, teardown],
  );

  return { phase, members, muted, speaking, peerStates, volumes, join, leave, toggleMute, setVolume, onMembers, onSignal, onConnectionDown };
}

export type VoiceState = ReturnType<typeof useVoice>;

function createAudio(id: string): HTMLAudioElement {
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.hidden = true;
  audio.dataset.voicePeer = id;
  document.body.appendChild(audio);
  return audio;
}

function removeAudio(audio: HTMLAudioElement) {
  audio.pause();
  audio.srcObject = null;
  audio.remove();
}
