import { getD1 } from "@/db";
import { getStaffUser } from "@/lib/staff-auth";
import { availableForBooking, validManagementDate, type ManagedBooking } from "@/lib/booking-management";
import { readBookingSettings } from "@/lib/booking-settings";

export async function GET(request: Request) {
  if (!await getStaffUser(request.headers)) return Response.json({ error: "Not authorised." }, { status: 403 });
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  try {
    const database = getD1();
    const stored = await readBookingSettings(database);
    if (!validManagementDate(date, stored.settings.bookingWindowDays)) return Response.json({ error: `Choose a date within the next ${stored.settings.bookingWindowDays} days.` }, { status: 400 });
    const booking = await database.prepare("SELECT * FROM appointments WHERE reference = ?").bind(url.searchParams.get("reference") ?? "").first<ManagedBooking>();
    if (!booking || booking.status !== "confirmed") return Response.json({ error: "Confirmed booking not found." }, { status: 404 });
    return Response.json({ times: await availableForBooking(database, booking, date, stored) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Availability is temporarily unavailable." }, { status: 503 });
  }
}
