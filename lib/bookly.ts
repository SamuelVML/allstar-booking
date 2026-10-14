/** Opt-in Bookly bridge. Secrets and customer data never reach the browser.
 * Durable commands survive HTTP timeouts. A snapshot must be complete before
 * removals are inferred. Conflicting edits are held for staff reconciliation.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { addMinutes, dateIsValid, getTodayInEindhoven, makeSlotKeys } from "@/lib/booking";
import { recordRefundDue, refundCancelledBooking, retryDueRefunds } from "@/lib/refunds";
import type { ManagedBooking } from "@/lib/booking-management";
import { backgroundBudget, meteredDatabase, SubrequestBudget, SubrequestBudgetExhausted } from "@/lib/subrequest-budget";

type BridgeEnv = { BOOKLY_SYNC_ENABLED?: string; BOOKLY_BRIDGE_URL?: string; BOOKLY_BRIDGE_SECRET?: string };
const environment = () => env as unknown as BridgeEnv;
export function booklyEnabled() { return environment().BOOKLY_SYNC_ENABLED === "true"; }
export class BooklyUnavailable extends Error {}
export class BooklyConflict extends BooklyUnavailable {}

/** Imported Bookly occupancy older than this is treated as unknown. Background
 * synchronization runs every minute (Worker Cron Trigger, plus the WordPress
 * callback), so three missed runs close customer availability and new bookings
 * until a snapshot succeeds. Live per-day Bookly checks still run on every
 * availability read and booking; this bound covers a broken background path.
 */
export const BOOKLY_MAX_OCCUPANCY_AGE_SECONDS = 180;

export async function booklyOccupancyAgeSeconds(database: D1Database, now = Date.now()) {
  const state = await database.prepare("SELECT last_success FROM bookly_sync_state WHERE id=1").first<{ last_success: string | null }>();
  const success = state?.last_success ? Date.parse(state.last_success) : NaN;
  return Number.isFinite(success) ? Math.max(0, Math.floor((now - success) / 1000)) : null;
}

/** Fail closed when the imported Bookly occupancy is missing or stale. */
export async function assertBooklyFresh(database: D1Database) {
  if (!booklyEnabled()) return;
  const age = await booklyOccupancyAgeSeconds(database);
  if (age === null || age > BOOKLY_MAX_OCCUPANCY_AGE_SECONDS) {
    throw new BooklyUnavailable("Calendar availability is out of date. Try again shortly.");
  }
}

const remoteSchema = z.object({
  remoteId: z.string().regex(/^\d+$/), localId: z.string().nullable(), kind: z.enum(["appointment", "block"]),
  version: z.string().regex(/^[a-f0-9]{64}$/), serviceId: z.string(), serviceName: z.string(),
  date: z.string().refine(dateIsValid), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endDate: z.string().refine(dateIsValid), endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().positive().max(1440), extraMinutes: z.number().int().nonnegative().max(1440),
  paddingLeftMinutes: z.number().int().nonnegative().max(240).default(0), paddingRightMinutes: z.number().int().nonnegative().max(240).default(0),
  status: z.enum(["confirmed", "payment_pending", "completed", "cancelled", "waitlisted"]),
  customerName: z.string(), customerEmail: z.string(), customerPhone: z.string(), notes: z.string(),
  priceCents: z.number().int().nonnegative(), paid: z.boolean(), group: z.boolean(),
});
type Remote = z.infer<typeof remoteSchema>;
type Link = { local_id: string; remote_id: string; remote_version: string; local_digest: string; kind: string };
type Row = ManagedBooking & { service_id: string; customer_phone: string; notes: string; source: string; payment_expires_at: string | null };
type State = {
  serviceId: string; date: string; time: string; durationMinutes: number; handlingMinutes: number;
  status: string; customerName: string; customerEmail: string; customerPhone: string; notes: string; paymentStatus: string;
};
type Command = { id: string; localId: string; kind: "appointment" | "block"; expectedVersion: string; state: State };

/** Records held for staff reconciliation (rejected commands Bookly will not
 * accept as sent, and bookings both calendars changed). Each one is isolated
 * so unrelated synchronization continues; beyond this many, synchronization
 * stops and online booking fails closed, because the calendars may be
 * diverging systematically. */
export const MAX_HELD_CONFLICTS = 10;
const LEASE_MS = 120_000;

/** Statements that make a batch commit only while `lease` still owns the sync
 * lease, renewing it in the same transaction. A worker whose lease expired or
 * was taken over fails the CHECK constraint and its whole batch rolls back:
 * no cancellation, slot release or refund record is written. */
function leaseFence(database: D1Database, lease: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  return {
    open: [
      database.prepare(`INSERT INTO bookly_revision_guards(id,valid)
        SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM bookly_sync_state WHERE id=1 AND lease=? AND lease_until > ?) THEN 1 ELSE 0 END`).bind(id, lease, now),
      database.prepare("UPDATE bookly_sync_state SET lease_until=? WHERE id=1 AND lease=?").bind(now + LEASE_MS, lease),
    ],
    close: database.prepare("DELETE FROM bookly_revision_guards WHERE id=?").bind(id),
  };
}
const isGuardFailure = (error: unknown) => error instanceof Error && error.message.includes("CHECK constraint");
async function assertLeaseHeld(database: D1Database, lease: string) {
  const state = await database.prepare("SELECT lease, lease_until FROM bookly_sync_state WHERE id=1").first<{ lease: string | null; lease_until: number }>();
  if (state?.lease !== lease || state.lease_until <= Date.now()) throw new BooklyUnavailable("Calendar sync lease expired.");
}

/** Hold a record for staff reconciliation. The latest remote version is kept
 * so staff can choose to keep the local version. A new conflict reopens a
 * resolution that had not reached both calendars yet. */
function recordConflict(database: D1Database, localId: string, reason: string, remote?: { remoteId: string; version: string | null }) {
  return database.prepare(`INSERT INTO bookly_conflicts(local_id,remote_id,remote_version,reason) VALUES (?,?,?,?)
    ON CONFLICT(local_id) DO UPDATE SET remote_id=COALESCE(excluded.remote_id,remote_id),remote_version=COALESCE(excluded.remote_version,remote_version),
      reason=excluded.reason,resolution=NULL`)
    .bind(localId, remote?.remoteId ?? null, remote?.version ?? null, reason.slice(0, 300));
}
/** Bookly changed a booking's service or duration. Adopting it would change
 * the local price, so staff cannot resolve it by keeping the Bookly version. */
