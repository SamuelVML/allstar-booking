import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffUser } from "@/lib/staff-auth";
import { readBookingSettings } from "@/lib/booking-settings";
import { environmentLabel } from "@/lib/backstage-view";
import { stripeIsConfigured } from "@/lib/stripe";
import SettingsForm from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const requestHeaders = await headers();
  const user = await getStaffUser(requestHeaders);
  if (!user) notFound();

  const host = requestHeaders.get("host") ?? "";
  const environment = environmentLabel(host);
  const { settings, revision } = await readBookingSettings();

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

        <SettingsForm initialSettings={settings} initialRevision={revision} />

        <div style={{ margin: "22px 0 0" }}>
          <form action="/" method="get">
            <button className="btn btn-outline btn-s" type="submit">
              Back to the website
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
