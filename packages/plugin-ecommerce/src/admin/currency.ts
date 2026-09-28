// The store currency in the admin, from the meta tag the admin page renders for the plugin's
// `adminSettings: ['COMMERCE_CURRENCY']` (TALISMAN_COMMERCE_CURRENCY). Commerce amounts are integers
// in its minor units. This module has no imports, so it can be tested alone.

export const STORE_CURRENCY_META = 'talisman-setting-commerce-currency';

/** A lower-case ISO 4217 code, or USD for anything that is not one. */
export function normalizeCurrency(value: string | null | undefined) {
  const code = value?.trim().toLowerCase();
  return code && /^[a-z]{3}$/.test(code) ? code : 'usd';
}

/**
 * The currency the store sells in: discount values, referral rewards, store credit and prices are
 * amounts in its minor units. USD outside a browser or without a usable setting.
 */
export function storeCurrency() {
  const content = typeof document === 'undefined' ? undefined
    : document.querySelector(`meta[name="${STORE_CURRENCY_META}"]`)?.getAttribute('content');
  return normalizeCurrency(content);
}
