// ---------------------------------------------------------------------------
// The database (Postgres; Neon in production). Tables are created on startup.
//
//   users          one row per Google account
//   images         every stored picture, with a small thumbnail beside it.
//                  user_id NULL = public art (the bible and the scenes)
//   bible          the character bible: one row per character per story
//   scenes         the pre-generated pages for both stories
//   books          a user's books: child's details, finished pages, timings
//   generation_log one row per image call: what, how long, score, attempt
//   api_calls      one row per OpenAI call: tokens and dollars, by book and attempt
//   payments       Stripe Checkout sessions
//   refunds        refund requests and what happened to them
//   ledger         every credit and debit. The balance is the sum of this table
// ---------------------------------------------------------------------------
import pg from "pg";
import { log } from "./log.js";
import { setSink } from "./cost.js";

const url = process.env.DATABASE_URL;
if (!url) { log.fatal("DATABASE_URL is not set."); process.exit(1); }

export const pool = new pg.Pool({
  connectionString: url,
  ...(/sslmode=/.test(url) ? {} : { ssl: process.env.PGSSL === "0" || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } }),
  max: 8,
  idleTimeoutMillis: 30_000,
});
pool.on("error", (err) => log.error({ err }, "postgres pool error"));
export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally { c.release(); }
}

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, google_id TEXT UNIQUE NOT NULL, email TEXT, name TEXT, picture TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      story TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', child JSONB NOT NULL DEFAULT '{}',
      description TEXT, photo_id BIGINT, portrait_id BIGINT, pages JSONB NOT NULL DEFAULT '[]',
      timing JSONB NOT NULL DEFAULT '{}', error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS books_user ON books(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS images (
      id BIGSERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      book_id INTEGER REFERENCES books(id) ON DELETE CASCADE, kind TEXT NOT NULL, page INTEGER,
      mime TEXT NOT NULL, data BYTEA NOT NULL, thumb BYTEA, meta JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS bible (
      story TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
      hash TEXT NOT NULL, image_id BIGINT NOT NULL REFERENCES images(id), meta JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (story, key));
    CREATE TABLE IF NOT EXISTS scenes (
      story TEXT NOT NULL, page INTEGER NOT NULL, hash TEXT NOT NULL,
      image_id BIGINT NOT NULL REFERENCES images(id), head JSONB, protected JSONB NOT NULL DEFAULT '[]',
      meta JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (story, page));
    CREATE TABLE IF NOT EXISTS generation_log (
      id BIGSERIAL PRIMARY KEY, user_id INTEGER, book_id INTEGER, kind TEXT NOT NULL, story TEXT, page INTEGER,
      attempt INTEGER, model TEXT, quality TEXT, status TEXT NOT NULL, score INTEGER, problems JSONB,
      error TEXT, ms INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS genlog_book ON generation_log(book_id);
    CREATE TABLE IF NOT EXISTS api_calls (
      id BIGSERIAL PRIMARY KEY, book_id INTEGER, user_id INTEGER, purpose TEXT NOT NULL, kind TEXT NOT NULL,
      model TEXT NOT NULL, attempt INTEGER, input_tokens INTEGER, output_tokens INTEGER, usd NUMERIC(12,6),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS api_calls_book ON api_calls(book_id);
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stripe_session TEXT UNIQUE NOT NULL, stripe_intent TEXT, cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS refunds (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payment_id INTEGER NOT NULL REFERENCES payments(id), cents INTEGER NOT NULL, reason TEXT,
      status TEXT NOT NULL DEFAULT 'requested', stripe_refund TEXT, error TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS ledger (
      id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cents INTEGER NOT NULL, kind TEXT NOT NULL, cause TEXT NOT NULL,
      book_id INTEGER REFERENCES books(id) ON DELETE SET NULL, payment_id INTEGER REFERENCES payments(id),
      refund_id INTEGER REFERENCES refunds(id), unique_ref TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
  `);
}

// users ---------------------------------------------------------------------
export async function upsertUser({ googleId, email, name, picture }) {
  const { rows } = await q(
    `INSERT INTO users (google_id, email, name, picture) VALUES ($1,$2,$3,$4)
     ON CONFLICT (google_id) DO UPDATE SET email=$2, name=$3, picture=$4, last_login=now()
     RETURNING id, email, name, picture, (xmax = 0) AS created`, [googleId, email, name, picture]);
  return rows[0];
}
export async function getUser(id) {
  const { rows } = await q(`SELECT id, email, name, picture FROM users WHERE id=$1`, [id]);
  return rows[0] || null;
}

// images --------------------------------------------------------------------
export async function saveImage({ userId = null, bookId = null, kind, page = null, buf, thumb = null, meta = {} }) {
  const mime = buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : "image/jpeg";
  const { rows } = await q(
    `INSERT INTO images (user_id, book_id, kind, page, mime, data, thumb, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [userId, bookId, kind, page, mime, buf, thumb, meta]);
  return Number(rows[0].id);
}
export async function imageData(id) {
  const { rows } = await q(`SELECT data FROM images WHERE id=$1`, [id]);
  return rows[0]?.data || null;
}
// A user's own picture, or public art. `thumb` picks the small version.
export async function readImage(id, userId, thumb) {
  const { rows } = await q(
    `SELECT mime, ${thumb ? "COALESCE(thumb, data)" : "data"} AS data, thumb IS NOT NULL AND $3 AS is_thumb
     FROM images WHERE id=$1 AND (user_id IS NULL OR user_id=$2)`, [id, userId ?? null, !!thumb]);
  return rows[0] || null;
}

// bible and scenes ----------------------------------------------------------
export async function bibleRows(story) {
  const { rows } = await q(`SELECT story, key, name, description, hash, image_id, meta FROM bible WHERE ($1::text IS NULL OR story=$1) ORDER BY story, key`, [story ?? null]);
  return rows;
}
export async function saveBible(r) {
  await q(`INSERT INTO bible (story, key, name, description, hash, image_id, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (story, key) DO UPDATE SET name=$3, description=$4, hash=$5, image_id=$6, meta=$7, created_at=now()`,
    [r.story, r.key, r.name, r.description, r.hash, r.imageId, r.meta]);
}
export async function sceneRows(story) {
  const { rows } = await q(`SELECT story, page, hash, image_id, head, protected, meta FROM scenes WHERE ($1::text IS NULL OR story=$1) ORDER BY story, page`, [story ?? null]);
  return rows;
}
export async function saveScene(r) {
  await q(`INSERT INTO scenes (story, page, hash, image_id, head, protected, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (story, page) DO UPDATE SET hash=$3, image_id=$4, head=$5, protected=$6, meta=$7, created_at=now()`,
    [r.story, r.page, r.hash, r.imageId, JSON.stringify(r.head), JSON.stringify(r.protected), r.meta]);
}

// books ---------------------------------------------------------------------
export async function listBooks(userId) {
  const { rows } = await q(
    `SELECT id, story, status, child, pages, timing, error, photo_id, portrait_id, created_at, finished_at FROM books WHERE user_id=$1 ORDER BY id DESC LIMIT 100`, [userId]);
  return rows;
}
export async function getBook(userId, id) {
  const { rows } = await q(`SELECT * FROM books WHERE id=$1 AND user_id=$2`, [id, userId]);
  return rows[0] || null;
}
export async function finishBook(id, { status, pages, timing, portraitId, description, error }) {
  await q(`UPDATE books SET status=$2, pages=$3, timing=$4, portrait_id=$5, description=$6, error=$7, finished_at=now() WHERE id=$1`,
    [id, status, JSON.stringify(pages ?? []), timing ?? {}, portraitId ?? null, description ?? null, error ?? null]);
}

// API spend -----------------------------------------------------------------
setSink((r) => q(`INSERT INTO api_calls (book_id, user_id, purpose, kind, model, attempt, input_tokens, output_tokens, usd)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [r.bookId, r.userId, r.purpose, r.kind, r.model, r.attempt, r.inputTokens, r.outputTokens, r.usd])
  .catch((err) => log.warn({ err: err.message }, "api cost log failed")));

/**
 * What books cost to make. Only finished books with costed calls count, so the
 * books made before costs were logged don't drag the average to zero.
 * A "retry" is any call made for attempt 2 or 3 of a picture. A book with no
 * retries counts as $0 of retries, so the three parts add up to the average.
 */
export async function costSummary(userId) {
  const { rows } = await q(`
    WITH per AS (
      SELECT c.book_id,
        SUM(c.usd) AS total,
        COALESCE(SUM(c.usd) FILTER (WHERE c.kind = 'image' AND COALESCE(c.attempt, 1) = 1), 0) AS first_tries,
        COALESCE(SUM(c.usd) FILTER (WHERE c.kind = 'image' AND c.attempt > 1), 0) AS retries,
        COALESCE(SUM(c.usd) FILTER (WHERE c.kind = 'check'), 0) AS checks,
        COUNT(*) FILTER (WHERE c.kind = 'image') AS image_calls,
        COUNT(*) FILTER (WHERE c.kind = 'image' AND c.attempt > 1) AS retry_calls,
        COUNT(*) FILTER (WHERE c.kind = 'check') AS check_calls
      FROM api_calls c JOIN books b ON b.id = c.book_id
      WHERE c.purpose = 'book' AND b.status = 'done' AND c.usd IS NOT NULL
      GROUP BY c.book_id)
    SELECT COUNT(*)::int AS books, AVG(total) AS avg, AVG(first_tries) AS first_tries, AVG(retries) AS retries, AVG(checks) AS checks,
      AVG(image_calls) AS image_calls, AVG(retry_calls) AS retry_calls, AVG(check_calls) AS check_calls, MIN(total) AS min, MAX(total) AS max
    FROM per`);
  const art = await q(`SELECT COALESCE(SUM(usd),0) AS usd, COUNT(*)::int AS calls FROM api_calls WHERE purpose = 'art'`);
  const mine = userId ? await q(`SELECT c.book_id, SUM(c.usd) AS usd FROM api_calls c JOIN books b ON b.id = c.book_id
    WHERE b.user_id = $1 AND c.purpose = 'book' GROUP BY c.book_id`, [userId]) : { rows: [] };
  const n = (x) => (x == null ? 0 : Number(x));
  const r = rows[0];
  return {
    books: r.books, avg: n(r.avg), min: n(r.min), max: n(r.max),
    parts: { firstTries: n(r.first_tries), retries: n(r.retries), checks: n(r.checks) },
    calls: { images: n(r.image_calls), retries: n(r.retry_calls), checks: n(r.check_calls) },
    art: { usd: n(art.rows[0].usd), calls: art.rows[0].calls },
    byBook: Object.fromEntries(mine.rows.map((x) => [x.book_id, n(x.usd)])),
  };
}

// generation log ------------------------------------------------------------
export async function logGen(r) {
  await q(`INSERT INTO generation_log (user_id, book_id, kind, story, page, attempt, model, quality, status, score, problems, error, ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [r.userId ?? null, r.bookId ?? null, r.kind, r.story ?? null, r.page ?? null, r.attempt ?? null, r.model ?? null, r.quality ?? null,
     r.status, r.score ?? null, r.problems ? JSON.stringify(r.problems) : null, r.error ?? null, r.ms ?? null]).catch((err) => log.warn({ err }, "generation log failed"));
}
