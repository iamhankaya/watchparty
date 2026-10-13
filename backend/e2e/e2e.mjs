import * as signalR from "@microsoft/signalr";
const BASE = process.env.BASE_URL ?? "http://localhost:5205";
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function client(name) {
  const conn = new signalR.HubConnectionBuilder().withUrl(BASE + "/hubs/lobby").configureLogging(signalR.LogLevel.None).build();
  const ev = { participants: [], playback: [], mode: [], chat: [], history: [], host: [], typing: [] };
  conn.on("ParticipantsChanged", l => ev.participants.push(l));
  conn.on("PlaybackUpdated", s => ev.playback.push(s));
  conn.on("ControlModeChanged", m => ev.mode.push(m));
  conn.on("ChatMessage", m => ev.chat.push(m));
  conn.on("ChatHistory", h => ev.history.push(h));
  conn.on("HostChanged", n => ev.host.push(n));
  conn.on("UserTyping", (id, nick) => ev.typing.push({ id, nick }));
  await conn.start();
  return { conn, ev, name };
}
const err = async p => { try { await p; return null; } catch (e) { return e.message; } };
const create = async body => (await fetch(BASE + "/api/lobbies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

// REST
const h = await (await fetch(BASE + "/api/health")).json();
ok(h.status === "ok" && typeof h.serverTime === "number", "health");
ok((await create({})).status === 400, "POST without clientId -> 400");
const { code } = await (await create({ clientId: "host-1" })).json();
ok(/^[A-HJ-NP-Z2-9]{6}$/.test(code), "lobby code format " + code);
ok((await fetch(BASE + "/api/lobbies/" + code.toLowerCase())).status === 200, "GET lowercase code");
ok((await fetch(BASE + "/api/lobbies/ZZZZZZ")).status === 404, "GET unknown -> 404");

// join
const host = await client("Ali"), guest = await client("Ayse");
ok((await err(host.conn.invoke("JoinLobby", code, "   ", "x"))) !== null, "blank nickname rejected");
ok((await err(host.conn.invoke("JoinLobby", "ZZZZZZ", "Ali", "host-1")))?.includes("bulunamadı"), "unknown lobby rejected");
const hr = await host.conn.invoke("JoinLobby", code, "Ali", "host-1");
ok(hr.isHost === true && hr.selfId, "host JoinResult isHost");
const gr = await guest.conn.invoke("JoinLobby", code, "Ayse", "guest-1");
ok(gr.isHost === false, "guest JoinResult not host");
await sleep(200);
const lastP = host.ev.participants.at(-1);
ok(lastP.length === 2 && lastP[0].nickname === "Ali" && lastP[0].isHost && !lastP[1].isHost && !("clientId" in lastP[0]), "participants list with isHost, no clientId");
ok(guest.ev.mode.at(-1) === false && guest.ev.playback.length === 1 && guest.ev.history.length === 1, "joiner gets snapshot");
ok((await err(guest.conn.invoke("JoinLobby", code, "Ayse", "guest-1")))?.includes("zaten"), "double join rejected");

// playback
ok((await err(guest.conn.invoke("Play", 0)))?.includes("medya"), "play without media rejected");
ok((await err(host.conn.invoke("SetMedia", "vimeo", "x"))) !== null, "bad media type rejected");
await host.conn.invoke("SetMedia", "youtube", "dQw4w9WgXcQ");
await guest.conn.invoke("Play", 30);
await sleep(200);
let s = host.ev.playback.at(-1);
ok(s.isPlaying && s.positionSec === 30 && s.mediaId === "dQw4w9WgXcQ", "guest can play in everyone mode");
ok((await err(guest.conn.invoke("Seek", -5))) !== null, "negative seek rejected");

// control mode
ok((await err(guest.conn.invoke("SetControlMode", true)))?.includes("host"), "guest cannot change mode");
await host.conn.invoke("SetControlMode", true);
await sleep(100);
ok(guest.ev.mode.at(-1) === true, "mode broadcast");
ok((await err(guest.conn.invoke("Pause", 31)))?.includes("Sadece host"), "guest blocked in host-only");
await host.conn.invoke("Pause", 31);
await sleep(100);
ok(guest.ev.playback.at(-1).isPlaying === false, "host can pause");

// hostOnly at creation
const r2 = await (await create({ clientId: "h2", hostOnlyControl: true })).json();
const c2 = await client("x");
await c2.conn.invoke("JoinLobby", r2.code, "X", "other");
await sleep(100);
ok(c2.ev.mode.at(-1) === true, "hostOnlyControl at creation");
await c2.conn.stop();

// chat
await guest.conn.invoke("SendChat", "  merhaba  ");
await sleep(100);
ok(host.ev.chat.at(-1)?.text === "merhaba" && host.ev.chat.at(-1).nickname === "Ayse", "chat broadcast with server nickname");
ok((await err(guest.conn.invoke("SendChat", "x".repeat(501)))) !== null, "long chat rejected");
const late = await client("Can");
await late.conn.invoke("JoinLobby", code, "Can", "guest-2");
await sleep(100);
ok(late.ev.history.at(-1).length === 1 && late.ev.history.at(-1)[0].text === "merhaba", "late joiner gets chat history");

// ping
const t0 = Date.now(); const sn = await host.conn.invoke("Ping"); const t1 = Date.now();
ok(Math.abs(sn - (t0 + t1) / 2) < 1000, "ping offset sane (rtt " + (t1 - t0) + "ms)");

// rebroadcast
const before = late.ev.playback.length;
await sleep(10500);
ok(late.ev.playback.length > before, "periodic playback rebroadcast");

// host refresh within grace keeps host
await host.conn.stop();
await sleep(1500);
const host2 = await client("Ali2");
const hr2 = await host2.conn.invoke("JoinLobby", code, "Ali", "host-1");
ok(hr2.isHost === true, "host refresh within grace keeps host");
await sleep(11000);
ok(guest.ev.host.length === 0, "no host transfer after quick refresh");

// host leaves for good -> transfer to oldest (Ayse)
await host2.conn.stop();
await sleep(12000);
ok(guest.ev.host.at(-1) === "Ayse", "host transferred to oldest after grace");
ok((await err(guest.conn.invoke("Play", 40))) === null, "new host can control");
ok((await err(late.conn.invoke("Play", 41)))?.includes("Sadece host"), "others still blocked");
await guest.conn.stop(); await late.conn.stop();

// altyazı
const { code: c4 } = await (await create({ clientId: "h4" })).json();
const sh = await client("Host"), sg = await client("Misafir");
await sh.conn.invoke("JoinLobby", c4, "Host", "h4");
await sg.conn.invoke("JoinLobby", c4, "Misafir", "g4");
ok((await err(sh.conn.invoke("SetSubtitle", "https://example.com/a.srt")))?.includes("medya"), "subtitle without media rejected");
await sh.conn.invoke("SetMedia", "youtube", "dQw4w9WgXcQ");
ok((await err(sh.conn.invoke("SetSubtitle", "https://example.com/a.srt")))?.includes("yalnızca MP4"), "subtitle on YouTube rejected");
await sh.conn.invoke("SetMedia", "file", "https://example.com/a.mp4");
await sh.conn.invoke("SetSubtitle", "https://example.com/a.srt");
await sleep(200);
ok(sg.ev.playback.at(-1)?.subtitleUrl === "https://example.com/a.srt", "subtitleUrl broadcast to other client");
const sl = await client("Gec");
await sl.conn.invoke("JoinLobby", c4, "Gec", "l4");
await sleep(200);
ok(sl.ev.playback.at(-1)?.subtitleUrl === "https://example.com/a.srt", "late joiner gets subtitleUrl");
await sh.conn.invoke("SetMedia", "file", "https://example.com/b.mp4");
await sleep(200);
ok(sg.ev.playback.at(-1)?.subtitleUrl === null, "SetMedia resets subtitle");
for (const c of [sh, sg, sl]) await c.conn.stop();

// yazıyor bildirimi
const { code: cTyp } = await (await create({ clientId: "h5" })).json();
const ta = await client("Yazan"), tb = await client("Izleyen");
const tar = await ta.conn.invoke("JoinLobby", cTyp, "Yazan", "h5");
await tb.conn.invoke("JoinLobby", cTyp, "Izleyen", "g5");
await ta.conn.invoke("Typing");
await sleep(300);
ok(tb.ev.typing.length === 1 && tb.ev.typing[0].id === tar.selfId && tb.ev.typing[0].nick === "Yazan", "Typing -> other client gets UserTyping with caller id and server nickname");
ok(ta.ev.typing.length === 0, "Typing is not echoed to caller");
for (const c of [ta, tb]) await c.conn.stop();

// takılana göre bekleme (host-only lobide; ReportBuffering kontrol eylemi değil)
const { code: c5 } = await (await create({ clientId: "h5", hostOnlyControl: true })).json();
const bh = await client("Host"), ba = await client("Ayse");
await bh.conn.invoke("JoinLobby", c5, "Host", "h5");
await ba.conn.invoke("JoinLobby", c5, "Ayse", "g5");
await bh.conn.invoke("SetMedia", "file", "https://example.com/a.mp4");
ok((await err(ba.conn.invoke("ReportBuffering", true))) === null, "ReportBuffering when paused: no error");
await sleep(200);
ok(bh.ev.playback.at(-1)?.waitingFor?.length === 0, "ReportBuffering when paused ignored");
await bh.conn.invoke("Play", 10);
await sleep(200);
ok((await err(ba.conn.invoke("ReportBuffering", true))) === null, "non-host ReportBuffering accepted in host-only mode");
await sleep(300);
const w1 = bh.ev.playback.at(-1);
ok(w1?.waitingFor?.includes(ba.conn.connectionId), "waitingFor contains the buffering client's id");
await sleep(300);
const w2 = bh.ev.playback.at(-1);
ok(w2.positionSec === w1.positionSec && w2.updatedAt === w1.updatedAt && w1.positionSec >= 10 && w1.isPlaying, "position frozen while waiting (same positionSec and updatedAt)");
ok((await err(ba.conn.invoke("SkipWaiting")))?.includes("Sadece host"), "SkipWaiting by non-host rejected in host-only mode");
await ba.conn.invoke("ReportBuffering", false);
await sleep(300);
const w3 = bh.ev.playback.at(-1);
ok(w3?.waitingFor?.length === 0 && w3.positionSec === w1.positionSec && w3.updatedAt >= w1.updatedAt, "ReportBuffering(false) resumes from frozen position");
await ba.conn.invoke("ReportBuffering", true);
await sleep(200);
await bh.conn.invoke("SkipWaiting");
await sleep(200);
ok(bh.ev.playback.at(-1)?.waitingFor?.length === 0, "host SkipWaiting clears the wait list");
for (const c of [bh, ba]) await c.conn.stop();

// limit 20
const { code: c3 } = await (await create({ clientId: "h3" })).json();
const many = [];
for (let i = 0; i < 20; i++) { const c = await client("u" + i); await c.conn.invoke("JoinLobby", c3, "u" + i, "c" + i); many.push(c); }
const extra = await client("extra");
ok((await err(extra.conn.invoke("JoinLobby", c3, "extra", "cx")))?.includes("dolu"), "21st participant rejected");
const g = await (await fetch(BASE + "/api/lobbies/" + c3)).json();
ok(g.isFull === true && g.participantCount === 20, "GET shows full");
for (const c of [...many, extra]) await c.conn.stop();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
