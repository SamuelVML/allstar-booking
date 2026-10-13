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
import { sendBookingChangeNotification } from "@/lib/booking-email";
import type { ManagedBooking } from "@/lib/booking-management";
import { meteredDatabase, type SubrequestBudget } from "@/lib/subrequest-budget";

type ObligationRow = { id: string; appointment_id: string; change_id: string; kind: "refund" | "notify"; status: string; attempts: number; outcome: string | null };

/** A claim outlives a slow Stripe or Resend call; a crashed worker's claim
 * expires and the obligation is retried. */
const LEASE_MS = 5 * 60_000;
/** Retries back off 1, 2, 4 … 64 minutes; the last attempt runs about four
 * hours after the change, inside Resend's 24-hour idempotency window. */
export const MAX_OBLIGATION_ATTEMPTS = 8;
const backoffMs = (attempts: number) => Math.min(2 ** (attempts - 1), 64) * 60_000;
/** Worst-case subrequests per obligation: due read share, claim, booking read
 * and final write in D1, plus the external calls (refund: three D1 and two
 * Stripe requests; email: refund-status read and up to two recipients × three
 * Resend attempts). */
export const OBLIGATION_COST = { refund: 9, notify: 10 } as const;
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

export type ObligationSummary = { refundsPending: number; notificationsSent: boolean };

/** Process due obligations, refunds before emails so each email states its
 * refund outcome. `changeIds` limits the run to specific changes (the request
 * that created them); without it, all due obligations are processed (Cron).
 * With a budget, stops before an obligation it cannot afford. */
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
    const claimed = await database.prepare(`UPDATE booking_obligations SET attempts = attempts + 1, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`).bind(now + LEASE_MS, row.id, now).run();
    if (claimed.meta.changes !== 1) continue; // another worker holds it
    const attempts = row.attempts + 1;
    try {
      const booking = await database.prepare("SELECT * FROM appointments WHERE id = ?").bind(row.appointment_id).first<ManagedBooking>();
      if (!booking) throw new Error("Appointment not found.");
      if (row.kind === "refund") {
        // Charged up front; runs unmetered so it never stops inside a refund.
        budget?.charge(EXTERNAL_COST.refund);
        const outcome = await refundCancelledBooking(raw, booking, "booking-obligation");
        if (outcome === "pending") await retry(database, row, attempts, "Stripe refund not confirmed.");
        else await complete(database, row, outcome);
        continue;
      }
      const refund = await database.prepare("SELECT status, outcome, attempts FROM booking_obligations WHERE change_id = ? AND kind = 'refund'")
        .bind(row.change_id).first<{ status: string; outcome: string | null; attempts: number }>();
      if (refund && refund.status === "pending" && refund.attempts === 0) {
        // Wait for the first refund attempt; give the claim back unchanged.
        await database.prepare("UPDATE booking_obligations SET attempts = attempts - 1, next_attempt_at = 0 WHERE id = ?").bind(row.id).run();
        continue;
      }
      const refundStatus: RefundOutcome = !refund ? "not_needed"
        : refund.status === "done" ? (refund.outcome as RefundOutcome) : "pending";
      budget?.charge(EXTERNAL_COST.notify);
      const sent = await sendBookingChangeNotification(booking, "cancel", row.change_id, undefined, refundStatus);
      if (sent) await complete(database, row, "sent");
      else await retry(database, row, attempts, "Email not delivered.");
    } catch (error) {
      // The pre-checked cost includes this final write. If it fails, the claim
      // expires and the obligation is retried; external calls are idempotent.
      try { await retry(database, row, attempts, error instanceof Error ? error.message.slice(0, 500) : "Obligation failed."); }
      catch { break; }
    }
  }
}

async function complete(database: D1Database, row: ObligationRow, outcome: string) {
  await database.prepare("UPDATE booking_obligations SET status = 'done', outcome = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(outcome, row.id).run();
}

/** Back off, or stop after the last attempt. A failed refund stays visible in
 * Backstage as paid and cancelled, where staff can retry it. */
async function retry(database: D1Database, row: ObligationRow, attempts: number, message: string) {
  const failed = attempts >= MAX_OBLIGATION_ATTEMPTS;
  await database.prepare(`UPDATE booking_obligations SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(failed ? "failed" : "pending", failed ? 0 : Date.now() + backoffMs(attempts), message, row.id).run();
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
