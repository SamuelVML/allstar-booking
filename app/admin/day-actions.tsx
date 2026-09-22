"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatPrice, HANDLING_BUFFER_MINUTES, SERVICES } from "@/lib/booking";
import {
  type AdminAppointment,
  canManage,
  canRecordPayment,
  durationOf,
  openingHoursFor,
  paymentInfo,
  shiftDate,
  staffSlots,
  type TimeOffBlock,
  TONE_COLOR,
} from "@/lib/backstage-view";
import { ArrowLeft, Check, Close } from "@/lib/icons";

const BOOKABLE = SERVICES.filter((service) => !service.isAddOn);
const RESCHEDULE_DAYS = 14;

type Sheet =
  | { kind: "appointment"; reference: string }
  | { kind: "reschedule"; reference: string }
  | { kind: "add" }
  | { kind: "block"; id: string }
  | null;

type Confirm = {
  title: string;
  body: string;
  warning?: string;
  cta: string;
  destructive?: boolean;
  run: () => Promise<void>;
} | null;

type DayActions = {
  openAppointment: (reference: string) => void;
  openBlock: (id: string) => void;
  openAdd: () => void;
  /** Straight to the confirmation — the one action fast enough to want a shortcut. */
  completeAppointment: (reference: string) => void;
};

const DayActionsContext = createContext<DayActions | null>(null);

export function useDayActions() {
  const value = useContext(DayActionsContext);
  if (!value) throw new Error("useDayActions must be used inside DayActionsProvider");
  return value;
}

function longDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${date}T12:00:00Z`));
}

function shortDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T12:00:00Z`));
}

