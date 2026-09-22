/**
 * Shaping shared by every Backstage screen: how a day reads as an agenda, what
 * a payment state is called, and how much of the day is still open.
 *
 * Pure functions over rows already read from D1 — no database or network
 * access, so pages and the reporting endpoint agree by construction.
 */

import {
  addMinutes,
  DAILY_BREAKS,
  HANDLING_BUFFER_MINUTES,
  OPENING_HOURS,
} from "@/lib/booking";

export type AdminAppointment = {
  reference: string;
  revision: number;
  source: string;
  customer_account_id: string | null;
  service_name: string;
  price_cents: number;
  appointment_date: string;
  start_time: string;
  end_time: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  notes: string;
  status: string;
  payment_method: string;
  payment_status: string;
};

export type TimeOffBlock = {
  id: string;
  start_time: string;
  end_time: string;
  reason: string;
};

/** Money actually received, money merely promised, and everything between. */
export type PaymentTone = "paid" | "due" | "pending" | "cancelled";

export type PaymentInfo = {
  /** Short badge text for dense rows. */
  label: string;
  /** Full sentence for the appointment sheet. */
  line: string;
  tone: PaymentTone;
};

/** The one place a payment tone becomes a colour. */
export const TONE_COLOR: Record<PaymentTone, string> = {
  paid: "var(--paid)",
  due: "var(--due)",
  pending: "var(--pending)",
  cancelled: "var(--cancelled)",
};

/**
 * Which deployment the barber is looking at. Derived from the request host —
 * no configuration or secret reaches the page.
 */
export function environmentLabel(host: string) {
  return host.includes("-test") || host.includes("localhost") || host.includes("127.0.0.1")
    ? "Test"
    : "Live";
}

