import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { CommerceContext } from './commerce-context';
import { batchGroups, chunked } from './db';
import * as schema from './schema';
import { readStoreSettings } from './store-settings';

// The basket: its limits, the catalog snapshot its lines are checked against, and the cart records
// a shopper's browser or account holds. Checkout (checkout.ts) prices a basket from the same snapshot.

export type RequiredComponent = { id: string; name: string; quantity: number; available: number };
export type InventoryTarget = { type: 'product' | 'variant' | 'stock'; id: string; quantity: number };
export type CartItemInput = { productId: string; variantId?: string; quantity: number };

export type CatalogProduct = {
  id: string; name: string; status: string; type: string;
  basePrice: number; inventoryQuantity: number; isPhysical: boolean;
};
type CatalogGroup = {
  id: string; productId: string; name: string; definitionName: string | null;
  priceOverride: number | null; inventoryQuantity: number;
};
type CatalogValue = {
  id: string; groupId: string; value: string; priceOverride: number | null;
  stock: { id: string; quantity: number } | null;
};
type CatalogRequirement = { componentId: string; quantity: number; component: { id: string; name: string; quantity: number } | null };

/** The catalog rows a basket's lines refer to, keyed by id (see loadBasketCatalog). */
export type BasketCatalog = {
  products: Map<string, CatalogProduct>;
  /** Every variant group of the basket's products. */
  groups: Map<string, CatalogGroup>;
  productsWithGroups: Set<string>;
  /** The groups, among the lines' variant ids, that have values. */
  groupsWithValues: Set<string>;
  values: Map<string, CatalogValue>;
  /** Each value's bill of materials, in component id order. */
  requirements: Map<string, CatalogRequirement[]>;
};

/** Most distinct lines one basket can hold. */
export const CART_MAX_LINES = 50;
/** Most units of one line. Checkout still checks stock. */
export const CART_MAX_LINE_QUANTITY = 99;
const CART_ID_MAX_LENGTH = 128;

const cartItemKey = (item: { productId: string; variantId?: string | null }) => `${item.productId}\0${item.variantId || ''}`;

/** Reject a malformed or oversized item list before the catalog is read. */
export function assertCartItems(items: unknown): asserts items is CartItemInput[] {
  if (!Array.isArray(items)) throw new Error('Cart items must be an array');
  if (items.length > CART_MAX_LINES) throw new Error(`Cart items must not exceed ${CART_MAX_LINES} lines`);
  if (items.some((item) =>
    !item || typeof item.productId !== 'string' || !item.productId.trim() || item.productId.length > CART_ID_MAX_LENGTH ||
    !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > CART_MAX_LINE_QUANTITY ||
    (item.variantId !== undefined && (typeof item.variantId !== 'string' || item.variantId.length > CART_ID_MAX_LENGTH))
  )) {
    throw new Error(`Cart items must have a product and a whole-number quantity from 1 to ${CART_MAX_LINE_QUANTITY}`);
  }
  const itemKeys = items.map(cartItemKey);
  if (new Set(itemKeys).size !== itemKeys.length) {
    throw new Error('Duplicate cart items are not allowed');
  }
}

export function aggregateComponentDemand(items: Array<{ quantity: number; components: RequiredComponent[] }>) {
  const demand = new Map<string, { name: string; quantity: number; available: number }>();
  for (const item of items) {
    for (const component of item.components) {
      const current = demand.get(component.id);
      demand.set(component.id, {
        name: component.name,
        quantity: (current?.quantity ?? 0) + item.quantity * component.quantity,
        available: component.available
      });
    }
  }
  return demand;
}

/**
 * Load every catalog row a basket's lines refer to in one D1 batch: a fixed number of statements
 * whatever the number of lines, so quoting and checkout do not slow down or run into D1's query
 * limits as the basket grows. The lines are then checked in memory against this snapshot.
 */
