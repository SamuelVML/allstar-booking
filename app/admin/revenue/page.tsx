import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getStaffUser } from "@/lib/staff-auth";
import { dateIsValid, formatPrice, getTodayInEindhoven } from "@/lib/booking";
import { readRange } from "@/lib/backstage-data";
import { TONE_COLOR } from "@/lib/backstage-view";
import { isPeriod, type Period, periodRange, summarise } from "@/lib/backstage-reporting";

export const dynamic = "force-dynamic";

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; date?: string }>;
}) {
  const user = await getStaffUser(await headers());
  if (!user) notFound();

  const params = await searchParams;
  const today = getTodayInEindhoven();
  const date = params.date && dateIsValid(params.date) ? params.date : today;
  const period: Period = isPeriod(params.period) ? params.period : "day";

  const { from, to } = periodRange(period, date);
  const { appointments } = await readRange(from, to);
  const summary = summarise(period, date, appointments);

  const rangeLabel =
    period === "day"
      ? new Intl.DateTimeFormat("en-GB", {
          timeZone: "UTC",
          weekday: "long",
          day: "numeric",
          month: "long",
        }).format(new Date(`${date}T12:00:00Z`))
      : period === "week"
        ? `Week of ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${from}T12:00:00Z`))} – ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${to}T12:00:00Z`))}`
        : new Intl.DateTimeFormat("en-GB", {
            timeZone: "UTC",
            month: "long",
            year: "numeric",
          }).format(new Date(`${from}T12:00:00Z`));

  const peak = Math.max(1, ...summary.bars.map((bar) => bar.cents));
  const columns = `repeat(${Math.max(summary.bars.length, 1)}, 1fr)`;

  return (
    <>
      <header className="bs-head">
        <div className="bs-head-row">
          <h1 className="display display-m">Revenue</h1>
          <div className="seg" role="tablist" aria-label="Period">
            {PERIODS.map((option) => (
              <a
                key={option.id}
                role="tab"
                aria-selected={period === option.id}
                href={`/admin/revenue?period=${option.id}&date=${date}`}
              >
                {option.label}
              </a>
            ))}
          </div>
        </div>
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
          {rangeLabel}
        </p>
      </header>

      <div className="bs-inner">
        <div className="money-pair">
          <div>
            <span className="eyebrow eyebrow-s">Recorded payments</span>
            <b>{formatPrice(summary.recordedCents)}</b>
            <span className="note note-received">Money actually received</span>
          </div>
          <div className="booked">
            <span className="eyebrow eyebrow-s">Booked value</span>
            <b>{formatPrice(summary.bookedCents)}</b>
            <span className="note note-booked">Confirmed + completed. Not revenue.</span>
          </div>
        </div>

        {summary.bars.length > 0 && (
          <div style={{ padding: "18px 0 6px" }}>
            <span className="eyebrow eyebrow-s">
              Recorded per {summary.barGrouping === "week" ? "week" : "day"}
            </span>
            <div className="chart" style={{ gridTemplateColumns: columns }}>
              {summary.bars.map((bar) => (
                <div
                  key={bar.from}
                  className={`chart-col${bar.from === date ? " is-current" : ""}`}
                >
                  <span>{bar.cents ? formatPrice(bar.cents).replace(",00", "") : ""}</span>
                  <i style={{ height: `${Math.round((bar.cents / peak) * 100)}%` }} />
                </div>
              ))}
            </div>
            <div className="chart-labels" style={{ gridTemplateColumns: columns }}>
              {summary.bars.map((bar) => (
                <span key={bar.from} className={bar.from === date ? "is-current" : undefined}>
                  {bar.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <h2 className="display display-s" style={{ margin: "22px 0 4px" }}>
          Breakdown
        </h2>
        <dl style={{ margin: 0 }}>
          {summary.buckets.map((bucket) => (
            <div
              className={`breakdown-row${bucket.tone === "paid" ? " is-received" : ""}`}
              key={bucket.key}
            >
              <dt>
                <span className="label">
                  <i style={{ background: TONE_COLOR[bucket.tone] }} />
                  {bucket.label}
                </span>
                <span className="sub">{bucket.detail}</span>
              </dt>
              <dd style={{ color: bucket.tone === "paid" ? "var(--ink)" : TONE_COLOR[bucket.tone] }}>
                {formatPrice(bucket.cents)}
              </dd>
            </div>
          ))}
        </dl>

        <p className="muted pretty" style={{ margin: "16px 0 0", fontSize: 12 }}>
          Totals follow appointment dates, not the day money changed hands. Refunded Stripe
          payments are removed from recorded payments automatically.
        </p>
      </div>
    </>
  );
}
