export type BarberService = {
  id: string;
  /** English display name; stored on new appointments as `service_name`. */
  name: string;
  durationMinutes: number;
  priceCents: number;
  /** Bookly service this website service is, one to one (owner decision D06). */
  booklyServiceId: number;
  /** The service title exactly as Bookly holds it (trimmed). */
  booklyName: string;
};

export type OpeningPeriod = { start: string; end: string };

export type BookingSettings = {
  openingHours: Record<number, OpeningPeriod | null>;
  dailyBreaks: Record<number, OpeningPeriod[]>;
  handlingBufferMinutes: number;
  onlineLeadMinutes: number;
  bookingWindowDays: number;
  paymentHoldMinutes: number;
  loyaltyRewardPoints: number;
};

/**
 * The bookable catalogue. Owner decision D06 (2026-10-14): Bookly is the
 * authoritative source for prices and durations, so every entry mirrors one
 * Bookly service as read on 2026-10-14
 * (`docs/release-cutover/bookly-catalogue-2026-10-14.json`). Distinct Bookly
 * services stay distinct even where durations match, and there are no add-on
 * combinations: Bookly has no extras configured. Change an entry only after
 * Bookly itself changes, and update the mapping contract with it
 * (`docs/release-cutover/service-mapping-contract.md`).
 */
export const SERVICES: readonly BarberService[] = Object.freeze([
  { id: "haircut", name: "Haircut", durationMinutes: 30, priceCents: 3350, booklyServiceId: 1, booklyName: "Hair cut" },
  { id: "line-up", name: "Line-up (shape-up)", durationMinutes: 15, priceCents: 1700, booklyServiceId: 2, booklyName: "Line up (Shape up) Contouren" },
  { id: "beard-shape", name: "Beard shape (model)", durationMinutes: 15, priceCents: 2000, booklyServiceId: 4, booklyName: "Beard Shape (model)" },
  { id: "line-up-beard-shave", name: "Line-up & beard shave", durationMinutes: 15, priceCents: 2250, booklyServiceId: 13, booklyName: "Line up & Beard shave" },
  { id: "line-up-beard-model", name: "Line-up & beard model", durationMinutes: 30, priceCents: 2800, booklyServiceId: 14, booklyName: "Line up & Beard model" },
  { id: "line-up-beard-model-colour", name: "Line-up, beard model & hair colour", durationMinutes: 30, priceCents: 4450, booklyServiceId: 16, booklyName: "Line up, beard model & hair color" },
  { id: "haircut-colour", name: "Haircut & hair colour", durationMinutes: 60, priceCents: 5000, booklyServiceId: 17, booklyName: "Hair cut & hair color" },
  { id: "haircut-beard-trim", name: "Haircut & beard trim or shave", durationMinutes: 40, priceCents: 3800, booklyServiceId: 18, booklyName: "Hair cut & Beard trim or shave" },
  { id: "haircut-beard-shape", name: "Haircut & beard shape", durationMinutes: 40, priceCents: 4000, booklyServiceId: 19, booklyName: "Hair cut & Beard shape" },
  { id: "haircut-beard-shape-colour", name: "Haircut, beard shape & hair colour", durationMinutes: 60, priceCents: 5500, booklyServiceId: 20, booklyName: "Hair cut, Beard shape & Hair color" },
  { id: "kids-haircut", name: "Kids haircut (4–15 years)", durationMinutes: 30, priceCents: 2750, booklyServiceId: 21, booklyName: "Kids (4-15 years)" },
  { id: "toddler-haircut", name: "Toddler haircut (0–3 years)", durationMinutes: 30, priceCents: 2500, booklyServiceId: 22, booklyName: "Enfants (0 - 3 years)" },
  { id: "kids-haircut-x2", name: "Two kids haircuts (4–15 years)", durationMinutes: 50, priceCents: 5500, booklyServiceId: 23, booklyName: "Kids x2 (4-15 years)" },
  { id: "student-haircut", name: "Student haircut (16+)", durationMinutes: 40, priceCents: 3350, booklyServiceId: 26, booklyName: "Hair cut Student 16 years +" },
].map((service) => Object.freeze(service)));

/**
 * Website key → Bookly service ID, derived from `SERVICES`. The WordPress
 * bridge ships the same map (`integrations/bookly/allstar-bookly-bridge/service-map.json`);
 * `tests/catalogue-consistency.mjs` keeps the two identical.
 */
export const BOOKLY_SERVICE_MAP: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(SERVICES.map((service) => [service.id, service.booklyServiceId])),
);

/**
 * Service keys the website sold before D06. Read-only: appointments that
 * carry them keep their stored name, duration and price, and these keys are
 * never bookable or priced again (`getService` does not know them).
 */
export const LEGACY_SERVICE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "beard-trim-shape": "Beard trim & shape",
  "haircut-beard": "Haircut + beard",
  "haircut-beard-colour": "Haircut + beard + colour",
  "colour-add-on": "Colour add-on",
});

