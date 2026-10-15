import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { getLobby } from "../lib/api";
import { ServerClock } from "../lib/clock";
import { createLobbyConnection, type LobbyConnection } from "../lib/connection";
import { describeConnectionError, errorMessage } from "../lib/errors";
import {
  getChatSoundOn,
  getClientId,
  getNickname,
  getSubtitlesOn,
  getVolume,
  saveChatSoundOn,
  saveNickname,
  saveSubtitlesOn,
  saveVolume,
  type VolumeSetting,
} from "../lib/identity";
import { isChatVisible, playBlip, shouldNotify, titleWithCount } from "../lib/notify";
import { lockLandscape, unlockOrientation } from "../lib/orientation";
import { SyncEngine } from "../lib/sync";
import { genitive } from "../lib/turkish";
import { TypingTracker } from "../lib/typing";
import { useVoice } from "../lib/useVoice";
import {
  expectedPosition,
  MAX_NICKNAME,
  type ChatMessage,
  type ConnectionStatus,
  type Participant,
  type PlaybackState,
} from "../lib/types";
import type { Player } from "../players/Player";
import { PlayerArea } from "../components/PlayerArea";
import { Controls } from "../components/Controls";
import { MediaPicker } from "../components/MediaPicker";
import { Participants } from "../components/Participants";
import { Chat } from "../components/Chat";
import { LobbyStrip } from "../components/LobbyStrip";
import { SidePanel } from "../components/SidePanel";
import { CodeBoard } from "../components/CodeBoard";
import { WaitingBanner } from "../components/WaitingBanner";
import { VoiceBar } from "../components/VoiceBar";

interface Props {
  code: string;
  navigate(to: string): void;
}

type Phase = "checking" | "notfound" | "full" | "nickname" | "joining" | "joined" | "failed";
type Toast = { text: string; kind: "error" | "info" };

