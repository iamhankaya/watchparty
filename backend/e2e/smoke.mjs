// Canlı ortam smoke testi: CloudFront + EC2 uçtan uca çalışıyor mu?
// Üretim limitlerine uygun: tek lobi, iki bağlantı, bir mesaj.
import * as signalR from "@microsoft/signalr";
const BASE = (process.env.BASE_URL ?? "http://localhost:5205").replace(/\/+$/, "");
const ORIGIN = process.env.ORIGIN_URL?.replace(/\/+$/, "");
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name); };
const skip = name => console.log("SKIP " + name);
const safe = async (name, fn) => {
  try { await fn(); } catch (e) { ok(false, name + " (" + (e?.message ?? e) + ")"); }
};

await safe("health", async () => {
  const r = await fetch(BASE + "/api/health");
  const j = r.ok ? await r.json() : null;
  ok(r.status === 200 && j?.status === "ok", "health");
});

await safe("spa deep link", async () => {
  const r = await fetch(BASE + "/l/ABCDEF");
  ok(r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/html"), "spa deep link");
});

await safe("api 404 korunuyor", async () => {
  ok((await fetch(BASE + "/api/lobbies/ZZZZZZ")).status === 404, "api 404 korunuyor");
});

if (BASE.startsWith("https://")) {
  await safe("csp header", async () => {
    const csp = (await fetch(BASE + "/")).headers.get("content-security-policy") ?? "";
    ok(csp.includes("frame-src https://www.youtube.com"), "csp header");
  });
} else skip("csp header");

await safe("hub sohbet", async () => {
  const create = await fetch(BASE + "/api/lobbies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "smoke-host" }) });
  if (!create.ok) throw new Error("POST /api/lobbies " + create.status);
  const { code } = await create.json();
  const mk = () => new signalR.HubConnectionBuilder().withUrl(BASE + "/hubs/lobby").configureLogging(signalR.LogLevel.None).build();
  const a = mk(), b = mk();
  try {
    const got = new Promise(res => b.on("ChatMessage", m => res(m)));
    await a.start(); await b.start();
    await a.invoke("JoinLobby", code, "SmokeA", "smoke-host");
    await b.invoke("JoinLobby", code, "SmokeB", "smoke-guest");
    await a.invoke("SendChat", "smoke");
    const m = await Promise.race([got, new Promise(res => setTimeout(() => res(null), 3000))]);
    ok(m !== null && JSON.stringify(m).includes("smoke"), "hub sohbet");
  } finally {
    await a.stop().catch(() => {}); await b.stop().catch(() => {});
  }
});

if (ORIGIN) {
  let reachable = true;
  try { await fetch(ORIGIN + "/api/health", { signal: AbortSignal.timeout(5000) }); } catch { reachable = false; }
  ok(!reachable, "origin kapalı");
} else skip("origin kapalı");

console.log(`\n${pass} geçti, ${fail} kaldı`);
process.exit(fail > 0 ? 1 : 0);
