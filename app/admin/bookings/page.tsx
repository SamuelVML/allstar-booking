import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getStaffUser } from "@/lib/staff-auth";
import {
  dateIsValid,
  formatPrice,
  getCurrentTimeInEindhoven,
  getTodayInEindhoven,
} from "@/lib/booking";
import { readDay } from "@/lib/backstage-data";
import { readBookingSettings } from "@/lib/booking-settings";
import {
  buildAgenda,
  environmentLabel,
  isLive,
  nextAppointment,
  openingHoursFor,
  openLabel,
  openMinutes,
  shiftDate,
  toMinutes,
} from "@/lib/backstage-view";
import { ChevronLeft, ChevronRight, StarMark } from "@/lib/icons";
import DayActionsProvider from "../day-actions";
import { AddButton, AddInlineButton, Agenda, NextUp } from "../agenda";

export const dynamic = "force-dynamic";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  // Checked here as well as in the layout: no screen leans on the shell for
  // its authorisation.
  const requestHeaders = await headers();
  if (!(await getStaffUser(requestHeaders))) notFound();

  const params = await searchParams;
  const today = getTodayInEindhoven();
  const date = params.date && dateIsValid(params.date) ? params.date : today;
  const now = getCurrentTimeInEindhoven();
  const isToday = date === today;

  // The barber needs to know at a glance which deployment they are operating.
  const environment = environmentLabel(requestHeaders.get("host") ?? "");

  const [{ appointments, blocks }, { settings }] = await Promise.all([
    readDay(date),
    readBookingSettings(),
  ]);

  const live = appointments.filter(isLive);
  const booked = live.reduce((total, row) => total + row.price_cents, 0);
  const recorded = appointments
    .filter((row) => row.payment_status === "paid")
    .reduce((total, row) => total + row.price_cents, 0);

  const hours = openingHoursFor(date, settings);
  const free = openMinutes(date, appointments, blocks, settings);
  const agenda = buildAgenda(date, appointments, blocks, settings);
  const next = nextAppointment(appointments, isToday, now);
  const inChair = !!next && isToday && toMinutes(next.start_time) <= toMinutes(now);

  const dayTitle = isToday
    ? "Today"
    : new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(
        new Date(`${date}T12:00:00Z`),
      );
  const daySubtitle =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(new Date(`${date}T12:00:00Z`)) +
    (hours ? ` · Open ${hours.start}–${hours.end}` : " · Closed");

  const empty = appointments.length === 0 && blocks.length === 0;

  return (
    <DayActionsProvider
      date={date}
      today={today}
      now={now}
      appointments={appointments}
      blocks={blocks}
      settings={settings}
    >
      <header className="bs-head bs-head-dark on-dark">
        <div className="bs-head-row">
          <span className="bs-env">
            <StarMark />
            <span>Backstage · {environment}</span>
          </span>
          <AddButton />
        </div>

        <div className="day-nav">
          <div>
            <h1 className="display">{dayTitle}</h1>
            <p>{daySubtitle}</p>
          </div>
          <div className="day-nav-buttons">
            <a
              className="btn-icon"
              aria-label="Previous day"
              href={`/admin/bookings?date=${shiftDate(date, -1)}`}
            >
              <ChevronLeft />
            </a>
            <a
              className="btn-icon"
              aria-label="Next day"
              href={`/admin/bookings?date=${shiftDate(date, 1)}`}
            >
              <ChevronRight />
            </a>
          </div>
        </div>

        <dl className="kpis">
          <div>
            <dt>Booked value</dt>
            <dd className="value">{formatPrice(booked)}</dd>
            <dd className="sub">{live.length} confirmed / done</dd>
          </div>
          <div>
            <dt>Recorded</dt>
            <dd className="value">{formatPrice(recorded)}</dd>
            <dd className="sub">actually received</dd>
          </div>
          <div>
            <dt>Open time</dt>
            <dd className="value">{openLabel(free)}</dd>
            <dd className="sub">
              {blocks.length
                ? `${blocks.length} block${blocks.length > 1 ? "s" : ""}`
                : "no time off"}
            </dd>
          </div>
        </dl>
      </header>

      {/* On a phone this reads top to bottom: who is next, then the day.
          From 1024px the agenda takes the main column and the summary moves
          into a sidebar beside it. */}
      <div className="today-columns">
        {next && (
          <div className="today-next">
            <NextUp appointment={next} inChair={inChair} />
          </div>
        )}

        <div className="today-agenda">
          {empty ? (
            <div className="empty-state" style={{ margin: "40px var(--gutter)" }}>
              <strong>{hours ? "Nothing booked" : "Closed"}</strong>
              <p>
                {hours
                  ? "The whole day is open for online bookings."
                  : "No opening hours on this day."}
              </p>
              <AddInlineButton label="Add walk-in or time off" />
            </div>
          ) : (
            <Agenda entries={agenda} nextReference={next?.reference ?? null} />
          )}
        </div>

        <p className="today-note muted pretty">
          Booked value is what is on the books for this date. Recorded payments are what has
          actually been received against appointments on this date, including paid
          cancellations — not daily takings or profit.
        </p>
      </div>
    </DayActionsProvider>
  );
}
