import { env } from "cloudflare:workers";
import { formatAppointmentDate, formatPrice, LOYALTY_REWARD_POINTS } from "@/lib/booking";

export type BookingConfirmation = {
  appointmentId: string;
  reference: string;
  customerName: string;
  customerEmail: string;
  serviceName: string;
  date: string;
  time: string;
  endTime: string;
  priceCents: number;
  paymentMethod: "Paid online" | "Pay at the shop";
};

export async function sendBookingConfirmation(booking: BookingConfirmation) {
  // Independent requests: a failure for one recipient must not suppress the other.
  const [customer, admin] = await Promise.allSettled([
    sendCustomerConfirmation(booking),
    sendAdminNotification(booking),
  ]);
  if (admin.status === "rejected") {
    console.error("Admin booking notification failed");
  }
  if (customer.status === "rejected") throw customer.reason;
  return customer.value;
}

async function sendAdminNotification(booking: BookingConfirmation) {
  const to = env.BOOKING_ADMIN_EMAIL?.trim();
  if (!to) return false;
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.BOOKING_EMAIL_FROM?.trim();
  const businessName = env.BOOKING_BUSINESS_NAME?.trim();
  if (!apiKey || !from || !businessName) {
    console.warn("Admin booking notification is not configured.");
    return false;
  }
  const rows = [
    ["Service", booking.serviceName],
    ["Date", `${formatAppointmentDate(booking.date)} (${booking.date})`],
    ["Time", `${booking.time}–${booking.endTime} (Europe/Amsterdam)`],
    ["Customer", booking.customerName],
    ["Email", booking.customerEmail],
    ["Price", formatPrice(booking.priceCents)],
    ["Payment", booking.paymentMethod],
    ["Reference", booking.reference],
  ];
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `booking-admin-notification/${booking.appointmentId}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: booking.customerEmail,
      subject: `New booking · ${booking.date} ${booking.time} · ${booking.serviceName}`,
      text: [`New booking — ${businessName}`, "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n"),
      html: `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#111"><div style="max-width:600px;margin:auto;padding:24px"><div style="background:#070707;color:#fff;padding:24px;border-radius:16px 16px 0 0"><p style="color:#e1262f;font-weight:700">NEW BOOKING</p><h1 style="font-size:24px">${escapeHtml(businessName)}</h1></div><div style="background:#fff;padding:24px;border-radius:0 0 16px 16px"><table style="width:100%;border-collapse:collapse">${rows.map(([label, value]) => `<tr><td style="padding:10px 0;color:#666;vertical-align:top">${escapeHtml(label)}</td><td style="padding:10px 0;text-align:right;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`).join("")}</table></div></div></body></html>`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Resend rejected admin notification (${response.status})`);
  }
  return true;
}

async function sendCustomerConfirmation(booking: BookingConfirmation) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.BOOKING_EMAIL_FROM?.trim();
  const businessName = env.BOOKING_BUSINESS_NAME?.trim();
  if (!apiKey || !from || !businessName) {
    console.warn("Booking confirmation email is not configured.");
    return false;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `booking-confirmation/${booking.appointmentId}`,
    },
    body: JSON.stringify({
      from,
      to: [booking.customerEmail],
      ...(env.BOOKING_EMAIL_REPLY_TO?.trim()
        ? { reply_to: env.BOOKING_EMAIL_REPLY_TO.trim() }
        : {}),
      subject: `Booking confirmed · ${booking.reference}`,
      html: bookingConfirmationHtml(businessName, booking),
      text: bookingConfirmationText(businessName, booking),
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Resend rejected booking confirmation (${response.status}): ${detail}`);
  }
  return true;
}

function bookingConfirmationHtml(businessName: string, booking: BookingConfirmation) {
  const safe = Object.fromEntries(
    Object.entries(booking).map(([key, value]) => [key, escapeHtml(String(value))]),
  ) as Record<keyof BookingConfirmation, string>;
  const safeBusinessName = escapeHtml(businessName);
  return `<!doctype html>
<html><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#111">
<div style="max-width:600px;margin:0 auto;padding:32px 18px">
<div style="background:#070707;color:#fff;padding:24px;border-radius:16px 16px 0 0">
<div style="color:#e1262f;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase">Booking confirmed</div>
<h1 style="margin:8px 0 0;font-size:28px">See you at ${safeBusinessName}.</h1>
</div>
<div style="background:#fff;padding:24px;border-radius:0 0 16px 16px">
<p style="margin-top:0">Hi ${safe.customerName}, your appointment is confirmed.</p>
<table style="width:100%;border-collapse:collapse">
<tr><td style="padding:9px 0;color:#666">Reference</td><td style="padding:9px 0;text-align:right;font-weight:700">${safe.reference}</td></tr>
<tr><td style="padding:9px 0;color:#666">Service</td><td style="padding:9px 0;text-align:right">${safe.serviceName}</td></tr>
<tr><td style="padding:9px 0;color:#666">Date</td><td style="padding:9px 0;text-align:right">${escapeHtml(formatAppointmentDate(booking.date))}</td></tr>
<tr><td style="padding:9px 0;color:#666">Time</td><td style="padding:9px 0;text-align:right">${safe.time}–${safe.endTime}</td></tr>
<tr><td style="padding:9px 0;color:#666">Price</td><td style="padding:9px 0;text-align:right">${escapeHtml(formatPrice(booking.priceCents))}</td></tr>
<tr><td style="padding:9px 0;color:#666">Payment</td><td style="padding:9px 0;text-align:right">${safe.paymentMethod}</td></tr>
</table>
<p style="margin:24px 0 0;padding:16px;background:#f5f5f5;border-radius:10px">Complete your visit to earn one loyalty point. Your reward is unlocked at ${LOYALTY_REWARD_POINTS} points.</p>
</div></div></body></html>`;
}

function bookingConfirmationText(businessName: string, booking: BookingConfirmation) {
  return [
    `Booking confirmed — ${businessName}`,
    "",
    `Hi ${booking.customerName}, your appointment is confirmed.`,
    `Reference: ${booking.reference}`,
    `Service: ${booking.serviceName}`,
    `Date: ${formatAppointmentDate(booking.date)}`,
    `Time: ${booking.time}–${booking.endTime}`,
    `Price: ${formatPrice(booking.priceCents)}`,
    `Payment: ${booking.paymentMethod}`,
    "",
    `Complete your visit to earn one loyalty point. Your reward is unlocked at ${LOYALTY_REWARD_POINTS} points.`,
  ].join("\n");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