export async function loadBasketCatalog(ctx: CommerceContext, items: Array<{ productId: string; variantId?: string | null }>): Promise<BasketCatalog> {
  const { db } = ctx;
  const productIds = [...new Set(items.map((item) => String(item.productId)))];
  const variantIds = [...new Set(items.flatMap((item) => item.variantId ? [String(item.variantId)] : []))];
  const rows = await batchGroups(db, {
    // Each product with its variant groups, and each group with the name of its definition.
    products: chunked(productIds).map((ids) => db.query.products.findMany({
      columns: { id: true, name: true, status: true, type: true, basePrice: true, inventoryQuantity: true, isPhysical: true },
      where: { id: { in: ids } },
      with: { variants: { columns: { id: true, productId: true, name: true, priceOverride: true, inventoryQuantity: true },
        with: { variant: { columns: { name: true } } } } },
    })),
    // Each value with its stock row and its bill of materials, in component id order.
    values: chunked(variantIds).map((ids) => db.query.productVariantValues.findMany({
      columns: { id: true, productVariantId: true, value: true, priceOverride: true },
      where: { id: { in: ids } },
      with: { stock: { columns: { id: true, quantity: true } },
        requirements: { columns: { componentId: true, quantity: true }, orderBy: { componentId: 'asc' },
          with: { component: { columns: { id: true, name: true, quantity: true } } } } },
    })),
    // A line's variant id may name a legacy group instead of a value; such a group must have no values.
    groupsWithValues: chunked(variantIds).map((ids) => db.query.productVariants.findMany({
      columns: { id: true }, where: { id: { in: ids }, values: true },
    })),
  });
  const catalog: BasketCatalog = { products: new Map(), groups: new Map(), productsWithGroups: new Set(),
    groupsWithValues: new Set(), values: new Map(), requirements: new Map() };
  for (const product of rows.products) {
    catalog.products.set(product.id, { id: product.id, name: product.name, status: product.status, type: product.type,
      basePrice: product.basePrice, inventoryQuantity: product.inventoryQuantity, isPhysical: product.isPhysical });
    for (const group of product.variants) {
      catalog.groups.set(group.id, { id: group.id, productId: group.productId, name: group.name,
        definitionName: group.variant?.name ?? null, priceOverride: group.priceOverride, inventoryQuantity: group.inventoryQuantity });
      catalog.productsWithGroups.add(group.productId);
    }
  }
  for (const value of rows.values) {
    catalog.values.set(value.id, { id: value.id, groupId: value.productVariantId, value: value.value,
      priceOverride: value.priceOverride, stock: value.stock && { id: value.stock.id, quantity: value.stock.quantity } });
    catalog.requirements.set(value.id, value.requirements.map((requirement) => ({
      componentId: requirement.componentId, quantity: requirement.quantity, component: requirement.component })));
  }
  for (const group of rows.groupsWithValues) catalog.groupsWithValues.add(group.id);
  return catalog;
}

export function resolveSelectedVariant(catalog: BasketCatalog, product: CatalogProduct, variantId: string) {
  const variantValue = catalog.values.get(String(variantId));
  if (variantValue) {
    const productVariant = catalog.groups.get(variantValue.groupId);
    if (!productVariant || productVariant.productId !== product.id) {
      throw new Error(`Variant value not found or mismatch: ${variantId}`);
    }

    const stock = variantValue.stock;
    const components: RequiredComponent[] = [];
    for (const requirement of catalog.requirements.get(variantValue.id) ?? []) {
      const component = requirement.component;
      if (!component) throw new Error(`Component not found: ${requirement.componentId}`);
      components.push({
        id: component.id,
        name: component.name,
        quantity: requirement.quantity,
        available: component.quantity
      });
    }

    return {
      price: variantValue.priceOverride ?? productVariant.priceOverride ?? product.basePrice,
      name: `${product.name} - ${productVariant.definitionName ?? productVariant.name}: ${variantValue.value}`,
      availableQuantity: components.length
        ? Math.min(...components.map((component) => Math.floor(component.available / component.quantity)))
        : stock?.quantity ?? productVariant.inventoryQuantity,
      inventoryTarget: components.length ? null : stock
        ? { type: 'stock' as const, id: stock.id }
        : { type: 'variant' as const, id: productVariant.id },
      components,
    };
  }

  // Groups are loaded by product, so a group of another product is not found either.
  const legacyVariant = catalog.groups.get(String(variantId));
  if (!legacyVariant || legacyVariant.productId !== product.id) {
    throw new Error(`Variant not found or mismatch: ${variantId}`);
  }
  // Only a group without values is a legacy variant. A group with values is the choice itself, so
  // its own price and stock never sell a unit that skips the values' components.
  if (catalog.groupsWithValues.has(legacyVariant.id)) throw new Error(`Select an option for ${product.name}`);

  return {
    price: legacyVariant.priceOverride ?? product.basePrice,
    name: `${product.name} - ${legacyVariant.name}`,
    availableQuantity: legacyVariant.inventoryQuantity,
    inventoryTarget: { type: 'variant' as const, id: legacyVariant.id },
    components: [] as RequiredComponent[],
  };
}

