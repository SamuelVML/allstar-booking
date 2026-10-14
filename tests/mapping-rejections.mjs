// Regressions for two defects found while integrating the cutover candidate
// (R17, R18). SQLite-backed D1 with the real migrations, the real routes and
// bridge; a Bookly double that, like the plugin, refuses an appointment whose
// website key has no Bookly service or whose duration differs from it. The
// HTTP status of that refusal is read from the plugin source, so these checks
// exercise the status the deployed plugin actually returns.
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


/* ------------------------------------------------- plugin mapping refusals */
const pluginSource = fs.readFileSync('integrations/bookly/allstar-bookly-bridge/allstar-bookly-bridge.php', 'utf8');
/** Status the plugin answers for a refusal code: `refuse(code…)` is 422, `fail(code, msg, N)` is N, `fail(code, msg)` 409. */
function pluginStatus(code) {
  const line = pluginSource.split('\n').find(l => l.includes(`('${code}'`));
  if (!line) throw new Error(`plugin has no ${code} refusal`);
  if (new RegExp(`self::refuse\\('${code}'`).test(line)) return 422;
  const explicit = new RegExp(`self::fail\\('${code}',\\s*'[^']*',\\s*(\\d{3})\\)`).exec(line);
  return explicit ? Number(explicit[1]) : 409;
}
const pluginRefusal = (code, message) => Response.json({ code: 'bridge_command', message: `${code}:${message}`, data: { status: pluginStatus(code) } }, { status: pluginStatus(code) });
const shippedServices = JSON.parse(fs.readFileSync('integrations/bookly/allstar-bookly-bridge/service-map.json', 'utf8')).services;
let mappedServices = { ...shippedServices };
const catalogue = JSON.parse(fs.readFileSync('docs/release-cutover/bookly-catalogue-2026-10-14.json', 'utf8')).services;
const booklyDurations = new Map(Object.values(catalogue).map(service => [service.id, service.duration === '1 h' ? 60 : Number(service.duration.replace(' min', ''))]));

/* ------------------------------------------------------------ Bookly double */
const env = { BOOKLY_SYNC_ENABLED: 'true', BOOKLY_BRIDGE_URL: 'https://wp.example.test/wp-json/allstar-bookly/v1', BOOKLY_BRIDGE_SECRET: 'x'.repeat(40),
  BOOKLY_SUBREQUEST_BUDGET: '900', RESEND_API_KEY: 're_test', BOOKING_EMAIL_FROM: 'All Star <bookings@example.test>', BOOKING_BUSINESS_NAME: 'All Star', BOOKING_ADMIN_EMAIL: '' };
const remote = new Map(); const receipts = new Map(); let nextId = 500;
// The plugin's allstar_bridge_links: local id -> Bookly id. Kept when the Bookly row is deleted, as in WordPress.
const bridgeLinks = new Map();
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
    const linkedId = bridgeLinks.get(input.localId);
    if (linkedId && !remote.has(linkedId)) {
      // Plugin: a link whose Bookly appointment is gone fails 'deleted', unless the
      // Worker recreates deliberately (no expected version, replaceDeletedLink).
      if (input.replaceDeletedLink === true && !input.expectedVersion) bridgeLinks.delete(input.localId);
      else return Response.json({ code: 'deleted', message: 'Appointment was deleted in Bookly.' }, { status: 409 });
    }
    if (existing && existing.version !== input.expectedVersion) return Response.json({ error: 'stale' }, { status: 409 });
    // Plugin apply(): an unlinked terminal record is a no-op; any other
    // appointment needs a mapped Bookly service of exactly its duration.
    const terminal = ['cancelled', 'payment_expired', 'removed'].includes(s.status);
    if (input.kind === 'appointment' && !(terminal && !existing)) {
      const booklyId = mappedServices[s.serviceId];
      if (!booklyId) return pluginRefusal('service_map', 'Service has not been mapped.');
      if (booklyDurations.get(booklyId) !== s.durationMinutes) return pluginRefusal('duration_map', 'Bookly service duration does not match the website service.');
    }
    const status = ['payment_expired', 'removed'].includes(s.status) ? 'cancelled' : s.status;
    if (active({ status }) && [...remote.values()].some(row => row.remoteId !== existing?.remoteId && active(row) && overlaps(row, s.date, minutes(s.time), s.durationMinutes + s.handlingMinutes))) {
      return Response.json({ error: 'slot taken' }, { status: 409 });
    }
    const row = remoteRow({ ...(existing ? { remoteId: existing.remoteId } : {}), localId: input.localId, kind: input.kind, serviceId: s.serviceId, date: s.date, time: s.time,
      durationMinutes: s.durationMinutes, extraMinutes: s.handlingMinutes, status, customerName: s.customerName, customerEmail: s.customerEmail, notes: s.notes });
    bridgeLinks.set(input.localId, row.remoteId);
    const receipt = { remoteId: row.remoteId, version: row.version }; receipts.set(input.id, receipt);
    return Response.json(receipt);
  }
  throw new Error(`Unexpected route ${route}`);
}

