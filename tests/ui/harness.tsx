/**
 * Mounts the real Backstage sheets outside Next.js and outside Cloudflare
 * Access, so `tests/ui/run.mjs` can drive them in a browser.
 *
 * WHAT A GREEN RUN DOES NOT MEAN. This exercises the client behaviour of
 * `app/admin/day-actions.tsx` against a stubbed API. It does not cover
 * Cloudflare Access, real D1 data, the same-origin and content-type check in
 * `authoriseStaffMutation` (`lib/staff-auth.ts`), or email delivery. Those are
 * only proven by deploying and signing in.
 *
 * The components, the design system and the request payloads are real. Only
 * `next/navigation`, `next/link` and `fetch` are replaced.
 */

import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import DayActionsProvider, { useDayActions } from "@/app/admin/day-actions";
import SamaritanPanel from "@/app/admin/samaritan-panel";
import type { AdminAppointment, TimeOffBlock } from "@/lib/backstage-view";
import { DEFAULT_BOOKING_SETTINGS } from "@/lib/booking";
import { installFakeApi, type Ranked } from "./fake-api";
import "@/app/globals.css";

/** A Tuesday: open 10:00–19:00, breaks 12:00, 14:30 and 16:45. */
const DATE = "2026-09-22";
const NOW = "11:24";
const REFERENCE = "AS-20260922-A2BB";

/**
 * Ranked highest first, as the server returns it. 13:40 is deliberately off
 * the fifteen-minute grid so the test can prove a picked recommendation is
 * still shown and selected.
 */
const RANKING: Ranked[] = [
  {
    date: DATE,
    time: "13:40",
    score: 300,
    reason:
      "Best fit for a 30-minute haircut. This time fills the space between two appointments without creating unused capacity.",
  },
  {
    date: DATE,
    time: "10:45",
    score: 180,
    reason:
      "Strong fit for a 30-minute haircut. It starts immediately after another appointment and keeps the working day compact.",
  },
  {
    date: DATE,
    time: "16:00",
    score: 0,
    reason: "Best currently available fit for a 30-minute haircut.",
  },
];

/** What the ranking becomes once the day has changed. */
const RANKING_AFTER_MUTATION: Ranked[] = [
  {
    date: DATE,
    time: "15:00",
    score: 180,
    reason: "Strong fit for a 30-minute haircut, re-ranked after the schedule changed.",
  },
];

const APPOINTMENTS: AdminAppointment[] = [
  {
    reference: REFERENCE,
    revision: 0,
    source: "online",
    customer_account_id: "c1",
    service_id: "haircut",
    service_name: "Haircut",
    price_cents: 3500,
    appointment_date: DATE,
    start_time: "11:30",
    end_time: "12:00",
    duration_minutes: 30,
    handling_minutes: 10,
    customer_name: "T. van Dijk",
    customer_email: "t.vandijk@example.com",
    customer_phone: "+31 6 1234 0003",
    notes: "Student card shown last time.",
    status: "confirmed",
    payment_method: "pay_at_shop",
    payment_status: "due_at_shop",
  },
];

const BLOCKS: TimeOffBlock[] = [
  { id: "t1", start_time: "15:30", end_time: "16:30", reason: "Supplier visit" },
];

installFakeApi({
  date: DATE,
  initialRanking: RANKING,
  // The reschedule grid's authority. Includes 13:40, which the grid's own
  // fifteen-minute steps would not produce.
  availableTimes: ["10:45", "13:40", "14:15", "16:00", "16:15"],
  rankingAfterMutation: RANKING_AFTER_MUTATION,
});

/** The two entry points a barber actually has into these sheets. */
function Controls() {
  const { openAdd, openAppointment } = useDayActions();
  return (
    <div style={{ display: "flex", gap: 8, padding: 20 }}>
      <button type="button" id="open-add" className="btn btn-outline btn-s" onClick={openAdd}>
        Add walk-in
      </button>
      <button
        type="button"
        id="open-appointment"
        className="btn btn-outline btn-s"
        onClick={() => openAppointment(REFERENCE)}
      >
        Open appointment
      </button>
    </div>
  );
}

/**
 * A panel that stays mounted, so the `revision` contract can be tested on its
 * own terms. Inside a sheet every mutation closes the sheet and the panel
 * remounts, which would refetch regardless — that hides whether the bump
 * actually works. It asks for a different service so its requests can be
 * counted apart from the sheets'.
 */
function PersistentPanel() {
  const [revision, setRevision] = useState(0);
  return (
    <div id="persistent" style={{ padding: "0 20px 20px" }}>
      <button
        type="button"
        id="bump-revision"
        className="btn btn-outline btn-s"
        onClick={() => setRevision((value) => value + 1)}
      >
        Bump revision
      </button>
      <SamaritanPanel
        serviceId="line-up"
        date={DATE}
        revision={revision}
        onPick={() => {}}
      />
    </div>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("The harness page has no #root element.");

createRoot(container).render(
  <div className="bs">
    <main className="bs-main">
      <DayActionsProvider
        date={DATE}
        today={DATE}
        now={NOW}
        appointments={APPOINTMENTS}
        blocks={BLOCKS}
        settings={DEFAULT_BOOKING_SETTINGS}
      >
        <Controls />
      </DayActionsProvider>
      <PersistentPanel />
    </main>
  </div>,
);
