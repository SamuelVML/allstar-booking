import { getD1 } from "@/db";
import { runScheduledBooklySync } from "@/lib/bookly-scheduled";
import { OBLIGATION_COST, processBookingObligations } from "@/lib/booking-obligations";
import { MAX_REFUND_ATTEMPTS, REFUND_RETRY_COST, retryDueRefunds } from "@/lib/refunds";
import { backgroundBudget, meteredDatabase, SubrequestBudget } from "@/lib/subrequest-budget";

/** Subrequests kept for due refund and email obligations in every invocation,
 * so a long Bookly backlog can never starve them: the due read plus at least
 * one refund or one email per minute. */
export const OBLIGATION_RESERVE = 1 + Math.max(OBLIGATION_COST.refund, OBLIGATION_COST.notify);
/** Subrequests kept for one due refund retry (failed Bookly, late-payment or
 * staff refunds), likewise never starved by a Bookly backlog. */
export const REFUND_RESERVE = REFUND_RETRY_COST + 1;

/** Cron Trigger body: one subrequest budget for the whole invocation. Bookly
 * synchronization runs first (fresh occupancy keeps online booking open) but,
 * when obligations or refund retries are due, without their reserved share;
 * they then use what remains. When both are due they take turns going first,
 * alternating by minute, so neither queue's backlog can starve the other.
 * Refund retries run whether or not Bookly synchronization is enabled.
 * Failures are logged and retried on the next minute.
 */
export async function runScheduledTasks() {
  const total = backgroundBudget();
  const database = getD1();
  let due = { obligations: 0, refunds: 0 };
  try {
    const now = Date.now();
    due = await meteredDatabase(database, total).prepare(`SELECT
        EXISTS(SELECT 1 FROM booking_obligations WHERE status = 'pending' AND next_attempt_at <= ?) AS obligations,
        EXISTS(SELECT 1 FROM payment_refunds r JOIN appointments a ON a.id = r.appointment_id
          WHERE r.status IN ('pending','failed') AND r.attempts < ? AND r.next_attempt_at <= ?
            AND a.status = 'cancelled' AND a.payment_status = 'paid' AND a.payment_method = 'stripe') AS refunds`)
      .bind(now, MAX_REFUND_ATTEMPTS, now).first<{ obligations: number; refunds: number }>() ?? due;
  } catch { console.error("Scheduled work check failed"); }
  // One reserve, never both: it must leave the Bookly snapshot affordable on the
  // default budget. The obligation share also covers a refund retry, so
  // whichever queue goes first can always make progress.
  const reserve = due.obligations ? OBLIGATION_RESERVE : due.refunds ? REFUND_RESERVE : 0;
  const bookly = new SubrequestBudget(total.remaining - reserve);
  const outcome = await runScheduledBooklySync(bookly);
  let used = bookly.used;
  const obligations = async () => {
    const budget = new SubrequestBudget(total.remaining - used);
    try { await processBookingObligations(database, { budget }); }
    catch { console.error("Scheduled booking obligations failed"); }
    used += budget.used;
  };
  const refunds = async () => {
    const budget = new SubrequestBudget(total.remaining - used);
    try { await retryDueRefunds(meteredDatabase(database, budget), database, budget); }
    catch { console.error("Scheduled refund retries failed"); }
    used += budget.used;
  };
  const refundsFirst = due.refunds && (!due.obligations || Math.floor(Date.now() / 60_000) % 2 === 0);
  if (refundsFirst) await refunds();
  if (due.obligations) await obligations();
  if (due.refunds && !refundsFirst) await refunds();
  return outcome;
}
