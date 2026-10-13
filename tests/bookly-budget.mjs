// Per-invocation subrequest budget for Bookly synchronization. Every D1 call,
// Bookly request and Stripe request is counted independently of the code under
// test, and each background run must stay within the configured budget while
// large backlogs, imports, refunds and interruptions resume over later runs.
// SQLite-backed D1 with Bookly and Stripe doubles; not a real Worker runtime.
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

/* ------------------------------------------------ independent subrequest count */
let subrequests = 0;
const database = {
  prepare(sql) { let values=[]; return { bind(...v){values=v;return this;},
    async first(){subrequests++;return db.prepare(sql).get(...values)??null;},
    async all(){subrequests++;return {results:db.prepare(sql).all(...values)};},
    async run(){subrequests++;return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};},
  async batch(statements){subrequests++;db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},
};
// Statements inside a batch call run() on the inner statement; undo their count.
const batchOf = database.batch;
database.batch = async statements => { const before = subrequests; const result = await batchOf(statements); subrequests = before + 1; return result; };

/* ------------------------------------------------------------ Bookly double */
const env = { BOOKLY_SYNC_ENABLED: 'true', BOOKLY_BRIDGE_URL: 'https://wp.example.test/wp-json/allstar-bookly/v1', BOOKLY_BRIDGE_SECRET: 'x'.repeat(40) };
const remote = new Map(); const receipts = new Map(); let nextId = 500;
let bridgeDown = false; let downAtCommand = null; let commandCalls = 0; let loseResponse = null;
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
  subrequests++;
  if (bridgeDown) throw new Error('connect ECONNREFUSED');
  const route = new URL(url).pathname.split('/').pop();
  const input = JSON.parse(options.body);
  if (route === 'snapshot') return Response.json({ complete: true, scopeFrom: '2000-01-01', appointments: [...remote.values()].map(row => ({ ...row })) });
  if (route === 'command') {
    commandCalls++;
    if (downAtCommand !== null && commandCalls >= downAtCommand) { downAtCommand = null; bridgeDown = true; throw new Error('connect ECONNREFUSED'); }
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
    if (loseResponse && loseResponse()) throw new Error('socket hang up');
    return Response.json(receipt);
  }
  throw new Error(`Unexpected route ${route}`);
}

/* ------------------------------------------------------------ Stripe double */
const stripeRefunds = new Map();
const stripe = {
  checkout: { sessions: { async retrieve(id) { subrequests++; return { id, payment_status: 'paid', payment_intent: `pi_${id}` }; } } },
  refunds: { async create(params, options) {
    subrequests++;
    if (!stripeRefunds.has(options.idempotencyKey)) stripeRefunds.set(options.idempotencyKey, { id: `re_${stripeRefunds.size + 1}` });
    return stripeRefunds.get(options.idempotencyKey);
  } },
};

