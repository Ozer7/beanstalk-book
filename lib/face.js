// ---------------------------------------------------------------------------
// Editing the reader into a pre-generated page. The whole page is NOT redrawn:
// that would take too long and let the art and text space drift. A square around
// the hero's head goes to the image model, and only the head comes back,
// colour-matched and feathered into the original art.
// ---------------------------------------------------------------------------
import sharp from "sharp";

// The crop is about 3 heads wide: the model sees the neck, shoulders and light, and
// has room to take away a stand-in's hair, which reaches well beyond the head.
export function cropFor(head, W, H) {
  const hw = (head.right - head.left) * W, hh = (head.bottom - head.top) * H;
  const side = Math.round(Math.min(Math.max(hw, hh) * 3, Math.min(W, H)));
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
 * Put the generated head back: a soft-edged shape around the head, colour-matched
 * to the page. Done with plain arithmetic, no image library, to save CPU. Returns
 * the finished page and the blended crop.
 *
 * The shape is not a plain oval. Hair goes up, not down: a stand-in's tuft or
 * a reader's tall hair sits well above the head box, where an oval is already
 * narrowing. So the top half reaches 2.5 head-half-heights up and is squarer
 * (a superellipse); the bottom half stays a tight oval so the collar and
 * shoulders stay the page's own. Other characters' faces in the crop are never
 * repainted: the shape fades out around them.
 */
const shapes = new Map(); // the same scene blends many times: work its shape out once
export function blendShape({ crop, head, W, H, avoid = [] }) {
  const key = JSON.stringify([crop, head, W, H, avoid]);
  if (shapes.has(key)) return shapes.get(key);
  if (shapes.size > 200) shapes.clear();
  const s = crop.width;
  const cx = ((head.left + head.right) / 2) * W - crop.left, cy = ((head.top + head.bottom) / 2) * H - crop.top;
  const rx = ((head.right - head.left) * W) / 2 * 1.95;
  const hy = ((head.bottom - head.top) * H) / 2;
  const ryDown = hy * 1.75, ryUp = hy * 2.5;
  const soft = 0.22; // how much of the radius fades out
  const p = 3; // squareness of the top half

  // Other faces, in crop pixels. They never reach into the hero's own head and the
  // hair above it: a cow's face box overlapping the hero's cheek must not leave
  // half the stand-in's face behind.
  const hw = (head.right - head.left) * W, hh = (head.bottom - head.top) * H;
  const hero = {
    l: head.left * W - crop.left - hw * 0.12, r: head.right * W - crop.left + hw * 0.12,
    t: head.top * H - crop.top - hh * 0.8, b: head.bottom * H - crop.top + hh * 0.1,
  };
  const boxes = avoid.map((b) => ({ l: b.left * W - crop.left, t: b.top * H - crop.top, r: b.right * W - crop.left, b: b.bottom * H - crop.top }))
    .filter((b) => b.r > 0 && b.b > 0 && b.l < s && b.t < s);
  const fade = Math.max(6, s * 0.02);

  const alpha = new Float32Array(s * s), dist = new Float32Array(s * s);
  for (let y = 0; y < s; y++) {
    const up = y < cy;
    const dy = Math.abs(y - cy) / (up ? ryUp : ryDown);
    for (let x = 0; x < s; x++) {
      const dx = Math.abs(x - cx) / rx;
      const d = up ? Math.pow(dx ** p + dy ** p, 1 / p) : Math.sqrt(dx * dx + dy * dy);
      const t = (1 + soft / 2 - d) / soft;
      let a = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
      // How far outside the hero's area: 0 inside, rising to 1 over the fade width.
      const ho = Math.max(hero.l - x, x - hero.r, hero.t - y, y - hero.b);
      const outside = ho <= 0 ? 0 : ho >= fade ? 1 : (ho / fade) ** 2 * (3 - 2 * (ho / fade));
      for (const b of outside ? boxes : []) {
        if (a === 0) break;
        const out = Math.max(b.l - x, x - b.r, b.t - y, y - b.b); // <0 inside the box
        const f = out <= 0 ? 0 : out >= fade ? 1 : (out / fade) ** 2 * (3 - 2 * (out / fade));
        a *= 1 - (1 - f) * outside;
      }
      const i = y * s + x;
      alpha[i] = a; dist[i] = d;
    }
  }
  const shape = { alpha, dist, boxes, hero };
  shapes.set(key, shape);
  return shape;
}

export async function blendHead({ scene, raw, generated, crop, head, W, H, avoid = [] }) {
  const s = crop.width;
  const next = await sharp(generated).resize(s, s, { fit: "fill", kernel: "cubic" }).removeAlpha().raw().toBuffer();
  const { alpha, dist, boxes, hero } = blendShape({ crop, head, W, H, avoid });
  const sum0 = [0, 0, 0], sum1 = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < s * s; i++) {
    if (alpha[i] === 0 && dist[i] < 1.8) {
      for (let c = 0; c < 3; c++) { sum0[c] += raw[i * 3 + c]; sum1[c] += next[i * 3 + c]; }
      n++;
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

  // What the face check sees: the same crop with every other character's face
  // greyed out, so a grandmother cheek to cheek with the hero can't be judged
  // in the hero's place. The hero's own head and hair are never covered.
  let checkView = blended;
  if (boxes.length) {
    const chk = Buffer.from(out);
    for (const f of boxes) {
      // Grown by a third each way, so their hair is covered too, not just the face.
      const gx = (f.r - f.l) * 0.35, gy = (f.b - f.t) * 0.35;
      const b = { l: f.l - gx, r: f.r + gx, t: f.t - gy, b: f.b + gy * 0.5 };
      for (let y = Math.max(0, Math.floor(b.t)); y < Math.min(s, Math.ceil(b.b)); y++) {
        for (let x = Math.max(0, Math.floor(b.l)); x < Math.min(s, Math.ceil(b.r)); x++) {
          if (x >= hero.l && x <= hero.r && y >= hero.t && y <= hero.b) continue;
          const i = (y * s + x) * 3; chk[i] = chk[i + 1] = chk[i + 2] = 128;
        }
      }
    }
    checkView = await sharp(chk, info).jpeg({ quality: 80 }).toBuffer();
  }
  const page = await sharp(scene).composite([{ input: out, ...info, left: crop.left, top: crop.top }]).jpeg({ quality: 86 }).toBuffer();
  return { page, blended, checkView };
}

// Faces on the page other than the hero's, which a blend must leave alone.
export const otherFaces = (scene) => (scene.protected || []).filter((b) => /^face$/i.test(b.label || ""));
