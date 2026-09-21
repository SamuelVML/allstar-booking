export type BarberService = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  isAddOn?: boolean;
};

export const SERVICES: BarberService[] = [
  { id: "haircut", name: "Haircut", durationMinutes: 30, priceCents: 3500 },
  { id: "student-haircut", name: "Student haircut", durationMinutes: 30, priceCents: 3000 },
  { id: "kids-haircut", name: "Kids haircut", durationMinutes: 30, priceCents: 2750 },
  { id: "line-up", name: "Line-up", durationMinutes: 15, priceCents: 1750 },
  { id: "beard-trim-shape", name: "Beard trim & shape", durationMinutes: 20, priceCents: 2250 },
  { id: "haircut-beard", name: "Haircut + beard", durationMinutes: 45, priceCents: 4750 },
  { id: "haircut-colour", name: "Haircut + colour", durationMinutes: 60, priceCents: 5500 },
  { id: "haircut-beard-colour", name: "Haircut + beard + colour", durationMinutes: 75, priceCents: 6750 },
  { id: "colour-add-on", name: "Colour add-on", durationMinutes: 30, priceCents: 2250, isAddOn: true },
];

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

const DAILY_BREAKS: Record<number, Array<{ start: string; end: string }>> = {
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

export function getOpeningHours(date: string) {
  if (!dateIsValid(date)) return null;
  return OPENING_HOURS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? null;
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

function overlapsBreak(date: string, start: string, durationMinutes: number) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const startMinutes = timeToMinutes(start);
  const endMinutes = startMinutes + durationMinutes;
  return (DAILY_BREAKS[day] ?? []).some((period) => (
    startMinutes < timeToMinutes(period.end) && endMinutes > timeToMinutes(period.start)
  ));
}

export function getTodayInEindhoven() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function getCurrentTimeInEindhoven() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function buildAvailableTimes(
  date: string,
  durationMinutes: number,
  occupiedSlots: Set<string>,
  handlingMinutes = HANDLING_BUFFER_MINUTES,
) {
  const hours = getOpeningHours(date);
  if (!hours) return [];

  const times: string[] = [];
  const today = getTodayInEindhoven();
  const currentTime = getCurrentTimeInEindhoven();
  const earliestToday = addMinutes(currentTime, 60);

  const occupiedMinutes = durationMinutes + handlingMinutes;
  for (let time = hours.start; addMinutes(time, occupiedMinutes) <= hours.end; time = addMinutes(time, 5)) {
    if (date === today && time < earliestToday) continue;
    if (overlapsBreak(date, time, occupiedMinutes)) continue;
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
