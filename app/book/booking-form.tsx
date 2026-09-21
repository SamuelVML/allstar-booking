"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Banknote, CalendarDays, Check, Clock, CreditCard, Gift, Scissors, Sparkles } from "lucide-react";
import { formatAppointmentDate, formatPrice, HANDLING_BUFFER_MINUTES, SERVICES } from "@/lib/booking";

type Confirmation = {
  reference: string;
  serviceName: string;
  date: string;
  time: string;
  endTime: string;
  durationMinutes: number;
  priceCents: number;
  paymentMethod: string;
  loyalty?: { currentPoints: number; rewardAt: number; pendingPoint: number };
};

type Recommendation = { date: string; dateLabel: string; time: string };

type BookingInput = {
  serviceId: string;
  date: string;
  time: string;
  name: string;
  email: string;
  phone: string;
  notes?: string;
  acceptedTerms: boolean;
  colourAddOn: boolean;
  paymentMethod: "cash" | "stripe";
  reminderOptIn: boolean;
  marketingConsent: boolean;
};

type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

declare global {
  interface Document {
    readonly modelContext?: ModelContext;
  }
}

function dateInputBounds() {
  const minimum = new Date();
  const maximum = new Date();
  maximum.setDate(maximum.getDate() + 60);
  return {
    min: minimum.toISOString().slice(0, 10),
    max: maximum.toISOString().slice(0, 10),
  };
}

