import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Player } from "../players/Player";
import type { ServerClock } from "./clock";
import { SyncEngine } from "./sync";
import { expectedPosition, type PlaybackState } from "./types";

const T0 = 1_000_000;

/** Elle yönetilen sahte oynatıcı: zaman ilerlemez, durumu testler belirler. */
class FakePlayer implements Player {
  readonly supportsRate = true;
  time = 10;
  playing = true;
  buffering = false;
  playResult = true;
  seek = vi.fn((sec: number) => {
    this.time = sec;
  });
  pause = vi.fn(() => {
    this.playing = false;
  });
  setRate = vi.fn();
  isReady = () => true;
  play = vi.fn(async () => {
    if (this.playResult) this.playing = true;
    return this.playResult;
  });
  getTime = () => this.time;
  getDuration = () => 1000;
  isPlaying = () => this.playing;
  isBuffering = () => this.buffering;
  setVolume = () => {};
}

const clock = { now: () => Date.now() } as ServerClock;

function state(over: Partial<PlaybackState> = {}): PlaybackState {
  return {
    mediaType: "file",
    mediaId: "https://example.com/a.mp4",
    isPlaying: true,
    positionSec: 10,
    updatedAt: Date.now(),
    subtitleUrl: null,
    waitingFor: [],
    ...over,
  };
}

describe("expectedPosition", () => {
  test("bekleme yokken oynuyorsa zaman ilerler", () => {
    const s = state({ positionSec: 10, updatedAt: 0 });
    expect(expectedPosition(s, 2000)).toBe(12);
  });

  test("bekleniyorken konum donar", () => {
    const s = state({ positionSec: 10, updatedAt: 0, waitingFor: ["x"] });
    expect(expectedPosition(s, 5000)).toBe(10);
  });

  test("duraklatılmışsa konum sabit", () => {
    const s = state({ isPlaying: false, positionSec: 7, updatedAt: 0 });
    expect(expectedPosition(s, 5000)).toBe(7);
  });
});

