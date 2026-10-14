// Owner decision D06 (2026-10-14): Bookly is the authoritative source for
// service prices and durations. These checks hold the website catalogue to
// the Bookly catalogue read on 2026-10-14 and prove that the customer booking
// flow, Stripe Checkout, confirmation email and Backstage all charge the same
// price, that appointments booked before D06 keep their stored price, and that
// no add-on combination can be booked.
// SQLite-backed D1 with the real migrations, the real routes and modules; a
// Bookly double (availability only), a Stripe double and a Resend double.
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
const database = {
  prepare(sql) { let values = []; return { bind(...v) { values = v; return this; },
    async first() { return db.prepare(sql).get(...values) ?? null; },
    async all() { return { results: db.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; } }; },
  async batch(statements) {
    db.exec('BEGIN'); const result = [];
    try { for (const s of statements) result.push(await s.run()); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    return result;
  },
};

const env = { BOOKLY_SYNC_ENABLED: 'false', BOOKLY_BRIDGE_URL: 'https://wp.example.test/wp-json/allstar-bookly/v1', BOOKLY_BRIDGE_SECRET: 'x'.repeat(40),
  BOOKLY_SUBREQUEST_BUDGET: '900', RESEND_API_KEY: 're_test', BOOKING_EMAIL_FROM: 'All Star <bookings@example.test>', BOOKING_BUSINESS_NAME: 'All Star', BOOKING_ADMIN_EMAIL: '' };

/* --------------------------------------------- Bookly double (availability) */
const availabilityRequests = [];
async function bridgeFetch(url, options) {
  const route = new URL(url).pathname.split('/').pop();
  const input = JSON.parse(options.body);
  if (route === 'availability') { availabilityRequests.push(input); return Response.json({ days: input.days }); }
  if (route === 'command') return Response.json({ remoteId: String(availabilityRequests.length + 1000), version: 'a'.repeat(64) });
  if (route === 'snapshot') return Response.json({ complete: true, scopeFrom: '2000-01-01', appointments: [] });
  throw new Error(`Unexpected route ${route}`);
}

/* ------------------------------------------------------------ Stripe double */
const checkoutCreates = []; const refunds = [];
const stripe = {
  checkout: { sessions: {
    async create(params) {
      const session = { id: `cs_test_${checkoutCreates.length + 1}`, url: `https://checkout.example.test/${checkoutCreates.length + 1}`, metadata: params.metadata, payment_status: 'unpaid' };
      checkoutCreates.push(params); return session;
    },
    async retrieve(id) { return { id, payment_status: 'paid', payment_intent: `pi_${id}` }; },
    async expire(id) { return { id, status: 'expired' }; } } },
  refunds: { async create(params, options) { refunds.push({ params, key: options?.idempotencyKey }); return { id: `re_${refunds.length}` }; } },
};

/* ------------------------------------------------------------ Resend double */
const deliveries = [];
async function resendFetch(_url, options) { deliveries.push(JSON.parse(options.body)); return Response.json({ id: `email_${deliveries.length}` }); }
const fetchDouble = (url, options) => String(url).startsWith('https://api.resend.com/') ? resendFetch(url, options) : bridgeFetch(url, options);

/* ------------------------------------------------------------- module loader */
const modules = new Map();
function load(relative) {
  const filename = path.resolve(root, relative); if (modules.has(filename)) return modules.get(filename).exports;
  const m = { exports: {} }; modules.set(filename, m);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module: m, exports: m.exports, console: { ...console, error() {}, warn() {} }, crypto, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, AbortSignal,
    Date, Error, Intl, setTimeout: fn => setImmediate(fn), fetch: fetchDouble,
    require(name) {
      if (name === 'cloudflare:workers') return { env };
      if (name === '@/lib/stripe') return { stripeIsConfigured: () => true, getStripeClient: () => stripe };
      if (name === '@/lib/staff-auth') return { async authoriseStaffMutation() { return { id: 'staff-1' }; }, async getStaffUser() { return { id: 'staff-1', email: 'staff@example.test' }; } };
      if (name === '@/db') return { getD1: () => database };
      if (name.startsWith('@/')) {
        const base = path.resolve(root, name.slice(2));
        return load(fs.existsSync(`${base}.ts`) ? `${name.slice(2)}.ts` : `${name.slice(2)}.tsx`);
      }
      return require(name);
    } }, { filename });
  return m.exports;
}
const booking = load('lib/booking.ts');
const catalogueCheck = load('lib/bookly-catalogue.ts');
const bookingsRoute = load('app/api/bookings/route.ts');
const availabilityRoute = load('app/api/availability/route.ts');
const recommendationsRoute = load('app/api/admin/recommendations/route.ts');
const adminBookingsRoute = load('app/api/admin/bookings/route.ts');
const operations = load('app/api/admin/operations/route.ts');
const changeRoute = load('app/api/admin/bookings/change/route.ts');

