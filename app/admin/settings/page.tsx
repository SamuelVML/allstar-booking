import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffUser } from "@/lib/staff-auth";
import {
  DAILY_BREAKS,
  HANDLING_BUFFER_MINUTES,
  LOYALTY_REWARD_POINTS,
  OPENING_HOURS,
} from "@/lib/booking";
import { environmentLabel } from "@/lib/backstage-view";
import { stripeIsConfigured } from "@/lib/stripe";

export const dynamic = "force-dynamic";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default async function SettingsPage() {
  const requestHeaders = await headers();
  const user = await getStaffUser(requestHeaders);
  if (!user) notFound();

  const host = requestHeaders.get("host") ?? "";
  const environment = environmentLabel(host);

  return (
    <>
      <header className="bs-head">
        <h1 className="display display-m">Settings</h1>
      </header>

      <div className="bs-inner">
        <div className="setting-row">
          <span>
            <strong>Environment</strong>
            <span className="sub">{host || "unknown host"} · Cloudflare Access</span>
          </span>
          <span className={environment === "Test" ? "badge" : "badge badge-live"}>
            {environment}
          </span>
        </div>

        <div className="setting-row">
          <span>
            <strong>Signed in</strong>
            <span className="sub">{user.email} · via Cloudflare Access</span>
          </span>
          <Link className="btn btn-outline btn-xs" href="/cdn-cgi/access/logout" prefetch={false}>
            Sign out
          </Link>
        </div>

        <div className="setting-row">
          <span>
            <strong>Online payment</strong>
            <span className="sub">
              {stripeIsConfigured()
                ? "Stripe Checkout is available to customers"
                : "Stripe is not configured — customers pay at the shop"}
            </span>
          </span>
        </div>

        <h2 className="display display-s" style={{ margin: "22px 0 4px" }}>
          Opening hours
        </h2>
        <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
          Defined in the booking configuration. Use time off to close ad hoc.
        </p>
        {WEEK_ORDER.map((weekday) => {
          const hours = OPENING_HOURS[weekday];
          const breaks = (DAILY_BREAKS[weekday] ?? [])
            .map((period) => `${period.start}–${period.end}`)
            .join(" · ");
          return (
            <div className="hours-row" key={weekday}>
              <strong>{DAY_NAMES[weekday]}</strong>
              <span className="breaks">{breaks}</span>
              <span className="range">{hours ? `${hours.start} – ${hours.end}` : "Closed"}</span>
            </div>
          );
        })}

        <h2 className="display display-s" style={{ margin: "22px 0 4px" }}>
          Booking rules
        </h2>
        <dl style={{ margin: 0, fontSize: 14 }}>
          <div className="rule-row">
            <dt>Handling buffer</dt>
            <dd>{HANDLING_BUFFER_MINUTES} min after each service</dd>
          </div>
          <div className="rule-row">
            <dt>Online lead time</dt>
            <dd>60 min</dd>
          </div>
          <div className="rule-row">
            <dt>Booking window</dt>
            <dd>60 days</dd>
          </div>
          <div className="rule-row">
            <dt>Online payment hold</dt>
            <dd>30 min</dd>
          </div>
          <div className="rule-row">
            <dt>Loyalty reward</dt>
            <dd>{LOYALTY_REWARD_POINTS} points</dd>
          </div>
        </dl>

        <p className="muted pretty" style={{ margin: "16px 0 0", fontSize: 12 }}>
          These rules live in the booking configuration and apply to every online booking. They
          are shown here for reference and are not editable from Backstage.
        </p>

        <p style={{ margin: "22px 0 0" }}>
          <Link className="btn btn-outline btn-s" href="/">
            Back to the website
          </Link>
        </p>
      </div>
    </>
  );
}
