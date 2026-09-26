/**
 * Money helpers. Every amount is an integer in the currency's minor units: cents for USD, yen for
 * JPY, fils for KWD. This module has no imports, so storefront and admin bundles can use it.
 */

/** Digits after the decimal point, as Intl formats the currency: 2 for USD, 0 for JPY, 3 for KWD. */
export function currencyMinorUnits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** An amount in minor units as text: formatMoney(1250, 'usd') is "$12.50". */
export function formatMoney(amount: number, currency: string, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() })
    .format(fromMinorUnits(amount, currency));
}

/** An amount in major units, such as 12.5 typed into an admin form, in minor units: 1250 for USD. */
export function toMinorUnits(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyMinorUnits(currency));
}

/** An amount in minor units in major units: 1250 is 12.5 in USD and 1250 in JPY. */
export function fromMinorUnits(amount: number, currency: string): number {
  return amount / 10 ** currencyMinorUnits(currency);
}

// Stripe's minimum charge per currency, in minor units:
// https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
const MINIMUM_CHARGES = new Map<string, number>([
  ['usd', 50], ['aed', 200], ['aud', 50], ['bgn', 100], ['brl', 50], ['cad', 50], ['chf', 50],
  ['czk', 1500], ['dkk', 250], ['eur', 50], ['gbp', 30], ['hkd', 400], ['huf', 17500], ['inr', 50],
  ['jpy', 50], ['mxn', 1000], ['myr', 200], ['nok', 300], ['nzd', 50], ['pln', 200], ['ron', 200],
  ['sek', 300], ['sgd', 50], ['thb', 1000],
]);

/**
 * The smallest card charge Stripe accepts in the currency, in minor units. Store credit, discounts
 * and gift cards leave at least this much to pay. A currency missing from the table uses 50; Stripe
 * still enforces its own minimum when it creates the payment.
 */
export function minimumChargeAmount(currency: string): number {
  return MINIMUM_CHARGES.get(currency.toLowerCase()) ?? 50;
}
