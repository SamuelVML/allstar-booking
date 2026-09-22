"use client";

import { useState } from "react";
import Link from "next/link";
import {
  formatPrice,
  type BookingSettings,
  SERVICES,
} from "@/lib/booking";
import { COPY, type Language, serviceLabel } from "@/lib/i18n";
import { ArrowRight, StarMark } from "@/lib/icons";

const ADDRESS_QUERY = "Bakkerstraat+48+5612+EP+Eindhoven";
const PHONE = "+31686357350";
const WHATSAPP_LAUNCH_URL =
  "https://wa.me/31686357350?text=Hi%20All%20Star%2C%20I%27m%20interested%20in%20the%20Mobile%20Barber.";

/** Monday-first, matching how the shop reads its own week. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function SiteHome({
  initialLanguage,
  todayWeekday,
  bookingSettings,
}: {
  initialLanguage: Language;
  /** Resolved on the server in Europe/Amsterdam so "today" matches the shop. */
  todayWeekday: number;
  bookingSettings: BookingSettings;
}) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const t = COPY[language];
  const bookable = SERVICES.filter((service) => !service.isAddOn);

  function bookHref(serviceId?: string) {
    const params = new URLSearchParams();
    if (serviceId) params.set("service", serviceId);
    if (language !== "en") params.set("lang", language);
    const query = params.toString();
    return query ? `/book?${query}` : "/book";
  }

  return (
    <div className="site">
      <a className="skip-link" href="#services">
        {language === "nl" ? "Ga naar diensten" : "Skip to services"}
      </a>

      <header className="site-top">
        <span className="brand">
          <StarMark />
          <span className="brand-name">
            <b>ALL STAR</b>
            <span>BARBERSHOP · EINDHOVEN</span>
          </span>
        </span>
        <button
          type="button"
          className="lang-toggle"
          onClick={() => setLanguage(language === "en" ? "nl" : "en")}
          aria-label={t.langSwitchLabel}
        >
          {t.langToggle}
        </button>
      </header>

      <section className="hero">
        <img
          src="/hero-barber.webp"
          alt={
            language === "nl"
              ? "Barbier werkt een precieze fade af bij All Star"
              : "Barber finishing a precision fade at All Star"
          }
        />
        <div className="hero-copy">
          <p className="kicker kicker-wide kicker-on-dark">{t.heroKicker}</p>
          <h1 className="display display-xl" style={{ marginTop: 14 }}>
            {t.heroTitle}
          </h1>
          <p className="lead pretty">{t.heroBody}</p>
        </div>
      </section>

      <section className="section" id="services">
        <div className="section-head">
          <h2 className="display display-m">{t.servicesTitle}</h2>
          <span className="eyebrow" style={{ paddingBottom: 4 }}>
            {t.servicesHint}
          </span>
        </div>
        <div>
          {bookable.map((service, index) => (
            <Link
              key={service.id}
              href={bookHref(service.id)}
              className="service-row"
            >
              <span className="service-no">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="service-name">
                <strong>{serviceLabel(service.id, service.name, language)}</strong>
                <small>{service.durationMinutes} min</small>
              </span>
              <b>{formatPrice(service.priceCents)}</b>
            </Link>
          ))}
        </div>
        <p className="muted" style={{ margin: "14px 0 0", fontSize: 13 }}>
          {t.addOnNote}
        </p>
      </section>

      <section className="section section-tight">
        <h2 className="display display-m" style={{ marginBottom: 18 }}>
          {t.howTitle}
        </h2>
        <ol className="steps">
          {t.howSteps.map((step, index) => (
            <li key={step.title}>
              <span className="step-no">{index + 1}</span>
              <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <strong>{step.title}</strong>
                <span className="body pretty">
                  {index === 0
                    ? language === "nl"
                      ? `Alleen vrije tijden worden getoond. Boek tot ${bookingSettings.bookingWindowDays} dagen vooruit.`
                      : `Only free times are shown. Book up to ${bookingSettings.bookingWindowDays} days ahead.`
                    : step.body}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="section section-tight" id="mobile">
        <div className="feature">
          <figure>
            <img
              src="/mobile-barber.webp"
              alt={
                language === "nl"
                  ? "Conceptbeeld van een premium mobiele barbershopbus"
                  : "Concept of a premium mobile barbershop van"
              }
            />
            <figcaption>Mobile Barber</figcaption>
          </figure>
          <div className="feature-copy">
            <p className="kicker">{t.mobileKicker}</p>
            <h2 className="display display-m" style={{ marginTop: 12 }}>
              {t.mobileTitle}
            </h2>
            <p className="body pretty">{t.mobileBody}</p>
            <div className="modes">
              {t.mobileModes.map((mode) => (
                <span key={mode}>{mode}</span>
              ))}
            </div>
            <a className="btn btn-outline" href={WHATSAPP_LAUNCH_URL}>
              {t.mobileCta}
              <ArrowRight />
            </a>
          </div>
        </div>
      </section>

      <section className="section section-tight" id="academy">
        <div className="feature">
          <figure>
            <img
              src="/academy-training.webp"
              alt={
                language === "nl"
                  ? "Instructeur demonstreert een fade-techniek aan studenten"
                  : "Barber instructor demonstrating a fade technique to students"
              }
            />
            <figcaption>Academy</figcaption>
          </figure>
          <div className="feature-copy">
            <p className="kicker">{t.academyKicker}</p>
            <h2 className="display display-m" style={{ marginTop: 12 }}>
              {t.academyTitle}
            </h2>
            <p className="body pretty">{t.academyBody}</p>
            <div className="programmes">
              {t.programmes.map((programme) => (
                <span key={programme}>{programme}</span>
              ))}
            </div>
            <a
              className="btn btn-outline"
              href="https://all-star-barbershop.com/academy/"
              target="_blank"
              rel="noreferrer"
            >
              {t.academyCta}
              <ArrowRight />
            </a>
          </div>
        </div>
      </section>

      <section className="section section-dark">
        <p className="kicker kicker-wide kicker-on-dark">{t.visitKicker}</p>
        <h2 className="display display-m" style={{ marginTop: 12 }}>
          Bakkerstraat 48
        </h2>
        <p style={{ margin: "8px 0 22px", color: "var(--on-dark-muted)", fontSize: 15 }}>
          5612 EP Eindhoven
        </p>
        <dl className="hours">
          {WEEK_ORDER.map((weekday) => {
            const hours = bookingSettings.openingHours[weekday];
            const isToday = weekday === todayWeekday;
            return (
              <div key={weekday} style={{ display: "contents" }}>
                <dt className={isToday ? "is-today" : undefined}>
                  {t.days[(weekday + 6) % 7]}
                </dt>
                <dd className={isToday ? "is-today" : undefined}>
                  {hours ? `${hours.start} – ${hours.end}` : t.closedWord}
                </dd>
              </div>
            );
          })}
        </dl>
        <div className="contact-actions">
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${ADDRESS_QUERY}`}
            target="_blank"
            rel="noreferrer"
          >
            {t.directions}
          </a>
          <a href={`tel:${PHONE}`}>{t.call}</a>
          <a href={`https://wa.me/${PHONE.replace("+", "")}`} target="_blank" rel="noreferrer">
            WhatsApp
          </a>
        </div>
      </section>

      <section className="loyalty-note">
        <StarMark />
        <div>
          <strong>{t.loyaltyTitle}</strong>
          <p className="pretty">{t.loyaltyBody}</p>
        </div>
      </section>

      <footer className="site-footer">
        <span>© All Star Barbershop</span>
        <span>{t.footerTag}</span>
      </footer>

      <div className="sticky-bar">
        <Link className="btn btn-primary btn-block" href={bookHref()}>
          {t.bookCta}
          <ArrowRight />
        </Link>
      </div>
    </div>
  );
}
