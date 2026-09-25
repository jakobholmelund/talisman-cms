import type { PaymentProviderAdapter } from '../payments';

/** Simulates a successful provider response. Only an authenticated admin route may use it. */
export class AdminTestPaymentAdapter implements PaymentProviderAdapter {
  readonly providerId = 'admin_test';
  readonly reservesInventory = false;

  async createCheckoutSession(params: { orderId: string; successUrl: string }) {
    return {
      providerSessionId: `admin_test:${params.orderId}`,
      url: params.successUrl
    };
  }

  async expireCheckoutSession() {
    // No external session or payment exists.
  }

  async getCheckoutSession() {
    return { status: 'open', url: null };
  }
}
