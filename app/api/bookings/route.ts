import { assertBooklyFresh, pushBooklyChanges, filterBooklyTimes, booklyEnabled, BooklyConflict, BooklyUnavailable } from "@/lib/bookly";
import { getD1 } from "@/db";
import {
  addMinutes,
  buildAvailableTimes,
  dateIsValid,
  getService,
  getTodayInEindhoven,
  makeSlotKeys,
} from "@/lib/booking";
import { releaseExpiredPaymentReservations } from "@/lib/payments";
import { getStripeClient, stripeIsConfigured } from "@/lib/stripe";
import { sendBookingConfirmation } from "@/lib/booking-email";
import { readBookingSettings } from "@/lib/booking-settings";

type BookingPayload = {
  requestId?: string;
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

type HeldBooking = { id: string; reference: string; customer_email: string; service_name: string; price_cents: number;
  status: string; payment_method: string; payment_expires_at: string | null; stripe_checkout_session_id: string | null };

/** Stripe Checkout for a held booking. Every attempt for the same hold sends
 * identical parameters under an idempotency key derived from the booking and
 * its hold expiry, so a retry or a concurrent retry receives the session
 * already created instead of a second one. */
async function checkoutFor(booking: HeldBooking, origin: string) {
  const expiresAt = Math.floor(new Date(booking.payment_expires_at!).getTime() / 1000);
  return getStripeClient().checkout.sessions.create({
    mode: "payment",
    customer_email: booking.customer_email,
    line_items: [{ price_data: { currency: "eur", product_data: { name: booking.service_name }, unit_amount: booking.price_cents }, quantity: 1 }],
    metadata: { appointment_id: booking.id, booking_reference: booking.reference },
    success_url: `${origin}/book/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/book?payment=cancelled`,
    expires_at: expiresAt,
    integration_identifier: "allstar_web_kqmrstuv",
  }, { idempotencyKey: `booking-checkout/${booking.id}/${expiresAt}` });
}

/** Stripe answered with a client error (4xx): no session was created. Any
 * other failure (no response, timeout, Stripe server error) may have created
 * one, which a retry recovers under the same idempotency key. So may an
 * idempotency or concurrency conflict: Stripe answers 409 while another
 * request with the same key is still executing, and 429 (including
 * lock_timeout) when the request should be retried; that other request can
 * still create the session, so the hold is kept for it. */
function checkoutOutcomeUncertain(error: unknown) {
  const failure = error as { statusCode?: unknown; type?: unknown; rawType?: unknown; code?: unknown } | null;
  const status = failure?.statusCode;
  if (status === 409 || status === 429) return true;
  if (failure?.type === "StripeIdempotencyError" || failure?.rawType === "idempotency_error" || failure?.code === "lock_timeout") return true;
  return !(typeof status === "number" && status >= 400 && status < 500);
}

/** Store a created Checkout Session on its hold and return the URL to send the
 * customer to. Concurrent retries can create two sessions (one under the old
 * hold expiry, one under the renewed one); only the stored one is matched by
 * payment confirmation, so a request that loses the store returns the stored
 * session and expires its own, which nobody has seen. */
async function storeCheckout(database: D1Database, id: string, session: { id: string; url: string }) {
  const stored = await database.prepare("UPDATE appointments SET stripe_checkout_session_id = ? WHERE id = ? AND stripe_checkout_session_id IS NULL")
    .bind(session.id, id).run();
  if (stored.meta.changes === 1) return session.url;
  const current = await database.prepare("SELECT stripe_checkout_session_id FROM appointments WHERE id = ?").bind(id)
    .first<{ stripe_checkout_session_id: string | null }>();
  if (!current?.stripe_checkout_session_id) throw new BooklyUnavailable("The payment is being prepared. Retry this same form in a moment.");
  if (current.stripe_checkout_session_id === session.id) return session.url;
  try { await getStripeClient().checkout.sessions.expire(session.id); }
  catch (error) { console.error("Unstored Checkout Session could not be expired", error); }
  return (await getStripeClient().checkout.sessions.retrieve(current.stripe_checkout_session_id)).url ?? null;
}

/** Stripe requires a Checkout Session to stay open at least 30 minutes. */
const CHECKOUT_MIN_OPEN_MS = 30 * 60_000 + 15_000;

/** Resume payment for a retried request whose hold has no Checkout Session
 * yet (interrupted before or after Checkout creation). Returns the Checkout
 * URL, or null when the hold is no longer payable. */
async function resumeCheckout(database: D1Database, id: string, origin: string, holdMinutes: number): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const booking = await database.prepare("SELECT * FROM appointments WHERE id = ?").bind(id).first<HeldBooking>();
    if (!booking || booking.status !== "payment_pending" || booking.payment_method !== "stripe" || !booking.payment_expires_at) return null;
    if (booking.stripe_checkout_session_id) {
      const session = await getStripeClient().checkout.sessions.retrieve(booking.stripe_checkout_session_id);
      return session.url ?? null;
    }
    const now = Date.now();
    const expiresAt = new Date(booking.payment_expires_at).getTime();
    if (expiresAt <= now) return null;
    if (expiresAt - now < CHECKOUT_MIN_OPEN_MS) {
      // Renew the hold once so Stripe accepts the session. Concurrent retries
      // race on the old expiry; the loser re-reads and uses the winner's.
      const renewed = new Date(now + (holdMinutes + 1) * 60_000).toISOString();
      const claimed = await database.prepare(`UPDATE appointments SET payment_expires_at = ? WHERE id = ? AND status = 'payment_pending'
        AND stripe_checkout_session_id IS NULL AND payment_expires_at = ?`).bind(renewed, id, booking.payment_expires_at).run();
      if (claimed.meta.changes !== 1) continue;
      booking.payment_expires_at = renewed;
    }
    const session = await checkoutFor(booking, origin);
    if (!session.url) throw new Error("Stripe did not return a checkout URL.");
    return await storeCheckout(database, id, { id: session.id, url: session.url });
  }
  throw new BooklyUnavailable("The payment is being prepared. Retry this same form in a moment.");
}

