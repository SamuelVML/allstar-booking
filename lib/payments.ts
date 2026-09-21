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
      database.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(id),
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
  await database
    .prepare(
      `UPDATE appointments
       SET status = 'confirmed', payment_status = 'paid', paid_at = ?, payment_expires_at = NULL
       WHERE id = ? AND stripe_checkout_session_id = ? AND payment_method = 'stripe'`,
    )
    .bind(new Date().toISOString(), appointmentId, checkoutSessionId)
    .run();
}

export async function expirePaymentAppointment(
  database: D1Database,
  appointmentId: string,
  checkoutSessionId: string,
) {
  await database.batch([
    database
      .prepare("DELETE FROM appointment_slots WHERE appointment_id = ?")
      .bind(appointmentId),
    database
      .prepare(
        `UPDATE appointments
         SET status = 'payment_expired', payment_status = 'expired', payment_expires_at = NULL
         WHERE id = ? AND stripe_checkout_session_id = ? AND status = 'payment_pending'`,
      )
      .bind(appointmentId, checkoutSessionId),
  ]);
}
