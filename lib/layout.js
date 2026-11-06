// ---------------------------------------------------------------------------
// Where the words go. This is solved, not hoped for. Every page's art comes with
// boxes around every face and everything the reader needs to see. The solver
// tries the template's preferred zone first, then the others, and picks the
// largest words that clear every box. If nothing clears, the page changes
// layout: the art is framed and the words go on paper below it, so words can
// never sit on a face. The PDF and the on-screen reader both use this result.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { createRequire } from "node:module";
import fontkit from "@pdf-lib/fontkit";
import { woffToSfnt } from "./woff.js";
import { slot } from "./template.js";

export const PAGE_W = 432; // 6 x 9 in, the same 2:3 shape as the art
export const PAGE_H = 648;

const require = createRequire(import.meta.url);
const load = (pkg, file) => woffToSfnt(fs.readFileSync(require.resolve(`@fontsource/${pkg}/files/${file}`)));
export const FONT_BYTES = {
  body: load("andika", "andika-latin-400-normal.woff"),
  bold: load("andika", "andika-latin-700-normal.woff"),
  title: load("fraunces", "fraunces-latin-700-normal.woff"),
  hebrew: load("noto-sans-hebrew", "noto-sans-hebrew-hebrew-400-normal.woff"),
  hebrewBold: load("noto-sans-hebrew", "noto-sans-hebrew-hebrew-700-normal.woff"),
};
const BODY = fontkit.create(FONT_BYTES.body);
const TITLE = fontkit.create(FONT_BYTES.title);
const HEBREW = fontkit.create(FONT_BYTES.hebrew);

