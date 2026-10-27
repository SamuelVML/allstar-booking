// Predeployment hardening: activation history, background-only snapshots,
// occupancy freshness and booking races. SQLite-backed D1 and a Bookly double
// that arbitrates slots like the plugin's named-lock check. This does not prove
// real WordPress/Bookly execution, Access or payment delivery.
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
const database = {
  prepare(sql) { let values=[]; return { bind(...v){values=v;return this;}, async first(){return db.prepare(sql).get(...values)??null;},
    async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};},
  async batch(statements){db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},
};

/* ------------------------------------------------------------ Bookly double */
const env = {};
const remote = new Map(); const receipts = new Map(); let nextId = 500;
const calls = { snapshot: 0, availability: 0, command: 0 };
let bridgeDown = false; let duringSnapshot = null; let beforeCommand = null;
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
async function fakeFetch(url, options) {
  if (bridgeDown) throw new Error('connect ECONNREFUSED');
  const route = new URL(url).pathname.split('/').pop();
  const input = JSON.parse(options.body);
  calls[route] += 1;
  await new Promise(resolve => setTimeout(resolve, 1)); // let concurrent requests interleave
  if (route === 'snapshot') {
    const rows = [...remote.values()].map(row => ({ ...row }));
    if (duringSnapshot) { const hook = duringSnapshot; duringSnapshot = null; await hook(); }
    return Response.json({ complete: true, scopeFrom: '2000-01-01', appointments: rows });
  }
  if (route === 'availability') {
    return Response.json({ days: input.days.map(day => ({ date: day.date, times: day.times.filter(time =>
      ![...remote.values()].some(row => active(row) && row.localId !== input.excludeLocalId && overlaps(row, day.date, minutes(time), input.durationMinutes))) })) });
  }
  if (route === 'command') {
    if (beforeCommand) { const hook = beforeCommand; beforeCommand = null; await hook(); }
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
    return Response.json(receipt);
  }
  throw new Error(`Unexpected route ${route}`);
}

