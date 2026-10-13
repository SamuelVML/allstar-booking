import { getD1 } from "@/db";
import { runScheduledBooklySync } from "@/lib/bookly-scheduled";
import { processBookingObligations } from "@/lib/booking-obligations";
import { backgroundBudget } from "@/lib/subrequest-budget";

/** Cron Trigger body: one subrequest budget for the whole invocation. Bookly
 * synchronization runs first (fresh occupancy keeps online booking open), then
 * due refund and email obligations use what remains. Failures are logged and
 * retried on the next minute.
 */
export async function runScheduledTasks() {
  const budget = backgroundBudget();
  const bookly = await runScheduledBooklySync(budget);
  try { await processBookingObligations(getD1(), { budget }); }
  catch { console.error("Scheduled booking obligations failed"); }
  return bookly;
}
