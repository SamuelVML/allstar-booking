// Regressions for the eight release-blocking findings of the independent
// release audit of PR #8 (ea4affa) and PR #9 (461b02b). Each check first
// reproduces the audited failure condition, then asserts the corrected
// behaviour. SQLite-backed D1 (real migrations and triggers), the real routes,
// bridge, refund, obligation and email modules; a Bookly double that
// arbitrates slots like the plugin, a Stripe double that honours idempotency
// keys and Checkout expiry limits, and a Resend double that rejects a reused
// key with a changed payload and can forget keys like the 24-hour retention.
// Not a real Worker, WordPress, Stripe or Resend.
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
let beforeBatch = null;
const database = {
  prepare(sql) { let values = []; return { bind(...v) { values = v; return this; },
    async first() { return db.prepare(sql).get(...values) ?? null; },
    async all() { return { results: db.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; } }; },
  async batch(statements) {
    if (beforeBatch) { const hook = beforeBatch; beforeBatch = null; await hook(); }
    db.exec('BEGIN'); const result = [];
    try { for (const s of statements) result.push(await s.run()); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    return result;
  },
};

/* ------------------------------------------------------------------- clock */
let clockOffset = 0;
class TestDate extends Date {
  constructor(...args) { if (args.length === 0) super(Date.now() + clockOffset); else super(...args); }
  static now() { return Date.now() + clockOffset; }
}

/* ------------------------------------------------------------ Bookly double */
const env = { BOOKLY_SYNC_ENABLED: 'true', BOOKLY_BRIDGE_URL: 'https://wp.example.test/wp-json/allstar-bookly/v1', BOOKLY_BRIDGE_SECRET: 'x'.repeat(40),
  BOOKLY_SUBREQUEST_BUDGET: '900', RESEND_API_KEY: 're_test', BOOKING_EMAIL_FROM: 'All Star <bookings@example.test>', BOOKING_BUSINESS_NAME: 'All Star', BOOKING_ADMIN_EMAIL: '' };
const remote = new Map(); const receipts = new Map(); let nextId = 500;
const calls = { snapshot: 0, availability: 0, command: 0 };
let commandsDown = false; let bridgeDown = false; let beforeCommand = null; const commandLog = [];
const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const clock = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const active = row => ['confirmed', 'payment_pending', 'completed'].includes(row.status);
const overlaps = (row, date, start, length) => row.date === date && minutes(row.time) < start + length && start < minutes(row.time) + row.durationMinutes + row.extraMinutes;
const hex = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function remoteRow(fields) {
  const row = { remoteId: String(nextId++), localId: null, kind: 'appointment', serviceId: 'haircut', serviceName: 'Haircut', durationMinutes: 30, extraMinutes: 0,
    status: 'confirmed', customerName: 'Native customer', customerEmail: 'native@example.test', customerPhone: '0600000000', notes: '', priceCents: 3500, paid: false, group: false, ...fields };
  delete row.version; row.endDate = row.date; row.endTime = clock(minutes(row.time) + row.durationMinutes); row.version = hex({ ...row, nonce: nextId });
  remote.set(row.remoteId, row); return row;
}
async function bridgeFetch(url, options) {
  const route = new URL(url).pathname.split('/').pop();
  const input = JSON.parse(options.body);
  calls[route] += 1;
  if (bridgeDown) throw new Error('connect ECONNREFUSED');
  if (route === 'snapshot') return Response.json({ complete: true, scopeFrom: '2000-01-01', appointments: [...remote.values()].map(row => ({ ...row })) });
  if (route === 'availability') {
    return Response.json({ days: input.days.map(day => ({ date: day.date, times: day.times.filter(time =>
      ![...remote.values()].some(row => active(row) && row.localId !== input.excludeLocalId && overlaps(row, day.date, minutes(time), input.durationMinutes))) })) });
  }
  if (route === 'command') {
    if (beforeCommand) { const hook = beforeCommand; beforeCommand = null; await hook(); }
    if (commandsDown) throw new Error('connect ECONNREFUSED');
    commandLog.push(input.localId);
    if (receipts.has(input.id)) return Response.json(receipts.get(input.id));
    const s = input.state; const existing = [...remote.values()].find(row => row.localId === input.localId);
    if (existing && existing.version !== input.expectedVersion) return Response.json({ error: 'stale' }, { status: 409 });
    const status = ['payment_expired', 'removed'].includes(s.status) ? 'cancelled' : s.status;
    if (active({ status }) && [...remote.values()].some(row => row.remoteId !== existing?.remoteId && active(row) && overlaps(row, s.date, minutes(s.time), s.durationMinutes + s.handlingMinutes))) {
      return Response.json({ error: 'slot taken' }, { status: 409 });
    }
    const row = remoteRow({ ...(existing ? { remoteId: existing.remoteId } : {}), localId: input.localId, kind: input.kind, serviceId: s.serviceId, date: s.date, time: s.time,
      durationMinutes: s.durationMinutes, extraMinutes: s.handlingMinutes, status, customerName: s.customerName, customerEmail: s.customerEmail, notes: s.notes });
    const receipt = { remoteId: row.remoteId, version: row.version }; receipts.set(input.id, receipt);
    return Response.json(receipt);
  }
  throw new Error(`Unexpected route ${route}`);
}

/* ------------------------------------------------------------ Stripe double */
const stripeRefunds = new Map(); let stripeRefundCalls = 0; let stripeFailures = 0;
const checkoutSessions = new Map(); const checkoutKeys = new Map(); let checkoutCreates = 0;
// 'uncertain': the session is created but the response is lost; 'definite': Stripe rejects the request.
let checkoutFailure = null; let afterCheckoutCreate = null;
const stripe = {
  checkout: { sessions: {
    async retrieve(id) { const session = checkoutSessions.get(id); if (!session) throw new Error('No such session'); return session; },
    async create(params, options = {}) {
      if (checkoutFailure === 'definite') { checkoutFailure = null; throw Object.assign(new Error('Invalid request'), { type: 'StripeInvalidRequestError', statusCode: 400 }); }
      const key = options.idempotencyKey;
      if (key && checkoutKeys.has(key)) {
        const previous = checkoutKeys.get(key);
        if (JSON.stringify(previous.params) !== JSON.stringify(params)) throw new Error('Keys for idempotent requests can only be used with the same parameters');
        return previous.session;
      }
      // Stripe requires expires_at between 30 minutes and 24 hours ahead.
      if (params.expires_at !== undefined && params.expires_at < Math.floor(TestDate.now() / 1000) + 30 * 60) throw new Error('expires_at must be at least 30 minutes in the future');
      checkoutCreates += 1;
      const session = { id: `cs_test_${checkoutCreates}`, url: `https://checkout.example.test/${checkoutCreates}`, metadata: params.metadata, payment_status: 'unpaid', payment_intent: `pi_${checkoutCreates}` };
      checkoutSessions.set(session.id, session); if (key) checkoutKeys.set(key, { params, session });
      if (afterCheckoutCreate) { const hook = afterCheckoutCreate; afterCheckoutCreate = null; await hook(); }
      if (checkoutFailure === 'uncertain') { checkoutFailure = null; throw Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' }); }
      return session;
    },
    async expire(id) { const session = checkoutSessions.get(id); session.status = 'expired'; session.url = null; return session; } } },
  refunds: { async create(params, options) {
    stripeRefundCalls += 1;
    if (stripeFailures > 0) { stripeFailures -= 1; throw new Error('Stripe is unavailable'); }
    if (!stripeRefunds.has(options.idempotencyKey)) stripeRefunds.set(options.idempotencyKey, { id: `re_${stripeRefunds.size + 1}`, payment_intent: params.payment_intent });
    return stripeRefunds.get(options.idempotencyKey);
  } },
};

/* ------------------------------------------------------------ Resend double */
const providerKeys = new Map(); // idempotency key -> body, forgotten after "24 hours"
const deliveries = []; let resendConflicts = 0; let resendFailures = 0;
async function resendFetch(_url, options) {
  if (resendFailures > 0) { resendFailures -= 1; return new Response('{}', { status: 500 }); }
  const key = options.headers['Idempotency-Key']; const body = JSON.parse(options.body);
  if (providerKeys.has(key)) {
    if (JSON.stringify(providerKeys.get(key)) !== JSON.stringify(body)) { resendConflicts += 1; return Response.json({ message: 'same key, different payload' }, { status: 409 }); }
    return Response.json({ id: key });
  }
  providerKeys.set(key, body); deliveries.push({ key, body });
  return Response.json({ id: key });
}
const fetchDouble = (url, options) => String(url).startsWith('https://api.resend.com/') ? resendFetch(url, options) : bridgeFetch(url, options);

/* ------------------------------------------------------------- module loader */
const modules = new Map();
function load(relative) {
  const filename = path.resolve(root, relative); if (modules.has(filename)) return modules.get(filename).exports;
  const m = { exports: {} }; modules.set(filename, m);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module: m, exports: m.exports, console: { ...console, error() {}, warn() {} }, crypto, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, AbortSignal,
    Date: TestDate, Error, setTimeout: fn => setImmediate(fn), fetch: fetchDouble,
    require(name) {
      if (name === 'cloudflare:workers') return { env };
      if (name === '@/lib/stripe') return { stripeIsConfigured: () => true, getStripeClient: () => stripe };
      if (name === '@/lib/staff-auth') return { async authoriseStaffMutation() { return { id: 'staff-1' }; }, async getStaffUser() { return { id: 'staff-1' }; } };
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
const scheduled = load('lib/scheduled.ts');
const operations = load('app/api/admin/operations/route.ts');
const changeRoute = load('app/api/admin/bookings/change/route.ts');
const bookingsRoute = load('app/api/bookings/route.ts');
const sessionRoute = load('app/api/stripe/session/route.ts');
const booklyAdmin = load('app/api/admin/bookly/route.ts');
const today = booking.getTodayInEindhoven();
const day = offset => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
// An open weekday (Tuesday–Saturday) at least a week out.
const openDay = (from = 8) => { for (let offset = from; ; offset += 1) { const date = day(offset); if ([2, 3, 4, 5, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return date; } };
// The n-th distinct open day from a week out.
const nthOpenDay = n => { let date = openDay(); for (let i = 0; i < n; i += 1) date = openDay(Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000) + 1); return date; };
let refs = 0;
function localAppointment(fields) {
  const row = { id: crypto.randomUUID(), reference: `AS-A${++refs}`, service_id: 'haircut', service_name: 'Haircut', duration_minutes: 30, price_cents: 3500,
    customer_name: 'Web customer', customer_email: `web${refs}@example.test`, customer_phone: '0611111111', status: 'confirmed', payment_method: 'pay_at_shop',
    payment_status: 'due_at_shop', source: 'online', handling_minutes: 10, ...fields };
  row.end_time = clock(minutes(row.start_time) + row.duration_minutes);
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO appointments(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
  if (['confirmed', 'payment_pending'].includes(row.status)) {
    for (const slot of booking.makeSlotKeys(row.appointment_date, row.start_time, row.duration_minutes + row.handling_minutes)) {
      db.prepare('INSERT INTO appointment_slots(slot_start, appointment_id) VALUES (?, ?)').run(slot, row.id);
    }
  }
  return row;
}
const paidAppointment = (date, time) => {
  const id = `cs_test_paid_${refs + 1}`; checkoutSessions.set(id, { id, payment_status: 'paid', payment_intent: `pi_${id}` });
  return localAppointment({ appointment_date: date, start_time: time, payment_method: 'stripe', payment_status: 'paid', stripe_checkout_session_id: id });
};
const appointment = id => db.prepare('SELECT * FROM appointments WHERE id=?').get(id);
const slotTimes = id => db.prepare('SELECT slot_start FROM appointment_slots WHERE appointment_id=? ORDER BY slot_start').all(id).map(row => row.slot_start.slice(11));
const remoteOf = id => [...remote.values()].find(row => row.localId === id);
const markFresh = () => db.prepare('UPDATE bookly_sync_state SET last_success=?,error=NULL WHERE id=1').run(new TestDate().toISOString());
const refundRow = id => db.prepare('SELECT * FROM payment_refunds WHERE appointment_id=?').get(id);
const deliveriesFor = reference => deliveries.filter(email => email.body.subject.includes(reference));
const json = async response => ({ status: response.status, body: await response.json() });
const changeBooking = body => changeRoute.POST(new Request('https://allstar.test/api/admin/bookings/change', { method: 'POST', body: JSON.stringify(body) })).then(json);
const operation = body => operations.POST(new Request('https://allstar.test/api/admin/operations', { method: 'POST', body: JSON.stringify(body) })).then(json);
const book = body => bookingsRoute.POST(new Request('https://allstar.test/api/bookings', { method: 'POST', body: JSON.stringify(body) })).then(json);
const booklyStatus = () => booklyAdmin.GET(new Request('https://allstar.test/api/admin/bookly')).then(json);
const booklyAction = body => booklyAdmin.POST(new Request('https://allstar.test/api/admin/bookly', { method: 'POST', body: JSON.stringify(body) })).then(json);
async function syncRun() {
  const before = calls.command;
  try { await bridge.synchronizeBookly(database); return { ok: true, commands: calls.command - before }; }
  catch (error) { return { ok: false, commands: calls.command - before, error: error.message }; }
}
function reset() {
  db.exec('PRAGMA foreign_keys=OFF');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('bookly_sync_state','booking_settings') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all()) db.exec(`DELETE FROM ${name}`);
  db.exec('PRAGMA foreign_keys=ON');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'test_%'").all()) db.exec(`DROP TRIGGER ${name}`);
  db.prepare('UPDATE bookly_sync_state SET lease=NULL,lease_until=0,last_success=NULL,error=NULL WHERE id=1').run();
  remote.clear(); receipts.clear(); commandLog.length = 0; providerKeys.clear(); deliveries.length = 0; stripeRefunds.clear(); checkoutKeys.clear();
  stripeFailures = 0; stripeRefundCalls = 0; checkoutCreates = 0; resendConflicts = 0; resendFailures = 0; clockOffset = 0;
  commandsDown = false; bridgeDown = false; beforeCommand = null; beforeBatch = null; env.BOOKLY_SYNC_ENABLED = 'true'; env.BOOKLY_SUBREQUEST_BUDGET = '900';
  checkoutFailure = null; afterCheckoutCreate = null; checkoutSessions.clear();
}
const results = []; let failures = 0;
async function check(name, fn) {
  reset();
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message.split('\n').slice(0,6).join(' | ')} @ ${(error.stack.split('\n').find(l => l.includes('release-audit.mjs')) ?? '').trim()}`); }
}

/* ----------------------------------------------------------------- F1 */
await check('F1 a staff edit racing a Bookly deletion keeps the booking and its slots; the time cannot be double-booked', async () => {
  markFresh(); const date = openDay();
  const raced = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [raced.id]);
  const before = slotTimes(raced.id);
  remote.clear(); // deleted in Bookly
  beforeBatch = () => { db.prepare("UPDATE appointments SET notes='concurrent staff edit',revision=revision+1 WHERE id=?").run(raced.id); };
  const run = await syncRun();
  assert.equal(run.ok, true, `the rest of the sync completes (${run.error})`);
  assert.equal(appointment(raced.id).status, 'confirmed');
  assert.deepEqual(slotTimes(raced.id), before, 'slots are released only together with the cancellation');
  assert.equal(stripeRefundCalls, 0);
  assert.ok(db.prepare('SELECT 1 FROM bookly_conflicts WHERE local_id=?').get(raced.id), 'the deletion is held for staff reconciliation');
  const second = await book({ requestId: crypto.randomUUID(), serviceId: 'haircut', date, time: '10:00', name: 'New Customer', email: 'new@example.test', phone: '0612345678', acceptedTerms: true, paymentMethod: 'cash' });
  assert.equal(second.status, 409, 'the still-confirmed time is not offered again');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE status='confirmed' AND appointment_date=? AND start_time='10:00'").get(date).n, 1);
});
await check('F1 an unraced Bookly deletion still cancels, releases the slots and refunds once', async () => {
  markFresh(); const date = openDay();
  const paid = paidAppointment(date, '10:00');
  await bridge.pushBooklyChanges(database, [paid.id]);
  remote.clear();
  assert.equal((await syncRun()).ok, true);
  assert.equal(appointment(paid.id).status, 'cancelled'); assert.deepEqual(slotTimes(paid.id), []);
  assert.equal(appointment(paid.id).payment_status, 'refunded'); assert.equal(stripeRefunds.size, 1);
  assert.equal((await syncRun()).ok, true); assert.equal(stripeRefunds.size, 1);
});

/* ----------------------------------------------------------------- F2 */
await check('F2 a reschedule Bookly rejects is reported as rejected, not notified, and restored to its original time', async () => {
  markFresh(); const date = openDay();
  const moved = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [moved.id]);
  beforeCommand = () => remoteRow({ date, time: '11:00' }); // native Bookly booking after the live check
  const response = await changeBooking({ reference: moved.reference, revision: 0, action: 'reschedule', date, time: '11:00' });
  assert.equal(response.status, 409); assert.equal(response.body.calendar, 'conflict');
  assert.notEqual(response.body.changed, true);
  assert.equal(deliveriesFor(moved.reference).length, 0, 'no reschedule email');
  const row = appointment(moved.id);
  assert.equal(row.status, 'confirmed'); assert.equal(row.start_time, '10:00');
  assert.deepEqual(slotTimes(moved.id), Array.from(booking.makeSlotKeys(date, '10:00', 40), slot => slot.slice(11)));
  assert.equal(remoteOf(moved.id).time, '10:00');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE local_id=? AND status='pending'").get(moved.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM booking_changes WHERE appointment_id=?').get(moved.id).n, 2, 'the move and its reversal are both audited');
  assert.equal((await syncRun()).ok, true, 'synchronization is not blocked afterwards');
  assert.equal(appointment(moved.id).start_time, '10:00');
});
await check('F2 a reschedule queued while Bookly is unreachable is notified only after Bookly accepts it', async () => {
  markFresh(); const date = openDay();
  const moved = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [moved.id]);
  commandsDown = true;
  const response = await changeBooking({ reference: moved.reference, revision: 0, action: 'reschedule', date, time: '11:00' });
  assert.equal(response.body.calendar, 'pending'); assert.equal(response.body.notificationsSent, false);
  assert.equal(deliveriesFor(moved.reference).length, 0, 'no email before Bookly accepts');
  commandsDown = false; clockOffset += 2 * 60_000;
  await scheduled.runScheduledTasks();
  assert.equal(remoteOf(moved.id).time, '11:00');
  const emails = deliveriesFor(moved.reference);
  assert.equal(emails.length, 1); assert.match(emails[0].body.text, /New appointment: .* 11:00/);
  await scheduled.runScheduledTasks(); assert.equal(deliveriesFor(moved.reference).length, 1);
});
await check('F2 a queued reschedule Bookly rejects later is restored and never notified', async () => {
  markFresh(); const date = openDay();
  const moved = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [moved.id]);
  commandsDown = true;
  await changeBooking({ reference: moved.reference, revision: 0, action: 'reschedule', date, time: '11:00' });
  remoteRow({ date, time: '11:00' }); commandsDown = false; clockOffset += 2 * 60_000;
  await scheduled.runScheduledTasks(); clockOffset += 10 * 60_000; await scheduled.runScheduledTasks();
  assert.equal(appointment(moved.id).start_time, '10:00'); assert.equal(remoteOf(moved.id).time, '10:00');
  assert.equal(deliveriesFor(moved.reference).length, 0);
  assert.deepEqual({ ...db.prepare("SELECT status,outcome FROM booking_obligations WHERE kind='notify'").get() }, { status: 'done', outcome: 'superseded' });
});
await check('F2 a reschedule Bookly accepts is confirmed and notified once (unchanged)', async () => {
  markFresh(); const date = openDay();
  const moved = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [moved.id]);
  const response = await changeBooking({ reference: moved.reference, revision: 0, action: 'reschedule', date, time: '11:00' });
  assert.equal(response.status, 200); assert.equal(response.body.calendar, 'synced'); assert.equal(response.body.notificationsSent, true);
  assert.equal(remoteOf(moved.id).time, '11:00'); assert.equal(deliveriesFor(moved.reference).length, 1);
});

/* ----------------------------------------------------------------- F3 */
async function heldConflict(date) {
  // A linked booking edited locally while Bookly changed it too: its command
  // is rejected on version, which no automatic action can resolve.
  const held = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [held.id]);
  const twin = remoteOf(held.id); remoteRow({ ...twin, notes: 'edited in Bookly' });
  db.prepare("UPDATE appointments SET notes='edited locally',revision=revision+1 WHERE id=?").run(held.id);
  return held;
}
await check('F3 one conflicted command is held; snapshots, exports and refunds continue', async () => {
  markFresh(); const date = openDay();
  const held = await heldConflict(date);
  await bridge.pushBooklyChanges(database, [held.id]).catch(() => {});
  const healthy = localAppointment({ appointment_date: openDay(15), start_time: '10:00' });
  const cancelled = paidAppointment(openDay(22), '10:00');
  await bridge.pushBooklyChanges(database, [cancelled.id]); remoteRow({ ...remoteOf(cancelled.id), status: 'cancelled' });
  const snapshots = calls.snapshot; const runs = []; const sentBefore = commandLog.filter(id => id === held.id).length;
  for (let i = 0; i < 3; i += 1) runs.push(await syncRun());
  assert.deepEqual(runs.map(run => run.ok), [true, true, true], JSON.stringify(runs));
  assert.equal(calls.snapshot - snapshots, 3, 'every run takes its snapshot');
  assert.ok(db.prepare('SELECT 1 FROM bookly_links WHERE local_id=?').get(healthy.id), 'an unrelated booking is exported');
  assert.equal(appointment(cancelled.id).payment_status, 'refunded', 'an unrelated Bookly cancellation is refunded');
  assert.equal(commandLog.filter(id => id === held.id).length, sentBefore, 'the held command is never resent by later runs');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE local_id=? AND status='held'").get(held.id).n, 1);
  const status = await booklyStatus();
  assert.equal(status.body.held.length, 1); assert.equal(status.body.conflicts.length, 1);
  assert.ok(status.body.occupancyAgeSeconds < 180, 'occupancy stays fresh, so online booking stays open');
});
await check('F3 later changes to a held booking wait behind its conflict (ordering preserved)', async () => {
  markFresh(); const date = openDay();
  const held = await heldConflict(date);
  await syncRun();
  db.prepare("UPDATE appointments SET notes='second local edit',revision=revision+1 WHERE id=?").run(held.id);
  await syncRun(); await syncRun();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE local_id=? AND status='pending'").get(held.id).n, 0, 'nothing overtakes the held command');
  assert.equal(remoteOf(held.id).notes, 'edited in Bookly');
});
await check('F3 conflict isolation is bounded: too many held records stop synchronization', async () => {
  markFresh();
  for (let i = 0; i <= bridge.MAX_HELD_CONFLICTS; i += 1) await heldConflict(nthOpenDay(i));
  const run = await syncRun();
  assert.equal(run.ok, false); assert.match(run.error, /held/);
});
await check('F3 staff resolve a held conflict by keeping the Bookly version', async () => {
  markFresh(); const date = openDay();
  const held = await heldConflict(date);
  await syncRun();
  const resolved = await booklyAction({ action: 'resolve', localId: held.id, keep: 'bookly' });
  assert.equal(resolved.status, 200);
  assert.equal((await syncRun()).ok, true);
  assert.equal(appointment(held.id).notes, 'edited in Bookly');
  assert.equal((await booklyStatus()).body.conflicts.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE status IN ('pending','held')").get().n, 0);
});
await check('F3 staff resolve a held conflict by keeping the local version', async () => {
  markFresh(); const date = openDay();
  const held = await heldConflict(date);
  await syncRun();
  await booklyAction({ action: 'resolve', localId: held.id, keep: 'local' });
  assert.equal((await syncRun()).ok, true);
  assert.equal(remoteOf(held.id).notes, 'edited locally');
  assert.equal((await booklyStatus()).body.conflicts.length, 0);
});

/* ----------------------------------------------------------------- F4 */
await check('F4 a failed refund for a Bookly cancellation is retried automatically with backoff, once', async () => {
  markFresh(); const date = openDay();
  const paid = paidAppointment(date, '10:00');
  await bridge.pushBooklyChanges(database, [paid.id]); remoteRow({ ...remoteOf(paid.id), status: 'cancelled' });
  stripeFailures = 1;
  assert.equal((await syncRun()).ok, true);
  assert.equal(refundRow(paid.id).status, 'failed');
  await syncRun(); assert.equal(stripeRefundCalls, 1, 'backoff: not retried immediately');
  clockOffset += 2 * 60_000; await syncRun();
  assert.equal(appointment(paid.id).payment_status, 'refunded'); assert.equal(stripeRefunds.size, 1);
  clockOffset += 60 * 60_000; await syncRun(); assert.equal(stripeRefunds.size, 1);
});
await check('F4 a failed late-payment refund is retried by the Cron task even with Bookly disabled', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false';
  const late = localAppointment({ appointment_date: openDay(), start_time: '10:00', status: 'payment_expired', payment_method: 'stripe', payment_status: 'expired', stripe_checkout_session_id: 'cs_test_late' });
  checkoutSessions.set('cs_test_late', { id: 'cs_test_late', metadata: { appointment_id: late.id }, payment_status: 'paid', payment_intent: 'pi_late' });
  stripeFailures = 1;
  const first = await sessionRoute.GET(new Request('https://allstar.test/api/stripe/session?session_id=cs_test_late')).then(json);
  assert.equal(first.body.outcome, 'cancelled'); assert.equal(first.body.refunded, false);
  for (let i = 0; i < 3; i += 1) await sessionRoute.GET(new Request('https://allstar.test/api/stripe/session?session_id=cs_test_late'));
  assert.equal(stripeRefundCalls, 1, 'repeated page loads do not hammer Stripe');
  clockOffset += 2 * 60_000; await scheduled.runScheduledTasks();
  assert.equal(appointment(late.id).payment_status, 'refunded'); assert.equal(stripeRefunds.size, 1);
  const after = await sessionRoute.GET(new Request('https://allstar.test/api/stripe/session?session_id=cs_test_late')).then(json);
  assert.equal(after.body.refunded, true);
});
await check('F4 a refund that keeps failing stops after its last automatic attempt and stays retryable by staff', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false';
  const late = localAppointment({ appointment_date: openDay(), start_time: '10:00', status: 'cancelled', payment_method: 'stripe', payment_status: 'paid', stripe_checkout_session_id: 'cs_test_stuck' });
  checkoutSessions.set('cs_test_stuck', { id: 'cs_test_stuck', payment_status: 'paid', payment_intent: 'pi_stuck' });
  db.prepare("INSERT INTO payment_refunds(id,appointment_id,amount_cents,status,requested_by) VALUES (?,?,3500,'failed','staff-1')").run(`refund-${late.id}`, late.id);
  stripeFailures = 1000;
  for (let i = 0; i < 40; i += 1) { clockOffset += 2 * 60 * 60_000; await scheduled.runScheduledTasks(); }
  const automatic = stripeRefundCalls;
  assert.ok(automatic >= 3 && automatic <= 12, `bounded automatic attempts (${automatic})`);
  assert.equal(refundRow(late.id).status, 'failed');
  stripeFailures = 0;
  const retried = await operation({ action: 'retry_refund', id: crypto.randomUUID(), reference: late.reference, revision: appointment(late.id).revision });
  assert.equal(retried.body.refundStatus, 'refunded'); assert.equal(stripeRefunds.size, 1);
});

/* ----------------------------------------------------------------- F5 */
await check('F5 a worker that lost its lease commits no cancellation and no refund', async () => {
  markFresh(); const date = openDay();
  const paid = paidAppointment(date, '10:00');
  await bridge.pushBooklyChanges(database, [paid.id]); remoteRow({ ...remoteOf(paid.id), status: 'cancelled' });
  beforeBatch = () => { clockOffset += 121_000; db.prepare("UPDATE bookly_sync_state SET lease='replacement-owner',lease_until=? WHERE id=1").run(TestDate.now() + 120_000); };
  const run = await syncRun();
  assert.equal(run.ok, false); assert.match(run.error, /lease/);
  assert.equal(appointment(paid.id).status, 'confirmed'); assert.equal(appointment(paid.id).payment_status, 'paid');
  assert.equal(stripeRefundCalls, 0); assert.equal(db.prepare('SELECT lease FROM bookly_sync_state').get().lease, 'replacement-owner');
});
await check('F5 a worker that lost its lease cannot cancel a booking deleted in Bookly', async () => {
  markFresh(); const date = openDay();
  const paid = paidAppointment(date, '10:00');
  await bridge.pushBooklyChanges(database, [paid.id]); remote.clear();
  beforeBatch = () => { clockOffset += 121_000; db.prepare("UPDATE bookly_sync_state SET lease='replacement-owner',lease_until=? WHERE id=1").run(TestDate.now() + 120_000); };
  const run = await syncRun();
  assert.equal(run.ok, false);
  assert.equal(appointment(paid.id).status, 'confirmed'); assert.equal(slotTimes(paid.id).length, 8); assert.equal(stripeRefundCalls, 0);
});

/* ----------------------------------------------------------------- F6 */
await check('F6 a notification retry sends the stored payload under the same key', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false'; const date = openDay();
  const card = paidAppointment(date, '10:00'); stripeFailures = 1;
  db.exec("CREATE TRIGGER test_email_commit_failure BEFORE UPDATE ON booking_obligations WHEN NEW.kind='notify' AND NEW.status='done' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END");
  await operation({ action: 'block_range', id: crypto.randomUUID(), fromDate: date, toDate: date, reason: 'Vacation', cancelConflicts: true });
  db.exec('DROP TRIGGER test_email_commit_failure');
  const first = deliveriesFor(card.reference); assert.equal(first.length, 1);
  const stored = db.prepare("SELECT payload FROM booking_obligations WHERE kind='notify'").get().payload;
  assert.ok(stored, 'the payload is stored before the first delivery');
  for (let i = 0; i < 4; i += 1) { clockOffset += 70 * 60_000; await scheduled.runScheduledTasks(); }
  assert.equal(appointment(card.id).payment_status, 'refunded');
  assert.equal(resendConflicts, 0, 'Resend never sees the key with a different payload');
  assert.equal(deliveriesFor(card.reference).length, 1, 'exactly one email');
  assert.equal(db.prepare("SELECT payload FROM booking_obligations WHERE kind='notify'").get().payload, stored, 'the stored payload never changes');
  assert.equal(db.prepare("SELECT status FROM booking_obligations WHERE kind='notify'").get().status, 'done');
});

/* ----------------------------------------------------------------- F7 */
await check('F7 an uncertain delivery older than the provider key window goes to reconciliation, not a resend', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false'; const date = openDay();
  const unpaid = localAppointment({ appointment_date: date, start_time: '10:00' });
  db.exec("CREATE TRIGGER test_email_commit_failure BEFORE UPDATE ON booking_obligations WHEN NEW.kind='notify' AND NEW.status='done' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END");
  await operation({ action: 'block_range', id: crypto.randomUUID(), fromDate: date, toDate: date, reason: 'Vacation', cancelConflicts: true });
  db.exec('DROP TRIGGER test_email_commit_failure');
  assert.equal(deliveriesFor(unpaid.reference).length, 1);
  clockOffset += 25 * 60 * 60_000; providerKeys.clear(); // Cron outage; Resend forgets the key
  await scheduled.runScheduledTasks(); await scheduled.runScheduledTasks();
  assert.equal(deliveriesFor(unpaid.reference).length, 1, 'no duplicate email');
  assert.equal(db.prepare("SELECT status FROM booking_obligations WHERE kind='notify'").get().status, 'reconcile');
});
await check('F7 an uncertain delivery inside the window is retried under the same key and completes once', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false'; const date = openDay();
  const unpaid = localAppointment({ appointment_date: date, start_time: '10:00' });
  db.exec("CREATE TRIGGER test_email_commit_failure BEFORE UPDATE ON booking_obligations WHEN NEW.kind='notify' AND NEW.status='done' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END");
  await operation({ action: 'block_range', id: crypto.randomUUID(), fromDate: date, toDate: date, reason: 'Vacation', cancelConflicts: true });
  db.exec('DROP TRIGGER test_email_commit_failure');
  clockOffset += 6 * 60_000; await scheduled.runScheduledTasks();
  assert.equal(deliveriesFor(unpaid.reference).length, 1);
  assert.equal(db.prepare("SELECT status FROM booking_obligations WHERE kind='notify'").get().status, 'done');
});

/* ----------------------------------------------------------------- F8 */
const stripeRequest = () => ({ requestId: crypto.randomUUID(), serviceId: 'haircut', date: openDay(), time: '10:00', name: 'Audit Customer', email: 'audit@example.test', phone: '0612345678', acceptedTerms: true, paymentMethod: 'stripe' });
await check('F8 retrying an interrupted pre-checkout request resumes payment without a second booking', async () => {
  markFresh(); const body = stripeRequest();
  commandsDown = true;
  const initial = await book(body);
  assert.equal(initial.status, 503);
  commandsDown = false; clockOffset += 3 * 60_000; markFresh();
  const retry = await book(body);
  assert.ok(retry.body.checkoutUrl, JSON.stringify(retry.body));
  assert.equal(checkoutCreates, 1);
  const again = await book(body);
  assert.equal(again.body.checkoutUrl, retry.body.checkoutUrl, 'a further retry returns the same session');
  assert.equal(checkoutCreates, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments').get().n, 1);
  const row = db.prepare('SELECT * FROM appointments').get();
  assert.equal(row.status, 'payment_pending'); assert.equal(row.stripe_checkout_session_id, 'cs_test_1');
  assert.equal([...remote.values()].filter(r => r.localId === row.id).length, 1, 'one Bookly hold');
});
await check('F8 concurrent retries of one request create one Checkout Session', async () => {
  markFresh(); const body = stripeRequest();
  commandsDown = true; await book(body); commandsDown = false; clockOffset += 3 * 60_000; markFresh();
  const [a, b] = await Promise.all([book(body), book(body)]);
  assert.equal(checkoutCreates, 1);
  const urls = [a, b].map(r => r.body.checkoutUrl).filter(Boolean);
  assert.ok(urls.length >= 1 && urls.every(url => url === urls[0]), JSON.stringify([a, b]));
});
await check('F8 an interruption after Checkout creation recovers the same session on retry', async () => {
  markFresh(); const body = stripeRequest();
  db.exec("CREATE TRIGGER test_session_store_failure BEFORE UPDATE OF stripe_checkout_session_id ON appointments WHEN NEW.stripe_checkout_session_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
  const initial = await book(body);
  assert.notEqual(initial.status, 201);
  db.exec('DROP TRIGGER test_session_store_failure');
  const retry = await book(body);
  assert.ok(retry.body.checkoutUrl, JSON.stringify(retry.body)); assert.equal(checkoutCreates, 1, 'Stripe returns the session created before the interruption');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments').get().n, 1);
});
await check('F8 a cash booking retry still confirms once (unchanged)', async () => {
  markFresh(); const body = { ...stripeRequest(), paymentMethod: 'cash' };
  const first = await book(body); assert.equal(first.status, 201);
  const second = await book(body); assert.equal(second.status, 200); assert.equal(second.body.booking.reference, first.body.booking.reference);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments').get().n, 1);
});

/* ------------------------------------------- Codex re-review of PR #10 (cc783f2) */
// R1 (migration) is covered in tests/migration-0010.mjs.
await check('R2 refund retries are not starved by a persistent notification backlog', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false'; env.BOOKLY_SUBREQUEST_BUDGET = '40';
  const stuck = localAppointment({ appointment_date: openDay(), start_time: '09:00', status: 'cancelled', payment_method: 'stripe', payment_status: 'paid', stripe_checkout_session_id: 'cs_test_r2' });
  checkoutSessions.set('cs_test_r2', { id: 'cs_test_r2', payment_status: 'paid', payment_intent: 'pi_r2' });
  db.prepare("INSERT INTO payment_refunds(id,appointment_id,amount_cents,status,requested_by) VALUES (?,?,3500,'failed','staff-1')").run(`refund-${stuck.id}`, stuck.id);
  for (let i = 0; i < 30; i += 1) {
    const row = localAppointment({ appointment_date: nthOpenDay(i % 5), start_time: clock(600 + 40 * Math.floor(i / 5)), status: 'cancelled' });
    db.prepare("INSERT INTO booking_changes(id,appointment_id,revision,action,actor_id,previous_date,previous_time) VALUES (?,?,1,'cancel','staff-1',?,?)").run(`c-${row.id}`, row.id, row.appointment_date, row.start_time);
    db.prepare("INSERT INTO booking_obligations(id,appointment_id,change_id,kind) VALUES (?,?,?,'notify')").run(`notify/${row.id}`, row.id, `c-${row.id}`);
  }
  for (let i = 0; i < 3; i += 1) { clockOffset += 60_000; await scheduled.runScheduledTasks(); }
  assert.ok(db.prepare("SELECT COUNT(*) n FROM booking_obligations WHERE status='pending'").get().n > 0, 'the email backlog persists');
  assert.ok(deliveries.length > 0, 'emails still progress');
  assert.equal(appointment(stuck.id).payment_status, 'refunded', `the due refund was attempted (${stripeRefundCalls} calls)`);
});
await check('R3 overlapping checkout retries return the stored session; the losing session is expired', async () => {
  markFresh(); const body = stripeRequest();
  commandsDown = true; await book(body); commandsDown = false; markFresh();
  const id = db.prepare('SELECT id FROM appointments').get().id;
  db.prepare('UPDATE appointments SET payment_expires_at=? WHERE id=?').run(new TestDate(TestDate.now() + 31 * 60_000).toISOString(), id);
  let second;
  afterCheckoutCreate = async () => { clockOffset += 2 * 60_000; markFresh(); second = await book(body); };
  const first = await book(body);
  const stored = appointment(id).stripe_checkout_session_id;
  assert.equal(checkoutCreates, 2, 'the race created two sessions');
  assert.equal(second.body.checkoutUrl, checkoutSessions.get(stored).url);
  assert.equal(first.body.checkoutUrl, checkoutSessions.get(stored).url, 'the losing request returns the stored session');
  const loser = [...checkoutSessions.values()].find(session => session.id.startsWith('cs_test_') && session.id !== stored);
  assert.equal(loser.status, 'expired', 'the unstored session can no longer be paid');
});
await check('R4 resolving a held reschedule as "keep Bookly" keeps its email blocked until Bookly is adopted', async () => {
  markFresh(); const date = openDay();
  const moved = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [moved.id]);
  commandsDown = true;
  await changeBooking({ reference: moved.reference, revision: 0, action: 'reschedule', date, time: '11:00' });
  remoteRow({ ...remoteOf(moved.id), notes: 'edited in Bookly' });
  localAppointment({ appointment_date: date, start_time: '10:00' }); // the old time is taken locally: the move cannot be restored
  commandsDown = false;
  await syncRun();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE local_id=? AND status='held'").get(moved.id).n, 1, 'the rejected move is held');
  assert.equal((await booklyAction({ action: 'resolve', localId: moved.id, keep: 'bookly' })).status, 200);
  bridgeDown = true;
  for (let i = 0; i < 3; i += 1) { clockOffset += 2 * 60_000; await scheduled.runScheduledTasks(); }
  assert.equal(deliveriesFor(moved.reference).length, 0, 'no email for the time staff did not keep');
  bridgeDown = false; markFresh();
  for (let i = 0; i < 2; i += 1) { clockOffset += 2 * 60_000; await scheduled.runScheduledTasks(); }
  assert.equal(appointment(moved.id).start_time, '10:00', 'the Bookly version is adopted');
  assert.equal(deliveriesFor(moved.reference).length, 0);
  assert.deepEqual({ ...db.prepare("SELECT status,outcome FROM booking_obligations WHERE kind='notify'").get() }, { status: 'done', outcome: 'superseded' });
});
await check('R4 resolving a held reschedule as "keep local" sends its email only after Bookly accepts it', async () => {
  markFresh(); const date = openDay();
  const moved = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [moved.id]);
  commandsDown = true;
  await changeBooking({ reference: moved.reference, revision: 0, action: 'reschedule', date, time: '11:00' });
  remoteRow({ ...remoteOf(moved.id), notes: 'edited in Bookly' });
  localAppointment({ appointment_date: date, start_time: '10:00' });
  commandsDown = false;
  await syncRun(); await syncRun();
  assert.equal((await booklyAction({ action: 'resolve', localId: moved.id, keep: 'local' })).status, 200);
  bridgeDown = true;
  for (let i = 0; i < 3; i += 1) { clockOffset += 2 * 60_000; await scheduled.runScheduledTasks(); }
  assert.equal(deliveriesFor(moved.reference).length, 0, 'no email before Bookly accepts the kept version');
  bridgeDown = false; markFresh();
  for (let i = 0; i < 2; i += 1) { clockOffset += 2 * 60_000; await scheduled.runScheduledTasks(); }
  assert.equal(remoteOf(moved.id).time, '11:00');
  assert.equal(deliveriesFor(moved.reference).length, 1);
  assert.equal((await booklyStatus()).body.conflicts.filter(row => row.local_id === moved.id).length, 0, 'the resolution is complete');
});
await check('R5 a Checkout creation with an uncertain outcome keeps the hold, and the retry recovers the session', async () => {
  markFresh(); const body = stripeRequest();
  checkoutFailure = 'uncertain';
  const initial = await book(body);
  assert.equal(initial.status, 503);
  const row = db.prepare('SELECT * FROM appointments').get();
  assert.equal(row.status, 'payment_pending', 'the hold is retained'); assert.equal(slotTimes(row.id).length, 8);
  const retry = await book(body);
  assert.ok(retry.body.checkoutUrl, JSON.stringify(retry.body));
  assert.equal(checkoutCreates, 1, 'the retry recovers the session Stripe created');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments').get().n, 1);
});
await check('R5 a Checkout creation Stripe rejects still releases the hold (unchanged)', async () => {
  markFresh(); const body = stripeRequest();
  checkoutFailure = 'definite';
  assert.equal((await book(body)).status, 503);
  const row = db.prepare('SELECT * FROM appointments').get();
  assert.equal(row.status, 'payment_expired'); assert.equal(slotTimes(row.id).length, 0);
});
await check('R6 a worker that lost its lease during a command request does not overwrite the newer link', async () => {
  markFresh(); const date = openDay();
  const linked = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [linked.id]);
  db.prepare("UPDATE appointments SET notes='local edit',revision=revision+1 WHERE id=?").run(linked.id);
  commandsDown = true; await bridge.pushBooklyChanges(database, [linked.id]).catch(() => {}); commandsDown = false;
  const newer = 'f'.repeat(64);
  beforeCommand = () => {
    clockOffset += 121_000;
    db.prepare("UPDATE bookly_sync_state SET lease='replacement-owner',lease_until=? WHERE id=1").run(TestDate.now() + 120_000);
    db.prepare('UPDATE bookly_links SET remote_version=? WHERE local_id=?').run(newer, linked.id); // the replacement's newer receipt
  };
  const run = await syncRun();
  assert.equal(run.ok, false); assert.match(run.error, /lease/);
  assert.equal(db.prepare('SELECT remote_version FROM bookly_links WHERE local_id=?').get(linked.id).remote_version, newer, 'the stale receipt is not written');
});
await check('R7 "keep Bookly" is refused for a service or duration change it cannot apply', async () => {
  markFresh(); const date = openDay();
  const changed = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [changed.id]);
  remoteRow({ ...remoteOf(changed.id), durationMinutes: 45 });
  await syncRun();
  assert.ok(db.prepare('SELECT 1 FROM bookly_conflicts WHERE local_id=?').get(changed.id));
  const refused = await booklyAction({ action: 'resolve', localId: changed.id, keep: 'bookly' });
  assert.equal(refused.status, 409, 'not reported as resolved');
  assert.ok(db.prepare('SELECT 1 FROM bookly_conflicts WHERE local_id=?').get(changed.id), 'the conflict stays held');
  assert.equal((await booklyAction({ action: 'resolve', localId: changed.id, keep: 'local' })).status, 200);
  assert.equal((await syncRun()).ok, true);
  assert.equal(remoteOf(changed.id).durationMinutes, 30); assert.equal((await booklyStatus()).body.conflicts.length, 0);
});
await check('R8 "keep local" works for a rejected command whose Bookly twin never changed', async () => {
  markFresh(); const date = openDay();
  const linked = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [linked.id]);
  const native = remoteRow({ date, time: '11:00' });
  db.prepare("UPDATE appointments SET start_time='11:00',end_time='11:30',revision=revision+1 WHERE id=?").run(linked.id);
  await bridge.pushBooklyChanges(database, [linked.id]).catch(() => {});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE local_id=? AND status='held'").get(linked.id).n, 1);
  await syncRun(); await syncRun();
  remote.delete(native.remoteId); // staff cleared the Bookly slot
  const resolved = await booklyAction({ action: 'resolve', localId: linked.id, keep: 'local' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal((await syncRun()).ok, true);
  assert.equal(remoteOf(linked.id).time, '11:00'); assert.equal((await booklyStatus()).body.conflicts.length, 0);
});

/* ------------------------------------------- Codex re-review of b7cc10d */
await check('R9 "keep Bookly" is refused for a service change that coincides with a local edit', async () => {
  markFresh(); const date = openDay();
  const changed = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [changed.id]);
  remoteRow({ ...remoteOf(changed.id), durationMinutes: 45 });
  db.prepare("UPDATE appointments SET notes='edited locally',revision=revision+1 WHERE id=?").run(changed.id);
  await syncRun();
  assert.ok(db.prepare('SELECT 1 FROM bookly_conflicts WHERE local_id=?').get(changed.id));
  const refused = await booklyAction({ action: 'resolve', localId: changed.id, keep: 'bookly' });
  assert.equal(refused.status, 409, 'not reported as resolved');
  assert.equal(db.prepare('SELECT resolution FROM bookly_conflicts WHERE local_id=?').get(changed.id).resolution, null, 'the conflict stays held');
});
await check('R10 "keep Bookly" is refused for a record Bookly never accepted', async () => {
  markFresh(); const date = openDay();
  remoteRow({ date, time: '10:00' });
  const unlinked = localAppointment({ appointment_date: date, start_time: '10:00' });
  await bridge.pushBooklyChanges(database, [unlinked.id]).catch(() => {});
  assert.ok(db.prepare('SELECT 1 FROM bookly_conflicts WHERE local_id=?').get(unlinked.id), 'the first export is held');
  assert.equal(db.prepare('SELECT 1 FROM bookly_links WHERE local_id=?').get(unlinked.id), undefined);
  const refused = await booklyAction({ action: 'resolve', localId: unlinked.id, keep: 'bookly' });
  assert.equal(refused.status, 409, 'Bookly has no version to keep');
  assert.ok(db.prepare('SELECT 1 FROM bookly_conflicts WHERE local_id=?').get(unlinked.id), 'the conflict stays held');
});
await check('R11 a command discarded while in flight does not settle as delivered; its record is held again', async () => {
  markFresh(); const date = openDay();
  const held = await heldConflict(date);
  await syncRun();
  assert.equal((await booklyAction({ action: 'resolve', localId: held.id, keep: 'local' })).status, 200);
  const delivered = () => db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE local_id=? AND status='done'").get(held.id).n;
  const deliveredBefore = delivered();
  beforeCommand = async () => { assert.equal((await booklyAction({ action: 'resolve', localId: held.id, keep: 'bookly' })).status, 200); };
  await syncRun();
  assert.equal(remoteOf(held.id).notes, 'edited locally', 'the in-flight write reached Bookly');
  assert.equal(delivered(), deliveredBefore, 'the discarded command is not marked delivered');
  const conflict = db.prepare('SELECT resolution FROM bookly_conflicts WHERE local_id=?').get(held.id);
  assert.ok(conflict, 'the record is still held'); assert.equal(conflict.resolution, null, 'staff choose again, knowing Bookly changed');
  assert.equal((await booklyAction({ action: 'resolve', localId: held.id, keep: 'bookly' })).status, 200);
  assert.equal((await syncRun()).ok, true);
  assert.equal(appointment(held.id).notes, 'edited locally', 'Bookly\'s version is adopted');
  assert.equal((await booklyStatus()).body.conflicts.length, 0, 'the resolution completes');
});

console.log(results.join('\n'));
if (failures) { console.error(`${failures} release-audit regression(s) failed`); process.exit(1); }
console.log('PASS: release audit findings 1-8 (deletion race, rejected reschedule, conflict isolation, refund recovery, lease fencing, stored notification payloads, provider key window, checkout recovery)');
