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
