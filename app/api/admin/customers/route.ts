import { getD1 } from "@/db";
import { getStaffUser } from "@/lib/staff-auth";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!await getStaffUser(request.headers)) return Response.json({ error: "Not authorised." }, { status: 403, headers });
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const query = (params.get("q") ?? "").trim();
  if (query.length > 100 || (id && id.length > 100)) return Response.json({ error: "Invalid search." }, { status: 400, headers });
  try {
    const db = getD1();
    if (id) {
      const visits = await db.prepare(`SELECT reference, service_name, appointment_date, start_time,
        status, payment_status, price_cents FROM appointments WHERE customer_account_id = ?
        ORDER BY appointment_date DESC, start_time DESC LIMIT 100`).bind(id).all();
      return Response.json({ visits: visits.results }, { headers });
    }
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const customers = await db.prepare(`SELECT id, name, email, phone, loyalty_points, completed_visits
      FROM customer_accounts WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
      ORDER BY name, id LIMIT 100`).bind(pattern, pattern).all();
    return Response.json({ customers: customers.results }, { headers });
  } catch {
    return Response.json({ error: "Unable to load customers." }, { status: 503, headers });
  }
}
