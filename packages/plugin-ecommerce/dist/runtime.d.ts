import { StripePaymentAdapter } from './adapters/stripe.js';
import { AdminTestPaymentAdapter } from './adapters/admin-test.js';
import 'stripe';
import './payments-9Bikdd3h.js';

/** Worker secrets are read at request time, never serialized into the Astro build. */
declare function runtimeStripeSecrets(env: Record<string, unknown>): {
    secretKey: string;
    webhookSecret: string;
    mode: string;
};
declare function runtimePaymentAdapters(env: Record<string, unknown>): (AdminTestPaymentAdapter | StripePaymentAdapter)[];

export { runtimePaymentAdapters, runtimeStripeSecrets };
