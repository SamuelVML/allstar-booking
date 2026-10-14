import { z } from "zod";
import { getD1 } from "@/db";
import { authoriseStaffMutation, getStaffUser } from "@/lib/staff-auth";
import { booklyEnabled } from "@/lib/bookly";
import { MAX_REFUND_ATTEMPTS } from "@/lib/refunds";
import { attentionItems, resolveNotification } from "@/lib/staff-attention";

const headers = { "Cache-Control": "private, no-store" };

/** Work that needs a staff decision: customer emails whose delivery is
 * unknown or failed, refunds that stopped retrying, and records held between
 * the website and Bookly. Listed whatever the bridge setting, because a record
 * held while the bridge was on is still unresolved after it is turned off. */
export async function GET(request: Request) {
  if (!await getStaffUser(request.headers)) return Response.json({ error: "Not authorised." }, { status: 403, headers });
  const items = await attentionItems(getD1(), MAX_REFUND_ATTEMPTS, !booklyEnabled());
  return Response.json({ ...items, calendar: { enabled: booklyEnabled(), ...items.calendar } }, { headers });
}

const schema = z.object({
  action: z.literal("resolve_notification"),
  id: z.string().min(1).max(200),
  decision: z.enum(["delivered", "resend", "dismiss"]),
});

export async function POST(request: Request) {
  const user = await authoriseStaffMutation(request);
  if (!user) return Response.json({ error: "Not authorised." }, { status: 403, headers });
  let parsed;
  try { parsed = schema.safeParse(await request.json()); } catch { return Response.json({ error: "Invalid request." }, { status: 400, headers }); }
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400, headers });
  const actor = "email" in user && typeof user.email === "string" ? `${user.email} (${user.id})` : user.id;
  const resolved = await resolveNotification(getD1(), parsed.data.id, parsed.data.decision, actor);
  if (!resolved) return Response.json({ error: "This email is no longer waiting for a decision. Refresh the list." }, { status: 409, headers });
  return Response.json({ resolved: true, decision: parsed.data.decision }, { headers });
}