/* ------------------------------------------------------------- module loader */
let refundCalls = 0;
const modules = new Map();
function load(relative) {
  const filename = path.resolve(root, relative); if (modules.has(filename)) return modules.get(filename).exports;
  const m = { exports: {} }; modules.set(filename, m);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: m, exports: m.exports, console, crypto, TextEncoder, TextDecoder, URL, Request, Response, Headers, AbortSignal, Date, Error, setTimeout, fetch: fakeFetch,
    require(name) {
      if (name === 'cloudflare:workers') return { env };
      if (name === '@/lib/refunds') return { async refundCancelledBooking(_db, row) { if (row.payment_method === 'stripe' && row.payment_status === 'paid') refundCalls++; return 'not_needed'; }, recordRefundDue: db => db.prepare('SELECT 1'), async retryDueRefunds() {} };
      if (name === '@/lib/stripe') return { stripeIsConfigured: () => false, getStripeClient() { throw new Error('Stripe is not used in these tests'); } };
      if (name === '@/lib/booking-email') return { async sendBookingConfirmation() { return true; } };
      if (name === '@/db') return { getD1: () => database };
      if (name.startsWith('@/')) return load(`${name.slice(2)}.ts`);
      return require(name);
    } }, { filename });
  return m.exports;
}
const bridge = load('lib/bookly.ts');
const scheduled = load('lib/bookly-scheduled.ts');
const booking = load('lib/booking.ts');
const availabilityRoute = load('app/api/availability/route.ts');
const bookingsRoute = load('app/api/bookings/route.ts');
const today = booking.getTodayInEindhoven();
const day = offset => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
let refs = 0;
function localAppointment(fields) {
  const row = { id: crypto.randomUUID(), reference: `AS-H${++refs}`, service_id: 'haircut', service_name: 'Haircut', duration_minutes: 30, price_cents: 3500,
    customer_name: 'Web customer', customer_email: `web${refs}@example.test`, customer_phone: '0611111111', status: 'confirmed', payment_method: 'cash',
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
const timeOff = (id, date, removed = false) => db.prepare(`INSERT INTO time_off(id,date,start_time,end_time,reason,actor_id,removed_at) VALUES (?,?,'09:00','09:30','Closed','staff',?)`)
  .run(id, date, removed ? '2026-01-01T00:00:00Z' : null);
const status = id => db.prepare('SELECT status FROM appointments WHERE id=?').get(id)?.status;
const slotCount = id => db.prepare('SELECT COUNT(*) n FROM appointment_slots WHERE appointment_id=?').get(id).n;
const commandedLocalIds = () => new Set([...remote.values()].filter(row => row.localId).map(row => row.localId));

/* ---------------------------------------------- 1. activation does not replay history */
const pastConfirmed = localAppointment({ appointment_date: day(-30), start_time: '10:00' }); // never marked completed
const pastCompleted = localAppointment({ appointment_date: day(-20), start_time: '10:00', status: 'completed', payment_status: 'paid' });
const pastHold = localAppointment({ appointment_date: day(-2), start_time: '11:00', status: 'payment_pending', payment_method: 'stripe', payment_status: 'pending' });
const todayConfirmed = localAppointment({ appointment_date: today, start_time: '15:00' });
const futureConfirmed = localAppointment({ appointment_date: day(9), start_time: '12:00' });
const futureHold = localAppointment({ appointment_date: day(9), start_time: '14:00', status: 'payment_pending', payment_method: 'stripe', payment_status: 'pending' });
const futureCancelled = localAppointment({ appointment_date: day(10), start_time: '12:00', status: 'cancelled' });
const futureExpired = localAppointment({ appointment_date: day(10), start_time: '14:00', status: 'payment_expired', payment_method: 'stripe', payment_status: 'expired' });
const futureCompleted = localAppointment({ appointment_date: day(11), start_time: '12:00', status: 'completed' });
timeOff('past-active', day(-5)); timeOff('past-removed', day(-4), true); timeOff('future-active', day(12)); timeOff('future-removed', day(13), true);
const nativePast = remoteRow({ date: day(-3), time: '10:00' });
const nativePastCancelled = remoteRow({ date: day(-3), time: '11:00', status: 'cancelled' });
const nativeFuture = remoteRow({ date: day(9), time: '16:00' });
const nativeFutureCancelled = remoteRow({ date: day(9), time: '17:00', status: 'cancelled' });
const nativeToday = remoteRow({ date: today, time: '09:00', status: 'completed' });
const slotsBefore = Object.fromEntries([todayConfirmed, futureConfirmed, futureHold].map(row => [row.id, slotCount(row.id)]));

await bridge.synchronizeBookly(database);
assert.equal(calls.snapshot, 0, 'disabled bridge makes no external call');
assert.equal(await scheduled.runScheduledBooklySync(), 'disabled');
Object.assign(env, { BOOKLY_SYNC_ENABLED: 'true', BOOKLY_BRIDGE_URL: 'https://bookly.example/wp-json/allstar-bookly/v1', BOOKLY_BRIDGE_SECRET: 'x'.repeat(40) });
assert.equal(await scheduled.runScheduledBooklySync(), 'synced');

assert.deepEqual(commandedLocalIds(), new Set([todayConfirmed.id, futureConfirmed.id, futureHold.id, 'block-future-active']),
  'only current/future active bookings and future time off are written to Bookly');
for (const row of [pastConfirmed, pastCompleted, pastHold, futureCancelled, futureExpired, futureCompleted]) {
  assert.equal(status(row.id), row.status, `${row.reference} keeps its local status`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bookly_links WHERE local_id=?').get(row.id).n, 0, `${row.reference} is not linked`);
}
for (const row of [todayConfirmed, futureConfirmed, futureHold]) {
  assert.equal(status(row.id), row.status, 'future bookings are preserved');
  assert.equal(slotCount(row.id), slotsBefore[row.id], 'future occupancy is preserved');
}
const imported = db.prepare("SELECT id, source, payment_status FROM appointments WHERE source='bookly' ORDER BY id").all();
assert.deepEqual(imported.map(row => row.id).sort(), [`bookly-${nativeFuture.remoteId}`, `bookly-${nativeToday.remoteId}`].sort(),
  'only active native rows for today and later are imported');
assert.ok(imported.every(row => row.payment_status === 'managed_in_bookly'));
for (const row of [nativePast, nativePastCancelled, nativeFutureCancelled]) assert.equal(status(`bookly-${row.remoteId}`), undefined);
assert.equal(db.prepare('SELECT COUNT(*) n FROM bookly_occupied_slots WHERE appointment_id=?').get(`bookly-${nativeFuture.remoteId}`).n, 6, 'native future occupancy is blocked');
assert.equal(db.prepare("SELECT source FROM appointments WHERE id=?").get(futureConfirmed.id).source, 'online', 'Worker-origin rows keep their origin');

const remoteCount = remote.size; const receiptCount = receipts.size; const localCount = db.prepare('SELECT COUNT(*) n FROM appointments').get().n;
await bridge.synchronizeBookly(database);
assert.equal(remote.size, remoteCount, 'second sync creates nothing in Bookly');
assert.equal(receipts.size, receiptCount, 'second sync sends no commands');
assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments').get().n, localCount, 'second sync imports nothing twice');
assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE status='pending'").get().n, 0);

// Linked records keep following Bookly even once they are in the past or terminal.
db.prepare("UPDATE appointments SET status='completed', revision=revision+1 WHERE id=?").run(todayConfirmed.id);
await bridge.synchronizeBookly(database);
assert.equal([...remote.values()].find(row => row.localId === todayConfirmed.id).status, 'completed', 'linked completion reaches Bookly');
console.log('PASS: activation skips historical, cancelled, expired and completed rows; preserves future bookings and occupancy; imports only current native rows; idempotent');

/* ------------------------------------------- 2. snapshots stay off request paths */
const bookingDate = (() => { for (let offset = 3; offset < 20; offset += 1) { const date = day(offset); if (new Date(`${date}T12:00:00Z`).getUTCDay() === 3) return date; } })();
const resetCalls = () => { for (const key of Object.keys(calls)) calls[key] = 0; };
const availability = async date => availabilityRoute.GET(new Request(`https://example.test/api/availability?service=haircut${date ? `&date=${date}` : ''}`));
const book = async (time, fields = {}) => bookingsRoute.POST(new Request('https://example.test/api/bookings', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ requestId: crypto.randomUUID(), serviceId: 'haircut', date: bookingDate, time, name: 'Race customer', email: `race${++refs}@example.test`,
    phone: '0612345678', acceptedTerms: true, paymentMethod: 'cash', ...fields }) }));

