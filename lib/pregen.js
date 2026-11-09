// ---------------------------------------------------------------------------
// The pre-generated art: the character bible and every scene of both stories.
// Made once, at startup, stored in the database, and only remade when a prompt
// changes (each row keeps a hash of what made it). Readers never wait for this.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import sharp from "sharp";
import * as db from "./db.js";
import { log } from "./log.js";
import { withMeter } from "./cost.js";
import { STORIES } from "./stories.js";
import { biblePrompt, scenePrompt, trimPrompt } from "./prompts.js";
import { editImage, generateImage, makeThumb, friendlyError, MOCK, SCENE_MODEL, SCENE_QUALITY, BOOK_MODEL } from "./images.js";
import { analyseCharacter, analyseScene } from "./vision.js";
import { bestOfThree } from "./quality.js";
import { PAGE_SIZE } from "./template.js";
import { placeWords } from "./layout.js";
import { locateFaces } from "./locate.js";
import { cropFor, prepareCrop, blendHead, otherFaces } from "./face.js";
import { pageWords } from "./stories.js";

const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const CONCURRENCY = Number(process.env.PREGEN_CONCURRENCY) || 5;
const MAX_CALLS = Number(process.env.PREGEN_MAX) || 200;

export const status = { state: "starting", done: 0, total: 0, calls: 0, error: null, current: [] };
const cache = new Map(); // "story:page" -> scene row + image bytes

export function storyReady(story) {
  return STORIES[story].pages.every((p) => cache.has(`${story}:${p.n}`));
}
export const sceneFor = (story, n) => cache.get(`${story}:${n}`);

// Each story's hero from the character bible, small. The portrait is painted
// with it beside the photo, as the example of this book's style.
const heroLooks = new Map();
export const heroLook = (story) => heroLooks.get(story) || null;

async function loadCache() {
  for (const r of await db.sceneRows()) {
    const buf = await db.imageData(r.image_id);
    await remember({ ...r, buf });
  }
  await loadHeroLooks();
}

async function loadHeroLooks() {
  for (const r of await db.bibleRows()) {
    const story = STORIES[r.story];
    if (!story || r.key !== story.hero || !r.image_id) continue;
    const buf = await db.imageData(r.image_id);
    if (buf) heroLooks.set(r.story, await sharp(buf).resize({ width: 512, height: 512, fit: "inside" }).jpeg({ quality: 85 }).toBuffer());
  }
}

// Everything a book needs for this scene, ready in memory.
async function remember(r) {
  const row = { ...r, W: 1024, H: 1536 };
  if (r.head) {
    row.crop = cropFor(r.head, row.W, row.H);
    Object.assign(row, await prepareCrop(r.buf, row.crop));
  }
  cache.set(`${r.story}:${r.page}`, row);
}

function limiter(n) {
  let running = 0; const queue = [];
  const next = () => { if (running < n && queue.length) { running++; queue.shift()(); } };
  return (fn) => new Promise((resolve, reject) => {
    // bind: run in the caller's context, so its API calls are costed to the right thing
    queue.push(AsyncResource.bind(() => fn().then(resolve, reject).finally(() => { running--; next(); })));
    next();
  });
}

class OutOfBudget extends Error {}

function spend() {
  if (status.calls >= MAX_CALLS) throw new OutOfBudget(`Stopped at PREGEN_MAX (${MAX_CALLS}) image calls.`);
  status.calls++;
}

async function makeCharacter(story, key) {
  const prompt = biblePrompt(story, key);
  const { best, attempts, lastError } = await bestOfThree({
    make: async (attempt, problems) => {
      spend();
      const extra = problems.length ? `\n\nA previous try had these problems, so avoid them: ${problems.join("; ")}.` : "";
      return generateImage({ prompt: prompt + extra, model: SCENE_MODEL, quality: SCENE_QUALITY, size: PAGE_SIZE, mock: `${story.key} ${key}` });
    },
    analyse: (image) => analyseCharacter(image, { story, key }),
    onAttempt: (a) => db.logGen({ kind: "bible", story: story.key, attempt: a.attempt, model: SCENE_MODEL, quality: SCENE_QUALITY, status: a.error ? "failed" : "done", score: a.score, problems: a.problems, error: a.error, ms: a.ms }),
  });
  if (!best) throw lastError || new Error("no character image");
  const imageId = await db.saveImage({ kind: "bible", buf: best.result, thumb: await makeThumb(best.result), meta: { story: story.key, key } });
  await db.saveBible({ story: story.key, key, name: story.cast[key].name, description: story.cast[key].description, hash: hash(prompt), imageId, meta: { score: best.check.score, attempts } });
  return imageId;
}

