import { P as PaymentProviderAdapter } from '../payments-Dtu__rfy.js';

/** Simulates a successful provider response. Only an authenticated admin route may use it. */
declare class AdminTestPaymentAdapter implements PaymentProviderAdapter {
    readonly providerId = "admin_test";
    readonly reservesInventory = false;
    createCheckoutSession(params: {
        orderId: string;
        successUrl: string;
    }): Promise<{
        providerSessionId: string;
        url: string;
    }>;
    expireCheckoutSession(): Promise<void>;
    getCheckoutSession(): Promise<{
        status: string;
        url: null;
    }>;
}

export { AdminTestPaymentAdapter };