const bookly = JSON.parse(fs.readFileSync('docs/release-cutover/bookly-catalogue-2026-10-14.json', 'utf8'));
const today = booking.getTodayInEindhoven();
const day = offset => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
// Open weekdays (Tuesday–Saturday) from a week out, one per booking so prices never compete for a slot.
const openDays = []; for (let offset = 8; openDays.length < 40; offset += 1) { const date = day(offset); if ([2, 3, 4, 5, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) openDays.push(date); }
// Every check books in windows no service (60 min + 10 min handling) can overlap with a break:
// 10:00, 13:00 and 15:15 on the n-th open day. Days 0–13 carry one service each.
const serviceDay = index => openDays[index];
const LEGACY_DAYS = [14, 15, 16]; const ADD_ON_DAY = 17; const QUERY_DAY = 18;
const json = async response => ({ status: response.status, body: await response.json() });
const book = body => bookingsRoute.POST(new Request('https://allstar.test/api/bookings', { method: 'POST', body: JSON.stringify(body) })).then(json);
const operation = body => operations.POST(new Request('https://allstar.test/api/admin/operations', { method: 'POST', body: JSON.stringify(body) })).then(json);
const changeBooking = body => changeRoute.POST(new Request('https://allstar.test/api/admin/bookings/change', { method: 'POST', body: JSON.stringify(body) })).then(json);
const appointment = reference => db.prepare('SELECT * FROM appointments WHERE reference=?').get(reference);
let customers = 0;
const customer = () => ({ name: 'Catalogue Customer', email: `catalogue${++customers}@example.test`, phone: '0612345678', acceptedTerms: true });
const minutesOf = label => { const hours = /^(\d+) h$/.exec(label); if (hours) return Number(hours[1]) * 60; const minutes = /^(\d+) min$/.exec(label); assert.ok(minutes, `unparsed Bookly duration "${label}"`); return Number(minutes[1]); };

const results = []; let failures = 0;
async function check(name, fn) {
  env.BOOKLY_SYNC_ENABLED = 'false'; checkoutCreates.length = 0; deliveries.length = 0; refunds.length = 0; availabilityRequests.length = 0;
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')} @ ${(error.stack.split('\n').find(l => l.includes('catalogue-consistency.mjs')) ?? '').trim()}`); }
}

await check('the website catalogue is the Bookly catalogue: same services, prices and durations, one to one', async () => {
  const remote = Object.values(bookly.services);
  assert.equal(booking.SERVICES.length, remote.length, 'one website service per Bookly service');
  assert.equal(new Set(booking.SERVICES.map(s => s.id)).size, booking.SERVICES.length, 'website keys are unique');
  assert.equal(new Set(booking.SERVICES.map(s => s.booklyServiceId)).size, booking.SERVICES.length, 'no two website services share a Bookly service');
  for (const service of remote) {
    const local = booking.SERVICES.find(s => s.booklyServiceId === service.id);
    assert.ok(local, `Bookly service ${service.id} "${service.name.trim()}" is on the website`);
    assert.equal(local.booklyName, service.name.trim(), `Bookly name kept for ${service.id}`);
    assert.equal(local.priceCents, Math.round(service.price * 100), `price of ${service.id} is Bookly's`);
    assert.equal(local.durationMinutes, minutesOf(service.duration), `duration of ${service.id} is Bookly's`);
    const staffPrice = bookly.staff['1'].services[String(service.id)].locations[0].flat_price;
    assert.equal(local.priceCents, Math.round(staffPrice * 100), `Amaury's price for ${service.id} is the service price`);
  }
  assert.equal(Object.values(bookly.services).every(s => s.has_extras === 0), true, 'Bookly has no extras, so the website has no add-ons');
  assert.ok(booking.SERVICES.every(s => !('isAddOn' in s)), 'no add-on entries');
});

await check('the WordPress bridge ships the same one-to-one service map as the Worker', async () => {
  const bundled = JSON.parse(fs.readFileSync('integrations/bookly/allstar-bookly-bridge/service-map.json', 'utf8')).services;
  assert.deepEqual(bundled, { ...booking.BOOKLY_SERVICE_MAP });
  const plugin = fs.readFileSync('integrations/bookly/allstar-bookly-bridge/allstar-bookly-bridge.php', 'utf8');
  assert.match(plugin, /service-map\.json/, 'the plugin reads the bundled map');
  assert.doesNotMatch(plugin, /ALLSTAR_BOOKLY_SERVICES\[/, 'no lookup bypasses the bundled map');
  assert.doesNotMatch(plugin, /array_flip\(ALLSTAR_BOOKLY_SERVICES\)/, 'reverse lookup uses the bundled map');
});

await check('a catalogue read through the bridge is verified against the website (drift is reported, never applied)', async () => {
  const rows = Object.values(bookly.services).map(s => ({ id: String(s.id), title: s.name, duration: String(minutesOf(s.duration) * 60), price: s.price.toFixed(2) }));
  const ok = catalogueCheck.checkBooklyCatalogue({ serviceMap: { ...booking.BOOKLY_SERVICE_MAP }, services: rows });
  assert.deepEqual({ map: ok.serviceMapMatches, all: ok.pricesAndDurationsMatch, differences: [...ok.differences] }, { map: true, all: true, differences: [] });
  const repriced = rows.map(row => row.id === '1' ? { ...row, price: '35.00' } : row);
  const drift = catalogueCheck.checkBooklyCatalogue({ serviceMap: { ...booking.BOOKLY_SERVICE_MAP }, services: repriced });
  assert.equal(drift.pricesAndDurationsMatch, false);
  assert.ok(drift.differences.some(d => d.startsWith('price 1 (haircut): Bookly 3500, website 3350')), drift.differences.join('; '));
  const remapped = catalogueCheck.checkBooklyCatalogue({ serviceMap: { ...booking.BOOKLY_SERVICE_MAP, haircut: 26 }, services: rows });
  assert.equal(remapped.serviceMapMatches, false);
});

await check('every service books online at the Bookly price and duration; the confirmation email quotes the same price', async () => {
  for (const service of booking.SERVICES) {
    deliveries.length = 0;
    const date = serviceDay(booking.SERVICES.indexOf(service));
    const response = await book({ requestId: crypto.randomUUID(), serviceId: service.id, date, time: '10:00', ...customer(), paymentMethod: 'cash' });
    assert.equal(response.status, 201, `${service.id}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.booking.priceCents, service.priceCents, `${service.id} quoted price`);
    assert.equal(response.body.booking.durationMinutes, service.durationMinutes, `${service.id} quoted duration`);
    const row = appointment(response.body.booking.reference);
    assert.equal(row.price_cents, service.priceCents, `${service.id} stored price`);
    assert.equal(row.duration_minutes, service.durationMinutes, `${service.id} stored duration`);
    assert.equal(row.service_id, service.id); assert.equal(row.service_name, service.name);
    const email = deliveries.find(d => d.to?.includes?.(row.customer_email) || JSON.stringify(d.to).includes(row.customer_email));
    assert.ok(email, `${service.id} confirmation email sent`);
    assert.ok(email.text.includes(`Price: ${booking.formatPrice(service.priceCents)}`), `${service.id} email price`);
  }
});

await check('Stripe Checkout charges exactly the Bookly price for every service', async () => {
  for (const service of booking.SERVICES) {
    const before = checkoutCreates.length;
    const response = await book({ requestId: crypto.randomUUID(), serviceId: service.id, date: serviceDay(booking.SERVICES.indexOf(service)), time: '13:00', ...customer(), paymentMethod: 'stripe' });
    assert.equal(response.status, 201, `${service.id}: ${JSON.stringify(response.body)}`);
    assert.ok(response.body.checkoutUrl);
    assert.equal(checkoutCreates.length, before + 1);
    const items = checkoutCreates.at(-1).line_items;
    assert.equal(items.length, 1, 'one line, no add-on line');
    assert.equal(items[0].quantity, 1);
    assert.equal(items[0].price_data.unit_amount, service.priceCents, `${service.id} Checkout amount`);
    assert.equal(items[0].price_data.currency, 'eur');
  }
});

await check('with Bookly enabled, availability asks Bookly for the mapped service and its exact duration', async () => {
  env.BOOKLY_SYNC_ENABLED = 'true';
  db.prepare('UPDATE bookly_sync_state SET last_success=?,error=NULL WHERE id=1').run(new Date().toISOString());
  const settings = booking.DEFAULT_BOOKING_SETTINGS;
  for (const service of booking.SERVICES) {
    availabilityRequests.length = 0;
    const date = openDays[QUERY_DAY];
    const times = await json(await availabilityRoute.GET(new Request(`https://allstar.test/api/availability?service=${service.id}&date=${date}`)));
    assert.equal(times.status, 200, service.id);
    assert.ok(availabilityRequests.length >= 1);
    for (const request of availabilityRequests) {
      assert.equal(request.serviceId, service.id, 'Bookly is asked for the catalogue key the bridge maps');
      assert.ok(service.id in booking.BOOKLY_SERVICE_MAP);
      assert.equal(request.durationMinutes, service.durationMinutes + settings.handlingBufferMinutes);
    }
  }
});

await check('Backstage lists the same services and prices, and a walk-in is priced from the catalogue', async () => {
  const listing = await json(await adminBookingsRoute.GET(new Request(`https://allstar.test/api/admin/bookings?date=${openDays[QUERY_DAY]}`)));
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.services.map(s => [s.id, s.priceCents, s.durationMinutes, s.booklyServiceId]),
    JSON.parse(JSON.stringify(booking.SERVICES.map(s => [s.id, s.priceCents, s.durationMinutes, s.booklyServiceId]))));
  for (const service of booking.SERVICES) {
    const id = crypto.randomUUID();
    const response = await operation({ action: 'walk_in', id, date: serviceDay(booking.SERVICES.indexOf(service)), time: '15:15', serviceId: service.id, name: 'Walk-in', notes: '' });
    assert.equal(response.status, 200, `${service.id}: ${JSON.stringify(response.body)}`);
    const row = db.prepare('SELECT * FROM appointments WHERE id=?').get(id);
    assert.equal(row.price_cents, service.priceCents, `${service.id} walk-in price`);
    assert.equal(row.duration_minutes, service.durationMinutes, `${service.id} walk-in duration`);
  }
});

await check('appointments booked before D06 keep their stored price through reschedule, display and refund', async () => {
  const legacy = [
    { service_id: 'haircut', service_name: 'Haircut', duration_minutes: 30, price_cents: 3500 },
    { service_id: 'haircut-beard', service_name: 'Haircut + beard', duration_minutes: 45, price_cents: 4750 },
    { service_id: 'haircut', service_name: 'Haircut + colour', duration_minutes: 60, price_cents: 5750 },
  ];
  for (const [index, fields] of legacy.entries()) {
    const date = openDays[LEGACY_DAYS[index]]; const id = crypto.randomUUID(); const reference = `AS-LEGACY-${id.slice(0, 6)}`; const session = `cs_legacy_${id.slice(0, 6)}`;
    const end = booking.addMinutes('10:00', fields.duration_minutes);
    db.prepare(`INSERT INTO appointments(id,reference,service_id,service_name,duration_minutes,price_cents,appointment_date,start_time,end_time,customer_name,customer_email,customer_phone,
      status,payment_method,payment_status,source,handling_minutes,stripe_checkout_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed','stripe','paid','online',10,?)`)
      .run(id, reference, fields.service_id, fields.service_name, fields.duration_minutes, fields.price_cents, date, '10:00', end, 'Legacy', `legacy-${id}@example.test`, '0600000000', session);
    for (const slot of booking.makeSlotKeys(date, '10:00', fields.duration_minutes + 10)) db.prepare('INSERT INTO appointment_slots(slot_start,appointment_id) VALUES (?,?)').run(slot, id);
    const listing = await json(await adminBookingsRoute.GET(new Request(`https://allstar.test/api/admin/bookings?date=${date}`)));
    const shown = listing.body.bookings.find(b => b.reference === reference);
    assert.equal(shown.price_cents, fields.price_cents, 'Backstage shows the stored price'); assert.equal(shown.service_name, fields.service_name);
    const moved = await changeBooking({ reference, revision: 0, action: 'reschedule', date, time: '13:00' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const after = appointment(reference);
    assert.deepEqual([after.price_cents, after.duration_minutes, after.service_name, after.start_time], [fields.price_cents, fields.duration_minutes, fields.service_name, '13:00'], 'a reschedule never reprices');
    const cancelled = await changeBooking({ reference, revision: after.revision, action: 'cancel' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const refund = db.prepare('SELECT amount_cents FROM payment_refunds WHERE appointment_id=?').get(id);
    assert.equal(refund?.amount_cents, fields.price_cents, 'the refund is the stored amount, not the new catalogue price');
  }
});

await check('no add-on combination and no legacy service can be booked or quoted', async () => {
  const date = openDays[ADD_ON_DAY];
  const colour = await book({ requestId: crypto.randomUUID(), serviceId: 'haircut', date, time: '10:00', ...customer(), paymentMethod: 'cash', colourAddOn: true });
  assert.equal(colour.status, 400, 'a colour add-on request is refused, not priced or dropped');
  for (const key of [...Object.keys(booking.LEGACY_SERVICE_NAMES), 'haircut+colour', 'student-haircut+colour']) {
    assert.equal(booking.getService(key), undefined, `${key} is not in the catalogue`);
    assert.equal((await book({ requestId: crypto.randomUUID(), serviceId: key, date, time: '10:00', ...customer(), paymentMethod: 'cash' })).status, 400, `${key} booking refused`);
    assert.equal((await availabilityRoute.GET(new Request(`https://allstar.test/api/availability?service=${encodeURIComponent(key)}&date=${date}`))).status, 400, `${key} availability refused`);
    assert.notEqual((await operation({ action: 'walk_in', id: crypto.randomUUID(), date, time: '13:00', serviceId: key, name: 'Walk-in', notes: '' })).status, 200, `${key} walk-in refused`);
  }
  assert.equal((await availabilityRoute.GET(new Request(`https://allstar.test/api/availability?service=haircut&addOn=colour&date=${date}`))).status, 400);
  assert.equal((await recommendationsRoute.GET(new Request(`https://allstar.test/api/admin/recommendations?service=haircut&addOn=colour&date=${date}`))).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE appointment_date=?").get(date).n, 0, 'nothing was booked');
});

await check('the homepage lists every Bookly service at its Bookly price and no add-on', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  for (const language of ['en', 'nl']) {
    const home = renderToStaticMarkup(React.createElement(load('app/site-home.tsx').default, { initialLanguage: language, todayWeekday: 2, bookingSettings: booking.DEFAULT_BOOKING_SETTINGS }));
    for (const service of booking.SERVICES) {
      assert.ok(home.includes(`href="/book?service=${service.id}`), `${language} ${service.id} link`);
      assert.ok(home.includes(booking.formatPrice(service.priceCents).replace(/ /g, '&nbsp;')) || home.includes(booking.formatPrice(service.priceCents)), `${language} ${service.id} price`);
    }
    assert.doesNotMatch(home, /add-on|22,50\)/i, `${language} has no add-on note`);
  }
});

for (const line of results) console.log(line);
if (failures) { console.error(`${failures} catalogue consistency check(s) failed`); process.exit(1); }
console.log('PASS: catalogue consistency (owner decision D06): Bookly prices and durations across booking, checkout, email and Backstage; legacy prices preserved; no add-ons');
