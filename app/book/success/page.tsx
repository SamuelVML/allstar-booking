"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, LoaderCircle } from "lucide-react";
import { formatPrice } from "@/lib/booking";

type PaidBooking = {
  reference: string;
  serviceName: string;
  date: string;
  time: string;
  endTime: string;
  priceCents: number;
  paymentStatus: string;
};

export default function PaymentSuccessPage() {
  const [booking, setBooking] = useState<PaidBooking | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id") ?? "";
    fetch(`/api/stripe/session?session_id=${encodeURIComponent(sessionId)}`)
      .then(async (response) => {
        const result = (await response.json()) as { booking?: PaidBooking; error?: string };
        if (!response.ok || !result.booking) throw new Error(result.error ?? "Confirmation failed.");
        setBooking(result.booking);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Confirmation failed."));
  }, []);

  return (
    <main className="booking-page">
      <header className="booking-header">
        <Link className="brand" href="/"><span>ALL STAR</span><small>BARBERSHOP</small></Link>
        <Link className="booking-back" href="/">Back to website</Link>
      </header>
      <section className="booking-confirmation" aria-live="polite">
        {!booking && !error && <><span className="confirmation-icon"><LoaderCircle className="spin" /></span><h2>Confirming payment…</h2></>}
        {error && <><p className="booking-error">{error}</p><p>Your payment may still be processing. Keep your Stripe receipt and contact All Star if needed.</p></>}
        {booking && <>
          <span className="confirmation-icon"><Check aria-hidden="true" /></span>
          <p className="booking-kicker">Payment received · Booking confirmed</p>
          <h2>See you at All Star.</h2>
          <dl>
            <div><dt>Reference</dt><dd>{booking.reference}</dd></div>
            <div><dt>Service</dt><dd>{booking.serviceName}</dd></div>
            <div><dt>Date</dt><dd>{booking.date}</dd></div>
            <div><dt>Time</dt><dd>{booking.time}–{booking.endTime}</dd></div>
            <div><dt>Paid online</dt><dd>{formatPrice(booking.priceCents)}</dd></div>
          </dl>
          <div className="button-row"><a className="button" href="https://wa.me/31686357350">WhatsApp All Star</a><Link className="button button-outline-dark" href="/">Back to website</Link></div>
        </>}
      </section>
    </main>
  );
}