export const OPENING_HOURS: Record<number, { start: string; end: string } | null> = {
  0: null,
  1: { start: "13:00", end: "18:00" },
  2: { start: "10:00", end: "19:00" },
  3: { start: "10:00", end: "19:00" },
  4: { start: "10:00", end: "19:00" },
  5: { start: "10:00", end: "20:00" },
  6: { start: "10:00", end: "20:00" },
};

export const HANDLING_BUFFER_MINUTES = 10;
export const LOYALTY_REWARD_POINTS = 10;
export const ONLINE_LEAD_MINUTES = 60;
export const BOOKING_WINDOW_DAYS = 60;
export const PAYMENT_HOLD_MINUTES = 30;

/**
 * Exported so Backstage can draw the barber's scheduled breaks in the agenda
 * and the calendar. Availability still reads it through `overlapsBreak`; the
 * values and the booking rules they drive are unchanged.
 */
export const DAILY_BREAKS: Record<number, Array<{ start: string; end: string }>> = {
  0: [],
  1: [
    { start: "14:15", end: "14:30" },
    { start: "15:30", end: "15:45" },
    { start: "16:45", end: "17:15" },
  ],
  2: [
    { start: "12:00", end: "12:15" },
    { start: "14:30", end: "14:45" },
    { start: "16:45", end: "17:15" },
  ],
  3: [
    { start: "12:00", end: "12:15" },
    { start: "14:30", end: "14:45" },
    { start: "16:45", end: "17:15" },
  ],
  4: [
    { start: "12:00", end: "12:15" },
    { start: "14:30", end: "14:45" },
    { start: "16:45", end: "17:15" },
  ],
  5: [
    { start: "12:15", end: "12:30" },
    { start: "15:00", end: "15:15" },
    { start: "17:30", end: "18:00" },
  ],
  6: [
    { start: "12:15", end: "12:30" },
    { start: "15:00", end: "15:15" },
    { start: "17:30", end: "18:00" },
  ],
};

export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  openingHours: OPENING_HOURS,
  dailyBreaks: DAILY_BREAKS,
  handlingBufferMinutes: HANDLING_BUFFER_MINUTES,
  onlineLeadMinutes: ONLINE_LEAD_MINUTES,
  bookingWindowDays: BOOKING_WINDOW_DAYS,
  paymentHoldMinutes: PAYMENT_HOLD_MINUTES,
  loyaltyRewardPoints: LOYALTY_REWARD_POINTS,
};

export function getService(serviceId: string) {
  return SERVICES.find((service) => service.id === serviceId);
}

export function formatPrice(priceCents: number) {
  return new Intl.NumberFormat("en-NL", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: priceCents % 100 === 0 ? 0 : 2,
  }).format(priceCents / 100);
}

export function dateIsValid(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

export function getOpeningHours(
  date: string,
  settings: BookingSettings = DEFAULT_BOOKING_SETTINGS,
) {
  if (!dateIsValid(date)) return null;
  return settings.openingHours[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? null;
}

export function addMinutes(time: string, minutes: number) {
  const [hour, minute] = time.split(":").map(Number);
  const total = hour * 60 + minute + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function makeSlotKeys(date: string, time: string, durationMinutes: number) {
  const slots: string[] = [];
  for (let offset = 0; offset < durationMinutes; offset += 5) {
    slots.push(`${date}T${addMinutes(time, offset)}`);
  }
  return slots;
}

function timeToMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function overlapsBreak(
  date: string,
  start: string,
  durationMinutes: number,
  settings: BookingSettings,
) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const startMinutes = timeToMinutes(start);
  const endMinutes = startMinutes + durationMinutes;
  return (settings.dailyBreaks[day] ?? []).some((period) => (
    startMinutes < timeToMinutes(period.end) && endMinutes > timeToMinutes(period.start)
  ));
}

export function getTodayInEindhoven(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function getCurrentTimeInEindhoven(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

export function buildAvailableTimes(
  date: string,
  durationMinutes: number,
  occupiedSlots: Set<string>,
  handlingMinutes = HANDLING_BUFFER_MINUTES,
  leadMinutes = ONLINE_LEAD_MINUTES,
  now = new Date(),
  settings: BookingSettings = DEFAULT_BOOKING_SETTINGS,
) {
  const hours = getOpeningHours(date, settings);
  if (!hours) return [];

  const times: string[] = [];
  const today = getTodayInEindhoven(now);
  const currentTime = getCurrentTimeInEindhoven(now);
  const earliestToday = addMinutes(currentTime, leadMinutes);

  const occupiedMinutes = durationMinutes + handlingMinutes;
  for (let time = hours.start; addMinutes(time, occupiedMinutes) <= hours.end; time = addMinutes(time, 5)) {
    if (date === today && time < earliestToday) continue;
    if (overlapsBreak(date, time, occupiedMinutes, settings)) continue;
    const requiredSlots = makeSlotKeys(date, time, occupiedMinutes);
    if (requiredSlots.every((slot) => !occupiedSlots.has(slot))) times.push(time);
  }

  return times;
}

export function formatAppointmentDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${date}T12:00:00Z`));
}
