// ---------------------------------------------------------------------------
// The eyes of the quality loop. A vision model looks at every generated image
// and returns a score, the problems it sees, and (for scenes) a box around every
// face and everything the page needs you to see. The words are laid out around
// those boxes, in layout.js.
// ---------------------------------------------------------------------------
import OpenAI from "openai";
import { MOCK } from "./images.js";
import { log } from "./log.js";
import { record, MOCK_USAGE } from "./cost.js";

export const CHECK_MODEL = process.env.CHECK_MODEL || "gpt-5.4-mini";
export const PASS_SCORE = 75;

let client = null;
const openai = () => (client ??= new OpenAI({ maxRetries: 1, timeout: 45_000 }));
const url = (buf) => `data:image/jpeg;base64,${buf.toString("base64")}`;

async function ask({ text, images, schema, name, detail = "high" }) {
  const res = await openai().responses.create({
    model: CHECK_MODEL,
    reasoning: { effort: "low" },
    input: [{ role: "user", content: [{ type: "input_text", text }, ...images.map((b) => ({ type: "input_image", detail, image_url: url(b) }))] }],
    text: { format: { type: "json_schema", name, schema, strict: true } },
  });
  record({ model: CHECK_MODEL, usage: res.usage, kind: "check" });
  return JSON.parse(res.output_text);
}

const BOX = {
  type: "object", additionalProperties: false, required: ["label", "left", "top", "right", "bottom"],
  properties: { label: { type: "string" }, left: { type: "number" }, top: { type: "number" }, right: { type: "number" }, bottom: { type: "number" } },
};
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

// A pre-generated scene: is it right, and where is everything?
export async function analyseScene(image, { story, page }) {
  if (MOCK) return { score: 90, problems: [], head: page.hero ? { left: 0.36, top: 0.42, right: 0.64, bottom: 0.58 } : null, protected: [{ label: "head", left: 0.36, top: 0.42, right: 0.64, bottom: 0.58 }] };
  const out = await ask({
    name: "scene_check",
    images: [image],
    schema: obj({
      score: { type: "integer" },
      problems: { type: "array", items: { type: "string" } },
      hero_head: { anyOf: [BOX, { type: "null" }] },
      faces: { type: "array", items: BOX },
      important: { type: "array", items: BOX },
    }),
    text: [
      `A page of a painted picture book, ${story.title}. Scene: ${page.scene}`,
      page.hero ? `The hero, ${story.role}, should be: ${page.hero}.` : `The hero, ${story.role}, is not on this page.`,
      "Give a quality score from 0 to 100. Score under 30 if any face or skin is a blank, flat, featureless silhouette. Take off a lot for: drawn letters or numbers, a hand with the wrong number of fingers, melted or doubled body parts, the hero appearing twice or with a hidden face, or anything the scene asks for being missing or wrong (count things when the scene gives a number). List each problem in a few words.",
      "Give boxes as fractions of the picture from 0 to 1, measured from the top-left corner, drawn tightly:",
      `- hero_head: the hero's whole head including hair${story.key === "red" ? " and hood" : ""}, or null if the hero isn't on the page.`,
      "- faces: every face in the picture, of people and animals, including the hero.",
      `- important: every whole person or animal in the picture, plus these things: ${page.keep.join(", ")}. Never box background: no sky, clouds, ground, grass, floor, road, walls, fields, or forest.`,
    ].join("\n"),
  });
  const clamp = (b) => b && ({ label: b.label, left: cl(b.left), top: cl(b.top), right: cl(b.right), bottom: cl(b.bottom) });
  return {
    score: out.score, problems: out.problems, head: clamp(out.hero_head),
    protected: [...out.faces, ...out.important].map(clamp),
  };
}
const cl = (n) => Math.min(1, Math.max(0, Number(n) || 0));

// A tighter hero head box, from a crop around the first guess.
export async function refineHead(crop, { story }) {
  if (MOCK) return null;
  const out = await ask({
    name: "head_box", images: [crop], schema: BOX,
    text: `This is a crop of a painted picture-book page. Draw a tight box around ${story.role}'s whole head including hair${story.key === "red" ? " and hood" : ""}. Fractions of this crop from 0 to 1, from the top-left. Label it "head".`,
  });
  return { left: cl(out.left), top: cl(out.top), right: cl(out.right), bottom: cl(out.bottom) };
}

