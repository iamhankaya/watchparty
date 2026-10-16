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

// Yanıt vermeyen bir uçta smoke süresiz beklemesin: her istek ve bağlantı adımı bu sürede bitmeli.
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 5000;
const timeoutError = step => new Error(`${step}: zaman aşımı, ${TIMEOUT_MS} ms içinde yanıt gelmedi`);
// Süre sınırı gövdenin okunmasını da kapsar (r.json() aynı sinyale bağlı).
const get = (url, init = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(e => {
    throw e?.name === "TimeoutError" ? timeoutError((init.method ?? "GET") + " " + new URL(url).pathname) : e;
  });
const json = r => r.json().catch(e => { throw e?.name === "TimeoutError" ? timeoutError("yanıt gövdesi") : e; });
// SignalR start/invoke/stop AbortSignal almıyor; süreyi yarışla sınırla.
const limit = (step, promise) => {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(timeoutError(step)), TIMEOUT_MS); })])
    .finally(() => clearTimeout(t));
};

await safe("health", async () => {
  const r = await get(BASE + "/api/health");
  const j = r.ok ? await json(r) : null;
  ok(r.status === 200 && j?.status === "ok", "health");
});

await safe("spa deep link", async () => {
  const r = await get(BASE + "/l/ABCDEF");
  ok(r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/html"), "spa deep link");
});

await safe("api 404 korunuyor", async () => {
  ok((await get(BASE + "/api/lobbies/ZZZZZZ")).status === 404, "api 404 korunuyor");
});

if (BASE.startsWith("https://")) {
  await safe("csp header", async () => {
    const csp = (await get(BASE + "/")).headers.get("content-security-policy") ?? "";
    ok(csp.includes("frame-src https://www.youtube.com"), "csp header");
  });
} else skip("csp header");

await safe("hub sohbet", async () => {
  const create = await get(BASE + "/api/lobbies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: "smoke-host" }) });
  if (!create.ok) throw new Error("POST /api/lobbies " + create.status);
  const { code } = await json(create);
  // SignalR'ın kendi HTTP süre sınırı biraz daha uzun: önce limit() Türkçe hatayla düşer, asılı istek de ardından iptal edilir.
  const mk = () => new signalR.HubConnectionBuilder().withUrl(BASE + "/hubs/lobby", { timeout: TIMEOUT_MS + 1000 }).configureLogging(signalR.LogLevel.None).build();
  const a = mk(), b = mk();
  try {
    const got = new Promise(res => b.on("ChatMessage", m => res(m)));
    await limit("A bağlantısı", a.start()); await limit("B bağlantısı", b.start());
    await limit("A JoinLobby", a.invoke("JoinLobby", code, "SmokeA", "smoke-host"));
    await limit("B JoinLobby", b.invoke("JoinLobby", code, "SmokeB", "smoke-guest"));
    await limit("SendChat", a.invoke("SendChat", "smoke"));
    const m = await Promise.race([got, new Promise(res => setTimeout(() => res(null), 3000))]);
    ok(m !== null && JSON.stringify(m).includes("smoke"), "hub sohbet");
  } finally {
    await limit("A kapanışı", a.stop()).catch(() => {}); await limit("B kapanışı", b.stop()).catch(() => {});
  }
});

if (ORIGIN) {
  let reachable = true;
  try { await get(ORIGIN + "/api/health"); } catch { reachable = false; }
  ok(!reachable, "origin kapalı");
} else skip("origin kapalı");

console.log(`\n${pass} geçti, ${fail} kaldı`);
process.exit(fail > 0 ? 1 : 0);
