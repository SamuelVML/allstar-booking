// A test Worker must never reach live Stripe: STRIPE_REQUIRE_TEST_MODE refuses live keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const env = {};
const m = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('lib/stripe.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
vm.runInNewContext(code, { module: m, exports: m.exports, require(name) { if (name === 'cloudflare:workers') return { env }; return require(name); } });
const stripe = m.exports;
const live = ['sk', 'live', 'example'].join('_'); const restrictedLive = ['rk', 'live', 'example'].join('_');
env.STRIPE_SECRET_KEY = live;
assert.equal(stripe.stripeIsConfigured(), true, 'production behaviour is unchanged when the guard is unset');
env.STRIPE_REQUIRE_TEST_MODE = 'true';
for (const key of [live, restrictedLive, 'garbage']) {
  env.STRIPE_SECRET_KEY = key;
  assert.equal(stripe.stripeIsConfigured(), false, `${key.slice(0, 7)} is refused in test mode`);
  assert.throws(() => stripe.getStripeClient(), /not configured/);
}
for (const key of ['sk_test_example', 'rk_test_example']) {
  env.STRIPE_SECRET_KEY = key;
  assert.equal(stripe.stripeIsConfigured(), true, `${key.slice(0, 8)} is accepted in test mode`);
  assert.ok(stripe.getStripeClient());
}
console.log('PASS: STRIPE_REQUIRE_TEST_MODE refuses live and restricted-live keys; production unchanged when unset');
