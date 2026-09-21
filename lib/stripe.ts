import { env } from "cloudflare:workers";
import Stripe from "stripe";

type PaymentEnvironment = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

function paymentEnvironment() {
  return env as unknown as PaymentEnvironment;
}

export function stripeIsConfigured() {
  return Boolean(paymentEnvironment().STRIPE_SECRET_KEY);
}

export function stripeWebhookIsConfigured() {
  return Boolean(paymentEnvironment().STRIPE_WEBHOOK_SECRET);
}

export function getStripeClient() {
  const secretKey = paymentEnvironment().STRIPE_SECRET_KEY;
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
