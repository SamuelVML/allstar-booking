// Render smoke tests for the Backstage screens.
//
// Every Backstage page is an async server component behind Cloudflare Access,
// so it cannot be exercised by a browser locally. This harness renders each
// one to static HTML against an in-memory database, with authorisation and the
// Next.js navigation helpers mocked *at the harness boundary* — the shipped
// `lib/staff-auth.ts` is never modified and every page keeps its own
// `getStaffUser` check.
//
// It asserts the things a screenshot would have caught: that the pages render
// at all, that the money wording stays honest, and that the barber sees who is
// next.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = process.cwd();
const require = createRequire(import.meta.url);
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
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  },
};

const STAFF = { id: 'render-harness', email: 'amaury@all-star-barbershop.com' };
const requestHeaders = new Headers({ host: 'allstar-booking-test.example.workers.dev' });

function element(tag) {
  const Component = ({ children, ...props }) => {
    const { prefetch, ...rest } = props;
    void prefetch;
    return React.createElement(tag, rest, children);
  };
  Component.displayName = `Mock(${tag})`;
  return Component;
}

const mocks = {
  'next/headers': { headers: async () => requestHeaders },
  'next/navigation': {
    notFound() { throw new Error('notFound() — the page refused to render without staff auth'); },
    usePathname: () => '/admin/bookings',
    useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  },
  'next/link': { __esModule: true, default: element('a') },
  '@/lib/staff-auth': { getStaffUser: async () => STAFF, authoriseStaffMutation: async () => STAFF },
  '@/db': { getD1: () => database, getDb() { throw new Error('unused'); } },
  '@/lib/stripe': { stripeIsConfigured: () => true },
};

function load(relative) {
  const filename = path.resolve(root, relative);
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const record = { exports: {} };
  loaded.set(filename, record);
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  }).outputText;

  const resolve = name => {
    if (mocks[name]) return mocks[name];
    if (name.startsWith('@/')) {
      const base = path.resolve(root, name.slice(2));
      for (const extension of ['.tsx', '.ts']) {
        if (fs.existsSync(`${base}${extension}`)) return load(`${name.slice(2)}${extension}`);
      }
    }
    if (name.startsWith('.')) {
      const base = path.resolve(path.dirname(filename), name);
      for (const extension of ['.tsx', '.ts']) {
        if (fs.existsSync(`${base}${extension}`)) {
          return load(path.relative(root, `${base}${extension}`));
        }
      }
    }
    return require(name);
  };

  vm.runInNewContext(code, {
    module: record, exports: record.exports, require: resolve,
    console, crypto, URL, URLSearchParams, Request, Response, Headers,
    Date, Error, Intl, Set, Map, Math, JSON, Array, Object, String, Number, Boolean, Promise,
    React, process, setTimeout, clearTimeout,
  }, { filename });
  return record.exports;
}

/* ---------------------------------------------------------------- fixtures */

const DAY = '2026-09-22'; // A Tuesday: open 10:00–19:00.
const SERVICE = { id: 'haircut', name: 'Haircut', duration: 30, price: 3500 };

function add(time, minutes) {
  const [hour, minute] = time.split(':').map(Number);
  const total = hour * 60 + minute + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

db.prepare(`INSERT INTO customer_accounts (id,email,name,phone,reminder_opt_in,marketing_consent,loyalty_points,completed_visits,last_visit_at)
  VALUES ('c1','s.bakker@example.com','S. Bakker','+31 6 1234 0005',1,1,9,9,'2026-09-17')`).run();

const seeded = [
  ['a1', DAY, '10:00', 'M. Janssen', 'stripe', 'paid', 'completed', null],
  ['a2', DAY, '13:30', 'S. Bakker', 'pay_at_shop', 'due_at_shop', 'confirmed', 'c1'],
  ['a3', DAY, '17:20', 'D. Vermeer', 'stripe', 'paid', 'cancelled', null],
  ['a4', '2026-09-17', '12:30', 'S. Bakker', 'cash', 'paid', 'completed', 'c1'],
];
for (const [id, date, start, name, method, payment, status, account] of seeded) {
  db.prepare(`INSERT INTO appointments (id,reference,revision,source,service_id,service_name,duration_minutes,
    price_cents,appointment_date,start_time,end_time,customer_name,customer_email,customer_phone,notes,status,
    payment_method,payment_status,customer_account_id,handling_minutes)
    VALUES (?,?,0,'online',?,?,?,?,?,?,?,?,'someone@example.com','+31 6 0000 0000','',?,?,?,?,10)`)
    .run(id, `AS-${date.replaceAll('-', '')}-${id.toUpperCase()}`, SERVICE.id, SERVICE.name,
      SERVICE.duration, SERVICE.price, date, start, add(start, SERVICE.duration), name, status,
      method, payment, account);
  if (status !== 'cancelled') {
    for (let offset = 0; offset < SERVICE.duration + 10; offset += 5) {
      db.prepare('INSERT OR IGNORE INTO appointment_slots (slot_start,appointment_id) VALUES (?,?)')
        .run(`${date}T${add(start, offset)}`, id);
    }
  }
}
db.prepare(`INSERT INTO time_off (id,date,start_time,end_time,reason,actor_id)
  VALUES ('t1',?,'15:30','16:30','Supplier visit','harness')`).run(DAY);
for (let offset = 0; offset < 60; offset += 5) {
  db.prepare('INSERT OR IGNORE INTO time_off_slots (slot_start,time_off_id) VALUES (?,?)')
    .run(`${DAY}T${add('15:30', offset)}`, 't1');
}

/* ----------------------------------------------------------------- renders */

async function render(relative, searchParams = {}) {
  const Page = load(relative).default;
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(searchParams) }));
  assert.ok(html.length > 500, `${relative} rendered almost nothing`);
  return html;
}

