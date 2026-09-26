// src/payments.ts
var TaxAddressError = class extends Error {
  constructor(message = "The address cannot be located for tax", options) {
    super(message, options);
    this.name = "TaxAddressError";
  }
};

export {
  TaxAddressError
};
