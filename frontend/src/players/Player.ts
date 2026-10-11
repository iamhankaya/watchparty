/**
 * İki oynatıcı tipi (YouTube ve MP4) bu arayüzün arkasında durur.
 * Senkron motoru (SyncEngine) hangi oynatıcıyla konuştuğunu bilmez.
 */
export interface Player {
  isReady(): boolean;
  /** Oynatma başlatılamazsa (tarayıcı otomatik oynatmayı engellediyse) false döner. */
  play(): Promise<boolean>;
  pause(): void;
  seek(sec: number): void;
  getTime(): number;
  getDuration(): number;
  /** Oynuyor veya oynamak için yükleniyor (buffering) mu? */
  isPlaying(): boolean;
  /** Hızla sessiz yakalama sadece HTML5 video'da var; YouTube'da yalnızca seek kullanılır. */
  readonly supportsRate: boolean;
  setRate(rate: number): void;
  /** Ses herkesin kendine ait; sunucuya gitmez. volume: 0-100 */
  setVolume(volume: number, muted: boolean): void;
}
