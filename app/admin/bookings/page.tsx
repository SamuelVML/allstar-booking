import { env } from "cloudflare:workers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getD1 } from "@/db";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { formatPrice } from "@/lib/booking";
import CompleteButton from "./complete-button";

export const dynamic = "force-dynamic";

type BookingRow = {
  reference: string;
  service_name: string;
  price_cents: number;
  appointment_date: string;
  start_time: string;
  end_time: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  notes: string;
  status: string;
  payment_method: string;
  payment_status: string;
};

export default async function BookingAdminPage() {
  const user = await requireChatGPTUser("/admin/bookings");
  const allowed = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(user.email.toLowerCase())) notFound();

  const rows = await getD1()
    .prepare(
      `SELECT reference, service_name, price_cents, appointment_date, start_time,
        end_time, customer_name, customer_email, customer_phone, notes, status,
        payment_method, payment_status
       FROM appointments
       ORDER BY appointment_date ASC, start_time ASC
       LIMIT 250`,
    )
    .all<BookingRow>();

  return (
    <main className="admin-page">
      <header>
        <div><span className="booking-kicker">Internal</span><h1>Bookings</h1></div>
        <Link className="button button-outline" href="/">Back to website</Link>
      </header>
      <div className="admin-table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Customer</th><th>Service</th><th>Contact</th><th>Total</th><th>Payment</th><th>Status</th><th>Visit</th></tr></thead>
          <tbody>
            {rows.results.map((booking) => (
              <tr key={booking.reference}>
                <td><strong>{booking.appointment_date}</strong><br />{booking.start_time}–{booking.end_time}<br /><small>{booking.reference}</small></td>
                <td><strong>{booking.customer_name}</strong>{booking.notes && <><br /><small>{booking.notes}</small></>}</td>
                <td>{booking.service_name}</td>
                <td><a href={`tel:${booking.customer_phone}`}>{booking.customer_phone}</a><br /><a href={`mailto:${booking.customer_email}`}>{booking.customer_email}</a></td>
                <td>{formatPrice(booking.price_cents)}</td>
                <td><strong>{booking.payment_status.replaceAll("_", " ")}</strong><br /><small>{booking.payment_method === "stripe" ? "Stripe" : "Cash at shop"}</small></td>
                <td><span className={`status status-${booking.status}`}>{booking.status}</span></td>
                <td>{booking.status === "confirmed" ? <CompleteButton reference={booking.reference} /> : booking.status === "completed" ? "Point awarded" : "—"}</td>
              </tr>
            ))}
            {rows.results.length === 0 && <tr><td colSpan={8}>No bookings yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}
