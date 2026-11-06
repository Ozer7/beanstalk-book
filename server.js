import express from "express";
import multer from "multer";
import compression from "compression";
import path from "node:path";
import sharp from "sharp";
import { createRequire } from "node:module";
import { log, httpLog } from "./lib/log.js";
import * as db from "./lib/db.js";
import { setupAuth, requireUser, DEV_LOGIN } from "./lib/auth.js";
import { STORIES } from "./lib/stories.js";
import { normalizePhoto, makeThumb, MOCK } from "./lib/images.js";
import { ensureArt, status as artStatus, storyReady, artOverview, sceneFor } from "./lib/pregen.js";
import { startBook, jobFor } from "./lib/pipeline.js";
import { buildBookPdf } from "./lib/pdf.js";
import { unsupportedChars } from "./lib/layout.js";
import * as wallet from "./lib/wallet.js";

const PORT = process.env.PORT || 3000;
// A safety valve for the shared test card: it's free money, but images aren't free.
const BOOKS_PER_USER_PER_DAY = Number(process.env.BOOKS_PER_USER_PER_DAY) || 10;
const BOOKS_PER_DAY = Number(process.env.BOOKS_PER_DAY) || 60;

await db.migrate();

const app = express();
app.use(compression({ filter: (req, res) => (req.path.endsWith("/events") ? false : compression.filter(req, res)) }));
app.use(httpLog);

// ---------------------------------------------------------------------------
// Public and instant: nothing here touches sessions or waits on the database.
// ---------------------------------------------------------------------------
app.get("/healthz", (_req, res) => res.send("ok"));
const require = createRequire(import.meta.url);
for (const pkg of ["andika", "fraunces"]) {
  const dir = path.dirname(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-700-normal.woff2`));
  app.use(`/fonts/${pkg}`, express.static(dir, { maxAge: "30d", immutable: true }));
}
app.use(express.static("public", { index: "index.html", maxAge: "5m" }));
app.get("/bible", (_req, res) => res.sendFile(path.resolve("public/bible.html")));
app.get("/privacy", (_req, res) => res.sendFile(path.resolve("public/privacy.html")));

// The stories, for the page itself. Cover art comes straight from memory.
app.get("/catalog.json", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json({
    mock: MOCK,
    devLogin: DEV_LOGIN,
    art: { state: artStatus.state, done: artStatus.done, total: artStatus.total },
    stories: Object.values(STORIES).map((s) => {
      const cover = sceneFor(s.key, 1), inside = sceneFor(s.key, 6);
      return { key: s.key, title: s.title, role: s.role, pronoun: s.defaultPronoun, ready: storyReady(s.key), cover: cover ? Number(cover.image_id) : null, inside: inside ? Number(inside.image_id) : null };
    }),
  });
});
app.get("/bible.json", async (_req, res) => {
  try { res.setHeader("Cache-Control", "no-store"); res.json(await artOverview()); } catch (err) { sendError(res, err); }
});
const artCache = new Map();
app.get("/art/:id", async (req, res) => {
  try {
    const key = `${req.params.id}:${req.query.thumb ? 1 : 0}`;
    let img = artCache.get(key);
    if (!img) {
      img = await db.readImage(Number(req.params.id), null, !!req.query.thumb);
      if (!img) return res.status(404).end();
      if (req.query.thumb) artCache.set(key, img);
    }
    res.setHeader("Content-Type", req.query.thumb ? "image/jpeg" : img.mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(img.data);
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// Signed-in.
// ---------------------------------------------------------------------------
setupAuth(app);
app.use(express.json({ limit: "64kb" }));
app.use(["/api", "/img"], (req, res, next) => (req.path === "/me" ? next() : requireUser(req, res, next)));

app.get("/api/me", route(async (req) => {
  if (!req.user) return { user: null };
  return { user: req.user, balance: await wallet.balance(req.user.id), bookCents: wallet.BOOK_CENTS };
}));

app.get("/img/:id(\\d+)", async (req, res) => {
  try {
    const img = await db.readImage(Number(req.params.id), req.user.id, !!req.query.thumb);
    if (!img) return res.status(404).end();
    res.setHeader("Content-Type", req.query.thumb ? "image/jpeg" : img.mime);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(img.data);
  } catch (err) { sendError(res, err); }
});

// A picture as base64 text, small, for checking a book from a machine whose
// network filter blanks out images of people.
app.get("/img/:id.txt", async (req, res) => {
  try {
    const img = await db.readImage(Number(req.params.id), req.user.id, false);
    if (!img) return res.status(404).end();
    const w = Math.min(1024, Number(req.query.w) || 256);
    const out = await sharp(img.data).resize({ width: w }).jpeg({ quality: Number(req.query.q) || 60 }).toBuffer();
    res.type("text/plain").send(out.toString("base64"));
  } catch (err) { sendError(res, err); }
});

// Money ---------------------------------------------------------------------
app.get("/api/wallet", route(async (req) => {
  await wallet.syncOpenPayments(req.user.id);
  return wallet.history(req.user.id);
}));
app.post("/api/wallet/fund", route(async (req) => wallet.startFunding({
  userId: req.user.id, email: req.user.email, cents: Number(req.body?.cents), origin: `${req.protocol}://${req.get("host")}`,
})));
app.post("/api/wallet/confirm", route(async (req) => ({ credited: await wallet.confirmPayment(req.user.id, String(req.body?.sessionId || "")) })));
app.post("/api/refunds", route(async (req) => wallet.requestRefund({
  userId: req.user.id, paymentId: Number(req.body?.paymentId), cents: req.body?.cents == null ? null : Number(req.body.cents), reason: req.body?.reason,
})));

