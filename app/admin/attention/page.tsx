import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getD1 } from "@/db";
import { getStaffUser } from "@/lib/staff-auth";
import { booklyEnabled } from "@/lib/bookly";
import { formatPrice } from "@/lib/booking";
import { MAX_REFUND_ATTEMPTS } from "@/lib/refunds";
import { attentionItems } from "@/lib/staff-attention";
import AttentionActions from "./attention-actions";

export const dynamic = "force-dynamic";

/** Work automatic processing stopped on: unknown or failed customer emails,
 * refunds out of automatic retries and records held between the website and
 * Bookly. Each needs a staff decision. */
export default async function AttentionPage() {
  const user = await getStaffUser(await headers());
  if (!user) notFound();

  const { notifications, refunds, calendar } = await attentionItems(getD1(), MAX_REFUND_ATTEMPTS, !booklyEnabled());
  const empty = notifications.length + refunds.length + calendar.conflicts.length === 0;

  return (
    <>
      <header className="bs-head">
        <h1 className="display display-m">Needs attention</h1>
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
          {empty ? "Nothing is waiting for a decision." : "Automatic retries stopped on these. Each needs your decision."}
        </p>
      </header>

      <div className="bs-inner">
        {notifications.length > 0 && <span className="eyebrow eyebrow-s">Customer emails</span>}
        {notifications.map((item) => (
          <div className="setting-row" key={item.id}>
            <span>
              <strong>
                {item.reference} · {item.customer_name}
              </strong>
              <span className="sub">
                {item.change_action === "reschedule" ? "Reschedule" : "Cancellation"} email to {item.customer_email} ·{" "}
                {item.appointment_date} {item.start_time}
              </span>
              <span className="sub">
                {item.status === "reconcile"
                  ? "Delivery unknown. Ask the customer whether they received it before resending."
                  : "Every delivery attempt failed."}{" "}
                {item.last_error}
              </span>
            </span>
            <AttentionActions kind="notification" id={item.id} reconcile={item.status === "reconcile"} />
          </div>
        ))}

        {refunds.length > 0 && <span className="eyebrow eyebrow-s">Refunds</span>}
        {refunds.map((item) => (
          <div className="setting-row" key={item.appointment_id}>
            <span>
              <strong>
                {item.reference} · {item.customer_name} · {formatPrice(item.amount_cents)}
              </strong>
              <span className="sub">
                Automatic refund stopped after {item.attempts} attempts. {item.error ?? ""}
              </span>
            </span>
            <a className="btn btn-outline btn-xs" href={`/admin/bookings?date=${item.appointment_date}`}>
              Open booking
            </a>
          </div>
        ))}

        {calendar.conflicts.length > 0 && (
          <span className="eyebrow eyebrow-s">
            Bookly calendar{booklyEnabled() ? "" : " · synchronization is off"}
          </span>
        )}
        {calendar.conflicts.map((item) => (
          <div className="setting-row" key={item.local_id}>
            <span>
              <strong>
                {item.reference ? `${item.reference} · ${item.customer_name}` : item.local_id.startsWith("block-") ? "Time off" : item.local_id}
              </strong>
              <span className="sub">
                {item.appointment_date ? `${item.appointment_date} ${item.start_time} · ` : ""}
                {item.reason}
              </span>
              {item.resolution && (
                <span className="sub">
                  You kept the {item.resolution === "local" ? "website" : "Bookly"} version. Waiting for it to reach both calendars.
                </span>
              )}
            </span>
            {!item.resolution && booklyEnabled() && <AttentionActions kind="calendar" id={item.local_id} />}
          </div>
        ))}
      </div>
    </>
  );
}
