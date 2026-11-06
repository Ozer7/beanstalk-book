// ---------------------------------------------------------------------------
// Finding faces exactly. Vision models are poor at pixel coordinates: measured on
// real pages, their head boxes were off by up to a tenth of the page. Image
// models know exactly where a head is, so one paints the heads in pure colours on
// a copy of the page, and the boxes are read from those pixels.
// ---------------------------------------------------------------------------
import sharp from "sharp";
import { editImage, MOCK, BOOK_MODEL } from "./images.js";
import { PAGE_SIZE } from "./template.js";

export function maskPrompt(story, page) {
  return [
    "Edit this picture-book page. Change nothing about the composition, camera, or where anything is.",
    page.hero
      ? `Paint a solid flat pure magenta (#FF00FF) shape over the whole head of ${story.role}, the child hero, from the top of the hair to the chin, covering the hair${story.key === "red" ? " and any hood around the head" : ""} and ears, and following the head's exact outline.`
      : "",
    "Paint a solid flat pure cyan (#00FFFF) shape over every other face in the picture, of people and animals, following each face's outline.",
    "Keep everything else exactly as it is. No other magenta or cyan anywhere. No text.",
  ].filter(Boolean).join(" ");
}

// Connected blobs of one colour, as boxes in page fractions.
function blobs(data, W, H, match, minPixels) {
  const seen = new Uint8Array(W * H);
  const out = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || !match(start)) continue;
    const stack = [start];
    seen[start] = 1;
    let n = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p - x) / W;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && !seen[q] && match(q)) { seen[q] = 1; stack.push(q); }
      }
    }
    if (n >= minPixels) out.push({ n, left: x0 / W, right: (x1 + 1) / W, top: y0 / H, bottom: (y1 + 1) / H });
  }
  return out.sort((a, b) => b.n - a.n);
}

export async function readMask(mask) {
  const W = 256;
  const { data, info } = await sharp(mask).resize({ width: W }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const H = info.height;
  const px = (i) => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
  const isMagenta = (i) => { const [r, g, b] = px(i); return r > 190 && b > 170 && g < 85; };
  const isCyan = (i) => { const [r, g, b] = px(i); return r < 85 && g > 180 && b > 180; };
  const minPixels = Math.round(W * H * 0.0006);
  return { heads: blobs(data, W, H, isMagenta, minPixels), faces: blobs(data, W, H, isCyan, minPixels) };
}

// Returns { head, faces } or null if the mask couldn't be read.
export async function locateFaces(image, { story, page }) {
  if (MOCK) return { head: page.hero ? { left: 0.36, top: 0.42, right: 0.64, bottom: 0.58 } : null, faces: [] };
  for (let tries = 0; tries < 2; tries++) {
    try {
      const mask = await editImage({ images: [image], prompt: maskPrompt(story, page), model: BOOK_MODEL, quality: "low", size: PAGE_SIZE });
      const { heads, faces } = await readMask(mask);
      if (page.hero && !heads.length) continue;
      const pad = 0.004;
      const box = (b, label) => ({ label, left: Math.max(0, b.left - pad), top: Math.max(0, b.top - pad), right: Math.min(1, b.right + pad), bottom: Math.min(1, b.bottom + pad) });
      return { head: page.hero ? box(heads[0], "hero head") : null, faces: faces.map((f) => box(f, "face")) };
    } catch { /* try again */ }
  }
  return null;
}
