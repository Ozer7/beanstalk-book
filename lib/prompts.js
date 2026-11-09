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
export function facePrompt({ story, page, description, from = "photo", problems }) {
  return [
    `IMAGE 1 is a square crop from a painted picture-book page. The character at the centre is ${story.role}.`,
    from === "portrait"
      ? `IMAGE 2 is the person who plays ${story.role}, already painted in this book's style. Copy their face from IMAGE 2 as a painting, with the same simple, soft brushwork: not more detailed or realistic than IMAGE 2.`
      : `IMAGE 2 is a photo of the real person who plays ${story.role}. Translate their face into a painting; never copy the photo's realism.`,
    `Repaint only the head of the character at the centre so that it is unmistakably this person: ${description}. Keep their real face shape, eyes, nose, mouth, ears, skin tone, hair and hairline, and glasses or facial hair if they have them. Remove the character's original hair completely: only this person's own hair may remain, with plain background where the old hair was, including any loose strands or tufts drawn above the head. Replace the whole old head, including its eyes, cheeks and ears: if this person's head is narrower, paint background where the old ears, cheeks and hair were, so that no outline or part of the old head shows beside the new one.`,
    `Keep in exactly the same place and at the same size: the head's position, tilt and direction. Expression: ${page.mood}. Change only the eyebrows, eyes and mouth for the expression.`,
    `Paint the head in the same style as the rest of IMAGE 1, with the same brushwork and the same level of detail as the other faces on the page: a painted picture-book face, never photographic. ${STYLE}`,
    `Do not change anything else: same clothes${story.key === "red" ? ", same red hood and cape" : ""}, body, hands, other characters, background, colours and light.`,
    ...(problems?.length ? [`A previous try had these problems, so avoid them: ${problems.join("; ")}.`] : []),
    NO_TEXT,
  ].join("\n\n");
}

// The reader painted as the hero, for the About Me page.
export function portraitPrompt({ story, hasStyle }) {
  const hero = story.cast[story.hero];
  const clothes = hero.description.split("Wears ")[1] || "";
  return [
    `IMAGE 1 is a photo of a real person who plays ${story.role} in a picture book. Paint a close-up portrait of them. Show only the head, neck and shoulders, with the head filling most of the picture. Do not show the body below the chest.`,
    hasStyle ? `IMAGE 2 is ${story.role} as already painted in this book. Paint the person from IMAGE 1 in exactly IMAGE 2's style: the same soft gouache brushwork, the same simple shapes for eyes, nose and mouth, the same level of detail and the same warm colours. Take only the style from IMAGE 2, never the face: the face, hair and glasses are all from IMAGE 1.` : "",
    "Keep their real face shape, eyes, nose, mouth, ears, skin tone, hair and hairline, and glasses or facial hair if they have them, so that anyone who knows them recognizes them at once.",
    "It must read as a painting in a children's picture book, never as a photo: no photographic skin texture, pores or sharp detail; soft, simplified, hand-painted.",
    `They wear: ${clothes}. Warm, friendly smile. Soft plain warm-paper background.`,
    `STYLE: ${STYLE}`,
    `RULES: one person. ${NO_TEXT}`,
  ].filter(Boolean).join("\n\n");
}

// Pre-generated art: crop the stand-in's hair, so nothing of it can outlast a
// reader's own shorter hair. Their own hair is painted on top, whatever its length.
export function trimPrompt(story) {
  return [
    `This is a square crop of a painted picture-book page. Repaint only the hair of the child at the centre, ${story.role}: make it very short and close-cropped to the scalp all the way round, so that no hair sticks out beyond the outline of the skull. Remove any loose strands, wisps or tufts drawn above or around the head too (for example lines showing surprise).`,
    `Where the old hair was, continue the background seamlessly.${story.key === "red" ? " The red hood stays resting on the shoulders." : ""}`,
    `Keep the same face, head position and size, clothes, body, hands, other characters, background, colours and light. Same style: ${STYLE}`,
    NO_TEXT,
  ].join("\n\n");
}
