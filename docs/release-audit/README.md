# Release audit remediation — findings 1–8

Branch `fix/release-audit-remediation`. Owner directive 2026-10-13: correct the
eight release-blocking findings of the independent Codex release audit. No
production change, deployment, merge or synchronization activation is part of
this work; `BOOKLY_SYNC_ENABLED=false` stays in force.

## Provenance

| Item | Value |
|---|---|
| Audited PR #8 head | `ea4affa6f73fcf56378263432c034440d49df7cb` (base `release/production-194dea2` = `194dea2`) |
| Audited PR #9 head | `461b02b504f4198e3ffdd6fd2b877b22820b9efe` (base `integration/bookly-bridge`) |
| Combined head (this branch's base) | `f984288` = PR #9 head merged with PR #8 head (`ea4affa` changes documentation only; no conflicts) |
| Regressions + migration 0010 | `5448624` — 18 checks fail, 5 controls pass ([log](evidence/release-audit-at-tests-commit.log)) |
| Corrections | `40890f7` |
| Re-review regressions / corrections | `ada6533` / `b7cc10d`; second re-review `aedbb6d` / see PR #10 |
| Migration order | `0008_bookly_bridge` → `0009_booking_obligations` → `0010_release_audit_remediation` |

The combined head is used because finding 4 builds on PR #9's durable
obligations and findings 6–7 are in PR #9's code. This follows the audit's
recommended sequence (#9 into #8, then #8 into the release branch).

## Evidence preserved

`evidence/` holds the complete audit report (`codex-release-audit.md`), every
reproduction log and script from `/tmp/allstar-release-audit`, the reproduction
re-run on the combined head before any change, the regression run at the test
commit, the audit scripts re-run after the fix and the full `npm test` log.
`SHA256SUMS` lists their checksums.

## Findings, corrections and regressions

Audit script labels differ from the audit's ranked numbering: script "F4" is
finding 1, "F1" is finding 4, "F8" is 5, "F5" is 6, "F6" is 7, "F7" is 8.

| # | Finding | Correction | Regression (`tests/release-audit.mjs`) |
|---|---|---|---|
| 1 | Concurrent deletion released a confirmed booking's slots | Cancellation, slot release, refund record and link update in one batch guarded on the compared revision and status; an edited booking is kept and held | `F1 a staff edit racing…`, `F1 an unraced Bookly deletion…` (control) |
| 2 | Bookly-rejected reschedule confirmed and notified | Email obligation committed with the move, sent only after Bookly accepts; a rejected move is restored (audited reversal) or held; route returns 409 | `F2 …rejects is reported as rejected…`, `F2 …queued while Bookly is unreachable…`, `F2 …rejects later…`, `F2 …accepts…` (control) |
| 3 | One conflicted command stalled all sync | Rejections settled or held per record, never retried every run; adoption/deletion conflicts held per record; later changes wait behind a held record; >10 held stops sync (fail closed); staff `resolve` action | `F3 one conflicted command is held…`, `F3 later changes…wait`, `F3 …bounded…`, `F3 staff resolve…bookly`, `F3 staff resolve…local` |
| 4 | Failed Bookly and late-payment refunds never retried | `payment_refunds.attempts/next_attempt_at`, backoff 1–64 min, 8 automatic attempts, Cron sweep regardless of Bookly; refund due recorded in the cancelling/payment transaction; claims + Stripe idempotency key | `F4 …Bookly cancellation…`, `F4 …late-payment…Bookly disabled`, `F4 …keeps failing…retryable by staff` |
| 5 | Worker without its lease still cancelled and refunded | Lease guard (and renewal) inside every booking-mutating batch of a sync run | `F5 …commits no cancellation and no refund`, `F5 …cannot cancel a booking deleted in Bookly` |
| 6 | Retry changed the payload under the same Resend key | Requests built once, stored (`booking_obligations.payload`) before first delivery, resent verbatim | `F6 a notification retry sends the stored payload…` |
| 7 | Duplicate email after Resend's 24 h key expiry | Delivery uncertain and first attempt older than 23 h → status `reconcile`, no resend | `F7 …older than the provider key window…`, `F7 …inside the window…` |
| 8 | Interrupted pre-checkout request could not resume | Retried request creates/recovers its Checkout Session with key `booking-checkout/<id>/<hold expiry>`; hold renewed once if Stripe's 30-minute minimum requires it; concurrent retries share one session | `F8 retrying an interrupted…`, `F8 concurrent retries…`, `F8 …after Checkout creation…`, `F8 a cash booking retry…` (control) |

Audit finding 9 (vacation within normal hours) is inherited from `194dea2` and
was already corrected by PR #9; its tests still pass.

## Validation (combined head with corrections)

| Check | Result |
|---|---|
| `npm test` (all suites incl. `release-audit`, `migration-0010`) | pass, 0 failures ([log](evidence/npm-test-after.log)) |
| `tsc --noEmit` | clean |
| `npm run lint` | 0 errors; 3 pre-existing `<img>` warnings (identical before the change) |
| `npm run build` | succeeds |
| `drizzle-kit check` / `generate` | clean / no schema drift |
| Migration compatibility | `tests/migration-0010.mjs`: populated 0009 database upgrades with every row and constraint intact |
| Cron budget (default 40) | obligations behind a 200-command backlog: 5 runs, peak 32 (audited baseline: 5 runs, peak 33) |

## Behaviour changes reviewers should know

- `synchronizeBookly` no longer throws for a per-record conflict; it records it
  in `bookly_conflicts` (or a `held` command) and sets `bookly_sync_state.error`
  to `held`. `GET /api/admin/bookly` lists `held` and `conflicts` (with
  `resolution` once staff chose a version that has not reached both calendars).
- `POST /api/admin/bookings/change` (reschedule) returns 409 with
  `changed:false, restored` when Bookly rejects the move; with Bookly
  unreachable it returns `calendar:"pending", notificationsSent:false` and the
  email follows acceptance.
- Refund retries back off; an immediate re-run after a Stripe failure does not
  retry until the next step (1 minute).
- A webhook replay never starts a refund that was not already recorded as due.

## Re-running the original audit scripts

`evidence/original-repro-scripts-after-fix.log`: findings 1, 2, 3, 5, 6 and 7
no longer reproduce. Two script outputs need the harness differences in mind:
the finding 4 scripts re-run immediately without advancing the clock (the new
backoff correctly defers the retry; `release-audit.mjs` advances the clock and
shows exactly one refund), and the finding 8 script's Stripe double has no
`checkout.sessions.create`, so it cannot exercise Checkout (covered by the
`F8` regressions). The audit email mock lacks the new prepare/deliver exports,
which is why its finding 9 line reports `notificationsSent:false`.

## Codex re-review of `cc783f2` (PR #10)

Codex's review of this branch raised eight further findings. Each was
reproduced by a failing regression first (`ada6533`,
[log](evidence/codex-rereview-at-tests-commit.log)), then corrected.

| # | Finding | Correction | Regression |
|---|---|---|---|
| R1 (P1) | Migration kept attempted 0009 notifications `pending` without a payload, so they could be rebuilt or resent | 0010 moves `notify` rows with `status='pending' AND attempts > 0` to `reconcile` with an explanatory `last_error`; untried, done and refund rows unchanged | `tests/migration-0010.mjs` |
| R2 (P1) | Persistent email backlog starved refund retries | When both queues are due they alternate which runs first, by minute; the reserved share always covers either one | `R2 refund retries are not starved…` |
| R3 (P1) | An overlapping checkout retry could return an unstored session that payment confirmation never matches | The losing store returns the stored session and expires its own | `R3 overlapping checkout retries…` |
| R4 (P1) | Resolving a held reschedule unblocked its email before the chosen version reached Bookly | `bookly_conflicts.resolution` marks a resolved row; it stays (blocking the email, not the sync) until adoption or Bookly's acceptance removes it; a new conflict reopens it | `R4 … "keep Bookly" …`, `R4 … "keep local" …` |
| R5 (P2) | A lost Checkout creation response cancelled the hold | Only a Stripe 4xx releases the hold; any other failure keeps it for idempotent recovery (it expires like any unpaid hold) | `R5 … uncertain outcome …`, `R5 … Stripe rejects …` (control) |
| R6 (P2) | Successful command receipts were written without the lease | Receipt batch fenced on the sync lease | `R6 a worker that lost its lease during a command request…` |
| R7 (P2) | "Keep Bookly" reported success for a service/duration change it could not apply | Refused with 409; staff keep the local version or cancel and rebook | `R7 "keep Bookly" is refused…` |
| R8 (P2) | "Keep local" was refused forever when Bookly's twin never changed | Falls back to the link's version (a changed twin is always recorded by the snapshot) | `R8 "keep local" works…` |

Validation after the corrections: `npm test` exit 0, 0 failures
([log](evidence/npm-test-after-rereview.log)); `tsc` clean; lint 0 errors,
3 pre-existing warnings; build succeeds; `drizzle-kit check`/`generate`
clean ([log](evidence/validation-after-rereview.log)). Cron budget unchanged:
5 runs, peak 32 behind a 200-command backlog. The preserved audit scripts are
now excluded from lint (they added 25 unused-variable warnings) so they stay
byte-identical to `SHA256SUMS`.

## Codex re-review of `b7cc10d` (PR #10)

Codex's review of the corrections raised three further findings, all in staff
conflict resolution. Each was reproduced by a failing regression first
(`aedbb6d`, [log](evidence/codex-rereview-2-at-tests-commit.log)), then
corrected.

| # | Finding | Correction | Regression |
|---|---|---|---|
| R9 (P2) | A service/duration change found together with a local edit was recorded as a generic conflict, so "keep Bookly" was accepted and the next snapshot reopened it | `adopt` classifies a service/duration change before any other conflict | `R9 "keep Bookly" is refused for a service change that coincides with a local edit` |
| R10 (P2) | "Keep Bookly" for a record Bookly never accepted deleted the conflict; the next sync exported the record again and the conflict returned | Refused with 409: Bookly has no version to keep | `R10 "keep Bookly" is refused for a record Bookly never accepted` |
| R11 (P2) | A command discarded by a resolve while in flight still settled as delivered: it overwrote the link and the "keep Bookly" marker never cleared | Receipts settle only while the command is `pending`. A discarded command that reached Bookly reopens the conflict with Bookly's new version (and links a new record so the snapshot recognises it). A discarded command Bookly rejected settles nothing | `R11 a command discarded while in flight does not settle as delivered…`, `R11 …then rejected by Bookly settles nothing` |

The second R11 regression was added after `aedbb6d` for the rejection path,
which the same race reaches; the log records it failing with only that guard
removed. Settling a rejection now costs one more subrequest (`SETTLE_COST` 8).

Validation after the corrections: `npm test` exit 0, 0 failures
([log](evidence/npm-test-after-rereview-2.log)); `tsc` clean; lint 0 errors,
3 pre-existing warnings; build succeeds; `drizzle-kit check`/`generate`
clean ([log](evidence/validation-after-rereview-2.log)). Cron budget unchanged:
5 runs, peak 32 behind a 200-command backlog. No schema or migration change.

## Not verified here

Real WordPress/Bookly, Stripe, Resend, MySQL locking and a deployed Worker;
PHP plugin tests (PHP not installed). Backstage has no UI yet for held
conflicts or `reconcile` emails (API only).
