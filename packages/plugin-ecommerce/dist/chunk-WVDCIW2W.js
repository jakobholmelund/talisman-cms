// src/checkout-input.ts
import { z } from "zod";
var addressSchema = z.object({
  name: z.string().trim().max(200).optional(),
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(30).optional(),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).optional()
});
var checkoutSchema = z.object({
  customerEmail: z.string().trim().email().max(254).optional(),
  discountCode: z.string().trim().max(32).optional(),
  giftCardCode: z.string().trim().max(37).optional(),
  shippingAddress: addressSchema.optional(),
  billingAddress: addressSchema.optional()
});

export {
  checkoutSchema
};
