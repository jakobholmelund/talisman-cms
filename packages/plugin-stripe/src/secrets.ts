import { readSetting } from 'talisman-cms/env';

export type StripeEnv = Record<string, unknown>;

export const MISSING_SECRET_KEY =
  '[plugin-stripe] STRIPE_SECRET_KEY is not set. Add it as a Worker secret; it is not read from astro.config.';
export const MISSING_WEBHOOK_SECRET =
  '[plugin-stripe] TALISMAN_STRIPE_WEBHOOK_SECRET is not set. Add the signing secret of the /api/stripe/webhooks endpoint as a Worker secret.';

/** Worker settings and secrets, read per request so they never enter the server bundle. */
export async function getWorkerEnv(): Promise<StripeEnv> {
  try {
    const worker = await import('cloudflare:workers');
    return worker.env as unknown as StripeEnv;
  } catch {
    return (globalThis as { process?: { env?: StripeEnv } }).process?.env ?? {};
  }
}

/** `TALISMAN_STRIPE_SECRET_KEY`, else the plain `STRIPE_SECRET_KEY` secret that plugin-ecommerce also reads. */
export function readStripeSecretKey(env: StripeEnv): string | undefined {
  const plain = env.STRIPE_SECRET_KEY;
  return readSetting(env, 'STRIPE_SECRET_KEY') ?? (typeof plain === 'string' && plain.trim() ? plain.trim() : undefined);
}

/**
 * `TALISMAN_STRIPE_WEBHOOK_SECRET`. Each Stripe endpoint has its own signing secret, and the plain
 * `STRIPE_WEBHOOK_SECRET` belongs to plugin-ecommerce's endpoint, so it is not read here.
 */
export function readStripeWebhookSecret(env: StripeEnv): string | undefined {
  return readSetting(env, 'STRIPE_WEBHOOK_SECRET');
}
