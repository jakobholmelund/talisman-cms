import type { APIRoute } from 'astro';
import { bindCommerceApi } from '../api';
import { runtimePaymentAdapters, runtimeStripeSecrets } from '../runtime';
import type { TalismanEnv } from 'talisman-cms/client';

export const POST: APIRoute = async ({ request }) => {
  try {
    const signature = request.headers.get('stripe-signature');
    if (!signature) {
      return new Response(JSON.stringify({ error: 'Missing stripe-signature header' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const payload = await request.text();
    const { env } = await import('cloudflare:workers');
    const runtimeEnv = env as unknown as TalismanEnv & Record<string, unknown>;
    const { secretKey: stripeSecretKey, webhookSecret: stripeWebhookSecret } = runtimeStripeSecrets(runtimeEnv);

    if (!stripeSecretKey || !stripeWebhookSecret) {
      return new Response(JSON.stringify({ error: 'Stripe is not configured' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const api = bindCommerceApi({
      env: runtimeEnv,
      paymentAdapters: runtimePaymentAdapters(runtimeEnv)
    });

    const result = await api.webhooks.handleStripe(payload, signature, stripeWebhookSecret);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
