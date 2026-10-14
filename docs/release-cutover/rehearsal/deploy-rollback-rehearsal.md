# Rehearsal: deploy, rollback and roll-forward (2026-10-14)

Worker `allstar-booking-rehearsal` (workers.dev only, no routes), D1
`allstar-booking-rehearsal` at 0000→0010 with synthetic data. No secrets on the
Worker: no Stripe, Resend or Bookly keys; no Cloudflare Access settings, so every
staff route fails closed (403). Production and staging untouched.

| Step | Version | Result |
|---|---|---|
| Deploy candidate `63e4ad7` (`BOOKLY_SYNC_ENABLED=false`, `STRIPE_REQUIRE_TEST_MODE=true`) | `e5b86f83` | Handlers `fetch, scheduled`. `/`, `/book` 200; availability 200 for D06 keys, 400 for retired `beard-trim-shape`; staff APIs 403. Offered times never overlap seeded bookings (checked 2026-10-16/17). |
| Cron | `e5b86f83` | **No scheduled event for ~30 min after deploy** although the deploy listed `schedule: * * * * *`. After `wrangler triggers deploy` it fired every minute (`tail4.txt`). |
| Cron work | `e5b86f83` | Due email obligation retried with backoff (no Resend key → "Email not delivered.", attempt 2, next attempt later). Refund obligation on a still-confirmed synthetic booking completed with no Stripe call, no cancellation, no refund row, slots intact. |
| Roll back to `194dea2` on the 0010 schema | `d9632270` | Handlers `fetch` only; cron removed. `/`, `/book`, availability 200; `/admin` 404 (as production today); staff API 403. Pay-at-shop booking created (201, no email); same slot again refused (409). |
| Roll forward to candidate | `53e5c6f9` | Candidate respects the booking written by `194dea2`: exactly the 15 overlapping start times disappear. |

## Findings for the cutover runbook

1. **Verify the cron fires** after every deploy (`wrangler tail` shows
   `"* * * * *" … Ok` each minute). If not within 5 minutes, run
   `wrangler triggers deploy` with the same config and re-check. Without it,
   refund and email retries and Bookly sync never run.
2. **Rollback reverts D06 prices.** `194dea2` books with its own catalogue
   (Haircut €35 instead of Bookly €33.50). Bookings made on the candidate keep
   their stored price; new bookings after rollback use the old prices.
3. **Rollback removes the cron.** Queued refund/email obligations stay queued
   (old code does not read them) until the candidate is redeployed.
4. Rolling back needs no schema rollback: `194dea2` reads and writes correctly
   on the 0010 schema.
5. One transient Cloudflare `error code: 1042` was seen on two paths in the
   first minute after deploy; it did not reproduce.

Not covered here: Stripe test payments, refunds and webhooks (no test keys),
Bookly bridge (staging WordPress unreachable behind Basic auth), browser and
mobile acceptance, Backstage with Access.
