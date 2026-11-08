// ---------------------------------------------------------------------------
// Making one book, in under 60 seconds. The art already exists. Each page with
// the hero gets one fast edit of just the hero's head; all of them run at once,
// and each page runs its own quality loop. Thumbnails go to the browser as each
// page finishes, and everything goes in the database the moment it's done.
// ---------------------------------------------------------------------------
import EventEmitter from "node:events";
import sharp from "sharp";
import * as db from "./db.js";
import { log } from "./log.js";
import { STORIES, pageWords } from "./stories.js";
import { sceneFor } from "./pregen.js";
import { editImage, makeThumb, friendlyError, BOOK_MODEL, BOOK_QUALITY } from "./images.js";
import { facePrompt, portraitPrompt } from "./prompts.js";
import { describePerson, analyseFace } from "./vision.js";
import { blendHead, otherFaces } from "./face.js";
import { bestOfThree } from "./quality.js";
import { placeWords } from "./layout.js";
import { buildBookPdf } from "./pdf.js";
import { refundFailedBook } from "./wallet.js";

const CONCURRENCY = Math.max(1, Number(process.env.IMAGE_CONCURRENCY) || 24);
// All pictures are finished by this mark, which leaves time to save the pages and
// bind the PDF inside 60 seconds. A retry needs about RETRY_MS: most pages are done
// by then, so it runs nearly alone and much faster than the first pass.
const PAGES_DONE_BY_MS = Number(process.env.PAGES_DONE_BY_MS) || 51_000;
const RETRY_MS = Number(process.env.RETRY_MS) || 13_000;

const slots = (() => {
  let free = CONCURRENCY; const waiting = [];
  return {
    acquire() { if (free > 0) { free--; return Promise.resolve(); } return new Promise((r) => waiting.push(r)); },
    release() { const next = waiting.shift(); if (next) next(); else free++; },
  };
})();
const withSlot = async (fn) => { await slots.acquire(); try { return await fn(); } finally { slots.release(); } };

const jobs = new Map(); // bookId -> { events, snapshot }

export const jobFor = (id) => jobs.get(Number(id));

export function startBook({ book, photo, userId }) {
  const job = { events: new EventEmitter(), snapshot: { stage: "reading", label: "Reading your photo", percent: 2, done: 0, total: 20, thumbs: [], elapsedMs: 0 } };
  job.events.setMaxListeners(20);
  jobs.set(book.id, job);
  run({ book, photo, userId, job })
    .catch(async (err) => {
      log.error({ err: err.message, book: book.id }, "book failed");
      const message = friendlyError(err);
      await db.finishBook(book.id, { status: "failed", error: message });
      await refundFailedBook({ userId, bookId: book.id }).catch((e) => log.error({ err: e.message }, "refund of failed book failed"));
      emit(job, { stage: "failed", label: message, percent: 100 });
    })
    .finally(() => setTimeout(() => jobs.delete(book.id), 120_000));
  return job;
}

function emit(job, patch) {
  Object.assign(job.snapshot, patch);
  job.events.emit("update", job.snapshot);
}

