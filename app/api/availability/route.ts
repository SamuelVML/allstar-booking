import { getD1 } from "@/db";
import {
  buildAvailableTimes,
  dateIsValid,
  formatAppointmentDate,
  getService,
  getTodayInEindhoven,
} from "@/lib/booking";
import { releaseExpiredPaymentReservations } from "@/lib/payments";

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
      return Response.json({ error: "Choose a valid service and date." }, { status: 400 });
    }

    const today = getTodayInEindhoven();
    const maximum = new Date(`${today}T12:00:00Z`);
    maximum.setUTCDate(maximum.getUTCDate() + 60);
    const maximumDate = maximum.toISOString().slice(0, 10);
    if (date && (date < today || date > maximumDate)) {
      return Response.json({ error: "Bookings are available up to 60 days ahead." }, { status: 400 });
    }

    const database = getD1();
    await releaseExpiredPaymentReservations(database);
    const rangeStart = date || today;
    const rangeEnd = date || maximumDate;
    const rows = await database
      .prepare(
        "SELECT slot_start FROM (SELECT slot_start FROM appointment_slots UNION ALL SELECT slot_start FROM time_off_slots) WHERE slot_start >= ? AND slot_start < ?",
      )
      .bind(`${rangeStart}T00:00`, `${rangeEnd}T23:59`)
      .all<{ slot_start: string }>();
    const occupied = new Set(rows.results.map((row) => row.slot_start));

    const durationMinutes = service.durationMinutes + (colourAddOn ? 30 : 0);
    if (!date) {
      const recommendations: Array<{ date: string; dateLabel: string; time: string }> = [];
      for (let offset = 0; offset <= 60 && recommendations.length < 3; offset += 1) {
        const candidate = new Date(`${today}T12:00:00Z`);
        candidate.setUTCDate(candidate.getUTCDate() + offset);
        const candidateDate = candidate.toISOString().slice(0, 10);
        const available = buildAvailableTimes(candidateDate, durationMinutes, occupied);
        if (available.length > 0) {
          recommendations.push({
            date: candidateDate,
            dateLabel: formatAppointmentDate(candidateDate),
            time: available[0],
          });
        }
      }
      return Response.json({ service: service.id, recommendations });
    }

    return Response.json({
      date,
      service: service.id,
      times: buildAvailableTimes(
        date,
        durationMinutes,
        occupied,
      ),
    });
  } catch (error) {
    console.error("Availability lookup failed", error);
    return Response.json(
      { error: "Availability is temporarily unavailable. Please try again." },
      { status: 503 },
    );
  }
}
