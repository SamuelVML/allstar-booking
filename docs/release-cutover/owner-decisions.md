# Approved owner decisions

## D06 — Bookly pricing authority

- Status: approved by the owner
- Date: 2026-10-14
- Scope: website, booking engine and Backstage catalogue. No production change
  is authorised by this decision.

Verbatim:

> OWNER DECISION — D06: BOOKLY PRICING AUTHORITY
>
> Bookly is the authoritative source for All Star service prices and durations.
>
> Reconcile the website, booking engine, and Backstage against the existing Bookly catalogue.
>
> Where website prices differ from Bookly, retain Bookly prices.
>
> Do not modify Bookly's existing prices.
>
> Do not merge distinct services solely because their durations match.
>
> Preserve historical appointment prices.
>
> Add automated tests ensuring consistent prices across the customer booking flow, checkout, and Backstage.
>
> Record this as an approved owner decision in the release documentation.
>
> No production changes authorized.

Implementation: `service-mapping-contract.md` (mapping, behaviour changes and
open items); catalogue source `bookly-catalogue-2026-10-14.json`; regression
`tests/catalogue-consistency.mjs`.

## D07 — WordPress staging (approved 2026-10-14)

Staging already exists at `staging.all-star-barbershop.com` with database
`allstar_bookly_staging` (owner-verified: separate database, Bookly Pro active,
47 Bookly tables on InnoDB, `GET_LOCK`/`RELEASE_LOCK` working,
Europe/Amsterdam, password protection, indexing disabled). No new clone.

Reinspection 2026-10-14 (public, read-only): every path, including `/`,
`/robots.txt`, `/wp-json/`, `/wp-json/allstar-bookly/v1/` and `/wp-login.php`,
returns `401` with HTTP Basic realm "Toegang tot All Star BarberShop" (nginx).
Staging and production resolve to the same host (`116.203.243.109`).

Open: the Basic-auth wall also blocks the Worker→bridge requests (the Worker
signs with HMAC headers and sends no credentials). Notification, payment-gateway
and external-integration isolation inside WordPress could not be verified
without WordPress admin or server access.

## D08 — Rehearsal database (approved 2026-10-14)

Separate D1 `allstar-booking-rehearsal` (`54f0284d-c09f-436f-a2e6-6839aea4f7f7`).
Production's exact migration files 0000–0007 (byte-identical to `194dea2`),
then synthetic data only (`rehearsal/seed.py`, all addresses `@example.invalid`;
70 appointments over 20 past and 20 future days in legacy pre-D06 service keys
and prices, 20 customers, refunds, receipts, changes, one vacation day), then
0008 and 0009. `rehearsal/cmp.py` rebuilds the expected state locally from the
same files and compares every row of all 11 pre-existing tables (insert
timestamps excluded): all match; `PRAGMA quick_check` ok; `d1_migrations`
lists 0000→0009 in order. Production D1 untouched. Migration 0010 (part of the
candidate) is not applied: D08 names 0008–0009 only.

## D09 — Academy (approved 2026-10-14)

PR #5 (launch list) is excluded. The candidate contains no Academy migration,
table or route. Note: the test D1 `allstar-booking-test` has
`0005_launch_list.sql` applied from earlier Academy testing, so that database is
not production-equivalent.

## D10 — Payments (approved 2026-10-14)

Staging uses Stripe test mode only (`sk_test_` key and its test webhook
secret); production secrets are never reused. Test credentials were not
available to the release engineer; the owner sets them with
`wrangler secret put` on `allstar-booking-test` and deploys with
`STRIPE_REQUIRE_TEST_MODE=true`.
