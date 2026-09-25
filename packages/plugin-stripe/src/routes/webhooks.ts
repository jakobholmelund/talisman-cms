import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import type { StripePluginConfig } from '../types';
// @ts-ignore - Virtual module provided by plugin
import { stripeConfig } from 'virtual:talisman-cms/stripe-config';

export const POST: APIRoute = async ({ request }) => {
  const config = stripeConfig as StripePluginConfig | undefined;
  
  if (!config) {
    return new Response(JSON.stringify({ error: 'Stripe plugin config not found in global scope' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { stripeSecretKey, stripeWebhooksEndpointSecret, webhooks, logs } = config;

  if (!stripeWebhooksEndpointSecret) {
    return new Response(JSON.stringify({ error: 'Missing stripeWebhooksEndpointSecret configuration' }), {
        status: 400,
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
  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2022-08-01' as any,
  });

  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      stripeWebhooksEndpointSecret
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
