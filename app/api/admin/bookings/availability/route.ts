import { getD1 } from "@/db";
import { getStaffUser } from "@/lib/staff-auth";
import { availableForBooking, validManagementDate, type ManagedBooking } from "@/lib/booking-management";

export async function GET(request: Request) {
  if (!await getStaffUser(request.headers)) return Response.json({ error: "Not authorised." }, { status: 403 });
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  if (!validManagementDate(date)) return Response.json({ error: "Choose a date within the next 60 days." }, { status: 400 });
  try {
    const database = getD1();
    const booking = await database.prepare("SELECT * FROM appointments WHERE reference = ?").bind(url.searchParams.get("reference") ?? "").first<ManagedBooking>();
    if (!booking || booking.status !== "confirmed") return Response.json({ error: "Confirmed booking not found." }, { status: 404 });
    return Response.json({ times: await availableForBooking(database, booking, date) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Availability is temporarily unavailable." }, { status: 503 });
  }
}
