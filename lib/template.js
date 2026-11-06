// ---------------------------------------------------------------------------
// The template. One 20-page plan that serves every story: for each page, where
// the art's subject sits, how close the camera is, and where the words are
// allowed to go. Stories (stories/*.js) only fill the template in; they can't
// change its layouts. That is what holds quality steady across the two books.
//
//   zone   where the words should go: top | middle | bottom
//   shot   how big the hero is, so their face stays large enough to read
//   beat   what this page does in the story
// ---------------------------------------------------------------------------
export const STYLE =
  "Hand-painted picture-book illustration in gouache and watercolour: visible brushstrokes and paper " +
  "texture, matte colours, soft natural light, gentle storybook proportions, warm simple faces. " +
  "Not 3D, not glossy, not photographic. One full-bleed painting with no border or frame.";

export const NO_TEXT = "No letters, words, numbers, signs, captions or speech bubbles anywhere.";

export const PAGE_SIZE = "1024x1536";

const SHOTS = {
  close: "Close shot: the hero is large, from the waist up, and their head is about a quarter of the picture's width.",
  medium: "Medium shot: the hero's whole body fills about half the picture's height, and their head is at least a seventh of the picture's width.",
  wide: "Wider shot showing the place, but the hero stays near the viewer: their head is still at least a tenth of the picture's width.",
};

const ZONES = {
  top: "the top 28% of the picture",
  middle: "a band across the middle of the picture, about 26% of its height",
  bottom: "the bottom 28% of the picture",
};

export const TEMPLATE = [
  { n: 1, beat: "cover", zone: "top", shot: "medium" },
  { n: 2, beat: "home", zone: "top", shot: "medium" },
  { n: 3, beat: "trouble", zone: "bottom", shot: "close" },
  { n: 4, beat: "setting off", zone: "top", shot: "wide" },
  { n: 5, beat: "the stranger", zone: "bottom", shot: "medium" },
  { n: 6, beat: "the bargain", zone: "top", shot: "close" },
  { n: 7, beat: "the consequence", zone: "bottom", shot: "medium" },
  { n: 8, beat: "the wonder", zone: "bottom", shot: "wide" },
  { n: 9, beat: "the journey", zone: "top", shot: "medium" },
  { n: 10, beat: "arrival", zone: "bottom", shot: "wide" },
  { n: 11, beat: "inside", zone: "top", shot: "medium" },
  { n: 12, beat: "close call", zone: "bottom", shot: "medium" },
  { n: 13, beat: "discovery", zone: "top", shot: "medium" },
  { n: 14, beat: "tension", zone: "bottom", shot: "close" },
  { n: 15, beat: "the turn", zone: "top", shot: "medium" },
  { n: 16, beat: "the chase", zone: "bottom", shot: "medium" },
  { n: 17, beat: "peril", zone: "middle", shot: "medium" },
  { n: 18, beat: "rescue", zone: "bottom", shot: "medium" },
  { n: 19, beat: "safe", zone: "top", shot: "medium" },
  { n: 20, beat: "ever after", zone: "bottom", shot: "medium" },
];

export const slot = (n) => TEMPLATE[n - 1];
export const shotText = (n) => SHOTS[slot(n).shot];
export const zoneText = (n) => ZONES[slot(n).zone];
