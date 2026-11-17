// src/shopper-errors.ts
var ShopperError = class extends Error {
  constructor(code, message, status, options) {
    super(message, options);
    this.code = code;
    this.status = status;
    this.name = "ShopperError";
  }
};
function shopperFailure(error) {
  if (error instanceof ShopperError) return { error: error.message, code: error.code, status: error.status };
  if (error instanceof SyntaxError) return { error: "Request must be valid JSON", code: "invalid_json", status: 400 };
  console.error("[commerce] Shopper operation failed", { name: error instanceof Error ? error.name : typeof error });
  return { error: "Checkout is unavailable right now. Please try again later.", code: "checkout_failed", status: 503 };
}

export {
  ShopperError,
  shopperFailure
};
