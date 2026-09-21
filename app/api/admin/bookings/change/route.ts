import { z } from "zod";
import { getD1 } from "@/db";
import { authoriseStaffMutation } from "@/lib/staff-auth";
import { BookingConflict, changeBooking, type ManagedBooking } from "@/lib/booking-management";
import { sendBookingChangeNotification } from "@/lib/booking-email";

export async function POST(request: Request) {
  const user = await authoriseStaffMutation(request);
  if (!user) return Response.json({ error: "Not authorised." }, { status: 403 });
  const schema = z.object({
    reference: z.string().min(1).max(80), revision: z.number().int().nonnegative(),
    action: z.enum(["cancel", "reschedule", "complete"]),
    date: z.string().optional(), time: z.string().optional(),
  });
  let parsed;
  try { parsed = schema.safeParse(await request.json()); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  if (!parsed.success) return Response.json({ error: "Invalid booking change." }, { status: 400 });
  const payload = parsed.data;
  if (payload.action === "reschedule" && (!payload.date || !payload.time)) return Response.json({ error: "Choose a date and time." }, { status: 400 });
  try {
    const database = getD1();
    const booking = await database.prepare("SELECT * FROM appointments WHERE reference = ?").bind(payload.reference).first<ManagedBooking>();
    if (!booking) return Response.json({ error: "Booking not found." }, { status: 404 });
    if (booking.revision !== payload.revision) throw new BookingConflict("The booking changed. Refresh and try again.");
    const target = payload.action === "reschedule" ? { date: payload.date!, time: payload.time! } : undefined;
    const change = await changeBooking(database, booking, payload.action, user.id, target);
    let notificationsSent = true;
    if (payload.action !== "complete") {
      notificationsSent = await sendBookingChangeNotification(booking, payload.action, change.changeId, target);
    }
    return Response.json({ changed: true, revision: change.revision, notificationsSent });
  } catch (error) {
    if (error instanceof BookingConflict) return Response.json({ error: error.message }, { status: 409 });
    console.error("Staff booking change failed");
    return Response.json({ error: "Unable to save the booking. Refresh before retrying." }, { status: 503 });
  }
}
