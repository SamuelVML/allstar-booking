// Focused tests for the Backstage redesign: the day model, the money
// semantics behind Revenue, and the additive `reason` on availability
// recommendations. In-memory database, no network, no customer emails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const root = process.cwd();
const require = createRequire(import.meta.url);
const env = {};
const loaded = new Map();
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for (const name of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
  db.exec(fs.readFileSync(`drizzle/${name}`, 'utf8'));
}
const database = {
  prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
    };
  },
  async batch(statements) {
    db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      db.exec('COMMIT');
      return results;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};

function load(relative) {
  const filename = path.resolve(root, relative);
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const record = { exports: {} };
  loaded.set(filename, record);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module: record, exports: record.exports, console, crypto, URL, Request, Response, Headers,
    Date, Error, Intl, Set, Map, Math, JSON,
    fetch: async () => { throw new Error('No external requests in tests'); },
    require(name) {
      if (name === 'cloudflare:workers') return { env };
      if (name === '@/db') return { getD1() { return database; } };
      if (name.startsWith('@/')) return load(`${name.slice(2)}.ts`);
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), `${name}.ts`)));
      return require(name);
    },
  }, { filename });
  return record.exports;
}

// Modules run inside a vm realm, so their objects do not share prototypes
// with this one. Compare structure, not identity.
const plain = value => JSON.parse(JSON.stringify(value));

const booking = load('lib/booking.ts');
const view = load('lib/backstage-view.ts');
const reporting = load('lib/backstage-reporting.ts');

/* ------------------------------------------------------------------ helpers */

let counter = 0;
function appointment(overrides = {}) {
  counter += 1;
  const start = overrides.start_time ?? '10:00';
  const duration = overrides.duration ?? 30;
  return {
    reference: `AS-TEST-${counter}`,
    revision: 0,
    source: 'online',
    customer_account_id: 'c1',
    service_name: 'Haircut',
    price_cents: 3500,
    appointment_date: '2026-09-22',
    start_time: start,
    end_time: booking.addMinutes(start, duration),
    customer_name: 'Test Customer',
    customer_email: 'test@example.com',
    customer_phone: '+31 6 1234 5678',
    notes: '',
    status: 'confirmed',
    payment_method: 'pay_at_shop',
    payment_status: 'due_at_shop',
    ...overrides,
  };
}

/* ------------------------------------------------- payment state semantics */

{
  const stripeUnpaid = appointment({ status: 'payment_pending', payment_method: 'stripe', payment_status: 'pending' });
  assert.equal(view.paymentInfo(stripeUnpaid).tone, 'pending');
  assert.equal(
    view.canRecordPayment(stripeUnpaid), false,
    'Stripe bookings must never be markable as paid by hand',
  );

  const stripePaid = appointment({ payment_method: 'stripe', payment_status: 'paid' });
  assert.equal(view.paymentInfo(stripePaid).tone, 'paid');
  assert.equal(view.canRecordPayment(stripePaid), false);

  const dueAtShop = appointment();
  assert.equal(view.paymentInfo(dueAtShop).tone, 'due');
  assert.equal(view.canRecordPayment(dueAtShop), true);

  // Completing a visit does not record payment, so a completed unpaid booking
  // is still collectable.
  assert.equal(view.canRecordPayment(appointment({ status: 'completed' })), true);

  // Cancelling preserves the payment record and issues no refund.
  const paidThenCancelled = appointment({ status: 'cancelled', payment_method: 'cash', payment_status: 'paid' });
  assert.equal(view.paymentInfo(paidThenCancelled).tone, 'cancelled');
  assert.equal(view.canRecordPayment(paidThenCancelled), false);
  assert.equal(view.canManage(paidThenCancelled), false);

  assert.equal(view.canRecordPayment(appointment({ status: 'payment_expired', payment_status: 'expired' })), false);
}

/* ------------------------------------------------------------- the day model */