// Books ---------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : httpError(400, "Please upload a PNG, JPEG or WEBP photo."), ok);
  },
});

const FIELDS = { name: 40, age: 20, likes: 60, food: 60, growUp: 60, more: 300 };
function cleanChild(raw = {}, story) {
  const child = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    let v = String(raw[k] ?? "").trim();
    v = k === "more" ? v.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n") : v.replace(/\s+/g, " ");
    child[k] = v.slice(0, max);
  }
  if (!child.name) throw httpError(400, "Type a name for the cover and the About Me page.");
  const bad = unsupportedChars(Object.values(child).join(""));
  if (bad.length) throw httpError(400, `The book's font can't print ${bad.slice(0, 6).join(" ")} yet. Please use English letters.`);
  child.pronoun = ["he", "she", "they"].includes(raw.pronoun) ? raw.pronoun : story.defaultPronoun;
  return child;
}

const bookOut = (b) => ({
  id: b.id, story: b.story, title: STORIES[b.story]?.title, status: b.status, child: b.child, error: b.error, timing: b.timing,
  createdAt: b.created_at, finishedAt: b.finished_at, portrait: b.portrait_id ? Number(b.portrait_id) : null,
  pages: (b.pages || []).map((p) => ({ n: p.n, url: `${p.shared ? "/art" : "/img"}/${p.image}`, text: p.text, place: p.place, score: p.score, attempts: p.attempts, standIn: p.standIn })),
});

app.get("/api/books", route(async (req) => ({ books: (await db.listBooks(req.user.id)).map(bookOut) })));

app.post("/api/books", upload.single("photo"), route(async (req) => {
  const story = STORIES[req.body.story];
  if (!story) throw httpError(400, "Pick a story.");
  if (!storyReady(story.key)) throw httpError(503, "This story's pictures are still being painted. Try again in a few minutes.");
  if (!req.file) throw httpError(400, "Add a photo first.");
  const child = cleanChild(req.body, story);

  const counts = (await db.q(`SELECT count(*) FILTER (WHERE user_id=$1)::int AS mine, count(*)::int AS everyone FROM books WHERE created_at > now() - interval '24 hours'`, [req.user.id])).rows[0];
  if (counts.mine >= BOOKS_PER_USER_PER_DAY) throw httpError(429, `That's ${BOOKS_PER_USER_PER_DAY} books today, the limit for one account. Try again tomorrow.`);
  if (counts.everyone >= BOOKS_PER_DAY) throw httpError(429, "The site has made all its books for today. Try again tomorrow.");

  const photo = await normalizePhoto(req.file.buffer);
  const book = await wallet.chargeForBook({ userId: req.user.id, story: story.key, storyTitle: story.title, child });
  const photoId = await db.saveImage({ userId: req.user.id, bookId: book.id, kind: "photo", buf: photo, thumb: await makeThumb(photo) });
  await db.q(`UPDATE books SET photo_id=$2 WHERE id=$1`, [book.id, photoId]);
  log.info({ event: "book.start", book: book.id, user: req.user.id, story: story.key }, "book started");
  startBook({ book, photo, userId: req.user.id });
  return { id: book.id };
}));

