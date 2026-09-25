import { BlockDefinition, Plugin } from 'talisman-cms';
export { bindCommerceApi, reconcileCommerce } from './api.cjs';
export { P as PaymentProviderAdapter, V as ValidatedWebhookEvent } from './payments-9Bikdd3h.cjs';
export { StripePaymentAdapter } from './adapters/stripe.cjs';
export { AdminTestPaymentAdapter } from './adapters/admin-test.cjs';
import 'talisman-cms/client';
import 'stripe';

/**
 * InventoryDO
 *
 * A Cloudflare Durable Object responsible for serializing stock reservation
 * requests to prevent overselling during high-concurrency scenarios (e.g., flash sales).
 *
 * Each Durable Object instance manages the inventory for a single product.
 */
declare class InventoryDO {
    ctx: any;
    env: any;
    /**
     * Maximum allowed reserved stock for the item. In a production scenario,
     * this would be initialized from D1, but we cache it in the DO's storage for fast synchronous checks.
     */
    private totalStock;
    /**
     * The currently reserved stock quantity.
     */
    private reservedStock;
    private isInitialized;
    constructor(ctx: any, env: any);
    /**
     * Ensures the DO has loaded the stock numbers from storage into memory.
     */
    private ensureInitialized;
    fetch(request: Request): Promise<Response>;
}

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
}
declare function createEcommerceLayoutBlocks(productsCollectionSlug?: string): BlockDefinition[];
declare const ecommercePlugin: (config?: EcommercePluginConfig) => Plugin;

export { type EcommercePluginConfig, InventoryDO, createEcommerceLayoutBlocks, ecommercePlugin };