const SERVICE_CHANGED = "Service or duration changed in Bookly. Review the booking before syncing its price.";

async function digest(value: unknown) {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(result), n => n.toString(16).padStart(2, "0")).join("");
}
function stateOf(row: Row): State {
  return { serviceId: row.service_id + (row.service_name.endsWith(" + colour") ? "+colour" : ""), date: row.appointment_date, time: row.start_time,
    durationMinutes: row.duration_minutes, handlingMinutes: row.handling_minutes, status: row.status,
    customerName: row.customer_name, customerEmail: row.customer_email, customerPhone: row.customer_phone,
    notes: row.notes, paymentStatus: row.payment_status };
}

export async function booklyRequest(route: string, input: unknown): Promise<unknown> {
  const config = environment();
  if (!config.BOOKLY_BRIDGE_URL || !config.BOOKLY_BRIDGE_SECRET || config.BOOKLY_BRIDGE_SECRET.length < 32) {
    throw new BooklyUnavailable("Bookly connection is not configured.");
  }
  const url = new URL(config.BOOKLY_BRIDGE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/wp-json/allstar-bookly/v1")) {
    throw new BooklyUnavailable("Invalid Bookly bridge URL.");
  }
  const body = JSON.stringify(input);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const path = `/allstar-bookly/v1/${route}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.BOOKLY_BRIDGE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}\n${nonce}\n${path}\n${body}`));
  const signature = Array.from(new Uint8Array(signed), n => n.toString(16).padStart(2, "0")).join("");
  let response;
  try {
    response = await fetch(`${url.href}/${route}`, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "X-Allstar-Timestamp": timestamp, "X-Allstar-Nonce": nonce, "X-Allstar-Signature": signature },
      body, signal: AbortSignal.timeout(25_000) });
  } catch { throw new BooklyUnavailable("Bookly could not be reached. Refresh before retrying."); }
  if (response.status === 409) throw new BooklyConflict("The appointment changed in Bookly. Resolve the pending change before retrying.");
  if (!response.ok) throw new BooklyUnavailable("Bookly connection is temporarily unavailable.");
  const text = await response.text();
  if (text.length > 5_000_000) throw new BooklyUnavailable("Bookly response exceeds the safety limit.");
  try { return JSON.parse(text); } catch { throw new BooklyUnavailable("Invalid Bookly response."); }
}

export async function filterBooklyTimes(serviceId: string, durationMinutes: number, days: { date: string; times: string[] }[], excludeLocalId?: string) {
  if (!booklyEnabled() || !days.some(day => day.times.length)) return days;
  const response = z.object({ days: z.array(z.object({ date: z.string().refine(dateIsValid), times: z.array(z.string()) })) })
    .parse(await booklyRequest("availability", { serviceId, durationMinutes, days, excludeLocalId }));
  if (response.days.length !== days.length || new Set(response.days.map(day => day.date)).size !== days.length) throw new BooklyUnavailable("Incomplete Bookly availability.");
  return days.map(day => {
    const remote = response.days.find(candidate => candidate.date === day.date);
    if (!remote || remote.times.some(time => !day.times.includes(time))) throw new BooklyUnavailable("Invalid Bookly availability.");
    return { date: day.date, times: remote.times };
  });
}

async function enqueue(database: D1Database, localId: string, kind: "appointment" | "block", state: State, link?: Link) {
  const localDigest = await digest(state);
  if (link?.local_digest === localDigest) return null;
  const command: Command = { id: crypto.randomUUID(), localId, kind, state, expectedVersion: link?.remote_version ?? "" };
  return database.prepare("INSERT OR IGNORE INTO bookly_commands(id, local_id, payload, digest) VALUES (?, ?, ?, ?)")
    .bind(command.id, localId, JSON.stringify(command), localDigest);
}

type TimeOffRow = { id: string; date: string; start_time: string; end_time: string; reason: string; removed_at: string | null };
type CommandRow = { id: string; local_id: string; payload: string; digest: string };

function blockState(block: TimeOffRow): State {
  const duration = (Number(block.end_time.slice(0,2))-Number(block.start_time.slice(0,2)))*60 + Number(block.end_time.slice(3))-Number(block.start_time.slice(3));
  return { serviceId:"", date:block.date,time:block.start_time,durationMinutes:duration,handlingMinutes:0,
    status:block.removed_at ? "removed":"confirmed", customerName:"Shop time off",customerEmail:"",customerPhone:"",notes:block.reason,paymentStatus:"not_applicable" };
}

/** Which local records may be written to Bookly. Linked records always follow
 * their Bookly twin. Unlinked records are exported only when they still occupy
 * today or a future day, so activation never recreates history in Bookly:
 * past appointments of any status, cancelled/expired/completed rows and past or
 * removed time off stay local. Bookly-origin rows are never echoed back.
 */
function exportableAppointment(row: Row, link: Link | undefined, today: string) {
  if (row.source === "bookly" || link?.remote_version === "deleted") return null;
  if (!link && (["cancelled","payment_expired","completed"].includes(row.status) || row.appointment_date < today)) return null;
  return stateOf(row);
}
function exportableBlock(block: TimeOffRow, link: Link | undefined, today: string) {
  if (!link && (block.removed_at || block.date < today)) return null;
  return blockState(block);
}

/** Statements per enqueue batch; each batch is one D1 request. */
const ENQUEUE_CHUNK = 50;

async function enqueueLocal(database: D1Database, localIds: string[] | null, today: string) {
  const links = (await database.prepare("SELECT * FROM bookly_links").all<Link>()).results;
  const linkOf = (localId: string) => links.find(item => item.local_id === localId);
  const wanted = localIds ? new Set(localIds) : null;
  // A record with a pending command gets its newer state on the next pass, after
  // delivery (the partial unique index would ignore the insert anyway). A held
  // record gets nothing until staff reconcile it, so no later change for it can
  // overtake the held one; other records are unaffected.
  const pending = new Set((await database.prepare(`SELECT local_id FROM bookly_commands WHERE status IN ('pending','held')
    UNION SELECT local_id FROM bookly_conflicts WHERE resolution IS NULL`).all<{ local_id: string }>()).results.map(row => row.local_id));
  const inserts: D1PreparedStatement[] = [];
  const rows = (await database.prepare("SELECT * FROM appointments WHERE source != 'bookly'").all<Row>()).results;
  for (const row of rows) {
    if ((wanted && !wanted.has(row.id)) || pending.has(row.id)) continue;
    const state = exportableAppointment(row, linkOf(row.id), today);
    const insert = state && await enqueue(database, row.id, "appointment", state, linkOf(row.id));
    if (insert) inserts.push(insert);
  }
  const blocks = (await database.prepare("SELECT * FROM time_off").all<TimeOffRow>()).results;
  for (const block of blocks) {
    const localId = `block-${block.id}`;
    if ((wanted && !wanted.has(localId)) || pending.has(localId)) continue;
    const state = exportableBlock(block, linkOf(localId), today);
    const insert = state && await enqueue(database, localId, "block", state, linkOf(localId));
    if (insert) inserts.push(insert);
  }
  for (let start = 0; start < inserts.length; start += ENQUEUE_CHUNK) await database.batch(inserts.slice(start, start + ENQUEUE_CHUNK));
}