/* ------------------------------------------------------------ Stripe double */
const stripeRefunds = new Map(); let stripeRefundCalls = 0; let stripeFailures = 0;
const checkoutSessions = new Map(); const checkoutKeys = new Map(); let checkoutCreates = 0;
// 'uncertain': the session is created but the response is lost; 'definite': Stripe rejects the request.
let checkoutFailure = null; let afterCheckoutCreate = null; let afterCheckoutReject = null; let beforeRefundCreate = null;
const stripe = {
  checkout: { sessions: {
    async retrieve(id) { const session = checkoutSessions.get(id); if (!session) throw new Error('No such session'); return session; },
    async create(params, options = {}) {
      if (checkoutFailure === 'definite') { checkoutFailure = null; throw Object.assign(new Error('Invalid request'), { type: 'StripeInvalidRequestError', statusCode: 400 }); }
      // Another request with the same key is still executing (Stripe: 409, retry later), or the key is locked (429 lock_timeout).
      if (checkoutFailure === 'idempotency_conflict') { checkoutFailure = null; afterCheckoutReject?.(params, options); throw Object.assign(new Error('There is currently another in-progress request using this Idempotent Key'), { type: 'StripeIdempotencyError', rawType: 'idempotency_error', statusCode: 409 }); }
      if (checkoutFailure === 'lock_timeout') { checkoutFailure = null; afterCheckoutReject?.(params, options); throw Object.assign(new Error('This object cannot be accessed right now because another API request or Stripe process is currently accessing it.'), { type: 'StripeRateLimitError', rawType: 'invalid_request_error', code: 'lock_timeout', statusCode: 429 }); }
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
    if (beforeRefundCreate) { const hook = beforeRefundCreate; beforeRefundCreate = null; await hook(); }
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
const attention = load('app/api/admin/attention/route.ts');
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
  checkoutFailure = null; afterCheckoutCreate = null; afterCheckoutReject = null; beforeRefundCreate = null; checkoutSessions.clear(); bridgeLinks.clear();
  mappedServices = { ...shippedServices };
}
const results = []; let failures = 0;
async function check(name, fn) {
  reset();
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message.split('\n').slice(0,6).join(' | ')} @ ${(error.stack.split('\n').find(l => l.includes('mapping-rejections.mjs')) ?? '').trim()}`); }
}


const heldFor = id => db.prepare("SELECT status, error FROM bookly_commands WHERE local_id=? ORDER BY created_at DESC").get(id);
const conflictFor = id => db.prepare('SELECT * FROM bookly_conflicts WHERE local_id=?').get(id);
const commandsFor = id => commandLog.filter(localId => localId === id).length;
const attentionList = () => attention.GET(new Request('https://allstar.test/api/admin/attention')).then(json);
const activationReport = () => booklyAdmin.GET(new Request('https://allstar.test/api/admin/bookly?report=activation')).then(json);
const legacy = (date, time, fields = {}) => localAppointment({ appointment_date: date, start_time: time, service_id: 'beard-trim-shape', service_name: 'Beard trim & shape',
  duration_minutes: 20, price_cents: 2250, ...fields });
const customer = (extra = {}) => ({ name: 'New Customer', email: `new${++refs}@example.test`, phone: '0612345678', acceptedTerms: true, ...extra });

/* ----------------------------------------------------------------- R17 */
await check('R17 a booking Bookly cannot map is held for staff and does not stop synchronization', async () => {
  markFresh(); const date = openDay();
  const unmapped = legacy(date, '10:00', { booking_request_id: crypto.randomUUID() });
  const current = localAppointment({ appointment_date: date, start_time: '12:00', price_cents: 3350 });
  const first = await syncRun();
  assert.equal(first.ok, true, `the run completes (${first.error})`);
  assert.ok(remoteOf(current.id), 'the mappable booking still reaches Bookly');
  assert.ok(db.prepare('SELECT last_success FROM bookly_sync_state WHERE id=1').get().last_success, 'occupancy stays fresh');
  assert.equal(appointment(unmapped.id).status, 'confirmed', 'an unpaid website booking is never cancelled for a mapping refusal');
  assert.equal(slotTimes(unmapped.id).length, 6, 'its time stays reserved');
  assert.equal(heldFor(unmapped.id)?.status, 'held');
  assert.match(conflictFor(unmapped.id)?.reason ?? '', /Service not mapped in Bookly/);
  const attempts = commandsFor(unmapped.id);
  for (let run = 0; run < 3; run += 1) { clockOffset += 61_000; assert.equal((await syncRun()).ok, true); }
  assert.equal(commandsFor(unmapped.id), attempts, 'a held record is not resent every run');
  await assert.doesNotReject(bridge.assertBooklyFresh(database), 'online availability stays open');
});
await check('R17 a duration that differs from Bookly is held, never cancelled, for walk-ins and paid bookings too', async () => {
  markFresh(); const date = openDay();
  const student = localAppointment({ appointment_date: date, start_time: '10:00', service_id: 'student-haircut', service_name: 'Student haircut', price_cents: 3000, source: 'walk_in' });
  const paid = paidAppointment(date, '12:00');
  db.prepare("UPDATE appointments SET service_name='Haircut + colour',duration_minutes=60,end_time='13:00',price_cents=5750 WHERE id=?").run(paid.id);
  assert.equal((await syncRun()).ok, true);
  assert.equal(appointment(student.id).status, 'confirmed'); assert.equal(appointment(paid.id).status, 'confirmed');
  assert.equal(appointment(paid.id).payment_status, 'paid'); assert.equal(stripeRefundCalls, 0);
  assert.match(conflictFor(student.id)?.reason ?? '', /Duration differs from Bookly/);
  assert.match(conflictFor(paid.id)?.reason ?? '', /Service not mapped in Bookly/);
  assert.equal(appointment(paid.id).price_cents, 5750, 'the historical price is kept');
});
await check('R17 many unmappable legacy bookings do not trip the held-record limit', async () => {
  markFresh();
  const rows = []; for (let i = 0; i < bridge.MAX_HELD_CONFLICTS + 2; i += 1) rows.push(legacy(nthOpenDay(i), '10:00'));
  const run = await syncRun();
  assert.equal(run.ok, true, `synchronization continues (${run.error})`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE status='held'").get().n, rows.length);
  await assert.doesNotReject(bridge.assertBooklyFresh(database));
});
await check('R17 held mapping refusals are listed for staff (Bookly status and Attention)', async () => {
  markFresh(); const unmapped = legacy(openDay(), '10:00');
  await syncRun();
  const status = await booklyStatus();
  assert.ok(status.body.held.some(row => row.local_id === unmapped.id && row.error === 'mapping'));
  assert.ok(status.body.conflicts.some(row => row.local_id === unmapped.id && /not mapped/.test(row.reason)));
  const list = await attentionList();
  assert.ok(list.body.calendar.conflicts.some(row => row.local_id === unmapped.id && /not mapped/.test(row.reason)));
});
await check('R17 the activation report lists future bookings Bookly cannot take, with sync still off', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false'; const date = openDay();
  const unmapped = legacy(date, '10:00');
  const longer = localAppointment({ appointment_date: date, start_time: '12:00', service_id: 'student-haircut', service_name: 'Student haircut', price_cents: 3000 });
  const addOn = localAppointment({ appointment_date: date, start_time: '14:00', service_name: 'Haircut + colour', duration_minutes: 60, price_cents: 5750 });
  const fine = localAppointment({ appointment_date: date, start_time: '16:00', price_cents: 3350 });
  localAppointment({ appointment_date: day(-3), start_time: '10:00', service_id: 'beard-trim-shape', service_name: 'Beard trim & shape', duration_minutes: 20 });
  localAppointment({ appointment_date: date, start_time: '17:00', status: 'cancelled', service_id: 'beard-trim-shape', service_name: 'Beard trim & shape', duration_minutes: 20 });
  const report = await activationReport();
  assert.equal(report.status, 200);
  const issues = Object.fromEntries(report.body.unmappable.map(row => [row.id, row.issue]));
  assert.deepEqual(Object.keys(issues).sort(), [unmapped.id, longer.id, addOn.id].sort(), 'only future active bookings Bookly would refuse');
  assert.equal(issues[unmapped.id], 'service_not_mapped'); assert.equal(issues[addOn.id], 'service_not_mapped'); assert.equal(issues[longer.id], 'duration_differs');
  assert.ok(!issues[fine.id]);
  const anonymous = await activationReport();
  assert.equal(anonymous.status, 200);
});
await check('R17 a new website booking Bookly cannot map fails cleanly: hold released, nothing charged, nothing held', async () => {
  markFresh(); const date = openDay();
  delete mappedServices.haircut; // the plugin's map lost a key the website still sells
  const response = await book({ requestId: crypto.randomUUID(), serviceId: 'haircut', date, time: '10:00', paymentMethod: 'stripe', ...customer() });
  assert.equal(response.status, 503); assert.match(response.body.error, /not booked|nothing was charged/i);
  assert.equal(checkoutCreates, 0, 'no Checkout Session exists');
  const row = db.prepare('SELECT * FROM appointments WHERE appointment_date=? AND start_time=?').get(date, '10:00');
  assert.notEqual(row.status, 'payment_pending'); assert.deepEqual(slotTimes(row.id), [], 'the time is released');
  assert.equal(heldFor(row.id)?.status, 'rejected'); assert.equal(conflictFor(row.id), undefined, 'nothing waits for staff');
  const cash = await book({ requestId: crypto.randomUUID(), serviceId: 'haircut', date, time: '12:00', paymentMethod: 'cash', ...customer() });
  assert.equal(cash.status, 503);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE status IN ('confirmed','payment_pending')").get().n, 0, 'no confirmed booking the customer was told failed');
});
await check('R17 a walk-in Bookly cannot map is not added', async () => {
  markFresh(); const date = openDay();
  delete mappedServices.haircut;
  const id = crypto.randomUUID();
  const response = await operation({ action: 'walk_in', id, serviceId: 'haircut', date, time: '10:00', name: 'Walk In', notes: '' });
  assert.equal(response.status, 409); assert.match(response.body.error, /not mapped|cannot take/i);
  assert.deepEqual(slotTimes(id), []);
});
await check('R17 staff can close a held legacy booking by cancelling it and keeping the local version', async () => {
  markFresh(); const unmapped = legacy(openDay(), '10:00');
  await syncRun();
  db.prepare("UPDATE appointments SET status='cancelled',revision=revision+1 WHERE id=?").run(unmapped.id);
  db.prepare('DELETE FROM appointment_slots WHERE appointment_id=?').run(unmapped.id);
  assert.equal((await booklyAction({ action: 'resolve', localId: unmapped.id, keep: 'local' })).status, 200);
  assert.equal((await syncRun()).ok, true);
  assert.equal(conflictFor(unmapped.id), undefined, 'no permanent marker remains');
  assert.equal(remoteOf(unmapped.id), undefined, 'nothing was written to Bookly');
});

/* ----------------------------------------------------------------- R18 */
function interruptedHold(fields) {
  return localAppointment({ status: 'payment_pending', payment_method: 'stripe', payment_status: 'pending', booking_request_id: crypto.randomUUID(),
    payment_expires_at: new TestDate(TestDate.now() + 25 * 60_000).toISOString(), ...fields });
}
await check('R18 a checkout interrupted before D06 with a retired service resumes at its stored price', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false'; const date = openDay();
  const hold = interruptedHold({ appointment_date: date, start_time: '10:00', service_id: 'beard-trim-shape', service_name: 'Beard trim & shape', duration_minutes: 20, price_cents: 2250 });
  const response = await book({ requestId: hold.booking_request_id, serviceId: 'beard-trim-shape', date, time: '10:00', paymentMethod: 'stripe', ...customer({ email: hold.customer_email }) });
  assert.equal(response.status, 200, JSON.stringify(response.body)); assert.ok(response.body.checkoutUrl);
  const [{ params }] = [...checkoutKeys.values()];
  assert.equal(params.line_items[0].price_data.unit_amount, 2250); assert.equal(params.line_items[0].price_data.product_data.name, 'Beard trim & shape');
});
await check('R18 a checkout interrupted before D06 with the colour add-on resumes at its stored price', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false'; const date = openDay();
  const hold = interruptedHold({ appointment_date: date, start_time: '10:00', service_name: 'Haircut + colour', duration_minutes: 60, price_cents: 5750 });
  const response = await book({ requestId: hold.booking_request_id, serviceId: 'haircut', colourAddOn: true, date, time: '10:00', paymentMethod: 'stripe', ...customer({ email: hold.customer_email }) });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal([...checkoutKeys.values()][0].params.line_items[0].price_data.unit_amount, 5750);
});
await check('R18 a new request for a retired service or the add-on is still refused', async () => {
  env.BOOKLY_SYNC_ENABLED = 'false'; const date = openDay();
  assert.equal((await book({ requestId: crypto.randomUUID(), serviceId: 'beard-trim-shape', date, time: '10:00', paymentMethod: 'cash', ...customer() })).status, 400);
  assert.equal((await book({ requestId: crypto.randomUUID(), serviceId: 'haircut', colourAddOn: true, date, time: '10:00', paymentMethod: 'cash', ...customer() })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments').get().n, 0);
});
await check('R18 with the bridge on, a retired-service hold Bookly refuses is released without charging', async () => {
  markFresh(); const date = openDay();
  const hold = interruptedHold({ appointment_date: date, start_time: '10:00', service_id: 'beard-trim-shape', service_name: 'Beard trim & shape', duration_minutes: 20, price_cents: 2250 });
  const response = await book({ requestId: hold.booking_request_id, serviceId: 'beard-trim-shape', date, time: '10:00', paymentMethod: 'stripe', ...customer({ email: hold.customer_email }) });
  assert.equal(response.status, 503); assert.match(response.body.error, /not booked|nothing was charged/i);
  assert.equal(checkoutCreates, 0); assert.deepEqual(slotTimes(hold.id), []);
  assert.notEqual(appointment(hold.id).status, 'payment_pending');
});

console.log(results.join('\n'));
if (failures) { console.error(`${failures} mapping-rejection regression(s) failed`); process.exit(1); }
console.log('PASS: R17 Bookly mapping refusals are held per record without stalling synchronization; R18 interrupted pre-D06 checkouts resume');
