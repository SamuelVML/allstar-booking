/**
 * Worker entry: vinext serves every request; the Cron Trigger keeps Bookly
 * occupancy current in the background so no public request waits on a full
 * calendar snapshot, and retries refund and email obligations of committed
 * booking changes. Synchronization is a no-op unless BOOKLY_SYNC_ENABLED=true.
 */
import handler from "vinext/server/fetch-handler";
import { runScheduledTasks } from "@/lib/scheduled";

const worker = {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return handler.fetch(request, env, ctx);
  },
  scheduled(_controller: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledTasks());
  },
};

export default worker;
