import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import { authenticatedEmailFromHeaders } from "@/app/chatgpt-auth";

type AppointmentRow = {
  id: string;
  status: string;
  customer_account_id: string | null;
};

export async function POST(request: Request) {
  const email = authenticatedEmailFromHeaders(request.headers)?.toLowerCase() ?? "";
  const allowed = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !allowed.includes(email)) {
    return Response.json({ error: "Not authorised." }, { status: 403 });
  }

  const payload = (await request.json()) as { reference?: string };
  const reference = payload.reference?.trim() ?? "";
  const database = getD1();
  const appointment = await database
    .prepare("SELECT id, status, customer_account_id FROM appointments WHERE reference = ?")
    .bind(reference)
    .first<AppointmentRow>();
  if (!appointment) return Response.json({ error: "Booking not found." }, { status: 404 });
  if (appointment.status === "completed") return Response.json({ completed: true, duplicate: true });
  if (appointment.status !== "confirmed" || !appointment.customer_account_id) {
    return Response.json({ error: "Only confirmed customer bookings can be completed." }, { status: 409 });
  }

  const loyaltyEventId = crypto.randomUUID();
  try {
    await database.batch([
      database
        .prepare(
          "INSERT INTO loyalty_events (id, customer_account_id, appointment_id, points_delta, event_type) VALUES (?, ?, ?, 1, 'visit_completed')",
        )
        .bind(loyaltyEventId, appointment.customer_account_id, appointment.id),
      database
        .prepare(
          `UPDATE customer_accounts
           SET loyalty_points = loyalty_points + 1,
               completed_visits = completed_visits + 1,
               last_visit_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(appointment.customer_account_id),
      database
        .prepare("UPDATE appointments SET status = 'completed' WHERE id = ? AND status = 'confirmed'")
        .bind(appointment.id),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("UNIQUE") && !message.includes("constraint")) throw error;
  }

  return Response.json({ completed: true, pointsAwarded: 1 });
}
