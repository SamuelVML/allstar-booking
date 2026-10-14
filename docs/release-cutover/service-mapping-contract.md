# Service mapping contract (owner decision D06)

Bookly is the authoritative source for All Star service prices and durations
(owner decision D06, 2026-10-14; see `owner-decisions.md`). The website
catalogue mirrors the Bookly catalogue one to one.

## Source

`bookly-catalogue-2026-10-14.json` in this directory: the public, read-only
`admin-ajax.php?action=bookly_render_service` response of the live booking form
(`form_id 6acf6efd1ffb0`, Bookly 28.6), read on 2026-10-14. It lists 14
services, one staff member (ID 1, Amaury Reyes) assigned to all 14, staff
prices equal to the service prices, and `has_extras: 0` for every service.
Bookly was not changed.

## Where the mapping is defined

| Place | Role |
|---|---|
| `lib/booking.ts` `SERVICES` | The only definition: website key, display name, Bookly price and duration, `booklyServiceId`, `booklyName`. `BOOKLY_SERVICE_MAP` is derived from it. |
| `integrations/bookly/allstar-bookly-bridge/service-map.json` | Generated from `SERVICES` by `node scripts/bookly-service-map.mjs`; shipped inside the plugin. The plugin reads only this map. |
| wp-config `ALLSTAR_BOOKLY_SERVICES` | Optional. If defined, it must equal the bundled map exactly, or the bridge refuses every request (503 `bridge_unconfigured`). |
| `POST /api/admin/bookly {"action":"catalogue"}` | Returns Bookly's live services and the bridge map with `verification` (`lib/bookly-catalogue.ts`): every price, duration and map difference. Differences are reported, never applied. |

`npm test` runs `scripts/bookly-service-map.mjs --check` and
`tests/catalogue-consistency.mjs`; `npm run test:plugin` runs the PHP checks
(bundled map, identical override, differing override fails closed).

## Mapping

Prices in euros; durations in minutes (Bookly duration, without the website's
10-minute handling buffer).

| Bookly ID | Bookly name (exact, trimmed) | Min | Price | Website key | Display name (EN) | Display name (NL) |
|---|---|---|---|---|---|---|
| 1 | Hair cut | 30 | €33.50 | `haircut` | Haircut | Knipbeurt |
| 2 | Line up (Shape up) Contouren | 15 | €17.00 | `line-up` | Line-up (shape-up) | Contouren (line-up) |
| 4 | Beard Shape (model) | 15 | €20.00 | `beard-shape` | Beard shape (model) | Baard vormen (model) |
| 13 | Line up & Beard shave | 15 | €22.50 | `line-up-beard-shave` | Line-up & beard shave | Contouren & baard scheren |
| 14 | Line up & Beard model | 30 | €28.00 | `line-up-beard-model` | Line-up & beard model | Contouren & baard model |
| 16 | Line up, beard model & hair color | 30 | €44.50 | `line-up-beard-model-colour` | Line-up, beard model & hair colour | Contouren, baard model & haar kleuren |
| 17 | Hair cut & hair color | 60 | €50.00 | `haircut-colour` | Haircut & hair colour | Knipbeurt & haar kleuren |
| 18 | Hair cut & Beard trim or shave | 40 | €38.00 | `haircut-beard-trim` | Haircut & beard trim or shave | Knipbeurt & baard trimmen of scheren |
| 19 | Hair cut & Beard shape | 40 | €40.00 | `haircut-beard-shape` | Haircut & beard shape | Knipbeurt & baard vormen |
| 20 | Hair cut, Beard shape & Hair color | 60 | €55.00 | `haircut-beard-shape-colour` | Haircut, beard shape & hair colour | Knipbeurt, baard vormen & haar kleuren |
| 21 | Kids (4-15 years) | 30 | €27.50 | `kids-haircut` | Kids haircut (4–15 years) | Kinderknipbeurt (4–15 jaar) |
| 22 | Enfants (0 - 3 years) | 30 | €25.00 | `toddler-haircut` | Toddler haircut (0–3 years) | Peuterknipbeurt (0–3 jaar) |
| 23 | Kids x2 (4-15 years) | 50 | €55.00 | `kids-haircut-x2` | Two kids haircuts (4–15 years) | Twee kinderknipbeurten (4–15 jaar) |
| 26 | Hair cut Student 16 years + | 40 | €33.50 | `student-haircut` | Student haircut (16+) | Studentenknipbeurt (16+) |