/** A product with variant groups is sold only as one of its variants, never at its base price and stock. */
export function requireVariantChoice(catalog: BasketCatalog, product: { id: string; name: string }, variantId?: string | null) {
  if (variantId) return;
  if (catalog.productsWithGroups.has(product.id)) throw new Error(`Select an option for ${product.name}`);
}

/**
 * Check the lines a request adds against the catalog; lines already in the basket were checked when
 * they were added. Draft products are accepted so a concept basket works; archived ones are not.
 * A product with variant groups needs a variant, and a group with values is not one. Stores only the
 * known fields.
 */
export async function checkCartItems(ctx: CommerceContext, items: unknown, current: Array<{ productId: string; variantId?: string | null }> = []) {
  const { db } = ctx;
  assertCartItems(items);
  const currentKeys = new Set(current.map(cartItemKey));
  const added = items.filter((item) => !currentKeys.has(cartItemKey(item)));
  const productIds = [...new Set(added.map((item) => item.productId))];
  const available = new Set(productIds.length ? (await db.select({ id: schema.products.id, status: schema.products.status })
    .from(schema.products).where(inArray(schema.products.id, productIds)))
    .filter((product) => product.status !== 'archived').map((product) => product.id) : []);
  const unknownProduct = added.find((item) => !available.has(item.productId));
  if (unknownProduct) throw new Error(`Cart items must be catalog products; ${unknownProduct.productId} is not available`);

  const variantIds = [...new Set(added.flatMap((item) => item.variantId ? [item.variantId] : []))];
  if (variantIds.length) {
    // Like checkout: a purchasable value of one of the product's variant groups, or a legacy variant
    // group, which has no values. Naming a group that has values leaves the choice unmade.
    const groups = await db.select({ id: schema.productVariants.id, productId: schema.productVariants.productId })
      .from(schema.productVariants).where(inArray(schema.productVariants.id, variantIds));
    const groupsWithValues = new Set(groups.length ? (await db.selectDistinct({ id: schema.productVariantValues.productVariantId })
      .from(schema.productVariantValues)
      .where(inArray(schema.productVariantValues.productVariantId, groups.map((group) => group.id))))
      .map((value) => value.id) : []);
    const owners = new Map(groups.filter((group) => !groupsWithValues.has(group.id))
      .map((group) => [group.id, group.productId]));
    const choices = new Map(groups.filter((group) => groupsWithValues.has(group.id))
      .map((group) => [group.id, group.productId]));
    for (const value of await db.select({ id: schema.productVariantValues.id, productId: schema.productVariants.productId })
      .from(schema.productVariantValues)
      .innerJoin(schema.productVariants, eq(schema.productVariants.id, schema.productVariantValues.productVariantId))
      .where(inArray(schema.productVariantValues.id, variantIds))) {
      owners.set(value.id, value.productId);
    }
    const unchosenGroup = added.find((item) => item.variantId && choices.get(item.variantId) === item.productId);
    if (unchosenGroup) throw new Error(`Cart items must choose one of the variants of ${unchosenGroup.productId}`);
    const unknownVariant = added.find((item) => item.variantId && owners.get(item.variantId) !== item.productId);
    if (unknownVariant) throw new Error(`Cart items must use a variant of their product; ${unknownVariant.variantId} is not available`);
  }
  const withoutVariant = [...new Set(added.flatMap((item) => item.variantId ? [] : [item.productId]))];
  if (withoutVariant.length) {
    const withGroups = new Set((await db.selectDistinct({ productId: schema.productVariants.productId })
      .from(schema.productVariants).where(inArray(schema.productVariants.productId, withoutVariant)))
      .map((variant) => variant.productId));
    const unchosen = added.find((item) => !item.variantId && withGroups.has(item.productId));
    if (unchosen) throw new Error(`Cart items must choose one of the variants of ${unchosen.productId}`);
  }
  return items.map(({ productId, variantId, quantity }) => variantId ? { productId, variantId, quantity } : { productId, quantity });
}

