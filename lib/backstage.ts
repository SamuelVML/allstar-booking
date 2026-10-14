import { filterBooklyTimes } from "@/lib/bookly";
import { addMinutes, buildAvailableTimes, getService, makeSlotKeys } from "@/lib/booking";
import { BookingConflict, validManagementDate } from "@/lib/booking-management";
import { readBookingSettings, type StoredBookingSettings } from "@/lib/booking-settings";
import type { ManagedBooking } from "@/lib/booking-management";
import { cancellationObligations } from "@/lib/booking-obligations";

async function batch(database: D1Database, statements: D1PreparedStatement[]) {
  try { return await database.batch(statements); }
  catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed|Slot unavailable/.test(error.message)) {
      throw new BookingConflict("The slot or booking changed. Refresh before retrying.");
    }
    throw error;
  }
}

export async function blockTime(database: D1Database, input: { id: string; date: string; start: string; end: string; reason: string }, actor: string, supplied?: StoredBookingSettings) {
  const stored = supplied ?? await readBookingSettings(database);
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (!validManagementDate(input.date, stored.settings.bookingWindowDays) || !/^([01]\d|2[0-3]):[0-5][05]$/.test(input.start) || !/^([01]\d|2[0-3]):[0-5][05]$/.test(input.end) || input.end <= input.start) {
    throw new BookingConflict(`Choose a date within ${stored.settings.bookingWindowDays} days and a valid time range in five-minute steps.`);
  }
  await batch(database, [
    database.prepare("INSERT INTO time_off (id, date, start_time, end_time, reason, actor_id) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(input.id, input.date, input.start, input.end, input.reason, actor),
    ...makeSlotKeys(input.date, input.start, minutes(input.end) - minutes(input.start)).map(slot =>
      database.prepare("INSERT INTO time_off_slots (slot_start, time_off_id) VALUES (?, ?)").bind(slot, input.id)),
  ]);
}

export async function timeOffConflicts(
  database: D1Database,
  fromDate: string,
  toDate: string,
) {
  return (
    await database
      .prepare(
        `SELECT * FROM appointments
         WHERE appointment_date >= ? AND appointment_date <= ?
           AND status = 'confirmed'
         ORDER BY appointment_date, start_time, reference`,
      )
      .bind(fromDate, toDate)
      .all<ManagedBooking>()
  ).results;
}

function datesBetween(fromDate: string, toDate: string) {
  const dates: string[] = [];
  const cursor = new Date(`${fromDate}T12:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= toDate && dates.length <= 366) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function fullDayStatements(
  database: D1Database,
  input: { fromDate: string; toDate: string; reason: string },
  actor: string,
  stored: StoredBookingSettings,
) {
  if (
    !validManagementDate(input.fromDate, stored.settings.bookingWindowDays) ||
    !validManagementDate(input.toDate, stored.settings.bookingWindowDays) ||
    input.toDate < input.fromDate
  ) {
    throw new BookingConflict(
      `Choose a valid vacation period within ${stored.settings.bookingWindowDays} days.`,
    );
  }

  let blockedDays = 0;
  const statements: D1PreparedStatement[] = [];
  for (const date of datesBetween(input.fromDate, input.toDate)) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const hours = stored.settings.openingHours[weekday];
    if (!hours) continue;
    const id = crypto.randomUUID();
    const minutes =
      Number(hours.end.slice(0, 2)) * 60 + Number(hours.end.slice(3)) -
      (Number(hours.start.slice(0, 2)) * 60 + Number(hours.start.slice(3)));
    statements.push(
      database
        .prepare(
          "INSERT INTO time_off (id, date, start_time, end_time, reason, actor_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id, date, hours.start, hours.end, input.reason, actor),
      ...makeSlotKeys(date, hours.start, minutes).map((slot) =>
        database
          .prepare("INSERT INTO time_off_slots (slot_start, time_off_id) VALUES (?, ?)")
          .bind(slot, id),
      ),
    );
    blockedDays += 1;
  }
  if (blockedDays === 0) throw new BookingConflict("That period contains no open shop days.");
  return { statements, blockedDays };
}

export async function blockFullDays(
  database: D1Database,
  input: { fromDate: string; toDate: string; reason: string },
  actor: string,
  stored: StoredBookingSettings,
) {
  const { statements, blockedDays } = fullDayStatements(database, input, actor, stored);
  await batch(database, statements);
  return blockedDays;
}

/** Block a vacation and cancel the bookings it covers in one D1 transaction.
 *
 * Each booking is guarded: if it changed since it was read (revision, status
 * or payment), the guard row violates its CHECK constraint and the whole batch
 * rolls back, including the vacation. Slots are released before the time-off
 * slots are inserted, so the overlap triggers still reject any booking that
 * appeared concurrently (rolling everything back). Refund and email
 * obligations are written in the same transaction and processed after commit.
 */
export async function blockFullDaysCancelling(
  database: D1Database,
  input: { fromDate: string; toDate: string; reason: string },
  conflicts: ManagedBooking[],
  actor: string,
  stored: StoredBookingSettings,
) {
  const { statements: timeOff, blockedDays } = fullDayStatements(database, input, actor, stored);
  const statements: D1PreparedStatement[] = [];
  const changeIds: string[] = [];
  for (const booking of conflicts) {
    if (booking.source === "bookly" || booking.status !== "confirmed") {
      throw new BookingConflict("The booking changed. Refresh before retrying.");
    }
    const changeId = crypto.randomUUID();
    const guard = crypto.randomUUID();
    changeIds.push(changeId);
    statements.push(
      database.prepare(`INSERT INTO bookly_revision_guards (id, valid)
        SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM appointments WHERE id = ? AND revision = ? AND status = 'confirmed'
          AND payment_status = ? AND payment_method = ?) THEN 1 ELSE 0 END`)
        .bind(guard, booking.id, booking.revision, booking.payment_status, booking.payment_method),
      database.prepare(`INSERT INTO booking_changes (id, appointment_id, revision, action, actor_id, previous_date, previous_time)
        SELECT ?, id, revision + 1, 'cancel', ?, appointment_date, start_time FROM appointments WHERE id = ? AND revision = ?`)
        .bind(changeId, actor, booking.id, booking.revision),
      database.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(booking.id),
      database.prepare("UPDATE appointments SET status = 'cancelled', revision = revision + 1 WHERE id = ? AND revision = ?")
        .bind(booking.id, booking.revision),
      ...cancellationObligations(database, booking, changeId),
      database.prepare("DELETE FROM bookly_revision_guards WHERE id = ?").bind(guard),
    );
  }
  try { await database.batch([...statements, ...timeOff]); }
  catch (error) {
    if (error instanceof Error && /CHECK constraint failed|UNIQUE constraint failed|Slot unavailable/.test(error.message)) {
      throw new BookingConflict("A booking or the calendar changed. Nothing was cancelled; refresh before retrying.");
    }
    throw error;
  }
  return { blockedDays, changeIds };
}

export async function removeBlock(database: D1Database, id: string, actor: string) {
  await database.batch([
    database.prepare("UPDATE time_off SET removed_at = CURRENT_TIMESTAMP, removed_by = ? WHERE id = ? AND removed_at IS NULL").bind(actor, id),
    database.prepare("DELETE FROM time_off_slots WHERE time_off_id = ? AND EXISTS (SELECT 1 FROM time_off WHERE id = ? AND removed_at IS NOT NULL)").bind(id, id),
  ]);
}

export async function createWalkIn(database: D1Database, input: { id: string; date: string; time: string; serviceId: string; name: string; notes: string }, actor: string, supplied?: StoredBookingSettings) {
  const stored = supplied ?? await readBookingSettings(database);
  const { settings } = stored;
  const service = getService(input.serviceId);
  if (!service || !validManagementDate(input.date, settings.bookingWindowDays)) throw new BookingConflict(`Choose a valid service and date within ${settings.bookingWindowDays} days.`);
  const rows = await database.prepare("SELECT slot_start FROM (SELECT slot_start FROM appointment_slots UNION ALL SELECT slot_start FROM bookly_occupied_slots UNION ALL SELECT slot_start FROM time_off_slots) WHERE slot_start >= ? AND slot_start < ?")
    .bind(`${input.date}T00:00`, `${input.date}T23:59`).all<{ slot_start: string }>();
  // Staff can book from the current time, without the online one-hour lead time.
  if (!buildAvailableTimes(input.date, service.durationMinutes, new Set(rows.results.map(row => row.slot_start)), settings.handlingBufferMinutes, 0, new Date(), settings).includes(input.time)) {
    throw new BookingConflict("That time is unavailable. Check opening hours, breaks and existing bookings.");
  }
  const checked = await filterBooklyTimes(service.id, service.durationMinutes + settings.handlingBufferMinutes, [{ date: input.date, times: [input.time] }]);
  if (!checked[0].times.includes(input.time)) throw new BookingConflict("That time is occupied in Bookly.");
  const reference = `WI-${input.date.replaceAll("-", "")}-${input.id.slice(0, 8).toUpperCase()}`;
  await batch(database, [
    database.prepare(`INSERT INTO appointments (id, reference, service_id, service_name, duration_minutes, price_cents,
      appointment_date, start_time, end_time, customer_name, customer_email, customer_phone, notes, handling_minutes, source, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, 'walk_in', ?)`)
      .bind(input.id, reference, service.id, service.name, service.durationMinutes, service.priceCents, input.date, input.time,
        addMinutes(input.time, service.durationMinutes), input.name, input.notes, settings.handlingBufferMinutes, actor),
    ...makeSlotKeys(input.date, input.time, service.durationMinutes + settings.handlingBufferMinutes).map(slot =>
      database.prepare("INSERT INTO appointment_slots (slot_start, appointment_id) VALUES (?, ?)").bind(slot, input.id)),
  ]);
  return reference;
}

export async function recordPayment(database: D1Database, input: { id: string; reference: string; revision: number; method: "cash" | "card" }, actor: string) {
  const results = await batch(database, [
    database.prepare(`INSERT INTO payment_receipts (id, appointment_id, amount_cents, method, actor_id)
      SELECT ?, id, price_cents, ?, ? FROM appointments WHERE reference = ? AND revision = ?
      AND source != 'bookly' AND status IN ('confirmed', 'completed') AND payment_status = 'due_at_shop' AND payment_method != 'stripe'`)
      .bind(input.id, input.method, actor, input.reference, input.revision),
    database.prepare(`UPDATE appointments SET payment_status = 'paid', payment_method = ?, paid_at = CURRENT_TIMESTAMP, revision = revision + 1
      WHERE reference = ? AND revision = ? AND EXISTS (SELECT 1 FROM payment_receipts WHERE id = ? AND appointment_id = appointments.id)`)
      .bind(input.method, input.reference, input.revision, input.id),
  ]);
  if (results[0].meta.changes !== 1) throw new BookingConflict("Already paid or booking changed. Refresh before retrying.");
}
