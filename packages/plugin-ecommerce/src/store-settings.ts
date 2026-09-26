import { z } from 'zod';
import { readBinding } from 'talisman-cms/env';
import { isCountryCode } from './countries';

/**
 * How the store sells, read from its `TALISMAN_COMMERCE_*` Worker settings. A store that sets none
 * of them sells in USD, delivers to any country and charges no shipping.
 */
export interface StoreSettings {
  /** Lowercase ISO 4217 code. Every order amount is an integer in its minor units. */
  currency: string;
  /**
   * Uppercase ISO 3166-1 alpha-2 codes of the countries the store delivers to, in the order they
   * are set, or null when it delivers to any country.
   */
  deliveryCountries: string[] | null;
  /**
   * The shipping rates checkout offers, in the order they are set. Empty when the store charges no
   * shipping. With rates, an order that ships goes only where one of them serves.
   */
  shippingRates: ShippingRate[];
}

/** One shipping rate, as set in `TALISMAN_COMMERCE_SHIPPING_RATES`. */
export interface ShippingRate {
  /** Names the rate in checkout requests and on orders: 1 to 40 characters from a-z, 0-9, _ and -. */
  id: string;
  /** Shown to shoppers and on the payment page. */
  label: string;
  /** The charge, in the store currency's minor units. */
  amount: number;
  /** Uppercase codes of the countries the rate serves, or null for every delivery country. */
  countries: string[] | null;
  /** The rate is free once the items total after discounts reaches this amount, in minor units. */
  freeOver: number | null;
  /** The delivery estimate, in business days. */
  minDays: number | null;
  maxDays: number | null;
}

/**
 * A store setting is set but cannot be used. Checkout stops rather than guess; the message names
 * the setting for the Worker log and is never shown to shoppers.
 */
export class StoreSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreSettingsError';
  }
}

/** Reads and checks the store settings. Throws StoreSettingsError when one of them is invalid. */
export function readStoreSettings(env: object): StoreSettings {
  const currency = readCurrency(env);
  const deliveryCountries = readDeliveryCountries(env);
  return { currency, deliveryCountries, shippingRates: readShippingRates(env, deliveryCountries) };
}

/** Logs why the settings were refused, for the operator, and returns the answer for shoppers. */
export function reportStoreSettingsError(error: StoreSettingsError) {
  console.error(`[Commerce] Store settings are invalid: ${error.message}`);
  return 'Checkout is temporarily unavailable.';
}

/**
 * A text setting. Unset or blank is undefined. Any other type is refused: readSetting would ignore
 * it, and the store would quietly fall back to the default.
 */