async function run({ book, photo, userId, job }) {
  const t0 = Date.now();
  const since = () => Date.now() - t0;
  const story = STORIES[book.story];
  const child = book.child;
  const timing = {};

  // Describing the person takes a couple of seconds. Don't let it hold up the pages.
  const description = await Promise.race([describePerson(photo), new Promise((r) => setTimeout(() => r("the person in the photo"), 6000))]);
  timing.describeMs = since();

  const total = story.pages.length;
  let done = 0, drawing = 0, redoing = 0;
  const say = () => {
    const percent = Math.min(92, 6 + (done / total) * 80);
    let stage = "painting", label = `Painting you into the pages: ${done} of ${total} done`;
    if (redoing > 0 && done + redoing >= total) { stage = "repainting"; label = `Repainting ${redoing} ${redoing === 1 ? "page" : "pages"} that didn't pass the check`; }
    emit(job, { stage, label, percent, done, total, elapsedMs: since() });
  };
  emit(job, { stage: "painting", label: `Painting you into the pages: 0 of ${total} done`, percent: 6, elapsedMs: since() });

  // The portrait for About Me, drawn alongside the pages. Retries can use it too.
  let portraitBuf = null;
  const portraitJob = withSlot(() => bestOfThree({
    make: () => editImage({ images: [photo], prompt: portraitPrompt({ story, description }), model: BOOK_MODEL, quality: BOOK_QUALITY, size: "1024x1024", mock: "portrait" }),
    analyse: async (image) => { portraitBuf = image; return analyseFace(image, photo, { story, page: { mood: "warm, friendly smile" } }); },
    timeLeft: () => PAGES_DONE_BY_MS - since(),
        retryNeeds: RETRY_MS,
    onAttempt: (a) => db.logGen({ userId, bookId: book.id, kind: "portrait", attempt: a.attempt, model: BOOK_MODEL, quality: BOOK_QUALITY, status: a.error ? "failed" : "done", score: a.score, problems: a.problems, error: a.error, ms: a.ms }),
  }));

  const pages = await Promise.all(story.pages.map(async (page) => {
    const scene = sceneFor(story.key, page.n);
    const spec = page.title ? { n: page.n, title: true, text: story.title, starring: child.name } : { n: page.n, text: pageWords(page, child.pronoun) };
    const place = placeWords(spec, scene.protected);
    let image = scene.buf, standIn = false, attempts = [], score = null;

    if (page.hero && scene.head) {
      const { crop, cropped, raw } = scene;
      const out = await bestOfThree({
        make: (attempt, problems) => withSlot(async () => {
          drawing++;
          if (attempt > 1) { redoing++; say(); }
          try {
            const images = [cropped, photo];
            if (attempt > 1 && portraitBuf) images.push(portraitBuf);
            const t = Date.now();
            const generated = await editImage({ images, prompt: facePrompt({ story, page, description, hasPortrait: images.length > 2, problems }), model: BOOK_MODEL, quality: BOOK_QUALITY, size: "1024x1024", mock: `${story.key} ${page.n} ${attempt}` });
            const genMs = Date.now() - t;
            const out = await blendHead({ scene: scene.buf, raw, generated, crop, head: scene.head, W: scene.W, H: scene.H, avoid: otherFaces(scene) });
            return { ...out, genMs, blendMs: Date.now() - t - genMs };
          } finally { drawing--; if (attempt > 1) redoing--; }
        }),
        analyse: (r) => analyseFace(r.blended, photo, { story, page }),
        timeLeft: () => PAGES_DONE_BY_MS - since(),
        retryNeeds: RETRY_MS,
        onAttempt: (a) => db.logGen({ userId, bookId: book.id, kind: "page", story: story.key, page: page.n, attempt: a.attempt, model: BOOK_MODEL, quality: BOOK_QUALITY, status: a.error ? "failed" : "done", score: a.score, problems: a.problems, error: a.error, ms: a.ms }),
      });
      attempts = out.attempts;
      if (out.best) Object.assign(attempts.find((a) => a.attempt === out.best.attempt) || {}, { genMs: out.best.result.genMs, blendMs: out.best.result.blendMs });
      if (out.best) { image = out.best.result.page; score = out.best.check.score; }
      else { standIn = true; log.warn({ book: book.id, page: page.n, err: out.lastError?.message }, "page kept its stand-in hero"); }
    }

    // Pages without the hero share the scene's own stored picture.
    const imageId = image === scene.buf ? Number(scene.image_id)
      : await db.saveImage({ userId, bookId: book.id, kind: "page", page: page.n, buf: image, thumb: await makeThumb(image), meta: { score, attempts } });
    done++;
    const shared = image === scene.buf;
    job.snapshot.thumbs.push({ n: page.n, url: shared ? `/art/${imageId}?thumb=1` : `/img/${imageId}?thumb=1` });
    say();
    return { n: page.n, image: imageId, shared, text: spec.text, place, score, attempts, standIn };
  }));
  timing.pagesMs = since();

  const portraitOut = await portraitJob;
  const portraitImage = portraitOut.best?.result || (await sharp(pages[0] && (await db.imageData(pages[0].image))).extract({ left: 0, top: 0, width: 1024, height: 1024 }).jpeg().toBuffer());
  const portraitId = await db.saveImage({ userId, bookId: book.id, kind: "portrait", buf: portraitImage, thumb: await makeThumb(portraitImage), meta: { attempts: portraitOut.attempts } });
  timing.portraitMs = since();

  emit(job, { stage: "binding", label: "Binding your PDF", percent: 95, elapsedMs: since() });
  pages.sort((a, b) => a.n - b.n);
  const t = Date.now();
  const pdf = await buildBookPdf({ story, child, pages, portrait: portraitId, loadImage: (id) => db.imageData(id) });
  timing.pdfMs = Date.now() - t;
  timing.pdfBytes = pdf.length;
  timing.totalMs = since();
  timing.generations = pages.reduce((s, p) => s + p.attempts.filter((a) => !a.skipped).length, 0);
  timing.retries = pages.reduce((s, p) => s + Math.max(0, p.attempts.filter((a) => !a.skipped).length - 1), 0);
  timing.outOfTime = pages.filter((p) => p.attempts.some((a) => a.skipped)).length;
  timing.model = BOOK_MODEL;
  timing.quality = BOOK_QUALITY;

  await db.finishBook(book.id, { status: "done", pages, timing, portraitId, description });
  log.info({ event: "book.done", book: book.id, user: userId, ...timing }, "book done");
  emit(job, { stage: "done", label: `Your book is ready, in ${(timing.totalMs / 1000).toFixed(0)} seconds`, percent: 100, done: total, elapsedMs: timing.totalMs });
}
