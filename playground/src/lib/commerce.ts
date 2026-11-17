import { and, eq } from 'drizzle-orm';
import { readStoreCurrency } from '@talisman-cms/plugin-ecommerce';
import { bindCommerceApi } from '@talisman-cms/plugin-ecommerce/api';
import { StripePaymentAdapter } from '@talisman-cms/plugin-ecommerce/adapters/stripe';
import {
  orders,
} from '@talisman-cms/plugin-ecommerce/schema';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { CUSTOMER_SESSION_COOKIE, findCustomerSession } from '@talisman-cms/plugin-ecommerce/accounts';
import { ensureCartSession, readCartSessionToken, readOrderAccess, type CookieJar } from '@talisman-cms/plugin-ecommerce/cookies';
import { getPrimaryProductImage } from './product-media';
import { catalogOffer, readCatalog, type CatalogProduct } from '@talisman-cms/plugin-ecommerce/catalog';

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
  isPhysical: boolean;
  availableQuantity: number | null;
  unavailable: boolean;
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
// Only the currency: a mistake in another store setting closes checkout, not the shop pages.
export function getStoreCurrency(env: RuntimeEnv) {
  return readStoreCurrency(env);
}

/** Keep unavailable/deleted lines visible so shoppers can remove them; never silently drop a purchase. */
function resolveLineItem(product: CatalogProduct | undefined, item: { productId: string; variantId?: string | null; quantity: number }, unitPriceOverride?: number): ResolvedLineItem {
  const offer = product ? catalogOffer(product) : null;
  const choice = offer?.choices.find(choice => (choice.id ?? '') === (item.variantId ?? ''));
  const unavailable = !product || product.status !== 'active' || !choice || choice.price <= 0;
  const availableQuantity = choice?.quantity ?? (product?.type === 'standard' ? 0 : null);
  const unitPrice = unitPriceOverride ?? choice?.price ?? product?.basePrice ?? 0;
  const variantLabel = item.variantId ? choice?.label ?? 'Unavailable option' : undefined;
  return {
    key: `${item.productId}:${item.variantId ?? 'default'}`, productId: item.productId, variantId: item.variantId || undefined,
    quantity: item.quantity, productName: product?.name ?? 'Unavailable product', variantLabel,
    imageUrl: choice?.image || getPrimaryProductImage(product), unitPrice, lineTotal: unitPrice * item.quantity,
    type: product?.type ?? 'standard', isPhysical: product?.isPhysical ?? true, availableQuantity, unavailable,
    stockLabel: unavailable ? 'Currently unavailable' : availableQuantity === null ? 'Available' : availableQuantity === 0 ? 'Out of stock' : `${availableQuantity} available`,
    href: `/shop/${encodeURIComponent(item.productId)}${item.variantId ? `?variant=${encodeURIComponent(item.variantId)}` : ''}`,
  };
}

export async function getHydratedCart(env: RuntimeEnv, sessionToken?: string | null, cookies?: CookieJar) {
  const currency = getStoreCurrency(env);
  const api = createCommerceApi(env);
  const customer = cookies ? await findCustomerSession(env, cookies.get(CUSTOMER_SESSION_COOKIE)?.value) : null;
  // Rendering is read-only: the mutation routes claim/create the basket when the shopper acts.
  const guest = sessionToken ? await api.carts.find(sessionToken) : null;
  const owned = customer ? await api.carts.find(undefined, customer.id) : null;
  const cart = guest?.items.length ? guest : owned ?? guest;
  const catalog = cart?.items.length ? await readCatalog(env, { ids: [...new Set(cart.items.map(item => item.productId))] }) : [];
  const byId = new Map(catalog.map(product => [product.id, product]));
  let quote: Awaited<ReturnType<typeof api.carts.quote>> | null = null;
  let pricingError: string | null = null;
  const locked = Boolean(cart?.checkoutSessionId || cart?.closed);
  if (cart?.items.length && !locked) {
    try { quote = await api.carts.quote(cart.id); }
    catch { pricingError = 'Some items have changed or are unavailable. Review their quantities or remove them before checkout.'; }
  }
  const items = (cart?.items ?? []).map(item => resolveLineItem(byId.get(item.productId), item,
    quote?.lines.find(line => line.productId === item.productId && (line.variantId || '') === (item.variantId || ''))?.unitAmount));
  return { cart, items, subtotal: quote?.totalAmount ?? items.reduce((total, item) => total + item.lineTotal, 0),
    itemCount: items.reduce((total, item) => total + item.quantity, 0),
    requiresShipping: quote?.requiresShipping ?? items.some(item => item.isPhysical), locked, currency, pricingError };
}

export async function getOrderSummary(env: RuntimeEnv, orderId: string | null | undefined, cookies: CookieJar) {
  if (!orderId) return null;

  const customer = await findCustomerSession(env, cookies.get(CUSTOMER_SESSION_COOKIE)?.value);
  const order = await bindCommerceApi({ env }).orders.findForSession(orderId, readCartSessionToken(cookies), customer?.id, readOrderAccess(cookies, orderId));
  if (!order) return null;

  const catalog = order.items.length ? await readCatalog(env, { ids: [...new Set(order.items.map(item => item.productId))] }) : [];
  const byId = new Map(catalog.map(product => [product.id, product]));
  const items = order.items.map(item => resolveLineItem(byId.get(item.productId), item, item.priceAtPurchase));

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