Distinct Bookly services stay distinct even where durations match (for example
13 and 2 and 4 are all 15 minutes; 1, 14, 16, 21 and 22 are all 30 minutes).

## What changed for customers

| Before D06 (website) | After D06 |
|---|---|
| 8 services plus a colour add-on (+30 min, +€22.50) on most services | 14 Bookly services, no add-on |
| Haircut €35, 30 min | Hair cut €33.50, 30 min |
| Student haircut €30, 30 min | Hair cut Student 16 years + €33.50, 40 min |
| Line-up €17.50 | €17.00 |
| Haircut + colour €55 | Hair cut & hair color €50 |
| Beard trim & shape (20 min), Haircut + beard (45 min), Haircut + beard + colour (75 min) | No Bookly equivalent with that duration; not sold. Customers choose a Bookly service (for example 4, 18, 19, 20) |

A request with `colourAddOn: true`, an `addOn` query parameter, a legacy key or
a `+colour` key is refused with 400; it is never priced or silently dropped.

## Appointments booked before D06

Stored `service_id`, `service_name`, `duration_minutes` and `price_cents` are
kept. Nothing reprices a stored appointment: Backstage, emails, reschedules,
payment receipts, refunds and Stripe all use the stored values
(`tests/catalogue-consistency.mjs` covers display, reschedule and refund).
Legacy keys (`LEGACY_SERVICE_NAMES` in `lib/booking.ts`: `beard-trim-shape`,
`haircut-beard`, `haircut-beard-colour`, `colour-add-on`) are read-only and not
bookable. Five keys are reused with Bookly's meaning (`haircut`,
`student-haircut`, `kids-haircut`, `line-up`, `haircut-colour`); their old rows
keep their old price and duration.

## Open items public data cannot answer (owner / WordPress admin)

1. **Padding.** `padding_left` / `padding_right` per service are not in the
   public response. The snapshot adds Bookly padding to occupancy, and the
   Worker adds its own 10-minute handling buffer. Read the padding in
   Bookly → Services before activation.
2. **Staff-specific duration overrides.** The public response shows staff
   prices (all equal to the service price) but not staff-specific durations.
   The plugin refuses a command whose duration differs from the Bookly
   service's own duration (`duration_map`, 503).
3. **10-minute handling buffer.** The website adds 10 minutes after every
   service (Backstage setting). Bookly's durations may already include
   turnaround. Decide whether the buffer stays, especially for the 15-minute
   services.
4. **`min_time_prior_booking`.** Every public service carries
   `[2026, 9, 14]`. Its meaning in Bookly 28.6 is not documented in the
   response. The website keeps its own 60-minute online lead time.
5. **Pre-D06 future bookings at sync activation.** Rows with a legacy key or a
   `+colour` name have no Bookly service, and the plugin refuses them
   (`service_map`). Rows with a reused key whose duration changed (old
   `student-haircut` 30 min against Bookly's 40) are refused (`duration_map`).
   Decide how these are entered in Bookly (by staff, before activation) and
   confirm how the Worker settles a 503 refusal (held for staff, not retried
   forever) before enabling sync.
6. **Hidden or private services.** The public form lists services visible to
   customers. Confirm in WordPress Tools → All Star Bookly Bridge that no
   other service should be sold online.
7. **Display names and translations.** English display names and the Dutch
   translations above were written for the website; Bookly names stay
   canonical (`booklyName`). Review the wording.
