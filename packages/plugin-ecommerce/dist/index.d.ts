import { BlockDefinition, Plugin } from 'talisman-cms';
export { CART_MAX_LINES, CART_MAX_LINE_QUANTITY, bindCommerceApi, reconcileCommerce } from './api.js';
export { P as PaymentProviderAdapter, V as ValidatedWebhookEvent } from './payments-B8lp8sbe.js';
export { StripePaymentAdapter } from './adapters/stripe.js';
export { AdminTestPaymentAdapter } from './adapters/admin-test.js';
import 'talisman-cms/client';
import 'stripe';

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
    /** Optional same-origin link overrides for stores with specialized admin workflows. */
    adminPages?: Partial<Record<'orders' | 'promotions' | 'giftCards' | 'testCheckout', string>>;
    /**
     * Adds the admin-only Test checkout screen and `/admin/api/ecommerce/test-checkout`, which place
     * orders through the simulated `admin_test` payment provider. When false, neither is injected and
     * the simulated provider is never registered.
     * @default false
     */
    adminTestCheckout?: boolean;
}
declare function createEcommerceLayoutBlocks(productsCollectionSlug?: string): BlockDefinition[];
declare const ecommercePlugin: (config?: EcommercePluginConfig) => Plugin;

export { type EcommercePluginConfig, createEcommerceLayoutBlocks, ecommercePlugin };
