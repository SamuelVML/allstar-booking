import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffUser } from "@/lib/staff-auth";
import { formatPrice, LOYALTY_REWARD_POINTS } from "@/lib/booking";
import { readCustomer, searchCustomers } from "@/lib/backstage-data";
import { paymentInfo, TONE_COLOR } from "@/lib/backstage-view";
import { ArrowLeft, StarMark } from "@/lib/icons";
import CustomerSearch from "./search";

export const dynamic = "force-dynamic";

const shortDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T12:00:00Z`));

const fullDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; id?: string }>;
}) {
  const user = await getStaffUser(await headers());
  if (!user) notFound();

  const params = await searchParams;
  const query = (params.q ?? "").slice(0, 100);

  /* ------------------------------------------------------------- detail */

  if (params.id) {
    const record = await readCustomer(params.id);
    if (!record) notFound();
    const { account, visits } = record;

    const completed = visits.filter((visit) => visit.status === "completed");
    const counts = new Map<string, number>();
    for (const visit of completed) {
      counts.set(visit.service_name, (counts.get(visit.service_name) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

    // The account counter and the appointment table can legitimately diverge:
    // visits recorded before appointment history began have no rows here. Say
    // so rather than inventing a preference from thin evidence.
    const enoughEvidence =
      completed.length >= 3 && !!top && top[1] / completed.length >= 0.5;
    const older = Math.max(0, account.completed_visits - completed.length);
    const notes = [...new Set(visits.map((visit) => visit.notes).filter(Boolean))].join(" · ");
    const digits = account.phone.replace(/\D/g, "");

    return (
      <>
        <header className="bs-head bs-head-dark on-dark">
          <Link className="flow-back" href="/admin/customers" style={{ color: "var(--on-dark)" }}>
            <ArrowLeft />
            Customers
          </Link>
          <h1 className="display display-m" style={{ marginTop: 6 }}>
            {account.name}
          </h1>
          <div className="customer-contact">
            <a href={`tel:${account.phone.replace(/\s/g, "")}`}>Call</a>
            <a href={`https://wa.me/${digits}`}>WhatsApp</a>
            <a href={`mailto:${account.email}`}>Email</a>
          </div>
        </header>

        <div className="bs-inner">
          <dl
            className="sheet-dl"
            style={{ margin: 0, borderTop: 0, borderBottom: "1px solid var(--hairline)", padding: "14px 0" }}
          >
            <dt>Email</dt>
            <dd>{account.email}</dd>
            <dt>Phone</dt>
            <dd>{account.phone}</dd>
            <dt>Reminders</dt>
            <dd>
              {account.reminder_opt_in ? "Reminders on" : "Reminders off"}
              {account.marketing_consent ? " · Stay Fresh offers on" : ""}
            </dd>
          </dl>

          <div className="stat-pair">
            <div>
              <span className="eyebrow eyebrow-s">Loyalty points</span>
              <div className="with-unit">
                <b>{account.loyalty_points}</b>
                <span>/ {LOYALTY_REWARD_POINTS}</span>
              </div>
              <div className="pips" aria-hidden="true">
                {Array.from({ length: LOYALTY_REWARD_POINTS }, (_, index) => (
                  <i key={index} className={index < account.loyalty_points ? "on" : undefined} />
                ))}
              </div>
            </div>
            <div>
              <span className="eyebrow eyebrow-s">Completed visits</span>
              <b>{account.completed_visits}</b>
              <small>
                {account.last_visit_at
                  ? `Last visit ${fullDate(account.last_visit_at.slice(0, 10))}`
                  : "No completed visit yet"}
              </small>
            </div>
          </div>

          <div className="stack-row">
            <span className="eyebrow eyebrow-s">Usual service</span>
            {enoughEvidence ? (
              <p>
                {top[0]} — {top[1]} of {completed.length} completed visits
              </p>
            ) : (
              <p className="insufficient">
                Insufficient history — {completed.length} of {account.completed_visits} completed
                visit{account.completed_visits === 1 ? "" : "s"}{" "}
                {completed.length === 1 ? "has" : "have"} booking detail
                {older > 0 ? ` (${older} recorded before appointment history began)` : ""}
              </p>
            )}
          </div>

          {notes && (
            <div className="stack-row">
              <span className="eyebrow eyebrow-s">Notes from bookings</span>
              <p style={{ fontSize: 14 }}>{notes}</p>
            </div>
          )}

          <h2 className="display display-s" style={{ margin: "22px 0 4px" }}>
            History
          </h2>
          {visits.length === 0 ? (
            <p className="muted" style={{ fontSize: 14 }}>
              No appointments recorded for this account yet.
            </p>
          ) : (
            visits.map((visit) => {
              const payment = paymentInfo(visit);
              return (
                <div className="history-row" key={visit.reference}>
                  <span>
                    <strong>
                      {fullDate(visit.appointment_date)} · {visit.start_time}
                    </strong>
                    <span className="svc">{visit.service_name}</span>
                  </span>
                  <span className="right">
                    <b>{formatPrice(visit.price_cents)}</b>
                    <span
                      className="eyebrow eyebrow-s"
                      style={{ color: TONE_COLOR[payment.tone] }}
                    >
                      {visit.status === "cancelled"
                        ? "Cancelled"
                        : visit.status === "completed"
                          ? "Completed"
                          : "Upcoming"}{" "}
                      · {payment.label}
                    </span>
                  </span>
                </div>
              );
            })
          )}
          <p className="muted pretty" style={{ margin: "16px 0 0", fontSize: 12 }}>
            Up to 100 most recent appointments. Walk-ins have no customer account and do not
            appear here.
          </p>
        </div>
      </>
    );
  }

  /* --------------------------------------------------------------- list */

  const customers = await searchCustomers(query);

  return (
    <>
      <header className="bs-head">
        <h1 className="display display-m" style={{ marginBottom: 12 }}>
          Customers
        </h1>
        <CustomerSearch initialQuery={query} />
      </header>

      {customers.length === 0 ? (
        <p className="muted" style={{ margin: "32px var(--gutter)", textAlign: "center" }}>
          No matching customer accounts.
          <br />
          <span style={{ fontSize: 13 }}>Walk-ins have no account.</span>
        </p>
      ) : (
        customers.map((customer) => (
          <Link
            key={customer.id}
            className="customer-row"
            href={`/admin/customers?id=${encodeURIComponent(customer.id)}`}
          >
            <span>
              <strong>{customer.name}</strong>
              <span className="sub">
                {customer.completed_visits} visit
                {customer.completed_visits === 1 ? "" : "s"}
                {customer.last_visit_at
                  ? ` · last ${shortDate(customer.last_visit_at.slice(0, 10))}`
                  : " · no completed visit yet"}
              </span>
            </span>
            <span className="points">
              <StarMark />
              {customer.loyalty_points}
            </span>
          </Link>
        ))
      )}

      <p className="muted" style={{ margin: "16px var(--gutter)", fontSize: 12 }}>
        Up to 100 matches. Customer details stay inside Backstage.
      </p>
    </>
  );
}
