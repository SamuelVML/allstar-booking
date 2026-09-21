import Stripe from "stripe";
import { getD1 } from "@/db";
import { confirmPaidAppointment, expirePaymentAppointment } from "@/lib/payments";
import { getStripeClient, getStripeWebhookSecret } from "@/lib/stripe";
import { sendBookingConfirmation } from "@/lib/booking-email";

type ConfirmedAppointment = {
  id: string;
  reference: string;
  customer_name: string;
  customer_email: string;
  service_name: string;
  appointment_date: string;
  start_time: string;
  end_time: string;
  price_cents: number;
};

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing Stripe signature", { status: 400 });

  try {
    const stripe = getStripeClient();
    const rawBody = await request.text();
    const event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      getStripeWebhookSecret(),
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
    const database = getD1();
    const processed = await database
      .prepare("SELECT id FROM stripe_events WHERE id = ?")
      .bind(event.id)
      .first<{ id: string }>();
    if (processed) return Response.json({ received: true, duplicate: true });

    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event.data.object as Stripe.Checkout.Session;
      const appointmentId = session.metadata?.appointment_id;
      if (appointmentId && session.payment_status === "paid") {
        await confirmPaidAppointment(database, appointmentId, session.id);
        const appointment = await database
          .prepare(
            `SELECT id, reference, customer_name, customer_email, service_name,
                    appointment_date, start_time, end_time, price_cents
             FROM appointments WHERE id = ? AND status = 'confirmed'`,
          )
          .bind(appointmentId)
          .first<ConfirmedAppointment>();
        if (appointment) {
          try {
            await sendBookingConfirmation({
              appointmentId: appointment.id,
              reference: appointment.reference,
              customerName: appointment.customer_name,
              customerEmail: appointment.customer_email,
              serviceName: appointment.service_name,
              date: appointment.appointment_date,
              time: appointment.start_time,
              endTime: appointment.end_time,
              priceCents: appointment.price_cents,
              paymentMethod: "Paid online",
            });
          } catch (error) {
            console.error("Paid booking confirmation email failed", error);
          }
        }
      }
    }

    if (
      event.type === "checkout.session.expired" ||
      event.type === "checkout.session.async_payment_failed"
    ) {
      const session = event.data.object as Stripe.Checkout.Session;
      const appointmentId = session.metadata?.appointment_id;
      if (appointmentId) await expirePaymentAppointment(database, appointmentId, session.id);
    }

    try {
      await database
        .prepare("INSERT INTO stripe_events (id, type) VALUES (?, ?)")
        .bind(event.id, event.type)
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("UNIQUE") && !message.includes("constraint")) throw error;
    }

    return Response.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook rejected", error);
    return new Response("Invalid Stripe webhook", { status: 400 });
  }
}
