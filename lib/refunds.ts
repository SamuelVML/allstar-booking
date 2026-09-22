import { getStripeClient } from "@/lib/stripe";
import type { ManagedBooking } from "@/lib/booking-management";

export type RefundOutcome = "not_needed" | "refunded" | "pending";

/**
 * Refunds a paid Stripe appointment once. The appointment-scoped record and
 * Stripe idempotency key make retries safe if a request is interrupted.
 */
export async function refundCancelledBooking(
  database: D1Database,
  booking: ManagedBooking,
  actorId: string,
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
         status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP`,
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
    await database
      .prepare(
        `UPDATE payment_refunds SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE appointment_id = ?`,
      )
      .bind(message, booking.id)
      .run();
    console.error("Automatic Stripe refund failed", booking.reference, error);
    return "pending";
  }
}
