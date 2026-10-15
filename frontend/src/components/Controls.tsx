import { useEffect, useState } from "react";
import { formatTime } from "../lib/media";
import type { PlaybackState } from "../lib/types";
import type { VolumeSetting } from "../lib/identity";
import { Icon } from "./Icon";

interface Props {
  playback: PlaybackState | null;
  disabled: boolean;
  getPosition(): number;
  getDuration(): number;
  onPlay(): void;
  onPause(): void;
  onSeek(sec: number): void;
  volume: VolumeSetting;
  onVolume(v: VolumeSetting): void;
  subtitlesOn: boolean;
  onToggleSubtitles(): void;
  isFullscreen: boolean;
  onToggleFullscreen(): void;
  chatOpen: boolean;
  onToggleChat(): void;
  /** Sesli sohbetteysem mikrofonun kapalı olup olmadığı; değilsem null (tam ekranda düğme görünmez). */
  voiceMuted: boolean | null;
  onToggleVoiceMute(): void;
}

export function Controls(props: Props) {
  const { playback, disabled, getPosition, getDuration, onPlay, onPause, onSeek, volume, onVolume } = props;
  const [, setFrame] = useState(0);
  const [dragValue, setDragValue] = useState<number | null>(null);

  // Konum göstergesi için saniyede birkaç kez yeniden çiz.
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 250);
    return () => clearInterval(t);
  }, []);

  const duration = getDuration();
  const position = dragValue ?? Math.min(getPosition(), duration || Infinity);
  const isPlaying = playback?.isPlaying ?? false;
  const silent = volume.muted || volume.volume === 0;

  const commitSeek = () => {
    if (dragValue !== null) onSeek(dragValue);
    setDragValue(null);
  };

  const skip = (delta: number) => onSeek(Math.max(0, Math.min(getPosition() + delta, duration || Infinity)));

  return (
    <div className="controls">
      <button className="icon" disabled={disabled} onClick={isPlaying ? onPause : onPlay} title={isPlaying ? "Durdur" : "Oynat"}>
        <Icon name={isPlaying ? "pause" : "play"} />
      </button>
      <button className="icon small skip" disabled={disabled} onClick={() => skip(-10)} title="10 sn geri">
        <Icon name="back" />
        <span className="skip-n">10</span>
      </button>
      <button className="icon small skip" disabled={disabled} onClick={() => skip(10)} title="10 sn ileri">
        <Icon name="forward" />
        <span className="skip-n">10</span>
      </button>
      <span className="time">{formatTime(position)}</span>
      <input
        type="range"
        className="seek"
        min={0}
        max={duration || 0}
        step={0.1}
        value={duration ? position : 0}
        disabled={disabled || !duration}
        onChange={(e) => setDragValue(Number(e.target.value))}
        onPointerUp={commitSeek}
        onKeyUp={commitSeek}
        onBlur={() => setDragValue(null)}
      />
      <span className="time">{formatTime(duration)}</span>

      {/* Ses sadece bu kişiyi etkiler, sunucuya gitmez. */}
      <div className="volume">
        <button
          className="icon small"
          onClick={() => onVolume({ volume: volume.volume || 50, muted: !silent })}
          title={silent ? "Sesi aç" : "Sesi kapat"}
        >
          <Icon name={silent ? "mute" : volume.volume < 50 ? "volumeLow" : "volume"} />
        </button>
        <input
          type="range"
          className="volume-slider"
          min={0}
          max={100}
          step={1}
          value={volume.muted ? 0 : volume.volume}
          onChange={(e) => onVolume({ volume: Number(e.target.value), muted: false })}
          aria-label="Ses"
        />
      </div>

      {/* Altyazı açık/kapalı da kişiye özel, sunucuya gitmez. */}
      {playback?.mediaType === "file" && playback.subtitleUrl && (
        <button
          className={`icon small${props.subtitlesOn ? " active" : ""}`}
          onClick={props.onToggleSubtitles}
          aria-pressed={props.subtitlesOn}
          title="Altyazı"
        >
          <Icon name="cc" />
        </button>
      )}
      {/* Tam ekranda yan panel görünmez; sesli sohbetteyken mikrofon buradan açılıp kapanır. */}
      {props.isFullscreen && props.voiceMuted !== null && (
        <button
          className={`icon small voice-mic${props.voiceMuted ? " is-muted" : ""}`}
          onClick={props.onToggleVoiceMute}
          aria-label="Mikrofonu kapat"
          aria-pressed={props.voiceMuted}
          title={props.voiceMuted ? "Mikrofonu aç" : "Mikrofonu kapat"}
        >
          <Icon name={props.voiceMuted ? "micOff" : "mic"} />
        </button>
      )}
      {props.isFullscreen && (
        <button className={`icon small${props.chatOpen ? " active" : ""}`} onClick={props.onToggleChat} title="Sohbeti göster/gizle">
          <Icon name="chat" />
        </button>
      )}
      <button className="icon small" onClick={props.onToggleFullscreen} title={props.isFullscreen ? "Tam ekrandan çık" : "Tam ekran"}>
        <Icon name={props.isFullscreen ? "shrink" : "expand"} />
      </button>
    </div>
  );
}
