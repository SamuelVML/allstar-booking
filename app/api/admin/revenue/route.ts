import { getStaffUser } from "@/lib/staff-auth";
import { dateIsValid, getTodayInEindhoven } from "@/lib/booking";
import { readRange } from "@/lib/backstage-data";
import { isPeriod, periodRange, summarise } from "@/lib/backstage-reporting";

/**
 * Read-only revenue summary for a day, week or month.
 *
 * A new endpoint — no existing contract changes. The Backstage web pages read
 * the same `summarise()` directly on the server; this exists so the native
 * Backstage client, which already consumes `/api/admin/*`, can show the same
 * figures without reimplementing the rules about what counts as received.
 */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!(await getStaffUser(request.headers))) {
    return Response.json({ error: "Not authorised." }, { status: 403, headers });
  }

  const params = new URL(request.url).searchParams;
  const date = params.get("date") ?? getTodayInEindhoven();
  const period = params.get("period") ?? "day";
  if (!dateIsValid(date) || !isPeriod(period)) {
    return Response.json({ error: "Invalid date or period." }, { status: 400, headers });
  }

  try {
    const { from, to } = periodRange(period, date);
    const { appointments } = await readRange(from, to);
    return Response.json(summarise(period, date, appointments), { headers });
  } catch {
    return Response.json({ error: "Unable to load revenue." }, { status: 503, headers });
  }
}