/** Deliver one stored command. Safe to call concurrently for the same row: the
 * plugin keys idempotency on the command ID and payload hash, so a second
 * delivery returns the original receipt instead of writing twice. With a
 * lease (background sync) the receipt is written only while the lease is
 * still held: a worker that lost it mid-request cannot overwrite the link a
 * replacement worker has since advanced.
 */
async function sendCommand(database: D1Database, row: CommandRow, budget?: SubrequestBudget, lease?: string) {
  budget?.charge(1); // the Bookly request; its D1 writes are metered by the caller's handle
  try {
    const command = JSON.parse(row.payload) as Command;
    const result = z.object({ remoteId: z.string().regex(/^\d+$/).nullable(), version: z.string(), terminal: z.boolean().optional() })
      .parse(await booklyRequest("command", command));
    if (result.remoteId && !/^[a-f0-9]{64}$/.test(result.version)) throw new BooklyUnavailable("Invalid Bookly command receipt.");
    // Settled as delivered only while still pending. Staff may have discarded
    // the command (resolve) while it was in flight.
    const settled = "EXISTS (SELECT 1 FROM bookly_commands WHERE id=? AND status='done')";
    const discarded = "EXISTS (SELECT 1 FROM bookly_commands WHERE id=? AND status='discarded')";
    const statements = [database.prepare("UPDATE bookly_commands SET status = 'done', error = NULL WHERE id = ? AND status = 'pending'").bind(row.id)];
    if (result.remoteId) {
      statements.push(database.prepare(`INSERT INTO bookly_links(local_id,remote_id,remote_version,local_digest,kind) SELECT ?,?,?,?,? WHERE ${settled}
        ON CONFLICT(local_id) DO UPDATE SET remote_id=excluded.remote_id,remote_version=excluded.remote_version,local_digest=excluded.local_digest`)
        .bind(row.local_id, result.remoteId, result.version, row.digest, command.kind, row.id));
      // A discarded command still changed Bookly. A new record is linked so the
      // snapshot recognises it; the staff choice is reopened, with Bookly's new
      // version, because it was made before this write.
      statements.push(database.prepare(`INSERT INTO bookly_links(local_id,remote_id,remote_version,local_digest,kind) SELECT ?,?,?,?,? WHERE ${discarded}
        ON CONFLICT(local_id) DO NOTHING`).bind(row.local_id, result.remoteId, result.version, row.digest, command.kind, row.id));
      statements.push(database.prepare(`INSERT INTO bookly_conflicts(local_id,remote_id,remote_version,reason) SELECT ?,?,?,? WHERE ${discarded}
        ON CONFLICT(local_id) DO UPDATE SET remote_id=excluded.remote_id,remote_version=excluded.remote_version,reason=excluded.reason,resolution=NULL`)
        .bind(row.local_id, result.remoteId, result.version, "A discarded change reached Bookly before it was discarded. Choose which version to keep.", row.id));
    }
    // Bookly accepted the version staff chose to keep: the resolution is
    // complete and the record's email may follow.
    statements.push(database.prepare(`DELETE FROM bookly_conflicts WHERE local_id=? AND resolution='local' AND ${settled}`).bind(row.local_id, row.id));
    if (lease) {
      const fence = leaseFence(database, lease);
      try { await database.batch([...fence.open, ...statements, fence.close]); }
      catch (error) {
        if (isGuardFailure(error)) await assertLeaseHeld(database, lease);
        throw error;
      }
    } else await database.batch(statements);
  } catch (error) {
    if (!(error instanceof BooklyConflict)) {
      await database.prepare("UPDATE bookly_commands SET error = 'unavailable' WHERE id = ?").bind(row.id).run();
      throw error;
    }
    if (budget && !budget.canAfford(SETTLE_COST)) {
      // Settled by the next run, which replays attempted commands first.
      await database.prepare("UPDATE bookly_commands SET error = 'conflict' WHERE id = ?").bind(row.id).run();
      throw new SubrequestBudgetExhausted("Subrequest budget reached; the next run settles the rejected command.");
    }
    await settleRejectedCommand(database, row, JSON.parse(row.payload) as Command, lease);
    throw error;
  }
}

/** Bookly rejected a command. Never leave the local calendar claiming what
 * Bookly refused:
 * - an unpaid new hold (website request or walk-in) is cancelled;
 * - a staff reschedule is moved back to its previous time, audited as a
 *   reversal, unless anything changed since or the old time is taken;
 * - anything else is held for staff reconciliation (GET /api/admin/bookly),
 *   so it is not retried every run and blocks no unrelated command.
 * A command staff discarded while it was in flight is left as it is.
 * With a lease (background sync) every booking write is fenced on it.
 */
