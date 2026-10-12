import { refundCancelledBooking } from "@/lib/refunds";
import type { ManagedBooking } from "@/lib/booking-management";
import { synchronizeBookly } from "@/lib/bookly";
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
  const changed = await database
    .prepare(
      `UPDATE appointments
       SET status = CASE WHEN status = 'payment_pending' THEN 'confirmed' ELSE 'cancelled' END,
         payment_status = 'paid', paid_at = ?, payment_expires_at = NULL
       WHERE id = ? AND stripe_checkout_session_id = ? AND payment_method = 'stripe'
         AND status IN ('payment_pending','payment_expired','cancelled') AND payment_status IN ('pending','expired')`,
    )
    .bind(new Date().toISOString(), appointmentId, checkoutSessionId)
    .run();
  if (changed.meta.changes === 1) {
    const latePayment = await database.prepare("SELECT * FROM appointments WHERE id=? AND status='cancelled'").bind(appointmentId).first<ManagedBooking>();
    if (latePayment) await refundCancelledBooking(database,latePayment,"late-stripe-payment");
  }
  await synchronizeBookly(database);
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
