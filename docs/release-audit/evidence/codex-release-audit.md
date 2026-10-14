**PR #8: CHANGES_REQUIRED.**  
**PR #9: CHANGES_REQUIRED.**

Both existing test suites pass, but independent failure simulations reproduced release-blocking defects. No repository code, configuration, secrets, production services, commits, or deployments were changed.

**PR integrity**

| PR | Exact audited head | Base branch |
|---|---|---|
| [#8](https://github.com/SamuelVML/allstar-booking/pull/8) | `ea4affa6f73fcf56378263432c034440d49df7cb` | `release/production-194dea2` |
| [#9](https://github.com/SamuelVML/allstar-booking/pull/9) | `461b02b504f4198e3ffdd6fd2b877b22820b9efe` | `integration/bookly-bridge` |

- Production baseline resolves to `194dea284a22d1745bf29f2e4450ee546008f50c`.
- PR #9 descends from PR #8’s earlier commit `73c19d1c58f6e7f9cb2c25e0dd5baee4eea19b28`. It does **not** contain #8’s current head.
- The intervening #8 commit changes documentation only. Local merge-tree verification found **no conflicts** and retains that documentation.
- GitHub reports both PRs mergeable; neither has reported CI checks.
- No unrelated code modifications were identified. A direct head-to-head comparison misleadingly shows 60 documentation lines removed by #9; the actual stacked merge preserves them.
- Migration ordering is correctly recorded as **0008 → 0009**. Applying both to a seeded baseline database preserved existing values and rows; `booking_request_id` was added as nullable.

**Findings, ranked**

Common findings below were reproduced against **both exact PR heads**. PR #9 inherits these defects from #8.

1. **P1 — Concurrent deletion reconciliation releases a still-confirmed appointment’s slots.**  
   A staff edit between the deletion lookup and cancellation batch makes the revision-qualified update affect zero rows, while the slot deletion still executes.  
   **Reproduction:** synchronization returned success; the original booking remained `confirmed`, with zero slots. An immediate new booking at the same time returned `201`, leaving **two confirmed appointments at 10:00**.  
   **Location:** [lib/bookly.ts:451–458](/private/tmp/allstar-release-audit/pr8/lib/bookly.ts:451).

2. **P1 — A Bookly-rejected reschedule is confirmed and notified locally.**  
   The local move commits before remote arbitration. A remote conflict becomes a response field, while the route still sends the reschedule notification and returns success.  
   **Reproduction:** move a linked 10:00 booking to 11:00; introduce a native Bookly appointment at 11:00 before command delivery. Response: `200`, `changed:true`, `notificationsSent:true`, `calendar:"conflict"`. Local booking: 11:00; Bookly booking: 10:00, with another customer occupying 11:00.  
   **Locations:** [change route:31–47](/private/tmp/allstar-release-audit/pr8/app/api/admin/bookings/change/route.ts:31), [lib/bookly.ts:288–292](/private/tmp/allstar-release-audit/pr8/lib/bookly.ts:288).

3. **P1 — One conflicted command stalls the entire synchronization pipeline.**  
   Errored commands run first. A conflict throws out of the drain before snapshot refresh, further exports, and the refund sweep.  
   **Reproduction:** retain the rejected move above and add an unrelated healthy appointment. Three consecutive sync attempts retried the same conflict, took **zero snapshots**, and never exported the healthy appointment. Availability subsequently fails closed when freshness expires.  
   **Locations:** [lib/bookly.ts:230–247](/private/tmp/allstar-release-audit/pr8/lib/bookly.ts:230), [first drain:402](/private/tmp/allstar-release-audit/pr8/lib/bookly.ts:402).

4. **P1 — Failed Bookly and late-payment refunds stop retrying automatically.**  
   The refund function writes `status="failed"` after a provider failure, but the Bookly sweep selects only `pending`. Late-payment reconciliation retries the refund only when its initial payment update changes a row.  
   **Reproduction:** fail one refund, then restore Stripe. Three successful sync runs left the cancellation paid and unrefunded. Three repeated paid-session lookups likewise left the late refund failed, while telling the customer it was being processed.  
   **Locations:** [refund failure handling:91](/private/tmp/allstar-release-audit/pr8/lib/refunds.ts:91), [Bookly sweep:480–485](/private/tmp/allstar-release-audit/pr8/lib/bookly.ts:480), [payment reconciliation:50–52](/private/tmp/allstar-release-audit/pr8/lib/payments.ts:50).  
   PR #9’s vacation obligations fix retrying **vacation refunds**, but do not cover these paths.

5. **P1 — A worker that lost its sync lease can still cancel and refund.**  
   Snapshot adoption executes mutations before the next lease-owner check.  
   **Reproduction:** advance the simulated clock past the 120-second lease and let a replacement worker acquire it before adoption commits. The old worker cancelled and refunded the appointment, then reported `Calendar sync lease expired`.  
   **Locations:** [adoption/refund:372–377](/private/tmp/allstar-release-audit/pr8/lib/bookly.ts:372), [later lease check:433–439](/private/tmp/allstar-release-audit/pr8/lib/bookly.ts:433).

6. **P2 — PR #9 notification retries change the payload under an existing idempotency key.**  
   Notification content is reconstructed from the latest refund state.  
   **Reproduction:** the first refund fails; Resend accepts the cancellation email; its completion write fails. The refund later succeeds, changing the retry’s email text. A provider-faithful double returns `409` for the reused key with changed content; the obligation eventually becomes `failed` after eight attempts. The existing double overlooks this payload mismatch.  
   **Locations:** [booking-obligations.ts:103–110](/private/tmp/allstar-release-audit/repo/lib/booking-obligations.ts:103), [booking-email.ts:207–219](/private/tmp/allstar-release-audit/repo/lib/booking-email.ts:207). Resend documents this rejection in its [idempotency contract](https://resend.com/changelog/idempotency-keys).

7. **P2 — PR #9 can send duplicate notifications after a long interruption.**  
   Eight attempts bound retry count, but do not bound elapsed time. Resend retains its idempotency keys for 24 hours.  
   **Reproduction:** accept an email, fail its completion write, interrupt processing for 25 hours, then resume after provider key expiry. The same cancellation was sent twice, and the obligation finished `done`.  
   **Locations:** [booking-obligations.ts:21–24](/private/tmp/allstar-release-audit/repo/lib/booking-obligations.ts:21), [retry selection:63–82](/private/tmp/allstar-release-audit/repo/lib/booking-obligations.ts:63). Provider expiry is documented by [Resend](https://resend.com/changelog/idempotency-keys).

8. **P2 — An interrupted pre-checkout push cannot resume payment creation.**  
   The saved-request path only resumes an already-linked Checkout Session.  
   **Reproduction:** interrupt Bookly command delivery after reserving a Stripe booking but before creating Checkout. First response: `503`, asking the customer to retry. After restoring Bookly, the identical request returns `409`; the local and remote payment holds remain, with no Checkout Session.  
   **Location:** [bookings route:91–95](/private/tmp/allstar-release-audit/pr8/app/api/bookings/route.ts:91).

9. **P2 — PR #8 cannot cancel bookings inside normal vacation hours.**  
   This is **inherited from production baseline `194dea2`**. The vacation block is inserted before conflicting booking slots are released.  
   **Reproduction:** confirmed 10:00 booking; submit a vacation with `cancelConflicts:true`. PR #8 returns `409`, cancelling nothing and creating no vacation. PR #9 returns `200` and correctly performs the atomic cancellation.  
   **Location:** [PR #8 operations route:92–101](/private/tmp/allstar-release-audit/pr8/app/api/admin/operations/route.ts:92).

No P0 findings were established.

**Test results and evidence**

- `npm test`: **PASS on both exact heads**.
- Existing tests cover local same-slot concurrency, outages, lost responses, historical export exclusions, large backlogs, webhook replay, stale availability, walk-in rejection, and vacation rollback.
- PR #9’s atomic vacation cancellation, refund retries, and obligation claim fencing pass their existing tests.
- Baseline application tests against the upgraded schema passed booking-management, Backstage, email, and rendering checks. `native-api.mjs` fails on its hard-coded past date `2026-09-22`; PR #8 already corrects that fixture.
- PHP execution was unavailable because PHP is not installed. Build/lint, browser tests, and real Worker/Bookly/MySQL execution remain unverified.

Independent evidence: [PR #8 reproductions](/private/tmp/allstar-release-audit/pr8-independent.log), [PR #9 reproductions](/private/tmp/allstar-release-audit/independent.log), [notification payload retry](/private/tmp/allstar-release-audit/obligations.log). Test logs: [#8](/private/tmp/allstar-release-audit/pr8-tests.log), [#9](/private/tmp/allstar-release-audit/pr9-tests.log).

**Release safety and remaining blockers**

`BOOKLY_SYNC_ENABLED=false` prevents bridge synchronization and requests. No hard-coded production Bookly fallback was found. Historical local appointments are deliberately excluded from initial export, and mapped service durations are checked exactly.

Test Stripe protection is **conditional** on `STRIPE_REQUIRE_TEST_MODE=true`; unset, the code accepts live keys. Code inspection therefore cannot establish unconditional staging isolation. Configuration verification remains with Claude.

The migrations preserve schema compatibility for application rollback, but operational rollback needs booking paused: baseline code ignores imported Bookly occupancy, and older workers do not process PR #9’s pending obligations.

Findings 1–8 block release approval. PR #8 alone also retains finding 9.

**Recommended merge sequence:** after remediation and re-audit, integrate #9 into #8 first, validate the combined head, then integrate #8 into the release branch. Apply migration `0008` before `0009`.

**Exact NextMove:** OWNER authorizes a separate fix pass for findings 1–8, with these reproductions added as regression coverage. Keep both PRs unmerged and staging deployment on hold until the combined head passes independent verification and Claude’s infrastructure checks.
