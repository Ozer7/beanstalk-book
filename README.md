# Storybook

A 20-page picture book starring you, in under a minute. Pick Jack and the Beanstalk or Little Red Riding Hood, upload a photo, and pay $0.99 from your account. MCON 368.

## How it works

- **One template** (`lib/template.js`): 20 page slots, each with a layout, a camera distance and a place for the words. Both stories (`stories/`) fill in the same slots.
- **Character bible** (`bible` table, public at `/bible`): every character's description and picture. Their pictures are edited into every scene.
- **Pre-generated scenes** (`scenes` table, `lib/pregen.js`): all 40 pages are painted once with a stand-in hero, checked, and stored with a box around every face and everything the page needs.
- **Your book** (`lib/pipeline.js`, `lib/face.js`): only a square around the hero's head goes to the image model, all pages at once. The new head is colour-matched and feathered back into the art.
- **Quality loop** (`lib/quality.js`, `lib/vision.js`): every generated image is analysed. A failure is regenerated, up to 3 generations in all, then the best of the three is kept.
- **Words** (`lib/layout.js`): the solver places the words so they clear every stored box, trying the template's zone first and then the others. If nothing clears, the art is framed and the words go on paper below it.
- **Money** (`lib/wallet.js`): every credit and debit is a ledger row, and the balance is their sum. Stripe sandbox only; the app refuses a live key.
- **Still there tomorrow**: images live in Postgres, and the PDF is rebuilt from them on request.

## Run it locally

```bash
npm install
cp .env.example .env   # fill it in; git ignores it
npm run dev
```

`DATABASE_URL=postgres://... npm test` runs the whole app end to end on placeholder pictures and a fake Stripe, with no API calls.

## Deploy (Render)

Build `npm install`, start `npm start`. Set the variables from `.env.example` in Render's Environment tab. The first start paints the bible and scenes, and `/bible` shows the progress. Add `https://<host>/auth/google/callback` to the Google OAuth client.
