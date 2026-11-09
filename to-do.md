# To do

## This homework: charge for the book
- [x] **Fund, balance, refund and process it, $0.99 per book, transaction history.** A real sandbox payment and a real refund both ran on the live site. Every credit and debit is a ledger row with its cause.
- [x] **20 pages plus About Me, from one template.** Both stories fill in the same slots (`lib/template.js`).
- [x] **Character bible in the database**, with pictures edited into every scene. Public at `/bible`.
- [x] **Scenes pre-generated for both stories.**
- [x] **Under 60 seconds.** Measured on Render Starter: 34, 36 and 36 seconds with redos; 51 seconds with a page that used all 3 tries. There is a hard time limit, so a slow redo is dropped and the book still lands on time.
- [x] **Named progress stages, thumbnails as each page finishes.**
- [x] **Still there tomorrow.** Images live in Postgres; the PDF is rebuilt from them. A book from hours earlier downloaded in 2 seconds.
- [x] **Quality loop, visible.** Every generated image is analysed, redone up to 3 generations, and the best is kept. Every picture shows its try count out of 3 (a ★ when none passed and the best was kept): live on the painting screen, on the reader's thumbnails, and under the page being read.
- [x] **What a book costs to make.** Every OpenAI call (image edits, retries, analysis checks, the photo description) is priced from its token counts at OpenAI's published rates and logged per book in `api_calls` (`lib/cost.js`). The purse shows the average against the $0.99 price. Measured: $0.541 a book over the first 2 books (first tries $0.490, retries $0.016, checks $0.035).
- [x] **Self-review.** `storybook-review` runs 1–3 scored 98, 94 and 99 (`review-log.md`), each with an unfamiliar AI-generated face. Run 2 found pasted-looking faces, likeness drift between pages, a check that judged the wrong face, and OpenAI rate limits on back-to-back books; all four are fixed in run 3.
- [x] **Words never on a face.** The faces come from a painted mask, not a guess, and the words are placed to clear them. If nothing clears, the art is framed and the words go below it.

## Defects I know about
- **Stand-in's hair: fixed.** Every stand-in has its hair cropped short in the stored art, and the check asks a direct yes-or-no about hair that isn't the reader's. Jack page 13 had a comic tuft floating above the head, just past the blend oval, so all 3 tries kept it (55, 55, 55). The blend now reaches higher above the head, with a squarer top, and skips other characters' faces; that page was trimmed again. Next book: page 13 scored 92 on the first try, whole book 37 seconds.
- **Half-changed and pasted-looking faces: fixed.** Jack page 20 kept half the stand-in's face (his cartoon eye) because the cow's face box, which the blend protects, overlapped the hero's cheek. Other faces are now protected only outside the hero's own head. The face check also asks two more yes-or-no questions: is any part of the stand-in still showing, and does the face look like a pasted photo. It no longer marks a page down for looking painted rather than like the photo. Next book: 27 seconds, every page passed first time, pages 2 and 20 clean.
- **Faces still a little realistic on the biggest heads.** Pages copy a painted portrait now (it was the photo, which made faces look pasted in), and the portrait is painted in the style of the story's own hero. Close-ups (Red pp. 8, 14) still read a little more realistic than the paint around them. Next: portrait at medium quality.
- **Portrait first costs time.** Pages wait up to 20 s for the painted portrait, so a book with retries takes 45–53 s instead of 35–45 s. Still under 60, with less margin.
- **Likeness on unfamiliar photos.** Review run 1 used an AI-generated girl with long curly hair: both books came out recognisably her, long hair included. On Red p9 and Jack p11 she read a little older, and the check passed them; it now marks down a face that looks a different age. Dark skin and head coverings other than a kippah are still untried.
- **Small type on short bands.** When a page's clear band is short, the words shrink (Red p2 went down to about 16 pt). Legible, but smaller than the rest of the book.
- **Page 12 in Jack is the hardest page.** Jack's head is small in the pot, and it used all 3 tries in one run. The loop handles it, but it's the likeliest page to keep a so-so best-of-three.
- **Body boxes from the vision model can be wrong.** Faces come from a painted mask and are exact; bodies don't. A page that can't fit its words gets up to two more looks, and the fallback layout can't put words on a face.

## Cost and limits
- **Render Starter is needed ($7 a month).** On the free plan the book took 43 to 55 seconds and redos didn't fit.
- **The test card is free money, but images aren't.** A book costs about $0.54 to make, 55% of the $0.99 price, and each retry eats into that. So there is a limit of 10 books per account and 60 across the site per day.
- **Neon free tier is 0.5 GB.** A book is about 7 MB of pictures, so that's about 60 books. Old books should move to object storage.
- **Books can't start for a short while after a deploy**, while the art loads into memory.

## Next
- **Delete an account** from the app. Deleting a book already works, from the shelf.
- **Hebrew in the story text.** Names and About Me print in Hebrew now (checked in a live PDF, right to left); the 20 pages of story are still English.
- **`book.bluebid.online` is a forward.** It opens the site, but the address bar shows the onrender.com address, because Render's workspace plan allows 2 custom domains and the two earlier homeworks use them.
- **Print quality.** 1024x1536 on a 6x9 in page is about 170 dpi: fine on screen, soft in print.
- **Stripe webhooks**, if this moves off the class's shared account.