describe("SyncEngine bekleme", () => {
  let player: FakePlayer;
  let onBlocked: ReturnType<typeof vi.fn>;
  let onBuffering: ReturnType<typeof vi.fn>;
  let engine: SyncEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    player = new FakePlayer();
    onBlocked = vi.fn();
    onBuffering = vi.fn();
    engine = new SyncEngine(clock, onBlocked, onBuffering);
    engine.setSelfId("me");
    engine.setPlayer(player);
    engine.setState(state());
    engine.start();
  });

  afterEach(() => {
    engine.stop();
    vi.useRealTimers();
  });

  /** Oynatıcının konumunu sunucunun beklediği yerde tutarak zamanı ilerletir. */
  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  test("900 ms takılma bildirilmez", async () => {
    player.buffering = true;
    await advance(900);
    expect(onBuffering).not.toHaveBeenCalled();
  });

  test("1 sn'yi geçen takılma bir kez bildirilir", async () => {
    player.buffering = true;
    // Takılma 500 ms'lik tick'le örneklenir: ilk görüldüğü tick'ten (500) 1 sn sonra (1500) bildirilir.
    await advance(1000);
    expect(onBuffering).not.toHaveBeenCalled();
    await advance(500);
    expect(onBuffering).toHaveBeenCalledTimes(1);
    expect(onBuffering).toHaveBeenCalledWith(true);
    await advance(3000);
    expect(onBuffering).toHaveBeenCalledTimes(1);
  });

  test("kesintili takılma sayacı sıfırlar", async () => {
    player.buffering = true;
    await advance(500);
    player.buffering = false;
    await advance(500);
    player.buffering = true;
    await advance(500);
    expect(onBuffering).not.toHaveBeenCalled();
  });

  test("otomatik oynatma engelliyken bildirilmez", async () => {
    player.playing = false;
    player.playResult = false;
    player.buffering = true;
    await advance(3000);
    expect(onBlocked).toHaveBeenCalledWith(true);
    expect(onBuffering).not.toHaveBeenCalled();
  });

  test("duraklatılmışken bildirilmez", async () => {
    engine.setState(state({ isPlaying: false }));
    player.buffering = true;
    await advance(3000);
    expect(onBuffering).not.toHaveBeenCalled();
  });

  test("kendi beklemesinde seek, hız düzeltmesi ve pause yapılmaz; yetişince bir kez false", async () => {
    player.buffering = true;
    await advance(1500);
    expect(onBuffering).toHaveBeenCalledWith(true);

    // Sunucu beni listeye aldı ve konumu 13'te dondurdu; ben 10'da kaldım (3 sn uzak).
    engine.setState(state({ positionSec: 13, waitingFor: ["me"] }));
    player.seek.mockClear();
    player.setRate.mockClear();
    await advance(3000);
    expect(player.seek).not.toHaveBeenCalled();
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.setRate).not.toHaveBeenCalledWith(1.05);
    expect(player.setRate).not.toHaveBeenCalledWith(0.95);

    player.buffering = false;
    player.time = 13; // yüklendi ve donmuş konuma yetişti
    await advance(500);
    expect(onBuffering).toHaveBeenCalledTimes(2);
    expect(onBuffering).toHaveBeenLastCalledWith(false);
    await advance(2000);
    expect(onBuffering).toHaveBeenCalledTimes(2);
  });

  test("başkası beklenirken pause çağrılır ve hedef donar", async () => {
    engine.setState(state({ positionSec: 10, waitingFor: ["other"] }));
    expect(player.pause).toHaveBeenCalled();
    await advance(5000);
    // Hedef 10'da donmuş olmasaydı 5 sn'lik sapma seek'e yol açardı.
    expect(player.seek).not.toHaveBeenCalled();
    expect(onBuffering).not.toHaveBeenCalled();
  });

  test("oynatıcı değişince sayaç sıfırlanır", async () => {
    player.buffering = true;
    await advance(800); // eski sayaç 500'de başladı, sıfırlanmasa 1500'de bildirirdi
    const next = new FakePlayer();
    next.buffering = true;
    engine.setPlayer(next); // sayaç 800'de yeniden başlar
    await advance(900);
    expect(onBuffering).not.toHaveBeenCalled();
    await advance(500);
    expect(onBuffering).toHaveBeenCalledTimes(1);
  });

  test("medya değişince sayaç sıfırlanır", async () => {
    player.buffering = true;
    await advance(800); // eski sayaç 500'de başladı, sıfırlanmasa 1500'de bildirirdi
    engine.setState(state({ mediaId: "https://example.com/b.mp4" })); // sayaç 800'de yeniden başlar
    await advance(900);
    expect(onBuffering).not.toHaveBeenCalled();
    await advance(600);
    expect(onBuffering).toHaveBeenCalledTimes(1);
  });

  test("başkasının yayını öne geçse de yetişince bir kez false gönderilir", async () => {
    player.buffering = true;
    await advance(1500);
    expect(onBuffering).toHaveBeenCalledWith(true);

    // Önce yalnızca başkası listede (bizim bildirimimiz henüz işlenmedi): dururuz.
    engine.setState(state({ positionSec: 10, waitingFor: ["other"] }));
    await advance(500);
    // Sonra biz de listedeyiz: oynamaya devam edip yükleriz.
    engine.setState(state({ positionSec: 10, waitingFor: ["other", "me"] }));
    player.buffering = false;
    await advance(2000);
    expect(onBuffering.mock.calls.filter(([b]) => b === false)).toHaveLength(1);
    expect(onBuffering).toHaveBeenCalledTimes(2);
  });

  test("kendi beklemesinde donmuş konuma yetişmeden false gönderilmez", async () => {
    player.buffering = true;
    await advance(1500);
    engine.setState(state({ positionSec: 13, waitingFor: ["me"] }));
    player.buffering = false;
    player.time = 12; // oynuyor ama 1 sn geride
    await advance(1000);
    expect(onBuffering).toHaveBeenCalledTimes(1);

    player.time = 12.8;
    await advance(500);
    expect(onBuffering).toHaveBeenCalledTimes(2);
    expect(onBuffering).toHaveBeenLastCalledWith(false);
    await advance(2000);
    expect(onBuffering).toHaveBeenCalledTimes(2);
  });

  test("sunucunun yok saydığı bildirim tekrarlanmaz, yetişince en fazla bir false", async () => {
    player.buffering = true;
    await advance(1500);
    await advance(3000); // waitingFor'da hiç görünmüyoruz
    expect(onBuffering).toHaveBeenCalledTimes(1);
    expect(onBuffering).toHaveBeenCalledWith(true);

    player.buffering = false;
    await advance(2000);
    expect(onBuffering.mock.calls.filter(([b]) => b === true)).toHaveLength(1);
    expect(onBuffering.mock.calls.filter(([b]) => b === false).length).toBeLessThanOrEqual(1);
  });
});
