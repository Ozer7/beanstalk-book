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

// The square sent to the model, up-scaled so a small head still gets detail, and
// the same square as raw pixels for blending. Made once per scene, at startup:
// Render's free CPU is the slowest thing in the whole pipeline.
export async function prepareCrop(scene, crop) {
  const cropped = await sharp(scene).extract(crop).resize(1024, 1024, { kernel: "lanczos3" }).jpeg({ quality: 82 }).toBuffer();
  const raw = await sharp(scene).extract(crop).removeAlpha().raw().toBuffer();
  return { cropped, raw };
}

/**
 * Put the generated head back: an oval around the head, soft at the edge,
 * colour-matched to the page. Done with plain arithmetic, no image library, to
 * save CPU. Returns the finished page and the blended crop.
 */
export async function blendHead({ scene, raw, generated, crop, head, W, H }) {
  const s = crop.width;
  const next = await sharp(generated).resize(s, s, { fit: "fill", kernel: "cubic" }).removeAlpha().raw().toBuffer();
  const cx = ((head.left + head.right) / 2) * W - crop.left, cy = ((head.top + head.bottom) / 2) * H - crop.top;
  // Reaches well past the head: a stand-in's bigger hair mustn't survive around a
  // reader's shorter hair.
  const rx = ((head.right - head.left) * W) / 2 * 1.5, ry = ((head.bottom - head.top) * H) / 2 * 1.42;
  const soft = 0.22; // how much of the oval's radius fades out

  const alpha = new Float32Array(s * s);
  const sum0 = [0, 0, 0], sum1 = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < s; y++) {
    const dy = (y - cy) / ry;
    for (let x = 0; x < s; x++) {
      const dx = (x - cx) / rx;
      const d = Math.sqrt(dx * dx + dy * dy);
      const t = (1 + soft / 2 - d) / soft;
      const a = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
      const i = y * s + x;
      alpha[i] = a;
      if (a === 0 && d < 1.8) {
        for (let c = 0; c < 3; c++) { sum0[c] += raw[i * 3 + c]; sum1[c] += next[i * 3 + c]; }
        n++;
      }
    }
  }
  const shift = n ? sum0.map((v, c) => (v - sum1[c]) / n) : [0, 0, 0];

  const out = Buffer.allocUnsafe(raw.length);
  for (let i = 0; i < s * s; i++) {
    const a = alpha[i];
    for (let c = 0; c < 3; c++) {
      const v = raw[i * 3 + c] * (1 - a) + (next[i * 3 + c] + shift[c]) * a;
      out[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  const info = { raw: { width: s, height: s, channels: 3 } };
  const blended = await sharp(out, info).jpeg({ quality: 80 }).toBuffer();
  const page = await sharp(scene).composite([{ input: out, ...info, left: crop.left, top: crop.top }]).jpeg({ quality: 86 }).toBuffer();
  return { page, blended };
}