export function toMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function toTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function weekdayOf(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Monday of the week the given date falls in. */
export function mondayOf(date: string) {
  return shiftDate(date, -((weekdayOf(date) + 6) % 7));
}

export function openingHoursFor(date: string) {
  return OPENING_HOURS[weekdayOf(date)] ?? null;
}

export function breaksFor(date: string) {
  return DAILY_BREAKS[weekdayOf(date)] ?? [];
}

export function isLive(appointment: AdminAppointment) {
  return appointment.status === "confirmed" || appointment.status === "completed";
}

/**
 * What the money is doing. Booked value is never described as received: only
 * `payment_status === "paid"` counts as money in.
 */
export function paymentInfo(appointment: AdminAppointment): PaymentInfo {
  const paid = appointment.payment_status === "paid";

  if (appointment.status === "cancelled") {
    return paid
      ? { label: "Paid · cancelled", line: "Paid, then cancelled — not refunded here", tone: "cancelled" }
      : { label: "Cancelled", line: "No payment taken", tone: "cancelled" };
  }
  if (appointment.status === "payment_expired") {
    return {
      label: "Payment expired",
      line: "The online payment hold expired and the slot was released",
      tone: "cancelled",
    };
  }
  if (paid) {
    if (appointment.payment_method === "stripe") {
      return { label: "Paid online", line: "Paid online (Stripe)", tone: "paid" };
    }
    if (appointment.payment_method === "cash") {
      return { label: "Paid cash", line: "Paid in cash at the shop", tone: "paid" };
    }
    if (appointment.payment_method === "card") {
      return { label: "Paid card", line: "Paid by card at the shop", tone: "paid" };
    }
    return { label: "Paid", line: "Payment recorded", tone: "paid" };
  }
  if (appointment.status === "payment_pending") {
    return {
      label: "Awaiting online",
      line: "Awaiting online payment — the slot is held for 30 minutes",
      tone: "pending",
    };
  }
  return { label: "Due at shop", line: "Due at the shop", tone: "due" };
}

/** Staff may record a shop payment only against an unpaid, non-Stripe booking. */
export function canRecordPayment(appointment: AdminAppointment) {
  return (
    isLive(appointment) &&
    appointment.payment_status === "due_at_shop" &&
    appointment.payment_method !== "stripe"
  );
}

export function canManage(appointment: AdminAppointment) {
  return appointment.status === "confirmed";
}

/** Everything that occupies chair time on this date, as [start, end) minutes. */
export function occupiedRanges(
  date: string,
  appointments: AdminAppointment[],
  blocks: TimeOffBlock[],
  exceptReference?: string,
) {
  const ranges: Array<[number, number]> = [];
  for (const appointment of appointments) {
    if (!isLive(appointment)) continue;
    if (appointment.reference === exceptReference) continue;
    const start = toMinutes(appointment.start_time);
    ranges.push([start, toMinutes(appointment.end_time) + HANDLING_BUFFER_MINUTES]);
  }
  for (const block of blocks) {
    ranges.push([toMinutes(block.start_time), toMinutes(block.end_time)]);
  }
  for (const period of breaksFor(date)) {
    ranges.push([toMinutes(period.start), toMinutes(period.end)]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Minutes of opening hours that nothing is using yet. */
export function openMinutes(
  date: string,
  appointments: AdminAppointment[],
  blocks: TimeOffBlock[],
) {
  const hours = openingHoursFor(date);
  if (!hours) return 0;
  const total = toMinutes(hours.end) - toMinutes(hours.start);

  // Merge overlaps so a break inside an appointment is not counted twice.
  let used = 0;
  let cursor = -1;
  for (const [start, end] of occupiedRanges(date, appointments, blocks)) {
    const from = Math.max(start, cursor, toMinutes(hours.start));
    const to = Math.min(end, toMinutes(hours.end));
    if (to > from) used += to - from;
    cursor = Math.max(cursor, to);
  }
  return Math.max(0, total - used);
}

export function openLabel(minutes: number) {
  if (minutes <= 0) return "0 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${String(rest).padStart(2, "0")}` : `${hours}h`;
}

export type AgendaEntry =
  | { kind: "gap"; start: string; minutes: number }
  | { kind: "appointment"; appointment: AdminAppointment }
  | { kind: "block"; block: TimeOffBlock }
  | { kind: "break"; start: string; end: string };

/**
 * The day as the barber reads it: chronological, with the open stretches
 * called out between bookings instead of left as blank space.
 */
export function buildAgenda(
  date: string,
  appointments: AdminAppointment[],
  blocks: TimeOffBlock[],
): AgendaEntry[] {
  const hours = openingHoursFor(date);
  const items: Array<{ start: number; end: number; entry: AgendaEntry }> = [
    ...appointments.map((appointment) => ({
      start: toMinutes(appointment.start_time),
      end: toMinutes(appointment.end_time),
      entry: { kind: "appointment", appointment } as AgendaEntry,
    })),
    ...blocks.map((block) => ({
      start: toMinutes(block.start_time),
      end: toMinutes(block.end_time),
      entry: { kind: "block", block } as AgendaEntry,
    })),
    ...breaksFor(date).map((period) => ({
      start: toMinutes(period.start),
      end: toMinutes(period.end),
      entry: { kind: "break", start: period.start, end: period.end } as AgendaEntry,
    })),
  ].sort((a, b) => a.start - b.start);

  const agenda: AgendaEntry[] = [];
  let cursor = hours ? toMinutes(hours.start) : 0;

  for (const item of items) {
    const isCancelled =
      item.entry.kind === "appointment" && !isLive(item.entry.appointment);
    if (hours && !isCancelled && item.start - cursor >= 15) {
      agenda.push({ kind: "gap", start: toTime(cursor), minutes: item.start - cursor });
    }
    agenda.push(item.entry);
    if (!isCancelled) {
      const tail = item.entry.kind === "appointment" ? HANDLING_BUFFER_MINUTES : 0;
      cursor = Math.max(cursor, item.end + tail);
    }
  }

  if (hours && toMinutes(hours.end) - cursor >= 15) {
    agenda.push({ kind: "gap", start: toTime(cursor), minutes: toMinutes(hours.end) - cursor });
  }
  return agenda;
}

/**
 * Who is next. During opening hours that is whoever is in the chair or about
 * to be; on another date it is simply the first confirmed appointment.
 */
export function nextAppointment(
  appointments: AdminAppointment[],
  isToday: boolean,
  now: string,
) {
  const confirmed = appointments.filter((appointment) => appointment.status === "confirmed");
  if (!isToday) return confirmed[0] ?? null;
  const nowMinutes = toMinutes(now);
  return (
    confirmed.find((appointment) => toMinutes(appointment.end_time) > nowMinutes) ?? null
  );
}

export function durationOf(appointment: AdminAppointment) {
  return toMinutes(appointment.end_time) - toMinutes(appointment.start_time);
}

/**
 * Start times a walk-in could take on this date, at the 15-minute rhythm the
 * barber books to. Staff have no one-hour lead time, but opening hours,
 * breaks, existing bookings and the handling buffer all still apply.
 */
export function staffSlots(
  date: string,
  serviceMinutes: number,
  appointments: AdminAppointment[],
  blocks: TimeOffBlock[],
  options: { from?: string; exceptReference?: string } = {},
) {
  const hours = openingHoursFor(date);
  if (!hours) return [];
  const occupied = occupiedRanges(date, appointments, blocks, options.exceptReference);
  const needed = serviceMinutes + HANDLING_BUFFER_MINUTES;
  const earliest = options.from ? toMinutes(options.from) : -1;

  const slots: Array<{ time: string; available: boolean }> = [];
  for (
    let time = hours.start;
    toMinutes(addMinutes(time, needed)) <= toMinutes(hours.end);
    time = addMinutes(time, 15)
  ) {
    const start = toMinutes(time);
    const end = start + needed;
    const clashes = occupied.some(([from, to]) => start < to && end > from);
    slots.push({ time, available: !clashes && start >= earliest });
  }
  return slots;
}
