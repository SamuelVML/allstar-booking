import { getD1 } from "@/db";
import { runScheduledBooklySync } from "@/lib/bookly-scheduled";
import { OBLIGATION_COST, obligationsDue, processBookingObligations } from "@/lib/booking-obligations";
import { backgroundBudget, meteredDatabase, SubrequestBudget } from "@/lib/subrequest-budget";

/** Subrequests kept for due refund and email obligations in every invocation,
 * so a long Bookly backlog can never starve them: at least one refund or one
 * email per minute. */
export const OBLIGATION_RESERVE = Math.max(OBLIGATION_COST.refund, OBLIGATION_COST.notify);

/** Cron Trigger body: one subrequest budget for the whole invocation. Bookly
 * synchronization runs first (fresh occupancy keeps online booking open) but,
 * when obligations are due, without their reserved share; obligations then
 * use what remains. Failures are logged and retried on the next minute.
 */
export async function runScheduledTasks() {
  const total = backgroundBudget();
  const database = getD1();
  let due = false;
  try { due = await obligationsDue(meteredDatabase(database, total)); }
  catch { console.error("Scheduled obligation check failed"); }
  const bookly = new SubrequestBudget(total.remaining - (due ? OBLIGATION_RESERVE : 0));
  const outcome = await runScheduledBooklySync(bookly);
  if (due) {
    try { await processBookingObligations(database, { budget: new SubrequestBudget(total.remaining - bookly.used) }); }
    catch { console.error("Scheduled booking obligations failed"); }
  }
  return outcome;
}
