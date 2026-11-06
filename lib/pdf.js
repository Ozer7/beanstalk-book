// ---------------------------------------------------------------------------
// The PDF. The model never draws words: they are set here in a real font, at the
// place layout.js solved for, so they're spelled right and clear of every face.
// ---------------------------------------------------------------------------
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PAGE_W, PAGE_H, FONT_BYTES, bodyWidth, wrap, visualRuns, hasHebrew } from "./layout.js";

const INK = rgb(0.106, 0.165, 0.255);
const PAPER = rgb(1, 0.985, 0.945);
const MUTED = rgb(0.34, 0.39, 0.46);
const ACCENT = { jack: rgb(0.13, 0.42, 0.26), red: rgb(0.72, 0.15, 0.2) };

// One line, drawn run by run so Hebrew and English can share it.
const fontOf = (fonts, font, heb) => (heb ? fonts.heb(font) : font);
const lineWidth = (fonts, text, font, size) => visualRuns(text).reduce((w, r) => w + fontOf(fonts, font, r.heb).widthOfTextAtSize(r.text, size), 0);
function drawLine(page, fonts, text, x, y, size, font, color) {
  for (const r of visualRuns(text)) {
    const f = fontOf(fonts, font, r.heb);
    page.drawText(r.text, { x, y, size, font: f, color });
    x += f.widthOfTextAtSize(r.text, size);
  }
}

const roundRect = (w, h, r) => `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;

export async function buildBookPdf({ story, child, pages, portrait, loadImage }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fonts = {
    body: await pdf.embedFont(FONT_BYTES.body, { subset: true }),
    bold: await pdf.embedFont(FONT_BYTES.bold, { subset: true }),
    title: await pdf.embedFont(FONT_BYTES.title, { subset: true }),
  };
  // Only a book with Hebrew in it carries the Hebrew font.
  if (Object.values(child).some(hasHebrew)) {
    fonts.hebrew = await pdf.embedFont(FONT_BYTES.hebrew, { subset: true });
    fonts.hebrewBold = await pdf.embedFont(FONT_BYTES.hebrewBold, { subset: true });
    fonts.heb = (f) => (f === fonts.body ? fonts.hebrew : fonts.hebrewBold);
  }
  pdf.setTitle(`${story.title}, starring ${child.name}`);
  pdf.setAuthor("Storybook");
  pdf.setCreator("Storybook (MCON 368)");
  pdf.setLanguage("en-US");

  for (const p of pages) await storyPage(pdf, fonts, p, await loadImage(p.image));
  await aboutMe(pdf, fonts, story, child, portrait ? await loadImage(portrait) : null);
  return Buffer.from(await pdf.save());
}

async function storyPage(pdf, fonts, p, buf) {
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const art = await pdf.embedJpg(buf);
  const { place } = p;
  if (place.mode === "framed") {
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PAPER });
    const a = place.art;
    page.drawImage(art, { x: a.left * PAGE_W, y: PAGE_H - a.bottom * PAGE_H, width: (a.right - a.left) * PAGE_W, height: (a.bottom - a.top) * PAGE_H });
  } else {
    page.drawImage(art, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
    const b = place.box;
    const w = (b.right - b.left) * PAGE_W, h = (b.bottom - b.top) * PAGE_H;
    page.drawSvgPath(roundRect(w, h, 12), { x: b.left * PAGE_W, y: PAGE_H - b.top * PAGE_H, color: PAPER, opacity: 0.93, borderWidth: 0 });
  }
  const font = place.font === "title" ? fonts.title : fonts.body;
  const b = place.box;
  const cx = ((b.left + b.right) / 2) * PAGE_W;
  const total = place.lines.length * place.lineH + (place.sub?.lineH || 0);
  let y = PAGE_H - ((b.top + b.bottom) / 2) * PAGE_H + total / 2;
  for (const line of place.lines) {
    y -= place.lineH;
    page.drawText(line.text, { x: cx - (line.width * PAGE_W) / 2, y: y + (place.lineH - place.size) * 0.62, size: place.size, font, color: INK });
  }
  if (place.sub) {
    y -= place.sub.lineH;
    drawLine(page, fonts, place.sub.text, cx - lineWidth(fonts, place.sub.text, fonts.body, place.sub.size) / 2, y + 5, place.sub.size, fonts.body, MUTED);
  }
}

const DETAILS = [["age", "Age"], ["likes", "Favourite thing to do"], ["food", "Favourite food"], ["growUp", "When I grow up"]];

async function aboutMe(pdf, fonts, story, child, portraitBuf) {
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const accent = ACCENT[story.key] || INK;
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PAPER });
  const center = (text, font, size, y, color) => drawLine(page, fonts, text, (PAGE_W - lineWidth(fonts, text, font, size)) / 2, y, size, font, color);

  const M = 48;
  const rows = DETAILS.filter(([k]) => child[k]).map(([k, label]) => ({ label, lines: wrap(child[k], bodyWidth, 13, PAGE_W - 2 * M) }));
  const more = child.more ? child.more.split(/\n+/).flatMap((para) => wrap(para, bodyWidth, 13, PAGE_W - 2 * M)) : [];
  const rowsH = rows.reduce((s, r) => s + 16 + r.lines.length * 18 + 8, 0) + (more.length ? 10 + more.length * 18 : 0);
  const fixed = 56 + 16 + 34 + 22 + 18;
  const side = Math.max(130, Math.min(290, PAGE_H - 90 - fixed - rowsH));
  let y = PAGE_H - Math.max(36, (PAGE_H - 40 - fixed - side - rowsH) / 2);

  y -= 40;
  center("About Me", fonts.title, 36, y, accent);
  y -= 16;
  if (portraitBuf) {
    const img = await pdf.embedJpg(portraitBuf);
    y -= side;
    page.drawImage(img, { x: (PAGE_W - side) / 2, y, width: side, height: side });
  }
  y -= 34;
  center(child.name, fonts.title, 26, y, INK);
  y -= 20;
  center(`starring as ${story.role}`, fonts.body, 12.5, y, MUTED);
  y -= 26;
  for (const r of rows) {
    center(r.label, fonts.bold, 10.5, y, accent);
    y -= 17;
    for (const line of r.lines) { center(line, fonts.body, 13, y, INK); y -= 18; }
    y -= 8;
  }
  if (more.length) {
    y -= 4;
    for (const line of more) { center(line, fonts.body, 13, y, INK); y -= 18; }
  }
}
