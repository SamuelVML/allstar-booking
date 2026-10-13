import { getD1 } from "@/db";
import { BooklyUnavailable, booklyEnabled, synchronizeBookly } from "@/lib/bookly";

/** Cron Trigger body. Failures are logged, never thrown: the next minute retries,
 * and request paths fail closed once occupancy exceeds its maximum age.
 */
export async function runScheduledBooklySync() {
  if (!booklyEnabled()) return "disabled";
  try {
    await synchronizeBookly(getD1());
    return "synced";
  } catch (error) {
    // A lease held by the WordPress callback or a staff sync is expected overlap.
    console.error("Scheduled Bookly sync failed", error instanceof BooklyUnavailable ? error.message : "unexpected error");
    return "failed";
  }
}
