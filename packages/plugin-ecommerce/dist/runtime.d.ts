import { StripePaymentAdapter } from './adapters/stripe.js';
import 'stripe';
import './payments-9Bikdd3h.js';

/** Worker secrets are read at request time, never serialized into the Astro build. */
declare function runtimeStripeSecrets(env: Record<string, unknown>): {
    secretKey: string;
    webhookSecret: string;
    mode: string;
};
/**
 * The real payment providers configured in this Worker: Stripe when both secrets match the mode.
 * The simulated `admin_test` provider is never included; only the opt-in admin test route adds it.
 */
declare function runtimePaymentAdapters(env: Record<string, unknown>): StripePaymentAdapter[];

export { runtimePaymentAdapters, runtimeStripeSecrets };
