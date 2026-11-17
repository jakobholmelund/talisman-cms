import { BlockDefinition, Plugin } from 'talisman-cms';
export { CART_MAX_LINES, CART_MAX_LINE_QUANTITY, TaxCalculationError, bindCommerceApi, deliverPendingCommerceEmails, reconcileCommerce } from './api.js';
import { IdentityEmailChangeHook } from 'talisman-cms/auth/identity';
export { P as PaymentProviderAdapter, a as PaymentReferences, T as TaxAddressError, b as TaxCalculation, c as TaxCalculationParams, V as ValidatedWebhookEvent } from './payments-DiMqRHdo.js';
export { CommerceEmailTemplates } from './emails.js';
export { StripePaymentAdapter } from './adapters/stripe.js';
export { AdminTestPaymentAdapter } from './adapters/admin-test.js';
export { a as ShippingOption, S as ShippingRate, b as StoreSettings, c as StoreSettingsError, T as TaxSettings, r as readStoreCurrency, d as readStoreSettings, s as shippingOptionsFor } from './shipping-Djkz1OMZ.js';
export { SUPPORTED_CURRENCIES, currencyMinorUnits, formatMoney, fromMinorUnits, isSupportedCurrency, minimumChargeAmount, toMinorUnits } from './money.js';
import './return-request-types-eGNtr7cH.js';
import './schema.js';
import 'drizzle-orm';
import 'drizzle-orm/sqlite-core';
import './return-requests-9ofJvWbS.js';
import 'talisman-cms/client';
import './commerce-context-DMvZFbwj.js';
import 'drizzle-orm/d1';
import './email-deliveries-CyzibTug.js';
import 'talisman-cms/email';
import 'stripe';

/** Preserve the shopper account id and its orders/credit; revoke shopper sessions and old sign-in links. */
declare const identityEmailChange: IdentityEmailChangeHook;

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
    adminPages?: Partial<Record<'orders' | 'promotions' | 'giftCards' | 'testCheckout' | 'attention' | 'emails' | 'stock' | 'returns' | 'refunds' | 'replenishment' | 'purchasing' | 'report' | 'exports' | 'recoveries', string>>;
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

export { COUNTRY_CODES, type EcommercePluginConfig, createEcommerceLayoutBlocks, ecommercePlugin, identityEmailChange, isCountryCode };
