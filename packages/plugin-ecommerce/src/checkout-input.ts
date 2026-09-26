import { z } from 'zod';
import { isCountryCode } from './countries';

/** Checkout refusals of a country the shopper can correct. The checkout routes answer them with 400. */
export const INVALID_COUNTRY = 'Enter a valid country code';
export const UNDELIVERABLE_COUNTRY = 'We do not deliver to this country';

export function isCountryError(error: unknown): error is Error {
  return error instanceof Error && (error.message === INVALID_COUNTRY || error.message === UNDELIVERABLE_COUNTRY);
}

/**
 * The address with its country trimmed and in uppercase. A country that is given must be an
 * officially assigned code; a blank one is left to the check for a required shipping address.
 */
export function withCountryCode<T>(address: T): T {
  const country = (address as { country?: unknown } | null | undefined)?.country;
  if (country === undefined || country === null) return address;
  const code = typeof country === 'string' ? country.trim().toUpperCase() : null;
  if (code === null || (code && !isCountryCode(code))) throw new Error(INVALID_COUNTRY);
  return { ...address, country: code };
}

const addressSchema = z.object({
  name: z.string().trim().max(200).optional(),
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(30).optional(),
  // Any case. Only officially assigned codes pass, so a mistyped "UK" is refused rather than stored.
  country: z.string().trim().toUpperCase().refine(isCountryCode, INVALID_COUNTRY).optional()
});

export const checkoutSchema = z.object({
  customerEmail: z.string().trim().email().max(254).optional(),
  discountCode: z.string().trim().max(32).optional(),
  giftCardCode: z.string().trim().max(37).optional(),
  shippingAddress: addressSchema.optional(),
  billingAddress: addressSchema.optional()
});

/** The answer to a checkout body the schema refused. A bad country is named, so the shopper can fix it. */
export function checkoutInputError(error: z.ZodError) {
  return error.issues.some((issue) => issue.path.at(-1) === 'country') ? INVALID_COUNTRY : 'Invalid checkout details';
}