/* ------------------------------------------------------------- module loader */
const modules = new Map();
function load(relative) {
  const filename = path.resolve(root, relative); if (modules.has(filename)) return modules.get(filename).exports;
  const m = { exports: {} }; modules.set(filename, m);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module: m, exports: m.exports, console: { ...console, error() {} }, crypto, TextEncoder, TextDecoder, URL, Request, Response, Headers, AbortSignal, Date, Error, setTimeout, fetch: bridgeFetch,
    require(name) {
      if (name === 'cloudflare:workers') return { env };
      if (name === '@/lib/stripe') return { stripeIsConfigured: () => true, getStripeClient: () => stripe };
      if (name === '@/db') return { getD1: () => database };
      if (name.startsWith('@/')) return load(`${name.slice(2)}.ts`);
      return require(name);
    } }, { filename });
  return m.exports;
}
const bridge = load('lib/bookly.ts');
const budgets = load('lib/subrequest-budget.ts');
const booking = load('lib/booking.ts');
const today = booking.getTodayInEindhoven();
const day = offset => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
let refs = 0;
function localAppointment(fields) {
  const row = { id: crypto.randomUUID(), reference: `AS-B${++refs}`, service_id: 'haircut', service_name: 'Haircut', duration_minutes: 30, price_cents: 3500,
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
const pendingCommands = () => db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE status='pending'").get().n;
const state = () => db.prepare('SELECT * FROM bookly_sync_state WHERE id=1').get();
function reset(budget) {
  db.exec('PRAGMA foreign_keys=OFF');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('bookly_sync_state','booking_settings') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all()) db.exec(`DELETE FROM ${name}`);
  db.exec('PRAGMA foreign_keys=ON');
  db.prepare('UPDATE bookly_sync_state SET lease=NULL,lease_until=0,last_success=NULL,error=NULL WHERE id=1').run();
  remote.clear(); receipts.clear(); stripeRefunds.clear();
  bridgeDown = false; downAtCommand = null; loseResponse = null;
  if (budget === undefined) delete env.BOOKLY_SUBREQUEST_BUDGET; else env.BOOKLY_SUBREQUEST_BUDGET = String(budget);
}
async function syncRun() {
  subrequests = 0;
  try { await bridge.synchronizeBookly(database); return { ok: true, used: subrequests }; }
  catch (error) { return { ok: false, used: subrequests, error: error.message }; }
}
const stats = runs => `runs=${runs.length}, peak=${Math.max(...runs.map(run => run.used))}`;
async function runUntil(done, limit, maxRuns = 200) {
  const runs = [];
  while (runs.length < maxRuns) {
    const run = await syncRun(); runs.push(run);
    assert.ok(run.used <= limit, `run ${runs.length} used ${run.used} subrequests (budget ${limit}): ${run.error ?? 'ok'}`);
    assert.equal(state().lease, null, 'every run releases its lease');
    if (run.ok && done()) return runs;
  }
  throw new Error(`not converged after ${maxRuns} runs: ${JSON.stringify(runs.slice(-3))}`);
}
const results = [];
async function check(name, fn) {
  try { const detail = await fn(); results.push(`PASS ${name}${detail ? ` (${detail})` : ''}`); }
  catch (error) { results.push(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
}
const seedBacklog = count => Array.from({ length: count }, (_, index) => localAppointment({ appointment_date: day(index + 1), start_time: '10:00' }));
function assertExported(rows) {
  const linked = [...remote.values()].filter(row => row.localId);
  assert.equal(linked.length, rows.length, 'every local booking exists exactly once in Bookly');
  assert.equal(new Set(linked.map(row => row.localId)).size, rows.length, 'no duplicate Bookly appointments');
  assert.equal(pendingCommands(), 0);
}

/* ------------------------------------------------------------- configuration */
await check('budget configuration: default fits Workers Free, values are clamped', async () => {
  reset(); assert.equal(budgets.configuredSubrequestBudget(), 40);
  env.BOOKLY_SUBREQUEST_BUDGET = 'many'; assert.equal(budgets.configuredSubrequestBudget(), 40);
  env.BOOKLY_SUBREQUEST_BUDGET = '5'; assert.equal(budgets.configuredSubrequestBudget(), 30);
  env.BOOKLY_SUBREQUEST_BUDGET = '900'; assert.equal(budgets.configuredSubrequestBudget(), 900);
  env.BOOKLY_SUBREQUEST_BUDGET = '1000000'; assert.equal(budgets.configuredSubrequestBudget(), 9500);
  assert.ok(budgets.configuredSubrequestBudget() + 0 > 0);
});

for (const budget of [undefined, 900]) {
  const limit = budget ?? 40;
  const label = budget ? `budget ${budget}` : 'default budget 40';

  await check(`${label}: idle run with 1,000 unchanged Bookly rows stays within budget`, async () => {
    reset(budget);
    for (let index = 0; index < 1000; index += 1) remoteRow({ date: day(1 + (index % 50)), time: clock(600 + 40 * Math.floor(index / 50)) });
    const importRuns = await runUntil(() => db.prepare("SELECT COUNT(*) n FROM appointments WHERE source='bookly'").get().n === 1000, limit);
    const idle = await syncRun();
    assert.equal(idle.ok, true, idle.error);
    assert.ok(idle.used <= 20, `an unchanged snapshot costs a fixed ${idle.used} subrequests, not one per row`);
    assert.equal(db.prepare('SELECT COUNT(DISTINCT appointment_id) n FROM bookly_occupied_slots').get().n, 1000);
    return `import ${stats(importRuns)}, idle run=${idle.used}`;
  });

  await check(`${label}: backlog of 250 drains in bounded runs with occupancy kept fresh`, async () => {
    reset(budget);
    const rows = seedBacklog(250);
    const runs = await runUntil(() => pendingCommands() === 0 && [...remote.values()].filter(row => row.localId).length === 250, limit);
    assert.ok(runs.every(run => run.ok), 'every run completes its snapshot, so availability stays open while the backlog drains');
    assertExported(rows);
    if (budget) assert.equal(runs.length, 3, `paid budget: the 100-command cap binds (${runs.length} runs)`);
    else assert.ok(runs.length > 3, `free budget: smaller batches (${runs.length} runs)`);
    return stats(runs);
  });

  await check(`${label}: backlog survives a lost response and an outage`, async () => {
    reset(budget);
    const rows = seedBacklog(120);
    let sent = 0; loseResponse = () => ++sent === 3;
    const first = await syncRun();
    assert.ok(first.used <= limit); loseResponse = null;
    commandCalls = 0; downAtCommand = 2;
    const second = await syncRun();
    assert.ok(second.used <= limit); assert.equal(second.ok, false);
    bridgeDown = false;
    await runUntil(() => pendingCommands() === 0 && [...remote.values()].filter(row => row.localId).length === 120, limit);
    assertExported(rows);
  });

  await check(`${label}: refund retries resume across runs, each refund exactly once`, async () => {
    reset(budget);
    const cancelled = Array.from({ length: 20 }, (_, index) => {
      const row = localAppointment({ appointment_date: day(-1), start_time: clock(600 + index * 15), status: 'cancelled', payment_method: 'stripe', payment_status: 'paid', stripe_checkout_session_id: `cs_test_${index}` });
      db.prepare("INSERT INTO payment_refunds(id,appointment_id,amount_cents,status,requested_by) VALUES (?,?,3500,'pending','staff')").run(`refund-${row.id}`, row.id);
      return row;
    });
    const runs = await runUntil(() => db.prepare("SELECT COUNT(*) n FROM payment_refunds WHERE status='succeeded'").get().n === 20, limit);
    assert.equal(stripeRefunds.size, 20, 'one Stripe refund per booking');
    assert.ok(cancelled.every(row => db.prepare('SELECT payment_status FROM appointments WHERE id=?').get(row.id).payment_status === 'refunded'));
    return stats(runs);
  });

  await check(`${label}: bookings deleted in Bookly are cancelled and refunded as one unit`, async () => {
    reset(budget);
    const paid = Array.from({ length: 15 }, (_, index) => localAppointment({ appointment_date: day(3 + index), start_time: '11:00', payment_method: 'stripe', payment_status: 'paid', stripe_checkout_session_id: `cs_test_d${index}` }));
    await runUntil(() => pendingCommands() === 0 && [...remote.values()].filter(row => row.localId).length === 15, limit);
    for (const row of [...remote.values()].filter(row => row.localId)) remote.delete(row.remoteId);
    const stranded = () => db.prepare(`SELECT COUNT(*) n FROM appointments a WHERE a.status='cancelled' AND a.payment_status='paid'
      AND NOT EXISTS (SELECT 1 FROM payment_refunds r WHERE r.appointment_id=a.id)`).get().n;
    const runs = [];
    while (db.prepare("SELECT COUNT(*) n FROM payment_refunds WHERE status='succeeded'").get().n < 15) {
      const run = await syncRun(); runs.push(run);
      assert.ok(run.used <= limit, `run used ${run.used}`);
      assert.equal(stranded(), 0, 'no cancellation is ever left without its refund record');
      assert.ok(runs.length < 50, 'converges');
    }
    assert.equal(stripeRefunds.size, 15);
    assert.ok(paid.every(row => db.prepare('SELECT status FROM appointments WHERE id=?').get(row.id).status === 'cancelled'));
    return stats(runs);
  });
}

await check('an exhausted budget records its state and releases the lease', async () => {
  reset();
  seedBacklog(30);
  const run = await syncRun();
  assert.ok(run.used <= 40);
  const budget = new budgets.SubrequestBudget(3);
  subrequests = 0;
  await assert.rejects(bridge.synchronizeBookly(database, budget), /subrequest budget/);
  assert.equal(state().error, 'budget');
  assert.equal(state().lease, null);
  assert.ok(subrequests <= 3 + budgets.CLOSING_RESERVE, `used ${subrequests}`);
});

console.log(results.join('\n'));
const failed = results.filter(line => line.startsWith('FAIL'));
if (failed.length) { console.error(`${failed.length} budget check(s) failed`); process.exit(1); }
console.log('PASS: Bookly sync stays within the per-invocation subrequest budget (default 40 and 900) across idle runs, 250-command backlogs, lost responses, outages, refund retries and Bookly deletions');
