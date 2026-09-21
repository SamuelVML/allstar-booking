"use client";

import { useRef, useState } from "react";

type Props = { reference: string; revision: number; date: string; paid: boolean };

export default function BookingActions({ reference, revision, date: initialDate, paid }: Props) {
  const [mode, setMode] = useState<"idle" | "cancel" | "reschedule" | "complete">("idle");
  const [date, setDate] = useState(initialDate);
  const [times, setTimes] = useState<string[]>([]);
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const lookup = useRef(0);

  async function loadTimes(value: string) {
    const requestId = ++lookup.current;
    setDate(value); setTimes([]); setTime(""); setMessage(""); setBusy(true);
    try {
      const response = await fetch(`/api/admin/bookings/availability?reference=${encodeURIComponent(reference)}&date=${encodeURIComponent(value)}`);
      const result = await response.json() as { error?: string; times: string[]; notificationsSent?: boolean };
      if (requestId !== lookup.current) return;
      if (!response.ok) throw new Error(result.error ?? "Unable to load times.");
      setTimes(result.times);
      if (!result.times.length) setMessage("No available times on this date.");
    } catch (error) {
      if (requestId === lookup.current) setMessage(error instanceof Error ? error.message : "Unable to load times.");
    } finally { if (requestId === lookup.current) setBusy(false); }
  }

  async function save() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/bookings/change", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference, revision, action: mode, date, time }),
      });
      const result = await response.json() as { error?: string; times: string[]; notificationsSent?: boolean };
      if (!response.ok) throw new Error(result.error ?? "Unable to save.");
      setSaved(true);
      if (!result.notificationsSent) {
        setMessage("Booking updated, but email delivery failed. Contact the customer directly, then refresh this page.");
      } else window.location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save. Refresh before retrying."); }
    finally { setBusy(false); }
  }

  if (saved) return <div role="status">{message}<br /><button onClick={() => window.location.reload()}>Refresh</button></div>;
  return <div className="booking-actions">
    {mode === "idle" ? <>
      <button type="button" onClick={() => { setMode("reschedule"); void loadTimes(date); }}>Reschedule</button>
      <button type="button" onClick={() => setMode("cancel")}>Cancel booking</button>
      <button type="button" onClick={() => setMode("complete")}>Complete visit</button>
    </> : <>
      {mode === "reschedule" ? <>
        <label>New date<input type="date" value={date} disabled={busy} onChange={(event) => void loadTimes(event.target.value)} /></label>
        <label>Available time<select value={time} disabled={busy} onChange={(event) => setTime(event.target.value)}><option value="">Choose a time</option>{times.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <small>Service duration and handling buffer are reserved automatically.</small>
      </> : <p>{mode === "cancel" ? `Cancel ${reference} and release its slot?${paid ? " Payment was received; handle any refund separately in Stripe." : ""}` : "Mark this visit completed and award one loyalty point? This does not record payment."}</p>}
      <button type="button" disabled={busy || (mode === "reschedule" && !time)} onClick={save}>{busy ? "Please wait…" : "Confirm"}</button>
      <button type="button" disabled={busy} onClick={() => { setMode("idle"); setMessage(""); }}>Back</button>
    </>}
    {message && <p role="alert">{message}</p>}
  </div>;
}
