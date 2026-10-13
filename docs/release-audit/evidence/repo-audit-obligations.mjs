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
let resendCalls = 0; let resendFailures = 0; let resendGate = null;
let clockOffset = 0;
class TestDate extends Date {
  constructor(...args) { if (args.length === 0) super(Date.now() + clockOffset); else super(...args); }
  static now() { return Date.now() + clockOffset; }
}
// Minimal Bookly double: an empty calendar that accepts every command.
let booklyCommands = 0;
async function booklyDouble(url) {
  const route = new URL(url).pathname.split('/').pop();
  if (route === 'snapshot') return Response.json({ complete: true, scopeFrom: '2000-01-01', appointments: [] });
  if (route === 'command') { booklyCommands++; return Response.json({ remoteId: String(1000 + booklyCommands), version: 'a'.repeat(64) }); }
  throw new Error(`Unexpected Bookly route ${route}`);
}
async function fetchDouble(url, options) {
  subrequests++;
  if (String(url).startsWith('https://wp.example.test/')) return booklyDouble(url);
  if (!String(url).startsWith('https://api.resend.com/')) throw new Error(`Unexpected fetch ${url}`);
  resendCalls++;
  if (resendGate) { const gate = resendGate; resendGate = null; await gate; }
  if (resendFailures > 0) { resendFailures--; return new Response('{}', { status: 500 }); }
  const key = options.headers['Idempotency-Key'];
  if (delivered.has(key) && JSON.stringify(delivered.get(key)) !== JSON.stringify(JSON.parse(options.body))) return Response.json({message:'same key, different payload'}, {status:409});
  if (!delivered.has(key)) delivered.set(key, JSON.parse(options.body));
  return Response.json({ id: key });
}

/* ------------------------------------------------------------- module loader */
const modules = new Map();
function load(relative) {
  const filename = path.resolve(root, relative); if (modules.has(filename)) return modules.get(filename).exports;
  const m = { exports: {} }; modules.set(filename, m);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: m, exports: m.exports, console: { ...console, error() {} }, crypto, TextEncoder, TextDecoder, URL, Request, Response, Headers, AbortSignal, Date: TestDate, Error,
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
  resendGate = null; clockOffset = 0; booklyCommands = 0;
  Object.assign(env, { BOOKLY_SYNC_ENABLED: 'false' }); delete env.BOOKLY_BRIDGE_URL; delete env.BOOKLY_BRIDGE_SECRET;
  db.prepare('UPDATE bookly_sync_state SET lease=NULL,lease_until=0,last_success=NULL,error=NULL WHERE id=1').run();
}

reset();
const date=openDay(); const card=paid(date,'10:00');stripeFailures=1;
// Provider accepts message; completion write fails. Refund later succeeds.
db.exec("CREATE TRIGGER audit_email_commit_failure BEFORE UPDATE ON booking_obligations WHEN NEW.kind='notify' AND NEW.status='done' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END");
const response=await vacation(date);
console.log(JSON.stringify({name:'F5 initial notification delivered but completion write failed',response,rows:obligationRows().map(r=>({kind:r.kind,status:r.status,attempts:r.attempts})),delivered:[...delivered.values()].map(v=>v.text)}));
db.exec('DROP TRIGGER audit_email_commit_failure');clockOffset+=2*60_000;
await scheduled.runScheduledTasks();
console.log(JSON.stringify({name:'F5 same key changed refund payload',rows:obligationRows().map(r=>({kind:r.kind,status:r.status,attempts:r.attempts,error:r.last_error})),payment:appointment(card.id).payment_status,delivered:delivered.size}));
for(let i=0;i<8;i++){clockOffset+=70*60_000;await scheduled.runScheduledTasks();}
console.log(JSON.stringify({name:'F5 exhausted retry',rows:obligationRows().map(r=>({kind:r.kind,status:r.status,attempts:r.attempts,error:r.last_error})),resendCalls,delivered:delivered.size}));
