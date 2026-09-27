import { APIRoute } from 'astro';

/**
 * Stripe's webhook. Stripe retries every answer other than 2xx for days and may disable an endpoint
 * that keeps failing, so events this store cannot use are answered 200: those of other integrations and
 * those that cannot be applied (see handleStripe). A refused signature is answered 400, an event that
 * waits for a payment to be recorded 409, and anything unexpected 500, so Stripe delivers it again.
 */
declare const POST: APIRoute;

export { POST };
