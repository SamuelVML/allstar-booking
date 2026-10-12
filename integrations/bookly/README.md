# Bookly calendar bridge — staged integration

Amaury keeps the existing WordPress/Bookly calendar. This plugin provides a
private server API; it does not replace Bookly or change its vendor files.
The Worker feature is OFF unless `BOOKLY_SYNC_ENABLED=true`.

## Included behaviour

- Pull recent/future Bookly appointments into Backstage and reserve their times.
- Filter website and staff recommendations against Bookly hours, breaks and
  appointments. Customer recommendations scan up to 14 days when enabled;
  explicitly chosen dates still work throughout the configured booking window.
- Push website bookings, payment holds, walk-ins, reschedules, cancellations,
  completions and time off to Bookly with persistent, idempotent commands.
- Pull changes to linked website appointments from Bookly. Reschedules do not
  refund. Cancellations/deletions trigger the existing idempotent Stripe refund.
- Keep Bookly-origin appointment edits and Mollie/payment administration in
  Bookly. Backstage displays them and links to the Bookly calendar. Their
  payment status is `managed_in_bookly`; it is not added to Backstage's recorded
  cash/card/Stripe payment totals. Group bookings are not edited through this API.
- The Worker sends immediate confirmations for its bookings; API writes do not
  send a second Bookly confirmation. Native Bookly notifications/reminders keep
  their existing configuration. Review reminder templates on staging.
- The homepage booking button/service links use browser-native navigation.

## Install and configure on staging first

1. Back up WordPress files and database. Clone it to a protected staging site.
2. Upload the `allstar-bookly-bridge` directory as a ZIP using WordPress
   Plugins → Add New → Upload Plugin, then activate it.
3. Open WordPress Tools → All Star Bookly Bridge. Its tables list the actual
   staff and service IDs. Select Amaury's staff ID and map every website service
   to its corresponding Bookly service. Durations must match exactly. Add-on
   combinations need their own mapping, for example `haircut+colour`.
4. In staging `wp-config.php`, before WordPress's bootstrap, define:

   ```php
   define('ALLSTAR_BOOKLY_SECRET', 'YOUR_RANDOM_SECRET_AT_LEAST_32_CHARACTERS');
   define('ALLSTAR_BOOKLY_STAFF_ID', YOUR_ACTUAL_STAFF_ID);
   define('ALLSTAR_BOOKLY_SERVICES', array(
       'haircut' => YOUR_ACTUAL_HAIRCUT_SERVICE_ID,
       // Map the other website services and any +colour combinations here.
   ));
   define('ALLSTAR_WORKER_SYNC_URL', 'https://YOUR_TEST_WORKER/api/bookly/sync');
   ```

   Generate the secret locally, for example `openssl rand -hex 32`. Keep it
   private. WordPress must use the `Europe/Amsterdam` named timezone.
5. Deploy this branch to the TEST Worker with migration
   `drizzle/0008_bookly_bridge.sql`. The existing deploy script applies it.
   Configure these Worker values (the URL has no trailing slash):

   ```text
   BOOKLY_BRIDGE_URL=https://YOUR_STAGING_WORDPRESS/wp-json/allstar-bookly/v1
   BOOKLY_BRIDGE_SECRET=<the same secret, stored as a Worker secret>
   BOOKLY_SYNC_ENABLED=true
   ```

   WordPress needs InnoDB storage and MySQL named locks. The API refuses writes
   when those prerequisites are unavailable. REST requests must reach the
   plugin without a homepage redirect, login redirect or HTML security challenge.
6. WordPress registers a one-minute cron callback. WP-Cron depends on traffic;
   configure a Plesk scheduled task to invoke WordPress cron every minute if
   continuous background sync is required. Do not disable WP-Cron without
   supplying that replacement. Signed callbacks use `/api/bookly/sync`, outside
   `/api/admin/*` Access rules; they return no customer data.
7. With a staff-authenticated test session, POST `{"action":"sync"}` to
   `/api/admin/bookly`, then GET that route to inspect last success/pending
   commands. `{"action":"catalogue"}` reads mapped staff/services.

## Activation checks — required against real Bookly

- Make a Bookly appointment; confirm it appears in Backstage and removes its
  slot from website availability and recommendations.
- Create cash and Stripe website bookings. Verify exactly one Bookly appointment
  and one immediate confirmation. A payment hold must block Bookly too.
- Retry a request after interrupting its response: no duplicate appointment.
- Move a linked website booking in Bookly; confirm Backstage updates with no
  refund. Cancel it; confirm the original Stripe payment is refunded once.
- Cancel a payment hold while checkout completes; confirm late payment refunds.
- Block/unblock time, including a vacation day; confirm both calendars agree.
- Check Bookly native booking and staff-edit actions under concurrent requests.
  Named locks cover the inspected native save/delete AJAX actions. Other add-ons
  or custom writers need separate compatibility checks; a staff member can still
  intentionally override availability in Bookly's own editor.
- Click the homepage booking button on desktop, iPhone and iPad. Browser checks
  in this environment were blocked by the Chromium download network policy.
- Verify scheduled callbacks work without customers browsing the old site.

A complete snapshot is limited to 5,000 participants and includes seven days of
unmapped history plus all bridge-managed appointments. Larger datasets fail
closed. Overnight bookings and unrecognized custom statuses require review.
Native Bookly rows that age out of the history scope are not treated as deleted.
The 10-minute website handling buffer is preserved for linked appointments.

## Conflict recovery and rollback

Conflicting edits remain pending instead of overwriting either calendar. Inspect
`GET /api/admin/bookly` and compare both appointment records. Do not delete an
uncertain command: replay with its original ID is how a lost response is safely
recovered. A rejected unlinked website request is cancelled locally and releases
its local slots; timeouts retain the reservation. Both-sided conflicts require
staff reconciliation on staging before activation. No automatic winner is chosen.

To pause integration set `BOOKLY_SYNC_ENABLED=false`. Existing imported occupancy
and local bookings remain preserved. Keep new website bookings paused during
rollback; with integration disabled Bookly cannot see subsequent new bookings.
Do not delete mapping/command tables or the old WordPress installation.
The old-domain redirect stays removed until the real booking checks pass.

## Local validation

`npm test` includes SQLite-backed Worker contract tests in `tests/bookly.mjs`.
`php -l integrations/bookly/allstar-bookly-bridge/allstar-bookly-bridge.php` and
`php tests/bookly-plugin.php` check PHP syntax, authentication, replay protection,
command idempotency, schedule rejection and full-day block handling.
These use test doubles; they do not prove real WordPress/MySQL transactions,
provider delivery, Cloudflare Access, or browser/device interactions.
