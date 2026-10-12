// CloudFront Function (spa-rewrite.js) testleri: node --test "infra/tests/*.test.mjs"
// CloudFront Function'lar modül değildir; dosya metni okunup handler çıkarılır.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../spa-rewrite.js", import.meta.url), "utf8");
const handler = new Function(src + "; return handler;")();

function rewrite(uri) {
  return handler({ request: { uri } }).uri;
}

test("/l/ABCDEF -> /index.html", () => {
  assert.equal(rewrite("/l/ABCDEF"), "/index.html");
});

test("/l/ABCDEF/ -> /index.html", () => {
  assert.equal(rewrite("/l/ABCDEF/"), "/index.html");
});

test("/l/abcdef -> /index.html", () => {
  assert.equal(rewrite("/l/abcdef"), "/index.html");
});

test("/ -> /index.html", () => {
  assert.equal(rewrite("/"), "/index.html");
});

test("/assets/index-abc.js değişmez", () => {
  assert.equal(rewrite("/assets/index-abc.js"), "/assets/index-abc.js");
});

test("/theme-init.js değişmez", () => {
  assert.equal(rewrite("/theme-init.js"), "/theme-init.js");
});

test("/favicon.ico değişmez", () => {
  assert.equal(rewrite("/favicon.ico"), "/favicon.ico");
});
