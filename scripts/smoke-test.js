// End to end on placeholder pictures and a fake Stripe: no API calls, no cost.
// Needs a local Postgres: DATABASE_URL=postgres://... npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import sharp from "sharp";
import { startFakeStripe } from "./fake-stripe.js";

const PORT = 3456, STRIPE = 12111;
const base = `http://localhost:${PORT}`;
const fake = await startFakeStripe(STRIPE);
const child = spawn("node", ["server.js"], {
  stdio: ["ignore", process.env.SMOKE_LOGS ? "inherit" : "ignore", "inherit"],
  env: { ...process.env, PORT, MOCK_IMAGES: "1", MOCK_DELAY_MS: "150", MOCK_FAIL_PAGES: "5", DEV_LOGIN: "1", PGSSL: "0", STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_API_HOST: "localhost", STRIPE_API_PORT: String(STRIPE), STRIPE_API_PROTOCOL: "http", SESSION_SECRET: "x", RENDER: "" },
});
const done = (code) => { child.kill(); fake.server.close(); process.exit(code); };
process.on("uncaughtException", (e) => { console.error(e); done(1); });
process.on("unhandledRejection", (e) => { console.error(e); done(1); });

for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

let cookie = "";
async function call(path, opts = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...opts, headers: { cookie, ...(opts.json ? { "Content-Type": "application/json" } : {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return res;
}
const J = async (path, opts) => { const r = await call(path, opts); return { status: r.status, body: await r.json() }; };

// art
for (let i = 0; i < 300; i++) { const c = await (await fetch(`${base}/catalog.json`)).json(); if (c.art.state === "ready") break; await new Promise((r) => setTimeout(r, 300)); }
const bible = await (await fetch(`${base}/bible.json`)).json();
assert.equal(bible.status.state, "ready");
assert.equal(bible.stories.length, 2);
for (const s of bible.stories) { assert.equal(s.pages.length, 20); assert.ok(s.cast.length >= 5); }
console.log("art ok");

// signed out
assert.equal((await J("/api/books")).status, 401);
await call(`/auth/dev?u=${Date.now()}`);
assert.ok((await J("/api/me")).body.user);

// can't make a book with no money
const photo = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#889" } }).jpeg().toBuffer();
const form = (story) => { const f = new FormData(); f.append("story", story); f.append("name", "Ori"); f.append("likes", "Reading"); f.append("photo", new Blob([photo], { type: "image/jpeg" }), "p.jpg"); return f; };
assert.equal((await J("/api/books", { method: "POST", body: form("jack") })).status, 402);

// fund
const fund = await J("/api/wallet/fund", { method: "POST", json: { cents: 500 } });
assert.equal(fund.status, 200, JSON.stringify(fund.body));
const sid = fund.body.url.split("/").pop();
assert.equal((await J("/api/wallet/confirm", { method: "POST", json: { sessionId: sid } })).body.credited, false, "unpaid isn't credited");
await fake.pay(sid);
assert.equal((await J("/api/wallet/confirm", { method: "POST", json: { sessionId: sid } })).body.credited, true);
assert.equal((await J("/api/wallet/confirm", { method: "POST", json: { sessionId: sid } })).body.credited, false, "credited only once");
assert.equal((await J("/api/wallet")).body.balance, 500);
console.log("fund ok");

// books, both stories
for (const story of ["jack", "red"]) {
  const t = Date.now();
  const { body: { id } } = await J("/api/books", { method: "POST", body: form(story) });
  let b;
  for (let i = 0; i < 200; i++) { b = (await J(`/api/books/${id}`)).body.book; if (b.status !== "running") break; await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(b.status, "done", b.error);
  assert.equal(b.pages.length, 20);
  for (const p of b.pages) {
    const boxes = bible.stories.find((s) => s.key === story).pages[p.n - 1].protected;
    if (p.place.mode === "panel") for (const r of boxes) assert.ok(p.place.box.right <= r.left || p.place.box.left >= r.right || p.place.box.bottom <= r.top || p.place.box.top >= r.bottom, `page ${p.n} words hit ${r.label}`);
  }
  if (story === "jack") {
    const five = b.pages.find((p) => p.n === 5);
    assert.equal(five.attempts.filter((a) => !a.skipped).length, 3, "fails 3 times");
    assert.equal(five.score, 40, "kept the best of 3");
    assert.equal(five.passed, false, "page 5 marked as none passed");
    assert.ok(five.kept >= 1 && five.kept <= 3, "page 5 names the kept try");
  }
  for (const p of b.pages) assert.ok(p.attempts.length >= 1 || p.ahead, `page ${p.n} has an attempt count`);
  assert.ok(b.timing.costUsd > 0, "book cost tracked");
  assert.ok(b.timing.apiCalls.images >= 20 && b.timing.apiCalls.checks >= 20, "image and check calls counted");
  const pdf = await call(`/api/books/${id}/pdf`);
  assert.equal(pdf.status, 200);
  const buf = Buffer.from(await pdf.arrayBuffer());
  fs.mkdirSync("out", { recursive: true }); fs.writeFileSync(`out/${story}.pdf`, buf);
  console.log(story, "book ok in", Date.now() - t, "ms, pdf", buf.length, "bytes, cost $" + b.timing.costUsd);
}
await new Promise((r) => setTimeout(r, 300)); // let the last cost rows land
const costs = (await J("/api/costs")).body;
assert.ok(costs.books >= 2 && costs.avg > 0 && costs.price === 0.99, "average cost per book shown against $0.99");
assert.ok(costs.parts.retries > 0, "retries costed separately");
assert.ok(Math.abs(costs.parts.firstTries + costs.parts.retries + costs.parts.checks - costs.avg) < 0.0005, "the cost parts add up to the average");
console.log("costs ok: average $" + costs.avg.toFixed(3), "over", costs.books, "books");

// Hebrew on the cover and the About Me page, and deleting a book
{
  const f = new FormData(); f.append("story", "red"); f.append("name", "אורי"); f.append("pronoun", "she"); f.append("likes", "לבנות apps"); f.append("photo", new Blob([photo], { type: "image/jpeg" }), "p.jpg");
  const { body: { id } } = await J("/api/books", { method: "POST", body: f });
  let b; for (let i = 0; i < 200; i++) { b = (await J(`/api/books/${id}`)).body.book; if (b.status !== "running") break; await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(b.status, "done", b.error);
  const pdf = await call(`/api/books/${id}/pdf`); assert.equal(pdf.status, 200);
  fs.writeFileSync("out/hebrew.pdf", Buffer.from(await pdf.arrayBuffer()));
  const img = b.pages.find((p) => p.url.startsWith("/img/")).url;
  assert.equal((await J(`/api/books/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(`/api/books/${id}`)).status, 404);
  assert.equal((await call(img)).status, 404, "its pictures go too");
  console.log("hebrew and delete ok");
}

// second login: the books are still there
cookie = cookie; 
const w = (await J("/api/wallet")).body;
assert.equal(w.balance, 500 - 3 * 99);
assert.equal(w.ledger.filter((l) => l.kind === "book").length, 3);
assert.ok(w.ledger.every((l) => l.cause));

// refund
assert.equal((await J("/api/refunds", { method: "POST", json: { paymentId: w.payments[0].id, cents: 99999 } })).status, 400, "can't refund more than the balance");
const r = await J("/api/refunds", { method: "POST", json: { paymentId: w.payments[0].id, cents: 100, reason: "test" } });
assert.equal(r.status, 200); assert.equal(r.body.status, "processed");
const w2 = (await J("/api/wallet")).body;
assert.equal(w2.balance, 500 - 297 - 100);
console.log("refund ok");

// someone else can't see the book or its picture
const id0 = (await J("/api/books")).body.books[0];
const img = id0.pages.find((p) => p.url.startsWith("/img/")).url;
assert.equal((await call(img)).status, 200);
const mine = cookie; cookie = ""; await call(`/auth/dev?u=other${Date.now()}`);
assert.equal((await call(img)).status, 404);
assert.equal((await call(`/api/books/${id0.id}`)).status, 404);
cookie = mine;
console.log("all ok");
done(0);
