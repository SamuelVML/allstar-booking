import { addMinutes, buildAvailableTimes, dateIsValid, getTodayInEindhoven, makeSlotKeys } from "@/lib/booking";
import {
  readBookingSettings,
  type StoredBookingSettings,
} from "@/lib/booking-settings";

export type ManagedBooking = {
  id: string; reference: string; revision: number; status: string;
  appointment_date: string; start_time: string; end_time: string;
  duration_minutes: number; handling_minutes: number;
  customer_account_id: string | null; customer_name: string; customer_email: string;
  service_name: string; price_cents: number; payment_status: string;
  payment_method: string; stripe_checkout_session_id: string | null;
};

export class BookingConflict extends Error {}

export function validManagementDate(date: string, bookingWindowDays = 60) {
  const today = getTodayInEindhoven();
  const maximum = new Date(`${today}T12:00:00Z`);
  maximum.setUTCDate(maximum.getUTCDate() + bookingWindowDays);
  return dateIsValid(date) && date >= today && date <= maximum.toISOString().slice(0, 10);
}

export async function availableForBooking(
  database: D1Database,
  booking: ManagedBooking,
  date: string,
  stored?: StoredBookingSettings,
) {
  const { settings } = stored ?? await readBookingSettings(database);
  const rows = await database.prepare(
    "SELECT slot_start FROM (SELECT slot_start, appointment_id FROM appointment_slots UNION ALL SELECT slot_start, NULL AS appointment_id FROM time_off_slots) WHERE slot_start >= ? AND slot_start < ? AND (appointment_id IS NULL OR appointment_id != ?)",
  ).bind(`${date}T00:00`, `${date}T23:59`, booking.id).all<{ slot_start: string }>();
  return buildAvailableTimes(
    date,
    booking.duration_minutes,
    new Set(rows.results.map((row) => row.slot_start)),
    booking.handling_minutes,
    0,
    new Date(),
    settings,
  );
}

export async function changeBooking(database: D1Database, booking: ManagedBooking, action: "cancel" | "reschedule" | "complete", actorId: string, target?: { date: string; time: string }, stored?: StoredBookingSettings) {
  const currentSettings = stored ?? await readBookingSettings(database);
  if (booking.status !== "confirmed") throw new BookingConflict("Only confirmed bookings can be changed.");
  if (action === "reschedule") {
    if (!target || !validManagementDate(target.date, currentSettings.settings.bookingWindowDays) || !(await availableForBooking(database, booking, target.date, currentSettings)).includes(target.time)) {
      throw new BookingConflict("That time is unavailable. Choose another slot.");
    }
    if (target.date === booking.appointment_date && target.time === booking.start_time) throw new BookingConflict("Choose a different appointment time.");
  }
  const changeId = crypto.randomUUID();
  const gate = "EXISTS (SELECT 1 FROM booking_changes WHERE id = ?)";
  // D1 batch is transactional. A competing change fails the revision check;
  // all subsequent writes are gated by the audit row created in this batch.
  const statements = [database.prepare(
    `INSERT INTO booking_changes (id, appointment_id, revision, action, actor_id, previous_date, previous_time, new_date, new_time)
     SELECT ?, id, revision + 1, ?, ?, appointment_date, start_time, ?, ?
     FROM appointments WHERE id = ? AND revision = ? AND status = 'confirmed'`,
  ).bind(changeId, action, actorId, target?.date ?? null, target?.time ?? null, booking.id, booking.revision)];

  if (action === "complete") {
    statements.push(
      database.prepare(`INSERT INTO loyalty_events (id, customer_account_id, appointment_id, points_delta, event_type)
        SELECT ?, ?, ?, 1, 'visit_completed' WHERE ${gate} AND ? IS NOT NULL`).bind(crypto.randomUUID(), booking.customer_account_id, booking.id, changeId, booking.customer_account_id),
      database.prepare(`UPDATE customer_accounts SET loyalty_points = loyalty_points + 1,
        completed_visits = completed_visits + 1, last_visit_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND ${gate}`).bind(booking.customer_account_id, changeId),
      database.prepare(`UPDATE appointments SET status = 'completed', revision = revision + 1 WHERE id = ? AND ${gate}`).bind(booking.id, changeId),
    );
  } else {
    statements.push(database.prepare(`DELETE FROM appointment_slots WHERE appointment_id = ? AND ${gate}`).bind(booking.id, changeId));
    if (action === "reschedule" && target) {
      for (const slot of makeSlotKeys(target.date, target.time, booking.duration_minutes + booking.handling_minutes)) {
        statements.push(database.prepare(`INSERT INTO appointment_slots (slot_start, appointment_id) SELECT ?, ? WHERE ${gate}`).bind(slot, booking.id, changeId));
      }
      statements.push(database.prepare(`UPDATE appointments SET appointment_date = ?, start_time = ?, end_time = ?, revision = revision + 1 WHERE id = ? AND ${gate}`)
        .bind(target.date, target.time, addMinutes(target.time, booking.duration_minutes), booking.id, changeId));
    } else {
      // The protected route triggers any required Stripe refund after this
      // transaction commits. Keeping these separate avoids holding a D1
      // transaction open across an external request.
      statements.push(database.prepare(`UPDATE appointments SET status = 'cancelled', revision = revision + 1 WHERE id = ? AND ${gate}`).bind(booking.id, changeId));
    }
  }
  let results;
  try { results = await database.batch(statements); }
  catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed|Slot unavailable/.test(error.message)) throw new BookingConflict("The booking or slot changed. Refresh and try again.");
    throw error;
  }
  if (results[0].meta.changes !== 1) throw new BookingConflict("The booking changed. Refresh and try again.");
  return { changeId, revision: booking.revision + 1 };
}
