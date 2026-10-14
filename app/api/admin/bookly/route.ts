import { z } from "zod";
import { getD1 } from "@/db";
import { authoriseStaffMutation, getStaffUser } from "@/lib/staff-auth";
import { checkBooklyCatalogue } from "@/lib/bookly-catalogue";
import { BOOKLY_MAX_OCCUPANCY_AGE_SECONDS, booklyEnabled, booklyOccupancyAgeSeconds, booklyRequest, resolveBooklyConflict, synchronizeBookly } from "@/lib/bookly";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  if (!await getStaffUser(request.headers)) return Response.json({ error: "Not authorised." }, { status: 403, headers });
  if (!booklyEnabled()) return Response.json({ enabled: false }, { headers });
  const database = getD1();
  const state = await database.prepare("SELECT last_success,error FROM bookly_sync_state WHERE id=1").first();
  const pending = await database.prepare("SELECT id,local_id,error,created_at FROM bookly_commands WHERE status='pending' ORDER BY created_at").all();
  // Records held for staff reconciliation; each blocks only its own record.
  const held = await database.prepare("SELECT id,local_id,error,created_at FROM bookly_commands WHERE status='held' ORDER BY created_at").all();
  const conflicts = await database.prepare("SELECT local_id,remote_id,reason,detected_at,resolution FROM bookly_conflicts ORDER BY detected_at").all();
  const occupancyAgeSeconds = await booklyOccupancyAgeSeconds(database);
  return Response.json({ enabled: true, state, pending: pending.results, held: held.results, conflicts: conflicts.results, occupancyAgeSeconds,
    maxOccupancyAgeSeconds: BOOKLY_MAX_OCCUPANCY_AGE_SECONDS }, { headers });
}
export async function POST(request: Request) {
  if (!await authoriseStaffMutation(request)) return Response.json({ error: "Not authorised." }, { status: 403, headers });
  if (!booklyEnabled()) return Response.json({ error: "Bookly synchronization is disabled." }, { status: 409, headers });
  try {
    const input = z.discriminatedUnion("action", [
      z.object({ action: z.literal("catalogue") }),
      z.object({ action: z.literal("sync") }),
      z.object({ action: z.literal("resolve"), localId: z.string().min(1).max(120), keep: z.enum(["bookly", "local"]) }),
    ]).parse(await request.json());
    if (input.action === "catalogue") {
      const catalogue = await booklyRequest("catalogue", {});
      // Owner decision D06: Bookly is authoritative; report any website drift.
      return Response.json({ ...(catalogue as object), verification: checkBooklyCatalogue(catalogue) }, { headers });
    }
    if (input.action === "resolve") {
      const resolved = await resolveBooklyConflict(getD1(), input.localId, input.keep);
      if (!resolved.ok) return Response.json({ error: resolved.error }, { status: 409, headers });
      return Response.json({ resolved: true, keep: input.keep }, { headers });
    }
    await synchronizeBookly(getD1());
    return Response.json({ synced: true }, { headers });
  } catch { return Response.json({ error: "Bookly could not sync. Check the connection and pending commands." }, { status: 503, headers }); }
}