app.get("/api/books/:id", route(async (req) => {
  const b = await db.getBook(req.user.id, Number(req.params.id));
  if (!b) throw httpError(404, "That book isn't yours or doesn't exist.");
  return { book: bookOut(b) };
}));

// Live progress, as server-sent events.
app.get("/api/books/:id/events", async (req, res) => {
  const b = await db.getBook(req.user.id, Number(req.params.id));
  if (!b) return res.status(404).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const job = jobFor(b.id);
  if (!job) { send({ stage: b.status === "done" ? "done" : b.status === "failed" ? "failed" : "lost", label: b.error || "", percent: 100, thumbs: [] }); return res.end(); }
  const onUpdate = (s) => { send(s); if (s.stage === "done" || s.stage === "failed") res.end(); };
  job.events.on("update", onUpdate);
  const ping = setInterval(() => res.write(": ping\n\n"), 10_000);
  req.on("close", () => { clearInterval(ping); job.events.off("update", onUpdate); });
  send(job.snapshot);
});

// The PDF, rebuilt on demand from the pictures in the database, so it's still
// here tomorrow. The last few are kept in memory so a second click is instant.
const pdfCache = new Map();
app.get("/api/books/:id/pdf", async (req, res) => {
  try {
    const b = await db.getBook(req.user.id, Number(req.params.id));
    if (!b) throw httpError(404, "That book isn't yours or doesn't exist.");
    if (b.status !== "done") throw httpError(409, "This book isn't finished.");
    let pdf = pdfCache.get(b.id);
    if (!pdf) {
      const t = Date.now();
      pdf = await buildBookPdf({ story: STORIES[b.story], child: b.child, pages: b.pages, portrait: b.portrait_id, loadImage: (id) => db.imageData(id) });
      log.info({ event: "pdf", book: b.id, ms: Date.now() - t, bytes: pdf.length }, "built PDF");
      pdfCache.set(b.id, pdf);
      if (pdfCache.size > 3) pdfCache.delete(pdfCache.keys().next().value);
    }
    const slug = String(b.child.name || "book").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "book";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${b.story === "jack" ? "jack-and-the-beanstalk" : "little-red-riding-hood"}-${slug}.pdf"`);
    res.send(pdf);
  } catch (err) { sendError(res, err); }
});

app.use((err, _req, res, _next) => sendError(res, err));

// A restart in the middle of a book: the reader isn't charged for it.
const { rows: stranded } = await db.q(`UPDATE books SET status='failed', error='The server restarted while this book was being made. You were not charged.', finished_at=now() WHERE status='running' RETURNING id, user_id`);
for (const b of stranded) await wallet.refundFailedBook({ userId: b.user_id, bookId: b.id }).catch((err) => log.error({ err: err.message }, "refund failed"));

app.listen(PORT, () => log.info({ port: PORT, mock: MOCK }, "Storybook is up"));
ensureArt();

// Render's free plan sleeps after 15 quiet minutes, and waking takes a minute.
// Visiting ourselves through the public address keeps "near-instant" true.
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => fetch(`${process.env.RENDER_EXTERNAL_URL}/healthz`).catch(() => {}), 10 * 60 * 1000).unref();
}

// ---------------------------------------------------------------------------
function route(fn) {
  return async (req, res) => {
    try { res.json(await fn(req)); } catch (err) { sendError(res, err); }
  };
}
function sendError(res, err) {
  if (res.headersSent) return res.end();
  if (err.expose) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  log.error({ err: err.message, status: err.status }, "request failed");
  res.status(500).json({ error: "Something went wrong on the server. Try again." });
}
function httpError(status, message) { return Object.assign(new Error(message), { status, expose: true }); }
