// smoke.mjs'nin yanıt vermeyen uçlarda süresiz beklemediğini doğrular.
// Çalıştırma: backend/e2e içinde `npm run test:smoke`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";

const SMOKE = fileURLToPath(new URL("../smoke.mjs", import.meta.url));
const MAX_MS = 30_000;   // smoke bu sürede bitmeli
const KILL_MS = 45_000;  // takılırsa test burada smoke'u öldürür

const listen = server => new Promise(res => server.listen(0, "127.0.0.1", () => res(server.address().port)));

// Bağlantıları açık tutar, hiç yanıt yazmaz; kapanışta soketleri de yok eder.
function track(server) {
  const sockets = new Set();
  server.on("connection", s => {
    sockets.add(s);
    s.on("error", () => {}); // smoke öldürülünce gelen ECONNRESET testi düşürmesin
    s.on("close", () => sockets.delete(s));
  });
  return () => new Promise(res => { for (const s of sockets) s.destroy(); server.close(() => res()); });
}

function runSmoke(baseUrl) {
  return new Promise(res => {
    const started = Date.now();
    const child = spawn(process.execPath, [SMOKE], {
      env: { ...process.env, BASE_URL: baseUrl, ORIGIN_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, KILL_MS);
    child.on("exit", code => { clearTimeout(timer); res({ code, killed, ms: Date.now() - started, out }); });
  });
}

function assertBoundedFailure(r) {
  assert.ok(!r.killed, `smoke ${KILL_MS} ms içinde bitmedi (takıldı). Çıktı:\n${r.out}`);
  assert.ok(r.ms <= MAX_MS, `smoke ${r.ms} ms sürdü, sınır ${MAX_MS} ms. Çıktı:\n${r.out}`);
  assert.notEqual(r.code, 0, `smoke 0 ile çıktı. Çıktı:\n${r.out}`);
}

test("hiç yanıt vermeyen sunucuda smoke sınırlı sürede hata koduyla biter", { timeout: KILL_MS + 10_000 }, async () => {
  const server = createServer(() => {}); // bağlantıyı kabul et, hiçbir şey yazma
  const close = track(server);
  const port = await listen(server);
  try {
    const r = await runSmoke(`http://127.0.0.1:${port}`);
    assertBoundedFailure(r);
    assert.match(r.out, /FAIL health .*zaman aşımı/, `health satırı zaman aşımını söylemiyor. Çıktı:\n${r.out}`);
  } finally {
    await close();
  }
});

test("hub bağlantısı yanıt vermezse smoke hangi adımın takıldığını yazar", { timeout: KILL_MS + 10_000 }, async () => {
  // REST uçları yanıt verir, /hubs/ altındaki istekler (negotiate) hiç yanıtlanmaz.
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/hubs/")) return;
    if (req.url === "/api/health") return res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    if (req.method === "POST" && req.url === "/api/lobbies")
      return res.writeHead(200, { "content-type": "application/json" }).end('{"code":"ABCDEF"}');
    if (req.url.startsWith("/api/")) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html>");
  });
  const close = track(server);
  const port = await listen(server);
  try {
    const r = await runSmoke(`http://127.0.0.1:${port}`);
    assertBoundedFailure(r);
    assert.match(r.out, /PASS health/, `REST kontrolleri geçmeliydi. Çıktı:\n${r.out}`);
    assert.match(r.out, /FAIL hub sohbet .*bağlantı.*zaman aşımı/, `hub satırı takılan adımı söylemiyor. Çıktı:\n${r.out}`);
  } finally {
    await close();
  }
});
