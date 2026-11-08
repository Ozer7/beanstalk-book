// ---------------------------------------------------------------------------
// What a book costs to make. Every OpenAI call reports the tokens it used; this
// turns them into dollars at OpenAI's published prices and writes one row per
// call to api_calls, tagged with the book, the attempt and what the call was for.
//
// The tagging uses AsyncLocalStorage: the pipeline runs each book inside
// withMeter({ bookId }), the quality loop adds { attempt }, and every call made
// underneath picks those up without passing them through every function.
// ---------------------------------------------------------------------------
import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "./log.js";

// US dollars per 1M tokens, from OpenAI's model pages (checked 2026-11-08).
// gpt-image-2.5-*: text in $5, image in $8, cached $1.25 / $2, image out $30.
// gpt-5.4-mini:   in $0.75, cached in $0.075, out $4.50.
export const PRICES = {
  "gpt-image-2.5-flare": { text: 5, image: 8, cachedText: 1.25, cachedImage: 2, out: 30 },
  "gpt-image-2.5-sunburst": { text: 5, image: 8, cachedText: 1.25, cachedImage: 2, out: 30 },
  "gpt-5.4-mini": { in: 0.75, cached: 0.075, out: 4.5 },
};
export const PRICES_CHECKED = "2026-11-08";

const store = new AsyncLocalStorage();
export const withMeter = (ctx, fn) => store.run({ ...(store.getStore() || {}), ...ctx }, fn);
export const meterContext = () => store.getStore() || {};
/** A running total that every call made inside fn adds to. */
export const newTally = () => ({ usd: 0, calls: 0, images: 0, checks: 0 });

/** Dollars for one call, or null for a model with no known price. */
export function dollars(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const M = 1e6;
  const inTok = usage.input_tokens || 0, outTok = usage.output_tokens || 0;
  const d = usage.input_tokens_details || {};
  if (p.image != null) {
    // Image models split input into text and image tokens. Without the split,
    // charge everything at the dearer image rate rather than undercount.
    const cached = d.cached_tokens || 0;
    const text = d.text_tokens ?? (d.image_tokens != null ? inTok - d.image_tokens : 0);
    const image = d.image_tokens ?? inTok - text;
    const cachedShare = inTok ? cached / inTok : 0;
    const inCost = (text * ((1 - cachedShare) * p.text + cachedShare * p.cachedText) + image * ((1 - cachedShare) * p.image + cachedShare * p.cachedImage)) / M;
    return inCost + (outTok * p.out) / M;
  }
  const cached = d.cached_tokens || 0;
  return ((inTok - cached) * p.in + cached * p.cached + outTok * p.out) / M;
}

let sink = null; // set by db.js, so this file doesn't import the database
export const setSink = (fn) => { sink = fn; };

/** Record one API call. kind: "image" | "check". */
export function record({ model, usage, kind }) {
  const ctx = meterContext();
  const usd = dollars(model, usage);
  if (usd == null) log.warn({ model }, "no price for this model; its calls are logged without a cost");
  const row = {
    bookId: ctx.bookId ?? null, userId: ctx.userId ?? null, purpose: ctx.purpose || (ctx.bookId ? "book" : "other"),
    kind, model, attempt: ctx.attempt ?? null,
    inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null, usd,
  };
  if (ctx.tally) { ctx.tally.usd += usd || 0; ctx.tally.calls++; if (kind === "image") ctx.tally.images++; else ctx.tally.checks++; }
  sink?.(row);
  return usd;
}

// Mock mode makes no API calls. It still reports a believable usage, so the cost
// pages and the smoke test have something to show.
export const MOCK_USAGE = {
  image: { input_tokens: 1800, output_tokens: 1100, input_tokens_details: { text_tokens: 500, image_tokens: 1300 } },
  check: { input_tokens: 2400, output_tokens: 300 },
};