const output = {};

output.today = await render('app/admin/bookings/page.tsx', { date: DAY });
assert.match(output.today, /Next up|In the chair/, 'Today answers "who is next"');
assert.match(output.today, /S\. Bakker/, 'the next customer is named');
assert.match(output.today, /Booked value/);
assert.match(output.today, /Recorded/);
assert.match(output.today, /Supplier visit/, 'time off appears in the agenda');
assert.match(output.today, /Break/, 'scheduled breaks appear in the agenda');
assert.match(output.today, /Open ·/, 'open stretches are called out');
assert.ok(
  !/Revenue[^<]*€/.test(output.today),
  'booked value is never labelled revenue',
);

output.calendarDay = await render('app/admin/calendar/page.tsx', { date: DAY, view: 'day' });
assert.match(output.calendarDay, /timeline/);
assert.match(output.calendarDay, /Walk-in \/ time off/);

output.calendarWeek = await render('app/admin/calendar/page.tsx', { date: DAY, view: 'week' });
assert.match(output.calendarWeek, /week-grid/);
assert.match(output.calendarWeek, /share of opening hours already committed/);

output.customers = await render('app/admin/customers/page.tsx', {});
assert.match(output.customers, /S\. Bakker/);
assert.match(output.customers, /Walk-ins have no account|Up to 100 matches/);

output.customerDetail = await render('app/admin/customers/page.tsx', { id: 'c1' });
assert.match(output.customerDetail, /Loyalty points/);
assert.match(output.customerDetail, /Completed visits/);
assert.match(
  output.customerDetail, /Insufficient history/,
  'with two appointment rows against nine recorded visits, the preference is not invented',
);

output.revenueDay = await render('app/admin/revenue/page.tsx', { period: 'day', date: DAY });
assert.match(output.revenueDay, /Money actually received/);
assert.match(output.revenueDay, /Confirmed \+ completed\. Not revenue\./);
assert.match(output.revenueDay, /Online \(Stripe\)/);
assert.match(output.revenueDay, /Cancelled value/);

output.revenueWeek = await render('app/admin/revenue/page.tsx', { period: 'week', date: DAY });
assert.match(output.revenueWeek, /Recorded per day/);

output.settings = await render('app/admin/settings/page.tsx', {});
assert.match(output.settings, /Opening hours/);
assert.match(output.settings, /Handling buffer/);
assert.match(output.settings, new RegExp(STAFF.email.replace('.', '\\.')), 'the signed-in staff email is shown');
assert.ok(!/CF_ACCESS|STRIPE_SECRET|ADMIN_EMAILS/.test(output.settings), 'no configuration is leaked to the page');

// Every page refuses to render without a staff user, independently of the layout.
const refuse = { ...mocks['@/lib/staff-auth'] };
mocks['@/lib/staff-auth'].getStaffUser = async () => null;
loaded.clear();
for (const page of [
  'app/admin/bookings/page.tsx',
  'app/admin/calendar/page.tsx',
  'app/admin/customers/page.tsx',
  'app/admin/revenue/page.tsx',
  'app/admin/settings/page.tsx',
]) {
  await assert.rejects(
    () => render(page, {}),
    /notFound/,
    `${page} must refuse to render for an unauthenticated visitor`,
  );
}
mocks['@/lib/staff-auth'].getStaffUser = refuse.getStaffUser;

if (process.env.BACKSTAGE_HTML_OUT) {
  fs.mkdirSync(process.env.BACKSTAGE_HTML_OUT, { recursive: true });
  const cssDir = 'dist/client/_next/static/css';
  const css = fs.readFileSync(path.join(cssDir, fs.readdirSync(cssDir)[0]), 'utf8');
  const Nav = load('app/admin/nav.tsx').default;
  const nav = renderToStaticMarkup(React.createElement(Nav));
  for (const [name, body] of Object.entries(output)) {
    fs.writeFileSync(
      path.join(process.env.BACKSTAGE_HTML_OUT, `${name}.html`),
      `<!doctype html><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<style>${css}</style>` +
        `<body><div class="bs">${nav}<main class="bs-main">${body}</main></div></body>`,
    );
  }
  console.log(`Wrote ${Object.keys(output).length} HTML renders to ${process.env.BACKSTAGE_HTML_OUT}`);
}

console.log('PASS: all five Backstage screens render, keep the money wording honest, and refuse unauthenticated visitors');
