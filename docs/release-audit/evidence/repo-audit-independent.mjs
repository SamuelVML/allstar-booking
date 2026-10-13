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
    if (active({ status }) && [...remote.values()].some(row => row.remoteId !== existing?.remoteId && active(row) && overlaps(row, s.date, minutes(s.time), s.durationMinutes + s.handlingMinutes))) {
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
let auditClockOffset=0; class AuditDate extends Date { constructor(...args){if(!args.length)super(Date.now()+auditClockOffset);else super(...args);} static now(){return Date.now()+auditClockOffset;} }
const modules = new Map();
function load(relative) {
  const filename = path.resolve(root, relative); if (modules.has(filename)) return modules.get(filename).exports;
  const m = { exports: {} }; modules.set(filename, m);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module: m, exports: m.exports, console: { ...console, error() {} }, crypto, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, AbortSignal, Date: AuditDate, Error, setTimeout, fetch: bridgeFetch,
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


function show(name, detail) { console.log(JSON.stringify({name,...detail})); }
// An actual failed Stripe request creates status='failed', not 'pending'.
reset();
const paid = localAppointment({appointment_date:day(8),start_time:'10:00',payment_method:'stripe',payment_status:'paid',stripe_checkout_session_id:'cs_test_paid'});
checkoutSessions.set('cs_test_paid',{id:'cs_test_paid',payment_status:'paid',payment_intent:'pi_paid'});
await bridge.pushBooklyChanges(database,[paid.id]);
let r=[...remote.values()].find(r=>r.localId===paid.id);
remoteRow({...r,status:'cancelled'}); stripeFailures=1;
const first=await syncRun(); const later=[];for(let i=0;i<3;i++)later.push(await syncRun());
show('F1 Bookly cancellation refund not retried',{first,later,appointment:appointment(paid.id),refund:db.prepare('SELECT status FROM payment_refunds').get(),refunds:stripeRefunds.size});
// Repeated paid-session callbacks after a failed late refund.
reset(); env.BOOKLY_SYNC_ENABLED='false';
const late=localAppointment({appointment_date:day(8),start_time:'10:00',status:'payment_expired',payment_method:'stripe',payment_status:'expired',stripe_checkout_session_id:'cs_test_late'});
checkoutSessions.set('cs_test_late',{id:'cs_test_late',metadata:{appointment_id:late.id},payment_status:'paid',payment_intent:'pi_late'});stripeFailures=1;
const lateOut=[];for(let i=0;i<3;i++){const response=await sessionRoute.GET(new Request('https://audit.test/api/stripe/session?session_id=cs_test_late'));lateOut.push(await response.json());}
show('F1 late refund retries',{lateOut,refunds:stripeRefunds.size,refund:db.prepare('SELECT status FROM payment_refunds').get()});
// Staff move validated live, then taken by native Bookly before command write.
reset();env.BOOKLY_SYNC_ENABLED='true';markFresh();
const moved=localAppointment({appointment_date:day(8),start_time:'10:00'});
await bridge.pushBooklyChanges(database,[moved.id]);
const mgmt=load('lib/booking-management.ts');
const saved=await mgmt.changeBooking(database,appointment(moved.id),'reschedule','auditor',{date:day(8),time:'11:00'});
remoteRow({date:day(8),time:'11:00'});
const calendar=await bridge.pushAfterCommit(database,[moved.id]);
show('F2 committed move rejected remotely',{calendar,localTime:appointment(moved.id).start_time,localStatus:appointment(moved.id).status,bookly:[...remote.values()].map(r=>({localId:r.localId,time:r.time,status:r.status}))});
const healthy=localAppointment({appointment_date:day(9),start_time:'10:00'});
const beforeSnapshots=calls.snapshot;const stalls=[];for(let i=0;i<3;i++)stalls.push(await syncRun());
show('F3 poison command stalls whole sync',{stalls,snapshotsTaken:calls.snapshot-beforeSnapshots,healthyLinked:!!db.prepare('SELECT * FROM bookly_links WHERE local_id=?').get(healthy.id),pending:pendingCommands()});
// Existing deletion path lacks the adopt() revision guard. Edit between read and cancellation batch.
reset();markFresh();
const raced=localAppointment({appointment_date:day(8),start_time:'10:00'});
await bridge.pushBooklyChanges(database,[raced.id]);remote.clear();
beforeBatch=()=>{db.prepare("UPDATE appointments SET notes='concurrent staff edit',revision=revision+1 WHERE id=?").run(raced.id);};
const racedSync=await syncRun();
show('F4 deletion race releases live appointment slots',{racedSync,localStatus:appointment(raced.id).status,revision:appointment(raced.id).revision,slots:db.prepare('SELECT COUNT(*) n FROM appointment_slots WHERE appointment_id=?').get(raced.id).n});


const afterRace="no second sync before booking";const refill=await load('app/api/bookings/route.ts').POST(new Request('https://audit.test/api/bookings',{method:'POST',body:JSON.stringify({requestId:crypto.randomUUID(),serviceId:'haircut',date:day(8),time:'10:00',name:'New Customer',email:'new@example.test',phone:'0612345678',acceptedTerms:true,paymentMethod:'cash'})}));
show('F4 double booking after deletion race',{afterRace,newBookingStatus:refill.status,confirmed:db.prepare("SELECT reference,start_time FROM appointments WHERE status='confirmed'").all()});
// Interrupted pre-checkout push retains a payment hold but retry never creates Checkout.
reset(); env.BOOKLY_SYNC_ENABLED='true';markFresh();
const publicBookings=load('app/api/bookings/route.ts');
const body={requestId:crypto.randomUUID(),serviceId:'haircut',date:day(8),time:'10:00',name:'Audit Customer',email:'audit@example.test',phone:'0612345678',acceptedTerms:true,paymentMethod:'stripe'};
const req=()=>new Request('https://audit.test/api/bookings',{method:'POST',body:JSON.stringify(body)});
commandsDown=true;let response=await publicBookings.POST(req());const initial={status:response.status,body:await response.json()};
commandsDown=false;response=await publicBookings.POST(req());
show('F7 interrupted push before checkout cannot resume',{initial,retry:{status:response.status,body:await response.json()},local:db.prepare('SELECT status,stripe_checkout_session_id FROM appointments').get(),remote:[...remote.values()].map(r=>r.status)});
// A worker that has lost the sync lease still executes adoption and refund.
reset();markFresh();
const leasePaid=localAppointment({appointment_date:day(8),start_time:'10:00',payment_method:'stripe',payment_status:'paid',stripe_checkout_session_id:'cs_test_lease'});
checkoutSessions.set('cs_test_lease',{id:'cs_test_lease',payment_status:'paid',payment_intent:'pi_lease'});
await bridge.pushBooklyChanges(database,[leasePaid.id]);r=[...remote.values()].find(r=>r.localId===leasePaid.id);remoteRow({...r,status:'cancelled'});
beforeBatch=()=>{auditClockOffset+=121000;db.prepare("UPDATE bookly_sync_state SET lease='replacement-owner',lease_until=? WHERE id=1").run(AuditDate.now()+120000);};
const expired=await syncRun();
show('F8 lost lease still cancels and refunds',{expired,lease:db.prepare('SELECT lease FROM bookly_sync_state').get().lease,status:appointment(leasePaid.id).status,payment:appointment(leasePaid.id).payment_status,refunds:stripeRefunds.size});

reset();env.BOOKLY_SYNC_ENABLED='false';
const v=localAppointment({appointment_date:day(8),start_time:'10:00'});
const vacationResult=await post({action:'block_range',id:crypto.randomUUID(),fromDate:day(8),toDate:day(8),reason:'Audit',cancelConflicts:true});
show('F9 vacation normal hours',{vacationResult,status:appointment(v.id).status,timeOff:db.prepare('SELECT COUNT(*) n FROM time_off').get().n});

reset();env.BOOKLY_SYNC_ENABLED='true';markFresh();
const routeMove=localAppointment({appointment_date:day(8),start_time:'10:00'});await bridge.pushBooklyChanges(database,[routeMove.id]);
beforeCommand=()=>remoteRow({date:day(8),time:'11:00'});
const moveResponse=await load('app/api/admin/bookings/change/route.ts').POST(new Request('https://audit.test/api/admin/bookings/change',{method:'POST',body:JSON.stringify({reference:routeMove.reference,revision:0,action:'reschedule',date:day(8),time:'11:00'})}));
show('F2 route confirms rejected move and notifies',{status:moveResponse.status,body:await moveResponse.json(),notifications:emails.length,localTime:appointment(routeMove.id).start_time});
