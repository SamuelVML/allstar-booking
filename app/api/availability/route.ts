import { getD1 } from "@/db";
import {
  buildAvailableTimes,
  dateIsValid,
  formatAppointmentDate,
  getService,
  getTodayInEindhoven,
} from "@/lib/booking";
import { rankRecommendations } from "@/lib/recommendations";
import { releaseExpiredPaymentReservations } from "@/lib/payments";
import { readBookingSettings } from "@/lib/booking-settings";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? "";
    const serviceId = url.searchParams.get("service") ?? "";
    const service = getService(serviceId);
    const colourAddOn =
      url.searchParams.get("addOn") === "colour" &&
      !service?.id.includes("colour");

    if (!service || service.isAddOn || (date && !dateIsValid(date))) {
      return Response.json({ error: "Choose a valid service and date." }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const now = new Date();
    const today = getTodayInEindhoven(now);
    const database = getD1();
    const { settings } = await readBookingSettings(database);
    const maximumDate = addDays(today, settings.bookingWindowDays);
    if (date && (date < today || date > maximumDate)) {
      return Response.json({ error: `Bookings are available up to ${settings.bookingWindowDays} days ahead.` }, { status: 400, headers: NO_STORE_HEADERS });
    }

    await releaseExpiredPaymentReservations(database);
    const rangeStart = date || today;
    const rangeEnd = date || maximumDate;
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

    if (!date) {
      const availableDays = [];
      for (let offset = 0; offset <= settings.bookingWindowDays; offset += 1) {
        const candidateDate = addDays(today, offset);
        const times = buildAvailableTimes(
          candidateDate,
          durationMinutes,
          occupied,
          settings.handlingBufferMinutes,
          settings.onlineLeadMinutes,
          now,
          settings,
        );
        if (times.length > 0) availableDays.push({ date: candidateDate, times });
      }
      const recommendations = rankRecommendations({
        availableDays,
        occupiedSlots: appointmentSlots,
        durationMinutes,
        serviceName: service.name,
        limit: 2,
        distinctDates: true,
        handlingMinutes: settings.handlingBufferMinutes,
      }).map(({ date: recommendationDate, time }) => ({
        date: recommendationDate,
        dateLabel: formatAppointmentDate(recommendationDate),
        time,
      }));
      return Response.json({
        service: service.id,
        recommendations,
        generatedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 60_000).toISOString(),
      }, { headers: NO_STORE_HEADERS });
    }

    return Response.json({
      date,
      service: service.id,
      times: buildAvailableTimes(
        date,
        durationMinutes,
        occupied,
        settings.handlingBufferMinutes,
        settings.onlineLeadMinutes,
        now,
        settings,
      ),
      generatedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 60_000).toISOString(),
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("Availability lookup failed", error);
    return Response.json(
      { error: "Availability is temporarily unavailable. Please try again." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
