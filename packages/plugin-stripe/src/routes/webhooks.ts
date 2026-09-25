import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { getWorkerEnv, MISSING_WEBHOOK_SECRET, readStripeWebhookSecret } from '../secrets';
import type { StripeRuntimeConfig } from '../types';
import { stripeConfig } from 'virtual:talisman-cms/stripe-config';

export const POST: APIRoute = async ({ request }) => {
  const config = stripeConfig as StripeRuntimeConfig | undefined;
  
  if (!config) {
    return new Response(JSON.stringify({ error: 'Stripe plugin config not found in global scope' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { webhooks, logs } = config;
  const webhookSecret = readStripeWebhookSecret(await getWorkerEnv());

  if (!webhookSecret) {
    console.error(MISSING_WEBHOOK_SECRET);
    return new Response(JSON.stringify({ error: 'Stripe webhook secret is not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
    });
  }

  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return new Response(JSON.stringify({ error: 'No stripe-signature header present' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
    });
  }

  // Stripe requires the raw buffer/string to verify signature
  const rawBody = await request.text();

  let event: Stripe.Event;

  try {
    // Verifying the signature needs only the endpoint's signing secret, not the API key.
    event = await Stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret
    );
  } catch (err: any) {
    if (logs) console.error(`⚠️ Webhook signature verification failed: ${err.message}`);
    return new Response(JSON.stringify({ error: `Webhook Error: ${err.message}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (logs) {
    console.log(`✅ Received Stripe webhook event: ${event.type}`);
  }

  // Dispatch event to configured handlers
  if (webhooks) {
    try {
      if (typeof webhooks === 'function') {
        await webhooks(event);
      } else if (typeof webhooks === 'object') {
        // Attempt to find specific handler for this event type
        const handler = webhooks[event.type];
        if (handler && typeof handler === 'function') {
          await handler(event);
        }
      }
    } catch (err: any) {
      if (logs) console.error(`❌ Webhook handler failed for event ${event.type}:`, err);
      // Depending on preference, one may return 500 to tell stripe to retry
      // For now we return 500 so stripe knows to aggressively retry
      return new Response(JSON.stringify({ error: 'Webhook handler failed', message: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Webhook handled successfully
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
