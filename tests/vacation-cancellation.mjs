// Vacation over existing bookings: one transaction cancels the covered
// bookings, releases their slots, records refund and email obligations and
// blocks the days, or changes nothing. Obligations are processed after commit
// and retried by the Cron task without duplicate refunds or emails.
// SQLite-backed D1 (real migrations and triggers), the real operations route,
// refund and email modules, and Stripe/Resend doubles that honour idempotency
// keys like the real services. Not a real Worker, Stripe or Resend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const root = process.cwd();
const db = new DatabaseSync(':memory:');
for (const name of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`drizzle/${name}`, 'utf8'));
let beforeBatch = null; let subrequests = 0;
const database = {
  prepare(sql) { let values=[]; return { bind(...v){values=v;return this;},
    async first(){subrequests++;return db.prepare(sql).get(...values)??null;},
    async all(){subrequests++;return {results:db.prepare(sql).all(...values)};},
    async run(){subrequests++;return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};},
  async batch(statements){
    if (beforeBatch) { const hook = beforeBatch; beforeBatch = null; await hook(); }
    const before = subrequests;
    db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');subrequests=before+1;return result;}
    catch(e){db.exec('ROLLBACK');subrequests=before+1;throw e;}},
};

/* --------------------------------------------------- Stripe and Resend doubles */
const env = { BOOKLY_SYNC_ENABLED: 'false', RESEND_API_KEY: 're_test', BOOKING_EMAIL_FROM: 'All Star <bookings@example.test>', BOOKING_BUSINESS_NAME: 'All Star', BOOKING_ADMIN_EMAIL: '' };
const stripeRefunds = new Map(); let stripeCreateCalls = 0; let stripeFailures = 0;
const stripe = {
  checkout: { sessions: { async retrieve(id) { subrequests++; return { id, payment_status: 'paid', payment_intent: `pi_${id}` }; } } },
  refunds: { async create(params, options) {
    subrequests++; stripeCreateCalls++;
    if (stripeFailures > 0) { stripeFailures--; throw new Error('Stripe is unavailable'); }
    if (!stripeRefunds.has(options.idempotencyKey)) stripeRefunds.set(options.idempotencyKey, { id: `re_${stripeRefunds.size + 1}` });
    return stripeRefunds.get(options.idempotencyKey);
  } },
};
const delivered = new Map(); // Resend idempotency key -> delivered email
let resendCalls = 0; let resendFailures = 0;
async function fetchDouble(url, options) {
  subrequests++;
  if (!String(url).startsWith('https://api.resend.com/')) throw new Error(`Unexpected fetch ${url}`);
  resendCalls++;
  if (resendFailures > 0) { resendFailures--; return new Response('{}', { status: 500 }); }
  const key = options.headers['Idempotency-Key'];
  if (!delivered.has(key)) delivered.set(key, JSON.parse(options.body));
  return Response.json({ id: key });
}

/* ------------------------------------------------------------- module loader */
const modules = new Map();
function load(relative) {
  const filename = path.resolve(root, relative); if (modules.has(filename)) return modules.get(filename).exports;
  const m = { exports: {} }; modules.set(filename, m);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: m, exports: m.exports, console: { ...console, error() {} }, crypto, TextEncoder, TextDecoder, URL, Request, Response, Headers, AbortSignal, Date, Error,
    setTimeout: fn => setImmediate(fn), fetch: fetchDouble,
    require(name) {
      if (name === 'cloudflare:workers') return { env };
      if (name === '@/lib/stripe') return { stripeIsConfigured: () => true, getStripeClient: () => stripe };
      if (name === '@/lib/staff-auth') return { async authoriseStaffMutation() { return { id: 'staff-1' }; } };
      if (name === '@/db') return { getD1: () => database };
      if (name.startsWith('@/')) return load(`${name.slice(2)}.ts`);
      return require(name);
    } }, { filename });
  return m.exports;
}
const operations = load('app/api/admin/operations/route.ts');
const scheduled = load('lib/scheduled.ts');
const obligations = load('lib/booking-obligations.ts');
const budgets = load('lib/subrequest-budget.ts');
const booking = load('lib/booking.ts');
const today = booking.getTodayInEindhoven();
const day = offset => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
// An open weekday (Tuesday–Saturday) at least a week out.
const openDay = (from = 8) => { for (let offset = from; ; offset += 1) { const date = day(offset); if ([2,3,4,5,6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return date; } };
const minutes = t => Number(t.slice(0,2))*60 + Number(t.slice(3));
const clock = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
let refs = 0;
function localAppointment(fields) {
  const row = { id: crypto.randomUUID(), reference: `AS-V${++refs}`, service_id: 'haircut', service_name: 'Haircut', duration_minutes: 30, price_cents: 3500,
    customer_name: 'Customer', customer_email: `customer${refs}@example.test`, customer_phone: '0611111111', status: 'confirmed', payment_method: 'pay_at_shop',
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
const paid = (date, time) => localAppointment({ appointment_date: date, start_time: time, payment_method: 'stripe', payment_status: 'paid', stripe_checkout_session_id: `cs_test_${refs + 1}` });
const appointment = id => db.prepare('SELECT * FROM appointments WHERE id=?').get(id);
const slots = id => db.prepare('SELECT COUNT(*) n FROM appointment_slots WHERE appointment_id=?').get(id).n;
const timeOffDays = date => db.prepare('SELECT COUNT(*) n FROM time_off WHERE date=? AND removed_at IS NULL').get(date).n;
const obligationRows = () => db.prepare('SELECT * FROM booking_obligations ORDER BY kind, appointment_id').all();
const emailsFor = reference => [...delivered.values()].filter(email => email.subject.includes(reference)).length;
const post = async body => { const response = await operations.POST(new Request('https://allstar.test/api/admin/operations', { method: 'POST', body: JSON.stringify(body) })); return { status: response.status, body: await response.json() }; };
const vacation = (date, extra = {}) => post({ action: 'block_range', id: crypto.randomUUID(), fromDate: date, toDate: date, reason: 'Vacation', cancelConflicts: true, ...extra });
function reset() {
  db.exec('PRAGMA foreign_keys=OFF');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('bookly_sync_state','booking_settings') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all()) db.exec(`DELETE FROM ${name}`);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('DROP TRIGGER IF EXISTS test_fail_obligation');
  stripeRefunds.clear(); delivered.clear(); stripeCreateCalls = 0; stripeFailures = 0; resendCalls = 0; resendFailures = 0; beforeBatch = null;
}
const results = [];
async function check(name, fn) {
  reset();
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) { results.push(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
}
const makeDue = () => db.prepare("UPDATE booking_obligations SET next_attempt_at=0 WHERE status='pending'").run();

/* ---------------------------------------------- atomic cancellation */
await check('paid and unpaid bookings inside opening hours: cancelled, slots released, vacation blocked, one refund and one email each', async () => {
  const date = openDay();
  const card = paid(date, '11:00');
  const shop = localAppointment({ appointment_date: date, start_time: '13:00' });
  const walkIn = localAppointment({ appointment_date: date, start_time: '15:30', source: 'walk_in', customer_email: '' });
  const response = await vacation(date);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.cancelledBookings, 3);
  assert.equal(response.body.refundsPending, 0);
  assert.equal(response.body.notificationsSent, true);
  for (const row of [card, shop, walkIn]) { assert.equal(appointment(row.id).status, 'cancelled'); assert.equal(slots(row.id), 0); }
  assert.equal(appointment(card.id).payment_status, 'refunded');
  assert.equal(appointment(shop.id).payment_status, 'due_at_shop', 'shop payments are not refunded');
  assert.equal(timeOffDays(date), 1);
  assert.equal(stripeRefunds.size, 1);
  assert.equal(emailsFor(card.reference), 1); assert.equal(emailsFor(shop.reference), 1);
  assert.equal(delivered.size, 2, 'no email for a walk-in without an address');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM booking_changes WHERE action='cancel'").get().n, 3, 'each cancellation is audited');
  assert.ok(obligationRows().every(row => row.status === 'done'));
  assert.match([...delivered.values()].find(email => email.subject.includes(card.reference)).text, /refunded automatically/);
  // The Cron task finds nothing left to do: no duplicate refund or email.
  makeDue(); await scheduled.runScheduledTasks();
  assert.equal(stripeRefunds.size, 1); assert.equal(delivered.size, 2); assert.equal(stripeCreateCalls, 1);
});

await check('a pending online payment in the period refuses the vacation and changes nothing', async () => {
  const date = openDay();
  const pending = localAppointment({ appointment_date: date, start_time: '11:00', status: 'payment_pending', payment_method: 'stripe', payment_status: 'pending',
    payment_expires_at: new Date(Date.now() + 20 * 60_000).toISOString() });
  const confirmed = localAppointment({ appointment_date: date, start_time: '13:00' });
  const response = await vacation(date);
  assert.equal(response.status, 409);
  assert.match(response.body.error, /payment is still pending/);
  assert.equal(appointment(pending.id).status, 'payment_pending'); assert.equal(slots(pending.id), 8);
  assert.equal(appointment(confirmed.id).status, 'confirmed'); assert.equal(slots(confirmed.id), 8);
  assert.equal(timeOffDays(date), 0); assert.equal(obligationRows().length, 0); assert.equal(delivered.size, 0);
});

await check('a booking edited concurrently rolls back every cancellation and the vacation', async () => {
  const date = openDay();
  const card = paid(date, '11:00');
  const shop = localAppointment({ appointment_date: date, start_time: '13:00' });
  beforeBatch = async () => { db.prepare("UPDATE appointments SET customer_phone='0622222222', revision=revision+1 WHERE id=?").run(shop.id); };
  const response = await vacation(date);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.match(response.body.error, /Nothing was cancelled/);
  assert.equal(appointment(card.id).status, 'confirmed'); assert.equal(appointment(card.id).payment_status, 'paid'); assert.equal(slots(card.id), 8);
  assert.equal(appointment(shop.id).status, 'confirmed'); assert.equal(slots(shop.id), 8);
  assert.equal(timeOffDays(date), 0); assert.equal(obligationRows().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM booking_changes').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bookly_revision_guards').get().n, 0);
  assert.equal(stripeCreateCalls, 0); assert.equal(resendCalls, 0);
});

await check('a booking cancelled or paid concurrently rolls everything back', async () => {
  const date = openDay();
  const shop = localAppointment({ appointment_date: date, start_time: '13:00' });
  const other = localAppointment({ appointment_date: date, start_time: '15:30' });
  // Status and payment changes without a revision bump are caught too.
  beforeBatch = async () => { db.prepare("UPDATE appointments SET payment_status='paid', payment_method='cash' WHERE id=?").run(shop.id); };
  assert.equal((await vacation(date)).status, 409);
  assert.equal(appointment(other.id).status, 'confirmed'); assert.equal(timeOffDays(date), 0);
});

await check('a booking created concurrently inside the vacation rolls everything back (overlap trigger kept)', async () => {
  const date = openDay();
  const shop = localAppointment({ appointment_date: date, start_time: '11:00' });
  beforeBatch = async () => { localAppointment({ appointment_date: date, start_time: '16:00' }); };
  const response = await vacation(date);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(appointment(shop.id).status, 'confirmed'); assert.equal(slots(shop.id), 8);
  assert.equal(timeOffDays(date), 0); assert.equal(obligationRows().length, 0);
});

await check('a database failure inside the transaction rolls everything back', async () => {
  const date = openDay();
  const card = paid(date, '11:00');
  db.exec("CREATE TRIGGER test_fail_obligation BEFORE INSERT ON booking_obligations BEGIN SELECT RAISE(ABORT, 'D1_ERROR: storage failure'); END;");
  const response = await vacation(date);
  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.equal(appointment(card.id).status, 'confirmed'); assert.equal(slots(card.id), 8);
  assert.equal(timeOffDays(date), 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM booking_changes').get().n, 0);
  assert.equal(stripeCreateCalls, 0);
});

/* ---------------------------------------------- obligations after commit */
await check('a refund that fails after commit is retried by the Cron task, refunded once, email sent once', async () => {
  const date = openDay();
  const card = paid(date, '11:00');
  stripeFailures = 1;
  const response = await vacation(date);
  assert.equal(response.status, 200);
  assert.equal(response.body.refundsPending, 1, 'reported as pending');
  assert.equal(response.body.notificationsSent, true, 'the email states the refund needs attention');
  assert.match([...delivered.values()][0].text, /refund needs attention/);
  assert.equal(appointment(card.id).status, 'cancelled'); assert.equal(appointment(card.id).payment_status, 'paid');
  const refund = obligationRows().find(row => row.kind === 'refund');
  assert.equal(refund.status, 'pending'); assert.ok(refund.next_attempt_at > Date.now(), 'backs off');
  await scheduled.runScheduledTasks();
  assert.equal(stripeRefunds.size, 0, 'not retried before its backoff');
  makeDue(); await scheduled.runScheduledTasks();
  assert.equal(appointment(card.id).payment_status, 'refunded');
  assert.equal(stripeRefunds.size, 1); assert.equal(delivered.size, 1, 'no second email');
  makeDue(); await scheduled.runScheduledTasks();
  assert.equal(stripeCreateCalls, 2, 'one failed and one successful Stripe call');
});

await check('an email that fails after commit is retried with the same idempotency key and delivered once', async () => {
  const date = openDay();
  const shop = localAppointment({ appointment_date: date, start_time: '13:00' });
  resendFailures = 3; // all three Resend attempts of the first try
  const response = await vacation(date);
  assert.equal(response.status, 200);
  assert.equal(response.body.notificationsSent, false);
  assert.equal(delivered.size, 0);
  makeDue(); await scheduled.runScheduledTasks();
  assert.equal(emailsFor(shop.reference), 1);
  makeDue(); await scheduled.runScheduledTasks();
  assert.equal(delivered.size, 1);
  assert.equal(obligationRows()[0].status, 'done');
});

await check('a worker crash after the Stripe refund is recovered without a duplicate refund', async () => {
  const date = openDay();
  const card = paid(date, '11:00');
  // The refund succeeds at Stripe, but the obligation's completion write fails.
  db.exec("CREATE TRIGGER test_fail_obligation BEFORE UPDATE OF status ON booking_obligations WHEN NEW.status='done' AND NEW.kind='refund' BEGIN SELECT RAISE(ABORT, 'D1_ERROR: connection lost'); END;");
  const response = await vacation(date);
  assert.equal(response.status, 200);
  db.exec('DROP TRIGGER test_fail_obligation');
  assert.equal(stripeRefunds.size, 1);
  makeDue(); await scheduled.runScheduledTasks();
  makeDue(); await scheduled.runScheduledTasks();
  assert.equal(stripeRefunds.size, 1, 'the retry reuses the recorded refund');
  assert.equal(obligationRows().find(row => row.kind === 'refund').status, 'done');
  assert.equal(emailsFor(card.reference), 1);
});

await check('concurrent processors claim each obligation once', async () => {
  const date = openDay();
  const rows = [paid(date, '10:00'), paid(date, '11:00'), localAppointment({ appointment_date: date, start_time: '13:00' })];
  // Record the obligations without processing them inline.
  const processor = obligations.processBookingObligations;
  const backstage = load('lib/backstage.ts');
  const settings = await load('lib/booking-settings.ts').readBookingSettings(database);
  const conflicts = db.prepare("SELECT * FROM appointments WHERE appointment_date=? AND status='confirmed'").all(date);
  await backstage.blockFullDaysCancelling(database, { fromDate: date, toDate: date, reason: 'Vacation' }, conflicts, 'staff-1', settings);
  await Promise.all([processor(database), processor(database), processor(database)]);
  await processor(database);
  assert.equal(stripeRefunds.size, 2); assert.equal(stripeCreateCalls, 2, 'each refund attempted once');
  for (const row of rows) assert.equal(emailsFor(row.reference), 1);
  assert.equal(resendCalls, 3, 'each email attempted once');
  assert.ok(obligationRows().every(row => row.status === 'done'));
});

await check('an obligation stops after its last attempt and stays visible', async () => {
  const date = openDay();
  const card = paid(date, '11:00');
  stripeFailures = 100;
  await vacation(date);
  for (let attempt = 1; attempt < obligations.MAX_OBLIGATION_ATTEMPTS; attempt += 1) { makeDue(); await scheduled.runScheduledTasks(); }
  const refund = obligationRows().find(row => row.kind === 'refund');
  assert.equal(refund.status, 'failed'); assert.equal(refund.attempts, obligations.MAX_OBLIGATION_ATTEMPTS);
  makeDue(); await scheduled.runScheduledTasks();
  assert.equal(stripeCreateCalls, obligations.MAX_OBLIGATION_ATTEMPTS, 'no attempts after the last one');
  // Staff can still retry from Backstage once Stripe recovers.
  stripeFailures = 0;
  const retry = await post({ action: 'retry_refund', id: crypto.randomUUID(), reference: card.reference, revision: appointment(card.id).revision });
  assert.equal(retry.body.refundStatus, 'refunded');
  assert.equal(stripeRefunds.size, 1);
});

await check('the Cron task stays within the subrequest budget and resumes a large obligation queue', async () => {
  for (let index = 0; index < 4; index += 1) {
    const date = openDay(8 + index * 7);
    for (const time of ['10:00', '11:00', '13:00', '14:00', '16:00']) paid(date, time);
  }
  const conflicts = db.prepare("SELECT * FROM appointments WHERE status='confirmed'").all();
  const backstage = load('lib/backstage.ts');
  const settings = await load('lib/booking-settings.ts').readBookingSettings(database);
  for (const date of [...new Set(conflicts.map(row => row.appointment_date))]) {
    await backstage.blockFullDaysCancelling(database, { fromDate: date, toDate: date, reason: 'Vacation' },
      conflicts.filter(row => row.appointment_date === date), 'staff-1', settings);
  }
  assert.equal(obligationRows().length, 40);
  const runs = [];
  while (obligationRows().some(row => row.status === 'pending')) {
    subrequests = 0; await scheduled.runScheduledTasks(); runs.push(subrequests);
    assert.ok(subrequests <= budgets.DEFAULT_SUBREQUEST_BUDGET, `run used ${subrequests}`);
    assert.ok(runs.length < 40, 'converges');
  }
  assert.equal(stripeRefunds.size, 20); assert.equal(delivered.size, 20);
  results.push(`  (40 obligations: ${runs.length} Cron runs, peak ${Math.max(...runs)} subrequests)`);
});

/* ---------------------------------------------- ordinary time blocks unchanged */
await check('ordinary time blocks and conflict previews behave as before', async () => {
  const date = openDay();
  const shop = localAppointment({ appointment_date: date, start_time: '13:00' });
  const blocked = await post({ action: 'block', id: crypto.randomUUID(), date, start: '13:00', end: '13:30', reason: 'Errand' });
  assert.equal(blocked.status, 409, 'a block over a booking is still refused by the overlap trigger');
  assert.equal(appointment(shop.id).status, 'confirmed');
  const free = await post({ action: 'block', id: crypto.randomUUID(), date, start: '16:00', end: '16:30', reason: 'Errand' });
  assert.equal(free.status, 200);
  const preview = await post({ action: 'block_range', id: crypto.randomUUID(), fromDate: date, toDate: date, reason: 'Vacation', cancelConflicts: false });
  assert.equal(preview.status, 409); assert.equal(preview.body.conflicts.length, 1);
  assert.equal(appointment(shop.id).status, 'confirmed');
  const empty = openDay(30);
  const plain = await post({ action: 'block_range', id: crypto.randomUUID(), fromDate: empty, toDate: empty, reason: 'Vacation', cancelConflicts: true });
  assert.equal(plain.status, 200); assert.equal(plain.body.cancelledBookings, 0); assert.equal(timeOffDays(empty), 1);
  // Existing time off in the period still refuses the vacation without cancelling.
  const again = await vacation(date);
  assert.equal(again.status, 409); assert.equal(appointment(shop.id).status, 'confirmed'); assert.equal(obligationRows().length, 0);
});

console.log(results.join('\n'));
const failed = results.filter(line => line.startsWith('FAIL'));
if (failed.length) { console.error(`${failed.length} vacation check(s) failed`); process.exit(1); }
console.log('PASS: atomic vacation cancellation (paid, unpaid, pending payment, concurrent edits, concurrent bookings, storage failure) and idempotent, retryable refund and email obligations');
