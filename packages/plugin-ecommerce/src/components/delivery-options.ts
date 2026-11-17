// Shared with the server's checkout calculation; never invent delivery prices or dates in the UI.
export { shippingOptionsFor } from '@talisman-cms/plugin-ecommerce/browser';
export type { ShippingRate } from '@talisman-cms/plugin-ecommerce/browser';

export function estimatedPayment(subtotal: number, shipping: number, reductions: { discountAmount?: number; creditApplied?: number; giftCardApplied?: number } = {}) {
  return Math.max(0, subtotal - (reductions.discountAmount || 0) - (reductions.creditApplied || 0) + shipping - (reductions.giftCardApplied || 0));
}