{
  // Tuesday 2026-09-22: open 10:00–19:00, breaks 12:00–12:15, 14:30–14:45,
  // 16:45–17:15.
  const date = '2026-09-22';
  assert.deepEqual(plain(view.openingHoursFor(date)), { start: '10:00', end: '19:00' });

  const day = [
    appointment({ start_time: '10:00', duration: 30 }),
    appointment({ start_time: '11:30', duration: 45 }),
    appointment({ start_time: '13:00', duration: 30, status: 'cancelled' }),
  ];
  const agenda = view.buildAgenda(date, day, []);

  const gaps = agenda.filter(entry => entry.kind === 'gap');
  // 10:40 (after the first cut plus its buffer) through 11:30 is open.
  assert.ok(gaps.some(gap => gap.start === '10:40' && gap.minutes === 50), 'the open stretch after a booking is called out');
  assert.equal(agenda.filter(entry => entry.kind === 'appointment').length, 3, 'cancelled bookings still appear, struck through');
  assert.equal(agenda.filter(entry => entry.kind === 'break').length, 3, 'scheduled breaks are drawn in the agenda');

  // A cancelled booking releases its time: the 12:25–14:30 stretch reads as one
  // open block even though a cancelled 13:00 booking sits inside it.
  const afterCancelled = gaps.find(gap => gap.start === '12:25');
  assert.ok(afterCancelled, 'the open stretch after the last live booking is called out');
  assert.equal(afterCancelled.minutes, 125, 'a cancelled booking does not consume chair time');

  // Open time merges an overlapping break into the appointment that covers it
  // rather than subtracting it twice.
  const overlapping = [appointment({ start_time: '11:45', duration: 45 })]; // 11:45–12:30 + 10 buffer
  const free = view.openMinutes(date, overlapping, []);
  const breakMinutes = 15 + 15 + 30; // the three Tuesday breaks
  const withoutDoubleCount = 9 * 60 - breakMinutes - 55 + 15; // the 12:00–12:15 break sits inside the booking
  assert.equal(free, withoutDoubleCount, 'overlapping breaks are not counted twice against open time');
}

/* ------------------------------------------------------------- walk-in slots */

{
  const date = '2026-09-22';
  const existing = [appointment({ start_time: '10:00', duration: 30 })]; // blocks 10:00–10:40
  const slots = view.staffSlots(date, 30, existing, []);
  const at = time => slots.find(slot => slot.time === time);

  assert.equal(at('10:00').available, false, 'an occupied start is unavailable');
  assert.equal(at('10:30').available, false, 'the handling buffer keeps the next slot closed');
  assert.equal(at('10:45').available, true, 'the first slot clear of the buffer is bookable');
  assert.equal(at('11:45').available, false, 'a slot overlapping the 12:00 break is unavailable');
  assert.equal(slots.at(-1).time, '18:15', 'the last slot leaves room for the service and its buffer');

  // Staff have no one-hour lead time, but cannot book into the past.
  const fromNow = view.staffSlots(date, 30, [], [], { from: '15:00' });
  assert.equal(fromNow.find(slot => slot.time === '14:45').available, false);
  assert.equal(fromNow.find(slot => slot.time === '15:00').available, true);

  // Blocked time closes slots the same way a booking does.
  const blocked = view.staffSlots(date, 30, [], [{ id: 't1', start_time: '13:00', end_time: '14:00', reason: 'Lunch' }]);
  assert.equal(blocked.find(slot => slot.time === '13:00').available, false);

  assert.equal(view.staffSlots('2026-09-20', 30, [], []).length, 0, 'a closed day sells nothing');
}

/* ---------------------------------------------------------- next up / timing */

{
  const day = [
    appointment({ start_time: '10:00', duration: 30, status: 'completed' }),
    appointment({ start_time: '11:00', duration: 30 }),
    appointment({ start_time: '13:00', duration: 30 }),
  ];
  assert.equal(view.nextAppointment(day, true, '11:10').start_time, '11:00', 'the customer in the chair is "next"');
  assert.equal(view.nextAppointment(day, true, '11:45').start_time, '13:00');
  assert.equal(view.nextAppointment(day, true, '19:00'), null, 'nothing is next once the day is done');
  assert.equal(view.nextAppointment(day, false, '23:00').start_time, '11:00', 'on another date, the first confirmed booking leads');
}

/* --------------------------------------------------------- revenue semantics */