resetCalls();
let response = await availability(bookingDate);
assert.equal(response.status, 200);
assert.equal(calls.snapshot, 0, 'public availability never takes a snapshot');
assert.equal(calls.availability, 1, 'public availability still checks the live Bookly day');
response = await availability();
assert.equal(response.status, 200); assert.equal(calls.snapshot, 0, 'recommendation scan never takes a snapshot');

db.prepare('UPDATE bookly_sync_state SET lease=?, lease_until=? WHERE id=1').run('other-worker', Date.now() + 60_000);
assert.equal((await availability(bookingDate)).status, 200, 'a running background sync does not block customers');
assert.equal(await scheduled.runScheduledBooklySync(), 'failed', 'overlapping scheduled run backs off');
db.prepare('UPDATE bookly_sync_state SET lease=NULL, lease_until=0 WHERE id=1').run();

resetCalls();
response = await book('10:30');
assert.equal(response.status, 201, 'cash booking succeeds');
assert.equal(calls.snapshot, 0, 'booking never takes a snapshot');
assert.equal(calls.command, 1, 'booking is written to Bookly before confirmation');
console.log('PASS: availability and bookings use live day checks and single-command pushes; no request path takes a snapshot; lease overlap is harmless');

/* -------------------------------------------- 3. freshness bound and fail closed */
assert.equal(bridge.BOOKLY_MAX_OCCUPANCY_AGE_SECONDS, 180);
const setAge = seconds => db.prepare('UPDATE bookly_sync_state SET last_success=? WHERE id=1').run(new Date(Date.now() - seconds * 1000).toISOString());
setAge(bridge.BOOKLY_MAX_OCCUPANCY_AGE_SECONDS - 5);
assert.equal((await availability(bookingDate)).status, 200, 'occupancy inside the bound is served');
setAge(bridge.BOOKLY_MAX_OCCUPANCY_AGE_SECONDS + 1);
assert.equal((await availability(bookingDate)).status, 503, 'stale occupancy closes availability');
assert.equal((await availability()).status, 503, 'stale occupancy closes recommendations');
const before = db.prepare('SELECT COUNT(*) n FROM appointments').get().n;
response = await book('11:30');
assert.equal(response.status, 503, 'stale occupancy closes bookings');
assert.match((await response.json()).error, /temporarily unavailable/);
assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments').get().n, before, 'nothing is reserved while stale');
db.prepare('UPDATE bookly_sync_state SET last_success=NULL WHERE id=1').run();
assert.equal((await availability(bookingDate)).status, 503, 'never-synchronized occupancy is closed');

