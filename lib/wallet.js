// ---------------------------------------------------------------------------
// Accounts and money. The ledger is the truth: one row per credit or debit, and
// the balance is their sum. Stripe (sandbox only) moves the test money in and
// out. No webhooks: the class shares one Stripe account, so the app asks Stripe
// about its own Checkout sessions when the reader returns from paying.
// ---------------------------------------------------------------------------
import Stripe from "stripe";
import * as db from "./db.js";
import { log } from "./log.js";

export const BOOK_CENTS = 99;
export const MIN_FUND = 100;
export const MAX_FUND = 10_000;

let stripeClient = null;
function stripe() {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw httpError(503, "Payments aren't set up on this server yet.");
  if (!key.startsWith("sk_test_")) throw httpError(500, "This app only runs on a Stripe sandbox key.");
  const { STRIPE_API_HOST: host, STRIPE_API_PORT: port, STRIPE_API_PROTOCOL: protocol } = process.env;
  stripeClient = new Stripe(key, host ? { host, port, protocol } : {});
  return stripeClient;
}

function httpError(status, message) { return Object.assign(new Error(message), { status, expose: true }); }

const lockUser = (c, userId) => c.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [userId]);
const balanceIn = async (c, userId) => Number((await c.query(`SELECT COALESCE(SUM(cents),0) AS b FROM ledger WHERE user_id=$1`, [userId])).rows[0].b);

export async function balance(userId) {
  return Number((await db.q(`SELECT COALESCE(SUM(cents),0) AS b FROM ledger WHERE user_id=$1`, [userId])).rows[0].b);
}

// Stripe Checkout: the reader pays on Stripe's page and comes back.
export async function startFunding({ userId, email, cents, origin }) {
  if (!Number.isInteger(cents) || cents < MIN_FUND || cents > MAX_FUND) throw httpError(400, "Add between $1 and $100.");
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: email || undefined,
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: cents, product_data: { name: "Storybook account credit" } } }],
    success_url: `${origin}/?funded={CHECKOUT_SESSION_ID}#/money`,
    cancel_url: `${origin}/#/money`,
    metadata: { app: "storybook", user_id: String(userId) },
  });
  await db.q(`INSERT INTO payments (user_id, stripe_session, cents) VALUES ($1,$2,$3)`, [userId, session.id, cents]);
  log.info({ event: "fund.start", user: userId, cents }, "checkout started");
  return { url: session.url };
}

// Ask Stripe whether one Checkout session was paid; credit it exactly once.
export async function confirmPayment(userId, sessionId) {
  const { rows } = await db.q(`SELECT * FROM payments WHERE user_id=$1 AND stripe_session=$2`, [userId, sessionId]);
  const payment = rows[0];
  if (!payment) throw httpError(404, "That payment isn't yours.");
  if (payment.status === "paid") return false;
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== "paid") {
    if (session.status === "expired") await db.q(`UPDATE payments SET status='expired' WHERE id=$1`, [payment.id]);
    return false;
  }
  const cents = session.amount_total;
  return db.tx(async (c) => {
    await lockUser(c, userId);
    const up = await c.query(`UPDATE payments SET status='paid', stripe_intent=$2, cents=$3, paid_at=now() WHERE id=$1 AND status<>'paid'`, [payment.id, session.payment_intent, cents]);
    if (!up.rowCount) return false;
    await c.query(`INSERT INTO ledger (user_id, cents, kind, cause, payment_id, unique_ref) VALUES ($1,$2,'deposit',$3,$4,$5) ON CONFLICT (unique_ref) DO NOTHING`,
      [userId, cents, `Added money with Stripe (${session.payment_intent})`, payment.id, `deposit:${session.id}`]);
    log.info({ event: "fund.paid", user: userId, cents }, "account funded");
    return true;
  });
}

// Catch payments whose reader closed the tab before coming back.
export async function syncOpenPayments(userId) {
  const { rows } = await db.q(`SELECT stripe_session FROM payments WHERE user_id=$1 AND status='open' AND created_at > now() - interval '24 hours' LIMIT 5`, [userId]);
  await Promise.all(rows.map((r) => confirmPayment(userId, r.stripe_session).catch((err) => log.warn({ err: err.message }, "payment sync failed"))));
}

// Refund: request first (the money leaves the balance at once, so it can't also
// buy a book), then process with Stripe. If Stripe says no, the money comes back.
export async function requestRefund({ userId, paymentId, cents, reason }) {
  const refund = await db.tx(async (c) => {
    await lockUser(c, userId);
    const { rows } = await c.query(`SELECT * FROM payments WHERE id=$1 AND user_id=$2 AND status='paid'`, [paymentId, userId]);
    const payment = rows[0];
    if (!payment) throw httpError(404, "That payment can't be refunded.");
    const refunded = Number((await c.query(`SELECT COALESCE(SUM(cents),0) AS s FROM refunds WHERE payment_id=$1 AND status IN ('requested','processed')`, [paymentId])).rows[0].s);
    const bal = await balanceIn(c, userId);
    const max = Math.min(payment.cents - refunded, bal);
    if (max <= 0) throw httpError(400, "There's nothing left to refund on this payment.");
    const amount = cents == null ? max : cents;
    if (!Number.isInteger(amount) || amount < 50) throw httpError(400, "The smallest refund is $0.50.");
    if (amount > max) throw httpError(400, `You can get back at most $${(max / 100).toFixed(2)} from this payment: what's left of it, up to your balance.`);
    const ins = await c.query(`INSERT INTO refunds (user_id, payment_id, cents, reason) VALUES ($1,$2,$3,$4) RETURNING *`, [userId, paymentId, amount, String(reason || "").slice(0, 300) || null]);
    await c.query(`INSERT INTO ledger (user_id, cents, kind, cause, payment_id, refund_id) VALUES ($1,$2,'refund',$3,$4,$5)`,
      [userId, -amount, `Refund requested #${ins.rows[0].id}`, paymentId, ins.rows[0].id]);
    return { ...ins.rows[0], stripe_intent: payment.stripe_intent };
  });
  log.info({ event: "refund.requested", user: userId, refund: refund.id, cents: refund.cents }, "refund requested");
  return processRefund(refund);
}

