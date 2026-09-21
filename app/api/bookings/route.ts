import { getD1 } from "@/db";
import {
  addMinutes,
  buildAvailableTimes,
  dateIsValid,
  getService,
  getTodayInEindhoven,
  HANDLING_BUFFER_MINUTES,
  LOYALTY_REWARD_POINTS,
  makeSlotKeys,
} from "@/lib/booking";
import { releaseExpiredPaymentReservations } from "@/lib/payments";
import { getStripeClient, stripeIsConfigured } from "@/lib/stripe";
import { sendBookingConfirmation } from "@/lib/booking-email";

type BookingPayload = {
  serviceId?: string;
  date?: string;
  time?: string;
  name?: string;
  email?: string;
  phone?: string;
  notes?: string;
  acceptedTerms?: boolean;
  colourAddOn?: boolean;
  paymentMethod?: "cash" | "stripe";
  reminderOptIn?: boolean;
  marketingConsent?: boolean;
};

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as BookingPayload;
    const service = getService(payload.serviceId ?? "");
    const date = payload.date?.trim() ?? "";
    const time = payload.time?.trim() ?? "";
    const name = payload.name?.trim() ?? "";
    const email = payload.email?.trim().toLowerCase() ?? "";
    const phone = payload.phone?.trim() ?? "";
    const notes = payload.notes?.trim() ?? "";
    const paymentMethod = payload.paymentMethod === "stripe" ? "stripe" : "cash";

    if (!service || service.isAddOn || !dateIsValid(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return Response.json({ error: "Choose a valid service, date and time." }, { status: 400 });
    }
    if (date < getTodayInEindhoven()) {
      return Response.json({ error: "Choose a future appointment." }, { status: 400 });
    }
    if (name.length < 2 || name.length > 80) {
      return Response.json({ error: "Enter your full name." }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      return Response.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (!/^[+()\d\s-]{7,30}$/.test(phone)) {
      return Response.json({ error: "Enter a valid phone number." }, { status: 400 });
    }
    if (notes.length > 1000 || payload.acceptedTerms !== true) {
      return Response.json({ error: "Accept the booking conditions to continue." }, { status: 400 });
    }

    if (paymentMethod === "stripe" && !stripeIsConfigured()) {
      return Response.json(
        { error: "Online payment is being connected. Choose cash at the shop for now." },
        { status: 503 },
      );
    }

    const database = getD1();
    await releaseExpiredPaymentReservations(database);
    const colourAddOn = payload.colourAddOn === true && !service.id.includes("colour");
    const durationMinutes = service.durationMinutes + (colourAddOn ? 30 : 0);
    const priceCents = service.priceCents + (colourAddOn ? 2250 : 0);
    const serviceName = `${service.name}${colourAddOn ? " + colour" : ""}`;
    const occupiedRows = await database
      .prepare(
        "SELECT slot_start FROM appointment_slots WHERE slot_start >= ? AND slot_start < ?",
      )
      .bind(`${date}T00:00`, `${date}T23:59`)
      .all<{ slot_start: string }>();
    const occupied = new Set(occupiedRows.results.map((row) => row.slot_start));
    const availableTimes = buildAvailableTimes(date, durationMinutes, occupied);
    if (!availableTimes.includes(time)) {
      return Response.json(
        { error: "That time was just booked. Please choose another time." },
        { status: 409 },
      );
    }

    const newCustomerId = crypto.randomUUID();
    const customer = await database
      .prepare(
        `INSERT INTO customer_accounts (
          id, email, name, phone, reminder_opt_in, marketing_consent, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(email) DO UPDATE SET
          name = excluded.name,
          phone = excluded.phone,
          reminder_opt_in = excluded.reminder_opt_in,
          marketing_consent = excluded.marketing_consent,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id, loyalty_points, completed_visits`,
      )
      .bind(
        newCustomerId,
        email,
        name,
        phone,
        payload.reminderOptIn === false ? 0 : 1,
        payload.marketingConsent === true ? 1 : 0,
      )
      .first<{ id: string; loyalty_points: number; completed_visits: number }>();
    if (!customer) throw new Error("Customer account could not be created.");

    const appointmentId = crypto.randomUUID();
    const reference = `AS-${date.replaceAll("-", "")}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const endTime = addMinutes(time, durationMinutes);
    const paymentExpiresAt =
      paymentMethod === "stripe" ? new Date(Date.now() + 31 * 60 * 1000).toISOString() : null;
    const status = paymentMethod === "stripe" ? "payment_pending" : "confirmed";
    const paymentStatus = paymentMethod === "stripe" ? "pending" : "due_at_shop";
    const storedPaymentMethod = paymentMethod === "stripe" ? "stripe" : "pay_at_shop";
    const statements = [
      database
        .prepare(
          `INSERT INTO appointments (
            id, reference, service_id, service_name, duration_minutes, price_cents,
            appointment_date, start_time, end_time, customer_name, customer_email,
            customer_phone, notes, status, payment_method, payment_status, payment_expires_at,
            customer_account_id, handling_minutes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          appointmentId,
          reference,
          service.id,
          serviceName,
          durationMinutes,
          priceCents,
          date,
          time,
          endTime,
          name,
          email,
          phone,
          notes,
          status,
          storedPaymentMethod,
          paymentStatus,
          paymentExpiresAt,
          customer.id,
          HANDLING_BUFFER_MINUTES,
        ),
      ...makeSlotKeys(date, time, durationMinutes + HANDLING_BUFFER_MINUTES).map((slot) =>
        database
          .prepare("INSERT INTO appointment_slots (slot_start, appointment_id) VALUES (?, ?)")
          .bind(slot, appointmentId),
      ),
    ];

    await database.batch(statements);

    if (paymentMethod === "stripe") {
      try {
        const origin = new URL(request.url).origin;
        const stripe = getStripeClient();
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          customer_email: email,
          line_items: [
            {
              price_data: {
                currency: "eur",
                product_data: { name: serviceName },
                unit_amount: priceCents,
              },
              quantity: 1,
            },
          ],
          metadata: { appointment_id: appointmentId, booking_reference: reference },
          success_url: `${origin}/book/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/book?payment=cancelled`,
          expires_at: Math.floor(new Date(paymentExpiresAt!).getTime() / 1000),
          integration_identifier: "allstar_web_kqmrstuv",
        });
        if (!session.url) throw new Error("Stripe did not return a checkout URL.");
        await database
          .prepare(
            "UPDATE appointments SET stripe_checkout_session_id = ? WHERE id = ?",
          )
          .bind(session.id, appointmentId)
          .run();
        return Response.json({ checkoutUrl: session.url }, { status: 201 });
      } catch (error) {
        await database.batch([
          database.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(appointmentId),
          database.prepare("DELETE FROM appointments WHERE id = ?").bind(appointmentId),
        ]);
        console.error("Stripe Checkout creation failed", error);
        return Response.json(
          { error: "Online checkout could not start. Choose cash or try again." },
          { status: 503 },
        );
      }
    }

    let confirmationEmailSent = false;
    try {
      confirmationEmailSent = await sendBookingConfirmation({
        appointmentId,
        reference,
        customerName: name,
        customerEmail: email,
        serviceName,
        date,
        time,
        endTime,
        priceCents,
        paymentMethod: "Pay at the shop",
      });
    } catch (error) {
      console.error("Booking confirmation email failed", error);
    }

    return Response.json(
      {
        confirmationEmailSent,
        booking: {
          reference,
          serviceName,
          date,
          time,
          endTime,
          durationMinutes,
          priceCents,
          paymentMethod: "Pay at the shop",
          loyalty: {
            currentPoints: customer.loyalty_points,
            rewardAt: LOYALTY_REWARD_POINTS,
            pendingPoint: 1,
          },
        },
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return Response.json(
        { error: "That time was just booked. Please choose another time." },
        { status: 409 },
      );
    }
    console.error("Booking creation failed", error);
    return Response.json(
      { error: "We could not save your booking. Please try again." },
      { status: 503 },
    );
  }
}
