"use client";

import { formatPrice } from "@/lib/booking";
import {
  type AdminAppointment,
  type AgendaEntry,
  durationOf,
  openLabel,
  paymentInfo,
} from "@/lib/backstage-view";
import { Plus } from "@/lib/icons";
import { useDayActions } from "./day-actions";

/** The "+" in the Today header. */
export function AddButton() {
  const { openAdd } = useDayActions();
  return (
    <button
      type="button"
      className="btn-icon"
      aria-label="Add a walk-in or block time off"
      onClick={openAdd}
    >
      <Plus />
    </button>
  );
}

export function AddInlineButton({ label }: { label: string }) {
  const { openAdd } = useDayActions();
  return (
    <button type="button" className="btn btn-outline btn-xs" onClick={openAdd}>
      {label}
    </button>
  );
}

/** Who is in the chair, or who walks in next. */
export function NextUp({
  appointment,
  inChair,
}: {
  appointment: AdminAppointment;
  inChair: boolean;
}) {
  const { openAppointment, completeAppointment } = useDayActions();
  const payment = paymentInfo(appointment);

  return (
    <section className="next-up" aria-label={inChair ? "In the chair" : "Next up"}>
      <div className="next-up-top">
        <span className="kicker">{inChair ? "In the chair" : "Next up"}</span>
        <span className="pay">{payment.line}</span>
      </div>
      <div className="next-up-main">
        <div>
          <b className="time">{appointment.start_time}</b>
          <p className="who">{appointment.customer_name}</p>
          <p className="what">
            {appointment.service_name} · {durationOf(appointment)} min
          </p>
        </div>
        <b className="price">{formatPrice(appointment.price_cents)}</b>
      </div>
      <div className="next-up-actions">
        <button
          type="button"
          className="btn btn-ink btn-s"
          onClick={() => completeAppointment(appointment.reference)}
        >
          Complete visit
        </button>
        <button
          type="button"
          className="btn btn-outline btn-s"
          onClick={() => openAppointment(appointment.reference)}
        >
          Details &amp; actions
        </button>
      </div>
    </section>
  );
}

export function Agenda({
  entries,
  nextReference,
}: {
  entries: AgendaEntry[];
  nextReference: string | null;
}) {
  const { openAppointment, openBlock } = useDayActions();

  return (
    <section className="agenda" aria-label="Agenda">
      {entries.map((entry, index) => {
        if (entry.kind === "gap") {
          return (
            <div className="agenda-gap" key={`gap-${entry.start}-${index}`}>
              <span className="num">{entry.start}</span>
              <span className="rule">
                <i />
                Open · {openLabel(entry.minutes)}
                <i />
              </span>
            </div>
          );
        }

        if (entry.kind === "break") {
          return (
            <div className="agenda-block" key={`break-${entry.start}`}>
              <span className="agenda-time num">
                {entry.start}
                <br />
                <span style={{ fontWeight: 400 }}>{entry.end}</span>
              </span>
              <span>
                <strong>Break</strong>
                <span className="kind">Scheduled break</span>
              </span>
              <span className="tag">Break</span>
            </div>
          );
        }

        if (entry.kind === "block") {
          return (
            <button
              type="button"
              className="agenda-block"
              key={`block-${entry.block.id}`}
              onClick={() => openBlock(entry.block.id)}
            >
              <span className="agenda-time num">
                {entry.block.start_time}
                <br />
                <span style={{ fontWeight: 400 }}>{entry.block.end_time}</span>
              </span>
              <span>
                <strong>{entry.block.reason}</strong>
                <span className="kind">Time off · blocked online</span>
              </span>
              <span className="tag">Blocked</span>
            </button>
          );
        }

        const appointment = entry.appointment;
        const payment = paymentInfo(appointment);
        const isNext = appointment.reference === nextReference;

        return (
          <button
            type="button"
            key={appointment.reference}
            className={[
              "agenda-row",
              isNext ? "is-next" : "",
              appointment.status === "completed" ? "is-completed" : "",
              appointment.status === "cancelled" || appointment.status === "payment_expired"
                ? "is-cancelled"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => openAppointment(appointment.reference)}
            aria-label={`${appointment.start_time} ${appointment.customer_name}, ${appointment.service_name}, ${payment.label}`}
          >
            <span className="agenda-time">
              {appointment.start_time}
              <span>{appointment.end_time}</span>
            </span>
            <span className="agenda-who">
              <span className="who">{appointment.customer_name}</span>
              <span className="what">
                {appointment.service_name} · {durationOf(appointment)} min
                {appointment.source === "walk_in" ? " · Walk-in" : ""}
              </span>
            </span>
            <span className="agenda-meta">
              <b>{formatPrice(appointment.price_cents)}</b>
              <span className={`status status-${payment.tone}`}>{payment.label}</span>
            </span>
          </button>
        );
      })}

      <div className="agenda-legend">
        <span>
          <i style={{ background: "var(--paid)" }} />
          Paid
        </span>
        <span>
          <i style={{ background: "var(--due)" }} />
          Due at shop
        </span>
        <span>
          <i style={{ background: "var(--pending)" }} />
          Awaiting online payment
        </span>
        <span>
          <i style={{ background: "var(--cancelled)" }} />
          Cancelled
        </span>
        <span>
          <i className="next" />
          Next
        </span>
      </div>
    </section>
  );
}
