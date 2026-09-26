export interface ValidatedWebhookEvent {
  type: string;
  data: any;
  rawEvent?: any;
}

/** What calculateTax is asked to tax. Every amount is an integer in the currency's minor units. */
export interface TaxCalculationParams {
  /** Lowercase ISO 4217 code of the order. */
  currency: string;
  /** `inclusive` when the amounts below include tax, `exclusive` when tax is added to them. */
  behavior: 'inclusive' | 'exclusive';
  /** The product tax code for every line, or null for the provider's default. */
  taxCode: string | null;
  /**
   * The product lines, each at its total after its share of the discount and store credit. A gift
   * card is a means of payment and never lowers them. `reference` is unique within the calculation.
   */
  lines: Array<{ reference: string; amount: number; quantity: number; /** Overrides taxCode for this line. */ taxCode?: string }>;
  /** The shipping charge, or 0. */
  shippingAmount: number;
  /** Where the order ships, or the billing address when nothing ships. */
  address: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country: string };
  addressSource: 'shipping' | 'billing';
  /** The uppercase code of the country the goods ship from, or null. */
  shipFromCountry: string | null;
}

export interface TaxCalculation {
  /** Names the calculation to recordTaxTransaction. */
  id: string;
  /** The lines and the shipping, plus the exclusive tax. */
  amountTotal: number;
  /** Tax added to the amounts; 0 when they include it. */
  taxAmountExclusive: number;
  /** Tax already inside the amounts; 0 when it is added to them. */
  taxAmountInclusive: number;
}

/**
 * calculateTax rejects with this when the provider cannot place the address for tax, such as a US
 * address without a valid ZIP code. Checkout then asks the shopper to check the address.
 */
export class TaxAddressError extends Error {
  constructor(message = 'The address cannot be located for tax', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TaxAddressError';
  }
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
    /**
     * Tax added to the order (exclusive tax), in minor units. The provider charges an amount above 0
     * with the items and shipping, less the adjustments above. Tax included in the prices is not passed.
     */
    tax?: { amount: number };
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

  /**
   * Calculates the tax on an order before its payment session is created, when the store sets a
   * Stripe tax mode. It records nothing; recordTaxTransaction does that once the order is paid. A
   * provider without all three tax methods cannot take orders while tax is on.
   */
  calculateTax?(params: TaxCalculationParams): Promise<TaxCalculation>;

  /**
   * Records the tax of a paid order from its calculation. Safe to retry: the order id names it.
   * `postedAt` (Unix seconds) dates a late record at the payment, so its liability falls in that period.
   */
  recordTaxTransaction?(params: { orderId: string; calculationId: string; postedAt?: number }): Promise<{ transactionId: string }>;

  /**
   * Reverses `amount` (in minor units, tax included) of an order's recorded tax, to mirror a refund.
   * `reference` names the reversal and no other, so a retry reverses nothing twice.
   */
  reverseTaxTransaction?(params: { orderId: string; transactionId: string; amount: number; reference: string }):
    Promise<{ reversalId: string }>;
}
