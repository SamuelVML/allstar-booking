# Samaritan recommendation API

The scheduling engine is shared, but its output is audience-specific.

## Customer availability

`GET /api/availability?service=haircut`

Returns at most two recommendations on different dates. Each recommendation contains only:

- `date`
- `dateLabel`
- `time`

Customer suggestions keep the existing 60-minute lead time. Scores and explanations are intentionally not exposed.

## Backstage recommendations

`GET /api/admin/recommendations?service=haircut`

Optional query parameters:

- `date=YYYY-MM-DD` limits ranking to one day.
- `addOn=colour` includes the colour add-on duration.

The protected response returns at most three ranked recommendations with:

- `date`
- `time`
- `score`
- `reason`

Without a date, Backstage scans the next 14 days. Backstage may recommend the next valid five-minute opening, but never a time in the past.

## Freshness contract

Both endpoints read D1 on every request, release expired Stripe reservations first, return `no-store` cache headers, and include `generatedAt` plus `validUntil`.

The UI should refetch:

1. On initial render.
2. After service, add-on or date changes.
3. After any booking, reschedule, cancellation, walk-in or time-off mutation.
4. When the tab becomes visible or focused.
5. Every 30 seconds in Backstage and every 60 seconds on the customer page.

Final booking and staff mutations must continue to revalidate the chosen slot server-side.

## How the UI consumes this

Scoring is never repeated in the browser. Both surfaces render the server's
order, and Backstage renders its `reason` sentence verbatim.

| | Customer | Backstage |
| --- | --- | --- |
| Endpoint | `/api/availability` | `/api/admin/recommendations` |
| Shown | up to two times, on different dates | up to three ranked times plus the top pick's explanation |
| Interval | 60s | 30s |
| Where | the Samaritan block on the date step | the walk-in and reschedule sheets |

`hooks/use-live-resource.ts` implements the freshness contract for both. It
refetches when the request changes (service, add-on or date), on an interval
while the tab is visible, on `focus` and on `visibilitychange`, and whenever a
caller bumps its `revision`.

`revision` is what covers point 3 of the contract. The customer flow bumps it
after a failed booking attempt — the likeliest cause is that someone else took
the slot. Backstage bumps it after every completion, cancellation, reschedule,
recorded payment, walk-in, block and unblock, so the next ranking is computed
against the day as it now stands.

Interval, focus and visibility refreshes are deliberately silent: the previous
answer stays on screen and a failed background poll does not blank it. Only a
changed request or a bumped revision shows a loading state.

Because the ranking runs at five-minute granularity while the booking grids
step by fifteen, a picked recommendation that falls between grid steps is added
to the grid so the choice stays visible. It is still revalidated server-side on
submission.