function readText(env: object, name: string) {
  const value = readBinding(env, name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new StoreSettingsError(`TALISMAN_${name} must be text`);
  return value.trim();
}

function readCurrency(env: object) {
  const value = readText(env, 'COMMERCE_CURRENCY');
  if (value === undefined) return 'usd';
  const currency = value.toLowerCase();
  if (!/^[a-z]{3}$/.test(currency) || !isIntlCurrency(currency)) {
    throw new StoreSettingsError('TALISMAN_COMMERCE_CURRENCY must be a three-letter ISO 4217 code '
      + `such as "usd", not ${JSON.stringify(value)}`);
  }
  return currency;
}

/**
 * Country codes separated by commas or whitespace, or a list of them. Blank is unset. A value that
 * lists no codes, such as an empty list, is refused rather than read as unset, so the store never
 * delivers everywhere by mistake.
 */
function readDeliveryCountries(env: object) {
  const name = 'TALISMAN_COMMERCE_DELIVERY_COUNTRIES';
  const value = readBinding(env, 'COMMERCE_DELIVERY_COUNTRIES');
  if (value === undefined) return null;
  const entries = typeof value === 'string' ? value.split(/[\s,]+/)
    : Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string') ? value : null;
  if (!entries) throw new StoreSettingsError(`${name} must be text or a list of text`);
  const given = [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))];
  const invalid = given.filter((entry) => !isCountryCode(entry.toUpperCase()));
  if (invalid.length) {
    throw new StoreSettingsError(`${name} must list officially assigned ISO 3166-1 alpha-2 codes such as "US", `
      + `not ${invalid.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }
  if (!given.length) {
    throw new StoreSettingsError(`${name} lists no countries; leave it unset to deliver to any country`);
  }
  return [...new Set(given.map((entry) => entry.toUpperCase()))];
}

const MAX_SHIPPING_RATES = 10;
const deliveryDays = z.number().int().min(1).max(365);
const minorUnits = z.number().int().max(Number.MAX_SAFE_INTEGER);

// Unknown keys are refused, so a misspelt `freeOver` never leaves a rate charging more than intended.
// A null optional field counts as left out.
const shippingRateSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/, 'must be 1 to 40 characters from a-z, 0-9, _ and -'),
  label: z.string().trim().min(1).max(100),
  amount: minorUnits.min(0),
  countries: z.array(z.string()).nullish().superRefine((entries, context) => {
    if (!entries) return;
    const invalid = entries.filter((entry) => !isCountryCode(entry.trim().toUpperCase()));
    if (invalid.length) {
      context.addIssue({ code: 'custom', message: 'must list officially assigned ISO 3166-1 alpha-2 codes '
        + `such as "US", not ${invalid.map((entry) => JSON.stringify(entry)).join(', ')}` });
    } else if (!entries.length) {
      context.addIssue({ code: 'custom', message: 'lists no countries; leave it out to serve every delivery country' });
    }
  }),
  freeOver: minorUnits.positive().nullish(),
  minDays: deliveryDays.nullish(),
  maxDays: deliveryDays.nullish(),
}).strict().refine((rate) => rate.minDays == null || rate.maxDays == null || rate.minDays <= rate.maxDays,
  { message: 'must not be more than maxDays', path: ['minDays'] });

const shippingRatesSchema = z.array(shippingRateSchema).superRefine((rates, context) => {
  const seen = new Set<string>();
  rates.forEach((rate, index) => {
    if (seen.has(rate.id)) {
      context.addIssue({ code: 'custom', path: [index, 'id'],
        message: `${JSON.stringify(rate.id)} is used by another rate` });
    }
    seen.add(rate.id);
  });
});

/**
 * A JSON list of rates, as text or a list value. Unset or blank charges no shipping. An empty list is
 * refused rather than read as unset, as the delivery countries are. The message points at the rate
 * and field, such as `[1].amount`, and quotes what is wrong; the values are not secret.
 */
function readShippingRates(env: object, deliveryCountries: string[] | null): ShippingRate[] {
  const name = 'TALISMAN_COMMERCE_SHIPPING_RATES';
  const value = readBinding(env, 'COMMERCE_SHIPPING_RATES');
  if (value === undefined) return [];
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch (error) {
      throw new StoreSettingsError(`${name} must be valid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
    }
  }
  if (!Array.isArray(list)) throw new StoreSettingsError(`${name} must be a JSON list of shipping rates`);
  if (!list.length) throw new StoreSettingsError(`${name} lists no rates; leave it unset to charge no shipping`);
  if (list.length > MAX_SHIPPING_RATES) {
    throw new StoreSettingsError(`${name} must list at most ${MAX_SHIPPING_RATES} rates, not ${list.length}`);
  }
  const parsed = shippingRatesSchema.safeParse(list);
  if (!parsed.success) {
    throw new StoreSettingsError(parsed.error.issues.map((issue) => `${name}${issue.path
      .map((key) => typeof key === 'number' ? `[${key}]` : `.${key}`).join('')}: ${issue.message}`).join('; '));
  }
  return parsed.data.map((rate, index) => {
    const countries = rate.countries ? [...new Set(rate.countries.map((entry) => entry.trim().toUpperCase()))] : null;
    const outside = countries && deliveryCountries ? countries.filter((code) => !deliveryCountries.includes(code)) : [];
    if (outside.length) {
      throw new StoreSettingsError(`${name}[${index}].countries: must be among TALISMAN_COMMERCE_DELIVERY_COUNTRIES, `
        + `not ${outside.map((code) => JSON.stringify(code)).join(', ')}`);
    }
    return { id: rate.id, label: rate.label, amount: rate.amount, countries, freeOver: rate.freeOver ?? null,
      minDays: rate.minDays ?? null, maxDays: rate.maxDays ?? null };
  });
}

function isIntlCurrency(code: string) {
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}
