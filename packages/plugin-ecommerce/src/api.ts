import { commerceContext, type CommerceApiOptions } from './commerce-context';
import { checkCartItems, claimCart, findCart, getOrCreateCart, quoteCart, updateCartItems, type CartItemInput } from './basket';
import { createOrderFromCart, reconcilePendingOrder, resumeCheckout } from './checkout';
import { cancelOrder, createOrder, finalizeOrderPayment, findOrder, findOrderForSession, updateOrderStatus } from './orders';
import { handleStripeWebhook } from './stripe-events';

export type { CommerceApiOptions } from './commerce-context';
export { CART_MAX_LINES, CART_MAX_LINE_QUANTITY, aggregateComponentDemand, type CartItemInput } from './basket';
export { PARKED_CHECKOUT_MESSAGE } from './orders';
export { reconcileCommerce } from './reconcile-job';
export { purgeStaleCommerceData, type CommercePurgeOptions } from './retention';
export { deliverPendingCommerceEmails } from './commerce-emails';
export { PROVIDER_CHECK_RETRY_MESSAGE, ProviderCheckLimitedError } from './provider-checks';
export { ReconcileFailure, type ReconcileFailureCode, type ReconcileResult } from './reconcile';
export { TaxCalculationError } from './tax';
export { WebhookMismatchError, WebhookRetryLaterError, WebhookSignatureError } from './webhook-errors';

/**
 * The commerce API for a site's server code and the plugin's own routes, bound to the Worker's
 * bindings and payment adapters. Each method is a function of its module, called with the same
 * context: the basket in basket.ts, checkout in checkout.ts, orders and their payment in orders.ts
 * and the Stripe webhook in stripe-events.ts.
 */
export function bindCommerceApi(options: CommerceApiOptions) {
  const ctx = commerceContext(options);
  type CheckoutOptions = Parameters<typeof createOrderFromCart>[2];
  type CancelOptions = Parameters<typeof cancelOrder>[2];
  type FulfillmentDetails = Parameters<typeof updateOrderStatus>[3];
  type NewOrder = Parameters<typeof createOrder>[1];
  type PaymentConfirmation = Omit<Parameters<typeof finalizeOrderPayment>[1], 'orderId'>;
  type Line = { productId: string; variantId?: string | null };

  return {
    carts: {
      quote: (cartId: string) => quoteCart(ctx, cartId),
      find: (sessionToken: string | undefined, userId?: string) => findCart(ctx, sessionToken, userId),
      /** Attach the current browser basket to an authenticated shopper account. */
      claim: (sessionToken: string, userId: string, choice?: 'browser' | 'account') => claimCart(ctx, sessionToken, userId, choice),
      getOrCreate: (sessionToken: string, userId?: string) => getOrCreateCart(ctx, sessionToken, userId),
      /**
       * Check an item list against the basket limits and the catalog without writing, for example
       * before creating a basket for it. Returns the list with only the stored fields.
       */
      validateItems: (items: unknown, current: Line[] = []) => checkCartItems(ctx, items, current),
      updateItems: (cartId: string, items: CartItemInput[]) => updateCartItems(ctx, cartId, items),
    },
    orders: {
      resumeFromCart: (cartId: string, options: { limitProviderChecks?: boolean } = {}) => resumeCheckout(ctx, cartId, options),
      reconcilePending: (id: string) => reconcilePendingOrder(ctx, id),
      createFromCart: (cartId: string, options: CheckoutOptions) => createOrderFromCart(ctx, cartId, options),
      create: (data: NewOrder) => createOrder(ctx, data),
      find: (id: string) => findOrder(ctx, id),
      findForSession: (id: string, sessionToken: string | undefined, customerId?: string) => findOrderForSession(ctx, id, sessionToken, customerId),
      updateStatus: (id: string, status: string, fulfillment?: FulfillmentDetails) => updateOrderStatus(ctx, id, status, fulfillment),
      finalizePayment: (id: string, options: PaymentConfirmation) => finalizeOrderPayment(ctx, { orderId: id, ...options }),
      cancel: (id: string, options: CancelOptions = {}) => cancelOrder(ctx, id, options),
    },
    webhooks: {
      handleStripe: (payload: string, signature: string, secret?: string) => handleStripeWebhook(ctx, payload, signature, secret),
    },
  };
}
