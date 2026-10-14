import { refundCancelledBooking, retryRefundIfDue } from "@/lib/refunds";
import type { ManagedBooking } from "@/lib/booking-management";
import { pushAfterCommit } from "@/lib/bookly";
export async function releaseExpiredPaymentReservations(database: D1Database) {
  const now = new Date().toISOString();
  const expired = await database
    .prepare(
      `SELECT id FROM appointments
       WHERE status = 'payment_pending' AND payment_expires_at IS NOT NULL
       AND payment_expires_at <= ?`,
    )
    .bind(now)
    .all<{ id: string }>();

  const results = expired.results;
  if (results.length === 0) return;

  await database.batch([
    ...results.map(({ id }) =>
      database.prepare(`DELETE FROM appointment_slots WHERE appointment_id = ? AND EXISTS (
        SELECT 1 FROM appointments WHERE id = ? AND status = 'payment_pending' AND payment_expires_at <= ?
      )`).bind(id, id, now),
    ),
    ...results.map(({ id }) =>
      database
        .prepare(
          `UPDATE appointments SET status = 'payment_expired', payment_status = 'expired'
           WHERE id = ? AND status = 'payment_pending'`,
        )
        .bind(id),
    ),
  ]);
}

export async function confirmPaidAppointment(
  database: D1Database,
  appointmentId: string,
  checkoutSessionId: string,
) {
  // A payment that arrives after the hold expired or the booking was cancelled
  // is refunded. The refund becomes durably due in the same transaction, so a
  // failure or crash before Stripe answers is retried automatically.
  const paidAt = new Date().toISOString();
  const [changed] = await database.batch([
    database
      .prepare(
        `UPDATE appointments
         SET status = CASE WHEN status = 'payment_pending' THEN 'confirmed' ELSE 'cancelled' END,
           payment_status = 'paid', paid_at = ?, payment_expires_at = NULL
         WHERE id = ? AND stripe_checkout_session_id = ? AND payment_method = 'stripe'
           AND status IN ('payment_pending','payment_expired','cancelled') AND payment_status IN ('pending','expired')`,
      )
      .bind(paidAt, appointmentId, checkoutSessionId),
    // Only for the late payment this statement just recorded (same paid_at).
    database
      .prepare(
        `INSERT INTO payment_refunds (id, appointment_id, amount_cents, status, requested_by)
         SELECT 'refund-' || id, id, price_cents, 'pending', 'late-stripe-payment' FROM appointments
         WHERE id = ? AND stripe_checkout_session_id = ? AND status = 'cancelled' AND payment_status = 'paid' AND paid_at = ?
         ON CONFLICT(appointment_id) DO NOTHING`,
      )
      .bind(appointmentId, checkoutSessionId, paidAt),
  ]);
  const latePayment = await database.prepare("SELECT * FROM appointments WHERE id=? AND status='cancelled' AND payment_status='paid'")
    .bind(appointmentId).first<ManagedBooking>();
  if (latePayment) {
    // The first confirmation attempts the refund now; repeated webhooks and
    // page loads only retry when the backoff allows.
    if (changed.meta.changes === 1) await refundCancelledBooking(database, latePayment, "late-stripe-payment", { automatic: true });
    else await retryRefundIfDue(database, latePayment, "late-stripe-payment");
  }
  // The webhook outcome is committed; Bookly delivery replays in the background.
  await pushAfterCommit(database, [appointmentId]);
}

export async function expirePaymentAppointment(
  database: D1Database,
  appointmentId: string,
  checkoutSessionId: string,
) {
  await database.batch([
    database
      .prepare(`DELETE FROM appointment_slots WHERE appointment_id = ? AND EXISTS (
        SELECT 1 FROM appointments WHERE id = ? AND stripe_checkout_session_id = ? AND status = 'payment_pending'
      )`)
      .bind(appointmentId, appointmentId, checkoutSessionId),
    database
      .prepare(
        `UPDATE appointments
         SET status = 'payment_expired', payment_status = 'expired', payment_expires_at = NULL
         WHERE id = ? AND stripe_checkout_session_id = ? AND status = 'payment_pending'`,
      )
      .bind(appointmentId, checkoutSessionId),
  ]);
}