async function makeScene(story, page, refs, sceneHash) {
  const prompt = scenePrompt(story, page);
  const images = page.cast.map((k) => refs[k]);
  const { best, attempts, lastError } = await bestOfThree({
    make: async (_attempt, problems) => {
      spend();
      const extra = problems.length ? `\n\nA previous try had these problems, so avoid them: ${problems.join("; ")}.` : "";
      return editImage({ images, prompt: prompt + extra, model: SCENE_MODEL, quality: SCENE_QUALITY, size: PAGE_SIZE, mock: `${story.key} page ${page.n}` });
    },
    analyse: (image) => analyseScene(image, { story, page }),
    onAttempt: (a) => db.logGen({ kind: "scene", story: story.key, page: page.n, attempt: a.attempt, model: SCENE_MODEL, quality: SCENE_QUALITY, status: a.error ? "failed" : "done", score: a.score, problems: a.problems, error: a.error, ms: a.ms }),
  });
  if (!best) throw lastError || new Error("no scene image");
  const { check, result: image } = best;
  const boxes = await boxesFor(story, page, image, check);
  const imageId = await db.saveImage({ kind: "scene", page: page.n, buf: image, thumb: await makeThumb(image), meta: { story: story.key } });
  const row = { story: story.key, page: page.n, hash: sceneHash, imageId, head: boxes.head, protected: boxes.protected, meta: { score: check.score, problems: check.problems, attempts, boxes: BOX_VERSION, located: boxes.located } };
  await db.saveScene(row);
  await remember({ story: story.key, page: page.n, hash: sceneHash, image_id: imageId, head: boxes.head, protected: boxes.protected, meta: row.meta, buf: image });
}

const BOX_VERSION = 2;

// Exact faces from the painted mask; bodies and objects from the vision check.
async function boxesFor(story, page, image, check) {
  spend();
  const found = await locateFaces(image, { story, page });
  const visionFaces = /face/i;
  const others = (check.protected || []).filter((b) => !visionFaces.test(b.label || ""));
  if (found) return { head: found.head, located: true, protected: [...found.faces, ...others, ...(found.head ? [found.head] : [])] };
  // Fall back on the vision model's face box, grown to take in the hair.
  log.warn({ story: story.key, page: page.n }, "couldn't read the face mask");
  const h = check.head;
  const head = h ? { label: "hero head", left: Math.max(0, h.left - 0.02), top: Math.max(0, h.top - 0.03), right: Math.min(1, h.right + 0.02), bottom: Math.min(1, h.bottom + 0.02) } : null;
  return { head, located: false, protected: [...(check.protected || []), ...(head ? [head] : [])] };
}

// The stand-in's hair, cut short on every page. Only the head changes; the head box
// stays as it was, so the reader's own hair has all that room.
// A scene listed here is trimmed again, from its current art, when its trim is
// older than the number. Jack 13 had a "surprised" tuft floating above the head
// that the first trim's oval didn't reach.
const RETRIM = { "jack:13": 2 };
const trimWanted = (r) => RETRIM[`${r.story}:${r.page}`] || 1;

async function trimStandIns(limit) {
  const todo = [...cache.values()].filter((r) => r.head && (Number(r.meta?.trimmed) || 0) < trimWanted(r));
  status.state = "trimming"; status.done = 0; status.total = todo.length;
  await Promise.all(todo.map((r) => limit(async () => {
    const story = STORIES[r.story];
    spend();
    const t = Date.now();
    const generated = await editImage({ images: [r.cropped], prompt: trimPrompt(story), model: BOOK_MODEL, quality: "medium", size: "1024x1024", mock: `trim ${r.story} ${r.page}` });
    const { page } = await blendHead({ scene: r.buf, raw: r.raw, generated, crop: r.crop, head: r.head, W: r.W, H: r.H, avoid: otherFaces(r) });
    const imageId = await db.saveImage({ kind: "scene", page: r.page, buf: page, thumb: await makeThumb(page), meta: { story: r.story, trimmedFrom: Number(r.image_id) } });
    const meta = { ...r.meta, trimmed: trimWanted(r) };
    await db.saveScene({ story: r.story, page: r.page, hash: r.hash, imageId, head: r.head, protected: r.protected, meta });
    await remember({ ...r, image_id: imageId, meta, buf: page });
    await db.logGen({ kind: "trim", story: r.story, page: r.page, attempt: 1, model: BOOK_MODEL, quality: "medium", status: "done", ms: Date.now() - t });
    status.done++;
  })));
}

// Scenes painted before the boxes improved: keep the art, redo only the boxes.
async function reboxScenes(limit) {
  // A page whose words couldn't clear its boxes gets a second look too: the vision
  // model sometimes boxes a person far past their feet. Two more looks at most.
  const wordsOf = (r) => { const st = STORIES[r.story], p = st.pages[r.page - 1]; return p.title ? { n: p.n, title: true, text: st.title, starring: "you" } : { n: p.n, text: pageWords(p, st.defaultPronoun) }; };
  const framed = (r) => placeWords(wordsOf(r), r.protected).mode === "framed";
  const todo = [...cache.values()].filter((r) => r.meta?.boxes !== BOX_VERSION || (framed(r) && (r.meta?.looks || 0) < 2));
  status.state = "boxes"; status.done = 0; status.total = todo.length;
  await Promise.all(todo.map((r) => limit(async () => {
    const story = STORIES[r.story];
    const page = story.pages[r.page - 1];
    const check = await analyseScene(r.buf, { story, page });
    // Keep the faces already found; only the other boxes get the new look.
    const boxes = r.meta?.boxes === BOX_VERSION && r.head !== undefined
      ? { head: r.head, located: r.meta.located, protected: [...r.protected.filter((b) => /^(face|hero head)$/.test(b.label)), ...check.protected.filter((b) => !/face/i.test(b.label || ""))] }
      : await boxesFor(story, page, r.buf, check);
    const meta = { ...r.meta, boxes: BOX_VERSION, located: boxes.located, looks: (r.meta?.looks || 0) + 1 };
    await db.saveScene({ story: r.story, page: r.page, hash: r.hash, imageId: r.image_id, head: boxes.head, protected: boxes.protected, meta });
    await remember({ ...r, head: boxes.head, protected: boxes.protected, meta });
    status.done++;
  })));
}

