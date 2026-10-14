/** Durable side effects of committed booking changes.
 *
 * A change records its refund and customer-email obligations in the same D1
 * transaction that commits it, so a failure after commit can never strand a
 * cancelled booking without them. Obligations are then processed right away
 * and retried from the Cron Trigger until done. Each obligation is claimed
 * with a lease before work starts, and the external calls are idempotent:
 * Stripe refunds use the appointment-scoped idempotency key in lib/refunds.ts,
 * and change emails use `booking-change/<changeId>/<recipient>` with Resend.
 */
import { refundCancelledBooking, type RefundOutcome } from "@/lib/refunds";
import { deliverPreparedEmails, prepareBookingChangeNotification, type PreparedEmail } from "@/lib/booking-email";
import { addMinutes } from "@/lib/booking";
import { booklyEnabled } from "@/lib/bookly";
import type { ManagedBooking } from "@/lib/booking-management";
import { meteredDatabase, type SubrequestBudget } from "@/lib/subrequest-budget";

type ObligationRow = { id: string; appointment_id: string; change_id: string; kind: "refund" | "notify"; status: string; attempts: number; outcome: string | null;
  payload: string | null; first_attempt_at: number | null };
type ChangeRow = { change_action: string; previous_date: string; previous_time: string; new_date: string | null; new_time: string | null };

/** A claim outlives a slow Stripe or Resend call; a crashed worker's claim
 * expires and the obligation is retried. */
const LEASE_MS = 5 * 60_000;
/** Retries back off 1, 2, 4 … 64 minutes; the last attempt runs about four
 * hours after the change, inside Resend's 24-hour idempotency window. */
export const MAX_OBLIGATION_ATTEMPTS = 8;
const backoffMs = (attempts: number) => Math.min(2 ** (attempts - 1), 64) * 60_000;
/** Resend keeps an idempotency key for 24 hours. After that a retry could
 * deliver the same email twice, so an email whose first delivery started
 * longer ago than this, without a recorded result, is left for staff
 * reconciliation instead of being resent. */
export const PROVIDER_KEY_WINDOW_MS = 23 * 60 * 60_000;
/** A reschedule email waits for Bookly to accept the move; checked again after this. */
const CALENDAR_WAIT_MS = 60_000;
/** Worst-case subrequests per obligation: due read share, claim, booking read
 * and final write in D1, plus the external calls (refund: three D1 and two
 * Stripe requests; email: one read of the refund and calendar state, the
 * payload write and up to two recipients × three Resend attempts). */
export const OBLIGATION_COST = { refund: 9, notify: 12 } as const;
const EXTERNAL_COST = { refund: 6, notify: 6 } as const;

/** Statements recording the obligations of a cancellation, for the change's
 * own transaction. Ids are derived from the change, so recording is idempotent. */
export function cancellationObligations(database: D1Database, booking: ManagedBooking, changeId: string) {
  const statements: D1PreparedStatement[] = [];
  const insert = (kind: "refund" | "notify") => database.prepare(
    "INSERT INTO booking_obligations (id, appointment_id, change_id, kind) VALUES (?, ?, ?, ?)",
  ).bind(`${kind}/${changeId}`, booking.id, changeId, kind);
  if (booking.payment_method === "stripe" && booking.payment_status === "paid") statements.push(insert("refund"));
  if (booking.customer_email) statements.push(insert("notify"));
  return statements;
}

/** Statement recording the email of a staff reschedule, gated on the change's
 * own audit row so it commits with the move. Sent once Bookly accepts the move
 * (or at once when the calendar bridge is off); never sent for a move Bookly
 * rejected. */
export function rescheduleNotification(database: D1Database, booking: ManagedBooking, changeId: string) {
  return database.prepare(`INSERT INTO booking_obligations (id, appointment_id, change_id, kind)
    SELECT ?, ?, ?, 'notify' WHERE EXISTS (SELECT 1 FROM booking_changes WHERE id = ?) AND ? != ''`)
    .bind(`notify/${changeId}`, booking.id, changeId, changeId, booking.customer_email ?? "");
}

export type ObligationSummary = { refundsPending: number; notificationsSent: boolean };

/** Process due obligations, refunds before emails so each email states its
 * refund outcome. `changeIds` limits the run to specific changes (the request
 * that created them); without it, all due obligations are processed (Cron).
 * With a budget, stops before an obligation it cannot afford. */
/** A claim is identified by the lease expiry it set and the attempt it counts.
 * Every later write for that claim requires both, so a worker whose lease
 * expired can never overwrite the result of the worker that reclaimed it. */
type Claim = { row: ObligationRow; until: number; attempts: number };

