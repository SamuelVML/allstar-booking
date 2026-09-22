import { z } from "zod";
import { getD1 } from "@/db";
import { authoriseStaffMutation } from "@/lib/staff-auth";
import { BookingConflict } from "@/lib/booking-management";
import {
  blockFullDays,
  blockTime,
  createWalkIn,
  recordPayment,
  removeBlock,
  timeOffConflicts,
} from "@/lib/backstage";
import { releaseExpiredPaymentReservations } from "@/lib/payments";
import { readBookingSettings } from "@/lib/booking-settings";
import { changeBooking } from "@/lib/booking-management";
import { refundCancelledBooking } from "@/lib/refunds";
import { sendBookingChangeNotification } from "@/lib/booking-email";
import type { ManagedBooking } from "@/lib/booking-management";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("block"), id: z.string().uuid(), date: z.string(), start: z.string(), end: z.string(), reason: z.string().trim().min(1).max(200) }),
  z.object({
    action: z.literal("block_range"),
    id: z.string().uuid(),
    fromDate: z.string(),
    toDate: z.string(),
    reason: z.string().trim().min(1).max(200),
    cancelConflicts: z.boolean().default(false),
  }),
  z.object({ action: z.literal("unblock"), id: z.string().uuid() }),
  z.object({ action: z.literal("walk_in"), id: z.string().uuid(), date: z.string(), time: z.string(), serviceId: z.string(), name: z.string().trim().min(1).max(80), notes: z.string().trim().max(1000) }),
  z.object({ action: z.literal("payment"), id: z.string().uuid(), reference: z.string().min(1).max(80), revision: z.number().int().nonnegative(), method: z.enum(["cash", "card"]) }),
  z.object({ action: z.literal("retry_refund"), id: z.string().uuid(), reference: z.string().min(1).max(80), revision: z.number().int().nonnegative() }),
]);
export async function POST(request: Request) {
  const user = await authoriseStaffMutation(request);
  if (!user) return Response.json({ error: "Not authorised." }, { status: 403 });
  let parsed;
  try { parsed = schema.safeParse(await request.json()); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  if (!parsed.success) return Response.json({ error: "Check the form fields and try again." }, { status: 400 });
  try {
    const database = getD1();
    const stored = await readBookingSettings(database);
    const input = parsed.data;
    if (input.action === "block" || input.action === "block_range" || input.action === "walk_in") await releaseExpiredPaymentReservations(database);
    if (input.action === "block") await blockTime(database, input, user.id, stored);
    if (input.action === "block_range") {
      const conflicts = await timeOffConflicts(database, input.fromDate, input.toDate);
      if (conflicts.length > 0 && !input.cancelConflicts) {
        return Response.json(
          {
            error: "Existing appointments must be rescheduled or cancelled before this vacation can be blocked.",
            conflicts: conflicts.map((booking) => ({
              reference: booking.reference,
              revision: booking.revision,
              date: booking.appointment_date,
              time: booking.start_time,
              customer: booking.customer_name,
              paidOnline:
                booking.payment_status === "paid" && booking.payment_method === "stripe",
              priceCents: booking.price_cents,
            })),
          },
          { status: 409 },
        );
      }

      const pendingReservation = await database
        .prepare(
          `SELECT reference FROM appointments
           WHERE appointment_date >= ? AND appointment_date <= ?
             AND status = 'payment_pending' LIMIT 1`,
        )
        .bind(input.fromDate, input.toDate)
        .first<{ reference: string }>();
      if (pendingReservation) {
        throw new BookingConflict(
          "An online payment is still pending in this period. Wait for it to complete or expire, then retry.",
        );
      }

      // Reserve the vacation before any irreversible cancellation, refund or
      // email side effect. Existing time off or an invalid range therefore
      // fails without changing a customer booking.
      const blockedDays = await blockFullDays(database, input, user.id, stored);

      let refundsPending = 0;
      let notificationsSent = true;
      for (const booking of conflicts) {
        const change = await changeBooking(database, booking, "cancel", user.id, undefined, stored);
        const refundStatus = await refundCancelledBooking(database, booking, user.id);
        if (refundStatus === "pending") refundsPending += 1;
        if (booking.customer_email) {
          notificationsSent =
            (await sendBookingChangeNotification(
              booking,
              "cancel",
              change.changeId,
              undefined,
              refundStatus,
            )) && notificationsSent;
        }
      }
      return Response.json({
        saved: true,
        blockedDays,
        cancelledBookings: conflicts.length,
        refundsPending,
        notificationsSent,
      });
    }
    if (input.action === "unblock") await removeBlock(database, input.id, user.id);
    if (input.action === "walk_in") await createWalkIn(database, input, user.id, stored);
    if (input.action === "payment") await recordPayment(database, input, user.id);
    if (input.action === "retry_refund") {
      const booking = await database
        .prepare("SELECT * FROM appointments WHERE reference = ?")
        .bind(input.reference)
        .first<ManagedBooking>();
      if (!booking) return Response.json({ error: "Booking not found." }, { status: 404 });
      if (booking.revision !== input.revision) {
        throw new BookingConflict("The booking changed. Refresh and try again.");
      }
      if (
        booking.status !== "cancelled" ||
        booking.payment_method !== "stripe" ||
        booking.payment_status !== "paid"
      ) {
        throw new BookingConflict("This booking does not have a pending Stripe refund.");
      }
      const refundStatus = await refundCancelledBooking(database, booking, user.id);
      return Response.json({ saved: true, refundStatus });
    }
    return Response.json({ saved: true });
  } catch (error) {
    if (error instanceof BookingConflict) return Response.json({ error: error.message }, { status: 409 });
    console.error("Backstage operation failed");
    return Response.json({ error: "Unable to save. Refresh to check whether it was saved before retrying." }, { status: 503 });
  }
}
