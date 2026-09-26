import type { TalismanEnv } from 'talisman-cms/client';
import { claimInterval } from './rate-limits';

/** Public routes ask the payment provider about one order at most once in this many seconds. */
export const PROVIDER_CHECK_INTERVAL_SECONDS = 15;
/** The order status route leaves orders younger than this to the provider's webhook. */
export const PROVIDER_CHECK_MIN_ORDER_AGE_SECONDS = 60;
/** The answer when an order's slot is taken; it never says anything about the payment itself. */
export const PROVIDER_CHECK_RETRY_MESSAGE = 'The payment session was checked moments ago. Please try again in 15 seconds.';

/** A limited release found the order's slot taken; nothing was asked or changed. */
export class ProviderCheckLimitedError extends Error {
  override readonly name = 'ProviderCheckLimitedError';

  constructor() {
    super(PROVIDER_CHECK_RETRY_MESSAGE);
  }
}

/** The 429 a public route answers while the order's slot is taken. */
export function providerCheckLimitResponse() {
  return Response.json({ error: PROVIDER_CHECK_RETRY_MESSAGE }, { status: 429,
    headers: { 'Retry-After': String(PROVIDER_CHECK_INTERVAL_SECONDS), 'Cache-Control': 'no-store' } });
}

/**
 * Whether a public request may ask the payment provider about a pending order now. An order whose
 * provider is one of the Worker's payment adapters has one slot, shared by the order status route,
 * checkout resume and session release and taken atomically at most once per interval; with
 * `minOrderAgeSeconds` the provider is not asked before the order is that old either. Any other order,
 * such as a gift-card or simulated one, makes no provider call and always may. Scheduled and admin
 * reconciliation call the provider directly and are not limited here.
 */
export async function mayAskPaymentProvider(env: TalismanEnv,
  order: { id: string; paymentProvider: string | null; createdAt: Date },
  paymentAdapters: ReadonlyArray<{ providerId: string }>,
  { minOrderAgeSeconds = 0, now = Math.floor(Date.now() / 1000) }: { minOrderAgeSeconds?: number; now?: number } = {}) {
  const provider = order.paymentProvider ?? 'stripe';
  if (!paymentAdapters.some((adapter) => adapter.providerId === provider)) return true;
  if (now - Math.floor(order.createdAt.getTime() / 1000) < minOrderAgeSeconds) return false;
  return claimInterval(env, `order-status:${order.id}`, PROVIDER_CHECK_INTERVAL_SECONDS, now);
}