export async function ensureArt() {
  return withMeter({ purpose: "art" }, ensureArtInner);
}

async function ensureArtInner() {
  await loadCache();
  if (process.env.PREGEN === "off") { status.state = "off"; return; }
  const limit = limiter(CONCURRENCY);

  try {
    // 1. The character bible.
    const rows = await db.bibleRows();
    const have = new Map(rows.map((r) => [`${r.story}:${r.key}`, r]));
    const refs = {};
    const charJobs = [];
    for (const story of Object.values(STORIES)) {
      refs[story.key] = {};
      for (const key of Object.keys(story.cast)) {
        const prompt = biblePrompt(story, key);
        const row = have.get(`${story.key}:${key}`);
        if (row?.hash === hash(prompt)) { refs[story.key][key] = { id: row.image_id, hash: row.hash }; continue; }
        charJobs.push({ story, key, h: hash(prompt) });
      }
    }
    const sceneTodo = [];
    status.total = charJobs.length;
    status.state = "bible";
    await Promise.all(charJobs.map((j) => limit(async () => {
      status.current.push(`${j.story.key}/${j.key}`);
      const id = await makeCharacter(j.story, j.key);
      refs[j.story.key][j.key] = { id, hash: j.h };
      status.done++;
      status.current = status.current.filter((c) => c !== `${j.story.key}/${j.key}`);
      log.info({ event: "pregen.bible", story: j.story.key, key: j.key }, "character done");
    })));

    // 2. The scenes. Each one's hash includes its cast, so a new character remakes its pages.
    for (const story of Object.values(STORIES)) {
      for (const page of story.pages) {
        const h = hash(scenePrompt(story, page) + page.cast.map((k) => refs[story.key][k].hash).join());
        if (sceneFor(story.key, page.n)?.hash !== h) sceneTodo.push({ story, page, h });
      }
    }
    status.state = "scenes"; status.done = 0; status.total = sceneTodo.length;
    const bufs = {};
    const refBuf = async (story, key) => (bufs[`${story}:${key}`] ??= await db.imageData(refs[story][key].id));
    await Promise.all(sceneTodo.map((j) => limit(async () => {
      const label = `${j.story.key}/${j.page.n}`;
      status.current.push(label);
      const r = {};
      for (const k of j.page.cast) r[k] = await refBuf(j.story.key, k);
      await makeScene(j.story, j.page, r, j.h);
      status.done++;
      status.current = status.current.filter((c) => c !== label);
      log.info({ event: "pregen.scene", story: j.story.key, page: j.page.n }, "scene done");
    })));
    await reboxScenes(limit);
    await trimStandIns(limit);
    await loadHeroLooks(); // the bible may have just been painted
    status.state = "ready";
    log.info({ event: "pregen.done", calls: status.calls }, "all art is ready");
  } catch (err) {
    status.state = "stopped";
    status.error = err instanceof OutOfBudget ? err.message : friendlyError(err);
    log.error({ err: err.message, status: err.status }, "pre-generation stopped");
  }
}

// The whole bible and all scenes, with where the words fall, for the public page.
export async function artOverview() {
  const [bible, scenes] = await Promise.all([db.bibleRows(), db.sceneRows()]);
  return {
    status: { ...status },
    stories: Object.values(STORIES).map((s) => ({
      key: s.key, title: s.title,
      cast: bible.filter((b) => b.story === s.key).map((b) => ({ key: b.key, name: b.name, description: b.description, image: Number(b.image_id), score: b.meta?.score ?? null })),
      pages: s.pages.map((p) => {
        const r = scenes.find((x) => x.story === s.key && x.page === p.n);
        const words = p.title ? { n: p.n, title: true, text: s.title, starring: "you" } : { n: p.n, text: pageWords(p, s.defaultPronoun) };
        return {
          n: p.n, text: words.text, image: r ? Number(r.image_id) : null, head: r?.head ?? null, protected: r?.protected ?? [],
          score: r?.meta?.score ?? null, problems: r?.meta?.problems ?? [], attempts: r?.meta?.attempts ?? [],
          place: r ? placeWords(words, r.protected) : null,
        };
      }),
    })),
  };
}
