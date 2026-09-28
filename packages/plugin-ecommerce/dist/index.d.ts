import { BlockDefinition, Plugin } from 'talisman-cms';
export { CART_MAX_LINES, CART_MAX_LINE_QUANTITY, TaxCalculationError, bindCommerceApi, deliverPendingCommerceEmails, reconcileCommerce } from './api.js';
export { P as PaymentProviderAdapter, a as PaymentReferences, T as TaxAddressError, b as TaxCalculation, c as TaxCalculationParams, V as ValidatedWebhookEvent } from './payments-TQo6Ws_B.js';
export { CommerceEmailTemplates } from './emails.js';
export { StripePaymentAdapter } from './adapters/stripe.js';
export { AdminTestPaymentAdapter } from './adapters/admin-test.js';
export { SUPPORTED_CURRENCIES, currencyMinorUnits, formatMoney, fromMinorUnits, isSupportedCurrency, minimumChargeAmount, toMinorUnits } from './money.js';
import 'talisman-cms/client';
import './email-deliveries-CyzibTug.js';
import 'talisman-cms/email';
import 'stripe';

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

/**
 * The officially assigned ISO 3166-1 alpha-2 country codes, in uppercase and sorted. Reserved,
 * user-assigned and withdrawn codes, such as UK, EU, XK or AN, are not among them.
 */
declare const COUNTRY_CODES: readonly string[];
/** Whether `code` is one of COUNTRY_CODES. It is case-sensitive, so trim and uppercase input first. */
declare function isCountryCode(code: string): boolean;

interface EcommercePluginConfig {
    /**
     * The slug of the collection to treat as Products.
     * If not provided, a default `products` collection will be created.
     * @default 'products'
     */
    productsCollectionSlug?: string;
    /**
     * Whether to inject the standard `_ecommerce_orders`, `_ecommerce_carts`, and `_ecommerce_categories` collections into the CMS UI.
     * If false, these tables will still be created in the DB and available via Local API, but hidden from the Admin Panel.
     * @default true
     */
    injectCollections?: boolean;
    /**
     * Overrides for the Orders, Promotions, Gift cards and Test checkout links in the Commerce
     * section, for stores with specialized admin workflows. Each is a path relative to the admin path,
     * such as `extensions/orders`, or an absolute path on the site, such as `/orders`. The integration
     * refuses anything that is not a path on the site, such as a full URL, at config time.
     */
    adminPages?: Partial<Record<'orders' | 'promotions' | 'giftCards' | 'testCheckout', string>>;
    /**
     * Adds the admin-only Test checkout screen and `/admin/api/ecommerce/test-checkout`, which place
     * orders through the simulated `admin_test` payment provider. When false, neither is injected and
     * the simulated provider is never registered.
     * @default false
     */
    adminTestCheckout?: boolean;
    /**
     * A module that replaces the order confirmation, shipment and gift card claim emails: a package
     * specifier or an absolute path that the site's build can resolve, for example
     * `fileURLToPath(new URL('./src/lib/commerce-emails.ts', import.meta.url))`. It exports any of
     * `orderConfirmation`, `shipment` and `giftCardClaim` (see `CommerceEmailTemplates` in
     * `@talisman-cms/plugin-ecommerce/emails`); the others keep the default.
     */
    emailTemplates?: string;
}
declare function createEcommerceLayoutBlocks(productsCollectionSlug?: string): BlockDefinition[];
declare const ecommercePlugin: (config?: EcommercePluginConfig) => Plugin;

export { COUNTRY_CODES, type EcommercePluginConfig, type ShippingOption, type ShippingRate, type StoreSettings, StoreSettingsError, type TaxSettings, createEcommerceLayoutBlocks, ecommercePlugin, isCountryCode, readStoreCurrency, readStoreSettings, shippingOptionsFor };
