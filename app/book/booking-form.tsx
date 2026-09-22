"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addMinutes,
  formatPrice,
  HANDLING_BUFFER_MINUTES,
  OPENING_HOURS,
  SERVICES,
} from "@/lib/booking";
import {
  COLOUR_ADD_ON_SUFFIX,
  COPY,
  type Language,
  locale,
  serviceLabel,
} from "@/lib/i18n";
import { ArrowLeft, ArrowRight, Check, StarMark } from "@/lib/icons";
import SuccessView, { type Booking } from "./success-view";

const TOTAL_STEPS = 7;
const BOOKING_WINDOW_DAYS = 60;
const COLOUR_ADD_ON_MINUTES = 30;
const COLOUR_ADD_ON_CENTS = 2250;
const PHONE = "+31686357350";

type Recommendation = {
  date: string;
  dateLabel: string;
  time: string;
  /** Additive field from /api/availability; older responses omit it. */
  reason?: "first" | "gap";
};

type Confirmation = Booking & {
  loyalty?: { currentPoints: number; rewardAt: number; pendingPoint: number };
};

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

async function createBooking(input: BookingInput) {
  const response = await fetch("/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = (await response.json()) as {
    booking?: Confirmation;
    checkoutUrl?: string;
    error?: string;
  };
  if (!response.ok || (!result.booking && !result.checkoutUrl)) {
    throw new Error(result.error ?? "Booking failed.");
  }
  return result;
}

function toMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekday(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/**
 * Every start time the shop could sell on this date, at the 15-minute rhythm
 * the barber books to. `/api/availability` returns only the free ones, so
 * anything missing from that list is drawn crossed out rather than hidden —
 * a full day has to look full.
 */
function candidateTimes(date: string, occupiedMinutes: number) {
  const hours = OPENING_HOURS[weekday(date)];
  if (!hours) return [];
  const times: string[] = [];
  for (
    let time = hours.start;
    toMinutes(addMinutes(time, occupiedMinutes)) <= toMinutes(hours.end);
    time = addMinutes(time, 15)
  ) {
    times.push(time);
  }
  return times;
}

export default function BookingForm({
  initialService,
  initialColourAddOn,
  initialLanguage,
  stripeEnabled,
  today,
}: {
  initialService: string;
  initialColourAddOn: boolean;
  initialLanguage: Language;
  stripeEnabled: boolean;
  /** Today in Europe/Amsterdam, resolved on the server. */
  today: string;
}) {
  const router = useRouter();

  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [step, setStep] = useState(1);
  const [serviceId, setServiceId] = useState(initialService);
  const [colourAddOn, setColourAddOn] = useState(
    initialColourAddOn && !initialService.includes("colour"),
  );
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [reminderOptIn, setReminderOptIn] = useState(true);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "stripe">("cash");
  const [touched, setTouched] = useState(false);

  // Both lookups key their result on the request that produced it, so
  // "loading" is derived from whether the current key has been answered rather
  // than being a second piece of state to keep in step.
  const [timesResult, setTimesResult] = useState<{ key: string; times: string[] }>({
    key: "",
    times: [],
  });
  const [recommendationResult, setRecommendationResult] = useState<{
    key: string;
    items: Recommendation[];
  }>({ key: "", items: [] });
  const [recommendationDismissed, setRecommendationDismissed] = useState(false);
  const [usedRecommendation, setUsedRecommendation] = useState(false);

  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const t = COPY[language];
  const service = SERVICES.find((item) => item.id === serviceId) ?? SERVICES[0];
  const supportsColourAddOn = !service.id.includes("colour");
  const addOn = supportsColourAddOn && colourAddOn;
  const totalDuration = service.durationMinutes + (addOn ? COLOUR_ADD_ON_MINUTES : 0);
  const totalPrice = service.priceCents + (addOn ? COLOUR_ADD_ON_CENTS : 0);
  const serviceName =
    serviceLabel(service.id, service.name, language) +
    (addOn ? COLOUR_ADD_ON_SUFFIX[language] : "");
  const lastDate = addDays(today, BOOKING_WINDOW_DAYS);

  const dateLabel = useMemo(() => {
    if (!date) return "";
    return new Intl.DateTimeFormat(locale(language), {
      timeZone: "Europe/Amsterdam",
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date(`${date}T12:00:00Z`));
  }, [date, language]);

  const timeRange = time ? `${time} – ${addMinutes(time, totalDuration)}` : "";

  const timesKey = date ? `${date}|${serviceId}|${addOn}` : "";
  const recommendationKey = `${serviceId}|${addOn}`;
  const loadingTimes = !!date && timesResult.key !== timesKey;
  const times = timesResult.key === timesKey ? timesResult.times : [];
  const loadingRecommendation = recommendationResult.key !== recommendationKey;
  const recommendations = loadingRecommendation ? [] : recommendationResult.items;

  /* ---------------------------------------------------------------- data */

  // Available times for the chosen date. Changing the service or add-on keeps
  // the date and re-checks it rather than throwing the choice away.
  useEffect(() => {
    if (!date) return;
    const controller = new AbortController();
    const key = `${date}|${serviceId}|${addOn}`;
    fetch(
      `/api/availability?date=${encodeURIComponent(date)}&service=${encodeURIComponent(serviceId)}${addOn ? "&addOn=colour" : ""}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json()) as { times?: string[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Availability failed.");
        const available = result.times ?? [];
        setTimesResult({ key, times: available });
        setTime((current) => (available.includes(current) ? current : ""));
      })
      .catch((reason) => {
        if (reason instanceof Error && reason.name !== "AbortError") {
          setError(reason.message);
          // Answer the key so the spinner does not hang; the empty result
          // surfaces the "fully booked" state with the error alongside it.
          setTimesResult({ key, times: [] });
        }
      });
    return () => controller.abort();
  }, [addOn, date, serviceId]);

  // Samaritan's recommendation for the current service.
  useEffect(() => {
    const controller = new AbortController();
    const key = `${serviceId}|${addOn}`;
    fetch(
      `/api/availability?service=${encodeURIComponent(serviceId)}${addOn ? "&addOn=colour" : ""}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json()) as {
          recommendations?: Recommendation[];
          error?: string;
        };
        if (!response.ok) throw new Error(result.error ?? "Recommendation failed.");
        setRecommendationResult({ key, items: result.recommendations ?? [] });
      })
      .catch((reason) => {
        if (reason instanceof Error && reason.name !== "AbortError") {
          setError(reason.message);
          setRecommendationResult({ key, items: [] });
        }
      });
    return () => controller.abort();
  }, [addOn, serviceId]);

  // Preserved: the booking surface stays available to model-driven clients
  // through document.modelContext.
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
          description:
            "Return currently available All Star appointment times for a service and date.",
          inputSchema: schema,
          annotations: { readOnlyHint: true, untrustedContentHint: false },
          async execute(input) {
            const value = input as { serviceId?: string; date?: string };
            const response = await fetch(
              `/api/availability?date=${encodeURIComponent(value.date ?? "")}&service=${encodeURIComponent(value.serviceId ?? "")}`,
            );
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
          description:
            "Confirm an All Star appointment using an available service, date and time. Payment is made at the shop.",
          inputSchema: {
            type: "object",
            properties: {
              serviceId: {
                type: "string",
                enum: SERVICES.filter((item) => !item.isAddOn).map((item) => item.id),
              },
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
            const result = await createBooking({
              ...(input as BookingInput),
              paymentMethod: "cash",
            });
            if (!result.booking) throw new Error("Booking confirmation failed.");
            setConfirmation(result.booking);
            return {
              reference: result.booking.reference,
              status: "confirmed",
              date: result.booking.date,
              time: result.booking.time,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ];
    void Promise.all(
      registrations.map((registration) => Promise.resolve(registration)),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  /* ------------------------------------------------------------ validation */

  const nameValid = name.trim().length > 1;
  const phoneValid = phone.replace(/\D/g, "").length >= 8;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const detailsValid = nameValid && phoneValid && emailValid && acceptedTerms;
  const invalid = (ok: boolean) => touched && !ok;

  const stepValid = [true, true, !!date, !!time, detailsValid, true, true, true][step];

  /* --------------------------------------------------------------- actions */

  function goTo(next: number) {
    setStep(next);
    setError("");
    setTouched(false);
    window.scrollTo({ top: 0 });
  }

  function onBack() {
    if (step === 1) {
      router.push(language === "en" ? "/" : `/?lang=${language}`);
      return;
    }
    goTo(step - 1);
  }

  function onNext() {
    if (step === 4 && !detailsValid) {
      setTouched(true);
      return;
    }
    if (!stepValid) return;
    if (step === 6) {
      void submit();
      return;
    }
    goTo(step + 1);
  }

  function pickService(id: string) {
    setServiceId(id);
    if (id.includes("colour")) setColourAddOn(false);
    // The date survives a service change and is re-checked against the new
    // duration by the availability effect.
    setTime("");
    setUsedRecommendation(false);
  }

  function acceptRecommendation(recommendation: Recommendation) {
    setDate(recommendation.date);
    setTime(recommendation.time);
    setUsedRecommendation(true);
    // Straight to details — the recommendation has answered steps 2 and 3.
    goTo(4);
  }

  async function submit() {
    setError("");
    setStep(7);
    window.scrollTo({ top: 0 });
    try {
      const result = await createBooking({
        serviceId,
        date,
        time,
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        notes: notes.trim(),
        acceptedTerms,
        colourAddOn: addOn,
        paymentMethod,
        reminderOptIn,
        marketingConsent,
      });
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      if (!result.booking) throw new Error("Booking confirmation failed.");
      setConfirmation(result.booking);
    } catch (reason) {
      // Everything entered is still in state — step 6 comes back exactly as it
      // was left, with a retry.
      setStep(6);
      setError(reason instanceof Error ? reason.message : "Booking failed.");
    }
  }

  /* ------------------------------------------------------------ done state */

  if (confirmation) {
    return (
      <SuccessView
        language={language}
        booking={{ ...confirmation, email: email.trim() || confirmation.email }}
      />
    );
  }

  /* ------------------------------------------------------------- rendering */

  // Three weeks, from the Monday of the current week.
  const gridStart = addDays(today, -((weekday(today) + 6) % 7));
  const dateCells = Array.from({ length: 21 }, (_, index) => {
    const value = addDays(gridStart, index);
    const past = value < today;
    return {
      value,
      day: new Date(`${value}T12:00:00Z`).getUTCDate(),
      past,
      closed: !OPENING_HOURS[weekday(value)] || value > lastDate,
      isToday: value === today,
      selected: value === date,
    };
  });

  const monthFormat = new Intl.DateTimeFormat(locale(language), {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
  const gridEnd = addDays(gridStart, 20);
  const startMonth = monthFormat.format(new Date(`${gridStart}T12:00:00Z`));
  const endMonth = monthFormat.format(new Date(`${gridEnd}T12:00:00Z`));
  const monthLabel = startMonth === endMonth ? startMonth : `${startMonth} – ${endMonth}`;

  const dateHours = date
    ? (OPENING_HOURS[weekday(date)]
        ? `${OPENING_HOURS[weekday(date)]!.start} – ${OPENING_HOURS[weekday(date)]!.end}`
        : t.closedWord)
    : "";

  const available = new Set(times);
  // The grid gives the day its shape; the API's free slots are unioned in so a
  // bookable time that falls between grid steps is never hidden — on a packed
  // day that off-grid slot may be the only one left.
  const allTimes = date
    ? [...new Set([...candidateTimes(date, totalDuration + HANDLING_BUFFER_MINUTES), ...times])].sort()
    : [];
  const timeGroups = [
    { label: t.morning, from: 0, to: 12 },
    { label: t.afternoon, from: 12, to: 17 },
    { label: t.evening, from: 17, to: 24 },
  ]
    .map((group) => ({
      label: group.label,
      slots: allTimes.filter((value) => {
        const hour = Number(value.slice(0, 2));
        return hour >= group.from && hour < group.to;
      }),
    }))
    .filter((group) => group.slots.length > 0);
  const noTimes = !!date && !loadingTimes && times.length === 0;

  const recommendation = recommendations[0];
  const showRecommendation = step === 2 && !recommendationDismissed && !date;

  const consents = [
    {
      id: "terms",
      label: t.terms,
      on: acceptedTerms,
      toggle: () => setAcceptedTerms((value) => !value),
      error: invalid(acceptedTerms),
    },
    {
      id: "reminders",
      label: t.reminders,
      on: reminderOptIn,
      toggle: () => setReminderOptIn((value) => !value),
      error: false,
    },
    {
      id: "marketing",
      label: t.marketing,
      on: marketingConsent,
      toggle: () => setMarketingConsent((value) => !value),
      error: false,
    },
  ];

  const reviewRows = [
    { key: t.service, value: serviceName, target: 1, recommended: false },
    { key: t.date, value: dateLabel, target: 2, recommended: false },
    { key: t.time, value: timeRange, target: 3, recommended: usedRecommendation },
    { key: t.nameK, value: name, target: 4, recommended: false },
    { key: t.contact, value: `${phone} · ${email}`, target: 4, recommended: false },
    {
      key: t.payment,
      value: paymentMethod === "stripe" ? t.paidOnline : t.paidShop,
      target: 5,
      recommended: false,
    },
  ];

  const paymentFootnote = paymentMethod === "stripe" ? t.footOnline : t.footShop;
  const barSubtitle =
    (step >= 3 && date ? dateLabel : serviceName) + (time && step > 3 ? ` · ${time}` : "");
  const nextLabel =
    step === 6 ? (paymentMethod === "stripe" ? t.payOnline : t.confirm) : t.continue;

  return (
    <div className="flow">
      <header className="flow-head">
        <div className="flow-head-inner">
          <div className="flow-head-row">
            <button type="button" className="flow-back" onClick={onBack}>
              <ArrowLeft />
              {step === 1 ? t.home : t.backStep}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="eyebrow">
                {t.step} {Math.min(step, TOTAL_STEPS)} {t.of} {TOTAL_STEPS}
              </span>
              <button
                type="button"
                className="btn btn-quiet btn-xs"
                onClick={() => setLanguage(language === "en" ? "nl" : "en")}
                aria-label={t.langSwitchLabel}
              >
                {t.langToggle}
              </button>
            </div>
          </div>
          <div className="progress" aria-hidden="true">
            {Array.from({ length: TOTAL_STEPS }, (_, index) => (
              <span key={index} className={index < step ? "done" : undefined} />
            ))}
          </div>
        </div>
      </header>

      <div className="flow-body">
        <div className="flow-body-inner" aria-live="polite">
          <h1 className="display display-m">{t.titles[step - 1]}</h1>
          {t.hints[step - 1] ? <p className="hint pretty">{t.hints[step - 1]}</p> : null}

          {/* 1 — Service ------------------------------------------------- */}
          {step === 1 && (
            <>
              <div className="choice-list" role="radiogroup" aria-label={t.service}>
                {SERVICES.filter((item) => !item.isAddOn).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={item.id === serviceId}
                    className="choice"
                    onClick={() => pickService(item.id)}
                  >
                    <span className="choice-name">
                      <strong>{serviceLabel(item.id, item.name, language)}</strong>
                      <small>{item.durationMinutes} min</small>
                    </span>
                    <b className="choice-price">{formatPrice(item.priceCents)}</b>
                  </button>
                ))}
              </div>
              {supportsColourAddOn && (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={colourAddOn}
                  className="choice"
                  style={{
                    marginTop: 16,
                    border: `1px solid ${colourAddOn ? "var(--ink)" : "var(--hairline)"}`,
                    gridTemplateColumns: "24px 1fr auto",
                  }}
                  onClick={() => {
                    setColourAddOn((value) => !value);
                    setTime("");
                    setUsedRecommendation(false);
                  }}
                >
                  <span className="check-box">
                    <Check strokeWidth={3} />
                  </span>
                  <span className="choice-name">
                    <strong>{t.addOnTitle}</strong>
                    <small>+{COLOUR_ADD_ON_MINUTES} min</small>
                  </span>
                  <b className="choice-price">+{formatPrice(COLOUR_ADD_ON_CENTS)}</b>
                </button>
              )}
            </>
          )}

          {/* 2 — Date ---------------------------------------------------- */}
          {step === 2 && (
            <>
              {showRecommendation && (
                <section className="samaritan" aria-label={t.recKicker} aria-live="polite">
                  <p className="kicker">
                    <StarMark fill="var(--red-on-dark)" />
                    {t.recKicker}
                  </p>
                  {loadingRecommendation && (
                    <div className="samaritan-loading">
                      <span className="spinner spinner-dark" aria-hidden="true" />
                      {t.recLoading}
                    </div>
                  )}
                  {!loadingRecommendation && recommendation && (
                    <>
                      <h2 className="display">
                        {new Intl.DateTimeFormat(locale(language), {
                          timeZone: "Europe/Amsterdam",
                          weekday: "long",
                          day: "numeric",
                          month: "long",
                        }).format(new Date(`${recommendation.date}T12:00:00Z`))}
                      </h2>
                      <div className="samaritan-time">
                        <b>{recommendation.time}</b>
                        <span>
                          {recommendation.time} – {addMinutes(recommendation.time, totalDuration)}{" "}
                          · {totalDuration} min
                        </span>
                      </div>
                      <p className="reason pretty">
                        {recommendation.reason === "gap" ? t.recReasonGap : t.recReasonFirst}
                      </p>
                      <div className="samaritan-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-s"
                          onClick={() => acceptRecommendation(recommendation)}
                        >
                          {t.recAccept}
                          <ArrowRight />
                        </button>
                        <button
                          type="button"
                          className="btn btn-on-dark btn-s"
                          onClick={() => setRecommendationDismissed(true)}
                        >
                          {t.recDismiss}
                        </button>
                      </div>
                    </>
                  )}
                  {!loadingRecommendation && !recommendation && (
                    <p
                      style={{ margin: "12px 0 0", fontSize: 15, color: "var(--on-dark-body)" }}
                    >
                      {t.recNone}
                    </p>
                  )}
                </section>
              )}

              {recommendationDismissed && !date && (
                <button
                  type="button"
                  className="samaritan-restore"
                  onClick={() => setRecommendationDismissed(false)}
                >
                  <StarMark />
                  {t.recRestore}
                </button>
              )}

              <p className="eyebrow" style={{ margin: "0 0 10px" }}>
                {monthLabel}
              </p>
              <div className="date-grid" role="radiogroup" aria-label={t.date}>
                {t.days.map((day) => (
                  <span className="date-head" key={day} aria-hidden="true">
                    {day}
                  </span>
                ))}
                {dateCells.map((cell) =>
                  cell.past ? (
                    <span key={cell.value} className="date-cell is-hidden" aria-hidden="true" />
                  ) : (
                    <button
                      key={cell.value}
                      type="button"
                      role="radio"
                      aria-checked={cell.selected}
                      aria-disabled={cell.closed}
                      className={`date-cell${cell.isToday ? " is-today" : ""}`}
                      onClick={() => {
                        if (cell.closed) return;
                        setDate(cell.value);
                        setTime("");
                        setUsedRecommendation(false);
                      }}
                    >
                      <span>{cell.day}</span>
                      <span className="dot" />
                    </button>
                  ),
                )}
              </div>
              <div className="legend">
                <span>
                  <i className="swatch-today" />
                  {t.today}
                </span>
                <span>
                  <i className="swatch-closed" />
                  {t.closed}
                </span>
              </div>
              {date && (
                <div
                  style={{
                    marginTop: 24,
                    paddingTop: 16,
                    borderTop: "1px solid var(--hairline)",
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 14,
                  }}
                >
                  <span className="muted">{t.openingOn}</span>
                  <strong>{dateHours}</strong>
                </div>
              )}
            </>
          )}

          {/* 3 — Time ---------------------------------------------------- */}
          {step === 3 && (
            <>
              {loadingTimes && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    color: "var(--muted)",
                    fontSize: 14,
                    padding: "12px 0",
                  }}
                >
                  <span className="spinner" aria-hidden="true" />
                  {t.checkingTimes}
                </div>
              )}
              {!loadingTimes && noTimes && (
                <div className="empty-state">
                  <strong>{t.noTimesTitle}</strong>
                  <p>{t.noTimesBody}</p>
                  <button type="button" className="btn btn-outline btn-s" onClick={() => goTo(2)}>
                    {t.pickAnotherDate}
                  </button>
                </div>
              )}
              {!loadingTimes &&
                !noTimes &&
                timeGroups.map((group) => (
                  <div key={group.label}>
                    <p className="eyebrow time-group-label">{group.label}</p>
                    <div className="time-grid" role="radiogroup" aria-label={group.label}>
                      {group.slots.map((slot) => {
                        const free = available.has(slot);
                        return (
                          <button
                            key={slot}
                            type="button"
                            role="radio"
                            aria-checked={slot === time}
                            aria-disabled={!free}
                            className="time-cell"
                            onClick={() => {
                              if (!free) return;
                              setTime(slot);
                              setUsedRecommendation(false);
                            }}
                          >
                            {slot}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              {!loadingTimes && !noTimes && (
                <div className="legend">
                  <span>
                    <i className="swatch-unavailable" />
                    {t.unavailableLegend}
                  </span>
                </div>
              )}
            </>
          )}

          {/* 4 — Details ------------------------------------------------- */}
          {step === 4 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <label className="field">
                <span className="label">{t.fullName}</span>
                <input
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  aria-invalid={invalid(nameValid)}
                />
                {invalid(nameValid) && (
                  <span className="field-error" role="alert">
                    {t.errName}
                  </span>
                )}
              </label>

              <label className="field">
                <span className="label">{t.phone}</span>
                <input
                  className="input"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  type="tel"
                  autoComplete="tel"
                  inputMode="tel"
                  aria-invalid={invalid(phoneValid)}
                />
                {invalid(phoneValid) && (
                  <span className="field-error" role="alert">
                    {t.errPhone}
                  </span>
                )}
              </label>

              <label className="field">
                <span className="label">{t.email}</span>
                <input
                  className="input"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  aria-invalid={invalid(emailValid)}
                />
                {invalid(emailValid) && (
                  <span className="field-error" role="alert">
                    {t.errEmail}
                  </span>
                )}
                <span className="field-hint">{t.emailHint}</span>
              </label>

              <label className="field">
                <span className="label">{t.notes}</span>
                <textarea
                  className="input"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                  maxLength={1000}
                />
              </label>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  borderTop: "1px solid var(--hairline)",
                  marginTop: 4,
                }}
              >
                {consents.map((consent) => (
                  <button
                    key={consent.id}
                    type="button"
                    role="checkbox"
                    aria-checked={consent.on}
                    className={`check${consent.error ? " is-invalid" : ""}`}
                    onClick={consent.toggle}
                  >
                    <span className="check-box">
                      <Check strokeWidth={3} />
                    </span>
                    <span>
                      {consent.label}
                      {consent.error && (
                        <span
                          role="alert"
                          style={{
                            display: "block",
                            color: "var(--red)",
                            fontWeight: 600,
                            fontSize: 13,
                            marginTop: 4,
                          }}
                        >
                          {t.errTerms}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 5 — Payment ------------------------------------------------- */}
          {step === 5 && (
            <>
              <div
                role="radiogroup"
                aria-label={t.payment}
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={paymentMethod === "cash"}
                  className="pay-option"
                  onClick={() => setPaymentMethod("cash")}
                >
                  <span className="pay-copy">
                    <span className="kicker">{t.payShopKicker}</span>
                    <strong>{t.payShopTitle}</strong>
                    <span className="body pretty">{t.payShopBody}</span>
                  </span>
                  <b>{formatPrice(totalPrice)}</b>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={paymentMethod === "stripe"}
                  aria-disabled={!stripeEnabled}
                  className="pay-option"
                  onClick={() => {
                    if (stripeEnabled) setPaymentMethod("stripe");
                  }}
                >
                  <span className="pay-copy">
                    <span className="kicker">{t.payOnlineKicker}</span>
                    <strong>{t.payOnlineTitle}</strong>
                    <span className="body pretty">
                      {stripeEnabled ? t.payOnlineBody : t.payOnlineOff}
                    </span>
                  </span>
                  <b>{formatPrice(totalPrice)}</b>
                </button>
              </div>
              <p className="muted pretty" style={{ margin: "18px 0 0", fontSize: 13 }}>
                {paymentFootnote}
              </p>
            </>
          )}

          {/* 6 — Review -------------------------------------------------- */}
          {step === 6 && (
            <>
              <div className="review-head">
                <p className="kicker kicker-on-dark">{t.yourAppointment}</p>
                <h2 className="display">{serviceName}</h2>
                <p className="when">{dateLabel}</p>
                <p className="range">
                  {timeRange} · {totalDuration} min
                </p>
              </div>

              <dl className="review-list">
                {reviewRows.map((row) => (
                  <div className="review-row" key={row.key}>
                    <dt>{row.key}</dt>
                    <dd>
                      {row.value}
                      {row.recommended && <span className="rec-tag">{t.recTag}</span>}
                    </dd>
                    <button type="button" className="link-btn" onClick={() => goTo(row.target)}>
                      {t.edit}
                    </button>
                  </div>
                ))}
              </dl>

              <div className="review-total">
                <span>{t.total}</span>
                <b>{formatPrice(totalPrice)}</b>
              </div>
              <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
                {paymentFootnote}
              </p>

              <p className="notice notice-inline">
                <StarMark />
                <span>{t.loyaltyReview}</span>
              </p>

              {error && (
                <div className="alert" role="alert" style={{ marginTop: 16 }}>
                  <strong>{t.failTitle}</strong>
                  <p>{error}</p>
                  <div className="alert-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-s"
                      onClick={() => void submit()}
                    >
                      {t.retry}
                    </button>
                    <a
                      className="btn btn-on-dark btn-s"
                      href={`https://wa.me/${PHONE.replace("+", "")}`}
                    >
                      WhatsApp
                    </a>
                  </div>
                </div>
              )}
            </>
          )}

          {/* 7 — Confirming ---------------------------------------------- */}
          {step === 7 && (
            <div className="confirming">
              <span className="spinner spinner-l" aria-hidden="true" />
              <strong>{paymentMethod === "stripe" ? t.openingCheckout : t.confirming}</strong>
              <span>{t.confirmingHint}</span>
            </div>
          )}
        </div>
      </div>

      {step < 7 && (
        <div className="sticky-bar sticky-bar-solid">
          <div className="sticky-inner">
            <div className="sticky-total">
              <span>{barSubtitle}</span>
              <b>{formatPrice(totalPrice)}</b>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onNext}
              disabled={!stepValid && step !== 4}
            >
              {nextLabel}
              <ArrowRight />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
