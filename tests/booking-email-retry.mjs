// Regression tests for Resend retry behaviour.
//
// These tests exercise the actual booking-email module with a fake Worker env and
// fake network. Delays are run immediately so the suite stays fast.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const filename = path.resolve("lib/booking-email.ts");
const source = fs.readFileSync(filename, "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: filename,
}).outputText;

const env = {
  RESEND_API_KEY: "re_test",
  BOOKING_EMAIL_FROM: "All Star Barbershop <bookings@example.com>",
  BOOKING_BUSINESS_NAME: "All Star Barbershop",
  BOOKING_ADMIN_EMAIL: "",
};

let fetchImpl = async () => new Response(null, { status: 200 });
const sandboxModule = { exports: {} };
const mocks = {
  "cloudflare:workers": { env },
  "@/lib/booking": {
    formatAppointmentDate: (value) => value,
    formatPrice: (value) => `€${(value / 100).toFixed(2)}`,
    LOYALTY_REWARD_POINTS: 10,
  },
};

vm.runInNewContext(code, {
  module: sandboxModule,
  exports: sandboxModule.exports,
  require(name) {
    if (mocks[name]) return mocks[name];
    throw new Error(`Unexpected import: ${name}`);
  },
  console,
  fetch: (...args) => fetchImpl(...args),
  Response,
  Headers,
  Request,
  Promise,
  Error,
  Object,
  String,
  Array,
  JSON,
  setTimeout(callback) {
    callback();
    return 0;
  },
}, { filename });

const { sendBookingConfirmation } = sandboxModule.exports;
const booking = {
  appointmentId: "apt-retry-test",
  reference: "AS-RETRY",
  customerName: "Test Customer",
  customerEmail: "customer@example.com",
  serviceName: "Haircut",
  date: "2026-09-23",
  time: "13:40",
  endTime: "14:10",
  priceCents: 3500,
  paymentMethod: "Pay at the shop",
};

{
  const statuses = [500, 429, 200];
  const keys = [];
  let calls = 0;
  fetchImpl = async (_url, options) => {
    calls += 1;
    keys.push(new Headers(options.headers).get("Idempotency-Key"));
    return new Response(null, { status: statuses.shift() });
  };

  assert.equal(await sendBookingConfirmation(booking), true);
  assert.equal(calls, 3, "temporary 5xx/429 failures are retried");
  assert.deepEqual(
    keys,
    Array(3).fill("booking-confirmation/apt-retry-test"),
    "every attempt reuses the idempotency key",
  );
}

{
  let calls = 0;
  fetchImpl = async () => {
    calls += 1;
    return new Response("invalid sender", { status: 400 });
  };

  await assert.rejects(
    () => sendBookingConfirmation(booking),
    /Resend rejected booking confirmation \(400\): invalid sender/,
  );
  assert.equal(calls, 1, "permanent 4xx failures are not retried");
}

{
  let calls = 0;
  fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("temporary network failure");
    return new Response(null, { status: 200 });
  };

  assert.equal(await sendBookingConfirmation(booking), true);
  assert.equal(calls, 2, "network failures are retried");
}

console.log("PASS: booking email retries transient failures without duplicating sends");