// Hebrew reads right to left, and a PDF just places glyphs left to right. So a line
// becomes runs in the order they're drawn, with Hebrew letters reversed. Marks
// (niqqud) are dropped: this font can't stack them once the letters are reversed.
const HEB = /[\u05D0-\u05EA]/;
export const hasHebrew = (t) => HEB.test(String(t ?? ""));
export function visualRuns(text) {
  const clean = String(text).replace(/[\u0591-\u05C7]/g, "");
  if (!HEB.test(clean)) return [{ text: clean, heb: false }];
  const parts = clean.match(/[\u05D0-\u05EA]+(?:[\s\-'"\u05F3\u05F4.,!?]+[\u05D0-\u05EA]+)*|[^\u05D0-\u05EA]+/g);
  const runs = parts.map((p) => (HEB.test(p) ? { text: [...p].reverse().join(""), heb: true } : { text: p, heb: false }));
  const first = clean.match(/[\u05D0-\u05EAA-Za-z]/)?.[0];
  return first && HEB.test(first) ? runs.reverse() : runs;
}

const runWidth = (font, text, size) => (font.layout(text).glyphs.reduce((s, g) => s + g.advanceWidth, 0) * size) / font.unitsPerEm;
const measure = (font) => (text, size) => visualRuns(text).reduce((sum, r) => sum + runWidth(r.heb ? HEBREW : font, r.text, size), 0);
export const bodyWidth = measure(BODY);
export const titleWidth = measure(TITLE);

export function unsupportedChars(str) {
  const bad = new Set();
  for (const ch of String(str ?? "")) if (!/\s/.test(ch) && !BODY.hasGlyphForCodePoint(ch.codePointAt(0)) && !/[\u0591-\u05F4]/.test(ch)) bad.add(ch);
  return [...bad];
}

export function wrap(text, widthOf, size, maxW) {
  const lines = [];
  let line = "";
  for (const word of String(text).trim().split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (widthOf(next, size) <= maxW || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

// Same number of lines, but as even as possible: no lonely last word.
function balanced(text, widthOf, size, maxW) {
  const greedy = wrap(text, widthOf, size, maxW);
  if (greedy.length < 2) return greedy;
  let lo = maxW * 0.4, hi = maxW;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (wrap(text, widthOf, size, mid).length <= greedy.length) hi = mid; else lo = mid;
  }
  return wrap(text, widthOf, size, hi);
}

const PAD_X = 16, PAD_Y = 11;   // inside the panel, in points
const CLEAR = 0.012;            // required gap between panel and any box
const BANDS = { top: [0.025, 0.30], middle: [0.30, 0.70], bottom: [0.70, 0.975] };
const WIDTHS = [0.86, 0.72, 0.58];
const X_ALIGN = ["center", "left", "right"];

function panelFor(lines, size, lineH, widthOf, kindW = null) {
  const textW = kindW ?? Math.max(...lines.map((l) => widthOf(l, size)));
  return { w: textW + 2 * PAD_X, h: lines.length * lineH + 2 * PAD_Y };
}

const hits = (a, b, gap = CLEAR) => a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;
const gapTo = (a, b) => {
  const dx = Math.max(0, b.left - a.right, a.left - b.right), dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
  return Math.hypot(dx, dy);
};

/**
 * spec: { n, text, title?, starring? }   boxes: [{ left, top, right, bottom }]
 * Returns { mode: "panel", box, size, lineH, lines, zone } or { mode: "framed", ... }
 * Box and lines are in page fractions from the top-left, so the screen can use them too.
 */
export function placeWords(spec, boxes) {
  const pref = slot(spec.n).zone;
  const zones = [pref, ...["top", "bottom", "middle"].filter((z) => z !== pref)];
  // A box covering most of the page is background, whatever it was called.
  const rects = boxes.filter((b) => b && b.right > b.left && b.bottom > b.top && (b.right - b.left) * (b.bottom - b.top) < 0.42);

  if (spec.title) return placeTitle(spec, rects, zones);

  for (const size of [21, 20, 19, 18, 17, 16, 15]) {
    const lineH = size * 1.32;
    for (const fw of WIDTHS) {
      const lines = balanced(spec.text, bodyWidth, size, PAGE_W * fw - 2 * PAD_X);
      if (lines.length > 5) continue;
      const hit = search(lines, size, lineH, bodyWidth, rects, zones);
      if (hit) return { mode: "panel", ...hit, size, lineH, lines: linesOut(lines, bodyWidth, size), font: "body" };
    }
  }
  return framed(spec);
}

function search(lines, size, lineH, widthOf, rects, zones) {
  const { w, h } = panelFor(lines, size, lineH, widthOf);
  const fw = w / PAGE_W, fh = h / PAGE_H;
  for (const zone of zones) {
    const [y0, y1] = BANDS[zone];
    if (y1 - y0 < fh) continue;
    let best = null;
    for (const align of X_ALIGN) {
      const left = align === "center" ? (1 - fw) / 2 : align === "left" ? 0.04 : 0.96 - fw;
      for (let i = 0; i <= 10; i++) {
        const top = y0 + ((y1 - y0 - fh) * i) / 10;
        const box = { left, top, right: left + fw, bottom: top + fh };
        if (rects.some((r) => hits(box, r))) continue;
        const nearest = rects.length ? Math.min(...rects.map((r) => gapTo(box, r))) : 1;
        // Nearer the page edge and centred read best; then more breathing room.
        const edge = zone === "top" ? top : zone === "bottom" ? 1 - (top + fh) : Math.abs(0.5 - (top + fh / 2));
        const score = Math.min(nearest, 0.06) * 4 - edge - (align === "center" ? 0 : 0.03);
        if (!best || score > best.score) best = { score, box, zone, clearance: nearest };
      }
    }
    if (best) return { box: best.box, zone: best.zone, clearance: round(best.clearance) };
  }
  return null;
}

const linesOut = (lines, widthOf, size) => lines.map((text) => ({ text, width: widthOf(text, size) / PAGE_W }));
const round = (n) => Math.round(n * 1000) / 1000;

// The cover: the title, big, and who it stars.
function placeTitle(spec, rects, zones) {
  for (const size of [40, 36, 32, 29, 26, 23]) {
    const lineH = size * 1.1;
    for (const fw of [0.86, 0.62, 0.5]) {
    const lines = balanced(spec.text, titleWidth, size, PAGE_W * fw - 2 * PAD_X);
    if (lines.length > 4 || lines.some((l) => titleWidth(l, size) > PAGE_W * fw - 2 * PAD_X)) continue;
    const subSize = Math.max(16, size * 0.55), subH = subSize * 1.5;
    const sub = spec.starring ? `starring ${spec.starring}` : "";
    const subW = sub ? bodyWidth(sub, subSize) : 0;
    const textW = Math.max(...lines.map((l) => titleWidth(l, size)), subW);
    const hPts = lines.length * lineH + (sub ? subH : 0);
    const fake = Array.from({ length: Math.ceil(hPts / lineH) }, () => "x");
    const hit = search(fake, size, lineH, () => textW, rects, zones);
    if (hit) return { mode: "panel", ...hit, size, lineH, lines: linesOut(lines, titleWidth, size), font: "title", sub: sub ? { text: sub, size: subSize, width: subW / PAGE_W, lineH: subH } : null };
    }
  }
  return framed(spec);
}

// Nothing clears: frame the art and set the words on paper below it.
function framed(spec) {
  const artH = 0.76;
  const title = !!spec.title;
  const widthOf = title ? titleWidth : bodyWidth;
  let size = title ? 30 : 19;
  let lines = balanced(spec.text, widthOf, size, PAGE_W * 0.84);
  while (lines.length * size * 1.32 > PAGE_H * (1 - artH) * 0.8 && size > 12) { size -= 1; lines = balanced(spec.text, widthOf, size, PAGE_W * 0.84); }
  return { mode: "framed", art: { left: (1 - artH) / 2, top: 0.03, right: (1 + artH) / 2, bottom: 0.03 + artH }, box: { left: 0.06, top: 0.8, right: 0.94, bottom: 0.98 }, zone: "framed", size, lineH: size * 1.32, lines: linesOut(lines, widthOf, size), font: title ? "title" : "body", sub: title && spec.starring ? { text: `starring ${spec.starring}`, size: 13, width: bodyWidth(`starring ${spec.starring}`, 13) / PAGE_W, lineH: 20 } : null };
}
