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
- **Stand-in's hair.** The wider crop fixed it on most pages. Jack page 13 still shows a small tuft around a short-haired reader's head. A stand-in with short hair would end this, at the cost of repainting the art.
- **The quality score misses some of that.** It gave pages with leftover hair scores of 90 or more, so a pass doesn't prove a page is clean. I check by reading the book.
- **Body boxes from the vision model are unreliable.** One page had a person boxed far past her feet. Faces are exact; bodies aren't. A page that can't fit its words gets a second look.
- **Tested with one person's photo.** No child, long hair, dark skin, or head covering other than a kippah has been tried yet. That is the biggest open risk to likeness.
- **Page 12 in Jack is the hardest page.** Jack's head is small in the pot, and it used all 3 tries in one run.

## Cost and limits
- **Render Starter is needed ($7 a month).** On the free plan the book took 43 to 55 seconds and redos didn't fit.
- **The test card is free money, but images aren't.** So there is a limit of 10 books per account and 60 across the site per day.
- **Neon free tier is 0.5 GB.** A book is about 7 MB of pictures, so that's about 60 books. Old books should move to object storage.
- **Books can't start for a short while after a deploy**, while the art loads into memory.

## Next
- **About Me only prints English letters.** Hebrew needs its own font and right-to-left layout.
- **Delete a book and delete an account** from the app.
- **Print quality.** 1024x1536 on a 6x9 in page is about 170 dpi: fine on screen, soft in print.
- **Stripe webhooks**, if this moves off the class's shared account.
