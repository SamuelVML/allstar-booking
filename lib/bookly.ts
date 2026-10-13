/** Opt-in Bookly bridge. Secrets and customer data never reach the browser.
 * Durable commands survive HTTP timeouts. A snapshot must be complete before
 * removals are inferred. Conflicting edits are held for staff reconciliation.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { addMinutes, dateIsValid, getTodayInEindhoven, makeSlotKeys } from "@/lib/booking";
import { refundCancelledBooking } from "@/lib/refunds";
import type { ManagedBooking } from "@/lib/booking-management";

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
  if (link?.local_digest === localDigest) return;
  const command: Command = { id: crypto.randomUUID(), localId, kind, state, expectedVersion: link?.remote_version ?? "" };
  await database.prepare("INSERT OR IGNORE INTO bookly_commands(id, local_id, payload, digest) VALUES (?, ?, ?, ?)")
    .bind(command.id, localId, JSON.stringify(command), localDigest).run();
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

async function enqueueLocal(database: D1Database, localIds: string[] | null, today: string) {
  const links = (await database.prepare("SELECT * FROM bookly_links").all<Link>()).results;
  const linkOf = (localId: string) => links.find(item => item.local_id === localId);
  const wanted = localIds ? new Set(localIds) : null;
  const rows = (await database.prepare("SELECT * FROM appointments WHERE source != 'bookly'").all<Row>()).results;
  for (const row of rows) {
    if (wanted && !wanted.has(row.id)) continue;
    const state = exportableAppointment(row, linkOf(row.id), today);
    if (state) await enqueue(database, row.id, "appointment", state, linkOf(row.id));
  }
  const blocks = (await database.prepare("SELECT * FROM time_off").all<TimeOffRow>()).results;
  for (const block of blocks) {
    const localId = `block-${block.id}`;
    if (wanted && !wanted.has(localId)) continue;
    const state = exportableBlock(block, linkOf(localId), today);
    if (state) await enqueue(database, localId, "block", state, linkOf(localId));
  }
}

/** Deliver one stored command. Safe to call concurrently for the same row: the
 * plugin keys idempotency on the command ID and payload hash, so a second
 * delivery returns the original receipt instead of writing twice.
 */
async function sendCommand(database: D1Database, row: CommandRow) {
  try {
    const command = JSON.parse(row.payload) as Command;
    const result = z.object({ remoteId: z.string().regex(/^\d+$/).nullable(), version: z.string(), terminal: z.boolean().optional() })
      .parse(await booklyRequest("command", command));
    if (result.remoteId && !/^[a-f0-9]{64}$/.test(result.version)) throw new BooklyUnavailable("Invalid Bookly command receipt.");
    const statements = [database.prepare("UPDATE bookly_commands SET status = 'done', error = NULL WHERE id = ?").bind(row.id)];
    if (result.remoteId) statements.push(database.prepare(`INSERT INTO bookly_links(local_id,remote_id,remote_version,local_digest,kind) VALUES (?,?,?,?,?)
      ON CONFLICT(local_id) DO UPDATE SET remote_id=excluded.remote_id,remote_version=excluded.remote_version,local_digest=excluded.local_digest`)
      .bind(row.local_id, result.remoteId, result.version, row.digest, command.kind));
    await database.batch(statements);
  } catch (error) {
    const command = JSON.parse(row.payload) as Command;
    if (error instanceof BooklyConflict && command.kind === "appointment" && !command.expectedVersion) {
      const booking = await database.prepare("SELECT source,booking_request_id,payment_status FROM appointments WHERE id=?").bind(row.local_id)
        .first<{ source: string; booking_request_id: string | null; payment_status: string }>();
      if (booking && (booking.booking_request_id || booking.source === "walk_in") && booking.payment_status !== "paid") {
        await database.batch([
          database.prepare("UPDATE appointments SET status='cancelled',revision=revision+1 WHERE id=?").bind(row.local_id),
          database.prepare("DELETE FROM appointment_slots WHERE appointment_id=?").bind(row.local_id),
          database.prepare("UPDATE bookly_commands SET status='rejected',error='conflict' WHERE id=?").bind(row.id),
        ]);
      }
    }
    await database.prepare("UPDATE bookly_commands SET error = ? WHERE id = ?").bind(error instanceof BooklyConflict ? "conflict" : "unavailable", row.id).run();
    throw error;
  }
}