export async function quoteCart(ctx: CommerceContext, cartId: string) {
  const { env, db } = ctx;
  const { currency } = readStoreSettings(env);
  const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
  if (!cart) throw new Error('Cart not found');
  const catalog = await loadBasketCatalog(ctx, cart.items);
  const lines = [];
  let totalAmount = 0;
  let requiresShipping = false;
  const componentItems: Array<{ quantity: number; components: RequiredComponent[] }> = [];
  for (const item of cart.items) {
    const product = catalog.products.get(String(item.productId));
    if (!product || product.status !== 'active') throw new Error(`Product is not available: ${item.productId}`);
    requireVariantChoice(catalog, product, item.variantId);
    const variant = item.variantId ? resolveSelectedVariant(catalog, product, item.variantId) : null;
    const unitAmount = variant?.price ?? product.basePrice;
    const name = variant?.name ?? product.name;
    if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) {
      throw new Error(`A positive price is required for ${name}`);
    }
    if (product.type === 'standard' && (variant?.availableQuantity ?? product.inventoryQuantity) < item.quantity) {
      throw new Error(`Insufficient stock for ${name}`);
    }
    if (product.type === 'standard' && variant?.components.length) {
      componentItems.push({ quantity: item.quantity, components: variant.components });
    }
    const lineTotal = unitAmount * item.quantity;
    totalAmount += lineTotal;
    requiresShipping ||= product.isPhysical;
    lines.push({ productId: item.productId, variantId: item.variantId, name, quantity: item.quantity, unitAmount, lineTotal });
  }
  for (const demand of aggregateComponentDemand(componentItems).values()) {
    if (demand.available < demand.quantity) throw new Error(`Insufficient stock for component ${demand.name}`);
  }
  if (!Number.isSafeInteger(totalAmount)) throw new Error('Order total is too large');
  return { lines, totalAmount, currency, requiresShipping, locked: Boolean(cart.checkoutSessionId) };
}

export async function findCart(ctx: CommerceContext, sessionToken: string | undefined, userId?: string) {
  const { db } = ctx;
  if (!sessionToken && !userId) return null;

  const conditions = [eq(schema.carts.closed, false)];

  if (userId) {
    conditions.push(eq(schema.carts.userId, userId));
  } else if (sessionToken) {
    conditions.push(eq(schema.carts.sessionToken, sessionToken));
    conditions.push(isNull(schema.carts.userId));
  }

  return await db.select().from(schema.carts).where(and(...conditions)).get();
}

