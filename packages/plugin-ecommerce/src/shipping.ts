import { isCountryCode } from './countries';
import { SHIPPING_OPTION_UNAVAILABLE, UNDELIVERABLE_COUNTRY } from './checkout-input';
import type { ShippingRate, StoreSettings } from './store-settings';

type ShippingSettings = Pick<StoreSettings, 'deliveryCountries' | 'shippingRates'>;

/** A shipping rate as offered for one destination and basket. */
export interface ShippingOption {
  id: string;
  label: string;
  /** What the shopper pays for it, in minor units: 0 once the items reach `freeOver`. */
  amount: number;
  /** The delivery estimate as text, such as "Delivery in 5–10 business days", or null. */
  description: string | null;
  /** The items total after discounts from which the rate is free, or null. */
  freeOver: number | null;
  minDays: number | null;
  maxDays: number | null;
}

/**
 * The shipping options for a destination, so a storefront can offer them before checkout: the rates
 * that serve `country`, in the order they are set, each with what it costs for items worth
 * `itemsAmount` (the items total after discounts, in minor units). Checkout charges the same, and
 * takes the first option when the shopper chooses none. Empty for a country the store does not
 * deliver to, and for a store without rates, which charges no shipping.
 */
export function shippingOptionsFor(settings: ShippingSettings, country: string, itemsAmount: number): ShippingOption[] {
  return ratesServing(settings, country).map((rate) => ({
    id: rate.id, label: rate.label, amount: shippingCharge(rate, itemsAmount), description: deliveryEstimate(rate),
    freeOver: rate.freeOver, minDays: rate.minDays, maxDays: rate.maxDays,
  }));
}

function ratesServing(settings: ShippingSettings, country: string) {
  const code = typeof country === 'string' ? country.trim().toUpperCase() : '';
  if (!isCountryCode(code) || (settings.deliveryCountries && !settings.deliveryCountries.includes(code))) return [];
  return settings.shippingRates.filter((rate) => !rate.countries || rate.countries.includes(code));
}

/**
 * The rate an order to `country` ships at: the one the shopper chose, else the first that serves
 * the country. Refuses a country no rate serves, and a chosen rate that does not serve it.
 */
export function chooseShippingRate(settings: ShippingSettings, country: string, chosenId?: string) {
  const serving = ratesServing(settings, country);
  if (!serving.length) throw new Error(UNDELIVERABLE_COUNTRY);
  const chosen = chosenId?.trim();
  const rate = chosen ? serving.find((candidate) => candidate.id === chosen) : serving[0];
  if (!rate) throw new Error(SHIPPING_OPTION_UNAVAILABLE);
  return rate;
}

/** What a rate costs for items worth `itemsAmount` after discounts. */
export function shippingCharge(rate: ShippingRate, itemsAmount: number) {
  return rate.freeOver !== null && itemsAmount >= rate.freeOver ? 0 : rate.amount;
}

/** "Delivery in 5–10 business days", or null for a rate without an estimate. */
export function deliveryEstimate(rate: Pick<ShippingRate, 'minDays' | 'maxDays'>) {
  const days = (count: number) => `${count} business day${count === 1 ? '' : 's'}`;
  const { minDays, maxDays } = rate;
  if (minDays !== null && maxDays !== null) {
    return `Delivery in ${minDays === maxDays ? days(maxDays) : `${minDays}–${days(maxDays)}`}`;
  }
  if (maxDays !== null) return `Delivery in up to ${days(maxDays)}`;
  if (minDays !== null) return `Delivery in at least ${days(minDays)}`;
  return null;
}
