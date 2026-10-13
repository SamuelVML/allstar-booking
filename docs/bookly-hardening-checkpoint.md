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

## Deployment-readiness report

Run 2026-10-13 (scheduled resume) on `integration/bookly-bridge`, base `2d62add`.
Nothing was deployed. No production D1 or live WordPress writes were made. The
production Worker `allstar-booking` is untouched and `BOOKLY_SYNC_ENABLED` stays `false`.

### 1. Recovered source and provenance

- Production code is `194dea2` (merge of PR #7, tree of `597500d`). The rebuilt
  bundle matches the deployed one except for build IDs and chunk hashes.
- `0075a0c` is Codex `bf1738e` (same patch-id `57f6045f…`): `/admin` redirect
  before staff-layout auth.
- `24f9741` is Codex `0ca2b4b`, applied with `git am` from
  `0ca2b4b-bookly-calendar-bridge.patch` (sha256 `84746f2b7d2b581b…`). It has not
  been rewritten. The plugin ZIP's PHP is identical to the patch copy.
- `drizzle/0008_bookly_bridge.sql` is byte-identical to the recovered file and has
  not been modified.

### 2. Commits and branch relationships

```
release/production-194dea2 → 194dea2  Merge PR #7 (production; created and pushed this run)
integration/bookly-bridge  → 194dea2
  0075a0c  Redirect bare admin route before staff layout authentication   (Codex bf1738e)
  24f9741  Add opt-in Bookly calendar bridge and reliable booking navigation (Codex 0ca2b4b)
  a9a1773  Declare Bookly bridge environment variables
  aaedfa5  Reconcile migration 0008 with Drizzle metadata
  c2f6a17  Refuse live Stripe keys on test Workers
  67b8ca9  Move Bookly snapshots off request paths and skip history
  2d62add  Add Bookly hardening checkpoint notes
  (+ this report commit)
```

`194dea2` is an ancestor of `integration/bookly-bridge` (verified with
`git merge-base --is-ancestor`), so the PR into `release/production-194dea2` is a
fast-forward diff of exactly these commits (38 files, about +3,000/−53 lines before this report).

### 3. Migration safety

- `0008` is additive only: 7 new tables (`bookly_links`, `bookly_commands`,
  `bookly_sync_state` + singleton row, `bookly_occupied_slots`,
  `bookly_callback_nonces`, `bookly_revision_guards`), one partial unique index on
  `bookly_commands`, one nullable column `appointments.booking_request_id`, and one
  partial unique index on it (`WHERE … IS NOT NULL`). Existing rows all get NULL,
  so creating the index cannot fail on production data.
- No existing column, table or index is dropped or rewritten. `194dea2` never
  reads the new objects, so after 0008 is applied the old code can be redeployed
  unchanged. Code rollback does not need a schema rollback.
- Drizzle metadata (`0008_snapshot.json`, journal tag `0008_bookly_bridge`) is
  aligned: `drizzle-kit generate` reports no schema changes and `drizzle-kit check` is clean.
- Caveat: `npm run deploy:cloudflare` always runs `wrangler d1 migrations apply DB
  --remote` before `wrangler deploy`. When Phase 1 runs against production, it
  applies 0008 to `allstar-booking-prod`. That is intended but irreversible
  (additive). Take a D1 export or Time Travel bookmark first (see the plan below).

### 4. Service mapping: owner decisions still open

**Catalogue discovery could not run from this environment.** The routine's outbound
policy blocks `all-star-barbershop.com`: curl gets `CONNECT tunnel failed, response
403` (proxy policy denial) and WebFetch gets `getaddrinfo ENOTFOUND`. So no Bookly
service names, durations or prices were read, and the plan to fetch
`bookly_render_service` with the page csrf token could not run. **No mappings are
proposed or invented.**

Website side (`lib/booking.ts` SERVICES and `app/api/bookings/route.ts`: the colour
add-on adds 30 min and €22.50 and appends `" + colour"` to the name):

| Mapping key | Website name | Min | Price | Bookly service ID |
|---|---|---|---|---|
| `haircut` | Haircut | 30 | €35.00 | **owner decision** |
| `student-haircut` | Student haircut | 30 | €30.00 | **owner decision** |
| `kids-haircut` | Kids haircut | 30 | €27.50 | **owner decision** |
| `line-up` | Line-up | 15 | €17.50 | **owner decision** |
| `beard-trim-shape` | Beard trim & shape | 20 | €22.50 | **owner decision** |
| `haircut-beard` | Haircut + beard | 45 | €47.50 | **owner decision** |
| `haircut-colour` | Haircut + colour | 60 | €55.00 | **owner decision** |
| `haircut-beard-colour` | Haircut + beard + colour | 75 | €67.50 | **owner decision** |
| `haircut+colour` | Haircut + colour (add-on) | 60 | €57.50 | **owner decision** |
| `student-haircut+colour` | Student haircut + colour | 60 | €52.50 | **owner decision** |
| `kids-haircut+colour` | Kids haircut + colour | 60 | €50.00 | **owner decision** |
| `line-up+colour` | Line-up + colour | 45 | €40.00 | **owner decision** |
| `beard-trim-shape+colour` | Beard trim & shape + colour | 50 | €45.00 | **owner decision** |
| `haircut-beard+colour` | Haircut + beard + colour (add-on) | 75 | €70.00 | **owner decision** |

`colour-add-on` (30 min, €22.50, `isAddOn`) cannot be booked alone, so it needs no
mapping key. Bookly IDs known so far: staff `1`; services 1, 2, 4, 13, 14, 16, 17,
18, 19, 20, 21, 22, 23, 26 (14 IDs, names unknown). The match of 14 IDs to 14 keys
is a count only. It is not evidence of a one-to-one mapping.

Questions for the owner, visible in the website catalogue alone:

- `haircut-colour` (60 min, €55) and `haircut+colour` (60 min, €57.50) describe
  the same work at different prices. The same applies to `haircut-beard-colour`
  (€67.50) and `haircut-beard+colour` (€70). Decide whether each pair maps to one
  Bookly service or two. A shared ID is allowed only if reverse lookup
  (`array_flip` in the plugin) still gives the intended key: with duplicate
  values, `array_flip` keeps the **last** key, so Bookly-native imports would be
  labelled with that key.
- Bookly has no add-on concept in this bridge. Every `+colour` combination needs
  its own Bookly service with the combined duration, or it must stay unmapped.
  An unmapped key fails closed: the plugin returns no service and the Worker
  refuses the booking.
- Bookly durations must equal the website durations exactly (README step 3). The
  Worker asks Bookly for availability using duration + the 10-minute handling
  buffer. Confirm whether Bookly services carry padding (`padding_left`/`padding_right`)
  that would double-count that buffer.
- Bookly prices are not synced. The website price stays authoritative for its
  own bookings, and imported native bookings keep Bookly's price. Price differences
  are informational but should be reviewed.

**What the owner must export** (staging first, from WordPress → Tools → All Star
Bookly Bridge; the page reads `wp_bookly_staff` and `wp_bookly_services`):

1. The Staff table (ID, Name). Confirm Amaury = ID 1.
2. The Services table: ID, Service (title), Minutes (Bookly `duration` is stored
   in seconds, and the page shows it raw), Price, for all 14 IDs above.
3. For each service, also from Bookly → Services: padding before/after, whether
   it is assigned to staff 1, and any staff-specific price or duration override.
4. Any Bookly "extras"/add-ons configured (Bookly Pro Service Extras). These are not
   supported by the bridge and must not be relied on for colour.
5. After the mapping is decided: the `ALLSTAR_BOOKLY_SERVICES` array for staging
   `wp-config.php`. The signed `{"action":"catalogue"}` call through
   `/api/admin/bookly` on the test Worker then echoes `serviceMap` for verification.

### 5. Plesk staging assessment

Public evidence could not be re-checked this run (the same network block). From
the earlier checkpoint: the WP REST index exposes the `wp-toolkit/api` namespace,
and `timezone_string` is `Europe/Amsterdam`. `~/Downloads/allstar.zip` contains
Bookly 28.5 and `bookly-addon-pro`. Still needs owner confirmation in Plesk or on staging:

- [ ] WP Toolkit **Clone** is available on the subscription and a password-protected
      staging clone (files + DB) can be made. The namespace only shows that WP Toolkit
      is installed; plan limits decide whether cloning is allowed.
- [ ] All Bookly and `wp_allstar_*` tables use **InnoDB** (Site Health → Info →
      Database, or `wp db query "SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE '%bookly%'"`).
      The plugin refuses command writes otherwise.
- [ ] MySQL **GET_LOCK** works: `wp db query "SELECT GET_LOCK('allstar-test',5), RELEASE_LOCK('allstar-test')"` returns `1 1`.
- [ ] **Bookly Pro** add-on is active and licensed on production and on the clone
      (Plugins page), and versions match the ZIP (Bookly 28.5).
- [ ] REST reaches `/wp-json/allstar-bookly/v1/*` with no redirect, login wall or
      WAF/Imunify challenge (Worker uses `redirect: "error"`).
- [ ] A Plesk scheduled task runs WP-Cron every minute on staging (README step 6).
- [ ] The staging clone has outgoing Bookly notifications disabled or redirected,
      so cloned customers are not emailed.

### 6. Authentication compatibility (HMAC Worker ↔ plugin)

- Worker → plugin (`lib/bookly.ts` `booklyRequest`): HMAC-SHA256 over
  `timestamp \n nonce \n /allstar-bookly/v1/<route> \n body`, with headers
  `X-Allstar-Timestamp/Nonce/Signature`. Plugin (`authorize`): recomputes over
  `$request->get_route()` (`/allstar-bookly/v1/<route>`, the same string), compares
  with `hash_equals`, allows ±120 s skew, requires a UUID nonce, and stores the
  nonce for 240 s (replay refused). Secret is ≥32 characters on both sides.
- Plugin → Worker (WP cron → `/api/bookly/sync`): HMAC over
  `timestamp \n nonce \n /api/bookly/sync \n {}`, checked with `crypto.subtle.verify`.
  The nonce is stored in D1 `bookly_callback_nonces`. The route returns no customer data.
- The bridge URL must be `https://…/wp-json/allstar-bookly/v1` with no credentials,
  query or fragment. Redirects are refused.
- Evidence: `php tests/bookly-plugin.php` PASS (HMAC expiry and replay,
  idempotent commands, altered-payload refusal). `tests/bookly.mjs` PASS (signed
  requests; unsigned scheduler callback rejected). The real end-to-end check on
  staging is still open.
- One secret, two places: Worker secret `BOOKLY_BRIDGE_SECRET` and staging
  `wp-config.php` `ALLSTAR_BOOKLY_SECRET`. Use a separate secret for production
  activation.

### 7. Test evidence (this run, Node v22.22.0, pnpm 11.25.0)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 (lockfile unchanged) |
| `npm test` | exit 0. 20 `PASS` lines, 0 failures. Logged `BooklyUnavailable` stack traces are expected output from the fail-closed tests |
| `npx tsc --noEmit` | exit 0, no errors |
| `npm run lint` | exit 0. 0 errors, 3 warnings (`@next/next/no-img-element` in `app/site-home.tsx`, already present) |
| `php -l …/allstar-bookly-bridge.php` | No syntax errors |
| `php tests/bookly-plugin.php` | PASS |

No tests were weakened or skipped. Not covered locally: real WordPress/MySQL
transactions, the Cloudflare cron trigger (wrangler 4.92 local dev cannot fire
`scheduled` when `assets` is set), Cloudflare Access, browsers and devices.

### 8. Test Worker and test D1: owner commands (not run; no Cloudflare credentials here)

Run from a clean checkout of `integration/bookly-bridge` with a Cloudflare API
token scoped to the account (Workers Scripts:Edit, D1:Edit). **Never** point these
variables at `allstar-booking` or `allstar-booking-prod`.

```bash
pnpm install --frozen-lockfile
npx wrangler d1 create allstar-booking-test          # note the database_id it prints
export CLOUDFLARE_D1_DATABASE_NAME=allstar-booking-test
export CLOUDFLARE_D1_DATABASE_ID=<id from above>
export CLOUDFLARE_WORKER_NAME=allstar-booking-test
npm run build:cloudflare                              # writes dist/server/wrangler.json
grep -E '"name"|database_name|database_id' dist/server/wrangler.json   # must say -test
npx wrangler d1 migrations list DB --remote --config dist/server/wrangler.json
npx wrangler d1 migrations apply DB --remote --config dist/server/wrangler.json   # 0000–0008
npx wrangler deploy --config dist/server/wrangler.json \
  --var BOOKLY_SYNC_ENABLED:false --var STRIPE_REQUIRE_TEST_MODE:true
# Secrets: paste interactively, test-mode Stripe keys only (sk_test_/rk_test_, test whsec_)
npx wrangler secret put STRIPE_SECRET_KEY      --name allstar-booking-test
npx wrangler secret put STRIPE_WEBHOOK_SECRET  --name allstar-booking-test
# plus the other secrets the app needs (mail, staff auth), as test values
npx wrangler d1 execute allstar-booking-test --remote \
  --command "SELECT name FROM sqlite_master WHERE name LIKE 'bookly_%'"
npx wrangler tail allstar-booking-test --format pretty   # wait ≥2 min: one scheduled event per minute
npx wrangler d1 execute allstar-booking-test --remote \
  --command "SELECT * FROM bookly_sync_state"
```

Expected result with sync off: one scheduled invocation per minute in `wrangler tail`
(or under Workers → allstar-booking-test → Logs/Cron Events), each a no-op, and
`bookly_sync_state` left unchanged. If `STRIPE_REQUIRE_TEST_MODE=true` is set with a
live key, the Worker refuses payments (verified by `tests/stripe-test-mode.mjs`).
(`npm run deploy:cloudflare` does the apply and deploy steps together. The explicit
steps above let you check the target before each one.)

### 9. Deployment and rollback plan

**Phase 0: preconditions.** PR `integration/bookly-bridge → release/production-194dea2`
reviewed. Test Worker green (section 8). Owner mapping decisions made (section 4).
Plesk checklist done (section 5).

**Phase 1: ship code with sync off (production).**
1. Back up production D1: `wrangler d1 time-travel info allstar-booking-prod`
   (record the bookmark) and `wrangler d1 export allstar-booking-prod --remote --output prod-pre-0008.sql`.
2. Make sure `BOOKLY_SYNC_ENABLED` is unset or `false` on `allstar-booking`. Leave
   `STRIPE_REQUIRE_TEST_MODE` **unset** in production.
3. Deploy the merged release commit with the normal production pipeline (applies
   0008, then deploys). Smoke test: homepage, `/book` availability, one staff
   login, admin `/admin` redirect, Stripe checkout page loads. No live test
   booking without owner approval. The cron fires every minute and does nothing while sync is off.
4. Rollback: redeploy `194dea2` (`release/production-194dea2`). The schema stays
   (additive, ignored by old code). Restore D1 only if data was damaged, using the
   Time Travel bookmark.

**Phase 2a: staging activation.** WP Toolkit clone → install plugin on the clone →
`wp-config.php` constants (staging secret, staff 1, approved mapping, test Worker
sync URL) → test Worker `BOOKLY_BRIDGE_URL`, `BOOKLY_BRIDGE_SECRET`,
`BOOKLY_SYNC_ENABLED=true` → run every item of the README "Activation checks"
against staging Bookly with Stripe test mode.
Rollback: `BOOKLY_SYNC_ENABLED=false` on the test Worker, then deactivate the plugin on staging.

**Phase 2b: production activation** (needs separate explicit owner authorization).
Fresh backups of production WP DB and D1 → install and activate the plugin on
production WordPress with a new secret and the approved mapping → set Worker secret
and URL → change `BOOKLY_SYNC_ENABLED` to `true` in a quiet hour → watch
`GET /api/admin/bookly` (last success under 180 s, no pending conflicts) and
`wrangler tail`. Activation exports only active future website bookings and
imports only current native Bookly rows (history matrix tested).
Rollback: set `BOOKLY_SYNC_ENABLED=false` (instant; bookings and imported occupancy
stay). Pause new website bookings while reconciling. Keep the mapping and command
tables and the old WordPress install. Resolve pending commands by replay, never by deleting them.

### 10. Done and blocked

- Done: release branch `release/production-194dea2` → `194dea2` pushed. PR opened
  (not merged). Full local test and lint run is green. HMAC compatibility reviewed.
  Migration safety reviewed. Owner commands and checklists written.
- Blocked (environment): catalogue discovery and the public Plesk/REST re-check,
  because `all-star-barbershop.com` is blocked by the routine's network policy.
  Test Worker and D1, because there are no Cloudflare credentials.
- Blocked (owner): the 14 service mappings, the Plesk confirmations (clone,
  InnoDB, GET_LOCK, Bookly Pro), production backups and every deployment.
