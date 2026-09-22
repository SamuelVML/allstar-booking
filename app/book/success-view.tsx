"use client";

import Link from "next/link";
import { formatPrice } from "@/lib/booking";
import { COPY, type Language, locale } from "@/lib/i18n";
import { Check, StarMark } from "@/lib/icons";

const PHONE = "+31686357350";
const LOCATION = "All Star Barbershop, Bakkerstraat 48, 5612 EP Eindhoven";

export type Booking = {
  reference: string;
  serviceName: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
  endTime: string;
  durationMinutes: number;
  priceCents: number;
  /** "stripe" means the customer already paid online. */
  paymentMethod: string;
  email?: string;
};

function icsTimestamp(date: string, time: string) {
  // Europe/Amsterdam local time, written as a floating local value so the
  // calendar shows the same clock time the shop works to.
  return `${date.replaceAll("-", "")}T${time.replace(":", "")}00`;
}

function escapeIcs(value: string) {
  return value.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}

function downloadCalendarFile(booking: Booking) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//All Star Barbershop//Booking//EN",
    "BEGIN:VEVENT",
    `UID:${booking.reference}@all-star-barbershop.com`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART;TZID=Europe/Amsterdam:${icsTimestamp(booking.date, booking.time)}`,
    `DTEND;TZID=Europe/Amsterdam:${icsTimestamp(booking.date, booking.endTime)}`,
    `SUMMARY:${escapeIcs(`All Star — ${booking.serviceName}`)}`,
    `LOCATION:${escapeIcs(LOCATION)}`,
    `DESCRIPTION:${escapeIcs(`Booking reference ${booking.reference}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `allstar-${booking.reference}.ics`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export default function SuccessView({
  booking,
  language,
}: {
  booking: Booking;
  language: Language;
}) {
  const t = COPY[language];
  const paidOnline = booking.paymentMethod === "stripe";

  const dateLabel = new Intl.DateTimeFormat(locale(language), {
    timeZone: "Europe/Amsterdam",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${booking.date}T12:00:00Z`));

  const rows = [
    { key: t.service, value: booking.serviceName },
    { key: t.date, value: dateLabel },
    {
      key: t.time,
      value: `${booking.time} – ${booking.endTime} · ${booking.durationMinutes} min`,
    },
    { key: t.total, value: formatPrice(booking.priceCents) },
    { key: t.payment, value: paidOnline ? t.paidOnline : t.paidShop },
    ...(booking.email ? [{ key: t.contact, value: booking.email }] : []),
  ];

  return (
    <div className="site">
      <div className="success-top">
        <div className="success-inner">
          <span className="success-mark">
            <Check />
          </span>
          <p className="kicker kicker-wide kicker-on-dark">
            {paidOnline ? t.successKickerOnline : t.successKickerShop}
          </p>
          <h1 className="display display-l" style={{ marginTop: 10 }}>
            {t.successTitle}
          </h1>
          <p style={{ margin: "16px 0 0", color: "var(--on-dark-muted)", fontSize: 15 }}>
            {t.successBody}
          </p>
        </div>
      </div>

      <div className="success-body">
        <div className="success-inner">
          <div className="success-ref">
            <span className="eyebrow">{t.reference}</span>
            <b>{booking.reference}</b>
          </div>

          <dl className="detail-list">
            {rows.map((row) => (
              <div className="detail-row" key={row.key}>
                <dt>{row.key}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>

          <div className="pair-actions" style={{ marginTop: 20 }}>
            <button
              type="button"
              className="btn btn-outline btn-s"
              onClick={() => downloadCalendarFile(booking)}
            >
              {t.addToCalendar}
            </button>
            <a
              className="btn btn-outline btn-s"
              href={`https://wa.me/${PHONE.replace("+", "")}`}
              target="_blank"
              rel="noreferrer"
            >
              WhatsApp
            </a>
          </div>

          <div className="success-aside">
            <StarMark />
            <div>
              <strong>{t.loyaltyTitleShort}</strong>
              <p className="pretty">{t.loyaltySuccess}</p>
            </div>
          </div>

          <div
            style={{
              marginTop: 18,
              borderTop: "1px solid var(--hairline)",
              paddingTop: 18,
            }}
          >
            <strong style={{ fontSize: 15, fontWeight: 600 }}>{t.changeTitle}</strong>
            <p className="muted pretty" style={{ margin: "3px 0 0", fontSize: 13 }}>
              {t.changeBody}
            </p>
          </div>
        </div>
      </div>

      <div className="sticky-bar">
        <Link className="btn btn-ink btn-block" href="/">
          {t.backToSite}
        </Link>
      </div>
    </div>
  );
}
