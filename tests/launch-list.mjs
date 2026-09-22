import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { drizzle } from 'drizzle-orm/d1';

const require = createRequire(import.meta.url);
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('drizzle/0005_launch_list.sql', 'utf8'));
let unavailable = false;
const d1 = { prepare(sql) {
  let args = [];
  return {
    bind(...values) { args = values; return this; },
    async raw() { return sqlite.prepare(sql).all(...args).map(row => Object.values(row)); },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
  };
} };
function load(file, overrides = {}) {
  const loadedModule = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module: loadedModule, exports: loadedModule.exports, crypto, Request, Response,
    require: name => overrides[name] ?? require(name),
  }, { filename: file });
  return loadedModule.exports;
}
const schema = load('db/schema.ts');
const db = drizzle(d1, { schema });
const { POST } = load('app/api/launch-list/route.ts', {
  '@/db': { getDb() { if (unavailable) throw new Error('private database details'); return db; } },
  '@/db/schema': schema,
});
const valid = { name: ' Test Subscriber ', email: ' Test@Example.com ', consent: true };
const post = body => POST(new Request('https://example.test/api/launch-list', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
}));
for (const input of [
  '{', null, [], {}, { ...valid, email: 'broken@' }, { ...valid, email: 'a b@example.com' },
  { ...valid, name: ' ' }, { ...valid, name: 'a' }, { ...valid, name: 'a'.repeat(121) },
  { ...valid, consent: false }, { ...valid, consent: undefined }, { ...valid, consent: 'true' },
]) assert.equal((await post(input)).status, 400, JSON.stringify(input));
const created = await post({ ...valid, id: 'attacker', source: 'unrelated_marketing', createdAt: 'bad' });
assert.equal(created.status, 201);
assert.equal((await created.json()).status, 'subscribed');
const row = sqlite.prepare('SELECT * FROM launch_list_subscribers').get();
assert.equal(row.name, 'Test Subscriber');
assert.equal(row.email, 'test@example.com');
assert.equal(row.consent, 1);
assert.equal(row.source, 'mobile_barber_launch_list');
assert.notEqual(row.id, 'attacker');
assert.match(row.created_at, /^\d{4}-\d\d-\d\d /);
const duplicate = await post({ ...valid, name: 'Different name' });
assert.equal(duplicate.status, 200);
assert.equal((await duplicate.json()).status, 'already_subscribed');
assert.deepEqual(sqlite.prepare('SELECT * FROM launch_list_subscribers').get(), row);
const concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => post({
  ...valid, email: i % 2 ? 'race@example.com' : ' RACE@EXAMPLE.COM ',
})));
assert.equal(concurrent.filter(response => response.status === 201).length, 1);
assert.equal(concurrent.filter(response => response.status === 200).length, 19);
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM launch_list_subscribers').get().n, 2);
assert.throws(() => sqlite.prepare('INSERT INTO launch_list_subscribers (id,name,email) VALUES (?,?,?)').run('other', 'Test', row.email), /UNIQUE/);
unavailable = true;
const failure = await post(valid);
assert.equal(failure.status, 503);
assert.equal((await failure.json()).error, 'Subscription is temporarily unavailable. Please try again.');
assert.equal((await post('{')).status, 400);
sqlite.close();
console.log('PASS: real migration + Drizzle SQL; validation, normalization, explicit consent/source/timestamp, unique index, duplicates, concurrent requests, controlled database failure');