// A bible picture: one clean figure?
export async function analyseCharacter(image, { story, key }) {
  if (MOCK) return { score: 90, problems: [] };
  const c = story.cast[key];
  return ask({
    name: "character_check", images: [image],
    schema: obj({ score: { type: "integer" }, problems: { type: "array", items: { type: "string" } } }),
    text: `Character design for a picture book: ${c.name}, ${c.description}. Score 0 to 100. Score under 30 if the face or any skin is a blank, flat, featureless silhouette. Take off a lot for: more than one figure, drawn text, wrong hands, a figure cut off by the edge, or not matching the description. List each problem in a few words.`,
  });
}

// One generated head, back in its crop: does it look like the person and blend in?
export async function analyseFace(crop, photo, { story, page }) {
  if (MOCK) {
    record({ model: CHECK_MODEL, usage: MOCK_USAGE.check, kind: "check" });
    const fail = process.env.MOCK_FAIL_PAGES?.split(",").includes(String(page.n));
    return { score: fail ? 40 : 88, problems: fail ? ["mock failure"] : [] };
  }
  const out = await ask({
    name: "face_check", images: [crop, photo],
    schema: obj({ extra_hair: { type: "boolean" }, leftover: { type: "boolean" }, photographic: { type: "boolean" }, score: { type: "integer" }, problems: { type: "array", items: { type: "string" } } }),
    text: [
      "Answer three yes-or-no questions first. The page was painted with a different, made-up character, and their head was then repainted as the person in the photo. Look for anything left over from that first character.",
      "extra_hair: look closely all round the head. Is there any hair, tuft or lock that doesn't belong to the person in the photo, or a second layer of hair sticking out behind or above their own? Be strict: true if in any doubt.",
      "leftover: is any other part of the first character still showing? For example a second ear, a cheek, jaw or hair edge peeking out beside the face, a ghostly outline around the head, or the first character's own features mixed into this face (big round cartoon eyes, rosy child's cheeks, a child's hair) where the person's should be, or one half of the face different from the other (one eye still a cartoon eye, glasses on one side only). Be strict: true if in any doubt.",
      "photographic: does the face look like a photograph pasted onto the painting, clearly more realistic, sharper or more detailed than the other faces and the rest of the page?",
      `Image 1 is a crop of a painted picture-book page. The character at the centre is meant to be the person in the photo (image 2), painted in the book's style, with this expression: ${page.mood}. Flat grey rectangles hide other characters' faces so that you judge only this one: ignore them, they are not part of the page.`,
      "Score from 0 to 100. Start at 100 and take off:",
      "- up to 50 if someone who knows the person wouldn't recognize them at once (face shape, eyes, hair, and glasses or beard if they have them);",
      "- up to 25 if the face looks a different age from the person in the photo, or their eyes, nose or face shape have drifted from the photo;",
      "- up to 40 for a visible seam, a head that doesn't match the neck or body, a face painted in a different style from the page, or a head the wrong size;",
      "- 80 if the face or skin is a blank, flat, featureless shape;",
      "- 40 if the hair is not the person's: different length or style, or tufts of other hair sticking out around the head;",
      "- up to 40 for a distorted face, extra eyes or other broken anatomy, or drawn letters;",
      "- up to 15 for the wrong expression.",
      "Do not take anything off because the painting looks different from the photo: it is meant to be painted, not photographic.",
      "List each problem in a few words.",
    ].join("\n"),
  });
  // Direct yes-or-no questions catch what a blended score lets through.
  if (out.extra_hair) { out.score = Math.min(out.score, 55); out.problems = [...out.problems, "hair that isn't the person's around the head"]; }
  if (out.leftover) { out.score = Math.min(out.score, 55); out.problems = [...out.problems, "part of the original character still showing (ear, cheek, hair edge or their features)"]; }
  if (out.photographic) { out.score = Math.min(out.score, 65); out.problems = [...out.problems, "face looks like a pasted photo, not painted like the page"]; }
  return out;
}

// What the person looks like, in words. Pasted into every prompt for the book.
export async function describePerson(photo) {
  if (MOCK) { record({ model: CHECK_MODEL, usage: MOCK_USAGE.check, kind: "check" }); return "a person with short dark hair"; }
  try {
    const out = await ask({
      name: "description", images: [photo], detail: "low",
      schema: obj({ description: { type: "string" } }),
      text: "This photo's owner is being drawn as a picture-book character. In one short phrase, describe only what's visible and needed to draw them: approximate age group, hair colour, length and style, head covering if any, skin tone, face shape, glasses (shape and colour) if any, facial hair if any. Don't name or identify anyone.",
    });
    return out.description;
  } catch (err) {
    log.warn({ err: err.message }, "couldn't describe the photo");
    return "the person in the photo";
  }
}
