"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { COPY, type Language } from "@/lib/i18n";
import { ArrowLeft } from "@/lib/icons";
import SuccessView, { type Booking } from "../success-view";

type PaidBooking = {
  reference: string;
  serviceName: string;
  date: string;
  time: string;
  endTime: string;
  priceCents: number;
  paymentStatus: string;
  durationMinutes?: number;
};

const PHONE = "+31686357350";

function minutesBetween(start: string, end: string) {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return endHour * 60 + endMinute - (startHour * 60 + startMinute);
}

export default function PaymentSuccess({
  language,
  loyaltyRewardPoints,
}: {
  language: Language;
  loyaltyRewardPoints: number;
}) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState("");
  const t = COPY[language];

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id") ?? "";
    const controller = new AbortController();
    fetch(`/api/stripe/session?session_id=${encodeURIComponent(sessionId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as { booking?: PaidBooking; error?: string };
        if (!response.ok || !result.booking) {
          throw new Error(result.error ?? "Confirmation failed.");
        }
        const paid = result.booking;
        setBooking({
          reference: paid.reference,
          serviceName: paid.serviceName,
          date: paid.date,
          time: paid.time,
          endTime: paid.endTime,
          durationMinutes: paid.durationMinutes ?? minutesBetween(paid.time, paid.endTime),
          priceCents: paid.priceCents,
          // This page is only reached after Stripe has taken the payment.
          paymentMethod: "stripe",
          loyalty: { rewardAt: loyaltyRewardPoints },
        });
      })
      .catch((reason) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Confirmation failed.");
      });
    return () => controller.abort();
  }, [loyaltyRewardPoints]);

  if (booking) return <SuccessView booking={booking} language={language} />;

  return (
    <div className="flow">
      <header className="flow-head">
        <div className="flow-head-inner">
          <div className="flow-head-row">
            <Link className="flow-back" href="/">
              <ArrowLeft />
              {t.home}
            </Link>
          </div>
        </div>
      </header>
      <div className="flow-body">
        <div className="flow-body-inner" aria-live="polite">
          {!error ? (
            <div className="confirming">
              <span className="spinner spinner-l" aria-hidden="true" />
              <strong>{t.confirming}</strong>
              <span>{t.confirmingHint}</span>
            </div>
          ) : (
            <div className="alert" role="alert">
              <strong>{t.failTitle}</strong>
              <p>{error}</p>
              <p>
                {language === "nl"
                  ? "Je betaling kan nog verwerkt worden. Bewaar je Stripe-bon en neem contact op met All Star als er iets niet klopt."
                  : "Your payment may still be processing. Keep your Stripe receipt and contact All Star if anything looks wrong."}
              </p>
              <div className="alert-actions">
                <a
                  className="btn btn-primary btn-s"
                  href={`https://wa.me/${PHONE.replace("+", "")}`}
                >
                  WhatsApp
                </a>
                <Link className="btn btn-on-dark btn-s" href="/">
                  {t.backToSite}
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