async function settleRejectedCommand(database: D1Database, row: CommandRow, command: Command, lease?: string) {
  // Discarded by staff while in flight: Bookly changed nothing, nothing to settle.
  if ((await database.prepare("SELECT status FROM bookly_commands WHERE id=?").bind(row.id).first<{ status: string }>())?.status !== "pending") return;
  const fence = lease ? leaseFence(database, lease) : null;
  const fenced = async (statements: D1PreparedStatement[]) => {
    try { await database.batch(fence ? [...fence.open, ...statements, fence.close] : statements); return true; }
    catch (error) {
      if (lease && isGuardFailure(error)) await assertLeaseHeld(database, lease);
      if (error instanceof Error && /CHECK constraint|UNIQUE constraint|Slot unavailable/.test(error.message)) return false;
      throw error;
    }
  };
  if (command.kind === "appointment") {
    const booking = await database.prepare("SELECT * FROM appointments WHERE id=?").bind(row.local_id).first<Row & { booking_request_id: string | null }>();
    if (booking && !command.expectedVersion && (booking.booking_request_id || booking.source === "walk_in") && booking.payment_status !== "paid") {
      if (await fenced([
        database.prepare("UPDATE appointments SET status='cancelled',revision=revision+1 WHERE id=? AND revision=?").bind(row.local_id, booking.revision),
        database.prepare("DELETE FROM appointment_slots WHERE appointment_id=? AND EXISTS (SELECT 1 FROM appointments WHERE id=? AND revision=? AND status='cancelled')")
          .bind(row.local_id, row.local_id, booking.revision + 1),
        database.prepare("UPDATE bookly_commands SET status='rejected',error='conflict' WHERE id=? AND EXISTS (SELECT 1 FROM appointments WHERE id=? AND revision=?)")
          .bind(row.id, row.local_id, booking.revision + 1),
      ]) && (await database.prepare("SELECT status FROM bookly_commands WHERE id=?").bind(row.id).first<{ status: string }>())?.status === "rejected") return;
    }
    const move = booking && command.expectedVersion && await database.prepare(`SELECT * FROM booking_changes WHERE appointment_id=? AND revision=? AND action='reschedule' AND new_date=? AND new_time=?`)
      .bind(booking.id, booking.revision, command.state.date, command.state.time)
      .first<{ id: string; revision: number; previous_date: string; previous_time: string; new_date: string; new_time: string }>();
    if (booking && move && booking.status === "confirmed" && booking.appointment_date === move.new_date && booking.start_time === move.new_time) {
      const guard = crypto.randomUUID();
      const reversal = crypto.randomUUID();
      const restored = await fenced([
        database.prepare(`INSERT INTO bookly_revision_guards(id,valid) SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM appointments
          WHERE id=? AND revision=? AND status='confirmed' AND appointment_date=? AND start_time=?) THEN 1 ELSE 0 END`)
          .bind(guard, booking.id, booking.revision, move.new_date, move.new_time),
        database.prepare(`INSERT INTO booking_changes (id, appointment_id, revision, action, actor_id, previous_date, previous_time, new_date, new_time)
          VALUES (?, ?, ?, 'reschedule', 'bookly-rejected', ?, ?, ?, ?)`)
          .bind(reversal, booking.id, booking.revision + 1, move.new_date, move.new_time, move.previous_date, move.previous_time),
        database.prepare("DELETE FROM appointment_slots WHERE appointment_id=?").bind(booking.id),
        ...makeSlotKeys(move.previous_date, move.previous_time, booking.duration_minutes + booking.handling_minutes).map(slot =>
          database.prepare("INSERT INTO appointment_slots (slot_start, appointment_id) VALUES (?, ?)").bind(slot, booking.id)),
        database.prepare("UPDATE appointments SET appointment_date=?,start_time=?,end_time=?,revision=revision+1 WHERE id=? AND revision=?")
          .bind(move.previous_date, move.previous_time, addMinutes(move.previous_time, booking.duration_minutes), booking.id, booking.revision),
        database.prepare("UPDATE bookly_commands SET status='rejected',error='conflict' WHERE id=?").bind(row.id),
        database.prepare("DELETE FROM bookly_revision_guards WHERE id=?").bind(guard),
      ]);
      if (restored) return;
    }
  }
  const link = await database.prepare("SELECT remote_id FROM bookly_links WHERE local_id=?").bind(row.local_id).first<{ remote_id: string }>();
  await fenced([
    database.prepare("UPDATE bookly_commands SET status='held',error='conflict' WHERE id=? AND status='pending'").bind(row.id),
    recordConflict(database, row.local_id, "Bookly rejected this change. Choose which version to keep.", link ? { remoteId: link.remote_id, version: null } : undefined),
  ]);
}

/** Commands delivered per background run, across both drain phases. A larger
 * backlog (initial export, long outage) drains over successive runs: delivered
 * commands are marked done as they succeed, so an interrupted run never repeats
 * or loses progress. The subrequest budget usually binds first.
 */
const DRAIN_BATCH = 100;
type DrainBudget = { remaining: number };
/** Worst-case subrequests for one command: lease renewal, the Bookly request,
 * and on failure a lookup, a batch and the error update. Settling a rejection
 * costs SETTLE_COST more, checked when it happens. */
const COMMAND_COST = 5;
/** Command status, booking and change lookups, the restoring batch, the link
 * lookup, the holding batch and a lease check after each batch. */
const SETTLE_COST = 8;
/** Worst-case subrequests for one Stripe refund: refund-record read, upsert and
 * final write in D1, plus the Checkout Session lookup and refund in Stripe. */
const REFUND_COST = 6;
/** Fixed cost of a run after the first drain: links, snapshot, appointment
 * preload, lease renewal, occupancy, export (4 reads + batches), second drain
 * read, held count, refund sweep read and the success write, with margin. */
const SNAPSHOT_RESERVE = 19;
// Commands already attempted (error set) replay first: their write may have
// reached Bookly, and the snapshot cannot be matched until they are linked.
// Fresh commands keep appointments before time off, oldest first.
const PENDING_ORDER = "ORDER BY (error IS NULL), (json_extract(payload,'$.kind') = 'block'), created_at, id";

/** Deliver pending commands while both the per-run command cap and the
 * subrequest budget allow, keeping `reserve` subrequests for the rest of the
 * run. Stops between commands, never inside one. */
async function drain(database: D1Database, lease: string, cap: DrainBudget, budget: SubrequestBudget, reserve: number) {
  const affordable = Math.floor((budget.remaining - 1 - reserve) / COMMAND_COST);
  const limit = Math.min(cap.remaining, affordable);
  if (limit <= 0) return;
  const rows = (await database.prepare(`SELECT * FROM bookly_commands WHERE status = 'pending' ${PENDING_ORDER} LIMIT ?`)
    .bind(limit).all<CommandRow>()).results;
  for (const row of rows) {
    if (!budget.canAfford(COMMAND_COST + reserve)) return;
    cap.remaining -= 1;
    const renewed = await database.prepare("UPDATE bookly_sync_state SET lease_until=? WHERE id=1 AND lease=? AND lease_until > ?")
      .bind(Date.now()+120_000,lease,Date.now()).run();
    if (renewed.meta.changes !== 1) throw new BooklyUnavailable("Calendar sync lease expired.");
    // A rejected command is settled (restored or held) inside sendCommand and
    // never stops the queue; an unreachable Bookly does.
    try { await sendCommand(database, row, budget, lease); }
    catch (error) { if (!(error instanceof BooklyConflict)) throw error; }
  }
}

/** Charge a refund up front, then run it on the unmetered handle so it can
 * never stop between its refund record and the Stripe call. */
