import { StripePaymentAdapter } from './adapters/stripe';
import { readSetting } from 'talisman-cms/env';
import { runtimeStripeMode } from './stripe-mode';

/** Worker secrets are read at request time, never serialized into the Astro build. */
export function runtimeStripeSecrets(env: Record<string, unknown>) {
  const mode = runtimeStripeMode(env);
  const localSecretKey = mode === 'test' ? readSetting(env, 'COMMERCE_LOCAL_STRIPE_SECRET_KEY') ?? '' : '';
  const localWebhookSecret = mode === 'test' ? readSetting(env, 'COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET') ?? '' : '';
  const secretKey = typeof env.STRIPE_SECRET_KEY === 'string' && env.STRIPE_SECRET_KEY
    ? env.STRIPE_SECRET_KEY : localSecretKey;
  const webhookSecret = typeof env.STRIPE_WEBHOOK_SECRET === 'string' && env.STRIPE_WEBHOOK_SECRET
    ? env.STRIPE_WEBHOOK_SECRET : localWebhookSecret;
  return { secretKey, webhookSecret, mode };
}

/**
 * The real payment providers configured in this Worker: Stripe when both secrets match the mode.
 * The simulated `admin_test` provider is never included; only the opt-in admin test route adds it.
 */
export function runtimePaymentAdapters(env: Record<string, unknown>): StripePaymentAdapter[] {
  const { secretKey, webhookSecret, mode } = runtimeStripeSecrets(env);
  if (!secretKey.startsWith(`sk_${mode}_`) || !webhookSecret.startsWith('whsec_') || secretKey === 'sk_test_mockkey') return [];
  return [new StripePaymentAdapter({ secretKey, webhookSecret })];
}
