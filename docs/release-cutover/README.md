# All Star production cutover — release candidate

Status: **NOT_READY** (see "Release blockers"). Prepared for independent Codex
review. Nothing in this branch has been merged or deployed to production.

## Candidate

| Item | Value |
|---|---|
| Branch | `release/cutover-rc` |
| Base (production) | `194dea2` = `release/production-194dea2` (lineage `backstage-ios-test`; `main` is stale since 2026-09-21 and not part of this release) |
| Contains | PR #8 (`ea4affa`), PR #9 (`461b02b`), PR #10 (`f5413b4`), `0075a0c` bare `/admin` redirect, Codex re-review 3 corrections (`c03bafa`), owner decision D06 (`e96d2e5`), mapping refusals and pre-D06 checkout resume (`9552e76`) |
| Excluded | Academy launch list (PR #5, `design/allstar-redesign`) per D09; iOS app (PR #1) |
| Diff vs production | 111 files, +14,846 / −256 |

PRs #8, #9 and #10 stay open and unmerged; this branch supersedes them as the
integration candidate.

## Migration inventory

| Migration | Production D1 | Candidate | Notes |
|---|---|---|---|
| 0000–0007 | applied (2026-09-21/22) | unchanged, byte-identical to `194dea2` | |
| `0008_bookly_bridge` | not applied | new | additive: Bookly tables, nullable `appointments.booking_request_id` + partial unique index |
| `0009_booking_obligations` | not applied | new | additive: durable refund/email obligations |
| `0010_release_audit_remediation` | not applied | new | refund retry columns, stored notification payloads, `reconcile` state, conflict resolution marker; moves attempted 0009 `notify` rows to `reconcile` |

No migration after 0010. `drizzle-kit check` and `generate` are clean.
Code rollback to `194dea2` needs no schema rollback (old code ignores the new
objects); verify this for 0010 in the rehearsal before cutover.

## Codex findings closed in this candidate

| Source | Findings | Where documented |
|---|---|---|
| PR #8 review of `23231c0` | 5 | `docs/bookly-hardening-checkpoint.md` |
| PR #9 review of `83ba08b` | 4 | PR #9 thread |
| Release audit | 1–8 | `docs/release-audit/README.md` |
| PR #10 re-reviews of `cc783f2`, `b7cc10d` | R1–R11 | `docs/release-audit/README.md` |
| PR #10 re-review of `f5413b4` | R12–R16 | `docs/release-audit/README.md` |
| Integration review (release engineer) | R17 permanent Bookly mapping refusal stalled all sync; R18 pre-D06 interrupted checkout could not resume | `docs/release-audit/README.md`, `service-mapping-contract.md` |

Every correction has a deterministic regression that failed before the fix
(logs in `docs/release-audit/evidence/` and `evidence/`). A resolved review
thread is not treated as proof; Codex must re-verify.

## Validation of the candidate

`evidence/candidate-validation.log` (Node 22, pnpm frozen lockfile):
`npm test`, `tsc --noEmit`, `npm run lint` (0 errors, 3 existing `<img>`
warnings), `npm run build`, `drizzle-kit check`, `drizzle-kit generate`
(no changes), `npm run test:plugin` (PHP 8.5, three mapping modes): all exit 0.

These are local tests with test doubles for Bookly, Stripe and Resend. They do
not replace staging acceptance.

## Environments

| Environment | State |
|---|---|
| Production Worker `allstar-booking` | v `eac0f994` (code `194dea2`), `BOOKLY_SYNC_ENABLED=false`, untouched |
| Production D1 `allstar-booking-prod` | 0000–0007, untouched (read-only migration list only) |
| Staging Worker `allstar-booking-test` | v `8d6e9445` (code `0075a0c`); no Stripe, Resend or Bookly secrets; sync off; candidate **not** deployed |
| Staging D1 `allstar-booking-test` | 0000–0007 plus Academy `0005_launch_list` (drift; not production-equivalent) |
| Rehearsal D1 `allstar-booking-rehearsal` | 0000–0007 → synthetic seed → 0008 → 0009, data verified (see `owner-decisions.md` D08, `rehearsal/`); 0010 not applied (D08 scope) |
| Staging WordPress | exists (D07); HTTP Basic auth on every path including the bridge REST route |

## Release blockers

1. **Codex review** of this candidate not yet run.
2. **Stripe test mode on staging** (D10): no `sk_test_` key or test webhook
   secret configured. Payment, refund, duplicate-webhook and interrupted-checkout
   acceptance cannot run.
3. **Staging bridge reachability**: HTTP Basic auth on
   `staging.all-star-barbershop.com/wp-json/allstar-bookly/v1/` blocks the
   Worker. Needs a path exemption (HMAC still protects it). Bridge plugin from
   this candidate not yet installed on staging.
4. **WordPress isolation** (notifications, payment gateways, external
   integrations on staging) not verified: no WordPress admin or server access.
5. **Bookly settings not public**: service padding, staff-specific overrides,
   `min_time_prior_booking` meaning; handling-buffer decision
   (`service-mapping-contract.md`).
6. **Pre-D06 future bookings** at Bookly activation: owner must choose move /
   cancel / enter manually in Bookly (activation report
   `GET /api/admin/bookly?report=activation`).
7. **Rehearsal 0010**: needs D08 extension; then deploy the candidate against
   the rehearsal D1 and rehearse rollback to `194dea2` with 0010 applied.
8. **Staging deployment and browser acceptance** (desktop and mobile, customer
   and Backstage, failure recovery) not run.
9. **Amaury's administration workflow** not run; his login must be in
   `ADMIN_EMAILS` on staging.
10. **Runbooks** (cutover, rollback, monitoring/incident) not yet written
    against verified staging behaviour.
