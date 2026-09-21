import { z } from "zod";
import { getD1 } from "@/db";
import { authoriseStaffMutation } from "@/lib/staff-auth";
import { BookingConflict } from "@/lib/booking-management";
import { blockTime, createWalkIn, recordPayment, removeBlock } from "@/lib/backstage";
import { releaseExpiredPaymentReservations } from "@/lib/payments";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("block"), id: z.string().uuid(), date: z.string(), start: z.string(), end: z.string(), reason: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal("unblock"), id: z.string().uuid() }),
  z.object({ action: z.literal("walk_in"), id: z.string().uuid(), date: z.string(), time: z.string(), serviceId: z.string(), name: z.string().trim().min(1).max(80), notes: z.string().trim().max(1000) }),
  z.object({ action: z.literal("payment"), id: z.string().uuid(), reference: z.string().min(1).max(80), revision: z.number().int().nonnegative(), method: z.enum(["cash", "card"]) }),
]);
export async function POST(request: Request) {
  const user = await authoriseStaffMutation(request);
  if (!user) return Response.json({ error: "Not authorised." }, { status: 403 });
  let parsed;
  try { parsed = schema.safeParse(await request.json()); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  if (!parsed.success) return Response.json({ error: "Check the form fields and try again." }, { status: 400 });
  try {
    const database = getD1();
    const input = parsed.data;
    if (input.action === "block" || input.action === "walk_in") await releaseExpiredPaymentReservations(database);
    if (input.action === "block") await blockTime(database, input, user.id);
    if (input.action === "unblock") await removeBlock(database, input.id, user.id);
    if (input.action === "walk_in") await createWalkIn(database, input, user.id);
    if (input.action === "payment") await recordPayment(database, input, user.id);
    return Response.json({ saved: true });
  } catch (error) {
    if (error instanceof BookingConflict) return Response.json({ error: error.message }, { status: 409 });
    console.error("Backstage operation failed");
    return Response.json({ error: "Unable to save. Refresh to check whether it was saved before retrying." }, { status: 503 });
  }
}
