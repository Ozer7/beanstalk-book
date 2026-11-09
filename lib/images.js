// ---------------------------------------------------------------------------
// The image model. Every call goes through editImage(). Pre-generated art and
// the per-book pass use different models and qualities on purpose: art can take
// its time; the per-book pass has to fit in the 60 seconds.
// ---------------------------------------------------------------------------
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { record, MOCK_USAGE } from "./cost.js";

sharp.concurrency(1); // Render's small CPU: don't let libvips fight itself
sharp.cache(false);

export const MOCK = process.env.MOCK_IMAGES === "1";
export const SCENE_MODEL = process.env.SCENE_IMAGE_MODEL || "gpt-image-2.5-sunburst";
export const SCENE_QUALITY = process.env.SCENE_IMAGE_QUALITY || "high";
export const BOOK_MODEL = process.env.BOOK_IMAGE_MODEL || "gpt-image-2.5-flare";
export const BOOK_QUALITY = process.env.BOOK_IMAGE_QUALITY || "low";

let client = null;
const openai = () => (client ??= new OpenAI({ maxRetries: 1, timeout: 120_000 }));

// OpenAI's image rate limit ("20 input images per minute") is hit when two books
// run back to back. The error says how long to wait ("try again in 3s"): wait
// that long and send the same request again, a few times, instead of failing
// the attempt. A wait never runs past the book's own time limit, which the
// quality loop enforces.
async function waitOutRateLimit(call, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await call(); }
    catch (err) {
      const msg = String(err?.error?.message || err?.message || "");
      if (err?.status !== 429 || /quota|billing|credit/i.test(msg) || i >= tries) throw err;
      const s = Number(msg.match(/try again in ([\d.]+)\s*s/i)?.[1] || 2);
      await new Promise((r) => setTimeout(r, Math.min(8, s + 0.3) * 1000));
    }
  }
}

export async function editImage({ images, prompt, model, quality, size = "1024x1024", mock }) {
  if (MOCK) { record({ model, usage: MOCK_USAGE.image, kind: "image" }); return mockImage(mock, size); }
  const files = await Promise.all(images.map((buf, i) => toFile(buf, `image-${i + 1}.jpg`, { type: mimeOf(buf) })));
  const result = await waitOutRateLimit(() => openai().images.edit({
    model, image: files.length === 1 ? files[0] : files, prompt, size, quality,
    output_format: "jpeg", output_compression: 90,
  }));
  record({ model, usage: result.usage, kind: "image" });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("The image model returned no picture.");
  return Buffer.from(b64, "base64");
}

// A new picture from words alone (the character bible).
export async function generateImage({ prompt, model, quality, size = "1024x1536", mock }) {
  if (MOCK) { record({ model, usage: MOCK_USAGE.image, kind: "image" }); return mockImage(mock, size); }
  const result = await openai().images.generate({ model, prompt, size, quality, output_format: "jpeg", output_compression: 90 });
  record({ model, usage: result.usage, kind: "image" });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("The image model returned no picture.");
  return Buffer.from(b64, "base64");
}

// Uploaded photo -> upright JPEG, at most 1024px (phones store rotation in EXIF).
export async function normalizePhoto(buf) {
  return sharp(buf).rotate().resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
}

export const makeThumb = (buf) => sharp(buf).resize({ width: 320 }).jpeg({ quality: 72 }).toBuffer();

export function friendlyError(err) {
  const msg = String(err?.error?.message || err?.message || "");
  const status = err?.status;
  if (status === 401) return "The server's OpenAI key is missing or wrong.";
  if (status === 429 && /quota|billing|credit/i.test(msg)) return "The OpenAI account is out of credit.";
  if (status === 429) return "Too many pictures at once. Wait a minute and try again.";
  if (err?.error?.code === "moderation_blocked" || (status === 400 && /safety|moderation/i.test(msg))) return "OpenAI's safety filter stopped this picture.";
  return msg || "Generating the picture failed.";
}

function mimeOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
}

// MOCK_IMAGES=1: placeholder art, no API calls, no cost. Head at a known spot.
async function mockImage(label = "mock", size) {
  const ms = Number(process.env.MOCK_DELAY_MS) || 200;
  await new Promise((r) => setTimeout(r, ms * (0.7 + Math.random() * 0.6)));
  const [w, h] = size.split("x").map(Number);
  const hue = [...String(label)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,72%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},40%,38%)"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w / 2}" cy="${h / 2}" r="${w * 0.16}" fill="#f1c9a5"/>
    <text x="50%" y="${h * 0.82}" font-family="sans-serif" font-size="${w * 0.05}" fill="#fff" text-anchor="middle">${String(label).slice(0, 28)}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}
