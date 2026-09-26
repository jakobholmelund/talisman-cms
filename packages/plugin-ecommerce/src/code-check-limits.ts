import type { TalismanEnv } from 'talisman-cms/client';
import { clientOverLimit, countRequest } from './rate-limits';

/**
 * Limits on checking entered discount and gift card codes, in fixed one-hour windows. The discount
 * preview and every checkout that carries a code share them, so either way a code gets the same
 * answer under the same budget. A shopper checks a code a few times per order; these leave room for
 * typos and changed baskets while keeping code lookups from one network or one basket to a trickle.
 */
export const CODE_CHECKS_PER_NETWORK_PER_HOUR = 30;
export const CODE_CHECKS_PER_BASKET_PER_HOUR = 10;
const CODE_CHECK_WINDOW_SECONDS = 60 * 60;

/** The shopper-facing answer over either limit. */
export const CODE_CHECK_LIMIT_MESSAGE = 'Too many code checks. Please try again later.';

/**
 * Counts a code check from the client network (IPv6 per /64) and says whether it is over the limit.
 * Without a client IP (tests, local development) there is no network limit; the basket limit holds.
 */
export function codeChecksOverNetworkLimit(env: TalismanEnv, sourceIp: string | null | undefined, now: number) {
  return clientOverLimit(env, 'code-check', sourceIp,
    { limit: CODE_CHECKS_PER_NETWORK_PER_HOUR, windowSeconds: CODE_CHECK_WINDOW_SECONDS, now });
}

/** Counts a code check for a basket and says whether it is over the limit. */
export async function codeChecksOverBasketLimit(env: TalismanEnv, cartId: string, now: number) {
  const count = await countRequest(env, `code-check-basket:${cartId}`, now, CODE_CHECK_WINDOW_SECONDS);
  return (count ?? CODE_CHECKS_PER_BASKET_PER_HOUR + 1) > CODE_CHECKS_PER_BASKET_PER_HOUR;
}
