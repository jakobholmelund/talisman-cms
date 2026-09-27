import { APIRoute } from 'astro';

/**
 * The orders screen's disputes and restocks: POST `{ action: 'list', orderIds }` reads the disputes and
 * stock of those orders, and `{ action: 'restock', orderId, reason, reservations? }` returns a refunded
 * order's stock. Order ids stay in the request body, out of request logs.
 */
declare const ALL: APIRoute;

export { ALL };
