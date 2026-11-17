/**
 * How the store sells, read from its `TALISMAN_COMMERCE_*` Worker settings. A store that sets none
 * of them sells in USD, delivers to any country and charges no shipping or tax.
 */
interface StoreSettings {
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
    tax: TaxSettings;
}
/**
 * How checkout charges tax, as set in `TALISMAN_COMMERCE_TAX`, `TALISMAN_COMMERCE_TAX_CODE` and
 * `TALISMAN_COMMERCE_SHIP_FROM_COUNTRY`.
 */
interface TaxSettings {
    /**
     * `none` charges no tax. With a Stripe mode, Stripe Tax calculates the tax before payment: under
     * `stripe-inclusive` the prices include it and the order only records it; under `stripe-exclusive`
     * it is added to what the shopper pays.
     */
    mode: 'none' | 'stripe-inclusive' | 'stripe-exclusive';
    /** The Stripe product tax code for every item, such as `txcd_99999999`, or null for the account's default. */
    taxCode: string | null;
    /** The uppercase code of the country the goods ship from, which Stripe Tax is told, or null. */
    shipFromCountry: string | null;
}
/** One shipping rate, as set in `TALISMAN_COMMERCE_SHIPPING_RATES`. */
interface ShippingRate {
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
declare class StoreSettingsError extends Error {
    constructor(message: string);
}
/** Reads and checks the store settings. Throws StoreSettingsError when one of them is invalid. */
declare function readStoreSettings(env: object): StoreSettings;
/** Logs why the settings were refused, for the operator, and returns the answer for shoppers. */
/**
 * The store currency alone, for pages that only show prices: a mistake in another store setting
 * closes checkout but should not stop them. Throws StoreSettingsError for an invalid currency.
 */
declare function readStoreCurrency(env: object): string;

type ShippingSettings = Pick<StoreSettings, 'deliveryCountries' | 'shippingRates'>;
/** A shipping rate as offered for one destination and basket. */
interface ShippingOption {
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
declare function shippingOptionsFor(settings: ShippingSettings, country: string, itemsAmount: number): ShippingOption[];

export { type ShippingRate as S, type TaxSettings as T, type ShippingOption as a, type StoreSettings as b, StoreSettingsError as c, readStoreSettings as d, readStoreCurrency as r, shippingOptionsFor as s };
