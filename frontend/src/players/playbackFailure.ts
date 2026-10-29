// Oynatıcının kalıcı "oynatılamıyor" durumu. Hata izleyiciye özeldir (ortak videoyu değiştirmez);
// ölümcül türlerde (network/unsupported/decode) yeniden play()/seek ve tamponlama bildirimi durur.

export type PlaybackFailureKind = "autoplay" | "network" | "unsupported" | "decode";

/** Gösterilecek metin `FAILURE_MESSAGES[kind]`'dan türetilir (tek kaynak). */
export interface PlaybackFailure {
  kind: PlaybackFailureKind;
}

export const FAILURE_MESSAGES: Record<PlaybackFailureKind, string> = {
  autoplay: "Oynatmayı başlatmak için tıkla.",
  network: "Video yüklenemedi.",
  unsupported: "Bu video bu tarayıcıda oynatılamıyor. Dosya biçimi veya codec desteklenmiyor olabilir.",
  decode: "Video çözümlenemedi; dosya bozuk veya codec/profil uyumsuz olabilir.",
};

export const MKV_HINT = "MKV desteği tarayıcıya bağlıdır: Chrome/Edge çoğu MKV'yi oynatır, Firefox kısıtlıdır, Safari oynatmaz.";

/** Oynatma hatasının izleyiciye gösterilecek metni; MKV bağlantısında tarayıcı ipucu eklenir. Bilinmeyen kod "network" sayılır. */
export function playbackMessage(code: number | undefined, url: string): string {
  const kind = classifyMediaError(code) ?? "network";
  const isMkv = /\.mkv$/i.test(url.split(/[?#]/)[0]);
  return isMkv && kind !== "network" ? `${FAILURE_MESSAGES[kind]} ${MKV_HINT}` : FAILURE_MESSAGES[kind];
}

/** `MediaError.code`'u türe çevirir: 2 network, 3 decode, 4 unsupported; 1 (aborted) ve bilinmeyen null. */
export function classifyMediaError(code: number | undefined): PlaybackFailureKind | null {
  switch (code) {
    case 2:
      return "network";
    case 3:
      return "decode";
    case 4:
      return "unsupported";
    default:
      return null;
  }
}
