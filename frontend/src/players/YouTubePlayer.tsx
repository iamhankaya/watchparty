import { useEffect, useRef } from "react";
import type { Player } from "./Player";

let apiPromise: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  apiPromise ??= new Promise<void>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      apiPromise = null;
      reject(new Error("YouTube oynatıcısı yüklenemedi"));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

const YT_ERRORS: Record<number, string> = {
  2: "Geçersiz YouTube video kimliği.",
  5: "Bu video tarayıcıda oynatılamıyor.",
  100: "Video bulunamadı veya kaldırılmış.",
  101: "Videonun sahibi başka sitelerde oynatılmasına izin vermiyor.",
  150: "Videonun sahibi başka sitelerde oynatılmasına izin vermiyor.",
};

interface Props {
  videoId: string;
  onPlayer(player: Player | null): void;
  onError(message: string): void;
}

export function YouTubePlayer({ videoId, onPlayer, onError }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let yt: YT.Player | null = null;
    let ready = false;
    let disposed = false;

    loadYouTubeApi()
      .then(() => {
        if (disposed || !hostRef.current) return;
        // React'in yönettiği div'i değil, içine eklenen bir çocuğu YouTube'a veriyoruz (iframe ile değiştirilecek).
        const target = document.createElement("div");
        hostRef.current.appendChild(target);
        yt = new window.YT!.Player(target, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: {
            controls: 0, // kontrolleri biz çiziyoruz; herkesin tıklaması sunucuya gidiyor
            disablekb: 1,
            fs: 0,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3,
            modestbranding: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (disposed) return;
              ready = true;
              onPlayer(player);
            },
            onError: (e) => onError(YT_ERRORS[e.data] ?? `YouTube hatası (${e.data})`),
          },
        });
      })
      .catch((e: Error) => onError(e.message));

    const player: Player = {
      supportsRate: false,
      isReady: () => ready,
      async play() {
        yt?.playVideo();
        return true; // engellenirse SyncEngine "oynamıyor" durumundan anlar
      },
      pause: () => yt?.pauseVideo(),
      seek: (sec) => yt?.seekTo(sec, true),
      getTime: () => yt?.getCurrentTime() ?? 0,
      getDuration: () => yt?.getDuration() ?? 0,
      isPlaying: () => {
        const s = yt?.getPlayerState();
        return s === 1 || s === 3;
      },
      isBuffering: () => yt?.getPlayerState() === window.YT?.PlayerState.BUFFERING,
      setRate: () => {},
      setVolume: (volume, muted) => {
        yt?.setVolume(volume);
        if (muted) yt?.mute();
        else yt?.unMute();
      },
    };

    return () => {
      disposed = true;
      onPlayer(null);
      yt?.destroy();
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, [videoId, onPlayer, onError]);

  return <div ref={hostRef} className="player-frame" />;
}