/** Attach the current browser basket to an authenticated shopper account. */
export async function claimCart(ctx: CommerceContext, sessionToken: string, userId: string, choice?: 'browser' | 'account') {
  const { db } = ctx;
  const account = await db.select({ id: schema.customerAccounts.id }).from(schema.customerAccounts)
    .where(eq(schema.customerAccounts.id, userId)).get();
  if (!account) throw new Error('Customer account not found');

  const guest = await db.select().from(schema.carts)
    .where(and(eq(schema.carts.sessionToken, sessionToken), eq(schema.carts.closed, false))).get();
  const owned = await db.select().from(schema.carts)
    .where(and(eq(schema.carts.userId, userId), eq(schema.carts.closed, false))).get();
  if (guest?.userId === userId) return guest;
  if (guest?.userId) throw new Error('Basket belongs to another account');
  if (guest?.checkoutSessionId) throw new Error('Checkout already started for this cart');

  if (guest && owned && guest.id !== owned.id) {
    if (guest.items.length && owned.items.length) {
      if (!choice) throw new Error('Both baskets have items; choose which basket to keep before linking this session');
    }
    if (owned.checkoutSessionId) throw new Error('Checkout already started for this cart');
    if (guest.items.length && choice !== 'account') {
      const released = await db.update(schema.carts).set({ userId: null, updatedAt: new Date() })
        .where(and(eq(schema.carts.id, owned.id), eq(schema.carts.userId, userId),
          eq(schema.carts.version, owned.version), eq(schema.carts.closed, false)))
        .returning({ id: schema.carts.id });
      if (!released.length) throw new Error('Basket changed during account upgrade; reload and try again');
    } else {
      const released = await db.update(schema.carts).set({ sessionToken: null, updatedAt: new Date() })
        .where(and(eq(schema.carts.id, guest.id), eq(schema.carts.sessionToken, sessionToken),
          eq(schema.carts.version, guest.version), eq(schema.carts.closed, false)))
        .returning({ id: schema.carts.id });
      if (!released.length) throw new Error('Basket changed during account upgrade; reload and try again');
    }
  }

  const target = choice === 'account' && owned ? owned : guest?.items.length ? guest : owned ?? guest;
  if (target) {
    if (!guest) {
      await db.update(schema.carts).set({ sessionToken: null })
        .where(and(eq(schema.carts.sessionToken, sessionToken), eq(schema.carts.closed, true)));
    }
    const updated = await db.update(schema.carts)
      .set({ userId, sessionToken, updatedAt: new Date(), version: sql`${schema.carts.version} + 1` })
      .where(and(eq(schema.carts.id, target.id), eq(schema.carts.closed, false),
        isNull(schema.carts.checkoutSessionId), eq(schema.carts.version, target.version)))
      .returning({ id: schema.carts.id });
    if (!updated.length) throw new Error('Basket changed during account upgrade; reload and try again');
    return await db.select().from(schema.carts).where(eq(schema.carts.id, target.id)).get();
  }
  return null;
}

export async function getOrCreateCart(ctx: CommerceContext, sessionToken: string, userId?: string) {
  const { db } = ctx;
  if (userId) {
    const claimed = await claimCart(ctx, sessionToken, userId);
    if (claimed) return claimed;
  }
  let cart = await findCart(ctx, sessionToken, userId);

  if (!cart) {
     if (!userId) {
       // A browser token outlives a shopper session after expiry or sign-out.
       // Keep the account basket, but stop treating that token as guest access.
       await db.update(schema.carts).set({ sessionToken: null })
         .where(and(eq(schema.carts.sessionToken, sessionToken), eq(schema.carts.closed, false),
           isNotNull(schema.carts.userId)));
     }
     await db.update(schema.carts).set({ sessionToken: null })
       .where(and(eq(schema.carts.sessionToken, sessionToken), eq(schema.carts.closed, true)));
     const cartId = `cart_${crypto.randomUUID()}`;
     const now = new Date();
     await db.insert(schema.carts).values({
       id: cartId,
       sessionToken,
       userId,
       checkoutSessionId: null,
       items: [],
       closed: false,
       closedAt: null,
       createdAt: now,
       updatedAt: now,
     });
     cart = await findCart(ctx, sessionToken, userId);
  }

  return cart;
}

export async function updateCartItems(ctx: CommerceContext, cartId: string, items: CartItemInput[]) {
  const { db } = ctx;
  assertCartItems(items);

  const cart = await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
  if (!cart) {
    throw new Error('Cart not found');
  }
  if (cart.closed) {
    throw new Error('Cart is closed');
  }
  if (cart.checkoutSessionId) {
    throw new Error('Checkout already started for this cart');
  }
  const checked = await checkCartItems(ctx, items, cart.items);

  const updated = await db.update(schema.carts)
    .set({ items: checked, updatedAt: new Date(), version: sql`${schema.carts.version} + 1` })
    .where(and(eq(schema.carts.id, cartId), eq(schema.carts.closed, false),
      isNull(schema.carts.checkoutSessionId), eq(schema.carts.version, cart.version)))
    .returning({ id: schema.carts.id });
  if (!updated.length) throw new Error('Basket changed or checkout already started; reload and try again');

  return await db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
}
