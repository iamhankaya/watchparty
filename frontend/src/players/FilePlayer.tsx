import { useEffect, useRef } from "react";
import { decodeSubtitle, parseSubtitles, type Cue } from "../lib/subtitles";
import type { Player } from "./Player";

interface Props {
  url: string;
  /** Lobi genelinde ortak altyazı linki (yoksa null). */
  subtitleUrl: string | null;
  /** Kişisel CC ayarı: açıksa altyazı gösterilir, kapalıysa gizlenir. */
  subtitlesOn: boolean;
  onPlayer(player: Player | null): void;
  onError(message: string): void;
}

/** MP4 filmler için HTML5 <video>. İleri sarma, tarayıcının byte-range istekleriyle çalışır. */
export function FilePlayer({ url, subtitleUrl, subtitlesOn, onPlayer, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Tek bir altyazı izi kurulur ve yeniden kullanılır (addTextTrack ile eklenen iz silinemez).
  const trackRef = useRef<TextTrack | null>(null);
  // İzde şu an yüklü cue var mı? CC düğmesi yalnızca o zaman izi görünür yapar.
  const loadedRef = useRef(false);
  const subtitlesOnRef = useRef(subtitlesOn);

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

  // Altyazı: <track>/blob URL yerine (CSP) dosya okunur, ayrıştırılır ve VTTCue olarak eklenir.
  // Video ya da altyazı linki değişince önceki iz boşaltılıp kapatılır.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !subtitleUrl) return;

    let target: URL;
    try {
      target = new URL(subtitleUrl, location.href);
    } catch {
      onError("Altyazı dosyası okunamadı");
      return;
    }
    // CSP connect-src 'self': başka alana istek zaten engellenir, hiç denemeyiz.
    if (target.origin !== location.origin) {
      onError("Altyazı yüklenemedi: yalnızca bu sitedeki dosyalar açılabiliyor");
      return;
    }

    const abort = new AbortController();
    (async () => {
      let res: Response;
      try {
        res = await fetch(target, { signal: abort.signal });
      } catch {
        if (!abort.signal.aborted) onError("Altyazı dosyası okunamadı");
        return;
      }
      if (!res.ok) {
        if (!abort.signal.aborted) onError(`Altyazı yüklenemedi (HTTP ${res.status})`);
        return;
      }
      let cues: Cue[];
      try {
        cues = parseSubtitles(decodeSubtitle(await res.arrayBuffer()));
      } catch {
        cues = [];
      }
      if (abort.signal.aborted) return;
      if (cues.length === 0) return onError("Altyazı dosyası okunamadı");

      const track = (trackRef.current ??= video.addTextTrack("subtitles", "Altyazı", "tr"));
      // Kapalı (disabled) izin cues listesi null döner; eklerken gizli tutulur.
      track.mode = "hidden";
      for (const c of cues) track.addCue(new VTTCue(c.start, c.end, c.text));
      loadedRef.current = true;
      track.mode = subtitlesOnRef.current ? "showing" : "hidden";
    })();

    return () => {
      abort.abort();
      clearTrack(trackRef.current);
      loadedRef.current = false;
    };
  }, [url, subtitleUrl, onError]);

  // CC düğmesi yalnızca bu sekmeyi etkiler; sunucuya bir şey gitmez.
  useEffect(() => {
    subtitlesOnRef.current = subtitlesOn;
    const track = trackRef.current;
    if (track && loadedRef.current) track.mode = subtitlesOn ? "showing" : "hidden";
  }, [subtitlesOn]);

  return <video ref={videoRef} className="player-frame" src={url} playsInline preload="auto" />;
}

/** İzdeki tüm cue'ları siler ve izi kapatır. */
function clearTrack(track: TextTrack | null) {
  if (!track) return;
  // cues, iz kapalıyken null döner; silmeden önce gizli moda alınır.
  track.mode = "hidden";
  const cues = track.cues;
  if (cues) while (cues.length > 0) track.removeCue(cues[0]);
  track.mode = "disabled";
}
