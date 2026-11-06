import { jack } from "../stories/jack.js";
import { red } from "../stories/red.js";
import { TEMPLATE } from "./template.js";

export const STORIES = { jack, red };

const PRONOUNS = { he: { he: "he", his: "his", him: "him" }, she: { he: "she", his: "her", him: "her" }, they: { he: "they", his: "their", him: "them" } };

// The words for one page, with the reader's pronouns filled in.
export function pageWords(page, pronoun) {
  const p = PRONOUNS[pronoun] || PRONOUNS.he;
  return page.text.replace(/\{(he|his|him)\}/g, (_, k) => p[k]);
}

// Every story must have exactly the template's pages, in order.
for (const s of Object.values(STORIES)) {
  if (s.pages.length !== TEMPLATE.length || s.pages.some((p, i) => p.n !== i + 1)) throw new Error(`${s.key} doesn't match the template`);
  for (const p of s.pages) for (const c of p.cast) if (!s.cast[c]) throw new Error(`${s.key} page ${p.n}: unknown ${c}`);
}
