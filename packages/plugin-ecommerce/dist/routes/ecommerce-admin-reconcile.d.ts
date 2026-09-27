import { APIRoute } from 'astro';

/**
 * GET lists the pending orders and gift card purchases parked for review. POST without an action runs
 * reconciliation, as before actions existed; `{ action: 'retry' | 'release', kind, id, reason }` acts on
 * one parked record and records the administrator and the reason. A release may add
 * `confirmPaymentReturned` (see releaseParkedCommerce).
 */
declare const ALL: APIRoute;

export { ALL };