export default function DayActionsProvider({
  date,
  today,
  now,
  appointments,
  blocks,
  children,
}: {
  date: string;
  today: string;
  /** Shop-local HH:MM, resolved on the server. */
  now: string;
  appointments: AdminAppointment[];
  blocks: TimeOffBlock[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);

  // Add sheet
  const [addMode, setAddMode] = useState<"walk_in" | "block">("walk_in");
  const [walkInName, setWalkInName] = useState("Walk-in");
  const [walkInService, setWalkInService] = useState(BOOKABLE[0].id);
  const [walkInTime, setWalkInTime] = useState("");
  const [walkInNotes, setWalkInNotes] = useState("");
  const [blockStart, setBlockStart] = useState("");
  const [blockEnd, setBlockEnd] = useState("");
  const [blockReason, setBlockReason] = useState("");

  // Reschedule sheet
  const [moveDate, setMoveDate] = useState("");
  const [moveTime, setMoveTime] = useState("");
  // Keyed on the request it answers, so "loading" is derived rather than a
  // second piece of state that can fall out of step.
  const [moveResult, setMoveResult] = useState<{
    key: string;
    times: string[];
    error: string;
  }>({ key: "", times: [], error: "" });

  const selected =
    sheet && (sheet.kind === "appointment" || sheet.kind === "reschedule")
      ? appointments.find((item) => item.reference === sheet.reference) ?? null
      : null;
  const selectedBlock =
    sheet && sheet.kind === "block"
      ? blocks.find((item) => item.id === sheet.id) ?? null
      : null;

  const showToast = useCallback((message: string, error?: boolean) => {
    setToast({ message, error });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(timer);
  }, [toast]);

  // Escape closes whatever is on top.
  useEffect(() => {
    if (!sheet && !confirm) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || busy) return;
      if (confirm) setConfirm(null);
      else setSheet(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, confirm, busy]);

  /* ------------------------------------------------------------ requests */

  async function post(url: string, payload: Record<string, unknown>) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = (await response.json().catch(() => ({}))) as {
      error?: string;
      notificationsSent?: boolean;
    };
    if (!response.ok) {
      throw new Error(
        result.error ?? "Unable to save. Refresh to check whether it was saved before retrying.",
      );
    }
    return result;
  }

  /** Runs a confirmed mutation, then refreshes the server-rendered day. */
  function runConfirmed(
    request: () => Promise<{ notificationsSent?: boolean }>,
    successMessage: string,
  ) {
    return async () => {
      setBusy(true);
      try {
        const result = await request();
        setConfirm(null);
        setSheet(null);
        if (result.notificationsSent === false) {
          showToast(
            "Saved, but the email did not go out. Contact the customer directly.",
            true,
          );
        } else {
          showToast(successMessage);
        }
        router.refresh();
      } catch (reason) {
        setConfirm(null);
        showToast(reason instanceof Error ? reason.message : "Unable to save.", true);
      } finally {
        setBusy(false);
      }
    };
  }

  function changeBooking(
    appointment: AdminAppointment,
    action: "cancel" | "reschedule" | "complete",
    target?: { date: string; time: string },
  ) {
    return () =>
      post("/api/admin/bookings/change", {
        reference: appointment.reference,
        revision: appointment.revision,
        action,
        ...target,
      });
  }

  function operation(payload: Record<string, unknown>) {
    return () => post("/api/admin/operations", { id: crypto.randomUUID(), ...payload });
  }

  /* -------------------------------------------------------- confirmations */

  function askComplete(appointment: AdminAppointment) {
    const info = paymentInfo(appointment);
    setConfirm({
      title: "Complete visit?",
      body: `Mark ${appointment.customer_name}'s ${appointment.service_name} as completed${
        appointment.customer_account_id ? " and award 1 loyalty point" : ""
      }.`,
      warning:
        info.tone === "paid"
          ? undefined
          : `This does not record payment. ${formatPrice(appointment.price_cents)} is still due.`,
      cta: "Complete",
      run: runConfirmed(
        changeBooking(appointment, "complete"),
        `Visit completed${appointment.customer_account_id ? " · 1 point awarded" : ""}`,
      ),
    });
  }

  function askCancel(appointment: AdminAppointment) {
    setConfirm({
      title: "Cancel booking?",
      body: `Cancel ${appointment.reference} and release ${appointment.start_time}–${appointment.end_time} for online booking.${
        appointment.customer_email ? " The customer receives a cancellation email." : ""
      }`,
      warning:
        appointment.payment_status === "paid"
          ? "Payment was already received. This does not issue a refund — handle it separately."
          : undefined,
      cta: "Cancel booking",
      destructive: true,
      run: runConfirmed(
        changeBooking(appointment, "cancel"),
        "Booking cancelled · slot released",
      ),
    });
  }

  function askPayment(appointment: AdminAppointment, method: "cash" | "card") {
    const amount = formatPrice(appointment.price_cents);
    setConfirm({
      title: method === "cash" ? "Cash received?" : "Card payment received?",
      body:
        method === "cash"
          ? `Record ${amount} received in cash from ${appointment.customer_name}. This records money already taken; nothing is charged.`
          : `Record ${amount} received by card at the shop from ${appointment.customer_name}. This records money already taken on the terminal; nothing is charged here.`,
      cta: method === "cash" ? "Confirm cash" : "Confirm card",
      run: runConfirmed(
        operation({
          action: "payment",
          reference: appointment.reference,
          revision: appointment.revision,
          method,
        }),
        `${method === "cash" ? "Cash" : "Card payment"} recorded · ${amount}`,
      ),
    });
  }

  function askMove(appointment: AdminAppointment) {
    setConfirm({
      title: "Move booking?",
      body: `Move ${appointment.customer_name} to ${longDate(moveDate)} at ${moveTime}. The customer receives an email with the new time.`,
      cta: "Move booking",
      run: runConfirmed(
        changeBooking(appointment, "reschedule", { date: moveDate, time: moveTime }),
        "Booking moved · email sent",
      ),
    });
  }

  function askUnblock(block: TimeOffBlock) {
    setConfirm({
      title: "Remove time off?",
      body: `Reopen ${block.start_time}–${block.end_time} (${block.reason}) for online booking.`,
      cta: "Remove",
      destructive: true,
      run: runConfirmed(
        operation({ action: "unblock", id: block.id }),
        "Time off removed · slots reopened",
      ),
    });
  }

  /* --------------------------------------------------------- walk-in data */

  const walkInServiceRecord =
    BOOKABLE.find((service) => service.id === walkInService) ?? BOOKABLE[0];
  const walkInSlots = staffSlots(
    date,
    walkInServiceRecord.durationMinutes,
    appointments,
    blocks,
    // Staff can start now — there is no one-hour online lead time — but not in
    // the past.
    date === today ? { from: now } : {},
  );
  const walkInReady = walkInName.trim().length > 0 && walkInTime.length > 0;
  const blockReady =
    blockStart.length > 0 && blockEnd.length > 0 && blockEnd > blockStart && blockReason.trim().length > 0;

  async function saveWalkIn() {
    setBusy(true);
    try {
      await post("/api/admin/operations", {
        id: crypto.randomUUID(),
        action: "walk_in",
        date,
        time: walkInTime,
        serviceId: walkInService,
        name: walkInName.trim(),
        notes: walkInNotes.trim(),
      });
      setSheet(null);
      showToast(`Walk-in added · ${walkInTime}`);
      router.refresh();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "Unable to save.", true);
    } finally {
      setBusy(false);
    }
  }

  async function saveBlock() {
    setBusy(true);
    try {
      await post("/api/admin/operations", {
        id: crypto.randomUUID(),
        action: "block",
        date,
        start: blockStart,
        end: blockEnd,
        reason: blockReason.trim(),
      });
      setSheet(null);
      showToast(`Time off blocked · ${blockStart}–${blockEnd}`);
      router.refresh();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "Unable to save.", true);
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------ reschedule data */

  function openReschedule(appointment: AdminAppointment) {
    setMoveDate(appointment.appointment_date);
    setMoveTime("");
    setMoveResult({ key: "", times: [], error: "" });
    setSheet({ kind: "reschedule", reference: appointment.reference });
  }

  const moveKey =
    sheet?.kind === "reschedule" && moveDate ? `${sheet.reference}|${moveDate}` : "";
  const loadingMoveTimes = moveKey !== "" && moveResult.key !== moveKey;
  const moveTimes = moveResult.key === moveKey ? moveResult.times : [];
  const moveError = moveResult.key === moveKey ? moveResult.error : "";

  useEffect(() => {
    if (sheet?.kind !== "reschedule" || !moveDate) return;
    const controller = new AbortController();
    const key = `${sheet.reference}|${moveDate}`;
    fetch(
      `/api/admin/bookings/availability?reference=${encodeURIComponent(sheet.reference)}&date=${encodeURIComponent(moveDate)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json()) as { times?: string[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Unable to load times.");
        const available = result.times ?? [];
        setMoveResult({
          key,
          times: available,
          error: available.length === 0 ? "No available times on this date." : "",
        });
      })
      .catch((reason) => {
        if (reason instanceof Error && reason.name !== "AbortError") {
          setMoveResult({ key, times: [], error: reason.message });
        }
      });
    return () => controller.abort();
  }, [sheet, moveDate]);

  const moveDates = Array.from({ length: RESCHEDULE_DAYS }, (_, index) => {
    const value = shiftDate(today, index);
    return {
      value,
      day: new Date(`${value}T12:00:00Z`).getUTCDate(),
      dow: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(
        new Date(`${value}T12:00:00Z`),
      ),
      closed: !openingHoursFor(value),
    };
  });

  const moveSlots =
    selected && moveDate
      ? staffSlots(moveDate, durationOf(selected), [], [], {}).map((slot) => ({
          time: slot.time,
          // The server is the authority on availability for another day.
          available:
            moveTimes.includes(slot.time) &&
            !(moveDate === selected.appointment_date && slot.time === selected.start_time),
        }))
      : [];

  /* ------------------------------------------------------------ rendering */

  const actions: DayActions = {
    openAppointment: (reference) => setSheet({ kind: "appointment", reference }),
    openBlock: (id) => setSheet({ kind: "block", id }),
    openAdd: () => {
      setAddMode("walk_in");
      setWalkInName("Walk-in");
      setWalkInService(BOOKABLE[0].id);
      setWalkInTime("");
      setWalkInNotes("");
      setBlockStart("");
      setBlockEnd("");
      setBlockReason("");
      setSheet({ kind: "add" });
    },
    completeAppointment: (reference) => {
      const appointment = appointments.find((item) => item.reference === reference);
      if (appointment) askComplete(appointment);
    },
  };

  return (
    <DayActionsContext.Provider value={actions}>
      {children}

      {/* Appointment ------------------------------------------------- */}
      {sheet?.kind === "appointment" && selected && (
        <>
          <button
            type="button"
            className="scrim"
            aria-label="Close"
            onClick={() => setSheet(null)}
          />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Appointment">
            <div className="sheet-head">
              <div>
                <span
                  className="eyebrow"
                  style={{
                    color:
                      selected.status === "cancelled"
                        ? "var(--cancelled)"
                        : selected.status === "completed"
                          ? "var(--paid)"
                          : "var(--red)",
                  }}
                >
                  {selected.status === "completed"
                    ? "Completed"
                    : selected.status === "cancelled"
                      ? "Cancelled"
                      : selected.source === "walk_in"
                        ? "Walk-in · confirmed"
                        : "Confirmed"}
                </span>
                <h2 className="display">{selected.customer_name}</h2>
                <p style={{ fontSize: 15, color: "var(--ink)" }}>
                  {selected.service_name} · {durationOf(selected)} min
                </p>
                <p>
                  {shortDate(selected.appointment_date)} · {selected.start_time}–
                  {selected.end_time}
                </p>
              </div>
              <button
                type="button"
                className="btn-icon"
                aria-label="Close"
                onClick={() => setSheet(null)}
              >
                <Close />
              </button>
            </div>

            <dl className="sheet-dl">
              <dt>Price</dt>
              <dd style={{ fontWeight: 700 }}>{formatPrice(selected.price_cents)}</dd>
              <dt>Payment</dt>
              <dd
                style={{
                  fontWeight: 700,
                  color: TONE_COLOR[paymentInfo(selected).tone],
                }}
              >
                {paymentInfo(selected).line}
              </dd>
              <dt>Reference</dt>
              <dd className="num" style={{ userSelect: "all" }}>
                {selected.reference}
              </dd>
              {selected.customer_phone || selected.customer_email ? (
                <>
                  <dt>Contact</dt>
                  <dd>
                    {selected.customer_phone}
                    {selected.customer_phone && selected.customer_email && <br />}
                    {selected.customer_email}
                  </dd>
                </>
              ) : null}
              {selected.notes ? (
                <>
                  <dt>Notes</dt>
                  <dd>{selected.notes}</dd>
                </>
              ) : null}
            </dl>

            {selected.customer_phone && (
              <div className="sheet-actions">
                <div className="pair">
                  <a
                    className="btn btn-quiet btn-s"
                    href={`tel:${selected.customer_phone.replace(/\s/g, "")}`}
                  >
                    Call
                  </a>
                  <a
                    className="btn btn-quiet btn-s"
                    href={`https://wa.me/${selected.customer_phone.replace(/\D/g, "")}`}
                  >
                    WhatsApp
                  </a>
                </div>
              </div>
            )}

            {canRecordPayment(selected) && (
              <>
                <p className="eyebrow sheet-label">
                  Record payment received · {formatPrice(selected.price_cents)}
                </p>
                <div className="sheet-actions">
                  <div className="pair">
                    <button
                      type="button"
                      className="btn btn-ink btn-s"
                      onClick={() => askPayment(selected, "cash")}
                    >
                      Cash
                    </button>
                    <button
                      type="button"
                      className="btn btn-ink btn-s"
                      onClick={() => askPayment(selected, "card")}
                    >
                      Card at shop
                    </button>
                  </div>
                </div>
              </>
            )}

            {selected.status === "payment_pending" && (
              <p className="notice" style={{ margin: "16px var(--gutter) 0" }}>
                Online payment pending — the slot is held for 30 minutes. Stripe bookings
                can&apos;t be marked paid manually.
              </p>
            )}

            {canManage(selected) && (
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => askComplete(selected)}
                >
                  Complete visit
                  {selected.customer_account_id ? " · +1 point" : ""}
                </button>
                <div className="pair">
                  <button
                    type="button"
                    className="btn btn-outline btn-s"
                    onClick={() => openReschedule(selected)}
                  >
                    Reschedule
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-s"
                    onClick={() => askCancel(selected)}
                  >
                    Cancel booking
                  </button>
                </div>
              </div>
            )}

            <p className="sheet-foot pretty">
              Completing a visit doesn&apos;t record payment. Recording a payment doesn&apos;t
              charge a card. Refunds are handled separately.
            </p>
          </div>
        </>
      )}

      {/* Reschedule --------------------------------------------------- */}
      {sheet?.kind === "reschedule" && selected && (
        <>
          <button
            type="button"
            className="scrim"
            aria-label="Close"
            onClick={() => setSheet(null)}
          />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Reschedule">
            <div className="sheet-head">
              <div>
                <span className="eyebrow">Reschedule</span>
                <h2 className="display" style={{ fontSize: 30 }}>
                  {selected.customer_name}
                </h2>
                <p>
                  Now {shortDate(selected.appointment_date)} · {selected.start_time} ·{" "}
                  {selected.service_name}
                </p>
              </div>
              <button
                type="button"
                className="btn-icon"
                aria-label="Back to appointment"
                onClick={() => setSheet({ kind: "appointment", reference: selected.reference })}
              >
                <ArrowLeft />
              </button>
            </div>

            <div className="sheet-pad">
              <p className="eyebrow" style={{ margin: "16px 0 8px" }}>
                New date
              </p>
              <div className="date-grid">
                {moveDates.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="date-cell"
                    style={{ aspectRatio: "auto", minHeight: 48, fontSize: 12 }}
                    aria-checked={option.value === moveDate}
                    aria-disabled={option.closed}
                    role="radio"
                    onClick={() => {
                      if (option.closed) return;
                      setMoveDate(option.value);
                      setMoveTime("");
                    }}
                  >
                    <span style={{ fontSize: 9, letterSpacing: "0.08em", opacity: 0.7 }}>
                      {option.dow.toUpperCase()}
                    </span>
                    <span style={{ fontSize: 15 }}>{option.day}</span>
                  </button>
                ))}
              </div>

              <p className="eyebrow" style={{ margin: "16px 0 8px" }}>
                Available time · {moveDate ? shortDate(moveDate) : "pick a date"}
              </p>
              {loadingMoveTimes ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--muted)" }}>
                  <span className="spinner" aria-hidden="true" /> Checking availability…
                </div>
              ) : moveSlots.length === 0 ? (
                <p className="muted" style={{ fontSize: 14 }}>
                  {moveError || "The shop is closed on this date."}
                </p>
              ) : (
                <div className="time-grid" role="radiogroup" aria-label="Available time">
                  {moveSlots.map((slot) => (
                    <button
                      key={slot.time}
                      type="button"
                      role="radio"
                      className="time-cell"
                      style={{ minHeight: 44, fontSize: 15 }}
                      aria-checked={slot.time === moveTime}
                      aria-disabled={!slot.available}
                      onClick={() => slot.available && setMoveTime(slot.time)}
                    >
                      {slot.time}
                    </button>
                  ))}
                </div>
              )}

              <p className="muted" style={{ margin: "12px 0 0", fontSize: 12 }}>
                Service duration and the {HANDLING_BUFFER_MINUTES} min handling buffer are
                reserved automatically. The customer gets an email.
              </p>

              <button
                type="button"
                className="btn btn-primary btn-block"
                style={{ marginTop: 16 }}
                disabled={!moveDate || !moveTime || busy}
                onClick={() => askMove(selected)}
              >
                {moveDate && moveTime
                  ? `Move to ${shortDate(moveDate)} · ${moveTime}`
                  : "Choose a date and time"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Add walk-in / time off --------------------------------------- */}
      {sheet?.kind === "add" && (
        <>
          <button
            type="button"
            className="scrim"
            aria-label="Close"
            onClick={() => setSheet(null)}
          />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Add to the day">
            <div className="sheet-head">
              <div className="seg" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={addMode === "walk_in"}
                  style={{ minHeight: 40, padding: "0 16px", fontSize: 14 }}
                  onClick={() => setAddMode("walk_in")}
                >
                  Walk-in
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={addMode === "block"}
                  style={{ minHeight: 40, padding: "0 16px", fontSize: 14 }}
                  onClick={() => setAddMode("block")}
                >
                  Time off
                </button>
              </div>
              <button
                type="button"
                className="btn-icon"
                aria-label="Close"
                onClick={() => setSheet(null)}
              >
                <Close />
              </button>
            </div>

            <div className="sheet-pad">
              <p className="muted" style={{ margin: "14px 0 0", fontSize: 14 }}>
                {longDate(date)}
              </p>

              {addMode === "walk_in" ? (
                <>
                  <label className="field" style={{ marginTop: 14 }}>
                    <span className="label">Customer name</span>
                    <input
                      className="input"
                      value={walkInName}
                      maxLength={80}
                      onChange={(event) => setWalkInName(event.target.value)}
                    />
                  </label>

                  <p className="eyebrow" style={{ margin: "14px 0 6px" }}>
                    Service
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {BOOKABLE.map((service) => (
                      <button
                        key={service.id}
                        type="button"
                        aria-pressed={service.id === walkInService}
                        className="choice"
                        style={{ minHeight: 48, padding: "6px 10px", fontSize: 13, borderBottom: 0, border: "1px solid var(--hairline)" }}
                        onClick={() => {
                          setWalkInService(service.id);
                          setWalkInTime("");
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{service.name}</span>
                        <b className="num" style={{ fontSize: 13 }}>
                          {formatPrice(service.priceCents)}
                        </b>
                      </button>
                    ))}
                  </div>

                  <p className="eyebrow" style={{ margin: "14px 0 6px" }}>
                    Start time · {walkInServiceRecord.durationMinutes} min +{" "}
                    {HANDLING_BUFFER_MINUTES} min buffer
                  </p>
                  {walkInSlots.length === 0 ? (
                    <p className="muted" style={{ fontSize: 14 }}>
                      The shop is closed on this date.
                    </p>
                  ) : (
                    <div className="time-grid" role="radiogroup" aria-label="Start time">
                      {walkInSlots.map((slot) => (
                        <button
                          key={slot.time}
                          type="button"
                          role="radio"
                          className="time-cell"
                          style={{ minHeight: 44, fontSize: 15 }}
                          aria-checked={slot.time === walkInTime}
                          aria-disabled={!slot.available}
                          onClick={() => slot.available && setWalkInTime(slot.time)}
                        >
                          {slot.time}
                        </button>
                      ))}
                    </div>
                  )}

                  <label className="field" style={{ marginTop: 14 }}>
                    <span className="label">Notes · optional</span>
                    <input
                      className="input"
                      value={walkInNotes}
                      maxLength={1000}
                      onChange={(event) => setWalkInNotes(event.target.value)}
                    />
                  </label>

                  <p className="muted" style={{ margin: "12px 0 0", fontSize: 12 }}>
                    Walk-ins get no email and no loyalty account. They can start now — no
                    one-hour lead time.
                  </p>

                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    style={{ marginTop: 16 }}
                    disabled={!walkInReady || busy}
                    onClick={() => void saveWalkIn()}
                  >
                    {busy
                      ? "Saving…"
                      : walkInReady
                        ? `Add walk-in · ${walkInTime} · ${formatPrice(walkInServiceRecord.priceCents)}`
                        : "Choose a service and start time"}
                  </button>
                </>
              ) : (
                <>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                      marginTop: 14,
                    }}
                  >
                    <label className="field">
                      <span className="label">From</span>
                      <input
                        className="input"
                        type="time"
                        step={300}
                        value={blockStart}
                        onChange={(event) => setBlockStart(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span className="label">Until</span>
                      <input
                        className="input"
                        type="time"
                        step={300}
                        value={blockEnd}
                        onChange={(event) => setBlockEnd(event.target.value)}
                      />
                    </label>
                  </div>
                  <label className="field" style={{ marginTop: 12 }}>
                    <span className="label">Reason</span>
                    <input
                      className="input"
                      value={blockReason}
                      maxLength={200}
                      placeholder="Lunch, appointment, day off…"
                      onChange={(event) => setBlockReason(event.target.value)}
                    />
                  </label>
                  <p className="muted" style={{ margin: "12px 0 0", fontSize: 12 }}>
                    Blocks online bookings for this period. Existing appointments in the range
                    must be moved or cancelled first.
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    style={{ marginTop: 16 }}
                    disabled={!blockReady || busy}
                    onClick={() => void saveBlock()}
                  >
                    {busy ? "Saving…" : "Block time off"}
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* Time off ----------------------------------------------------- */}
      {sheet?.kind === "block" && selectedBlock && (
        <>
          <button
            type="button"
            className="scrim"
            aria-label="Close"
            onClick={() => setSheet(null)}
          />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Time off">
            <div className="sheet-head">
              <div>
                <span className="eyebrow">Time off</span>
                <h2 className="display" style={{ fontSize: 30 }}>
                  {selectedBlock.reason}
                </h2>
                <p>
                  {longDate(date)} · {selectedBlock.start_time}–{selectedBlock.end_time}
                </p>
              </div>
              <button
                type="button"
                className="btn-icon"
                aria-label="Close"
                onClick={() => setSheet(null)}
              >
                <Close />
              </button>
            </div>
            <div className="sheet-pad">
              <p className="muted" style={{ margin: "16px 0 0", fontSize: 14 }}>
                Removing this block reopens its slots for online booking. The audit record is
                kept.
              </p>
              <button
                type="button"
                className="btn btn-danger btn-block"
                style={{ marginTop: 16 }}
                onClick={() => askUnblock(selectedBlock)}
              >
                Remove time off
              </button>
            </div>
          </div>
        </>
      )}

      {/* Confirmation ------------------------------------------------- */}
      {confirm && (
        <div className="dialog-wrap">
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="bs-confirm">
            <h2 className="display" id="bs-confirm">
              {confirm.title}
            </h2>
            <p className="pretty">{confirm.body}</p>
            {confirm.warning && <p className="dialog-warning">{confirm.warning}</p>}
            {busy ? (
              <div className="dialog-busy">
                <span className="spinner" aria-hidden="true" /> Saving…
              </div>
            ) : (
              <div className="dialog-actions">
                <button
                  type="button"
                  className="btn btn-outline btn-s"
                  onClick={() => setConfirm(null)}
                >
                  Keep unchanged
                </button>
                <button
                  type="button"
                  className={confirm.destructive ? "btn btn-primary btn-s" : "btn btn-ink btn-s"}
                  onClick={() => void confirm.run()}
                >
                  {confirm.cta}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toast -------------------------------------------------------- */}
      {toast && (
        <div className={`toast${toast.error ? " is-error" : ""}`} role="status">
          <i>{toast.error ? <Close /> : <Check strokeWidth={3} />}</i>
          {toast.message}
        </div>
      )}
    </DayActionsContext.Provider>
  );
}
