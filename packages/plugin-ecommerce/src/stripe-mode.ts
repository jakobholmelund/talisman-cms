import { readSetting } from 'talisman-cms/env';

export type StripeMode = 'test' | 'live';

/** The Stripe mode the store runs in: live only when TALISMAN_COMMERCE_STRIPE_MODE is `live`. */
export function runtimeStripeMode(env: object | null | undefined): StripeMode {
  return readSetting(env, 'COMMERCE_STRIPE_MODE') === 'live' ? 'live' : 'test';
}

/**
 * The mode a Stripe Checkout Session was created in, read from its id (`cs_test_` or `cs_live_`), or
 * null for an id without either prefix. A key of one mode cannot read a session of the other.
 */
export function stripeSessionMode(sessionId: string | null | undefined): StripeMode | null {
  if (sessionId?.startsWith('cs_test_')) return 'test';
  if (sessionId?.startsWith('cs_live_')) return 'live';
  return null;
}