export async function processRefund(refund) {
  try {
    const r = await stripe().refunds.create(
      { payment_intent: refund.stripe_intent, amount: refund.cents, metadata: { app: "storybook", refund_id: String(refund.id) } },
      { idempotencyKey: `storybook-refund-${refund.id}` }
    );
    await db.q(`UPDATE refunds SET status='processed', stripe_refund=$2, processed_at=now() WHERE id=$1`, [refund.id, r.id]);
    await db.q(`UPDATE ledger SET cause=$2 WHERE refund_id=$1 AND kind='refund'`, [refund.id, `Refund #${refund.id} sent back to your card (${r.id})`]);
    log.info({ event: "refund.processed", refund: refund.id, stripe: r.id }, "refund processed");
    return { id: refund.id, status: "processed", cents: refund.cents, stripeRefund: r.id };
  } catch (err) {
    await db.tx(async (c) => {
      await c.query(`UPDATE refunds SET status='failed', error=$2, processed_at=now() WHERE id=$1`, [refund.id, err.message]);
      await c.query(`INSERT INTO ledger (user_id, cents, kind, cause, payment_id, refund_id, unique_ref) VALUES ($1,$2,'refund_reversed',$3,$4,$5,$6)`,
        [refund.user_id, refund.cents, `Refund #${refund.id} failed, money back in your balance`, refund.payment_id, refund.id, `reversal:${refund.id}`]);
    });
    log.error({ event: "refund.failed", refund: refund.id, err: err.message }, "refund failed");
    throw httpError(502, "Stripe couldn't process that refund, so the money is back in your balance. Try again in a minute.");
  }
}

// One book: charge and create in the same transaction, so it's never one without the other.
export async function chargeForBook({ userId, story, storyTitle, child }) {
  return db.tx(async (c) => {
    await lockUser(c, userId);
    const bal = await balanceIn(c, userId);
    if (bal < BOOK_CENTS) throw httpError(402, "Your balance is too low. A book costs $0.99.");
    const { rows } = await c.query(`INSERT INTO books (user_id, story, child) VALUES ($1,$2,$3) RETURNING *`, [userId, story, child]);
    const book = rows[0];
    await c.query(`INSERT INTO ledger (user_id, cents, kind, cause, book_id, unique_ref) VALUES ($1,$2,'book',$3,$4,$5)`,
      [userId, -BOOK_CENTS, `Book #${book.id}: ${storyTitle}, starring ${child.name}`, book.id, `book:${book.id}`]);
    return book;
  });
}

export async function refundFailedBook({ userId, bookId }) {
  await db.q(`INSERT INTO ledger (user_id, cents, kind, cause, book_id, unique_ref) VALUES ($1,$2,'book_refund',$3,$4,$5) ON CONFLICT (unique_ref) DO NOTHING`,
    [userId, BOOK_CENTS, `Book #${bookId} couldn't be made, so you weren't charged`, bookId, `book-refund:${bookId}`]);
}

// The history page: every credit and debit, what caused it, and the running balance.
export async function history(userId) {
  const { rows } = await db.q(
    `SELECT l.id, l.cents, l.kind, l.cause, l.book_id, l.created_at, SUM(l.cents) OVER (ORDER BY l.id) AS balance_after
     FROM ledger l WHERE l.user_id=$1 ORDER BY l.id DESC LIMIT 500`, [userId]);
  const payments = await db.q(
    `SELECT p.id, p.cents, p.paid_at, p.stripe_intent,
       COALESCE((SELECT SUM(r.cents) FROM refunds r WHERE r.payment_id=p.id AND r.status IN ('requested','processed')),0)::int AS refunded
     FROM payments p WHERE p.user_id=$1 AND p.status='paid' ORDER BY p.id DESC`, [userId]);
  const refunds = await db.q(`SELECT id, payment_id, cents, reason, status, stripe_refund, error, requested_at, processed_at FROM refunds WHERE user_id=$1 ORDER BY id DESC`, [userId]);
  return {
    balance: rows[0] ? Number(rows[0].balance_after) : 0,
    ledger: rows.map((r) => ({ id: Number(r.id), cents: r.cents, kind: r.kind, cause: r.cause, bookId: r.book_id, at: r.created_at, balanceAfter: Number(r.balance_after) })),
    payments: payments.rows,
    refunds: refunds.rows,
    bookCents: BOOK_CENTS,
  };
}
