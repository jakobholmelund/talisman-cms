/**
 * Money helpers. Every amount is an integer in the currency's minor units: cents for USD, yen for
 * JPY, fils for KWD. This module has no imports, so storefront and admin bundles can use it.
 */
/** Digits after the decimal point, as Intl formats the currency: 2 for USD, 0 for JPY, 3 for KWD. */
declare function currencyMinorUnits(currency: string): number;
/** An amount in minor units as text: formatMoney(1250, 'usd') is "$12.50". */
declare function formatMoney(amount: number, currency: string, locale?: string): string;
/** An amount in major units, such as 12.5 typed into an admin form, in minor units: 1250 for USD. */
declare function toMinorUnits(major: number, currency: string): number;
/** An amount in minor units in major units: 1250 is 12.5 in USD and 1250 in JPY. */
declare function fromMinorUnits(amount: number, currency: string): number;
/** The currencies a store can use, in lowercase: see MINIMUM_CHARGES. */
declare const SUPPORTED_CURRENCIES: readonly string[];
declare function isSupportedCurrency(currency: string): boolean;
/**
 * The smallest card charge Stripe accepts in the currency, in minor units. Store credit, discounts
 * and gift cards leave at least this much to pay. Store currencies all have an entry; 50 is only a
 * fallback for other input, and Stripe still enforces its own minimum when it creates the payment.
 */
declare function minimumChargeAmount(currency: string): number;

export { SUPPORTED_CURRENCIES, currencyMinorUnits, formatMoney, fromMinorUnits, isSupportedCurrency, minimumChargeAmount, toMinorUnits };
