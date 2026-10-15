import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LobbyEvents } from "./connection";
import { mockApi, MockLobbyConnection } from "./mock";
import type { VoiceMember } from "./types";

// Mock'un sesli sohbet kuralları hub ile aynı olmalı (LobbyHub.JoinVoice/LeaveVoice/SetVoiceMuted/VoiceSignal).
// Tarayıcı yerine localStorage ve window sahtesi; BroadcastChannel Node'da yerleşik.

interface Log {
  members: VoiceMember[][];
  signals: [string, string, string][];
}

function events(log: Log): LobbyEvents {
  const noop = () => {};
  return {
    participantsChanged: noop,
    playbackUpdated: noop,
    controlModeChanged: noop,
    hostChanged: noop,
    chatHistory: noop,
    chatMessage: noop,
    bufferingIgnored: noop,
    userTyping: noop,
    joined: noop,
    statusChanged: noop,
    connectionLost: noop,
    voiceMembersChanged: (m) => log.members.push(m),
    voiceSignal: (from, kind, payload) => log.signals.push([from, kind, payload]),
  };
}

const conns: MockLobbyConnection[] = [];
async function client(code: string, nick: string) {
  const log: Log = { members: [], signals: [] };
  const conn = new MockLobbyConnection(events(log));
  conns.push(conn);
  const { selfId } = await conn.join(code, nick, `c-${nick}`);
  // join() o anki sesli üye listesini gönderir; testler sonraki yayınlara baktığı için ayrı tutulur.
  const initialMembers = log.members.splice(0);
  return { conn, log, selfId, initialMembers };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 0,
    clearInterval() {},
  });
});

afterEach(async () => {
  for (const c of conns.splice(0)) await c.stop();
  vi.unstubAllGlobals();
});

describe("MockLobbyConnection sesli sohbet", () => {
  it("lobiye katılmadan JoinVoice hata verir", async () => {
    const conn = new MockLobbyConnection(events({ members: [], signals: [] }));
    conns.push(conn);
    await expect(conn.joinVoice()).rejects.toThrow("Önce bir lobiye katıl");
  });

  it("katılma yayınlanır, tekrar katılma aynı sonucu döner ve listeyi yeniden yayınlar", async () => {
    const code = await mockApi.createLobby("c-A", false);
    const a = await client(code, "A");
    const b = await client(code, "B");
    const r = await a.conn.joinVoice();
    expect(r.members).toEqual([{ id: a.selfId, nickname: "A", muted: false }]);
    expect(r.iceServers).toEqual([{ urls: ["stun:stun.l.google.com:19302"] }]);
    await tick();
    expect(a.log.members).toHaveLength(1);
    expect(b.log.members).toEqual([[{ id: a.selfId, nickname: "A", muted: false }]]);

    const again = await a.conn.joinVoice();
    expect(again.members).toEqual(r.members);
    await tick();
    // Hub gibi: listesi bayatlamış istemciler düzelsin diye tekrar katılmada da yayın yapılır.
    expect(a.log.members).toHaveLength(2);
    expect(b.log.members).toEqual([r.members, r.members]);
  });

  it("lobiye sonradan katılan, o anki sesli üye listesini hemen alır", async () => {
    const code = await mockApi.createLobby("c-A", false);
    const a = await client(code, "A");
    expect(a.initialMembers).toEqual([[]]);
    const b = await client(code, "B");
    await a.conn.joinVoice();
    await b.conn.joinVoice();
    await b.conn.setVoiceMuted(true);
    const c = await client(code, "C");
    expect(c.initialMembers).toEqual([
      [
        { id: a.selfId, nickname: "A", muted: false },
        { id: b.selfId, nickname: "B", muted: true },
      ],
    ]);
    // C'nin sinyal üyelik kontrolü de bu listeyi bilir: C katılınca A'ya sinyal gönderebilir.
    await c.conn.joinVoice();
    await tick();
    await c.conn.voiceSignal(a.selfId, "offer", '{"sdp":"c"}');
    await tick();
    expect(a.log.signals).toEqual([[c.selfId, "offer", '{"sdp":"c"}']]);
  });

  it("7. kişiye 'Sesli sohbet dolu'", async () => {
    const code = await mockApi.createLobby("c-0", false);
    const clients = [];
    for (let i = 0; i < 7; i++) clients.push(await client(code, `K${i}`));
    for (const c of clients.slice(0, 6)) await c.conn.joinVoice();
    await expect(clients[6].conn.joinVoice()).rejects.toThrow("Sesli sohbet dolu");
  });

  it("sessize alma değişince yayınlanır; aynı değer ya da üye değilse ayrılma/sessize alma sessizdir", async () => {
    const code = await mockApi.createLobby("c-A", false);
    const a = await client(code, "A");
    const b = await client(code, "B");
    await b.conn.leaveVoice();
    await b.conn.setVoiceMuted(true);
    await a.conn.joinVoice();
    await a.conn.setVoiceMuted(false); // zaten açık
    await a.conn.setVoiceMuted(true);
    await a.conn.setVoiceMuted(true); // değişmedi
    await tick();
    expect(b.log.members.map((m) => m[0]?.muted)).toEqual([false, true]);
    await a.conn.leaveVoice();
    await tick();
    expect(b.log.members.at(-1)).toEqual([]);
  });

  it("sinyal yalnızca hedef sekmeye ve yalnızca iki taraf da üyeyken iletilir", async () => {
    const code = await mockApi.createLobby("c-A", false);
    const a = await client(code, "A");
    const b = await client(code, "B");
    const c = await client(code, "C");
    await a.conn.joinVoice();
    await a.conn.voiceSignal(b.selfId, "offer", "{}"); // B üye değil: düşer
    await b.conn.joinVoice();
    await a.conn.voiceSignal(b.selfId, "offer", '{"sdp":"x"}');
    await c.conn.voiceSignal(a.selfId, "offer", "{}"); // C üye değil: düşer
    await a.conn.voiceSignal(a.selfId, "offer", "{}"); // kendine: düşer
    await tick();
    expect(b.log.signals).toEqual([[a.selfId, "offer", '{"sdp":"x"}']]);
    expect(a.log.signals).toEqual([]);
    expect(c.log.signals).toEqual([]);
  });

  it("geçersiz tür ve çok büyük sinyal hata verir (üyelikten bağımsız)", async () => {
    const code = await mockApi.createLobby("c-A", false);
    const a = await client(code, "A");
    await expect(a.conn.voiceSignal("x", "bye" as never, "{}")).rejects.toThrow("Geçersiz ses sinyali");
    await expect(a.conn.voiceSignal("x", "offer", "a".repeat(16385))).rejects.toThrow("Ses sinyali çok büyük");
    await expect(a.conn.voiceSignal("x", "offer", "a".repeat(16384))).resolves.toBeUndefined();
  });

  it("bağlantıyı kapatan üye listeden çıkar ve diğerlerine yayınlanır", async () => {
    const code = await mockApi.createLobby("c-A", false);
    const a = await client(code, "A");
    const b = await client(code, "B");
    await a.conn.joinVoice();
    await b.conn.joinVoice();
    await a.conn.stop();
    await tick();
    expect(b.log.members.at(-1)).toEqual([{ id: b.selfId, nickname: "B", muted: false }]);
  });
});
