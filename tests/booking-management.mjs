import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import * as jose from 'jose';

const root = process.cwd();
const require = createRequire(import.meta.url);
const env = {};
const modules = new Map();
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for (const name of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`drizzle/${name}`, 'utf8'));
let databaseReads = 0;
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
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
const publicJwk = { ...await jose.exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const mockedJose = { ...jose, createRemoteJWKSet(url, options) {
  return jose.createRemoteJWKSet(url, { ...options, [jose.customFetch]: async () => new Response(JSON.stringify({ keys: [publicJwk] })) });
} };
function load(relative) {
  const filename = path.resolve(root, relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} }; modules.set(filename, module);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, crypto, URL, Request, Response, Headers, Date, Error,
    fetch: async () => { throw new Error('No external requests in tests'); },
    require(name) {
      if (name === 'cloudflare:workers') return { env };
      if (name === 'jose') return mockedJose;
      if (name === '@/db') return { getD1() { databaseReads++; return database; } };
      if (name.startsWith('@/')) return load(`${name.slice(2)}.ts`);
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), `${name}.ts`)));
      return require(name);
    },
  }, { filename });
  return module.exports;
}
const auth = load('lib/staff-auth.ts');
const management = load('lib/booking-management.ts');
const bookingHelpers = load('lib/booking.ts');
const recommendationEngine = load('lib/recommendations.ts');
const changes = load('app/api/admin/bookings/change/route.ts');
const complete = load('app/api/admin/bookings/complete/route.ts');
const availability = load('app/api/admin/bookings/availability/route.ts');
const payments = load('lib/payments.ts');
const backstage = load('lib/backstage.ts');
const operations = load('app/api/admin/operations/route.ts');
const issuer = 'https://test-team.cloudflareaccess.com';
Object.assign(env, { CF_ACCESS_TEAM_DOMAIN: issuer, CF_ACCESS_AUD: 'staff-app', ADMIN_EMAILS: 'barber@example.com' });
async function token(overrides = {}, signingKey = privateKey) {
  return new jose.SignJWT({ iss: issuer, aud: ['staff-app'], sub: 'staff-id', email: 'barber@example.com', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingKey);
}
const validToken = await token();
const tokenHeaders = value => new Headers({ 'cf-access-jwt-assertion': value });
assert.equal((await auth.getStaffUser(tokenHeaders(validToken))).email, 'barber@example.com');
assert.equal(await auth.getStaffUser(new Headers({ 'cf-access-authenticated-user-email': 'barber@example.com', 'oai-authenticated-user-email': 'barber@example.com' })), null);
for (const overrides of [{ iss: 'https://other.cloudflareaccess.com' }, { aud: ['other-app'] }, { exp: 1 }, { nbf: Math.floor(Date.now()/1000)+3600 }, { email: 'outsider@example.com' }, { sub: '' }, { iat: Math.floor(Date.now()/1000)+3600 }]) {
  assert.equal(await auth.getStaffUser(tokenHeaders(await token(overrides))), null);
}
const wrongKey = await jose.generateKeyPair('RS256');
assert.equal(await auth.getStaffUser(tokenHeaders(await token({}, wrongKey.privateKey))), null);
env.CF_ACCESS_AUD = ''; assert.equal(await auth.getStaffUser(tokenHeaders(validToken)), null); env.CF_ACCESS_AUD = 'staff-app';
const headers = { 'cf-access-jwt-assertion': validToken, 'content-type': 'application/json', origin: 'https://booking.example.com' };
assert.equal(await auth.authoriseStaffMutation(new Request('https://booking.example.com/api/admin/bookings/change', { method: 'POST', headers: { ...headers, origin: 'https://evil.example.com' } })), null);
for (const handler of [changes.POST, complete.POST, operations.POST]) {
  const response = await handler(new Request('https://booking.example.com/api/admin/bookings/change', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-authenticated-user-email': 'barber@example.com' }, body: JSON.stringify({ reference: 'TEST', revision: 0 }) }));
  assert.equal(response.status, 403);
}
assert.equal((await availability.GET(new Request('https://booking.example.com/api/admin/bookings/availability'))).status, 403);
assert.equal(databaseReads, 0, 'unauthorised handlers must not read the database');
assert.equal(bookingHelpers.dateIsValid('2026-02-31'), false);
console.log('PASS: signed staff tokens, spoofed headers, issuer/audience/expiry/allowlist, CSRF and protected routes');

const day = new Date(); day.setUTCDate(day.getUTCDate()+7);
while (day.getUTCDay() !== 2) day.setUTCDate(day.getUTCDate()+1);
const date = day.toISOString().slice(0,10);
function seed(id, time = '10:00', status = 'confirmed', paid = false) {
  db.prepare("INSERT OR IGNORE INTO customer_accounts (id,email,name,phone) VALUES ('customer','client@example.com','Client','123456789')").run();
  db.prepare(`INSERT INTO appointments (id, reference, service_id, service_name, duration_minutes, price_cents, appointment_date, start_time, end_time, customer_name, customer_email, customer_phone, customer_account_id, status, payment_status, payment_method, stripe_checkout_session_id)
    VALUES (?,?,'haircut','Haircut',30,3500,?,?,?,'Client','client@example.com','123456789','customer',?,?,?,?)`)
    .run(id,id,date,time,bookingHelpers.addMinutes(time,30),status,paid?'paid':'due_at_shop',paid?'stripe':'cash',`session-${id}`);
  for (const slot of bookingHelpers.makeSlotKeys(date,time,40)) db.prepare('INSERT INTO appointment_slots VALUES (?,?)').run(slot,id);
  return row(id);
}
function row(id) { return db.prepare('SELECT * FROM appointments WHERE id=?').get(id); }
function slots(id) { return db.prepare('SELECT slot_start FROM appointment_slots WHERE appointment_id=? ORDER BY slot_start').all(id).map(r=>r.slot_start); }
const initial = seed('move');
await management.changeBooking(database, initial, 'reschedule','staff-id',{date,time:'11:00'});
assert.equal(row('move').start_time,'11:00'); assert.equal(row('move').revision,1);
assert.equal(slots('move').length,8);assert.equal(slots('move').at(-1),`${date}T11:35`);
await assert.rejects(management.changeBooking(database,initial,'cancel','staff-id'),/booking changed/);
assert.equal(row('move').status,'confirmed');assert.equal(slots('move').length,8);
await assert.rejects(management.changeBooking(database,row('move'),'reschedule','staff-id',{date,time:'11:30'}),/unavailable/); // Buffer crosses 12:00 break.
seed('occupied','13:00');
await assert.rejects(management.changeBooking(database,row('move'),'reschedule','staff-id',{date,time:'13:00'}),/unavailable/);
// Simulate another booking taking the chosen time after the availability read.
const raceDatabase = { ...database, async batch(statements) { seed('race','15:00'); return database.batch(statements); } };
await assert.rejects(management.changeBooking(raceDatabase,row('move'),'reschedule','staff-id',{date,time:'15:00'}),/slot changed/);
assert.equal(row('move').start_time,'11:00');assert.equal(slots('move').length,8);
assert.equal(db.prepare("SELECT count(*) AS n FROM booking_changes WHERE appointment_id='move'").get().n,1);
await management.changeBooking(database,row('move'),'cancel','staff-id');
assert.equal(row('move').status,'cancelled');assert.equal(slots('move').length,0);
await payments.confirmPaidAppointment(database,'move','session-move');assert.equal(row('move').status,'cancelled');
const paid = seed('paid','10:00','confirmed',true);
await management.changeBooking(database,paid,'cancel','staff-id');assert.equal(row('paid').payment_status,'paid');
await payments.confirmPaidAppointment(database,'paid','session-paid');assert.equal(row('paid').status,'cancelled');
const finish = seed('finish','10:00');
await management.changeBooking(database,finish,'complete','staff-id');
await assert.rejects(management.changeBooking(database,finish,'complete','staff-id'),/booking changed/);
assert.equal(db.prepare("SELECT loyalty_points FROM customer_accounts WHERE id='customer'").get().loyalty_points,1);
await payments.expirePaymentAppointment(database,'finish','session-finish');assert.equal(slots('finish').length,8);
console.log('PASS: migrations, buffer/break checks, stale edits, slot-race rollback, cancellation, paid status, loyalty once, webhook replay safety');

const blockId = crypto.randomUUID();
await backstage.blockTime(database, {id:blockId,date,start:'11:00',end:'11:30',reason:'Personal appointment'}, 'staff-id');
assert.equal((await management.availableForBooking(database,row('occupied'),date)).includes('11:00'),false);
// Database triggers guard public booking inserts too, even after an earlier availability read.
assert.throws(() => db.prepare('INSERT INTO appointment_slots VALUES (?,?)').run(`${date}T11:00`,'occupied'),/Slot unavailable/);
const overlap = crypto.randomUUID();
await assert.rejects(backstage.blockTime(database,{id:overlap,date,start:'12:55',end:'13:15',reason:'Overlap'},'staff-id'),/slot or booking changed/);
assert.equal(db.prepare('SELECT count(*) AS n FROM time_off WHERE id=?').get(overlap).n,0);
assert.equal(db.prepare('SELECT count(*) AS n FROM time_off_slots WHERE slot_start=?').get(`${date}T12:55`).n,0,'partial block must roll back');
await backstage.removeBlock(database,blockId,'staff-id');
await backstage.removeBlock(database,blockId,'staff-id');
assert.equal(db.prepare('SELECT count(*) AS n FROM time_off_slots WHERE time_off_id=?').get(blockId).n,0);
assert.equal(db.prepare('SELECT removed_by FROM time_off WHERE id=?').get(blockId).removed_by,'staff-id');
const walkId = crypto.randomUUID();
await backstage.createWalkIn(database,{id:walkId,date,time:'11:00',serviceId:'haircut',name:'Walk-in',notes:''},'staff-id');
assert.equal(slots(walkId).length,8); assert.equal(row(walkId).source,'walk_in');
assert.equal(row(walkId).payment_status,'due_at_shop');
await management.changeBooking(database,row(walkId),'complete','staff-id');
assert.equal(row(walkId).status,'completed');
assert.equal(row(walkId).payment_status,'due_at_shop','completion must not record payment');
assert.equal(db.prepare('SELECT count(*) AS n FROM loyalty_events WHERE appointment_id=?').get(walkId).n,0);
const receipt = {id:crypto.randomUUID(), reference:row(walkId).reference, revision:row(walkId).revision, method:'card'};
await backstage.recordPayment(database,receipt,'staff-id');
await assert.rejects(backstage.recordPayment(database,receipt,'staff-id'),/Already paid/);
await assert.rejects(backstage.recordPayment(database,{...receipt,id:crypto.randomUUID(),revision:row(walkId).revision},'staff-id'),/Already paid/);
assert.equal(row(walkId).payment_status,'paid'); assert.equal(row(walkId).payment_method,'card');
assert.equal(db.prepare('SELECT amount_cents FROM payment_receipts WHERE appointment_id=?').get(walkId).amount_cents,3500);
assert.equal(db.prepare('SELECT count(*) AS n FROM payment_receipts WHERE appointment_id=?').get(walkId).n,1);
await assert.rejects(backstage.recordPayment(database,{id:crypto.randomUUID(),reference:'paid',revision:row('paid').revision,method:'cash'},'staff-id'),/Already paid/);
// A time-off block wins between the walk-in availability read and its transaction.
const walkRaceId = crypto.randomUUID();
const blockedRace = {...database, async batch(statements) {
  await backstage.blockTime(database,{id:crypto.randomUUID(),date,start:'18:00',end:'18:40',reason:'Race'},'staff-id');
  return database.batch(statements);
}};
await assert.rejects(backstage.createWalkIn(blockedRace,{id:walkRaceId,date,time:'18:00',serviceId:'haircut',name:'Walk-in',notes:''},'staff-id'),/slot or booking changed/);
assert.equal(row(walkRaceId),undefined);
const blockedMove = {...database, async batch(statements) {
  await backstage.blockTime(database,{id:crypto.randomUUID(),date,start:'17:20',end:'18:00',reason:'Race'},'staff-id');
  return database.batch(statements);
}};
await assert.rejects(management.changeBooking(blockedMove,row('occupied'),'reschedule','staff-id',{date,time:'17:20'}),/slot changed/);
assert.equal(row('occupied').start_time,'13:00'); assert.equal(slots('occupied').length,8);
const bad = await operations.POST(new Request('https://booking.example.com/api/admin/operations',{method:'POST',headers,body:JSON.stringify({action:'payment',id:crypto.randomUUID(),reference:'occupied',revision:0,method:'wire'})}));
assert.equal(bad.status,400);
console.log('PASS: time-off collisions and removal, walk-in buffers and completion, payment ledger/replays, concurrent block rollback, protected operations');

const fixedRecommendationNow = new Date('2026-09-22T11:42:00Z'); // 13:42 in Eindhoven.
const immediateTimes = bookingHelpers.buildAvailableTimes('2026-09-22',30,new Set(),10,0,fixedRecommendationNow);
assert.equal(immediateTimes.includes('13:40'),false,'Backstage must never recommend a past time');
assert.equal(immediateTimes.includes('13:45'),true,'Backstage may recommend the next five-minute opening');
const customerTimes = bookingHelpers.buildAvailableTimes('2026-09-22',30,new Set(),10,60,fixedRecommendationNow);
assert.equal(customerTimes.includes('14:40'),false,'Customer recommendations keep the sixty-minute lead time');
assert.equal(customerTimes.includes('14:45'),true);
const recommendationDate = '2026-09-23';
const recommendationOccupied = new Set([
  `${recommendationDate}T13:35`,
  `${recommendationDate}T14:20`,
]);
const rankedRecommendations = recommendationEngine.rankRecommendations({
  availableDays: [{date:recommendationDate,times:['10:00','13:40','15:00']}],
  occupiedSlots: recommendationOccupied,
  durationMinutes: 30,
  serviceName: 'Haircut',
  limit: 3,
  distinctDates: false,
});
assert.equal(rankedRecommendations[0].time,'13:40');
assert.match(rankedRecommendations[0].reason,/between two appointments/);
const multiDayRecommendations = recommendationEngine.rankRecommendations({
  availableDays: [
    {date:'2026-09-23',times:['10:00','11:00']},
    {date:'2026-09-24',times:['10:00']},
    {date:'2026-09-25',times:['10:00']},
  ],
  occupiedSlots: new Set(),
  durationMinutes: 30,
  serviceName: 'Haircut',
  limit: 2,
  distinctDates: true,
});
assert.deepEqual(Array.from(multiDayRecommendations, item => item.date),['2026-09-23','2026-09-24']);
console.log('PASS: real-time cutoffs, compact-gap ranking and distinct-day customer recommendations');

db.close();
