import { getD1 } from "@/db";
import { getStaffUser } from "@/lib/staff-auth";
import { dateIsValid, getTodayInEindhoven, SERVICES } from "@/lib/booking";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  const user = await getStaffUser(request.headers);
  if (!user) return Response.json({ error: "Not authorised." }, { status: 403, headers });
  const date = new URL(request.url).searchParams.get("date") ?? getTodayInEindhoven();
  if (!dateIsValid(date)) return Response.json({ error: "Invalid date." }, { status: 400, headers });
  try {
    const db = getD1();
    const bookings = await db.prepare(`SELECT reference, revision, source, customer_account_id,
      service_name, price_cents, appointment_date, start_time, end_time, customer_name,
      customer_email, customer_phone, notes, status, payment_method, payment_status
      FROM appointments WHERE appointment_date = ? ORDER BY start_time, reference`).bind(date).all();
    const blocks = await db.prepare(`SELECT id, start_time, end_time, reason FROM time_off
      WHERE date = ? AND removed_at IS NULL ORDER BY start_time`).bind(date).all();
    return Response.json({ date, email: user.email, bookings: bookings.results, blocks: blocks.results,
      services: SERVICES.filter(service => !service.isAddOn) }, { headers });
  } catch {
    return Response.json({ error: "Unable to load bookings." }, { status: 503, headers });
  }
}
