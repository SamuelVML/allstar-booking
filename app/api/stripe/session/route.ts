import { getD1 } from "@/db";
import { confirmPaidAppointment } from "@/lib/payments";
import { getStripeClient } from "@/lib/stripe";

type AppointmentRow = {
  reference: string;
  service_name: string;
  appointment_date: string;
  start_time: string;
  end_time: string;
  price_cents: number;
  payment_status: string;
};

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("session_id") ?? "";
    if (!sessionId.startsWith("cs_")) {
      return Response.json({ error: "Invalid checkout session." }, { status: 400 });
    }

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const appointmentId = session.metadata?.appointment_id;
    if (!appointmentId) {
      return Response.json({ error: "Booking not found." }, { status: 404 });
    }

    const database = getD1();
    if (session.payment_status !== "paid") {
      return Response.json({ error: "Payment is still processing." }, { status: 409 });
    }
    await confirmPaidAppointment(database, appointmentId, session.id);
    const row = await database
      .prepare(
        `SELECT reference, service_name, appointment_date, start_time, end_time,
          price_cents, payment_status
         FROM appointments WHERE id = ? AND stripe_checkout_session_id = ?`,
      )
      .bind(appointmentId, session.id)
      .first<AppointmentRow>();
    if (!row) return Response.json({ error: "Booking not found." }, { status: 404 });

    return Response.json({
      booking: {
        reference: row.reference,
        serviceName: row.service_name,
        date: row.appointment_date,
        time: row.start_time,
        endTime: row.end_time,
        priceCents: row.price_cents,
        paymentStatus: row.payment_status,
      },
    });
  } catch (error) {
    console.error("Stripe session lookup failed", error);
    return Response.json({ error: "Payment confirmation is still processing." }, { status: 503 });
  }
}
