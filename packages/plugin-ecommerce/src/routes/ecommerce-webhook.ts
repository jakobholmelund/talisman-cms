import type { APIRoute } from 'astro';
import { bindCommerceApi, WebhookRetryLaterError, WebhookSignatureError } from '../api';
import { runtimePaymentAdapters, runtimeStripeSecrets } from '../runtime';
import type { TalismanEnv } from 'talisman-cms/client';

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

/**
 * Stripe's webhook. Stripe retries every answer other than 2xx for days and may disable an endpoint
 * that keeps failing, so events this store cannot use are answered 200: those of other integrations and
 * those that cannot be applied (see handleStripe). A refused signature is answered 400, an event that
 * waits for a payment to be recorded 409, and anything unexpected 500, so Stripe delivers it again.
 */
export const POST: APIRoute = async ({ request }) => {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return json({ error: 'Missing stripe-signature header' }, 400);

  try {
    const payload = await request.text();
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv & Record<string, unknown>;
    const { secretKey: stripeSecretKey, webhookSecret: stripeWebhookSecret } = runtimeStripeSecrets(runtimeEnv);
    const paymentAdapters = runtimePaymentAdapters(runtimeEnv);

    if (!stripeSecretKey || !stripeWebhookSecret || !paymentAdapters.length) {
      return json({ error: 'Stripe is not configured' }, 400);
    }

    const api = bindCommerceApi({ env: runtimeEnv, paymentAdapters });
    return json(await api.webhooks.handleStripe(payload, signature, stripeWebhookSecret), 200);
  } catch (error) {
    if (error instanceof WebhookSignatureError) return json({ error: error.message }, 400);
    if (error instanceof WebhookRetryLaterError) return json({ error: error.message, retry: true }, 409);
    // The error's text can name a statement or an order, so it stays in the logs; the payload is not logged.
    console.error('[commerce] Stripe webhook failed', error instanceof Error
      ? { name: error.name, message: error.message } : { name: typeof error });
    return json({ error: 'The event could not be processed; Stripe will retry it' }, 500);
  }
};