export function LobbyPage({ code, navigate }: Props) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [nickname, setNickname] = useState(getNickname());
  const [selfId, setSelfId] = useState<string | null>(null);
  const [joinedAsHost, setJoinedAsHost] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [hostOnly, setHostOnly] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [blocked, setBlocked] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  // Bağlantı istemeden koptuysa sebep metni; "Yeniden bağlan" başarılı olunca temizlenir.
  const [lostReason, setLostReason] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [volume, setVolume] = useState<VolumeSetting>(getVolume);
  const [subtitlesOn, setSubtitlesOn] = useState(getSubtitlesOn);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [soundOn, setSoundOn] = useState(getChatSoundOn);
  // Sayfa gizliyken ya da odakta değilken gelen başkalarının mesajları (sekme başlığında gösterilir).
  const [unread, setUnread] = useState(0);
  const [typingLabel, setTypingLabel] = useState<string | null>(null);

  const connRef = useRef<LobbyConnection | null>(null);
  const clockRef = useRef(new ServerClock());
  const engineRef = useRef<SyncEngine | null>(null);
  const playerRef = useRef<Player | null>(null);
  const volumeRef = useRef(volume);
  const theaterRef = useRef<HTMLDivElement>(null);
  // Bağlantı olayları join() kapanışında çalışır; güncel değerleri ref'lerden okurlar.
  const myNicknameRef = useRef(nickname);
  const soundOnRef = useRef(soundOn);
  const fullscreenRef = useRef(false);
  const chatOpenRef = useRef(true);
  const lastSoundAtRef = useRef(-Infinity);
  // Sayaç eklenmeden önceki özgün başlık (titleWithCount mevcut öneki ayıklamaz).
  const baseTitleRef = useRef(document.title);
  const trackerRef = useRef(new TypingTracker());
  // Yazanların kimlik -> takma ad eşlemesi: mesajı gelince ya da lobiden çıkınca takipçiden silmek için.
  const typingIdsRef = useRef(new Map<string, string>());

  const showError = useCallback((e: unknown) => setToast({ text: errorMessage(e), kind: "error" }), []);
  const notify = useCallback((text: string, kind: Toast["kind"]) => setToast({ text, kind }), []);
  // Sesli sohbet; sayfadan çıkınca (aşağıdaki bağlantı kapatma etkisinden önce) LeaveVoice gönderip kaynakları kapatır.
  const voice = useVoice({ connRef, selfId, notify });
  const { onMembers: voiceMembersChanged, onSignal: voiceSignalReceived, onConnectionDown: voiceConnectionDown } = voice;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Kendi takma adım: katılımcı listesindeki ad, yoksa girilen ad (olay kapanışları ref'ten okur).
  useEffect(() => {
    myNicknameRef.current = participants.find((p) => p.id === selfId)?.nickname ?? nickname;
  }, [participants, selfId, nickname]);

  // Sayfadan çıkınca bağlantıyı ve senkron motorunu kapat.
  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      void connRef.current?.stop();
    };
  }, []);

  // Aynı ad birden çok kişide olabilir; ifadede bir kez geçer.
  const refreshTyping = useCallback(() => {
    const names = trackerRef.current.active(Date.now());
    setTypingLabel(trackerRef.current.label(names));
  }, []);

  const forgetTyping = useCallback((id: string) => {
    trackerRef.current.remove(id);
    typingIdsRef.current.delete(id);
  }, []);

  // Yeni sohbet mesajı (geçmiş değil): ses, sekme sayacı ve yazanın "yazıyor" ifadesi.
  const handleIncoming = useCallback(
    (m: ChatMessage) => {
      // ChatMessage'da kimlik yok; Chat'teki "mine" ölçütüyle aynı şekilde ada göre eşleriz.
      for (const [id, name] of typingIdsRef.current) if (name === m.nickname) forgetTyping(id);
      refreshTyping();

      if (m.nickname === myNicknameRef.current) return;
      const hidden = document.hidden;
      const focused = document.hasFocus();
      const now = Date.now();
      const visible = isChatVisible({ hidden, focused, fullscreen: fullscreenRef.current, chatOpen: chatOpenRef.current });
      if (shouldNotify({ fromSelf: false, history: false, visible, soundOn: soundOnRef.current, lastSoundAt: lastSoundAtRef.current, now })) {
        lastSoundAtRef.current = now;
        playBlip();
      }
      // Sayaç ses ayarından bağımsızdır.
      if (hidden || !focused) setUnread((n) => n + 1);
    },
    [forgetTyping, refreshTyping],
  );

  const join = useCallback(
    async (nick: string, reconnect = false) => {
      if (reconnect) {
        // Eski bağlantıyı ve motoru kapat; stop() kullanıcı kapatması sayıldığı için ikinci bir uyarı çıkmaz.
        engineRef.current?.stop();
        void connRef.current?.stop();
        setRetrying(true);
      } else {
        setPhase("joining");
      }

      // Takılma bildirimi otomatiktir; hatası (ör. rate limit, kopuk bağlantı) kullanıcıya gösterilmez.
      let conn: LobbyConnection | null = null;
      const engine = new SyncEngine(clockRef.current, setBlocked, (buffering) => {
        conn?.reportBuffering(buffering).catch(() => {});
      });
      engineRef.current = engine;
      engine.start();
      engine.setPlayer(playerRef.current);

      conn = createLobbyConnection({
        participantsChanged: (list) => {
          setParticipants(list);
          // Lobiden çıkan kişinin "yazıyor" ifadesi hemen kalkar.
          const ids = new Set(list.map((p) => p.id));
          for (const id of typingIdsRef.current.keys()) if (!ids.has(id)) forgetTyping(id);
          refreshTyping();
        },
        playbackUpdated: (s) => {
          setPlayback(s);
          engine.setState(s);
        },
        controlModeChanged: setHostOnly,
        hostChanged: (name) => setToast({ text: `Yeni host: ${name}`, kind: "info" }),
        chatHistory: setChat,
        chatMessage: (m) => {
          setChat((list) => [...list, m].slice(-200));
          handleIncoming(m);
        },
        userTyping: (id, name) => {
          trackerRef.current.add(id, name, Date.now());
          typingIdsRef.current.set(id, name);
          refreshTyping();
        },
        bufferingIgnored: (name) => {
          const owner = genitive(name);
          const text = name === getNickname()
            ? "Bağlantın yavaş; senin için beklenmeyecek"
            : owner ? `${owner} bağlantısı yavaş; beklenmeyecek` : `Bağlantısı yavaş: ${name} beklenmeyecek`;
          setToast({ text, kind: "info" });
        },
        joined: (r) => {
          // İlk katılımda ve her yeniden katılımda yeni selfId gelir.
          engine.setSelfId(r.selfId);
          setSelfId(r.selfId);
          setJoinedAsHost(r.isHost);
        },
        voiceMembersChanged: (list) => {
          if (connRef.current === conn) voiceMembersChanged(list);
        },
        voiceSignal: (fromId, kind, payload) => {
          if (connRef.current === conn) voiceSignalReceived(fromId, kind, payload);
        },
        statusChanged: (st) => {
          // Sunucu kopan bağlantının sesli üyeliğini düşürür; otomatik yeniden katılmayız.
          if ((st === "reconnecting" || st === "disconnected") && connRef.current === conn) voiceConnectionDown();
          // Kopunca kimliğimiz geçersizdir; motorun takılma sayaçları sıfırlansın (yeniden katılınca yenisi gelir).
          if (st === "reconnecting" || st === "disconnected") engine.setSelfId(null);
          // Eski bağlantının geç gelen olayları yeni bağlantının durumunu ezmesin.
          if (connRef.current === conn) setStatus(st);
        },
        connectionLost: (reason) => {
          if (connRef.current !== conn) return;
          setLostReason(reason);
          // Tam ekranda banner görünmez; toast alanı görünür.
          setToast({ text: reason, kind: "error" });
        },
      });
      connRef.current = conn;

      try {
        await conn.start();
        await clockRef.current.sync(conn.ping);
        await conn.join(code, nick, getClientId());
        setLostReason(null);
        setPhase("joined");
      } catch (e) {
        engine.stop();
        void conn.stop();
        if (reconnect) {
          // Lobi ekranında kal; yeni sebebi göster, kullanıcı tekrar deneyebilsin.
          setStatus("disconnected");
          setLostReason(describeConnectionError(e));
        } else {
          connRef.current = null;
          setFatal(describeConnectionError(e, "Sunucuya bağlanılamadı"));
          setPhase("failed");
        }
      } finally {
        if (reconnect) setRetrying(false);
      }
    },
    [code, handleIncoming, refreshTyping, forgetTyping, voiceMembersChanged, voiceSignalReceived, voiceConnectionDown],
  );

  // 1) Lobi var mı, dolu mu?
  useEffect(() => {
    let cancelled = false;
    getLobby(code)
      .then((info) => {
        if (cancelled) return;
        if (!info) return setPhase("notfound");
        if (info.isFull) return setPhase("full");
        // Lobiyi yeni oluşturan kişi takma adını zaten yazdı; doğrudan katılır.
        const autoJoin = new URLSearchParams(window.location.search).has("join") && getNickname();
        window.history.replaceState(null, "", `/l/${code}`);
        if (autoJoin) void join(getNickname());
        else setPhase("nickname");
      })
      .catch((e) => {
        if (cancelled) return;
        setFatal(errorMessage(e));
        setPhase("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [code, join]);

  // Saat farkını ara ara yenile (ağ koşulları değişebilir).
  useEffect(() => {
    if (phase !== "joined") return;
    const t = setInterval(() => {
      const conn = connRef.current;
      if (conn) clockRef.current.sync(conn.ping, 3).catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, [phase]);

  // "Yazıyor" ifadesi 5 sn sonra kendiliğinden kalksın diye saniyede bir tazelenir.
  useEffect(() => {
    if (phase !== "joined") return;
    const t = setInterval(refreshTyping, 1000);
    return () => clearInterval(t);
  }, [phase, refreshTyping]);

  // Sekme başlığında okunmamış sayacı; sayfa görünür ve odaktayken sıfırlanır.
  useEffect(() => {
    document.title = titleWithCount(baseTitleRef.current, unread);
  }, [unread]);

  useEffect(() => {
    const reset = () => {
      if (!document.hidden && document.hasFocus()) setUnread(0);
    };
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("focus", reset);
    const baseTitle = baseTitleRef.current;
    return () => {
      document.removeEventListener("visibilitychange", reset);
      window.removeEventListener("focus", reset);
      document.title = baseTitle;
    };
  }, []);

  useEffect(() => {
    soundOnRef.current = soundOn;
    saveChatSoundOn(soundOn);
  }, [soundOn]);

  useEffect(() => {
    fullscreenRef.current = isFullscreen;
    chatOpenRef.current = chatOpen;
  }, [isFullscreen, chatOpen]);

  const handlePlayer = useCallback((p: Player | null) => {
    playerRef.current = p;
    p?.setVolume(volumeRef.current.volume, volumeRef.current.muted);
    engineRef.current?.setPlayer(p);
  }, []);

  // Ses ayarı kişiye özel: oynatıcıya uygula ve tarayıcıda hatırla.
  useEffect(() => {
    volumeRef.current = volume;
    playerRef.current?.setVolume(volume.volume, volume.muted);
    saveVolume(volume);
  }, [volume]);

  // Tam ekran: oynatıcı, kontroller ve (açıksa) sağda sohbet birlikte tam ekrana geçer.
  // Mobilde ekran yataya kilitlenir; tam ekrandan nasıl çıkılırsa çıkılsın (geri tuşu dahil) kilit kalkar.
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === theaterRef.current && !!theaterRef.current);
      if (!document.fullscreenElement) unlockOrientation();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      theaterRef.current
        ?.requestFullscreen()
        .then(() => lockLandscape())
        .catch(() => setToast({ text: "Tarayıcı tam ekrana izin vermedi.", kind: "error" }));
  }, []);

  function handleNicknameSubmit(e: FormEvent) {
    e.preventDefault();
    const nick = nickname.trim();
    if (!nick) return;
    saveNickname(nick);
    void join(nick);
  }

  if (phase === "checking" || phase === "joining") {
    return <main className="center muted">{phase === "checking" ? "Lobi aranıyor..." : "Lobiye bağlanılıyor..."}</main>;
  }

  if (phase === "notfound" || phase === "full" || phase === "failed") {
    const title = { notfound: "Lobi bulunamadı", full: "Lobi dolu", failed: "Lobiye girilemedi" }[phase];
    const text = {
      notfound: `"${code}" kodlu bir lobi yok ya da süresi dolmuş.`,
      full: "Bu lobide yer kalmadı (en fazla 20 kişi).",
      failed: fatal,
    }[phase];
    return (
      <main className="center">
        <div className="card narrow">
          <h2>{title}</h2>
          <p className="muted">{text}</p>
          <button className="primary" onClick={() => navigate("/")}>
            Ana sayfaya dön
          </button>
        </div>
      </main>
    );
  }

  if (phase === "nickname") {
    return (
      <main className="center">
        <form className="card narrow" onSubmit={handleNicknameSubmit}>
          <CodeBoard code={code} />
          <h2>Bu lobiye katıl</h2>
          <label className="field">
            <span>Takma ad</span>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={MAX_NICKNAME} autoFocus placeholder="ör. Ayşe" />
          </label>
          {/* Bu tıklama aynı zamanda tarayıcının sesli otomatik oynatma kilidini açar. */}
          <button className="primary" disabled={!nickname.trim()}>
            Katıl
          </button>
        </form>
      </main>
    );
  }

  const lostBanner = lostReason && (
    <div className="card lost-banner" role="alert">
      <p>{lostReason}</p>
      <button className="full" disabled={retrying} onClick={() => void join(nickname.trim() || getNickname(), true)}>
        {retrying ? "Bağlanıyor..." : "Yeniden bağlan"}
      </button>
      <button className="full" onClick={() => navigate("/")}>
        Ana sayfaya dön
      </button>
    </div>
  );

  const me = participants.find((p) => p.id === selfId);
  const isHost = me ? me.isHost : joinedAsHost;
  const canControl = !hostOnly || isHost;
  const conn = connRef.current;
  // Butonlara giden konum oynatıcınınki değil, sunucu durumundan hesaplanan konumdur.
  const serverPosition = () => (playback ? expectedPosition(playback, clockRef.current.now()) : 0);

  const chatBox = (
    <Chat
      messages={chat}
      myNickname={me?.nickname ?? nickname}
      onSend={(text) => conn?.sendChat(text).catch((err) => { showError(err); throw err; })}
      onTyping={() => conn?.typing()}
      typingLabel={typingLabel}
      soundOn={soundOn}
      onToggleSound={() => setSoundOn((on) => !on)}
    />
  );

  const theater = (
    <div ref={theaterRef} className={`theater${isFullscreen ? " is-fullscreen" : ""}${isFullscreen && chatOpen ? " with-chat" : ""}`}>
      <div className="theater-main">
        <WaitingBanner
          playback={playback}
          participants={participants}
          selfId={selfId}
          canControl={canControl}
          onSkip={() => conn?.skipWaiting().catch(showError)}
        />
        <PlayerArea
          playback={playback}
          onPlayer={handlePlayer}
          onError={showError}
          blocked={blocked}
          canControl={canControl && !!playback?.mediaId}
          subtitlesOn={subtitlesOn}
          onTogglePlay={() =>
            (playback?.isPlaying ? conn?.pause(serverPosition()) : conn?.play(serverPosition()))?.catch(showError)
          }
          onUnblock={() => engineRef.current?.unblock()}
        />
        <Controls
          playback={playback}
          disabled={!canControl || !playback?.mediaId}
          getPosition={() => engineRef.current?.currentPosition() ?? serverPosition()}
          getDuration={() => engineRef.current?.duration() ?? 0}
          onPlay={() => conn?.play(serverPosition()).catch(showError)}
          onPause={() => conn?.pause(serverPosition()).catch(showError)}
          onSeek={(sec) => conn?.seek(sec).catch(showError)}
          volume={volume}
          onVolume={setVolume}
          subtitlesOn={subtitlesOn}
          onToggleSubtitles={() => {
            // Kişisel ayar: yalnızca bu tarayıcıda hatırlanır, sunucuya gitmez.
            saveSubtitlesOn(!subtitlesOn);
            setSubtitlesOn(!subtitlesOn);
          }}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((o) => !o)}
          voiceMuted={voice.phase === "joined" ? voice.muted : null}
          onToggleVoiceMute={voice.toggleMute}
        />
      </div>
      {isFullscreen && chatOpen && chatBox}
      {/* Tam ekranda sadece bu kutunun içi görünür, bildirimler de burada olmalı. */}
      {toast && (
        <div className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );

  // Hata gösterilir ve yeniden fırlatılır: seçici, video başarısızsa altyazıyı göndermesin.
  const reportFailure = (p: Promise<void> | undefined) =>
    (p ?? Promise.resolve()).catch((err) => {
      showError(err);
      throw err;
    });
  const mediaPicker = (
    <MediaPicker
      disabled={!canControl}
      playback={playback}
      onSetMedia={(type, id) => reportFailure(conn?.setMedia(type, id))}
      onSetSubtitle={(url) => reportFailure(conn?.setSubtitle(url))}
    />
  );
  const hostOnlyNote = !canControl && <p className="muted small">Bu lobide oynatmayı sadece host kontrol ediyor.</p>;
  const hostSettings = isHost && (
    <div className="card host-settings">
      <h3>Host ayarları</h3>
      <label className="check">
        <input type="checkbox" checked={hostOnly} onChange={(e) => conn?.setControlMode(e.target.checked).catch(showError)} />
        <span>
          Sadece ben kontrol edeyim
          <small className="muted">Kapalıyken herkes oynat, durdur ve ileri sar yapabilir.</small>
        </span>
      </label>
    </div>
  );

  return (
    <main className="cn-lobby">
      <LobbyStrip code={code} status={status} participants={participants} />
      <section className="stage">
        {lostBanner}
        {theater}
        {mediaPicker}
        {hostOnlyNote}
      </section>
      <SidePanel
        top={
          <VoiceBar
            phase={voice.phase}
            count={voice.members.length}
            muted={voice.muted}
            online={status === "connected"}
            onJoin={() => void voice.join()}
            onLeave={voice.leave}
            onToggleMute={voice.toggleMute}
          />
        }
        chat={isFullscreen ? <p className="muted small cn-pane-note">Sohbet tam ekranda açık.</p> : chatBox}
        people={
          <>
            <Participants
              participants={participants}
              selfId={selfId}
              voice={{
                members: voice.members,
                joined: voice.phase === "joined",
                selfMuted: voice.muted,
                speaking: voice.speaking,
                peerStates: voice.peerStates,
                volumes: voice.volumes,
                onVolume: voice.setVolume,
              }}
            />
            {hostSettings}
          </>
        }
        peopleCount={participants.length}
        messageCount={chat.length}
      />
    </main>
  );
}
