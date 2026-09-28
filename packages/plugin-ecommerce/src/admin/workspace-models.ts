// How the Commerce workspace (CommerceWorkspace.tsx) groups the section's collections: the products
// collection under the slug the site configured, the native tables by what they hold, and the
// site's own collections as store content. Kept apart from the page so the grouping can be tested.
import type { AdminSectionWorkspaceProps } from 'talisman-cms/ui/lib/admin-sections';
import { productsCollectionSlug } from 'virtual:talisman-cms/ecommerce-admin';

export type CommerceModel = AdminSectionWorkspaceProps['collections'][number];

const catalogSlugs = new Set([
  '_ecommerce_categories', '_ecommerce_tags', '_ecommerce_variants',
  '_ecommerce_product_variants', '_ecommerce_product_variant_values',
  '_ecommerce_stocks', '_ecommerce_components', '_ecommerce_variant_components'
]);
const shopperSlugs = new Set(['_ecommerce_customers', '_ecommerce_customer_accounts', '_ecommerce_carts']);
const promotionSlugs = new Set([
  '_ecommerce_referral_codes', '_ecommerce_referrals', '_ecommerce_referral_settings',
  '_ecommerce_discount_redemptions', '_ecommerce_credit_ledger'
]);
const giftSlugs = new Set([
  '_ecommerce_gift_card_purchases', '_ecommerce_gift_card_ledger',
  '_ecommerce_gift_card_redemptions', '_ecommerce_gift_card_refunds',
  '_ecommerce_gift_card_order_refunds', '_ecommerce_gift_card_reviews'
]);
/** The native tables shown as highlights, next to the products collection. */
const featuredSlugs = new Set(['_ecommerce_orders', '_ecommerce_discount_codes', '_ecommerce_gift_cards']);

const help: Record<string, string> = {
  _ecommerce_orders: 'Payments and fulfillment',
  _ecommerce_discount_codes: 'Offers and promotional credit',
  _ecommerce_gift_cards: 'Issued cards and balances',
  _ecommerce_categories: 'Organize what shoppers browse',
  _ecommerce_product_variant_values: 'Shopper choices, images, and prices',
  _ecommerce_stocks: 'Stock available for each option',
  _ecommerce_components: 'Shared physical parts and supplies'
};

/** The line under a model's name in the workspace. */
export function modelHelp(model: CommerceModel): string {
  if (model.slug === productsCollectionSlug) return 'Images, prices, options, and availability';
  return help[model.slug] || model.description || 'Manage records';
}

/**
 * The products collection among the section's models: the one mapped to the plugin's products
 * table, else the one with the configured slug (a site-defined collection with its own table).
 */
export function findProductsModel(models: CommerceModel[]): CommerceModel | undefined {
  return models.find(model => model.nativeSchemaMapping?.exportName === 'products')
    || models.find(model => model.slug === productsCollectionSlug);
}

/** The extension path an admin link points at, when it links to a plugin admin page. */
export function extensionPathOf(href: string) {
  return /^\/(?:[^/?#]+\/)*extensions\/([^/?#]+)$/.exec(href)?.[1];
}

/** The section's models in the groups the workspace shows. A model appears in one group only. */
export function groupCommerceModels(models: CommerceModel[]) {
  const bySlug = new Map(models.map(model => [model.slug, model]));
  const products = findProductsModel(models);
  const content = models.filter(model => !model.slug.startsWith('_ecommerce_') && model !== products);
  const catalog = models.filter(model => catalogSlugs.has(model.slug));
  const shoppers = models.filter(model => shopperSlugs.has(model.slug));
  const promotions = models.filter(model => promotionSlugs.has(model.slug));
  const giftRecords = models.filter(model => giftSlugs.has(model.slug));
  const advanced = models.filter(model => model !== products && !featuredSlugs.has(model.slug) && !catalogSlugs.has(model.slug)
    && !shopperSlugs.has(model.slug) && !promotionSlugs.has(model.slug) && !giftSlugs.has(model.slug) && !content.includes(model));
  return {
    products,
    orders: bySlug.get('_ecommerce_orders'),
    discountCodes: bySlug.get('_ecommerce_discount_codes'),
    giftCards: bySlug.get('_ecommerce_gift_cards'),
    content,
    catalog,
    shoppers,
    promotions,
    giftRecords,
    advanced,
  };
}