async function createBooking(input: BookingInput) {
  const response = await fetch("/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = (await response.json()) as { booking?: Confirmation; checkoutUrl?: string; error?: string };
  if (!response.ok || (!result.booking && !result.checkoutUrl)) throw new Error(result.error ?? "Booking failed.");
  return result;
}

export default function BookingForm({
  initialService,
  initialColourAddOn,
  stripeEnabled,
}: {
  initialService: string;
  initialColourAddOn: boolean;
  stripeEnabled: boolean;
}) {
  const bounds = useMemo(() => dateInputBounds(), []);
  const [serviceId, setServiceId] = useState(initialService);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [colourAddOn, setColourAddOn] = useState(initialColourAddOn && !initialService.includes("colour"));
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "stripe">("cash");
  const [times, setTimes] = useState<string[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [showCalendar, setShowCalendar] = useState(false);
  const [loadingRecommendation, setLoadingRecommendation] = useState(true);
  const [loadingTimes, setLoadingTimes] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const service = SERVICES.find((item) => item.id === serviceId) ?? SERVICES[0];
  const supportsColourAddOn = !service.id.includes("colour");
  const totalDuration = service.durationMinutes + (colourAddOn ? 30 : 0);
  const totalPrice = service.priceCents + (colourAddOn ? 2250 : 0);
  const selectedServiceName = `${service.name}${colourAddOn ? " + colour add-on" : ""}`;
  const curatedTimes = useMemo(() => {
    const chosen: string[] = [];
    let nextMinute = -1;
    for (const candidate of times) {
      const [hour, minute] = candidate.split(":").map(Number);
      const candidateMinute = hour * 60 + minute;
      if (candidateMinute < nextMinute) continue;
      chosen.push(candidate);
      nextMinute = candidateMinute + totalDuration + HANDLING_BUFFER_MINUTES;
      if (chosen.length === 8) break;
    }
    return chosen;
  }, [times, totalDuration]);

  useEffect(() => {
    if (!date) return;
    const controller = new AbortController();
    fetch(`/api/availability?date=${encodeURIComponent(date)}&service=${encodeURIComponent(serviceId)}${colourAddOn ? "&addOn=colour" : ""}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as { times?: string[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Availability failed.");
        const availableTimes = result.times ?? [];
        setTimes(availableTimes);
        setTime((current) => availableTimes.includes(current) ? current : "");
      })
      .catch((reason) => {
        if (reason instanceof Error && reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingTimes(false);
      });
    return () => controller.abort();
  }, [colourAddOn, date, serviceId]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/availability?service=${encodeURIComponent(serviceId)}${colourAddOn ? "&addOn=colour" : ""}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as { recommendations?: Recommendation[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Recommendation failed.");
        setRecommendations(result.recommendations ?? []);
      })
      .catch((reason) => {
        if (reason instanceof Error && reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRecommendation(false);
      });
    return () => controller.abort();
  }, [colourAddOn, serviceId]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const schema = {
      type: "object",
      properties: {
        serviceId: { type: "string", enum: SERVICES.map((item) => item.id) },
        date: { type: "string", description: "Appointment date in YYYY-MM-DD format" },
      },
      required: ["serviceId", "date"],
      additionalProperties: false,
    };

    const registrations = [
      context.registerTool(
        {
          name: "get_available_appointment_times",
          title: "Get available appointment times",
          description: "Return currently available All Star appointment times for a service and date.",
          inputSchema: schema,
          annotations: { readOnlyHint: true, untrustedContentHint: false },
          async execute(input) {
            const value = input as { serviceId?: string; date?: string };
            const response = await fetch(`/api/availability?date=${encodeURIComponent(value.date ?? "")}&service=${encodeURIComponent(value.serviceId ?? "")}`);
            if (!response.ok) throw new Error("Availability could not be loaded.");
            return response.json();
          },
        },
        { signal: lifecycle.signal },
      ),
      context.registerTool(
        {
          name: "create_booking",
          title: "Create an All Star booking",
          description: "Confirm an All Star appointment using an available service, date and time. Payment is made at the shop.",
          inputSchema: {
            type: "object",
            properties: {
              serviceId: { type: "string", enum: SERVICES.filter((item) => !item.isAddOn).map((item) => item.id) },
              date: { type: "string", description: "Appointment date in YYYY-MM-DD format" },
              time: { type: "string", description: "Available start time in HH:MM format" },
              name: { type: "string" },
              email: { type: "string" },
              phone: { type: "string" },
              notes: { type: "string" },
              colourAddOn: { type: "boolean" },
              acceptedTerms: { type: "boolean", const: true },
            },
            required: ["serviceId", "date", "time", "name", "email", "phone", "acceptedTerms"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          async execute(input) {
            const result = await createBooking({ ...(input as BookingInput), paymentMethod: "cash" });
            if (!result.booking) throw new Error("Booking confirmation failed.");
            setConfirmation(result.booking);
            return { reference: result.booking.reference, status: "confirmed", date: result.booking.date, time: result.booking.time };
          },
        },
        { signal: lifecycle.signal },
      ),
    ];
    void Promise.all(registrations.map((registration) => Promise.resolve(registration))).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await createBooking({
        serviceId,
        date,
        time,
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
        phone: String(data.get("phone") ?? ""),
        notes: String(data.get("notes") ?? ""),
        acceptedTerms: data.get("terms") === "on",
        colourAddOn,
        paymentMethod,
        reminderOptIn: data.get("reminders") === "on",
        marketingConsent: data.get("marketing") === "on",
      });
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      if (!result.booking) throw new Error("Booking confirmation failed.");
      setConfirmation(result.booking);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Booking failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmation) {
    return (
      <section className="booking-confirmation" aria-live="polite">
        <span className="confirmation-icon"><Check aria-hidden="true" /></span>
        <p className="booking-kicker">Booking confirmed</p>
        <h2>See you at All Star.</h2>
        <dl>
          <div><dt>Reference</dt><dd>{confirmation.reference}</dd></div>
          <div><dt>Service</dt><dd>{confirmation.serviceName}</dd></div>
          <div><dt>Date</dt><dd>{confirmation.date}</dd></div>
          <div><dt>Time</dt><dd>{confirmation.time}–{confirmation.endTime}</dd></div>
          <div><dt>Total</dt><dd>{formatPrice(confirmation.priceCents)}</dd></div>
          <div><dt>Payment</dt><dd>{confirmation.paymentMethod}</dd></div>
          {confirmation.loyalty && <div><dt>All Star points</dt><dd>{confirmation.loyalty.currentPoints} + 1 after your visit</dd></div>}
        </dl>
        {confirmation.loyalty && <p className="loyalty-confirmation"><Gift aria-hidden="true" /> Your point is added when the visit is completed. At {confirmation.loyalty.rewardAt} points, your next full-service haircut and haircare product are free.</p>}
        <p>To change or cancel, contact All Star at least two hours before your appointment.</p>
        <div className="button-row">
          <a className="button" href="https://wa.me/31686357350">WhatsApp All Star</a>
          <Link className="button button-outline-dark" href="/">Back to website</Link>
        </div>
      </section>
    );
  }

  return (
    <form className="booking-shell" onSubmit={submit}>
      <aside className="booking-summary">
        <span className="booking-kicker">Your appointment</span>
        <h2>{selectedServiceName}</h2>
        <div><Scissors aria-hidden="true" /><span>{formatPrice(totalPrice)}</span></div>
        <div><Clock aria-hidden="true" /><span>{totalDuration} min service · {HANDLING_BUFFER_MINUTES} min buffer</span></div>
        <div><CalendarDays aria-hidden="true" /><span>{date && time ? `${formatAppointmentDate(date)} · ${time}` : "Samaritan is finding your best fit"}</span></div>
        <p>Bakkerstraat 48<br />5612 EP Eindhoven</p>
      </aside>
      <div className="booking-fields">
        <fieldset>
          <legend>1. Choose your service</legend>
          <div className="service-options">
            {SERVICES.filter((item) => !item.isAddOn).map((item) => (
              <label className={serviceId === item.id ? "selected" : ""} key={item.id}>
                <input type="radio" name="service" value={item.id} checked={serviceId === item.id} onChange={() => {
                  setServiceId(item.id);
                  if (item.id.includes("colour")) setColourAddOn(false);
                  setDate("");
                  setTime("");
                  setTimes([]);
                  setRecommendations([]);
                  setLoadingRecommendation(true);
                  setShowCalendar(false);
                  setError("");
                }} />
                <span><strong>{item.name}</strong><small>{item.durationMinutes} min · {formatPrice(item.priceCents)}</small></span>
              </label>
            ))}
          </div>
          {supportsColourAddOn && (
            <label className={`add-on-option ${colourAddOn ? "selected" : ""}`}>
              <input type="checkbox" checked={colourAddOn} onChange={(event) => {
                setColourAddOn(event.target.checked);
                setDate("");
                setTime("");
                setTimes([]);
                setRecommendations([]);
                setLoadingRecommendation(true);
                setShowCalendar(false);
                setError("");
              }} />
              <span><strong>Add hair colour</strong><small>+30 min · +€22.50</small></span>
            </label>
          )}
        </fieldset>

        <fieldset>
          <legend>2. Your best available time</legend>
          <div className="samaritan-recommendation" aria-live="polite">
            <div className="samaritan-mark"><Sparkles aria-hidden="true" /><span>Samaritan recommends</span></div>
            {loadingRecommendation && <p>Finding the best fit for this service…</p>}
            {!loadingRecommendation && recommendations[0] && (
              <>
                <strong>{recommendations[0].dateLabel}</strong>
                <b>{recommendations[0].time}</b>
                <small>{totalDuration} min service + {HANDLING_BUFFER_MINUTES} min handling buffer</small>
                <p>Does that fit?</p>
                <div className="recommendation-actions">
                  <button className="button" type="button" onClick={() => {
                    setDate(recommendations[0].date);
                    setTime(recommendations[0].time);
                    setShowCalendar(false);
                  }}>Yes, use this time</button>
                  <button className="text-button" type="button" onClick={() => setShowCalendar(true)}>No, show other times</button>
                </div>
              </>
            )}
            {!loadingRecommendation && recommendations.length === 0 && <p>No availability was found in the next 60 days.</p>}
          </div>
          {date && time && !showCalendar && <div className="selected-time"><Check aria-hidden="true" /><span><strong>Selected</strong>{formatAppointmentDate(date)} at {time}</span><button type="button" onClick={() => setShowCalendar(true)}>Change</button></div>}
          {showCalendar && (
            <div className="calendar-fallback">
              {recommendations.length > 1 && <div className="smart-picks">
                <span>Next smart options</span>
                {recommendations.map((option) => (
                  <button className={date === option.date && time === option.time ? "selected" : ""} type="button" key={`${option.date}-${option.time}`} onClick={() => {
                    setDate(option.date);
                    setTime(option.time);
                  }}><strong>{option.dateLabel}</strong><small>{option.time}</small></button>
                ))}
              </div>}
              <label className="field-label" htmlFor="appointment-date">Choose another date</label>
              <input id="appointment-date" className="text-input" type="date" min={bounds.min} max={bounds.max} value={date} onChange={(event) => {
                setDate(event.target.value);
                setTime("");
                setTimes([]);
                setLoadingTimes(true);
                setError("");
              }} required />
              <div className="time-grid" aria-live="polite">
                {loadingTimes && <p>Checking available times…</p>}
                {!loadingTimes && date && times.length === 0 && <p>No times are available on this date.</p>}
                {curatedTimes.map((availableTime) => (
                  <button className={time === availableTime ? "selected" : ""} type="button" onClick={() => setTime(availableTime)} key={availableTime}>{availableTime}</button>
                ))}
              </div>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>3. Your details</legend>
          <div className="details-grid">
            <label>Full name<input className="text-input" name="name" autoComplete="name" required /></label>
            <label>Phone<input className="text-input" name="phone" type="tel" autoComplete="tel" required /></label>
            <label className="full-width">Email<input className="text-input" name="email" type="email" autoComplete="email" required /></label>
            <label className="full-width">Notes <small>Optional</small><textarea className="text-input" name="notes" rows={3} maxLength={1000} /></label>
          </div>
          <label className="terms"><input type="checkbox" name="terms" required /><span>I agree to contact All Star at least two hours in advance if I need to change or cancel.</span></label>
          <div className="account-box">
            <Gift aria-hidden="true" />
            <div><strong>Your All Star account</strong><p>Your visits and points are linked securely to your email. Every completed visit earns 1 point; 10 points unlock a free full-service haircut and haircare product.</p></div>
          </div>
          <label className="terms"><input type="checkbox" name="reminders" defaultChecked /><span>Send me appointment confirmations and reminders.</span></label>
          <label className="terms"><input type="checkbox" name="marketing" /><span>Send me occasional “Stay Fresh” offers and reminders when it may be time for my next cut. Optional.</span></label>
        </fieldset>

        <fieldset>
          <legend>4. Choose payment</legend>
          <div className="payment-options">
            <label className={paymentMethod === "cash" ? "selected" : ""}>
              <input type="radio" name="paymentMethod" value="cash" checked={paymentMethod === "cash"} onChange={() => setPaymentMethod("cash")} />
              <Banknote aria-hidden="true" />
              <span><strong>Cash at the shop</strong><small>Pay after your appointment</small></span>
            </label>
            <label className={`${paymentMethod === "stripe" ? "selected" : ""} ${!stripeEnabled ? "disabled" : ""}`}>
              <input type="radio" name="paymentMethod" value="stripe" checked={paymentMethod === "stripe"} onChange={() => setPaymentMethod("stripe")} disabled={!stripeEnabled} />
              <CreditCard aria-hidden="true" />
              <span><strong>Pay securely online</strong><small>{stripeEnabled ? "Continue to Stripe Checkout" : "Available once All Star Stripe is connected"}</small></span>
            </label>
          </div>
        </fieldset>

        {error && <p className="booking-error" role="alert">{error}</p>}
        <button className="button booking-submit" type="submit" disabled={!date || !time || submitting}>
          {submitting ? (paymentMethod === "stripe" ? "Opening secure checkout…" : "Confirming…") : paymentMethod === "stripe" ? `Pay online · ${formatPrice(totalPrice)}` : `Book and pay cash · ${formatPrice(totalPrice)}`}
        </button>
        <p className="payment-note">{paymentMethod === "stripe" ? "Your slot is reserved for 30 minutes while you pay securely through Stripe." : "No payment is taken now. Pay at the shop after your appointment."}</p>
      </div>
    </form>
  );
}
