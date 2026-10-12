import { z } from "zod";
import { getD1 } from "@/db";
import { authoriseStaffMutation, getStaffUser } from "@/lib/staff-auth";
import { booklyEnabled, booklyRequest, synchronizeBookly } from "@/lib/bookly";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  if (!await getStaffUser(request.headers)) return Response.json({ error: "Not authorised." }, { status: 403, headers });
  if (!booklyEnabled()) return Response.json({ enabled: false }, { headers });
  const database = getD1();
  const state = await database.prepare("SELECT last_success,error FROM bookly_sync_state WHERE id=1").first();
  const pending = await database.prepare("SELECT id,local_id,error,created_at FROM bookly_commands WHERE status='pending' ORDER BY created_at").all();
  return Response.json({ enabled: true, state, pending: pending.results }, { headers });
}
export async function POST(request: Request) {
  if (!await authoriseStaffMutation(request)) return Response.json({ error: "Not authorised." }, { status: 403, headers });
  if (!booklyEnabled()) return Response.json({ error: "Bookly synchronization is disabled." }, { status: 409, headers });
  try {
    const input = z.object({ action: z.enum(["catalogue", "sync"]) }).parse(await request.json());
    if (input.action === "catalogue") return Response.json(await booklyRequest("catalogue", {}), { headers });
    if (input.action !== "sync") return Response.json({ error: "Invalid action." }, { status: 400, headers });
    await synchronizeBookly(getD1());
    return Response.json({ synced: true }, { headers });
  } catch { return Response.json({ error: "Bookly could not sync. Check the connection and pending commands." }, { status: 503, headers }); }
}