/** Commands delivered per background run, across both drain phases. A larger
 * backlog (initial export, long outage) drains over successive runs: delivered
 * commands are marked done as they succeed, so an interrupted run never repeats
 * or loses progress.
 */
const DRAIN_BATCH = 100;
type DrainBudget = { remaining: number };
// Commands already attempted (error set) replay first: their write may have
// reached Bookly, and the snapshot cannot be matched until they are linked.
// Fresh commands keep appointments before time off, oldest first.
const PENDING_ORDER = "ORDER BY (error IS NULL), (json_extract(payload,'$.kind') = 'block'), created_at, id";

async function drain(database: D1Database, lease: string, budget: DrainBudget) {
  if (budget.remaining <= 0) return;
  const rows = (await database.prepare(`SELECT * FROM bookly_commands WHERE status = 'pending' ${PENDING_ORDER} LIMIT ?`)
    .bind(budget.remaining).all<CommandRow>()).results;
  for (const row of rows) {
    budget.remaining -= 1;
    const renewed = await database.prepare("UPDATE bookly_sync_state SET lease_until=? WHERE id=1 AND lease=? AND lease_until > ?")
      .bind(Date.now()+120_000,lease,Date.now()).run();
    if (renewed.meta.changes !== 1) throw new BooklyUnavailable("Calendar sync lease expired.");
    await sendCommand(database, row);
  }
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
    if (!pending.length) return;
    if (pending.length > 100) throw new BooklyUnavailable("Bookly has a large backlog. Background synchronization delivers it in batches.");
    for (const row of pending) await sendCommand(database, row);
  }
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

async function adopt(database: D1Database, remote: Remote, link?: Link) {
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
    await database.batch([
      database.prepare("UPDATE time_off SET date=?,start_time=?,end_time=?,reason=?,removed_at=?,removed_by=? WHERE id=?")
        .bind(remote.date,remote.time,remote.endTime,remote.notes,removed ? new Date().toISOString():null,removed ? "bookly-sync":null,blockId),
      database.prepare("DELETE FROM time_off_slots WHERE time_off_id=?").bind(blockId),
      ...(!removed ? makeSlotKeys(remote.date,remote.time,remote.durationMinutes).map(slot => database.prepare("INSERT INTO time_off_slots(slot_start,time_off_id) VALUES (?,?)").bind(slot,blockId)):[]),
      database.prepare("UPDATE bookly_links SET remote_version=?,local_digest=? WHERE local_id=?").bind(remote.version,await digest(state),link.local_id),
    ]);
    return;
  }
  const id = link?.local_id ?? remote.localId ?? `bookly-${remote.remoteId}`;
  const current = await database.prepare("SELECT * FROM appointments WHERE id = ?").bind(id).first<Row>();
  if (current && link && await digest(stateOf(current)) !== link.local_digest) {
    if (remote.version !== link.remote_version) throw new BooklyConflict("Both calendars changed the same booking. Staff reconciliation is required.");
    return; // Local change is queued after this snapshot.
  }
  if (current && link?.remote_version === remote.version) return;
  if (remote.endDate !== remote.date || remote.durationMinutes > 480) throw new BooklyUnavailable("An overnight Bookly appointment needs staff review.");
  if (current && (stateOf(current).serviceId !== remote.serviceId || current.duration_minutes !== remote.durationMinutes)) {
    throw new BooklyConflict("Service or duration changed in Bookly. Review the booking before syncing its price.");
  }
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
  try { await database.batch(statements); }
  catch (error) {
    if (error instanceof Error && error.message.includes("CHECK constraint")) throw new BooklyConflict("A local edit raced with Bookly synchronization.");
    throw error;
  }
  if (cancelled && current) await refundCancelledBooking(database, current, "bookly-sync");
}

/** Full bounded reconciliation. Runs in the background only: the Worker Cron
 * Trigger, the signed WordPress callback and the staff "sync" action. Request
 * paths use assertBooklyFresh and pushBooklyChanges instead.
 * Lease owner checks prevent a second Worker from draining the same queue.
 */
