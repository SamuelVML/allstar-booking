import { getD1 } from "@/db";
import {
  buildAvailableTimes,
  dateIsValid,
  getService,
  getTodayInEindhoven,
} from "@/lib/booking";
import { rankRecommendations } from "@/lib/recommendations";
import { releaseExpiredPaymentReservations } from "@/lib/payments";
import { getStaffUser } from "@/lib/staff-auth";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const user = await getStaffUser(request.headers);
  if (!user) return Response.json({ error: "Not authorised." }, { status: 403, headers: PRIVATE_HEADERS });

  try {
    const url = new URL(request.url);
    const serviceId = url.searchParams.get("service") ?? "";
    const date = url.searchParams.get("date") ?? "";
    const service = getService(serviceId);
    const colourAddOn =
      url.searchParams.get("addOn") === "colour" &&
      !service?.id.includes("colour");
    if (!service || service.isAddOn || (date && !dateIsValid(date))) {
      return Response.json({ error: "Choose a valid service and date." }, { status: 400, headers: PRIVATE_HEADERS });
    }

    const now = new Date();
    const today = getTodayInEindhoven(now);
    const maximumDate = addDays(today, 60);
    if (date && (date < today || date > maximumDate)) {
      return Response.json({ error: "Choose today or a future date within 60 days." }, { status: 400, headers: PRIVATE_HEADERS });
    }

    const rangeStart = date || today;
    const rangeEnd = date || addDays(today, 14);
    const database = getD1();
    await releaseExpiredPaymentReservations(database);
    const rows = await database
      .prepare(
        "SELECT slot_start, kind FROM (SELECT slot_start, 'appointment' AS kind FROM appointment_slots UNION ALL SELECT slot_start, 'time_off' AS kind FROM time_off_slots) WHERE slot_start >= ? AND slot_start < ?",
      )
      .bind(`${rangeStart}T00:00`, `${rangeEnd}T23:59`)
      .all<{ slot_start: string; kind: "appointment" | "time_off" }>();
    const occupied = new Set(rows.results.map((row) => row.slot_start));
    const appointmentSlots = new Set(
      rows.results.filter((row) => row.kind === "appointment").map((row) => row.slot_start),
    );
    const durationMinutes = service.durationMinutes + (colourAddOn ? 30 : 0);
    const availableDays = [];
    const daysToScan = date ? 0 : 14;
    for (let offset = 0; offset <= daysToScan; offset += 1) {
      const candidateDate = date || addDays(today, offset);
      const times = buildAvailableTimes(
        candidateDate,
        durationMinutes,
        occupied,
        undefined,
        0,
        now,
      );
      if (times.length > 0) availableDays.push({ date: candidateDate, times });
    }

    const recommendations = rankRecommendations({
      availableDays,
      occupiedSlots: appointmentSlots,
      durationMinutes,
      serviceName: service.name,
      limit: 3,
      distinctDates: false,
    });

    return Response.json({
      service: service.id,
      date: date || null,
      recommendations,
      generatedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 30_000).toISOString(),
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    console.error("Backstage recommendation lookup failed", error);
    return Response.json(
      { error: "Recommendations are temporarily unavailable." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