async function refundWithin(budget: SubrequestBudget, raw: D1Database, booking: Row) {
  budget.charge(REFUND_COST);
  await refundCancelledBooking(raw, booking, "bookly-sync", { automatic: true });
}

/** Write local changes to Bookly without taking a snapshot or the sync lease.
 * Used on request paths: a website booking is pushed before checkout, so Bookly
 * (which serializes writes with a MySQL named lock) rejects a slot taken there
 * since the last snapshot; the rejected hold is cancelled locally and the
 * caller gets BooklyConflict. BooklyUnavailable leaves the command pending for
 * background replay. `localIds` limits the push; null pushes every change.
 */
export async function pushBooklyChanges(database: D1Database, localIds: string[] | null) {
  if (!booklyEnabled()) return;
  const today = getTodayInEindhoven();
  // A pending command for the same record blocks a newer one (unique index),
  // so deliver, then enqueue again until the stored state is current.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await enqueueLocal(database, localIds, today);
    // Select the requested records directly: filtering a limited queue would
    // skip them silently behind an unrelated backlog.
    const pending = (await (localIds
      ? database.prepare(`SELECT * FROM bookly_commands WHERE status = 'pending' AND local_id IN (SELECT value FROM json_each(?)) ${PENDING_ORDER}`).bind(JSON.stringify(localIds))
      : database.prepare(`SELECT * FROM bookly_commands WHERE status = 'pending' ${PENDING_ORDER} LIMIT 101`)).all<CommandRow>()).results;
    if (!pending.length) break;
    if (pending.length > 100) throw new BooklyUnavailable("Bookly has a large backlog. Background synchronization delivers it in batches.");
    // A rejection settles that record only; the others are still delivered.
    let rejected: BooklyConflict | null = null;
    for (const row of pending) {
      try { await sendCommand(database, row); }
      catch (error) { if (error instanceof BooklyConflict) rejected = error; else throw error; }
    }
    if (rejected && localIds) throw rejected;
  }
  // A requested record held for reconciliation was not written to Bookly.
  if (localIds && await database.prepare(`SELECT 1 FROM bookly_commands WHERE status='held' AND local_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .bind(JSON.stringify(localIds)).first()) throw new BooklyConflict("The appointment changed in Bookly. Staff must reconcile it before it can sync.");
}

/** For committed staff changes: refunds and notifications must still run, so
 * delivery problems are reported instead of thrown. Pending commands replay in
 * the background; conflicts stay visible at GET /api/admin/bookly.
 */
export async function pushAfterCommit(database: D1Database, localIds: string[] | null): Promise<"synced" | "pending" | "conflict" | "disabled"> {
  if (!booklyEnabled()) return "disabled";
  try { await pushBooklyChanges(database, localIds); return "synced"; }
  catch (error) {
    if (error instanceof BooklyConflict) return "conflict";
    if (error instanceof BooklyUnavailable) return "pending";
    throw error;
  }
}

type SyncContext = { budget: SubrequestBudget; raw: D1Database; lease: string };
/** A row edited locally while this run adopted it: skipped this run, compared
 * again by the next snapshot. */
class LocalEditRace extends BooklyConflict {}

/** Run a booking batch fenced on the sync lease. A failed guard is either a
 * lost lease (stop the run) or a concurrent local edit. */
async function fencedBatch(database: D1Database, lease: string, statements: D1PreparedStatement[]) {
  const fence = leaseFence(database, lease);
  try { await database.batch([...fence.open, ...statements, fence.close]); }
  catch (error) {
    if (!isGuardFailure(error)) throw error;
    await assertLeaseHeld(database, lease);
    throw new LocalEditRace("A local edit raced with Bookly synchronization.");
  }
}

async function adopt(database: D1Database, remote: Remote, link: Link | undefined, preloaded: Map<string, Row>, context: SyncContext) {
  if (remote.kind === "block") {
    if (!link) throw new BooklyUnavailable("Unrecognized Bookly time-off mapping.");
    if (link.remote_version === remote.version) return;
    const blockId = link.local_id.replace(/^block-/, "");
    const block = await database.prepare("SELECT * FROM time_off WHERE id=?").bind(blockId)
      .first<{ date: string; start_time: string; end_time: string; reason: string; removed_at: string | null }>();
    if (!block || remote.endDate !== remote.date) throw new BooklyConflict("Review the changed Bookly time off.");
    const duration = (Number(block.end_time.slice(0,2))-Number(block.start_time.slice(0,2)))*60 + Number(block.end_time.slice(3))-Number(block.start_time.slice(3));
    const local: State = { serviceId:"",date:block.date,time:block.start_time,durationMinutes:duration,handlingMinutes:0,
      status:block.removed_at ? "removed":"confirmed",customerName:"Shop time off",customerEmail:"",customerPhone:"",notes:block.reason,paymentStatus:"not_applicable" };
    if (await digest(local) !== link.local_digest) throw new BooklyConflict("Both calendars changed the same time off.");
    const removed = remote.status === "cancelled";
    const state = { ...local,date:remote.date,time:remote.time,durationMinutes:remote.durationMinutes,notes:remote.notes,status:removed ? "removed":"confirmed" };
    await fencedBatch(database, context.lease, [
      database.prepare("UPDATE time_off SET date=?,start_time=?,end_time=?,reason=?,removed_at=?,removed_by=? WHERE id=?")
        .bind(remote.date,remote.time,remote.endTime,remote.notes,removed ? new Date().toISOString():null,removed ? "bookly-sync":null,blockId),
      database.prepare("DELETE FROM time_off_slots WHERE time_off_id=?").bind(blockId),
      ...(!removed ? makeSlotKeys(remote.date,remote.time,remote.durationMinutes).map(slot => database.prepare("INSERT INTO time_off_slots(slot_start,time_off_id) VALUES (?,?)").bind(slot,blockId)):[]),
      database.prepare("UPDATE bookly_links SET remote_version=?,local_digest=? WHERE local_id=?").bind(remote.version,await digest(state),link.local_id),
      database.prepare("DELETE FROM bookly_conflicts WHERE local_id=?").bind(link.local_id),
    ]);
    return;
  }
  const id = link?.local_id ?? remote.localId ?? `bookly-${remote.remoteId}`;
  // Preloaded once per run; the revision guard below rejects a row edited since.
  const current = preloaded.get(id) ?? null;
  // Classified before any other conflict, so "keep Bookly" is refused whenever
  // Bookly's version cannot be adopted, even if the booking also changed locally.
  const serviceChanged = current && (stateOf(current).serviceId !== remote.serviceId || current.duration_minutes !== remote.durationMinutes);
  if (current && link && await digest(stateOf(current)) !== link.local_digest) {
    if (remote.version !== link.remote_version) {
      throw new BooklyConflict(serviceChanged ? SERVICE_CHANGED : "Both calendars changed the same booking. Staff reconciliation is required.");
    }
    return; // Local change is queued after this snapshot.
  }
  if (current && link?.remote_version === remote.version) return;
  if (remote.endDate !== remote.date || remote.durationMinutes > 480) throw new BooklyUnavailable("An overnight Bookly appointment needs staff review.");
  if (serviceChanged) throw new BooklyConflict(SERVICE_CHANGED);
  const status = current?.source !== "bookly" && remote.status === "payment_pending" && current?.status === "payment_pending"
    ? "payment_pending" : remote.status === "payment_pending" ? "confirmed" : remote.status;
  const cancelled = status === "cancelled";
  const incoming: State = current ? { ...stateOf(current), date: remote.date, time: remote.time, status, notes: remote.notes }
    : { serviceId: remote.serviceId, date: remote.date, time: remote.time, durationMinutes: remote.durationMinutes,
      handlingMinutes: remote.extraMinutes, status, customerName: remote.customerName, customerEmail: remote.customerEmail,
      customerPhone: remote.customerPhone, notes: remote.notes, paymentStatus: "managed_in_bookly" };
  const localDigest = await digest(incoming);
  const statements: D1PreparedStatement[] = [];
  const guard = crypto.randomUUID();
  if (current) statements.push(database.prepare(`INSERT INTO bookly_revision_guards(id,valid)
    SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM appointments WHERE id=? AND revision=? AND status=? AND payment_status=?) THEN 1 ELSE 0 END`)
    .bind(guard,current.id,current.revision,current.status,current.payment_status));
  if (!current) {
    statements.push(database.prepare(`INSERT INTO appointments(id,reference,service_id,service_name,duration_minutes,price_cents,appointment_date,start_time,end_time,customer_name,customer_email,customer_phone,notes,status,payment_method,payment_status,source,handling_minutes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'bookly',?, 'bookly',?)`)
      .bind(id, `BK-${remote.remoteId}`, remote.serviceId, remote.serviceName, remote.durationMinutes, remote.priceCents, remote.date, remote.time, remote.endTime,
        remote.customerName, remote.customerEmail, remote.customerPhone, remote.notes, status, incoming.paymentStatus, remote.extraMinutes));
  } else {
    statements.push(database.prepare(`UPDATE appointments SET appointment_date=?,start_time=?,end_time=?,status=?,notes=?,revision=revision+1
      WHERE id=? AND revision=?`).bind(remote.date,remote.time,remote.endTime,status,remote.notes,id,current.revision));
    if (status === "completed" && current.status !== "completed" && current.customer_account_id) {
      const event = crypto.randomUUID();
      statements.push(database.prepare(`INSERT OR IGNORE INTO loyalty_events(id,customer_account_id,appointment_id,points_delta,event_type) VALUES (?,?,?,1,'visit_completed')`)
        .bind(event,current.customer_account_id,id));
      statements.push(database.prepare(`UPDATE customer_accounts SET loyalty_points=loyalty_points+1,completed_visits=completed_visits+1,last_visit_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND EXISTS(SELECT 1 FROM loyalty_events WHERE id=?)`).bind(current.customer_account_id,event));
    }
    // Remove local occupancy of Worker-origin bookings moved or cancelled in Bookly.
    statements.push(database.prepare("DELETE FROM appointment_slots WHERE appointment_id = ? AND EXISTS (SELECT 1 FROM appointments WHERE id=? AND revision=?)").bind(id,id,current.revision+1));
  }
  statements.push(database.prepare(`INSERT INTO bookly_links(local_id,remote_id,remote_version,local_digest,kind) VALUES (?,?,?,?, 'appointment')
    ON CONFLICT(local_id) DO UPDATE SET remote_version=excluded.remote_version,local_digest=excluded.local_digest`)
    .bind(id,remote.remoteId,remote.version,localDigest));
  if (current) statements.push(database.prepare("DELETE FROM bookly_revision_guards WHERE id=?").bind(guard));
  statements.push(database.prepare("DELETE FROM bookly_conflicts WHERE local_id=?").bind(id));
  // A cancellation and its refund are one unit: reserve both before writing,
  // and record the refund as due in the cancelling transaction.
  const refund = cancelled && current;
  if (refund) statements.push(recordRefundDue(database, current, "bookly-sync"));
  if (!context.budget.canAfford(1 + 1 + (refund ? REFUND_COST : 0))) throw new SubrequestBudgetExhausted("Subrequest budget reached; the next run continues.");
  // Fenced: a worker that lost its lease writes nothing, so it can neither
  // cancel the booking nor make its refund due.
  await fencedBatch(database, context.lease, statements);
  if (refund) await refundWithin(context.budget, context.raw, current);
}

/** Full bounded reconciliation. Runs in the background only: the Worker Cron
 * Trigger, the signed WordPress callback and the staff "sync" action. Request
 * paths use assertBooklyFresh and pushBooklyChanges instead.
 * Lease owner checks prevent a second Worker from draining the same queue.
 */
export async function synchronizeBookly(raw: D1Database, budget: SubrequestBudget = backgroundBudget()) {
  if (!booklyEnabled()) return;
  // Every D1 call and Bookly or Stripe request below is charged to the
  // invocation's subrequest budget. Closing writes use the raw handle (the
  // budget's closing reserve). Work stops at a safe boundary and resumes.
  const database = meteredDatabase(raw, budget);
  const lease = crypto.randomUUID();
  const context: SyncContext = { budget, raw, lease };
  const acquired = await database.prepare("UPDATE bookly_sync_state SET lease=?,lease_until=? WHERE id=1 AND lease_until < ?")
    .bind(lease, Date.now() + 120_000, Date.now()).run();
  if (acquired.meta.changes !== 1) throw new BooklyUnavailable("Calendar synchronization is in progress. Try again shortly.");
  try {
    const today = getTodayInEindhoven();
    const cap: DrainBudget = { remaining: DRAIN_BATCH };
    // Replay uncertain writes before comparing snapshots, using the exact stored
    // payload and command ID, so a lost HTTP response never creates a duplicate.
    // Keep enough budget for the snapshot: fresh occupancy keeps booking open.
    await drain(database, lease, cap, budget, SNAPSHOT_RESERVE);
    // Read links before requesting the snapshot. Request paths can link new
    // bookings concurrently; only links that existed before the snapshot was
    // requested may be inferred deleted when the snapshot lacks them.
    const links = (await database.prepare("SELECT * FROM bookly_links").all<Link>()).results;
    // Occupancy age counts from the moment the snapshot was requested.
    const snapshotRequestedAt = new Date().toISOString();
    budget.charge(1);
    const snapshot = z.object({ complete: z.literal(true), scopeFrom: z.string().refine(dateIsValid), appointments: z.array(remoteSchema).max(5000) })
      .parse(await booklyRequest("snapshot", {}));
    if (new Set(snapshot.appointments.map(row => row.remoteId)).size !== snapshot.appointments.length) throw new BooklyUnavailable("Duplicate Bookly IDs.");
    // One read for every local appointment the snapshot can touch (adoption and
    // deletion inference), instead of one read per row.
    const candidateIds = [...new Set([
      ...snapshot.appointments.map(remote => links.find(item => item.remote_id === remote.remoteId)?.local_id ?? remote.localId ?? `bookly-${remote.remoteId}`),
      ...links.filter(item => item.kind === "appointment").map(item => item.local_id),
    ])];
    const preloaded = new Map((await database.prepare("SELECT * FROM appointments WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(candidateIds)).all<Row>()).results.map(row => [row.id, row]));
    // Conflicts found in this run, written with the occupancy batch.
    const conflicts: D1PreparedStatement[] = [];
    for (const remote of snapshot.appointments) {
      let link = links.find(item => item.remote_id === remote.remoteId);
      if (remote.localId && !link) {
        link = await database.prepare("SELECT * FROM bookly_links WHERE remote_id=?").bind(remote.remoteId).first<Link>() ?? undefined;
        if (link) links.push(link);
      }
      if (remote.localId && !link) throw new BooklyUnavailable("Unrecognized Bookly mapping. Recover the pending command first.");
      if (remote.localId && link && remote.localId !== link.local_id) throw new BooklyUnavailable("Bookly identity mismatch.");
      // Native Bookly history is not imported: an unlinked row is adopted only
      // while it still occupies today or a future day. Occupancy below still
      // reads every active snapshot row.
      if (!link && !remote.localId && (remote.date < today || !["confirmed","payment_pending","completed"].includes(remote.status))) continue;
      // A conflict on one booking is held for staff and never stops the run;
      // its Bookly occupancy is still applied below.
      try { await adopt(database, remote, link, preloaded, context); }
      catch (error) {
        if (error instanceof LocalEditRace) continue;
        if (!(error instanceof BooklyConflict)) throw error;
        conflicts.push(recordConflict(database, link?.local_id ?? remote.localId ?? `bookly-${remote.remoteId}`, error.message, remote));
      }
    }
    // Refresh the lease between network phases. Each remote request has a
    // 25-second timeout; loss of lease stops delivery before another write.
    const renewed = await database.prepare("UPDATE bookly_sync_state SET lease_until=? WHERE id=1 AND lease=? AND lease_until > ?")
      .bind(Date.now()+120_000,lease,Date.now()).run();
    if (renewed.meta.changes !== 1) throw new BooklyUnavailable("Calendar sync lease expired.");
    // Only linked rows can be inferred deleted; unrelated past local rows are
    // never exported automatically. Initial migration is an explicit staff step.
    for (const link of links.filter(item => item.kind === "appointment" && !snapshot.appointments.some(row => row.remoteId === item.remote_id))) {
      const listed = preloaded.get(link.local_id);
      if (listed?.source === "bookly" && listed.appointment_date < snapshot.scopeFrom) continue;
      if (listed && !["cancelled","payment_expired"].includes(listed.status)) {
        // Cancellation, slot release, refund record and link update are one
        // unit: reserve all of it, and commit it only for the exact revision
        // compared here, under this run's lease.
        if (!budget.canAfford(1 + 1 + 1 + REFUND_COST + 2)) throw new SubrequestBudgetExhausted("Subrequest budget reached; the next run continues.");
        const current = await database.prepare("SELECT * FROM appointments WHERE id=?").bind(link.local_id).first<Row>();
        if (!current || ["cancelled","payment_expired"].includes(current.status)) continue;
        const remote = { remoteId: link.remote_id, version: "deleted" };
        if (await digest(stateOf(current)) !== link.local_digest) {
          conflicts.push(recordConflict(database, current.id, "A booking changed locally was deleted in Bookly.", remote));
          continue;
        }
        const guard = crypto.randomUUID();
        try {
          await fencedBatch(database, lease, [
            database.prepare(`INSERT INTO bookly_revision_guards(id,valid) SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM appointments
              WHERE id=? AND revision=? AND status=? AND payment_status=?) THEN 1 ELSE 0 END`).bind(guard,current.id,current.revision,current.status,current.payment_status),
            database.prepare("UPDATE appointments SET status='cancelled',revision=revision+1 WHERE id=? AND revision=?").bind(current.id,current.revision),
            database.prepare("DELETE FROM appointment_slots WHERE appointment_id=?").bind(current.id),
            recordRefundDue(database, current, "bookly-sync"),
            database.prepare("UPDATE bookly_links SET remote_version='deleted',local_digest=? WHERE local_id=?")
              .bind(await digest(stateOf({ ...current, status: "cancelled" })),current.id),
            database.prepare("DELETE FROM bookly_conflicts WHERE local_id=?").bind(current.id),
            database.prepare("DELETE FROM bookly_revision_guards WHERE id=?").bind(guard),
          ]);
        } catch (error) {
          // Edited after the comparison: keep the booking and its slots.
          if (!(error instanceof LocalEditRace)) throw error;
          conflicts.push(recordConflict(database, current.id, "A booking changed locally while it was deleted in Bookly.", remote));
          continue;
        }
        await refundWithin(budget, raw, current);
      }
    }
    const occupancy: D1PreparedStatement[] = [database.prepare("DELETE FROM bookly_occupied_slots")];
    for (const remote of snapshot.appointments.filter(row => ["confirmed","payment_pending","completed"].includes(row.status))) {
      const link = links.find(item => item.remote_id === remote.remoteId);
      const id = link?.local_id ?? remote.localId ?? `bookly-${remote.remoteId}`;
      // Floor off-grid starts and ceil duration, conservatively covering Bookly's
      // minute-level timestamps in the website's five-minute occupancy grid.
      const padded = addMinutes(remote.time,-remote.paddingLeftMinutes);
      // Cross-midnight padding is outside this bridge's same-day contract.
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(padded)) throw new BooklyUnavailable("Review cross-midnight Bookly padding.");
      const offset = Number(padded.slice(3)) % 5;
      const rounded = `${padded.slice(0,3)}${String(Number(padded.slice(3))-offset).padStart(2,"0")}`;
      for (const slot of makeSlotKeys(remote.date, rounded, remote.durationMinutes + remote.extraMinutes + remote.paddingLeftMinutes + remote.paddingRightMinutes + offset)) {
        occupancy.push(database.prepare("INSERT OR IGNORE INTO bookly_occupied_slots(slot_start,appointment_id) VALUES (?,?)").bind(slot,id));
      }
    }
    await fencedBatch(database, lease, [...occupancy, ...conflicts]);
    await enqueueLocal(database, null, today);
    // Remaining budget after the held count, the sweep read and the success write.
    await drain(database, lease, cap, budget, 3);
    // Isolation is bounded: many held records suggest the calendars are
    // diverging, so stop and let availability fail closed.
    const held = await database.prepare(`SELECT COUNT(*) AS n FROM (SELECT local_id FROM bookly_commands WHERE status='held'
      UNION SELECT local_id FROM bookly_conflicts WHERE resolution IS NULL)`)
      .first<{ n: number }>();
    if ((held?.n ?? 0) > MAX_HELD_CONFLICTS) throw new BooklyConflict(`${held!.n} records are held for staff reconciliation; synchronization stops until they are resolved.`);
    // Due refunds of any origin, with backoff; the rest stay due for the next run.
    await retryDueRefunds(database, raw, budget, 20, 1);
    await database.prepare("UPDATE bookly_sync_state SET last_success=?,error=? WHERE id=1 AND lease=?")
      .bind(snapshotRequestedAt,held?.n ? "held" : null,lease).run();
  } catch (error) {
    if (error instanceof SubrequestBudgetExhausted) {
      await raw.prepare("UPDATE bookly_sync_state SET error='budget' WHERE id=1 AND lease=?").bind(lease).run();
      throw new BooklyUnavailable("Calendar synchronization paused at the subrequest budget; the next run continues.");
    }
    await raw.prepare("UPDATE bookly_sync_state SET error=? WHERE id=1 AND lease=?").bind(error instanceof BooklyConflict ? "conflict":"unavailable",lease).run();
    throw error;
  } finally {
    await raw.prepare("UPDATE bookly_sync_state SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?").bind(lease).run();
  }
}

/** Staff reconciliation of a held record (POST /api/admin/bookly, "resolve").
 * - "bookly": drop the local change; the next sync adopts Bookly's version
 *   (or, if Bookly deleted the booking, cancels and refunds it locally).
 *   Refused for a service or duration change, which would change the price,
 *   and for a record Bookly never accepted.
 * - "local": drop the rejected command; the next sync writes the local version
 *   over Bookly's latest one (or recreates it), and Bookly still arbitrates the
 *   time slot.
 * The conflict row stays, marked with the choice, until that version has
 * reached both calendars (adopted, or accepted by Bookly): until then the
 * record's customer email stays blocked, and a new conflict reopens it.
 */
export async function resolveBooklyConflict(database: D1Database, localId: string, keep: "bookly" | "local") {
  const conflict = await database.prepare("SELECT remote_version, reason FROM bookly_conflicts WHERE local_id=?").bind(localId)
    .first<{ remote_version: string | null; reason: string }>();
  const held = await database.prepare("SELECT 1 FROM bookly_commands WHERE local_id=? AND status='held'").bind(localId).first();
  if (!conflict && !held) return { ok: false as const, error: "Nothing is held for this record." };
  const link = await database.prepare("SELECT remote_version FROM bookly_links WHERE local_id=?").bind(localId).first<{ remote_version: string }>();
  const statements = [database.prepare("UPDATE bookly_commands SET status='discarded' WHERE local_id=? AND status IN ('held','pending')").bind(localId)];
  const mark = database.prepare(`INSERT INTO bookly_conflicts(local_id,reason,resolution) VALUES (?,?,?)
    ON CONFLICT(local_id) DO UPDATE SET resolution=excluded.resolution`).bind(localId, "Resolved by staff.", keep);
  const done = database.prepare("DELETE FROM bookly_conflicts WHERE local_id=?").bind(localId);
  if (keep === "local") {
    // A conflict found by a snapshot carries Bookly's latest version. A rejected
    // command whose twin never changed in Bookly carries none: the link's
    // version is then still current (a changed twin would have been recorded).
    const version = conflict?.remote_version ?? link?.remote_version ?? null;
    if (version === "deleted") {
      statements.push(database.prepare("DELETE FROM bookly_links WHERE local_id=?").bind(localId));
      // Recreated in Bookly only while it still occupies a future time.
      const row = localId.startsWith("block-") ? null : await database.prepare("SELECT * FROM appointments WHERE id=?").bind(localId).first<Row>();
      const block = localId.startsWith("block-") ? await database.prepare("SELECT * FROM time_off WHERE id=?").bind(localId.slice(6)).first<TimeOffRow>() : null;
      const today = getTodayInEindhoven();
      const recreated = row ? exportableAppointment(row, undefined, today) : block ? exportableBlock(block, undefined, today) : null;
      statements.push(recreated ? mark : done);
    } else {
      if (link && version) statements.push(database.prepare("UPDATE bookly_links SET remote_version=?,local_digest='' WHERE local_id=?").bind(version, localId));
      statements.push(mark);
    }
  } else {
    if (conflict?.reason === SERVICE_CHANGED) {
      return { ok: false as const, error: "Bookly changed this booking's service or duration. Keep the local version, or cancel and rebook it." };
    }
    // Never linked: Bookly has no version to adopt, and the next sync would
    // export the local record again.
    if (!link) return { ok: false as const, error: "Bookly has no version of this record. Keep the local version, or cancel it." };
    let state: State | null = null;
    if (localId.startsWith("block-")) {
      const block = await database.prepare("SELECT * FROM time_off WHERE id=?").bind(localId.slice(6)).first<TimeOffRow>();
      if (block) state = blockState(block);
    } else {
      const row = await database.prepare("SELECT * FROM appointments WHERE id=?").bind(localId).first<Row>();
      if (row) state = stateOf(row);
    }
    if (state) statements.push(database.prepare("UPDATE bookly_links SET remote_version='',local_digest=? WHERE local_id=?").bind(await digest(state), localId));
    statements.push(mark);
  }
  await database.batch(statements);
  return { ok: true as const };
}
