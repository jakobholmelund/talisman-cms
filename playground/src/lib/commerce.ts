import { and, eq } from 'drizzle-orm';
import { readStoreSettings } from '@talisman-cms/plugin-ecommerce';
import { bindCommerceApi } from '@talisman-cms/plugin-ecommerce/api';
import { StripePaymentAdapter } from '@talisman-cms/plugin-ecommerce/adapters/stripe';
import {
  orders,
  products,
  productVariantValues,
  productVariants,
  stocks,
  variants as variantDefinitions,
} from '@talisman-cms/plugin-ecommerce/schema';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { ensureCartSession, readCartSessionToken, type CookieJar } from '@talisman-cms/plugin-ecommerce/cookies';
import { getPrimaryProductImage } from './product-media';

export { formatMoney } from '@talisman-cms/plugin-ecommerce/money';

type RuntimeEnv = TalismanEnv & Record<string, unknown>;

export interface ResolvedLineItem {
  key: string;
  productId: string;
  variantId?: string;
  quantity: number;
  productName: string;
  variantLabel?: string;
  imageUrl?: string | null;
  unitPrice: number;
  lineTotal: number;
  type: string;
  stockLabel: string;
  href: string;
}

function getPaymentAdapters(env: RuntimeEnv) {
  const stripeSecretKey = typeof env.STRIPE_SECRET_KEY === 'string' ? env.STRIPE_SECRET_KEY : '';
  const stripeWebhookSecret = typeof env.STRIPE_WEBHOOK_SECRET === 'string' ? env.STRIPE_WEBHOOK_SECRET : undefined;

  if (!stripeSecretKey) {
    return [];
  }

  return [
    new StripePaymentAdapter({
      secretKey: stripeSecretKey,
      webhookSecret: stripeWebhookSecret
    })
  ];
}

export function createCommerceApi(env: RuntimeEnv) {
  return bindCommerceApi({
    env,
    paymentAdapters: getPaymentAdapters(env)
  });
}

/**
 * The basket token gates cart and order access, so it comes from the plugin's helper: a random UUID
 * in an HttpOnly cookie (Secure on https) that page scripts cannot read.
 */
export function getCartSessionToken(cookies: CookieJar, options?: { create?: boolean; secure?: boolean }) {
  if (options?.create) return ensureCartSession(cookies, options.secure ?? true);
  return readCartSessionToken(cookies) ?? null;
}

/** The currency the store sells in (TALISMAN_COMMERCE_CURRENCY). Prices are integers in its minor units. */
export function getStoreCurrency(env: RuntimeEnv) {
  return readStoreSettings(env).currency;
}

async function resolveLineItem(
  db: ReturnType<typeof createDbClient>,
  item: { productId: string; variantId?: string; quantity: number },
  unitPriceOverride?: number
): Promise<ResolvedLineItem | null> {
  const product = await db.select().from(products).where(eq(products.id, item.productId)).get();
  if (!product) return null;

  let imageUrl = getPrimaryProductImage(product);

  let productName = product.name;
  let variantLabel: string | undefined;
  let unitPrice = unitPriceOverride ?? product.basePrice;
  let stockLabel = product.type === 'digital'
    ? 'Delivered instantly'
    : `${product.inventoryQuantity} available`;

  if (item.variantId) {
    const variantValue = await db.select().from(productVariantValues).where(eq(productVariantValues.id, item.variantId)).get();
    if (variantValue) {
      const group = await db.select().from(productVariants).where(eq(productVariants.id, variantValue.productVariantId)).get();
      const stock = await db.select().from(stocks).where(eq(stocks.productVariantValueId, variantValue.id)).get();
      const definition = group?.variantId
        ? await db.select().from(variantDefinitions).where(eq(variantDefinitions.id, group.variantId)).get()
        : null;

      variantLabel = definition?.name
        ? `${definition.name}: ${variantValue.value}`
        : `${group?.name ?? 'Variant'}: ${variantValue.value}`;
      unitPrice = unitPriceOverride ?? variantValue.priceOverride ?? group?.priceOverride ?? product.basePrice;
      imageUrl = variantValue.image || imageUrl;
      stockLabel = product.type === 'digital'
        ? 'Delivered instantly'
        : `${stock?.quantity ?? group?.inventoryQuantity ?? 0} available`;
    } else {
      const legacyVariant = await db.select().from(productVariants).where(eq(productVariants.id, item.variantId)).get();
      if (legacyVariant) {
        variantLabel = legacyVariant.name;
        unitPrice = unitPriceOverride ?? legacyVariant.priceOverride ?? product.basePrice;
        stockLabel = product.type === 'digital'
          ? 'Delivered instantly'
          : `${legacyVariant.inventoryQuantity} available`;
      }
    }
  }

  return {
    key: `${item.productId}:${item.variantId ?? 'default'}`,
    productId: item.productId,
    variantId: item.variantId,
    quantity: item.quantity,
    productName,
    variantLabel,
    imageUrl,
    unitPrice,
    lineTotal: unitPrice * item.quantity,
    type: product.type,
    stockLabel,
    href: `/shop/${product.id}`
  };
}

export async function getHydratedCart(env: RuntimeEnv, sessionToken?: string | null) {
  const currency = getStoreCurrency(env);
  if (!sessionToken) {
    return {
      cart: null,
      items: [] as ResolvedLineItem[],
      subtotal: 0,
      itemCount: 0,
      requiresShipping: false,
      locked: false,
      currency,
    };
  }

  const api = createCommerceApi(env);
  const cart = await api.carts.getOrCreate(sessionToken);
  
  if (!cart) {
    return {
      cart: null,
      items: [] as ResolvedLineItem[],
      subtotal: 0,
      itemCount: 0,
      requiresShipping: false,
      locked: false,
      currency,
    };
  }

  const db = createDbClient(env);
  const items = (await Promise.all(cart.items.map((item) => resolveLineItem(db, item)))).filter(Boolean) as ResolvedLineItem[];

  return {
    cart,
    items,
    subtotal: items.reduce((total, item) => total + item.lineTotal, 0),
    itemCount: items.reduce((total, item) => total + item.quantity, 0),
    requiresShipping: items.some((item) => item.type !== 'digital'),
    locked: Boolean(cart.checkoutSessionId || cart.closed),
    currency,
  };
}

export async function getOrderSummary(env: RuntimeEnv, orderId?: string | null) {
  if (!orderId) return null;

  const db = createDbClient(env);
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return null;

  const items = (await Promise.all(
    order.items.map((item) => resolveLineItem(db, item, item.priceAtPurchase))
  )).filter(Boolean) as ResolvedLineItem[];

  return {
    order,
    items,
    subtotal: items.reduce((total, item) => total + item.lineTotal, 0),
  };
}

export async function getPendingOrderForCart(env: RuntimeEnv, cartId?: string | null) {
  if (!cartId) return null;

  const db = createDbClient(env);
  return db.select().from(orders).where(and(eq(orders.cartId, cartId), eq(orders.status, 'pending'))).get();
}