bridgeDown = true;
assert.equal(await scheduled.runScheduledBooklySync(), 'failed', 'background failure is contained');
assert.equal(db.prepare('SELECT error FROM bookly_sync_state').get().error, 'unavailable');
assert.equal(db.prepare('SELECT lease_until FROM bookly_sync_state').get().lease_until, 0, 'failed sync releases the lease');
assert.equal((await availability(bookingDate)).status, 503, 'a failed sync does not refresh occupancy');
bridgeDown = false;
assert.equal(await scheduled.runScheduledBooklySync(), 'synced');
bridgeDown = true;
assert.equal((await availability(bookingDate)).status, 503, 'fresh occupancy still fails closed when the live Bookly check is unreachable');
response = await book('11:30');
assert.equal(response.status, 503, 'bookings fail closed when Bookly is unreachable');
assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments').get().n, before, 'nothing is reserved when Bookly is unreachable');
bridgeDown = false;
console.log('PASS: 180-second occupancy bound; stale, missing or unreachable Bookly closes availability, recommendations and bookings without reserving');

/* ------------------------------------------------- 4. double-booking prevention */
await scheduled.runScheduledBooklySync();
const [first, second] = await Promise.all([book('13:00'), book('13:00')]);
assert.deepEqual([first.status, second.status].sort(), [201, 409], 'concurrent requests for one slot: exactly one succeeds');
assert.equal([...remote.values()].filter(row => row.date === bookingDate && row.time === '13:00' && active(row)).length, 1, 'Bookly receives one appointment');
assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE appointment_date=? AND start_time='13:00' AND status='confirmed'").get(bookingDate).n, 1);

// A native Bookly booking made after the last snapshot is caught by the live day check.
remoteRow({ date: bookingDate, time: '15:00' });
response = await book('15:00');
assert.equal(response.status, 409, 'live check rejects a slot taken in Bookly since the snapshot');
assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE appointment_date=? AND start_time='15:00' AND source!='bookly'").get(bookingDate).n, 0);

// A native booking landing between the live check and the write is rejected by Bookly.
beforeCommand = async () => { remoteRow({ date: bookingDate, time: '16:00' }); };
response = await book('16:00');
assert.equal(response.status, 409, 'Bookly arbitration rejects the losing hold');
assert.match((await response.json()).error, /just booked/);
const loser = db.prepare("SELECT id, status FROM appointments WHERE appointment_date=? AND start_time='16:00' AND source!='bookly'").get(bookingDate);
assert.equal(loser.status, 'cancelled', 'the rejected hold is cancelled locally');
assert.equal(slotCount(loser.id), 0, 'the rejected hold releases its slots');

// A link created by a request during a background snapshot is not inferred deleted.
let racing;
duringSnapshot = async () => {
  racing = localAppointment({ appointment_date: bookingDate, start_time: '17:00', booking_request_id: crypto.randomUUID() });
  await bridge.pushBooklyChanges(database, [racing.id]);
};
await bridge.synchronizeBookly(database);
assert.equal(status(racing.id), 'confirmed', 'a booking linked during the snapshot is not cancelled');
assert.equal(refundCalls, 0, 'and is not refunded');
await bridge.synchronizeBookly(database);
assert.equal(status(racing.id), 'confirmed', 'the next snapshot adopts it normally');
console.log('PASS: concurrent same-slot requests yield one booking; post-snapshot Bookly bookings are rejected by the live check or Bookly arbitration; request-time links survive a concurrent snapshot');
db.close();
