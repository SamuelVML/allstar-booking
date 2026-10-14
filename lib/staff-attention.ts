/** Staff reconciliation queue (Backstage "Attention", /api/admin/attention).
 *
 * Lists what automatic processing has stopped on and only staff can decide:
 * - customer emails in `reconcile` (delivery outcome unknown after the
 *   provider's idempotency window) or `failed` (every attempt failed);
 * - refunds whose automatic retries are exhausted (retried from the booking);
 * - records held between the website and Bookly (resolved via
 *   POST /api/admin/bookly "resolve").
 */

export type AttentionNotification = {
  id: string; change_id: string; status: "reconcile" | "failed"; attempts: number; last_error: string | null; updated_at: string;
  change_action: string; appointment_id: string; reference: string; customer_name: string; customer_email: string;
  appointment_date: string; start_time: string; booking_status: string;
};
export type AttentionRefund = {
  appointment_id: string; reference: string; customer_name: string; amount_cents: number; attempts: number; error: string | null;
  revision: number; appointment_date: string; start_time: string;
};
export type AttentionCalendarItem = { local_id: string; reason: string; remote_id: string | null; resolution: string | null; detected_at: string;
  reference: string | null; customer_name: string | null; appointment_date: string | null; start_time: string | null };

/** `syncDisabled`: commands still pending when the bridge is off never reach
 * Bookly, and a reschedule email waits on them, so they are listed too. */
export async function attentionItems(database: D1Database, maxRefundAttempts: number, syncDisabled = false) {
  const notifications = (await database.prepare(`SELECT o.id, o.change_id, o.status, o.attempts, o.last_error, o.updated_at,
      c.action AS change_action, a.id AS appointment_id, a.reference, a.customer_name, a.customer_email, a.appointment_date, a.start_time,
      a.status AS booking_status
    FROM booking_obligations o JOIN appointments a ON a.id = o.appointment_id JOIN booking_changes c ON c.id = o.change_id
    WHERE o.kind = 'notify' AND o.status IN ('reconcile','failed') ORDER BY o.updated_at, o.id LIMIT 200`).all<AttentionNotification>()).results;
  const refunds = (await database.prepare(`SELECT r.appointment_id, a.reference, a.customer_name, r.amount_cents, r.attempts, r.error, a.revision,
      a.appointment_date, a.start_time
    FROM payment_refunds r JOIN appointments a ON a.id = r.appointment_id
    WHERE r.status IN ('pending','failed') AND r.attempts >= ? AND a.status = 'cancelled' AND a.payment_status = 'paid'
    ORDER BY r.updated_at LIMIT 200`).bind(maxRefundAttempts).all<AttentionRefund>()).results;
  const conflicts = (await database.prepare(`SELECT k.local_id, k.reason, k.remote_id, k.resolution, k.detected_at,
      a.reference, a.customer_name, a.appointment_date, a.start_time
    FROM bookly_conflicts k LEFT JOIN appointments a ON a.id = k.local_id ORDER BY k.detected_at LIMIT 200`).all<AttentionCalendarItem>()).results;
  // A held command without a conflict row (rejected export) is listed too.
  const held = (await database.prepare(`SELECT h.local_id,
      CASE WHEN h.status = 'pending' THEN 'Not yet in Bookly, and synchronization is off. Emails for this booking wait until it reaches Bookly.'
        ELSE COALESCE(h.error, 'Bookly rejected this change.') END AS reason, NULL AS remote_id,
      NULL AS resolution, h.created_at AS detected_at, a.reference, a.customer_name, a.appointment_date, a.start_time
    FROM bookly_commands h LEFT JOIN appointments a ON a.id = h.local_id
    WHERE (h.status = 'held' OR (? = 1 AND h.status = 'pending')) AND NOT EXISTS (SELECT 1 FROM bookly_conflicts k WHERE k.local_id = h.local_id)
    ORDER BY h.created_at LIMIT 200`).bind(syncDisabled ? 1 : 0).all<AttentionCalendarItem>()).results;
  return { notifications, refunds, calendar: { conflicts: [...conflicts, ...held] } };
}

/** Staff decision for one email waiting in `reconcile` or `failed`. Audited on
 * the obligation (who, when, which decision). A decision is accepted once: the
 * update requires the row to still be waiting.
 * - "delivered": the customer confirmed receipt; closed, nothing is sent.
 * - "dismiss": closed without sending (for example the customer was called).
 * - "resend": sent once more by the next obligation run, rebuilt from the
 *   booking's current state under a new provider idempotency key. */
export async function resolveNotification(database: D1Database, id: string, decision: "delivered" | "resend" | "dismiss", actor: string) {
  const at = new Date().toISOString();
  const waiting = "id = ? AND kind = 'notify' AND status IN ('reconcile','failed')";
  const result = decision === "resend"
    ? await database.prepare(`UPDATE booking_obligations SET status = 'pending', attempts = 0, next_attempt_at = 0, payload = NULL,
        first_attempt_at = NULL, outcome = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE ${waiting}`)
      .bind(`${RESEND_PREFIX}${Date.now()}`, `Resend requested by ${actor} at ${at}.`.slice(0, 500), id).run()
    : await database.prepare(`UPDATE booking_obligations SET status = 'done', outcome = ?, next_attempt_at = 0, last_error = ?,
        updated_at = CURRENT_TIMESTAMP WHERE ${waiting}`)
      .bind(decision === "delivered" ? "staff_confirmed_delivered" : "staff_dismissed",
        `Resolved by ${actor} at ${at}: ${decision === "delivered" ? "customer confirmed receipt" : "dismissed without sending"}.`.slice(0, 500), id).run();
  if (result.meta.changes === 1) console.info("Staff resolved a customer email", { id, decision, actor });
  return result.meta.changes === 1;
}

/** Marks a staff-requested resend on a pending obligation (in `outcome` until
 * it completes). The rebuilt email gets idempotency keys of its own, so the
 * provider never matches it to the earlier attempt. */
export const RESEND_PREFIX = "resend-";
