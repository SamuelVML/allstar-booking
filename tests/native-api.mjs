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

const bookings = load('app/api/admin/bookings/route.ts');
const customers = load('app/api/admin/customers/route.ts');
const issuer = 'https://test-team.cloudflareaccess.com';
Object.assign(env, { CF_ACCESS_TEAM_DOMAIN: issuer, CF_ACCESS_AUD: 'staff-app', ADMIN_EMAILS: 'barber@example.com' });
async function request(route, suffix = '', claims = {}) {
  const token = await new jose.SignJWT({ iss: issuer, aud: 'staff-app', sub: 'staff', email: 'barber@example.com', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, ...claims }).setProtectedHeader({alg:'RS256',kid:'test-key'}).sign(privateKey);
  return route.GET(new Request('https://example.com/api/admin/data'+suffix, {headers:{'cf-access-jwt-assertion':token}}));
}
for (const route of [bookings, customers]) {
  assert.equal((await route.GET(new Request('https://example.com'))).status,403);
  assert.equal((await request(route,'',{aud:'production-app'})).status,403);
  assert.equal((await request(route,'',{email:'outsider@example.com'})).status,403);
}
assert.equal(databaseReads,0);
assert.equal((await request(bookings,'?date=2026-02-30')).status,400);
db.prepare("INSERT INTO customer_accounts(id,email,name,phone) VALUES ('c','test@example.com','Test 100%','123')").run();
let result=await request(customers,'?q=100%25');
assert.equal(result.status,200);
assert.equal(result.headers.get('cache-control'),'private, no-store');
assert.equal((await result.json()).customers.length,1);
assert.equal((await (await request(customers,'?q=%27%20OR%201%3D1--')).json()).customers.length,0);
assert.equal((await (await request(customers,'?q=_')).json()).customers.length,0,'wildcards must be literal');
assert.equal((await request(customers,'?q='+ 'a'.repeat(101))).status,400);
db.prepare(`INSERT INTO appointments(id,reference,service_id,service_name,duration_minutes,price_cents,appointment_date,start_time,end_time,customer_name,customer_email,customer_phone,customer_account_id)
 VALUES ('a','TEST','haircut','Haircut',30,3500,'2026-09-22','10:00','10:30','Test','test@example.com','123','c')`).run();
result=await request(bookings,'?date=2026-09-22');
assert.equal(result.status,200);
assert.equal(result.headers.get('cache-control'),'private, no-store');
let body=await result.json();
assert.equal(body.bookings.length,1);
assert.equal(body.bookings[0].reference,'TEST');
assert.equal(body.bookings[0].stripe_checkout_session_id,undefined);
assert.ok(body.services.every(s=>!s.isAddOn));
assert.equal((await (await request(bookings,'?date=2026-09-21')).json()).bookings.length,0);
assert.equal((await (await request(customers,'?id=c')).json()).visits.length,1);
assert.equal((await (await request(customers,'?id=other')).json()).visits.length,0);
db.close();
console.log('PASS: native API rejects missing/wrong audience/outsider tokens before DB access; date filtering, literal search, customer history, no-store and minimal fields');
