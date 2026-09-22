/**
 * Revenue reporting.
 *
 * One rule runs through all of it: booked value is never described as money
 * received. `recordedCents` counts only appointments whose payment_status is
 * `paid`; `bookedCents` counts confirmed and completed visits regardless of
 * whether anyone has paid. Totals follow the appointment date, not the day the
 * money moved, and paid cancellations stay in recorded payments because the
 * shop still holds that money.
 */

import { type AdminAppointment, isLive, mondayOf, shiftDate } from "@/lib/backstage-view";

export type Period = "day" | "week" | "month";

export function isPeriod(value: string | undefined): value is Period {
  return value === "day" || value === "week" || value === "month";
}

export function periodRange(period: Period, date: string): { from: string; to: string } {
  if (period === "day") return { from: date, to: date };
  if (period === "week") {
    const monday = mondayOf(date);
    return { from: monday, to: shiftDate(monday, 6) };
  }
  const first = `${date.slice(0, 7)}-01`;
  // The last day of the month is the day before the first of the next one.
  const nextMonth = new Date(`${first}T12:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return { from: first, to: shiftDate(nextMonth.toISOString().slice(0, 10), -1) };
}

export type RevenueBucket = {
  key: "stripe" | "cash" | "card" | "pending" | "cancelled";
  label: string;
  detail: string;
  cents: number;
  tone: "paid" | "due" | "cancelled";
};

export type RevenueBar = { label: string; from: string; cents: number };

export type RevenueSummary = {
  period: Period;
  from: string;
  to: string;
  recordedCents: number;
  bookedCents: number;
  buckets: RevenueBucket[];
  bars: RevenueBar[];
  /** What the bars are grouped by, for the chart heading. */
  barGrouping: "day" | "week" | "none";
};

const paid = (appointment: AdminAppointment) => appointment.payment_status === "paid";

function sum(appointments: AdminAppointment[], match: (row: AdminAppointment) => boolean) {
  return appointments.reduce(
    (total, row) => (match(row) ? total + row.price_cents : total),
    0,
  );
}

export function summarise(
  period: Period,
  date: string,
  appointments: AdminAppointment[],
): RevenueSummary {
  const { from, to } = periodRange(period, date);
  const rows = appointments.filter(
    (row) => row.appointment_date >= from && row.appointment_date <= to,
  );

  const buckets: RevenueBucket[] = [
    {
      key: "stripe",
      label: "Online (Stripe)",
      detail: "Paid at booking",
      cents: sum(rows, (row) => paid(row) && row.payment_method === "stripe"),
      tone: "paid",
    },
    {
      key: "cash",
      label: "Cash at the shop",
      detail: "Recorded by staff",
      cents: sum(rows, (row) => paid(row) && row.payment_method === "cash"),
      tone: "paid",
    },
    {
      key: "card",
      label: "Card at the shop",
      detail: "Recorded by staff",
      cents: sum(rows, (row) => paid(row) && row.payment_method === "card"),
      tone: "paid",
    },
    {
      key: "pending",
      label: "Pending",
      detail: "Due at the shop or awaiting online payment",
      cents: sum(rows, (row) => row.status !== "cancelled" && !paid(row)),
      tone: "due",
    },
    {
      key: "cancelled",
      label: "Cancelled value",
      detail: "Not counted in booked value",
      cents: sum(rows, (row) => row.status === "cancelled"),
      tone: "cancelled",
    },
  ];

  const bars: RevenueBar[] = [];
  let barGrouping: RevenueSummary["barGrouping"] = "none";

  if (period === "week") {
    barGrouping = "day";
    for (let index = 0; index < 7; index += 1) {
      const day = shiftDate(from, index);
      bars.push({
        label: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(
          new Date(`${day}T12:00:00Z`),
        ),
        from: day,
        cents: sum(rows, (row) => paid(row) && row.appointment_date === day),
      });
    }
  } else if (period === "month") {
    // Weekly bars keep a month legible on a phone; per-day bars would be
    // thirty-one slivers.
    barGrouping = "week";
    let cursor = from;
    while (cursor <= to) {
      const weekEnd = shiftDate(mondayOf(cursor), 6);
      const chunkEnd = weekEnd < to ? weekEnd : to;
      bars.push({
        label: `${cursor.slice(8)}–${chunkEnd.slice(8)}`,
        from: cursor,
        cents: sum(
          rows,
          (row) =>
            paid(row) && row.appointment_date >= cursor && row.appointment_date <= chunkEnd,
        ),
      });
      cursor = shiftDate(chunkEnd, 1);
    }
  }

  return {
    period,
    from,
    to,
    recordedCents: sum(rows, paid),
    bookedCents: sum(rows, isLive),
    buckets,
    bars,
    barGrouping,
  };
}
