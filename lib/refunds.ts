import { getStripeClient } from "@/lib/stripe";
import type { ManagedBooking } from "@/lib/booking-management";
import type { SubrequestBudget } from "@/lib/subrequest-budget";

export type RefundOutcome = "not_needed" | "refunded" | "pending";

/** Automatic attempts per refund before it waits for staff (Backstage
 * "retry refund"). Retries back off 1, 2, 4 … 64 minutes, so the last one runs
 * about four hours after the first failure. A staff retry starts a new series.
 */
export const MAX_REFUND_ATTEMPTS = 8;
/** A claimed retry outlives a slow Stripe call; a crashed worker's claim expires. */
const REFUND_CLAIM_MS = 5 * 60_000;
/** Worst-case subrequests for one retried refund: retry-record read, claim,
 * refund-record read, upsert and final write in D1, plus the Checkout Session
 * lookup and refund in Stripe. */
export const REFUND_RETRY_COST = 7;

/**
 * Refunds a paid Stripe appointment once. The appointment-scoped record and
 * Stripe idempotency key make retries safe if a request is interrupted.
 * `automatic` retries keep the attempt count; a staff or first request
 * restarts it. Every failure stays durably due for an automatic retry.
 */
export async function refundCancelledBooking(
  database: D1Database,
  booking: ManagedBooking,
  actorId: string,
  options: { automatic?: boolean } = {},
): Promise<RefundOutcome> {
  if (
    booking.payment_status !== "paid" ||
    booking.payment_method !== "stripe" ||
    !booking.stripe_checkout_session_id
  ) {
    return "not_needed";
  }

  const existing = await database
    .prepare("SELECT status FROM payment_refunds WHERE appointment_id = ?")
    .bind(booking.id)
    .first<{ status: string }>();
  if (existing?.status === "succeeded") return "refunded";

  const refundRecordId = `refund-${booking.id}`;
  await database
    .prepare(
      `INSERT INTO payment_refunds (id, appointment_id, amount_cents, status, requested_by)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT(appointment_id) DO UPDATE SET
         status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP${options.automatic ? "" : ", attempts = 0"}`,
    )
    .bind(refundRecordId, booking.id, booking.price_cents, actorId)
    .run();

  try {
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(booking.stripe_checkout_session_id);
    const paymentIntent =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    if (!paymentIntent) throw new Error("The Stripe payment could not be found.");

    const refund = await stripe.refunds.create(
      { payment_intent: paymentIntent, reason: "requested_by_customer" },
      { idempotencyKey: `appointment-refund/${booking.id}` },
    );
    await database.batch([
      database
        .prepare(
          `UPDATE payment_refunds SET stripe_refund_id = ?, status = 'succeeded',
             error = NULL, updated_at = CURRENT_TIMESTAMP WHERE appointment_id = ?`,
        )
        .bind(refund.id, booking.id),
      database
        .prepare(
          `UPDATE appointments SET payment_status = 'refunded', revision = revision + 1
           WHERE id = ? AND status = 'cancelled' AND payment_status = 'paid'`,
        )
        .bind(booking.id),
    ]);
    return "refunded";
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Refund failed";
    // Count the attempt and schedule the next automatic one (retryDueRefunds).
    await database
      .prepare(
        `UPDATE payment_refunds SET status = 'failed', error = ?, attempts = attempts + 1,
           next_attempt_at = ? + MIN(1 << MIN(attempts, 6), 64) * 60000, updated_at = CURRENT_TIMESTAMP
         WHERE appointment_id = ?`,
      )
      .bind(message, Date.now(), booking.id)
      .run();
    console.error("Automatic Stripe refund failed", booking.reference, error);
    return "pending";
  }
}

/** Refund statement for a cancellation's own transaction: the refund becomes
 * durably due in the same commit that cancels the paid booking, so a crash
 * before the Stripe call can never strand it. */
export function recordRefundDue(database: D1Database, booking: ManagedBooking, actorId: string) {
  return database.prepare(
    `INSERT INTO payment_refunds (id, appointment_id, amount_cents, status, requested_by)
     SELECT ?, ?, ?, 'pending', ? WHERE ? = 'stripe' AND ? = 'paid'
     ON CONFLICT(appointment_id) DO NOTHING`,
  ).bind(`refund-${booking.id}`, booking.id, booking.price_cents, actorId, booking.payment_method, booking.payment_status);
}

/** Retry one refund if it is due. The claim comes first, so concurrent sweeps,
 * page loads and webhooks make at most one attempt per backoff step. */
export async function retryRefundIfDue(database: D1Database, booking: ManagedBooking, actorId: string): Promise<RefundOutcome> {
  if (booking.status !== "cancelled" || booking.payment_status !== "paid" || booking.payment_method !== "stripe") return "not_needed";
  const now = Date.now();
  const record = await database.prepare("SELECT status, attempts, next_attempt_at FROM payment_refunds WHERE appointment_id = ?")
    .bind(booking.id).first<{ status: string; attempts: number; next_attempt_at: number }>();
  // Only refunds already recorded as due are retried here; starting a refund
  // is the job of the path that cancelled the booking.
  if (!record) return "pending";
  if (record.status === "succeeded") return "refunded";
  if (record.attempts >= MAX_REFUND_ATTEMPTS || record.next_attempt_at > now) return "pending";
  const claimed = await database.prepare(`UPDATE payment_refunds SET next_attempt_at = ?
    WHERE appointment_id = ? AND status IN ('pending','failed') AND attempts = ? AND next_attempt_at = ?`)
    .bind(now + REFUND_CLAIM_MS, booking.id, record.attempts, record.next_attempt_at).run();
  if (claimed.meta.changes !== 1) return "pending"; // another worker holds it
  return refundCancelledBooking(database, booking, actorId, { automatic: true });
}

/** Retry every due refund of a cancelled, paid Stripe booking, whatever
 * cancelled it (staff, vacation, Bookly, late payment). Stops before a refund
 * it cannot afford; the rest stay due for the next run. */
export async function retryDueRefunds(database: D1Database, raw: D1Database, budget?: SubrequestBudget, limit = 20, reserve = 0) {
  if (budget && !budget.canAfford(1 + REFUND_RETRY_COST + reserve)) return;
  const due = (await database.prepare(`SELECT a.* FROM appointments a JOIN payment_refunds r ON r.appointment_id = a.id
    WHERE a.status = 'cancelled' AND a.payment_method = 'stripe' AND a.payment_status = 'paid'
      AND r.status IN ('pending','failed') AND r.attempts < ? AND r.next_attempt_at <= ?
    ORDER BY r.next_attempt_at, r.appointment_id LIMIT ?`).bind(MAX_REFUND_ATTEMPTS, Date.now(), limit).all<ManagedBooking>()).results;
  for (const booking of due) {
    if (budget && !budget.canAfford(REFUND_RETRY_COST + reserve)) return;
    budget?.charge(REFUND_RETRY_COST);
    // Unmetered: charged up front so it never stops inside a refund.
    await retryRefundIfDue(raw, booking, "automatic-refund-retry");
  }
}
