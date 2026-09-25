// src/adapters/admin-test.ts
var AdminTestPaymentAdapter = class {
  providerId = "admin_test";
  reservesInventory = false;
  async createCheckoutSession(params) {
    return {
      providerSessionId: `admin_test:${params.orderId}`,
      url: params.successUrl
    };
  }
  async expireCheckoutSession() {
  }
  async getCheckoutSession() {
    return { status: "open", url: null };
  }
};

export {
  AdminTestPaymentAdapter
};
