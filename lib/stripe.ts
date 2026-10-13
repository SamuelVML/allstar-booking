import { env } from "cloudflare:workers";
import Stripe from "stripe";

type PaymentEnvironment = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_REQUIRE_TEST_MODE?: string;
};

function paymentEnvironment() {
  return env as unknown as PaymentEnvironment;
}

/** Test Workers set STRIPE_REQUIRE_TEST_MODE=true: a live key is then treated
 * as missing, so no charge or refund can reach live Stripe. Production leaves
 * it unset.
 */
function usableSecretKey() {
  const { STRIPE_SECRET_KEY: secretKey, STRIPE_REQUIRE_TEST_MODE: testOnly } = paymentEnvironment();
  if (!secretKey) return undefined;
  if (testOnly === "true" && !/^(sk|rk)_test_/.test(secretKey)) return undefined;
  return secretKey;
}

export function stripeIsConfigured() {
  return Boolean(usableSecretKey());
}

export function stripeWebhookIsConfigured() {
  return Boolean(paymentEnvironment().STRIPE_WEBHOOK_SECRET);
}

export function getStripeClient() {
  const secretKey = usableSecretKey();
  if (!secretKey) throw new Error("Stripe is not configured.");
  return new Stripe(secretKey, {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function getStripeWebhookSecret() {
  const secret = paymentEnvironment().STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("Stripe webhook verification is not configured.");
  return secret;
}