export async function POST(request: Request) {
  let reserved = false;
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

    if (!service || !dateIsValid(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return Response.json({ error: "Choose a valid service, date and time." }, { status: 400 });
    }
    // Owner decision D06: every bookable service is one Bookly service, and
    // Bookly has no add-ons, so a colour add-on request is refused rather
    // than priced or silently dropped.
    if (payload.colourAddOn === true) {
      return Response.json({ error: "Choose a service that includes colour." }, { status: 400 });
    }
    const today = getTodayInEindhoven();
    if (date < today) {
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
    const requestId = payload.requestId ?? null;
    if (booklyEnabled() && (!requestId || !/^[a-f0-9-]{36}$/.test(requestId))) {
      return Response.json({ error: "Refresh the booking page before continuing." }, { status: 400 });
    }
    // Imported Bookly occupancy must be current; the live check below and the
    // pushed command then close the remaining window.
    await assertBooklyFresh(database);
    if (requestId) {
      const previous = await database.prepare("SELECT * FROM appointments WHERE booking_request_id = ?").bind(requestId)
        .first<{ id: string; reference: string; service_id: string; customer_email: string; customer_name: string; payment_method: string; payment_status: string; customer_account_id: string | null; appointment_date: string; start_time: string; service_name: string; end_time: string; duration_minutes: number; price_cents: number; status: string; stripe_checkout_session_id: string | null }>();
      if (previous) {
        reserved = true;
        // Deliver a command left pending by an interrupted attempt. A Bookly
        // rejection cancels the unpaid hold and surfaces as BooklyConflict.
        await pushBooklyChanges(database, [previous.id]);
        if (previous.service_id !== service.id || previous.customer_email !== email || previous.appointment_date !== date || previous.start_time !== time) {
          return Response.json({ error: "This booking request was already used. Refresh before starting a different booking." }, { status: 409 });
        }
        if (previous.status === "payment_pending" && previous.payment_method === "stripe") {
          // Resume an interrupted request: the same hold gets its Checkout
          // Session, created once even when the retry repeats or races.
          const { settings: holdSettings } = await readBookingSettings(database);
          const checkoutUrl = await resumeCheckout(database, previous.id, new URL(request.url).origin, holdSettings.paymentHoldMinutes);
          if (checkoutUrl) return Response.json({ checkoutUrl });
        }
        if (previous.status !== "confirmed") return Response.json({ error: "This request is saved but still needs staff review. Do not create a second booking." }, { status: 409 });
        const { settings: retrySettings } = await readBookingSettings(database);
        let confirmationEmailSent = false;
        try { confirmationEmailSent = await sendBookingConfirmation({
          appointmentId: previous.id, reference: previous.reference, customerName: previous.customer_name, customerEmail: previous.customer_email,
          serviceName: previous.service_name, date: previous.appointment_date, time: previous.start_time, endTime: previous.end_time,
          priceCents: previous.price_cents, paymentMethod: previous.payment_status === "paid" ? "Paid online" : "Pay at the shop", loyaltyRewardPoints: retrySettings.loyaltyRewardPoints,
        }); } catch { /* Same provider idempotency key makes retries safe. */ }
        const retryCustomer = previous.customer_account_id ? await database.prepare("SELECT loyalty_points FROM customer_accounts WHERE id=?").bind(previous.customer_account_id).first<{ loyalty_points: number }>() : null;
        return Response.json({ confirmationEmailSent, booking: {
          reference: previous.reference, serviceName: previous.service_name, date: previous.appointment_date, time: previous.start_time,
          endTime: previous.end_time, durationMinutes: previous.duration_minutes, priceCents: previous.price_cents,
          paymentMethod: previous.payment_status === "paid" ? "Paid online" : "Pay at the shop", loyalty: { currentPoints: retryCustomer?.loyalty_points ?? 0, rewardAt: retrySettings.loyaltyRewardPoints, pendingPoint: 1 },
        } });
      }
    }
    const { settings } = await readBookingSettings(database);
    const maximumDate = new Date(`${today}T12:00:00Z`);
    maximumDate.setUTCDate(maximumDate.getUTCDate() + settings.bookingWindowDays);
    if (date > maximumDate.toISOString().slice(0, 10)) {
      return Response.json(
        { error: `Bookings are available up to ${settings.bookingWindowDays} days ahead.` },
        { status: 400 },
      );
    }
    await releaseExpiredPaymentReservations(database);
    const durationMinutes = service.durationMinutes;
    const priceCents = service.priceCents;
    const serviceName = service.name;
    const occupiedRows = await database
      .prepare(
        "SELECT slot_start FROM (SELECT slot_start FROM appointment_slots UNION ALL SELECT slot_start FROM bookly_occupied_slots UNION ALL SELECT slot_start FROM time_off_slots) WHERE slot_start >= ? AND slot_start < ?",
      )
      .bind(`${date}T00:00`, `${date}T23:59`)
      .all<{ slot_start: string }>();
    const occupied = new Set(occupiedRows.results.map((row) => row.slot_start));
    const availableTimes = buildAvailableTimes(
      date,
      durationMinutes,
      occupied,
      settings.handlingBufferMinutes,
      settings.onlineLeadMinutes,
      new Date(),
      settings,
    );
    const checked = await filterBooklyTimes(service.id, durationMinutes + settings.handlingBufferMinutes, [{ date, times: availableTimes }]);
    if (!checked[0].times.includes(time)) {
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
      paymentMethod === "stripe"
        ? new Date(Date.now() + (settings.paymentHoldMinutes + 1) * 60 * 1000).toISOString()
        : null;
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
            customer_account_id, handling_minutes, booking_request_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          settings.handlingBufferMinutes,
          requestId,
        ),
      ...makeSlotKeys(date, time, durationMinutes + settings.handlingBufferMinutes).map((slot) =>
        database
          .prepare("INSERT INTO appointment_slots (slot_start, appointment_id) VALUES (?, ?)")
          .bind(slot, appointmentId),
      ),
    ];

    await database.batch(statements);
    reserved = true;
    // Write the hold to Bookly before checkout or confirmation. Bookly rejects a
    // slot taken there since the last snapshot; the hold is then cancelled.
    await pushBooklyChanges(database, [appointmentId]);

    if (paymentMethod === "stripe") {
      let session;
      let failure: unknown = null;
      try {
        session = await checkoutFor({ id: appointmentId, reference, customer_email: email, service_name: serviceName, price_cents: priceCents,
          status, payment_method: storedPaymentMethod, payment_expires_at: paymentExpiresAt, stripe_checkout_session_id: null }, new URL(request.url).origin);
      } catch (error) {
        failure = error;
        // Stripe may have created the session: keep the hold so retrying this
        // same request recovers it under the same idempotency key. Unrecovered,
        // the hold expires like any unpaid one.
        if (requestId && checkoutOutcomeUncertain(error)) {
          console.error("Stripe Checkout creation outcome unknown", error);
          return Response.json({ error: "The payment page could not open. Your request is retained; retry this same form." }, { status: 503 });
        }
      }
      if (!session?.url) {
        await database.batch([
          database.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(appointmentId),
          database.prepare("UPDATE appointments SET status='payment_expired',payment_status='expired' WHERE id=?").bind(appointmentId),
        ]);
        try { await pushBooklyChanges(database, [appointmentId]); } catch { /* Persistent retry retains the cancellation. */ }
        if (session) {
          try { await getStripeClient().checkout.sessions.expire(session.id); } catch { /* It expires with the hold. */ }
        }
        console.error("Stripe Checkout creation failed", failure ?? "no checkout URL");
        return Response.json(
          { error: "Online checkout could not start. Choose cash or try again." },
          { status: 503 },
        );
      }
      // Stored separately: if this write fails, retrying the same request
      // recovers this session (same idempotency key) and keeps the hold.
      let checkoutUrl;
      try { checkoutUrl = await storeCheckout(database, appointmentId, { id: session.id, url: session.url }); }
      catch (error) {
        console.error("Checkout Session could not be stored", error);
        return Response.json({ error: "The payment page could not open. Your request is retained; retry this same form." }, { status: 503 });
      }
      if (!checkoutUrl) return Response.json({ error: "The payment page could not open. Your request is retained; retry this same form." }, { status: 503 });
      return Response.json({ checkoutUrl }, { status: 201 });
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
        loyaltyRewardPoints: settings.loyaltyRewardPoints,
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
            rewardAt: settings.loyaltyRewardPoints,
            pendingPoint: 1,
          },
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof BooklyConflict) return Response.json({ error: "That time was just booked. Please choose another time." }, { status: 409 });
    if (error instanceof BooklyUnavailable) {
      return Response.json({ error: reserved
        ? "The calendar connection was interrupted. Your request is retained; retry this same form before starting another booking."
        : "Online booking is temporarily unavailable. Please try again shortly." }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE") || message.includes("constraint") || message.includes("Slot unavailable")) {
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
