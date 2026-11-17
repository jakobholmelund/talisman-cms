import {
  ShopperError
} from "./chunk-3MXMGN5I.js";
import {
  isCountryCode
} from "./chunk-USNNZXV4.js";

// src/checkout-input.ts
import { z } from "zod/v4";
var INVALID_COUNTRY = "Enter a valid country code";
var UNDELIVERABLE_COUNTRY = "We do not deliver to this country";
var SHIPPING_OPTION_UNAVAILABLE = "This shipping option is not available for your country";
var TAX_ADDRESS_REQUIRED = "A billing address is required to calculate tax";
var TAX_ADDRESS_UNUSABLE = "Tax cannot be calculated for this address. Check it and try again.";
var TAX_UNAVAILABLE = "Tax could not be calculated. Please try again.";
var correctableRefusals = /* @__PURE__ */ new Set([
  INVALID_COUNTRY,
  UNDELIVERABLE_COUNTRY,
  SHIPPING_OPTION_UNAVAILABLE,
  TAX_ADDRESS_REQUIRED,
  TAX_ADDRESS_UNUSABLE
]);
function isCheckoutDetailsError(error) {
  return error instanceof Error && correctableRefusals.has(error.message);
}
function withCountryCode(address) {
  const country = address?.country;
  if (country === void 0 || country === null) return address;
  const code = typeof country === "string" ? country.trim().toUpperCase() : null;
  if (code === null || code && !isCountryCode(code)) throw new ShopperError("invalid_country", INVALID_COUNTRY, 400);
  return { ...address, country: code };
}
var addressSchema = z.object({
  name: z.string().trim().max(200).optional(),
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(30).optional(),
  // Any case. Only officially assigned codes pass, so a mistyped "UK" is refused rather than stored.
  country: z.string().trim().toUpperCase().refine(isCountryCode, INVALID_COUNTRY).optional()
}).strict();
var checkoutSchema = z.object({
  customerEmail: z.string().trim().email().max(254),
  discountCode: z.string().trim().max(32).optional(),
  giftCardCode: z.string().trim().max(37).optional(),
  shippingAddress: addressSchema.optional(),
  billingAddress: addressSchema.optional(),
  // A rate id from the store's shipping rates. Left out or blank, checkout uses the first rate that
  // serves the country.
  shippingRateId: z.string().trim().max(40).optional()
}).strict();
function checkoutInputError(error) {
  return error.issues.some((issue) => issue.path.at(-1) === "country") ? INVALID_COUNTRY : "Invalid checkout details";
}

export {
  UNDELIVERABLE_COUNTRY,
  SHIPPING_OPTION_UNAVAILABLE,
  TAX_ADDRESS_REQUIRED,
  TAX_ADDRESS_UNUSABLE,
  TAX_UNAVAILABLE,
  isCheckoutDetailsError,
  withCountryCode,
  checkoutSchema,
  checkoutInputError
};
