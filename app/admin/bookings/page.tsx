import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getD1 } from "@/db";
import { getStaffUser } from "@/lib/staff-auth";
import { dateIsValid, getTodayInEindhoven, formatPrice } from "@/lib/booking";
import BookingActions from "./booking-actions";
import Operations, { RecordPayment } from "./operations";

export const dynamic = "force-dynamic";

type BookingRow = {
  reference: string;
  source: string;
  customer_account_id: string | null;
  revision: number;
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

export default async function BookingAdminPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await getStaffUser(await headers());
  if (!user) notFound();
  const params = await searchParams;
  const date = params.date && dateIsValid(params.date) ? params.date : getTodayInEindhoven();

  const rows = await getD1()
    .prepare(
      `SELECT reference, revision, source, customer_account_id, service_name, price_cents, appointment_date, start_time,
        end_time, customer_name, customer_email, customer_phone, notes, status,
        payment_method, payment_status
       FROM appointments
       WHERE appointment_date = ?
       ORDER BY start_time ASC
`,
    )
    .bind(date)
    .all<BookingRow>();

  const blocks = await getD1().prepare("SELECT id, start_time, end_time, reason FROM time_off WHERE date = ? AND removed_at IS NULL ORDER BY start_time")
    .bind(date).all<{ id: string; start_time: string; end_time: string; reason: string }>();
  const booked = rows.results.filter(row => ["confirmed", "completed"].includes(row.status)).reduce((sum, row) => sum + row.price_cents, 0);
  const paid = rows.results.filter(row => row.payment_status === "paid").reduce((sum, row) => sum + row.price_cents, 0);
  return (
    <main className="admin-page">
      <header>
        <div><span className="booking-kicker">Backstage</span><h1>Bookings</h1></div>
        <Link className="button button-outline" href="/">Back to website</Link>
      </header>
      <form className="admin-date-filter" method="get">
        <label>Appointments on <input type="date" name="date" defaultValue={date} required /></label>
        <button className="button button-outline" type="submit">Show bookings</button>
        <Link href="/admin/bookings">Today</Link>
      </form>
      <p>Times are local to the shop (Europe/Amsterdam). Completing a visit awards a point; it does not record payment.</p>
      <div className="backstage-totals">
        <div><span>Booked value</span><strong>{formatPrice(booked)}</strong><small>Confirmed and completed visits on {date}</small></div>
        <div><span>Recorded payments</span><strong>{formatPrice(paid)}</strong><small>Payments against appointments on {date}, including paid cancellations. Not daily takings or profit.</small></div>
      </div>
      <Operations date={date} blocks={blocks.results} />
      <div className="admin-table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Customer</th><th>Service</th><th>Contact</th><th>Total</th><th>Payment</th><th>Status</th><th>Manage</th></tr></thead>
          <tbody>
            {rows.results.map((booking) => (
              <tr key={booking.reference}>
                <td><strong>{booking.appointment_date}</strong><br />{booking.start_time}–{booking.end_time}<br /><small>{booking.reference}</small></td>
                <td><strong>{booking.customer_name}</strong>{booking.notes && <><br /><small>{booking.notes}</small></>}</td>
                <td>{booking.service_name}{booking.source === "walk_in" && <><br /><small>Walk-in</small></>}</td>
                <td><a href={`tel:${booking.customer_phone}`}>{booking.customer_phone}</a><br /><a href={`mailto:${booking.customer_email}`}>{booking.customer_email}</a></td>
                <td>{formatPrice(booking.price_cents)}</td>
                <td><strong>{booking.payment_status.replaceAll("_", " ")}</strong><br /><small>{booking.payment_method === "stripe" ? "Stripe" : booking.payment_method === "card" ? "Card at shop" : booking.payment_status === "paid" ? "Cash" : "Pay at shop"}</small></td>
                <td><span className={`status status-${booking.status}`}>{booking.status}</span></td>
                <td>{booking.status === "confirmed" ? <BookingActions reference={booking.reference} revision={booking.revision} date={booking.appointment_date} paid={booking.payment_status === "paid"} loyalty={!!booking.customer_account_id} /> : booking.status === "completed" ? (booking.customer_account_id ? "Visit completed · Point awarded" : "Visit completed") : "—"}{["confirmed", "completed"].includes(booking.status) && booking.payment_status === "due_at_shop" && booking.payment_method !== "stripe" && <RecordPayment reference={booking.reference} revision={booking.revision} amount={booking.price_cents} />}</td>
              </tr>
            ))}
            {rows.results.length === 0 && <tr><td colSpan={8}>No bookings yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}
