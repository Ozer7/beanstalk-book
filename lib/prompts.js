// ---------------------------------------------------------------------------
// Prompt builders. The style line, cast descriptions and template rules are
// pasted word for word into every call, so the look can't drift between pages.
// ---------------------------------------------------------------------------
import { STYLE, NO_TEXT, shotText, zoneText } from "./template.js";

const PAINT_ALL = "Paint every character completely: real faces with eyes, nose and mouth, and natural painted skin on faces, hands, arms and legs. Never leave a blank, flat, grey or silhouetted area on anyone.";

export function biblePrompt(story, key) {
  const c = story.cast[key];
  return [
    `Character design for a picture book, ${story.title}. Draw ${c.name}: ${c.description}.`,
    `STYLE: ${STYLE}`,
    "One single figure, whole body, standing and facing the viewer, face evenly lit, on a plain warm-paper background with nothing else in it.",
    PAINT_ALL,
    `RULES: only this one character. ${NO_TEXT}`,
  ].join("\n\n");
}

// A pre-generated page. The images are the bible pictures of the cast, in order.
export function scenePrompt(story, page) {
  const refs = page.cast.map((k, i) => `IMAGE ${i + 1} is ${story.cast[k].name}: ${story.cast[k].description}.`);
  const heroName = story.cast[story.hero].name;
  return [
    `Page ${page.n} of 20 of a picture book, ${story.title}. Paint this page by editing the characters from the reference images into one new scene.`,
    refs.join("\n"),
    "Each character looks exactly like their reference: same face, colouring, proportions and clothes. Use the references only for how they look, not for their poses or plain backgrounds.",
    `STYLE: ${STYLE}`,
    `SCENE: ${page.scene}`,
    PAINT_ALL,
    ...(page.hero ? [
      `${heroName.toUpperCase()}: ${page.hero}. Expression: ${page.mood}. ${heroName} appears exactly once, with nothing covering the face.`,
      shotText(page.n),
    ] : []),
    `SPACE FOR THE WORDS: keep ${zoneText(page.n)} calm and simple, with no faces, hands or important objects in it. Words will be printed there later.`,
    `RULES: every hand has four fingers and one thumb. ${NO_TEXT}`,
  ].join("\n\n");
}

// The per-book pass. Image 1 is a crop of a finished page, centred on the hero's
// head. Image 2 is the reader's photo. Image 3, on retries, is their portrait.
export function facePrompt({ story, page, description, hasPortrait, problems }) {
  return [
    `IMAGE 1 is a square crop from a painted picture-book page. The character at the centre is ${story.role}.`,
    `IMAGE 2 is a photo of the real person who plays ${story.role}.${hasPortrait ? " IMAGE 3 is that person already painted in this book's style." : ""}`,
    `Repaint only the head of the character at the centre so that it is unmistakably this person: ${description}. Keep their real face shape, eyes, nose, mouth, ears, skin tone, hair and hairline, and glasses or facial hair if they have them.`,
    `Keep in exactly the same place and at the same size: the head's position, tilt and direction. Expression: ${page.mood}. Change only the eyebrows, eyes and mouth for the expression.`,
    `Paint the head in the same style as the rest of IMAGE 1: ${STYLE}`,
    `Do not change anything else: same clothes${story.key === "red" ? ", same red hood and cape" : ""}, body, hands, other characters, background, colours and light.`,
    ...(problems?.length ? [`A previous try had these problems, so avoid them: ${problems.join("; ")}.`] : []),
    NO_TEXT,
  ].join("\n\n");
}

// The reader painted as the hero, for the About Me page.
export function portraitPrompt({ story, description }) {
  const hero = story.cast[story.hero];
  const clothes = hero.description.split("Wears ")[1] || "";
  return [
    `IMAGE 1 is a photo of a real person who plays ${story.role} in a picture book. Paint their head-and-shoulders portrait: ${description}.`,
    "Keep their real face shape, eyes, nose, mouth, ears, skin tone, hair and hairline, and glasses or facial hair if they have them, so that anyone who knows them recognizes them at once.",
    `They wear: ${clothes}. Warm, friendly smile. Soft plain warm-paper background.`,
    `STYLE: ${STYLE}`,
    `RULES: one person. ${NO_TEXT}`,
  ].join("\n\n");
}
