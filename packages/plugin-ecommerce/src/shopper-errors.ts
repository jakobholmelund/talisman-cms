/** Only errors explicitly safe for shoppers may cross public checkout/payment boundaries. */
export class ShopperError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 409 | 503, options?: ErrorOptions) {
    super(message, options); this.name = 'ShopperError';
  }
}
export function shopperFailure(error: unknown) {
  if (error instanceof ShopperError) return { error: error.message, code: error.code, status: error.status };
  if (error instanceof SyntaxError) return { error: 'Request must be valid JSON', code: 'invalid_json', status: 400 };
  // Logs intentionally contain neither provider text nor addresses/tokens.
  console.error('[commerce] Shopper operation failed', { name: error instanceof Error ? error.name : typeof error });
  return { error: 'Checkout is unavailable right now. Please try again later.', code: 'checkout_failed', status: 503 };
}
