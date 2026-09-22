"use client";

import type { BookingSettings } from "@/lib/booking";
import {
  type AdminAppointment,
  breaksFor,
  isLive,
  openingHoursFor,
  paymentInfo,
  type TimeOffBlock,
  TONE_COLOR,
  toMinutes,
  toTime,
} from "@/lib/backstage-view";
import { useDayActions } from "./day-actions";

/** Pixels per minute. Tuned so a 15-minute slot is still tappable. */
const SCALE = 1.6;

export function AddToolbarButton({ label }: { label: string }) {
  const { openAdd } = useDayActions();
  return (
    <button type="button" className="btn btn-outline btn-xs" onClick={openAdd}>
      {label}
    </button>
  );
}

export default function Timeline({
  date,
  appointments,
  blocks,
  now,
  isToday,
  settings,
}: {
  date: string;
  appointments: AdminAppointment[];
  blocks: TimeOffBlock[];
  now: string;
  isToday: boolean;
  settings: BookingSettings;
}) {
  const { openAppointment, openBlock } = useDayActions();
  const hours = openingHoursFor(date, settings);

  if (!hours) {
    return (
      <div className="empty-state" style={{ marginTop: 20 }}>
        <strong>Closed</strong>
        <p>No opening hours on this day.</p>
      </div>
    );
  }

  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
  const height = (end - start) * SCALE + 8;

  const hourMarks: number[] = [];
  for (let minute = start; minute <= end; minute += 60) hourMarks.push(minute);

  const items = [
    ...appointments.map((appointment) => ({
      key: appointment.reference,
      from: toMinutes(appointment.start_time),
      to: toMinutes(appointment.end_time),
      title: appointment.customer_name,
      sub: appointment.service_name,
      className: [
        "timeline-item",
        "appt",
        appointment.status === "completed" ? "is-completed" : "",
        !isLive(appointment) ? "is-cancelled" : "",
      ]
        .filter(Boolean)
        .join(" "),
      rail: TONE_COLOR[paymentInfo(appointment).tone],
      onOpen: () => openAppointment(appointment.reference),
    })),
    ...blocks.map((block) => ({
      key: `block-${block.id}`,
      from: toMinutes(block.start_time),
      to: toMinutes(block.end_time),
      title: block.reason,
      sub: "Time off",
      className: "timeline-item block",
      rail: "var(--muted)",
      onOpen: () => openBlock(block.id),
    })),
    ...breaksFor(date, settings).map((period) => ({
      key: `break-${period.start}`,
      from: toMinutes(period.start),
      to: toMinutes(period.end),
      title: "Break",
      sub: "",
      className: "timeline-item brk",
      rail: "var(--hairline)",
      onOpen: null as null | (() => void),
    })),
  ].sort((a, b) => a.from - b.from);

  const nowMinutes = toMinutes(now);
  const showNow = isToday && nowMinutes >= start && nowMinutes <= end;

  return (
    <div className="timeline" style={{ height }}>
      {hourMarks.map((minute) => (
        <div
          className="timeline-hour"
          key={minute}
          style={{ top: (minute - start) * SCALE }}
          aria-hidden="true"
        >
          <span>{toTime(minute)}</span>
          <i />
        </div>
      ))}

      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={item.className}
          disabled={!item.onOpen}
          onClick={() => item.onOpen?.()}
          style={{
            top: (item.from - start) * SCALE,
            height: Math.max((item.to - item.from) * SCALE - 2, 18),
            borderLeftColor: item.rail,
          }}
        >
          <span className="t-title">
            <strong>{item.title}</strong> {item.sub && <span>{item.sub}</span>}
          </span>
          <span className="t-range num">
            {toTime(item.from)}–{toTime(item.to)}
          </span>
        </button>
      ))}

      {showNow && (
        <div
          className="timeline-now"
          style={{ top: (nowMinutes - start) * SCALE }}
          aria-hidden="true"
        >
          <span>{now}</span>
        </div>
      )}
    </div>
  );
}