export async function processBookingObligations(
  raw: D1Database,
  options: { changeIds?: string[]; budget?: SubrequestBudget; limit?: number } = {},
) {
  const { budget, changeIds, limit = 20 } = options;
  const database = budget ? meteredDatabase(raw, budget) : raw;
  if (budget && !budget.canAfford(1)) return;
  const now = Date.now();
  const rows = (await (changeIds
    ? database.prepare(`SELECT * FROM booking_obligations WHERE status = 'pending' AND next_attempt_at <= ?
        AND change_id IN (SELECT value FROM json_each(?)) ORDER BY (kind = 'notify'), created_at, id LIMIT ?`).bind(now, JSON.stringify(changeIds), limit)
    : database.prepare(`SELECT * FROM booking_obligations WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY (kind = 'notify'), created_at, id LIMIT ?`).bind(now, limit)
  ).all<ObligationRow>()).results;

  for (const row of rows) {
    if (budget && !budget.canAfford(OBLIGATION_COST[row.kind])) break;
    if (row.attempts >= MAX_OBLIGATION_ATTEMPTS) {
      // Exhausted (for example a crash after its last claim): stop without
      // another external call.
      await database.prepare(`UPDATE booking_obligations SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending' AND attempts >= ? AND next_attempt_at <= ?`).bind(row.id, MAX_OBLIGATION_ATTEMPTS, now).run();
      continue;
    }
    const claim: Claim = { row, until: now + LEASE_MS, attempts: row.attempts + 1 };
    const claimed = await database.prepare(`UPDATE booking_obligations SET attempts = attempts + 1, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? AND attempts = ? AND attempts < ?`)
      .bind(claim.until, row.id, now, row.attempts, MAX_OBLIGATION_ATTEMPTS).run();
    if (claimed.meta.changes !== 1) continue; // another worker holds or finished it
    try {
      const booking = await database.prepare("SELECT * FROM appointments WHERE id = ?").bind(row.appointment_id).first<ManagedBooking>();
      if (!booking) throw new Error("Appointment not found.");
      if (row.kind === "refund") {
        // Charged up front; runs unmetered so it never stops inside a refund.
        budget?.charge(EXTERNAL_COST.refund);
        const outcome = await refundCancelledBooking(raw, booking, "booking-obligation", { automatic: true });
        if (outcome === "pending") await retry(database, claim, "Stripe refund not confirmed.");
        else await complete(database, claim, outcome);
        continue;
      }
      const outcome = await notify(database, claim, booking, budget);
      if (outcome === "sent") await complete(database, claim, "sent");
      else if (outcome === "superseded") await complete(database, claim, "superseded");
      else if (outcome === "failed") await retry(database, claim, "Email not delivered.");
    } catch (error) {
      // The pre-checked cost includes this final write. If it fails, the claim
      // expires and the obligation is retried; external calls are idempotent.
      try { await retry(database, claim, error instanceof Error ? error.message.slice(0, 500) : "Obligation failed."); }
      catch { break; }
    }
  }
}

type NotifyOutcome = "sent" | "failed" | "superseded" | "waiting" | "reconcile" | "lost";

/** Send a change email under its claim. The exact provider request is built
 * once, stored before the first delivery and resent verbatim, so a retry never
 * reuses an idempotency key with different content. */