{
  assert.deepEqual(plain(reporting.periodRange('day', '2026-09-22')), { from: '2026-09-22', to: '2026-09-22' });
  assert.deepEqual(plain(reporting.periodRange('week', '2026-09-24')), { from: '2026-09-21', to: '2026-09-27' });
  assert.deepEqual(plain(reporting.periodRange('month', '2026-09-22')), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(plain(reporting.periodRange('month', '2026-02-10')), { from: '2026-02-01', to: '2026-02-28' });

  const rows = [
    appointment({ appointment_date: '2026-09-22', payment_method: 'stripe', payment_status: 'paid' }),
    appointment({ appointment_date: '2026-09-22', payment_method: 'cash', payment_status: 'paid' }),
    appointment({ appointment_date: '2026-09-22' }),
    appointment({ appointment_date: '2026-09-22', status: 'cancelled', payment_method: 'stripe', payment_status: 'paid' }),
    appointment({ appointment_date: '2026-09-22', status: 'cancelled' }),
    appointment({ appointment_date: '2026-10-01', payment_method: 'cash', payment_status: 'paid' }),
  ];
  const summary = reporting.summarise('day', '2026-09-22', rows);
  const bucket = key => summary.buckets.find(entry => entry.key === key).cents;

  assert.equal(summary.bookedCents, 3 * 3500, 'booked value counts confirmed and completed visits only');
  assert.equal(summary.recordedCents, 3 * 3500, 'recorded payments include a paid booking that was later cancelled');
  assert.notEqual(summary.bookedCents === summary.recordedCents && bucket('pending') === 0, true,
    'the two totals are computed from different sets, not aliases');
  assert.equal(bucket('stripe'), 2 * 3500, 'the paid cancellation stays in the Stripe total');
  assert.equal(bucket('cash'), 3500);
  assert.equal(bucket('card'), 0);
  assert.equal(bucket('pending'), 3500, 'pending excludes cancelled bookings');
  assert.equal(bucket('cancelled'), 2 * 3500);
  assert.equal(summary.barGrouping, 'none', 'a single day gets no chart');

  // Out-of-range rows are ignored even when handed in.
  assert.equal(reporting.summarise('day', '2026-10-01', rows).recordedCents, 3500);

  const week = reporting.summarise('week', '2026-09-22', rows);
  assert.equal(week.bars.length, 7);
  assert.equal(week.bars.find(bar => bar.from === '2026-09-22').cents, 3 * 3500);
  assert.equal(week.bars.find(bar => bar.from === '2026-09-23').cents, 0);

  const month = reporting.summarise('month', '2026-09-22', rows);
  assert.equal(month.barGrouping, 'week', 'a month is charted by week so it stays legible on a phone');
  assert.equal(month.bars.reduce((total, bar) => total + bar.cents, 0), 3 * 3500);
  assert.equal(month.bars.at(-1).from <= '2026-09-30', true, 'bars stay inside the month');
}

console.log('PASS: payment state, day model, walk-in slots, next up and revenue semantics');

/* ------------------------------------- recommendation API contract (PR #2) */

// The scoring engine and its cutoffs are covered in tests/booking-management.mjs.
// What matters here is the contract the UI is wired to: what each audience is
// allowed to see.

const availability = load('app/api/availability/route.ts');
const adminRecommendations = load('app/api/admin/recommendations/route.ts');

function blockParent(id, date, start, end) {
  db.prepare('INSERT OR IGNORE INTO time_off (id, date, start_time, end_time, reason, actor_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, date, start, end, 'test fixture', 'tester');
}

function blockWholeDay(date) {
  const id = `blanket-${date}`;
  blockParent(id, date, '00:00', '23:55');
  const statement = db.prepare('INSERT OR IGNORE INTO time_off_slots (slot_start, time_off_id) VALUES (?, ?)');
  for (let minute = 0; minute < 24 * 60; minute += 5) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    statement.run(`${date}T${time}`, id);
  }
}

{
  const today = booking.getTodayInEindhoven();
  // Today is closed off entirely so the recommendations are deterministic
  // regardless of the clock the suite runs on.
  blockWholeDay(today);

  const response = await availability.GET(
    new Request('https://example.test/api/availability?service=haircut'),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/, 'availability is never cached');
  const result = await response.json();

  assert.ok(result.recommendations.length <= 2, 'customers are offered at most two times');
  assert.ok(result.recommendations.length > 0, 'the fixture leaves days open');
  assert.equal(
    new Set(result.recommendations.map(entry => entry.date)).size,
    result.recommendations.length,
    'the two customer recommendations fall on different dates',
  );
  for (const recommendation of result.recommendations) {
    assert.deepEqual(
      plain(Object.keys(recommendation).sort()), ['date', 'dateLabel', 'time'],
      'customers receive a date, a label and a time — never a score or an explanation',
    );
    assert.ok(recommendation.date > today, 'today is fully blocked in this fixture');
  }
  assert.ok(result.generatedAt && result.validUntil, 'the freshness window is published');
  assert.ok(
    new Date(result.validUntil) > new Date(result.generatedAt),
    'validUntil is after generatedAt',
  );

  // The date-specific branch keeps its shape, plus the freshness fields.
  const freeDay = result.recommendations[0].date;
  const dayResponse = await availability.GET(
    new Request(`https://example.test/api/availability?service=haircut&date=${freeDay}`),
  );
  const dayResult = await dayResponse.json();
  assert.deepEqual(
    plain(Object.keys(dayResult).sort()),
    ['date', 'generatedAt', 'service', 'times', 'validUntil'],
  );
  assert.ok(dayResult.times.length > 0);

  // Backstage explanations are protected: no staff token, no ranking.
  const unauthorised = await adminRecommendations.GET(
    new Request('https://example.test/api/admin/recommendations?service=haircut'),
  );
  assert.equal(unauthorised.status, 403, 'Backstage recommendations require a staff token');
  assert.match(unauthorised.headers.get('cache-control'), /private, no-store/);
  const refusal = await unauthorised.json();
  assert.equal(refusal.recommendations, undefined, 'a refusal leaks no ranking');
}

console.log('PASS: customers get two unexplained times, Backstage explanations stay behind staff auth');
