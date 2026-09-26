import type { TalismanEnv } from 'talisman-cms/client';
import { clientOverLimit } from './rate-limits';

/**
 * New baskets one client network (an IPv4 address or an IPv6 /64) may create per hour. A shopper
 * needs one basket, so this leaves room for shared networks. Changes to an open basket are never
 * counted or refused.
 */
export const NEW_BASKETS_PER_NETWORK_PER_HOUR = 20;
const NEW_BASKET_WINDOW_SECONDS = 60 * 60;

/** The answer to a refused basket creation: the same for every client, with no counts. */
export const BASKET_LIMIT_MESSAGE = 'Too many new baskets. Please try again later.';

/** The 429 for a refused basket creation. Retry-After is the whole window, the longest possible wait. */
export function basketLimitResponse() {
  return Response.json({ error: BASKET_LIMIT_MESSAGE },
    { status: 429, headers: { 'Retry-After': String(NEW_BASKET_WINDOW_SECONDS) } });
}

/**
 * Counts a basket about to be created for the client at `sourceIp` and says whether its network is
 * over the hourly limit. Call it only when a basket will be created, after the items are validated
 * and before the basket cookie or row is written. No client IP (local development, tests) means no
 * limit, as for shopper sign-in.
 */
export function basketCreationOverLimit(env: TalismanEnv, sourceIp: string | null | undefined) {
  return clientOverLimit(env, 'basket-create', sourceIp, {
    limit: NEW_BASKETS_PER_NETWORK_PER_HOUR, windowSeconds: NEW_BASKET_WINDOW_SECONDS,
  });
}