async function notify(database: D1Database, claim: Claim, booking: ManagedBooking, budget?: SubrequestBudget): Promise<NotifyOutcome> {
  const { row } = claim;
  if (row.payload) {
    // Delivered or not, the outcome of the first attempt is unknown here. Past
    // the provider's key window a resend could duplicate the email.
    if (row.first_attempt_at !== null && Date.now() - row.first_attempt_at >= PROVIDER_KEY_WINDOW_MS) {
      await database.prepare(`UPDATE booking_obligations SET status = 'reconcile', next_attempt_at = 0, updated_at = CURRENT_TIMESTAMP,
          last_error = 'Delivery outcome unknown after the provider idempotency window; confirm with the customer before resending.'
        WHERE id = ? AND status = 'pending' AND next_attempt_at = ? AND attempts = ?`).bind(row.id, claim.until, claim.attempts).run();
      return "reconcile";
    }
    budget?.charge(EXTERNAL_COST.notify);
    return await deliverPreparedEmails(JSON.parse(row.payload) as PreparedEmail[]) ? "sent" : "failed";
  }
  // One read: the change, its refund obligation and the calendar delivery state.
  const state = await database.prepare(`SELECT c.action AS change_action, c.previous_date, c.previous_time, c.new_date, c.new_time,
      (SELECT json_object('status', status, 'outcome', outcome, 'attempts', attempts) FROM booking_obligations WHERE change_id = c.id AND kind = 'refund') AS refund,
      EXISTS (SELECT 1 FROM bookly_commands WHERE local_id = c.appointment_id AND status IN ('pending','held'))
        OR EXISTS (SELECT 1 FROM bookly_conflicts WHERE local_id = c.appointment_id) AS calendar_pending
    FROM booking_changes c WHERE c.id = ?`)
    .bind(row.change_id).first<ChangeRow & { refund: string | null; calendar_pending: number }>();
  if (!state) throw new Error("Booking change not found.");
  const change = state;
  let messages: PreparedEmail[] | null;
  if (change.change_action === "reschedule") {
    // A move Bookly rejected was restored (or replaced by a later change):
    // nothing was confirmed, so nothing is sent.
    if (booking.status !== "confirmed" || booking.appointment_date !== change.new_date || booking.start_time !== change.new_time) return "superseded";
    if (booklyEnabled() && state.calendar_pending) {
      // Remote acceptance not established yet; give the claim back unchanged.
      await database.prepare("UPDATE booking_obligations SET attempts = attempts - 1, next_attempt_at = ? WHERE id = ? AND next_attempt_at = ? AND attempts = ?")
        .bind(Date.now() + CALENDAR_WAIT_MS, row.id, claim.until, claim.attempts).run();
      return "waiting";
    }
    const previous = { ...booking, appointment_date: change.previous_date, start_time: change.previous_time, end_time: addMinutes(change.previous_time, booking.duration_minutes) };
    messages = prepareBookingChangeNotification(previous, "reschedule", row.change_id, { date: change.new_date!, time: change.new_time! });
  } else {
    const refund = state.refund ? JSON.parse(state.refund) as { status: string; outcome: string | null; attempts: number } : null;
    if (refund && refund.status === "pending" && refund.attempts === 0) {
      // Wait for the first refund attempt; give the claim back unchanged.
      await database.prepare("UPDATE booking_obligations SET attempts = attempts - 1, next_attempt_at = 0 WHERE id = ? AND next_attempt_at = ? AND attempts = ?")
        .bind(row.id, claim.until, claim.attempts).run();
      return "waiting";
    }
    // The stored payment is authoritative: a refund can succeed while its
    // obligation's completion write failed.
    const refundStatus: RefundOutcome = booking.payment_status === "refunded" ? "refunded"
      : !refund ? "not_needed" : refund.status === "done" ? (refund.outcome as RefundOutcome) : "pending";
    messages = prepareBookingChangeNotification(booking, "cancel", row.change_id, undefined, refundStatus);
  }
  if (!messages) return "failed"; // email not configured; retried with backoff
  const stored = await database.prepare(`UPDATE booking_obligations SET payload = ?, first_attempt_at = ?
    WHERE id = ? AND status = 'pending' AND next_attempt_at = ? AND attempts = ? AND payload IS NULL`)
    .bind(JSON.stringify(messages), Date.now(), row.id, claim.until, claim.attempts).run();
  if (stored.meta.changes !== 1) return "lost"; // the claim expired; its new holder sends
  budget?.charge(EXTERNAL_COST.notify);
  return await deliverPreparedEmails(messages) ? "sent" : "failed";
}

async function complete(database: D1Database, claim: Claim, outcome: string) {
  await database.prepare(`UPDATE booking_obligations SET status = 'done', outcome = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending' AND next_attempt_at = ? AND attempts = ?`)
    .bind(outcome, claim.row.id, claim.until, claim.attempts).run();
}

/** Back off, or stop after the last attempt. A failed refund stays visible in
 * Backstage as paid and cancelled, where staff can retry it. */
async function retry(database: D1Database, claim: Claim, message: string) {
  const failed = claim.attempts >= MAX_OBLIGATION_ATTEMPTS;
  await database.prepare(`UPDATE booking_obligations SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending' AND next_attempt_at = ? AND attempts = ?`)
    .bind(failed ? "failed" : "pending", failed ? 0 : Date.now() + backoffMs(claim.attempts), message, claim.row.id, claim.until, claim.attempts).run();
}

/** Whether any obligation is due now; one read. */
export async function obligationsDue(database: D1Database) {
  return Boolean(await database.prepare("SELECT 1 AS due FROM booking_obligations WHERE status = 'pending' AND next_attempt_at <= ? LIMIT 1")
    .bind(Date.now()).first());
}

/** Outcome of the obligations of specific changes, for the response. */
export async function obligationSummary(database: D1Database, changeIds: string[]): Promise<ObligationSummary> {
  const rows = (await database.prepare("SELECT kind, status FROM booking_obligations WHERE change_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(changeIds)).all<{ kind: string; status: string }>()).results;
  return {
    refundsPending: rows.filter(row => row.kind === "refund" && row.status !== "done").length,
    notificationsSent: rows.filter(row => row.kind === "notify").every(row => row.status === "done"),
  };
}
