export interface ValidatedWebhookEvent {
  type: string;
  data: any;
  rawEvent?: any;
}

export interface PaymentProviderAdapter {
  /**
   * Identifies the provider (e.g., 'stripe', 'paypal')
   */
  readonly providerId: string;

  /** Test providers can exercise checkout without consuming sellable stock. */
  readonly reservesInventory?: boolean;

  /**
   * Initializes a checkout session for the given order and returns the URL to redirect the user to.
   */
  createCheckoutSession(params: {
    orderId: string;
    /** Lowercase ISO 4217 code of the order. The provider must charge in it and in no other currency. */
    currency: string;
    items: Array<{
      name: string;
      description?: string;
      /** Unit price in the currency's minor units, like every amount here. */
      priceCents: number;
      quantity: number;
    }>;
    customerEmail?: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    /** Store credit reserved on the order; the provider charges the remainder. */
    creditApplied?: number;
    /** Exact promotion discount, calculated by the commerce server. */
    discountApplied?: number;
    /** Gift card tender reserved on the order; the provider charges only the remainder. */
    giftCardApplied?: number;
    /**
     * The order's shipping rate: its label, its charge in minor units and an optional delivery
     * estimate. The provider charges the items and a charge above 0 together, less the adjustments above.
     */
    shipping?: { label: string; amount: number; description?: string };
  }): Promise<{ url: string; providerSessionId: string }>;

  /**
   * Validates a webhook payload and signature, returning a normalized event.
   */
  validateWebhook?(payload: string, signature: string, secret: string): Promise<ValidatedWebhookEvent>;

  /** Stop an open hosted checkout before releasing its stock reservation. */
  expireCheckoutSession?(sessionId: string): Promise<void>;

  /**
   * Delete the single-use discount the provider created for an order's checkout, once that
   * checkout has expired or was cancelled. Resolves when there is nothing to delete.
   */
  discardCheckoutDiscount?(orderId: string): Promise<void>;

  /** Reopen an in-progress hosted checkout after the shopper returns. */
  getCheckoutSession?(sessionId: string): Promise<{
    status: string | null;
    url: string | null;
    paymentStatus?: string | null;
    amountTotal?: number | null;
    currency?: string | null;
    paymentIntentId?: string | null;
    customerEmail?: string | null;
  }>;

  /**
   * Whether the payment is disputed: 'open' while the dispute is undecided, 'lost' once the payment
   * was taken back, otherwise 'none'. Referral awards are released only after it answers 'none'.
   */
  getDisputeStatus?(paymentIntentId: string): Promise<'none' | 'open' | 'lost'>;
}
