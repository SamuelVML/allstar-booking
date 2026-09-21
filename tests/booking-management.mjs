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
const changes = load('app/api/admin/bookings/change/route.ts');
const complete = load('app/api/admin/bookings/complete/route.ts');
const availability = load('app/api/admin/bookings/availability/route.ts');
const payments = load('lib/payments.ts');
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
for (const handler of [changes.POST, complete.POST]) {
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
db.close();
