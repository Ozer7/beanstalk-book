# Review log

Every run of the `storybook-review` skill against the live site, oldest first. Entries are never edited or deleted.

## Run 1 — 2026-11-08 — reviewer: self — browser: Claude's built-in browser
Total 98 (first run)
PDF 39/40 · UI 20/20 · Money 19/20 · Engineering 20/20
Upload 18:26:19 → PDF 18:26:56 (37.6 s), Little Red Riding Hood, book #14 (one page repainted: p18 passed on try 2 of 3)
Upload 18:28:40 → PDF 18:29:03 (22.6 s), Jack and the Beanstalk, book #15 (every page passed on try 1)
Balance: 8.13 → fund 5.00 → 13.13 → generate 12.14 → generate 11.15 → refund 5.00 → 6.15 → refund 5.50 → 0.65 → generate refused (402, "Your balance is $0.65 and a book costs $0.99, so nothing was charged"), balance stays 0.65
Avg cost per book: $0.541 over 2 books (price $0.99): first tries $0.490, retries and checks the rest; cheapest $0.536, dearest $0.547
Photo: an AI-generated face from thispersondoesnotexist.com (a girl with long curly hair), never used in development. Name "Lily", girl, About Me: 8, drawing horses, pancakes, a vet.
Not measured: none. Deviations: the built-in browser has no private window, so the run started signed in and the sign-out / sign-in step was done in the same tab; the builder entered the 4242 test card on Stripe's page (the reviewer may not type card numbers), and the balance before and after was recorded.
Changed since last run: first run. Added for this run: API cost per book (every image call, retry and analysis check priced from token counts and shown against $0.99 in the purse) and the attempt count on every picture (live on the painting screen, on reader thumbnails, and under the page).

Evidence, line by line:
- PDF. Each PDF has 21 pages: 20 story pages plus About Me (pdf.js page count; text extracted from every page). Same 20-slot template in both: text zones match page for page except p13 (Jack bottom, Red top) and p17 (Jack middle, Red top), where the solver moved the words off the art. The child is the same girl on pp. 1, 10, 20 of both books, with her long curly hair on every page. Text over a face: none on any of the 42 pages, checked one by one. At 400% (Red p2, Jack p17, Jack p21) the letters are real type (Andika, Fraunces), crisp, and selectable. Story in order, complete. About Me shows "Lily", "starring as Little Red/Jack", and the four details entered.
- UI. Home loaded in 0.42 s (navigation timing, including the book.bluebid.online redirect). The progress bar names each stage: "Reading your photo", "Painting you into the pages: 9 of 20 done", "Repainting 1 page that didn't pass the check", "Binding your PDF". Thumbnails landed one at a time from 7.9 s to 24.9 s. Each slot showed "try 1/3" live and "try 2/3" on p18 while it was repainted. Balance in the top bar on every screen. History is one click away (the purse), dated, with cause and running balance. At 400 px the upload form works with no sideways scroll. Too little money: the form shows "A book costs $0.99, and your balance is $0.65" and an Add money button instead of the make button.
- Money. Funding: +$5.00 (pi_3UZfP2D77uFrOgI50TR1wiIt). Each book: exactly −$0.99. Refunds: $5.00 (re_3UZfP2D77uFrOgI50A2Vtqpr) and $5.50 processed at once; the balance updated without a reload. History: 21 rows, each with cause, amount and timestamp; they sum to the $0.65 balance, and every running balance checks.
- Engineering. Both books in under 60 s (37.6 s, 22.6 s). Signed out: PDFs refused (401). Signed back in: book #9 from Nov 6 downloads (6.8 MB, 1.6 s). The character bible is in Postgres and served by /bible.json. The attempt count is on every picture; book #10 p13 shows "3/3 ★" with "All 3 tries had problems: kept the best, try 1, check score 55". No keys in any commit, in .env history, or in the page source.

Fix first:
1. Cost card splits don't add up: retries ($0.033) and checks are averaged only over books that had them, so first tries + retries + checks ($0.558) is more than the $0.541 average (lib/db.js costSummary; Money, −1)
2. Likeness drifts on a few pages: Lily reads older and her eyes differ on Red p9 and Jack p11 (both scored as passes by the check) (PDF, −1)
3. At 400 px the header breaks into three lines: the balance pill floats above the logo and "Sign out" sits on its own line (public/index.html header; UI, 0 but looks unfinished)
4. Red p2 words are set smaller than the other pages (the top band is short), and the About Me labels are about 7 pt: legible, but the smallest type in the book (lib/layout.js, lib/pdf.js; PDF, 0)
5. Cost is 55% of the price ($0.54 of $0.99), and every retry eats into it; worth knowing before pricing changes (no points)
