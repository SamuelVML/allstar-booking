// Regressions from the PR #8 review: command backlogs, refund retries during
// Bookly outages, partial vacation cancellations, refunded late payments and
// walk-ins rejected by Bookly. SQLite-backed D1, a Bookly double that
// arbitrates slots like the plugin, and a Stripe double that honours
// idempotency keys. This does not prove real WordPress, Stripe or Resend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const root = process.cwd();
const db = new DatabaseSync(':memory:');
for (const name of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`drizzle/${name}`, 'utf8'));
let afterBatch = null; let beforeBatch = null;
const database = {
  prepare(sql) { let values=[]; return { bind(...v){values=v;return this;}, async first(){return db.prepare(sql).get(...values)??null;},
    async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};},
  async batch(statements){if (beforeBatch) { const hook = beforeBatch; beforeBatch = null; await hook(); } db.exec('BEGIN');let result=[];try{for(const s of statements)result.push(await s.run());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    if (afterBatch) await afterBatch(); return result;},
};

/* ------------------------------------------------------------ Bookly double */
// A paid-plan budget, so the 100-commands-per-run cap is what binds here; the
// default (Workers Free) budget is exercised in tests/bookly-budget.mjs.
const env = { BOOKLY_SYNC_ENABLED: 'true', BOOKLY_BRIDGE_URL: 'https://wp.example.test/wp-json/allstar-bookly/v1', BOOKLY_BRIDGE_SECRET: 'x'.repeat(40), BOOKLY_SUBREQUEST_BUDGET: '900' };
const remote = new Map(); const receipts = new Map(); let nextId = 500;
const calls = { snapshot: 0, availability: 0, command: 0 };
let bridgeDown = false; let commandsDown = false; let downAtCommand = null; let beforeCommand = null; let loseResponse = null;
const minutes = t => Number(t.slice(0,2))*60 + Number(t.slice(3));
const clock = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const active = row => ['confirmed','payment_pending','completed'].includes(row.status);
const overlaps = (row, date, start, length) => row.date === date && minutes(row.time) < start + length && start < minutes(row.time) + row.durationMinutes + row.extraMinutes;
const hex = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function remoteRow(fields) {
  const row = { remoteId: String(nextId++), localId: null, kind: 'appointment', serviceId: 'haircut', serviceName: 'Haircut', durationMinutes: 30, extraMinutes: 0,
    status: 'confirmed', customerName: 'Native customer', customerEmail: 'native@example.test', customerPhone: '0600000000', notes: '', priceCents: 3500, paid: false, group: false, ...fields };
  row.endDate = row.date; row.endTime = clock(minutes(row.time) + row.durationMinutes); row.version = hex(row);
  remote.set(row.remoteId, row); return row;
}
async function bridgeFetch(url, options) {
  if (bridgeDown) throw new Error('connect ECONNREFUSED');
  const route = new URL(url).pathname.split('/').pop();
  const input = JSON.parse(options.body);
  calls[route] += 1;
  if (route === 'snapshot') return Response.json({ complete: true, scopeFrom: '2000-01-01', appointments: [...remote.values()].map(row => ({ ...row })) });
  if (route === 'availability') {
    return Response.json({ days: input.days.map(day => ({ date: day.date, times: day.times.filter(time =>
      ![...remote.values()].some(row => active(row) && row.localId !== input.excludeLocalId && overlaps(row, day.date, minutes(time), input.durationMinutes))) })) });
  }
  if (route === 'command') {
    if (beforeCommand) { const hook = beforeCommand; beforeCommand = null; await hook(); }
    if (downAtCommand !== null && calls.command >= downAtCommand) { downAtCommand = null; bridgeDown = true; }
    if (bridgeDown || commandsDown) throw new Error('connect ECONNREFUSED');
    if (receipts.has(input.id)) return Response.json(receipts.get(input.id));
    const s = input.state; const existing = [...remote.values()].find(row => row.localId === input.localId);
    if (existing && existing.version !== input.expectedVersion) return Response.json({ error: 'stale' }, { status: 409 });
    const status = ['payment_expired','removed'].includes(s.status) ? 'cancelled' : s.status;
    if (!existing && active({ status }) && [...remote.values()].some(row => active(row) && overlaps(row, s.date, minutes(s.time), s.durationMinutes + s.handlingMinutes))) {
      return Response.json({ error: 'slot taken' }, { status: 409 });
    }
    const row = remoteRow({ ...(existing ? { remoteId: existing.remoteId } : {}), localId: input.localId, kind: input.kind, serviceId: s.serviceId, date: s.date, time: s.time,
      durationMinutes: s.durationMinutes, extraMinutes: s.handlingMinutes, status, customerName: s.customerName, customerEmail: s.customerEmail, notes: s.notes });
    const receipt = { remoteId: row.remoteId, version: row.version }; receipts.set(input.id, receipt);
    // The write committed in Bookly but its HTTP response never arrives.
    if (loseResponse && loseResponse(input)) throw new Error('socket hang up');
    return Response.json(receipt);
  }
  throw new Error(`Unexpected route ${route}`);
}

/* ------------------------------------------------------------ Stripe double */
const stripeRefunds = new Map(); // idempotency key -> refund, like Stripe
let stripeFailures = 0;
const checkoutSessions = new Map();
const stripe = {
  checkout: { sessions: { async retrieve(id) { const session = checkoutSessions.get(id); if (!session) throw new Error('No such session'); return session; } } },
  refunds: { async create(params, options) {
    if (stripeFailures > 0) { stripeFailures -= 1; throw new Error('Stripe is unavailable'); }
    if (!stripeRefunds.has(options.idempotencyKey)) stripeRefunds.set(options.idempotencyKey, { id: `re_${stripeRefunds.size + 1}`, payment_intent: params.payment_intent });
    return stripeRefunds.get(options.idempotencyKey);
  } },
};

/* ------------------------------------------------------------- module loader */
const emails = []; // change notifications: { reference, changeId }
const modules = new Map();
function load(relative) {
  const filename = path.resolve(root, relative); if (modules.has(filename)) return modules.get(filename).exports;
  const m = { exports: {} }; modules.set(filename, m);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module: m, exports: m.exports, console: { ...console, error() {} }, crypto, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, AbortSignal, Date, Error, setTimeout, fetch: bridgeFetch,
    require(name) {
      if (name === 'cloudflare:workers') return { env };
      if (name === '@/lib/stripe') return { stripeIsConfigured: () => true, getStripeClient: () => stripe };
      if (name === '@/lib/staff-auth') return { async authoriseStaffMutation() { return { id: 'staff-1' }; } };
      if (name === '@/lib/booking-email') return {
        async sendBookingConfirmation() { return true; },
        async sendBookingChangeNotification(booking, _action, changeId) { emails.push({ reference: booking.reference, changeId }); return true; },
      };
      if (name === '@/db') return { getD1: () => database };
      if (name.startsWith('@/')) {
        const base = path.resolve(root, name.slice(2));
        return load(fs.existsSync(`${base}.ts`) ? `${name.slice(2)}.ts` : `${name.slice(2)}.tsx`);
      }
      return require(name);
    } }, { filename });
  return m.exports;
}
const bridge = load('lib/bookly.ts');
const booking = load('lib/booking.ts');
const operations = load('app/api/admin/operations/route.ts');
const sessionRoute = load('app/api/stripe/session/route.ts');
const today = booking.getTodayInEindhoven();
const day = offset => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
let refs = 0;
function localAppointment(fields) {
  const row = { id: crypto.randomUUID(), reference: `AS-R${++refs}`, service_id: 'haircut', service_name: 'Haircut', duration_minutes: 30, price_cents: 3500,
    customer_name: 'Web customer', customer_email: `web${refs}@example.test`, customer_phone: '0611111111', status: 'confirmed', payment_method: 'pay_at_shop',
    payment_status: 'due_at_shop', source: 'online', handling_minutes: 10, ...fields };
  row.end_time = clock(minutes(row.start_time) + row.duration_minutes);
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO appointments(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
  if (['confirmed','payment_pending'].includes(row.status)) {
    for (const slot of booking.makeSlotKeys(row.appointment_date, row.start_time, row.duration_minutes + row.handling_minutes)) {
      db.prepare('INSERT INTO appointment_slots(slot_start, appointment_id) VALUES (?, ?)').run(slot, row.id);
    }
  }
  return row;
}
const appointment = id => db.prepare('SELECT * FROM appointments WHERE id=?').get(id);
const pendingCommands = () => db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE status='pending'").get().n;
const markFresh = () => db.prepare('UPDATE bookly_sync_state SET last_success=?,error=NULL WHERE id=1').run(new Date().toISOString());
const markStale = () => db.prepare('UPDATE bookly_sync_state SET last_success=NULL WHERE id=1').run();
const post = async body => { const response = await operations.POST(new Request('https://allstar.test/api/admin/operations', { method: 'POST', body: JSON.stringify(body) })); return { status: response.status, body: await response.json() }; };
function reset() {
  db.exec('PRAGMA foreign_keys=OFF'); for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('bookly_sync_state','booking_settings') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all()) db.exec(`DELETE FROM ${name}`); db.exec('PRAGMA foreign_keys=ON');
  db.prepare('UPDATE bookly_sync_state SET lease=NULL,lease_until=0,last_success=NULL,error=NULL WHERE id=1').run();
  remote.clear(); receipts.clear(); emails.length = 0; stripeRefunds.clear(); stripeFailures = 0;
  bridgeDown = false; commandsDown = false; downAtCommand = null; beforeCommand = null; loseResponse = null; afterBatch = null; beforeBatch = null;
}
async function syncRun() {
  const before = calls.command;
  try { await bridge.synchronizeBookly(database); return { ok: true, commands: calls.command - before }; }
  catch (error) { return { ok: false, commands: calls.command - before, error: error.message }; }
}
const results = [];
async function check(name, fn) {
  reset();
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) { results.push(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
}

/* ---------------------------------------------- 1. bounded, resumable backlog */
function seedBacklog(count) {
  // One unlinked future booking per day; activation exports each as a command.
  return Array.from({ length: count }, (_, index) => localAppointment({ appointment_date: day(index + 1), start_time: '10:00' }));
}
function assertExported(rows) {
  const linked = [...remote.values()].filter(row => row.localId);
  assert.equal(linked.length, rows.length, 'every local booking exists exactly once in Bookly');
  assert.equal(new Set(linked.map(row => row.localId)).size, rows.length, 'no duplicate Bookly appointments');
  assert.equal(pendingCommands(), 0, 'backlog fully drained');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bookly_links').get().n, rows.length);
}
for (const size of [100, 101, 250]) {
  await check(`backlog of ${size} drains in bounded runs`, async () => {
    const rows = seedBacklog(size);
    const runs = [];
    for (let attempt = 0; attempt < 5 && (runs.length === 0 || pendingCommands() > 0 || !runs.at(-1).ok); attempt += 1) runs.push(await syncRun());
    assert.ok(runs.every(run => run.commands <= 100), `each run sends at most 100 commands (${runs.map(run => run.commands)})`);
    assert.equal(runs.length, Math.ceil(size / 100), `${size} commands need ${Math.ceil(size / 100)} runs (${JSON.stringify(runs)})`);
    assert.ok(runs.every(run => run.ok), JSON.stringify(runs));
    assertExported(rows);
    assert.ok(db.prepare('SELECT last_success FROM bookly_sync_state WHERE id=1').get().last_success, 'occupancy is fresh again');
  });
}
await check('backlog of 250 recovers after a lost response and an outage', async () => {
  const rows = seedBacklog(250);
  // Run 1: Bookly commits the 37th command but its response is lost.
  let sent = 0; loseResponse = () => ++sent === 37;
  const first = await syncRun();
  assert.equal(first.ok, false, 'lost response fails the run');
  assert.equal(first.commands, 37);
  loseResponse = null;
  // Run 2: the bridge goes down at the 23rd command of the run.
  downAtCommand = calls.command + 23;
  const second = await syncRun();
  assert.equal(second.ok, false, 'outage fails the run');
  assert.ok(second.commands <= 100);
  bridgeDown = false;
  const recovery = [];
  for (let attempt = 0; attempt < 6 && (pendingCommands() > 0 || !recovery.at(-1)?.ok); attempt += 1) recovery.push(await syncRun());
  assert.ok(recovery.every(run => run.ok && run.commands <= 100), JSON.stringify(recovery));
  assertExported(rows);
});
await check('request-path push reaches its own command behind a large backlog', async () => {
  seedBacklog(150);
  // The activation export is queued but Bookly refuses commands, leaving a backlog.
  commandsDown = true;
  const queued = await syncRun();
  assert.equal(queued.ok, false);
  commandsDown = false;
  db.prepare("UPDATE bookly_commands SET created_at='2000-01-01 00:00:00'").run();
  assert.equal(pendingCommands(), 150);
  const fresh = localAppointment({ appointment_date: day(200), start_time: '12:00' });
  await bridge.pushBooklyChanges(database, [fresh.id]);
  assert.ok([...remote.values()].some(row => row.localId === fresh.id), 'Bookly arbitrated the new booking');
  assert.equal(pendingCommands(), 150, 'the request path only sends its own command');
});

/* ---------------------------------------------- 2. refund retries during Bookly outages */
function paidCancelled(fields = {}) {
  const row = localAppointment({ appointment_date: day(3), start_time: '11:00', status: 'cancelled', payment_method: 'stripe', payment_status: 'paid',
    stripe_checkout_session_id: `cs_test_${refs + 1}`, ...fields });
  checkoutSessions.set(row.stripe_checkout_session_id, { id: row.stripe_checkout_session_id, payment_status: 'paid', payment_intent: `pi_${row.id}`, metadata: { appointment_id: row.id } });
  return row;
}
await check('retry_refund and shop payments work while Bookly occupancy is stale', async () => {
  const cancelled = paidCancelled();
  const shop = localAppointment({ appointment_date: day(4), start_time: '12:00' });
  markStale(); bridgeDown = true;
  const refund = await post({ action: 'retry_refund', id: crypto.randomUUID(), reference: cancelled.reference, revision: 0 });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  assert.equal(refund.body.refundStatus, 'refunded');
  assert.equal(appointment(cancelled.id).payment_status, 'refunded');
  const payment = await post({ action: 'payment', id: crypto.randomUUID(), reference: shop.reference, revision: 0, method: 'cash' });
  assert.equal(payment.status, 200, JSON.stringify(payment.body));
  assert.equal(appointment(shop.id).payment_status, 'paid');
  // Calendar-dependent operations still fail closed.
  const walkIn = await post({ action: 'walk_in', id: crypto.randomUUID(), date: day(5), time: '14:00', serviceId: 'haircut', name: 'Walk-in', notes: '' });
  assert.equal(walkIn.status, 503);
  const block = await post({ action: 'block', id: crypto.randomUUID(), date: day(5), start: '15:00', end: '15:30', reason: 'Closed' });
  assert.equal(block.status, 503);
});
await check('repeated refund retries never refund twice', async () => {
  const cancelled = paidCancelled();
  markStale(); bridgeDown = true; stripeFailures = 1;
  const failed = await post({ action: 'retry_refund', id: crypto.randomUUID(), reference: cancelled.reference, revision: 0 });
  assert.equal(failed.status, 200); assert.equal(failed.body.refundStatus, 'pending');
  const retried = await post({ action: 'retry_refund', id: crypto.randomUUID(), reference: cancelled.reference, revision: 0 });
  assert.equal(retried.body.refundStatus, 'refunded');
  const again = await post({ action: 'retry_refund', id: crypto.randomUUID(), reference: cancelled.reference, revision: appointment(cancelled.id).revision });
  assert.equal(again.status, 409, 'a refunded booking has no pending refund');
  assert.equal(stripeRefunds.size, 1, 'one Stripe refund');
  assert.equal(db.prepare("SELECT status FROM payment_refunds WHERE appointment_id=?").get(cancelled.id).status, 'succeeded');
});

/* ---------------------------------------------- 3. partial vacation cancellation */
// The time-off trigger (0004) refuses a vacation over booked slots, so the
// cancellation loop runs for bookings outside the current opening hours (for
// example after the hours were edited). Those start at 08:00 here.
await check('a concurrent edit during a vacation cancels, refunds and emails nothing; a retry does each once', async () => {
  // Cancellations, slot release, obligations and the vacation commit in one
  // transaction (fix/vacation-over-bookings), so a booking edited while the
  // vacation is saved rolls the whole operation back instead of leaving a
  // partial set of cancellations.
  markFresh();
  const date = day(9);
  const first = localAppointment({ appointment_date: date, start_time: '08:00', payment_method: 'stripe', payment_status: 'paid', stripe_checkout_session_id: 'cs_test_v1' });
  checkoutSessions.set('cs_test_v1', { id: 'cs_test_v1', payment_status: 'paid', payment_intent: 'pi_v1', metadata: { appointment_id: first.id } });
  const second = localAppointment({ appointment_date: date, start_time: '08:45' });
  beforeBatch = async () => { db.prepare('UPDATE appointments SET revision=revision+1 WHERE id=?').run(second.id); };
  const response = await post({ action: 'block_range', id: crypto.randomUUID(), fromDate: date, toDate: date, reason: 'Vacation', cancelConflicts: true });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(appointment(first.id).status, 'confirmed', 'nothing was cancelled');
  assert.equal(appointment(first.id).payment_status, 'paid');
  assert.equal(stripeRefunds.size, 0, 'nothing was refunded');
  assert.equal(emails.length, 0, 'nobody was emailed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM time_off WHERE date=?').get(date).n, 0, 'the vacation was not blocked');
  const retried = await post({ action: 'block_range', id: crypto.randomUUID(), fromDate: date, toDate: date, reason: 'Vacation', cancelConflicts: true });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(appointment(first.id).payment_status, 'refunded');
  assert.equal(appointment(second.id).status, 'cancelled');
  assert.equal(stripeRefunds.size, 1);
  assert.deepEqual(emails.map(email => email.reference).sort(), [first.reference, second.reference].sort(), 'each customer emailed once');
  const retry = await post({ action: 'retry_refund', id: crypto.randomUUID(), reference: first.reference, revision: appointment(first.id).revision });
  assert.equal(retry.status, 409, 'no pending refund remains');
  assert.equal(stripeRefunds.size, 1);
});
await check('a failed refund during vacation cancellation stays durably retryable', async () => {
  markFresh();
  const date = day(10);
  const first = localAppointment({ appointment_date: date, start_time: '08:00', payment_method: 'stripe', payment_status: 'paid', stripe_checkout_session_id: 'cs_test_v2' });
  checkoutSessions.set('cs_test_v2', { id: 'cs_test_v2', payment_status: 'paid', payment_intent: 'pi_v2', metadata: { appointment_id: first.id } });
  const second = localAppointment({ appointment_date: date, start_time: '08:45' });
  stripeFailures = 1;
  const response = await post({ action: 'block_range', id: crypto.randomUUID(), fromDate: date, toDate: date, reason: 'Vacation', cancelConflicts: true });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.refundsPending, 1);
  assert.equal(appointment(second.id).status, 'cancelled');
  assert.equal(db.prepare("SELECT status FROM payment_refunds WHERE appointment_id=?").get(first.id).status, 'failed', 'failure is recorded');
  assert.equal(emails.length, 2, 'both customers were emailed once');
  markStale(); bridgeDown = true; // and recovery works during a Bookly outage
  const retry = await post({ action: 'retry_refund', id: crypto.randomUUID(), reference: first.reference, revision: appointment(first.id).revision });
  assert.equal(retry.body.refundStatus, 'refunded');
  assert.equal(stripeRefunds.size, 1);
  assert.equal(emails.length, 2, 'retrying a refund sends no second email');
});

