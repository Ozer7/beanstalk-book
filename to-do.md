# To do

## This homework: charge for the book
- [x] **Fund, balance, refund and process it, $0.99 per book, transaction history.** A real sandbox payment and a real refund both ran on the live site. Every credit and debit is a ledger row with its cause.
- [x] **20 pages plus About Me, from one template.** Both stories fill in the same slots (`lib/template.js`).
- [x] **Character bible in the database**, with pictures edited into every scene. Public at `/bible`.
- [x] **Scenes pre-generated for both stories.**
- [x] **Under 60 seconds.** Measured on Render Starter: 34, 36 and 36 seconds with redos; 51 seconds with a page that used all 3 tries. There is a hard time limit, so a slow redo is dropped and the book still lands on time.
- [x] **Named progress stages, thumbnails as each page finishes.**
- [x] **Still there tomorrow.** Images live in Postgres; the PDF is rebuilt from them. A book from hours earlier downloaded in 2 seconds.
- [x] **Quality loop.** Every generated image is analysed, redone up to 3 generations, and the best is kept.
- [x] **Words never on a face.** The faces come from a painted mask, not a guess, and the words are placed to clear them. If nothing clears, the art is framed and the words go below it.

## Defects I know about
- **Stand-in's hair: fixed.** Every stand-in has its hair cropped short in the stored art, and the check asks a direct yes-or-no about hair that isn't the reader's. Jack page 13 had a comic tuft floating above the head, just past the blend oval, so all 3 tries kept it (55, 55, 55). The blend now reaches higher above the head, with a squarer top, and skips other characters' faces; that page was trimmed again. Next book: page 13 scored 92 on the first try, whole book 37 seconds.
- **Half-changed and pasted-looking faces: fixed.** Jack page 20 kept half the stand-in's face (his cartoon eye) because the cow's face box, which the blend protects, overlapped the hero's cheek. Other faces are now protected only outside the hero's own head. The face check also asks two more yes-or-no questions: is any part of the stand-in still showing, and does the face look like a pasted photo. It no longer marks a page down for looking painted rather than like the photo. Next book: 27 seconds, every page passed first time, pages 2 and 20 clean.
- **Tested with one person's photo.** No child, long hair, dark skin, or head covering other than a kippah has been tried yet. That is the biggest open risk to likeness.
- **Page 12 in Jack is the hardest page.** Jack's head is small in the pot, and it used all 3 tries in one run. The loop handles it, but it's the likeliest page to keep a so-so best-of-three.
- **Body boxes from the vision model can be wrong.** Faces come from a painted mask and are exact; bodies don't. A page that can't fit its words gets up to two more looks, and the fallback layout can't put words on a face.

## Cost and limits
- **Render Starter is needed ($7 a month).** On the free plan the book took 43 to 55 seconds and redos didn't fit.
- **The test card is free money, but images aren't.** So there is a limit of 10 books per account and 60 across the site per day.
- **Neon free tier is 0.5 GB.** A book is about 7 MB of pictures, so that's about 60 books. Old books should move to object storage.
- **Books can't start for a short while after a deploy**, while the art loads into memory.

## Next
- **Delete an account** from the app. Deleting a book already works, from the shelf.
- **Hebrew in the story text.** Names and About Me print in Hebrew now (checked in a live PDF, right to left); the 20 pages of story are still English.
- **`book.bluebid.online` is a forward.** It opens the site, but the address bar shows the onrender.com address, because Render's workspace plan allows 2 custom domains and the two earlier homeworks use them.
- **Print quality.** 1024x1536 on a 6x9 in page is about 170 dpi: fine on screen, soft in print.
- **Stripe webhooks**, if this moves off the class's shared account.
