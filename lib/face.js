// ---------------------------------------------------------------------------
// Editing the reader into a pre-generated page. The whole page is NOT redrawn:
// that would take too long and let the art and text space drift. A square around
// the hero's head goes to the image model, and only the head comes back,
// colour-matched and feathered into the original art.
// ---------------------------------------------------------------------------
import sharp from "sharp";

// The crop is about 2.1 heads wide, so the model sees the neck, shoulders and light.
export function cropFor(head, W, H) {
  const hw = (head.right - head.left) * W, hh = (head.bottom - head.top) * H;
  const side = Math.round(Math.min(Math.max(hw, hh) * 2.1, Math.min(W, H)));
  const cx = ((head.left + head.right) / 2) * W, cy = ((head.top + head.bottom) / 2) * H;
  return {
    left: Math.round(Math.min(W - side, Math.max(0, cx - side / 2))),
    top: Math.round(Math.min(H - side, Math.max(0, cy - side / 2))),
    width: side, height: side,
  };
}

// The square sent to the model: up-scaled so a small head still gets detail.
export async function cropScene(scene, crop) {
  return sharp(scene).extract(crop).resize(1024, 1024, { kernel: "lanczos3" }).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Put the generated head back. Returns the finished page and the blended crop
 * (what the quality check looks at).
 */
export async function blendHead({ scene, generated, crop, head, W, H }) {
  const s = crop.width;
  const original = await sharp(scene).extract(crop).removeAlpha().raw().toBuffer();
  let next = await sharp(generated).resize(s, s, { fit: "fill" }).removeAlpha().raw().toBuffer();

  // Oval around the head, soft at the edge, reaching a little past the hair.
  const cx = ((head.left + head.right) / 2) * W - crop.left, cy = ((head.top + head.bottom) / 2) * H - crop.top;
  const rx = ((head.right - head.left) * W) / 2 * 1.22, ry = ((head.bottom - head.top) * H) / 2 * 1.2;
  const blur = Math.max(2, s * 0.03);
  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><rect width="100%" height="100%" fill="black"/><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="white"/></svg>`;
  const mask = await sharp(Buffer.from(maskSvg)).blur(blur).greyscale().raw().toBuffer();

  // Colour match: nudge the new art so the part outside the oval matches the page.
  let sum0 = [0, 0, 0], sum1 = [0, 0, 0], n = 0;
  for (let i = 0; i < mask.length; i += 7) {
    if (mask[i] > 8) continue;
    for (let c = 0; c < 3; c++) { sum0[c] += original[i * 3 + c]; sum1[c] += next[i * 3 + c]; }
    n++;
  }
  const shift = n ? sum0.map((v, c) => (v - sum1[c]) / n) : [0, 0, 0];

  const out = Buffer.alloc(original.length);
  for (let i = 0; i < mask.length; i++) {
    const a = mask[i] / 255;
    for (let c = 0; c < 3; c++) {
      const v = original[i * 3 + c] * (1 - a) + (next[i * 3 + c] + shift[c]) * a;
      out[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  const raw = { raw: { width: s, height: s, channels: 3 } };
  const blended = await sharp(out, raw).jpeg({ quality: 92 }).toBuffer();
  const page = await sharp(scene).composite([{ input: blended, left: crop.left, top: crop.top }]).jpeg({ quality: 88 }).toBuffer();
  return { page, blended };
}
