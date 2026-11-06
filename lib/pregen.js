// ---------------------------------------------------------------------------
// The pre-generated art: the character bible and every scene of both stories.
// Made once, at startup, stored in the database, and only remade when a prompt
// changes (each row keeps a hash of what made it). Readers never wait for this.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import sharp from "sharp";
import * as db from "./db.js";
import { log } from "./log.js";
import { STORIES } from "./stories.js";
import { biblePrompt, scenePrompt } from "./prompts.js";
import { editImage, makeThumb, friendlyError, MOCK, SCENE_MODEL, SCENE_QUALITY } from "./images.js";
import { analyseCharacter, analyseScene, refineHead } from "./vision.js";
import { bestOfThree } from "./quality.js";
import { PAGE_SIZE } from "./template.js";
import { placeWords } from "./layout.js";
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

async function loadCache() {
  for (const r of await db.sceneRows()) {
    const buf = await db.imageData(r.image_id);
    cache.set(`${r.story}:${r.page}`, { ...r, buf, W: 1024, H: 1536 });
  }
}

function limiter(n) {
  let running = 0; const queue = [];
  const next = () => { if (running < n && queue.length) { running++; queue.shift()(); } };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => { running--; next(); }));
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
      return editImage({ images: [blankPaper], prompt: prompt + extra, model: SCENE_MODEL, quality: SCENE_QUALITY, size: PAGE_SIZE, mock: `${story.key} ${key}` });
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
  let head = check.head;
  // Refine the head box from a closer look: the face edit depends on it.
  if (head && !MOCK) {
    try {
      const W = 1024, H = 1536;
      const hw = (head.right - head.left) * W, hh = (head.bottom - head.top) * H;
      const side = Math.min(W, Math.round(Math.max(hw, hh) * 2.4));
      const left = Math.max(0, Math.min(W - side, Math.round(((head.left + head.right) / 2) * W - side / 2)));
      const top = Math.max(0, Math.min(H - side, Math.round(((head.top + head.bottom) / 2) * H - side / 2)));
      const crop = await sharp(image).extract({ left, top, width: side, height: side }).jpeg({ quality: 85 }).toBuffer();
      const r = await refineHead(crop, { story });
      if (r && r.right > r.left && r.bottom > r.top) {
        head = { label: "head", left: (left + r.left * side) / W, top: (top + r.top * side) / H, right: (left + r.right * side) / W, bottom: (top + r.bottom * side) / H };
      }
    } catch (err) { log.warn({ err: err.message, page: page.n }, "head refine failed; using first box"); }
  }
  const imageId = await db.saveImage({ kind: "scene", page: page.n, buf: image, thumb: await makeThumb(image), meta: { story: story.key } });
  const prot = [...check.protected, ...(head ? [{ ...head, label: "hero head" }] : [])];
  const row = { story: story.key, page: page.n, hash: sceneHash, imageId, head, protected: prot, meta: { score: check.score, problems: check.problems, attempts } };
  await db.saveScene(row);
  cache.set(`${story.key}:${page.n}`, { story: story.key, page: page.n, hash: sceneHash, image_id: imageId, head, protected: prot, meta: row.meta, buf: image, W: 1024, H: 1536 });
}

let blankPaper;

export async function ensureArt() {
  await loadCache();
  if (process.env.PREGEN === "off") { status.state = "off"; return; }
  blankPaper = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#f3ecdc" } }).jpeg().toBuffer();
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