/* ---------------------------------------------- 4. refunded late payments */
async function lookup(sessionId) {
  const response = await sessionRoute.GET(new Request(`https://allstar.test/api/stripe/session?session_id=${sessionId}`));
  return { status: response.status, body: await response.json() };
}
await check('a payment completed after the hold expired never shows a confirmation', async () => {
  const late = localAppointment({ appointment_date: day(6), start_time: '10:00', status: 'payment_expired', payment_method: 'stripe', payment_status: 'expired', stripe_checkout_session_id: 'cs_test_late' });
  db.prepare('DELETE FROM appointment_slots WHERE appointment_id=?').run(late.id);
  checkoutSessions.set('cs_test_late', { id: 'cs_test_late', payment_status: 'paid', payment_intent: 'pi_late', metadata: { appointment_id: late.id } });
  for (const attempt of ['redirect', 'refresh', 'second refresh']) {
    const result = await lookup('cs_test_late');
    assert.equal(result.status, 409, `${attempt}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.booking, undefined, `${attempt}: no booking is returned`);
    assert.equal(result.body.outcome, 'cancelled');
    assert.equal(result.body.refunded, true);
  }
  assert.equal(appointment(late.id).status, 'cancelled');
  assert.equal(stripeRefunds.size, 1, 'refunded once across refreshes');
  const view = load('lib/payment-outcome.ts');
  assert.equal(view.sessionOutcome(false, { outcome: 'cancelled', refunded: true, error: 'x' }).kind, 'cancelled');
  assert.equal(view.sessionOutcome(true, { booking: { reference: 'A' } }).kind, 'confirmed');
  assert.equal(view.sessionOutcome(false, { error: 'Payment is still processing.' }).kind, 'error');
  const page = fs.readFileSync('app/book/success/payment-success.tsx', 'utf8');
  assert.match(page, /sessionOutcome\(response\.ok/, 'the success page reads the outcome before rendering');
  assert.match(page, /outcome\.kind === "cancelled"/, 'the success page handles the cancelled outcome');
});
await check('a late payment whose refund failed reports the pending refund, not a booking', async () => {
  const late = localAppointment({ appointment_date: day(6), start_time: '12:00', status: 'cancelled', payment_method: 'stripe', payment_status: 'pending', stripe_checkout_session_id: 'cs_test_late2' });
  db.prepare('DELETE FROM appointment_slots WHERE appointment_id=?').run(late.id);
  checkoutSessions.set('cs_test_late2', { id: 'cs_test_late2', payment_status: 'paid', payment_intent: 'pi_late2', metadata: { appointment_id: late.id } });
  stripeFailures = 1;
  const result = await lookup('cs_test_late2');
  assert.equal(result.status, 409);
  assert.equal(result.body.outcome, 'cancelled');
  assert.equal(result.body.refunded, false);
  const confirmed = localAppointment({ appointment_date: day(6), start_time: '15:00', status: 'payment_pending', payment_method: 'stripe', payment_status: 'pending', stripe_checkout_session_id: 'cs_test_ok' });
  checkoutSessions.set('cs_test_ok', { id: 'cs_test_ok', payment_status: 'paid', payment_intent: 'pi_ok', metadata: { appointment_id: confirmed.id } });
  const odd = localAppointment({ appointment_date: day(6), start_time: '17:00', status: 'payment_pending', payment_method: 'stripe', payment_status: 'paid', stripe_checkout_session_id: 'cs_test_odd' });
  checkoutSessions.set('cs_test_odd', { id: 'cs_test_odd', payment_status: 'paid', payment_intent: 'pi_odd', metadata: { appointment_id: odd.id } });
  const unconfirmed = await lookup('cs_test_odd');
  assert.equal(unconfirmed.status, 409, 'an unconfirmed booking is never shown as booked');
  assert.equal(unconfirmed.body.booking, undefined);
  assert.equal(unconfirmed.body.outcome, undefined, 'nor reported as cancelled');
  const ok = await lookup('cs_test_ok');
  assert.equal(ok.status, 200); assert.equal(ok.body.booking.reference, confirmed.reference);
});

/* ---------------------------------------------- 5. walk-ins rejected by Bookly */
await check('a walk-in taken in Bookly after the live check is reported as failed', async () => {
  markFresh();
  const date = day(2);
  // A native Bookly booking lands between the live availability check and the push.
  beforeCommand = async () => { remoteRow({ date, time: '16:00' }); };
  const id = crypto.randomUUID();
  const response = await post({ action: 'walk_in', id, date, time: '16:00', serviceId: 'haircut', name: 'Walk-in', notes: '' });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.saved, undefined);
  assert.equal(appointment(id).status, 'cancelled', 'the local walk-in was released');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointment_slots WHERE appointment_id=?').get(id).n, 0);
});
await check('a walk-in Bookly has not confirmed is not reported as added', async () => {
  markFresh();
  const id = crypto.randomUUID();
  beforeCommand = async () => { bridgeDown = true; };
  const response = await post({ action: 'walk_in', id, date: day(2), time: '13:00', serviceId: 'haircut', name: 'Walk-in', notes: '' });
  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.equal(appointment(id).status, 'confirmed', 'the reservation is retained for background replay');
  assert.equal(pendingCommands(), 1);
  bridgeDown = false;
  const accepted = crypto.randomUUID();
  const ok = await post({ action: 'walk_in', id: accepted, date: day(2), time: '18:00', serviceId: 'haircut', name: 'Walk-in', notes: '' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.saved, true);
  assert.ok([...remote.values()].some(row => row.localId === accepted), 'success only after Bookly accepted it');
});

console.log(results.join('\n'));
const failed = results.filter(line => line.startsWith('FAIL'));
if (failed.length) { console.error(`${failed.length} regression check(s) failed`); process.exit(1); }
console.log('PASS: bounded resumable backlog (100/101/250, interruption, lost response), refund retries during outages, partial vacation cancellation, refunded late payments, walk-ins rejected by Bookly');
