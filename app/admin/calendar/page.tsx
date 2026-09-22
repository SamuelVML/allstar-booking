import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getStaffUser } from "@/lib/staff-auth";
import {
  dateIsValid,
  formatPrice,
  getCurrentTimeInEindhoven,
  getTodayInEindhoven,
} from "@/lib/booking";
import { type DatedTimeOffBlock, readDay, readRange } from "@/lib/backstage-data";
import {
  type AdminAppointment,
  isLive,
  mondayOf,
  openingHoursFor,
  openLabel,
  openMinutes,
  shiftDate,
  toMinutes,
} from "@/lib/backstage-view";
import { ChevronLeft, ChevronRight } from "@/lib/icons";
import DayActionsProvider from "../day-actions";
import Timeline, { AddToolbarButton } from "../timeline";

export const dynamic = "force-dynamic";

const dayFormat = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(
    new Date(`${date}T12:00:00Z`),
  );

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; view?: string }>;
}) {
  const user = await getStaffUser(await headers());
  if (!user) notFound();

  const params = await searchParams;
  const today = getTodayInEindhoven();
  const date = params.date && dateIsValid(params.date) ? params.date : today;
  const view = params.view === "week" ? "week" : "day";
  const now = getCurrentTimeInEindhoven();
  const monday = mondayOf(date);

  // The day is always loaded: the week view still opens appointments through
  // the same sheets, and the provider needs the selected day's rows.
  const { appointments, blocks } = await readDay(date);
  const hours = openingHoursFor(date);
  const free = openMinutes(date, appointments, blocks);

  // Monday–Saturday; the shop is closed on Sundays.
  const weekDates = Array.from({ length: 6 }, (_, index) => shiftDate(monday, index));
  const week: {
    appointments: AdminAppointment[];
    blocks: DatedTimeOffBlock[];
  } =
    view === "week"
      ? await readRange(weekDates[0], weekDates[5])
      : { appointments: [], blocks: [] };

  const weekDays = weekDates.map((value) => {
    const dayAppointments = week.appointments.filter(
      (row) => row.appointment_date === value,
    );
    const dayBlocks = week.blocks.filter((row) => row.date === value);
    const dayHours = openingHoursFor(value);
    const total = dayHours ? toMinutes(dayHours.end) - toMinutes(dayHours.start) : 0;
    const openLeft = openMinutes(value, dayAppointments, dayBlocks);
    const used = total - openLeft;
    const active = dayAppointments.filter((row) => row.status !== "cancelled");
    return {
      value,
      day: dayFormat(value, { day: "numeric" }),
      dow: dayFormat(value, { weekday: "short" }),
      count: active.length,
      openLabel: `${openLabel(openLeft)} open`,
      fill: total ? Math.min(100, Math.round((used / total) * 100)) : 0,
      hasTimeOff: dayBlocks.length > 0,
      value_cents: dayAppointments
        .filter(isLive)
        .reduce((total_, row) => total_ + row.price_cents, 0),
    };
  });

  const booked = appointments.filter((row) => row.status !== "cancelled").length;

  return (
    <DayActionsProvider
      date={date}
      today={today}
      now={now}
      appointments={appointments}
      blocks={blocks}
    >
      <header className="bs-head">
        <div className="bs-head-row">
          <h1 className="display display-m">Calendar</h1>
          <div className="seg" role="tablist" aria-label="Calendar view">
            <a role="tab" aria-selected={view === "day"} href={`/admin/calendar?date=${date}&view=day`}>
              Day
            </a>
            <a role="tab" aria-selected={view === "week"} href={`/admin/calendar?date=${date}&view=week`}>
              Week
            </a>
          </div>
        </div>

        <div className="cal-nav">
          <a
            className="btn-icon"
            aria-label={view === "week" ? "Previous week" : "Previous day"}
            href={`/admin/calendar?date=${shiftDate(date, view === "week" ? -7 : -1)}&view=${view}`}
          >
            <ChevronLeft />
          </a>
          <div className="cal-nav-title">
            <strong>
              {view === "week"
                ? `Week of ${dayFormat(monday, { day: "numeric", month: "long" })}`
                : dayFormat(date, { weekday: "long", day: "numeric", month: "long" })}
            </strong>
            <span>
              {view === "week"
                ? "Mon – Sat · Sunday closed"
                : hours
                  ? `Open ${hours.start}–${hours.end}`
                  : "Closed"}
            </span>
          </div>
          <a
            className="btn-icon"
            aria-label={view === "week" ? "Next week" : "Next day"}
            href={`/admin/calendar?date=${shiftDate(date, view === "week" ? 7 : 1)}&view=${view}`}
          >
            <ChevronRight />
          </a>
        </div>
      </header>

      <div className="bs-inner">
        {view === "day" ? (
          <>
            <div className="cal-tools">
              <span>{hours ? `${booked} booked · ${openLabel(free)} open` : "Closed"}</span>
              <AddToolbarButton label="+ Walk-in / time off" />
            </div>
            <Timeline
              date={date}
              appointments={appointments}
              blocks={blocks}
              now={now}
              isToday={date === today}
            />
          </>
        ) : (
          <>
            <div className="week-grid">
              {weekDays.map((day) => (
                <a
                  key={day.value}
                  className="week-day"
                  aria-current={day.value === date ? "date" : undefined}
                  href={`/admin/calendar?date=${day.value}&view=day`}
                >
                  <span className="dow">{day.dow}</span>
                  <b>{day.day}</b>
                  <span className="week-bar" aria-hidden="true">
                    <i style={{ height: `${day.fill}%` }} />
                  </span>
                  <span className="count">
                    {day.count} {day.count === 1 ? "appt" : "appts"}
                  </span>
                  <span className="open">{day.openLabel}</span>
                </a>
              ))}
            </div>
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 12 }}>
              The bar is the share of opening hours already committed — bookings, breaks and
              time off. Tap a day to open it.
            </p>
            <div className="week-list">
              {weekDays.map((day) => (
                <div key={day.value}>
                  <strong>{day.dow}</strong>
                  <span>
                    {day.hasTimeOff ? "Time off · " : ""}
                    {day.count} booked · {day.openLabel}
                  </span>
                  <b className="num">{formatPrice(day.value_cents)}</b>
                </div>
              ))}
            </div>
            <p className="muted pretty" style={{ margin: "16px 0 0", fontSize: 12 }}>
              Values are booked value for confirmed and completed visits — not money received.
            </p>
          </>
        )}
      </div>
    </DayActionsProvider>
  );
}