export async function synchronizeBookly(database: D1Database) {
  if (!booklyEnabled()) return;
  const lease = crypto.randomUUID();
  const acquired = await database.prepare("UPDATE bookly_sync_state SET lease=?,lease_until=? WHERE id=1 AND lease_until < ?")
    .bind(lease, Date.now() + 120_000, Date.now()).run();
  if (acquired.meta.changes !== 1) throw new BooklyUnavailable("Calendar synchronization is in progress. Try again shortly.");
  try {
    const today = getTodayInEindhoven();
    const budget: DrainBudget = { remaining: DRAIN_BATCH };
    // Replay uncertain writes before comparing snapshots, using the exact stored
    // payload and command ID, so a lost HTTP response never creates a duplicate.
    await drain(database, lease, budget);
    // Read links before requesting the snapshot. Request paths can link new
    // bookings concurrently; only links that existed before the snapshot was
    // requested may be inferred deleted when the snapshot lacks them.
    const links = (await database.prepare("SELECT * FROM bookly_links").all<Link>()).results;
    // Occupancy age counts from the moment the snapshot was requested.
    const snapshotRequestedAt = new Date().toISOString();
    const snapshot = z.object({ complete: z.literal(true), scopeFrom: z.string().refine(dateIsValid), appointments: z.array(remoteSchema).max(5000) })
      .parse(await booklyRequest("snapshot", {}));
    if (new Set(snapshot.appointments.map(row => row.remoteId)).size !== snapshot.appointments.length) throw new BooklyUnavailable("Duplicate Bookly IDs.");
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
      await adopt(database, remote, link);
    }
    // Refresh the lease between network phases. Each remote request has a
    // 25-second timeout; loss of lease stops delivery before another write.
    const renewed = await database.prepare("UPDATE bookly_sync_state SET lease_until=? WHERE id=1 AND lease=? AND lease_until > ?")
      .bind(Date.now()+120_000,lease,Date.now()).run();
    if (renewed.meta.changes !== 1) throw new BooklyUnavailable("Calendar sync lease expired.");
    // Only linked rows can be inferred deleted; unrelated past local rows are
    // never exported automatically. Initial migration is an explicit staff step.
    for (const link of links.filter(item => item.kind === "appointment" && !snapshot.appointments.some(row => row.remoteId === item.remote_id))) {
      const current = await database.prepare("SELECT * FROM appointments WHERE id=?").bind(link.local_id).first<Row>();
      if (current?.source === "bookly" && current.appointment_date < snapshot.scopeFrom) continue;
      if (current && !["cancelled","payment_expired"].includes(current.status)) {
        if (await digest(stateOf(current)) !== link.local_digest) throw new BooklyConflict("A changed booking was deleted in Bookly.");
        await database.batch([
          database.prepare("UPDATE appointments SET status='cancelled',revision=revision+1 WHERE id=? AND revision=?").bind(current.id,current.revision),
          database.prepare("DELETE FROM appointment_slots WHERE appointment_id=?").bind(current.id),
        ]);
        await refundCancelledBooking(database,current,"bookly-sync");
        const terminal = await database.prepare("SELECT * FROM appointments WHERE id=?").bind(current.id).first<Row>();
        if (terminal) await database.prepare("UPDATE bookly_links SET remote_version='deleted',local_digest=? WHERE local_id=?")
          .bind(await digest(stateOf(terminal)),current.id).run();
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
    await database.batch(occupancy);
    await enqueueLocal(database, null, today);
    await drain(database, lease, budget);
    const refunds = (await database.prepare(`SELECT a.* FROM appointments a JOIN payment_refunds r ON r.appointment_id=a.id
      WHERE a.status='cancelled' AND a.payment_method='stripe' AND a.payment_status='paid' AND r.status='pending'`).all<Row>()).results;
    for (const booking of refunds) await refundCancelledBooking(database,booking,"bookly-sync");
    await database.prepare("UPDATE bookly_sync_state SET last_success=?,error=NULL WHERE id=1 AND lease=?")
      .bind(snapshotRequestedAt,lease).run();
  } catch (error) {
    await database.prepare("UPDATE bookly_sync_state SET error=? WHERE id=1 AND lease=?").bind(error instanceof BooklyConflict ? "conflict":"unavailable",lease).run();
    throw error;
  } finally {
    await database.prepare("UPDATE bookly_sync_state SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?").bind(lease).run();
  }
}
