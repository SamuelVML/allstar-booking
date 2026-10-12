# Bookly Bridge predeployment hardening — checkpoint

Saved 2026-10-13 00:30 CEST on branch `integration/bookly-bridge`.
Resume scheduled for 2026-10-13 14:00 CEST.

## Governance (unchanged, binding)

- No production deployments. No production D1 writes. No live appointment changes.
- Production Worker `allstar-booking` stays as is; `BOOKLY_SYNC_ENABLED=false`.
- Never print or commit secrets. Do not merge any PR without explicit authorization.

## Provenance

- Production code = `194dea2` (tree of `597500d`, PR #7). Deployed bundle rebuilt
  and compared; differences limited to build IDs/chunk hashes. No `/admin` redirect.
- `0075a0c` = Codex `bf1738e` (identical patch-id `57f6045f…`).
- `24f9741` = Codex `0ca2b4b` applied with `git am` from
  `All_Star_Bookly_Installation_Package/0ca2b4b-bookly-calendar-bridge.patch`
  (sha256 `84746f2b7d2b581b…`). Plugin ZIP PHP identical to the patch copy.
- `drizzle/0008_bookly_bridge.sql` is byte-identical to the recovered file.

## Done

1. Historical sync: unlinked local rows are exported to Bookly only when active and
   dated today or later; past/removed time off is never exported; native Bookly
   history (past, cancelled, waitlisted unlinked rows) is not imported. Linked rows
   keep following Bookly. (`exportableAppointment`, `exportableBlock` in `lib/bookly.ts`.)
2. Concurrency: full snapshots run only in the background — Worker Cron Trigger
   (`worker/index.ts`, `lib/bookly-scheduled.ts`, `triggers.crons` in `vite.config.ts`),
   the signed WordPress callback and the staff sync action. Request paths use
   `assertBooklyFresh` (max occupancy age 180 s, `BOOKLY_MAX_OCCUPANCY_AGE_SECONDS`)
   plus the existing live per-day check, and `pushBooklyChanges` (single idempotent
   command; Bookly's named lock arbitrates). Staff paths use `pushAfterCommit`.
   Links are read before the snapshot request so request-time links are never
   inferred deleted. `last_success` records the snapshot request time.
3. Drizzle: `db/schema.ts` aligned (composite PK, partial unique index, checks);
   `0008_snapshot.json` and journal tag `0008_bookly_bridge` added.
   `drizzle-kit generate` → "No schema changes"; `drizzle-kit check` clean.
4. Stripe guard: `STRIPE_REQUIRE_TEST_MODE=true` refuses live keys (test Worker only).
5. Tests: `tests/bookly-hardening.mjs` (history matrix, no snapshots on request
   paths, freshness/fail-closed, concurrent same-slot bookings, post-snapshot native
   bookings, snapshot/link race), `tests/stripe-test-mode.mjs`; `tests/bookly.mjs`
   dates made relative. All 20 suites pass; tsc clean; lint 0 errors; build OK.
   Five mutation checks confirmed the new tests catch each regression.
6. Local `wrangler dev`: scheduled handler no-op when disabled; failure recorded and
   lease released when bridge unreachable; availability 503 when stale.
   Note: wrangler 4.92 local dev cannot trigger `scheduled` when `assets` is set
   (returns `exception` even for a trivial worker); verify cron on the test Worker.
7. WordPress: REST `timezone_string` = `Europe/Amsterdam` (verified).
   `~/Downloads/allstar.zip` contains `bookly-addon-pro` and Bookly 28.5.

## Remaining (resume here)

1. Service catalogue discovery (read-only). Known staff ID 1; known service IDs
   1, 2, 4, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 26. Homepage embeds the Bookly
   form (`data-form_id`, `BooklyL10nGlobal.csrf_token`); public `admin-ajax.php`
   `bookly_render_service` returns the service list. Compare with the 14 website keys:
   `haircut`, `student-haircut`, `kids-haircut`, `line-up`, `beard-trim-shape`,
   `haircut-beard`, `haircut-colour`, `haircut-beard-colour`, plus `+colour` for the
   first six. Report missing combinations, duration mismatches, unsupported add-ons.
   Do not invent mappings.
2. Plesk staging: WP REST exposes `wp-toolkit/api` (WP Toolkit clone available on
   the subscription is likely; confirm in Plesk). InnoDB and `GET_LOCK` need
   Site Health / WP-CLI on staging.
3. Test Worker + D1 (requires Cloudflare credentials): create D1
   `allstar-booking-test`, apply migrations 0000–0008 remotely, deploy Worker
   `allstar-booking-test` with `BOOKLY_SYNC_ENABLED=false`,
   `STRIPE_REQUIRE_TEST_MODE=true`, test-mode Stripe only. Verify cron fires.
4. Open PR `integration/bookly-bridge` → new branch `release/production-194dea2`
   (pointing at `194dea2`). Do not merge.
5. Final report: provenance, commits, migration safety, mapping decisions, auth,
   test evidence, deployment and rollback plan.
