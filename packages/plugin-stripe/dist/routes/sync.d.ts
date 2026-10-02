import { APIRoute } from 'astro';

/** Administrator-only audit and explicit recovery; never creates a Stripe resource. */
declare const GET: APIRoute;
declare const POST: APIRoute;

export { GET, POST };
