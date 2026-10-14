import { assertBooklyFresh, pushAfterCommit, BooklyConflict } from "@/lib/bookly";
import { z } from "zod";
import { getD1 } from "@/db";
import { authoriseStaffMutation } from "@/lib/staff-auth";
import { BookingConflict, changeBooking, type ManagedBooking } from "@/lib/booking-management";
import { sendBookingChangeNotification } from "@/lib/booking-email";
import { readBookingSettings } from "@/lib/booking-settings";
import { refundCancelledBooking } from "@/lib/refunds";
import { obligationSummary, processBookingObligations, rescheduleNotification } from "@/lib/booking-obligations";

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
    await assertBooklyFresh(database);
    const stored = await readBookingSettings(database);
    const booking = await database.prepare("SELECT * FROM appointments WHERE reference = ?").bind(payload.reference).first<ManagedBooking>();
    if (!booking) return Response.json({ error: "Booking not found." }, { status: 404 });
    if (booking.revision !== payload.revision) throw new BookingConflict("The booking changed. Refresh and try again.");
    const target = payload.action === "reschedule" ? { date: payload.date!, time: payload.time! } : undefined;
    if (payload.action === "reschedule") {
      // The move and its customer email commit together. The email is sent only
      // once Bookly has accepted the move (immediately when the bridge is off);
      // a move Bookly rejects is restored and never reported or notified.
      const change = await changeBooking(database, booking, "reschedule", user.id, target, stored,
        changeId => [rescheduleNotification(database, booking, changeId)]);
      const calendar = await pushAfterCommit(database, [booking.id]);
      try { await processBookingObligations(database, { changeIds: [change.changeId], limit: 1 }); }
      catch { console.error("Reschedule notification deferred to background retry"); }
      const current = await database.prepare("SELECT revision, appointment_date, start_time FROM appointments WHERE id = ?").bind(booking.id)
        .first<{ revision: number; appointment_date: string; start_time: string }>();
      if (calendar === "conflict") {
        const restored = current?.appointment_date === booking.appointment_date && current?.start_time === booking.start_time;
        return Response.json({
          error: restored
            ? "That time was just booked in Bookly. The booking stays at its original time and the customer was not notified."
            : "Bookly rejected this move. It is held for reconciliation in Backstage and the customer was not notified.",
          changed: false, restored, calendar, revision: current?.revision ?? change.revision,
        }, { status: 409 });
      }
      const { notificationsSent } = await obligationSummary(database, [change.changeId]);
      return Response.json({ changed: true, revision: current?.revision ?? change.revision, notificationsSent, refundStatus: "not_needed", calendar });
    }
    const change = await changeBooking(database, booking, payload.action, user.id, target, stored);
    // Committed: refunds and notifications run even when Bookly delivery waits.
    const refundStatus = payload.action === "cancel"
      ? await refundCancelledBooking(database, booking, user.id)
      : "not_needed";
    const calendar = await pushAfterCommit(database, [booking.id]);
    let notificationsSent = true;
    if (payload.action !== "complete" && booking.customer_email) {
      notificationsSent = await sendBookingChangeNotification(
        booking,
        payload.action,
        change.changeId,
        target,
        refundStatus,
      );
    }
    return Response.json({
      changed: true,
      revision: change.revision + (refundStatus === "refunded" ? 1 : 0),
      notificationsSent,
      refundStatus,
      calendar,
    });
  } catch (error) {
    if (error instanceof BookingConflict || error instanceof BooklyConflict) return Response.json({ error: error.message }, { status: 409 });
    console.error("Staff booking change failed");
    return Response.json({ error: "Unable to save the booking. Refresh before retrying." }, { status: 503 });
  }
}
