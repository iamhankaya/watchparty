import { useEffect, useRef } from "react";
import type { Player } from "./Player";

interface Props {
  url: string;
  onPlayer(player: Player | null): void;
  onError(message: string): void;
}

/** MP4 filmler için HTML5 <video>. İleri sarma, tarayıcının byte-range istekleriyle çalışır. */
export function FilePlayer({ url, onPlayer, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const player: Player = {
      supportsRate: true,
      isReady: () => video.readyState >= HTMLMediaElement.HAVE_METADATA,
      async play() {
        try {
          await video.play();
          return true;
        } catch (e) {
          // NotAllowedError: tarayıcı kullanıcı tıklaması olmadan sesli oynatmaya izin vermedi.
          return !(e instanceof DOMException && e.name === "NotAllowedError");
        }
      },
      pause: () => video.pause(),
      seek: (sec) => {
        video.currentTime = sec;
      },
      getTime: () => video.currentTime,
      getDuration: () => (Number.isFinite(video.duration) ? video.duration : 0),
      isPlaying: () => !video.paused && !video.ended,
      setRate: (rate) => {
        if (video.playbackRate !== rate) video.playbackRate = rate;
      },
      setVolume: (volume, muted) => {
        video.volume = volume / 100;
        video.muted = muted;
      },
    };

    const handleError = () => onError("Video yüklenemedi. URL'nin doğrudan bir MP4 dosyasına gittiğinden emin olun.");
    video.addEventListener("error", handleError);
    onPlayer(player);

    return () => {
      video.removeEventListener("error", handleError);
      onPlayer(null);
    };
  }, [url, onPlayer, onError]);

  return <video ref={videoRef} className="player-frame" src={url} playsInline preload="auto" />;
}
