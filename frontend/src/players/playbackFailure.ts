// Oynatıcının kalıcı "oynatılamıyor" durumu. Hata izleyiciye özeldir (ortak videoyu değiştirmez);
// ölümcül türlerde (network/unsupported/decode) yeniden play()/seek ve tamponlama bildirimi durur.

export type PlaybackFailureKind = "autoplay" | "network" | "unsupported" | "decode";

export interface PlaybackFailure {
  kind: PlaybackFailureKind;
  message: string;
}

export const FAILURE_MESSAGES: Record<PlaybackFailureKind, string> = {
  autoplay: "Oynatmayı başlatmak için tıkla.",
  network: "Video yüklenemedi.",
  unsupported: "Bu video bu tarayıcıda oynatılamıyor. Dosya biçimi veya codec desteklenmiyor olabilir.",
  decode: "Video çözümlenemedi; dosya bozuk veya codec/profil uyumsuz olabilir.",
};

/** `MediaError.code`'u türe çevirir: 2 network, 3 decode, 4 unsupported; 1 (aborted) ve bilinmeyen null. */
export function classifyMediaError(_code: number | undefined): PlaybackFailureKind | null {
  throw new Error("Uygulama fazında yazılacak (T20261029-23)");
}
