"use client";

import { useRef, useState, type FormEvent } from "react";
import { SERVICES, formatPrice } from "@/lib/booking";

function useOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const running = useRef(false);
  async function save(payload: Record<string, unknown>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError("");
    requestId.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/admin/operations", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: requestId.current, ...payload }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error || "Unable to save. Refresh and sign in again.");
      }
      window.location.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to save. Refresh before retrying.");
      setBusy(false); running.current = false;
    }
  }
  return { busy, error, save };
}

export default function Operations({ date, blocks }: { date: string; blocks: { id: string; start_time: string; end_time: string; reason: string }[] }) {
  const { busy, error, save } = useOperation();
  const [panel, setPanel] = useState<"walk_in" | "block" | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    void save({ ...values, date, action: panel });
  }
  return <section className="backstage-tools" aria-label="Manage the day">
    <div className="admin-date-filter">
      <button className="button button-primary" disabled={busy} onClick={() => setPanel(panel === "walk_in" ? null : "walk_in")}>Add walk-in</button>
      <button className="button button-outline" disabled={busy} onClick={() => setPanel(panel === "block" ? null : "block")}>Block time off</button>
    </div>
    {panel && <form className="backstage-form" onSubmit={submit} key={panel}>
      <h2>{panel === "walk_in" ? "Walk-in booking" : "Time off"} · {date}</h2>
      {panel === "walk_in" ? <>
        <label>Customer name<input name="name" defaultValue="Walk-in" maxLength={80} required /></label>
        <label>Service<select name="serviceId">{SERVICES.filter(service => !service.isAddOn).map(service => <option key={service.id} value={service.id}>{service.name} · {formatPrice(service.priceCents)}</option>)}</select></label>
        <label>Start time<input name="time" type="time" step={300} required /></label>
        <label>Notes<input name="notes" maxLength={1000} /></label>
        <p>No customer email is sent. This visit has no loyalty account. Opening hours, breaks and handling time still apply.</p>
      </> : <>
        <label>From<input name="start" type="time" step={300} required /></label>
        <label>Until<input name="end" type="time" step={300} required /></label>
        <label>Reason<input name="reason" placeholder="Lunch, appointment, day off…" maxLength={200} required /></label>
        <p>Blocks online bookings for this period. Existing appointments must be moved or cancelled first.</p>
      </>}
      <button className="button button-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      <button className="button button-outline" type="button" disabled={busy} onClick={() => setPanel(null)}>Close</button>
    </form>}
    {blocks.length > 0 && <div className="backstage-blocks"><h2>Time off</h2>{blocks.map(block => <div key={block.id}>
      <span><strong>{block.start_time}–{block.end_time}</strong> · {block.reason}</span>
      <button className="button button-outline" disabled={busy} onClick={() => { if (window.confirm("Remove this time off and reopen available slots?")) void save({ action: "unblock", id: block.id }); }}>Remove</button>
    </div>)}</div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function RecordPayment({ reference, revision, amount }: { reference: string; revision: number; amount: number }) {
  const { busy, error, save } = useOperation();
  const [open, setOpen] = useState(false);
  return <div className="backstage-payment">
    {!open ? <button className="button button-outline" onClick={() => setOpen(true)}>Record payment</button> : <form onSubmit={event => {
      event.preventDefault();
      const method = new FormData(event.currentTarget).get("method");
      void save({ action: "payment", reference, revision, method });
    }}>
      <p>Confirm you received <strong>{formatPrice(amount)}</strong>. This records a payment already taken; it does not charge a card.</p>
      <label>Paid by <select name="method"><option value="cash">Cash</option><option value="card">Card at shop</option></select></label>
      <button className="button button-primary" disabled={busy}>{busy ? "Saving…" : "Confirm received"}</button>
      <button type="button" className="button button-outline" disabled={busy} onClick={() => setOpen(false)}>Close</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
