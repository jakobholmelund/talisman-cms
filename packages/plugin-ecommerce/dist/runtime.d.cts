import { StripePaymentAdapter } from './adapters/stripe.cjs';
import { AdminTestPaymentAdapter } from './adapters/admin-test.cjs';
import 'stripe';
import './payments-9Bikdd3h.cjs';

/** Worker secrets are read at request time, never serialized into the Astro build. */
declare function runtimeStripeSecrets(env: Record<string, unknown>): {
    secretKey: string;
    webhookSecret: string;
    mode: string;
};
declare function runtimePaymentAdapters(env: Record<string, unknown>): (StripePaymentAdapter | AdminTestPaymentAdapter)[];

export { runtimePaymentAdapters, runtimeStripeSecrets };
