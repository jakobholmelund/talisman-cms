import {
  AdminTestPaymentAdapter
} from "./chunk-FK3KKBW6.js";
import {
  StripePaymentAdapter
} from "./chunk-6LYWG22B.js";
import {
  bindCommerceApi,
  reconcileCommerce
} from "./chunk-LVJ6XT5P.js";
import "./chunk-MPVZ6EEH.js";
import "./chunk-LHGIEHI6.js";
import "./chunk-JB5GG7SZ.js";
import "./chunk-53CI56PJ.js";
import "./chunk-XLYDGTBP.js";

// src/index.ts
import { fileURLToPath } from "url";
import { existsSync } from "fs";

// src/inventory.ts
var InventoryDO = class {
  ctx;
  env;
  /**
   * Maximum allowed reserved stock for the item. In a production scenario, 
   * this would be initialized from D1, but we cache it in the DO's storage for fast synchronous checks.
   */
  totalStock = 0;
  /**
   * The currently reserved stock quantity.
   */
  reservedStock = 0;
  isInitialized = false;
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  /**
   * Ensures the DO has loaded the stock numbers from storage into memory.
   */
  async ensureInitialized() {
    if (this.isInitialized) return;
    this.totalStock = await this.ctx.storage.get("totalStock") || 0;
    this.reservedStock = await this.ctx.storage.get("reservedStock") || 0;
    this.isInitialized = true;
  }
  async fetch(request) {
    await this.ensureInitialized();
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/reserve") {
      const data = await request.json();
      const { quantity } = data;
      if (typeof quantity !== "number" || quantity <= 0) {
        return Response.json({ error: "Invalid quantity" }, { status: 400 });
      }
      const availableStock = this.totalStock - this.reservedStock;
      if (availableStock >= quantity) {
        this.reservedStock += quantity;
        this.ctx.storage.put("reservedStock", this.reservedStock);
        return Response.json({
          success: true,
          reservedStock: this.reservedStock,
          remainingStock: this.totalStock - this.reservedStock
        });
      }
      return Response.json({
        success: false,
        error: "Insufficient stock",
        remainingStock: availableStock
      }, { status: 409 });
    }
    if (request.method === "POST" && url.pathname === "/set-stock") {
      const data = await request.json();
      this.totalStock = data.totalStock;
      this.ctx.storage.put("totalStock", this.totalStock);
      return Response.json({ success: true, totalStock: this.totalStock });
    }
    if (request.method === "GET" && url.pathname === "/stock") {
      const availableStock = this.totalStock - this.reservedStock;
      return Response.json({
        totalStock: this.totalStock,
        reservedStock: this.reservedStock,
        availableStock
      });
    }
    return new Response("Not found", { status: 404 });
  }
};

// src/index.ts
function resolveCartEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-cart");
}
function resolveCheckoutEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-checkout");
}
function resolveAdminTestCheckoutEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-admin-test-checkout");
}
function resolveAdminReconcileEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-admin-reconcile");
}
function resolveAdminFulfillmentEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-admin-fulfillment");
}
function resolveOrderEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-order");
}
function resolveAccountEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-account");
}
function resolveDiscountEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-discount");
}
function resolveGiftCardsEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-gift-cards");
}
function resolveAdminGiftCardsEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-admin-gift-cards");
}
function resolveAdminPromotionsEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-admin-promotions");
}
function resolveWebhookEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-webhook");
}
function resolveRouteEntrypoint(name) {
  let routePath = fileURLToPath(new URL(`./routes/${name}.js`, import.meta.url));
  if (!existsSync(routePath)) {
    routePath = fileURLToPath(new URL(`../src/routes/${name}.ts`, import.meta.url));
  }
  return routePath;
}
function createEcommerceLayoutBlocks(productsCollectionSlug = "products") {
  return [
    {
      name: "Featured Products",
      slug: "ecommerceFeaturedProducts",
      description: "Curated product cards pulled from your commerce catalog.",
      category: "Commerce",
      fields: [
        { name: "eyebrow", label: "Eyebrow", type: "text" },
        { name: "title", label: "Section Title", type: "text", required: true },
        { name: "description", label: "Description", type: "textarea" },
        { name: "productIds", label: "Products", type: "relation", relationTo: productsCollectionSlug, hasMany: true, required: true },
        { name: "columns", label: "Columns", type: "select", options: ["2", "3", "4"], defaultValue: "3", required: true },
        { name: "ctaLabel", label: "CTA Label", type: "text", defaultValue: "Browse catalog" },
        { name: "ctaHref", label: "CTA URL", type: "text", defaultValue: "/shop" }
      ]
    },
    {
      name: "Product Spotlight",
      slug: "ecommerceProductSpotlight",
      description: "Feature a single product with supporting copy and a primary CTA.",
      category: "Commerce",
      fields: [
        { name: "eyebrow", label: "Eyebrow", type: "text", defaultValue: "Featured product" },
        { name: "title", label: "Title Override", type: "text" },
        { name: "description", label: "Description Override", type: "textarea" },
        { name: "productId", label: "Product", type: "relation", relationTo: productsCollectionSlug, required: true },
        { name: "ctaLabel", label: "CTA Label", type: "text", defaultValue: "View product" },
        { name: "ctaHref", label: "CTA URL Override", type: "text" },
        { name: "mediaPosition", label: "Media Position", type: "select", options: ["left", "right"], defaultValue: "right", required: true }
      ]
    }
  ];
}
var ecommercePlugin = (config) => {
  const productsSlug = config?.productsCollectionSlug || "products";
  const inject = config?.injectCollections !== false;
  const cartEndpointPath = resolveCartEndpointPath();
  const checkoutEndpointPath = resolveCheckoutEndpointPath();
  const adminTestCheckoutEndpointPath = resolveAdminTestCheckoutEndpointPath();
  const adminReconcileEndpointPath = resolveAdminReconcileEndpointPath();
  const adminFulfillmentEndpointPath = resolveAdminFulfillmentEndpointPath();
  const orderEndpointPath = resolveOrderEndpointPath();
  const accountEndpointPath = resolveAccountEndpointPath();
  const discountEndpointPath = resolveDiscountEndpointPath();
  const giftCardsEndpointPath = resolveGiftCardsEndpointPath();
  const adminGiftCardsEndpointPath = resolveAdminGiftCardsEndpointPath();
  const adminPromotionsEndpointPath = resolveAdminPromotionsEndpointPath();
  const webhookEndpointPath = resolveWebhookEndpointPath();
  const blocks = createEcommerceLayoutBlocks(productsSlug);
  const adminPageDefinitions = [
    { key: "orders", path: "commerce-orders", component: "Orders", label: "Orders & fulfillment", description: "Review paid orders and record shipments." },
    { key: "promotions", path: "commerce-promotions", component: "Promotions", label: "Promotions & referrals", description: "Create discounts and manage referral rewards." },
    { key: "giftCards", path: "commerce-gift-cards", component: "GiftCards", label: "Gift cards", description: "Issue cards, check balances, and manage refunds." },
    { key: "testCheckout", path: "commerce-test-checkout", component: "TestCheckout", label: "Test checkout", description: "Exercise checkout without charging a card." }
  ];
  return {
    name: "@talisman-cms/plugin-ecommerce",
    adminLinks: adminPageDefinitions.flatMap((page) => {
      const href = config?.adminPages?.[page.key] || `/admin/extensions/${page.path}`;
      return href?.startsWith("/") && !href.startsWith("//") ? [{ section: "commerce", label: page.label, description: page.description, href }] : [];
    }),
    adminUi: adminPageDefinitions.map((page) => ({
      path: page.path,
      label: page.label,
      section: "commerce",
      componentPath: `@talisman-cms/plugin-ecommerce/admin/${page.component}`
    })),
    blocks,
    onInit: (talismanConfig) => {
      const collections = talismanConfig.collections || [];
      const existingProductsCollection = collections.find((c) => c.slug === productsSlug);
      const hasProductsCollection = Boolean(existingProductsCollection);
      if (existingProductsCollection && !existingProductsCollection.adminSection) {
        existingProductsCollection.adminSection = "commerce";
      }
      if (!hasProductsCollection) {
        const productFields = [];
        productFields.push(
          { name: "id", label: "ID", type: "text", required: true },
          { name: "name", label: "Name", type: "text", required: true },
          { name: "slug", label: "Slug", type: "text", required: true },
          { name: "sku", label: "SKU", type: "text" },
          { name: "description", label: "Description", type: "textarea" },
          {
            name: "images",
            label: "Product Images",
            type: "array",
            fields: [
              { name: "url", label: "Image URL", type: "media", required: true }
            ]
          }
        );
        if (inject) {
          productFields.push(
            { name: "categoryIds", label: "Categories", type: "relation", relationTo: "_ecommerce_categories", hasMany: true },
            { name: "tagIds", label: "Tags", type: "relation", relationTo: "_ecommerce_tags", hasMany: true }
          );
        }
        productFields.push(
          { name: "basePrice", label: "Base Price (Cents)", type: "number", required: true, defaultValue: 0 },
          { name: "isPhysical", label: "Is Physical Product", type: "boolean", defaultValue: true },
          { name: "inventoryQuantity", label: "Inventory Quantity", type: "number", defaultValue: 0 },
          { name: "type", label: "Product Type", type: "select", options: ["standard", "digital", "subscription"], defaultValue: "standard", required: true },
          { name: "status", label: "Status", type: "select", options: ["draft", "active", "archived"], defaultValue: "draft", required: true }
        );
        collections.push({
          name: "Products",
          slug: productsSlug,
          description: "Catalog of items available for purchase",
          adminSection: "commerce",
          fields: productFields,
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "products",
            idColumn: "id"
          }
        });
      }
      if (inject) {
        collections.push({
          name: "Variants",
          slug: "_ecommerce_variants",
          description: "Reusable variant definitions such as Size or Color",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "name", label: "Name", type: "text", required: true }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "variants",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Product Variant Groups",
          slug: "_ecommerce_product_variants",
          description: "Assigns a reusable variant definition to a product",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "productId", label: "Product", type: "relation", relationTo: productsSlug, required: true },
            { name: "variantId", label: "Variant Definition", type: "relation", relationTo: "_ecommerce_variants" },
            { name: "name", label: "Display Name", type: "text", required: true }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "productVariants",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Product Variant Values",
          slug: "_ecommerce_product_variant_values",
          description: "Purchasable values for each product variant group",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "productVariantId", label: "Product Variant Group", type: "relation", relationTo: "_ecommerce_product_variants", required: true },
            { name: "value", label: "Value", type: "text", required: true },
            { name: "sku", label: "SKU", type: "text" },
            { name: "image", label: "Variant Image URL", type: "media" },
            { name: "priceOverride", label: "Price Override (Cents)", type: "number" }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "productVariantValues",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Stock Levels",
          slug: "_ecommerce_stocks",
          description: "Inventory rows for product variant values",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "productVariantValueId", label: "Product Variant Value", type: "relation", relationTo: "_ecommerce_product_variant_values", required: true },
            { name: "quantity", label: "Quantity", type: "number", required: true, defaultValue: 0 }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "stocks",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Shared Components",
          slug: "_ecommerce_components",
          description: "Physical stock shared by sellable choices, such as frame bodies or lens pairs.",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "sku", label: "Component SKU", type: "text", required: true },
            { name: "name", label: "Name", type: "text", required: true },
            { name: "quantity", label: "Available Quantity", type: "number", required: true, defaultValue: 0 }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "components",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Variant Components",
          slug: "_ecommerce_variant_components",
          description: "Parts and quantities consumed by each sellable variant value. A choice with parts uses component stock instead of its own stock row.",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "productVariantValueId", label: "Purchasable Variant Value", type: "relation", relationTo: "_ecommerce_product_variant_values", required: true },
            { name: "componentId", label: "Shared Component", type: "relation", relationTo: "_ecommerce_components", required: true },
            { name: "quantity", label: "Units per Item", type: "number", required: true, defaultValue: 1 }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "variantComponents",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Categories",
          slug: "_ecommerce_categories",
          description: "Product categories",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "name", label: "Name", type: "text", required: true },
            { name: "slug", label: "Slug", type: "text", required: true },
            { name: "description", label: "Description", type: "textarea" },
            { name: "image", label: "Category Image URL", type: "media" },
            { name: "parentId", label: "Parent Category", type: "relation", relationTo: "_ecommerce_categories" }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "categories",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Carts",
          slug: "_ecommerce_carts",
          description: "Active customer shopping sessions",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "sessionToken", label: "Session Token", type: "text" },
            { name: "userId", label: "User ID", type: "text" },
            { name: "checkoutSessionId", label: "Checkout Session ID", type: "text" },
            {
              name: "items",
              label: "Cart Items",
              type: "array",
              fields: [
                { name: "productId", label: "Product ID", type: "text", required: true },
                { name: "variantId", label: "Variant ID", type: "text" },
                { name: "quantity", label: "Quantity", type: "number", required: true, defaultValue: 1 }
              ]
            },
            { name: "closed", label: "Closed", type: "boolean", defaultValue: false },
            { name: "closedAt", label: "Closed At", type: "date" }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "carts",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Customers",
          slug: "_ecommerce_customers",
          description: "E-commerce customers/buyers",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "name", label: "Name", type: "text" },
            { name: "email", label: "Email", type: "text" },
            { name: "stripeCustomerId", label: "Stripe Customer ID", type: "text" },
            { name: "userId", label: "User ID", type: "text" }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "customers",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Shopper Accounts",
          slug: "_ecommerce_customer_accounts",
          description: "Accounts created after confirmed shopper payments",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "email", label: "Email", type: "text" },
            { name: "name", label: "Name", type: "text" },
            { name: "creditBalance", label: "Store Credit Balance (Cents)", type: "number" }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "customerAccounts",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Referral Codes",
          slug: "_ecommerce_referral_codes",
          description: "Server-issued shopper referral links",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "code", label: "Code", type: "text", required: true },
            { name: "accountId", label: "Shopper Account ID", type: "text" },
            { name: "active", label: "Active", type: "boolean" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "referralCodes", idColumn: "code" }
        });
        collections.push({
          name: "Qualified Referrals",
          slug: "_ecommerce_referrals",
          description: "First paid purchases attributed to a referral code",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "code", label: "Code", type: "text" },
            { name: "referrerAccountId", label: "Referrer Account ID", type: "text" },
            { name: "referredAccountId", label: "Referred Account ID", type: "text" },
            { name: "orderId", label: "Order ID", type: "text" },
            { name: "rewardCents", label: "Reward (Cents)", type: "number" },
            { name: "status", label: "Status", type: "text" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "referrals", idColumn: "id" }
        });
        collections.push({
          name: "Store Credit Ledger",
          slug: "_ecommerce_credit_ledger",
          description: "Auditable awards, checkout reserves, releases, and refund reversals",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "accountId", label: "Shopper Account ID", type: "text" },
            { name: "orderId", label: "Order ID", type: "text" },
            { name: "kind", label: "Kind", type: "text" },
            { name: "amountCents", label: "Amount (Cents)", type: "number" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "creditLedger", idColumn: "id" }
        });
        collections.push({
          name: "Referral Settings",
          slug: "_ecommerce_referral_settings",
          description: "Referral terms. Edit through the Commerce Promotions admin page.",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "enabled", label: "Enabled", type: "boolean" },
            { name: "rewardCents", label: "Reward (Cents)", type: "number" },
            { name: "minOrderCents", label: "Minimum Order (Cents)", type: "number" },
            { name: "attributionDays", label: "Attribution Window (Days)", type: "number" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "referralSettings", idColumn: "id" }
        });
        collections.push({
          name: "Discount Codes",
          slug: "_ecommerce_discount_codes",
          description: "Offers and credit vouchers. Edit through the Commerce Promotions admin page.",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "code", label: "Code", type: "text", required: true },
            { name: "description", label: "Description", type: "text" },
            { name: "type", label: "Type", type: "text" },
            { name: "value", label: "Value", type: "number" },
            { name: "remainingCents", label: "Remaining Credit (Cents)", type: "number" },
            { name: "active", label: "Active", type: "boolean" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "discountCodes", idColumn: "code" }
        });
        collections.push({
          name: "Discount Redemptions",
          slug: "_ecommerce_discount_redemptions",
          description: "Reserved and confirmed code uses for payment reconciliation.",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "code", label: "Code", type: "text" },
            { name: "orderId", label: "Order ID", type: "text" },
            { name: "amountCents", label: "Discount (Cents)", type: "number" },
            { name: "status", label: "Status", type: "text" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "discountRedemptions", idColumn: "id" }
        });
        collections.push({
          name: "Gift Cards",
          slug: "_ecommerce_gift_cards",
          description: "Purchased and administrator-issued stored value. Manage through the Gift Cards admin page.",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "codeSuffix", label: "Code Suffix", type: "text" },
            { name: "source", label: "Source", type: "text" },
            { name: "initialCents", label: "Issued (Cents)", type: "number" },
            { name: "balanceCents", label: "Balance (Cents)", type: "number" },
            { name: "status", label: "Status", type: "text" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCards", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Purchases",
          slug: "_ecommerce_gift_card_purchases",
          description: "Payment and refund status for purchased cards.",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "buyerEmail", label: "Buyer Email", type: "text" },
            { name: "amountCents", label: "Amount (Cents)", type: "number" },
            { name: "status", label: "Status", type: "text" },
            { name: "providerRefundedCents", label: "Refunded (Cents)", type: "number" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardPurchases", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Ledger",
          slug: "_ecommerce_gift_card_ledger",
          description: "Auditable issuance, reservations, releases, and reversals.",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "cardId", label: "Gift Card ID", type: "text" },
            { name: "orderId", label: "Order ID", type: "text" },
            { name: "kind", label: "Kind", type: "text" },
            { name: "amountCents", label: "Amount (Cents)", type: "number" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardLedger", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Redemptions",
          slug: "_ecommerce_gift_card_redemptions",
          description: "Reserved and confirmed gift card uses.",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "cardId", label: "Gift Card ID", type: "text" },
            { name: "orderId", label: "Order ID", type: "text" },
            { name: "amountCents", label: "Amount (Cents)", type: "number" },
            { name: "status", label: "Status", type: "text" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardRedemptions", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Refunds",
          slug: "_ecommerce_gift_card_refunds",
          description: "Administrator-approved gift card tender refunds with reasons.",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "cardId", label: "Gift Card ID", type: "text" },
            { name: "orderId", label: "Order ID", type: "text" },
            { name: "amountCents", label: "Amount (Cents)", type: "number" },
            { name: "adminActor", label: "Administrator", type: "text" },
            { name: "reason", label: "Reason", type: "text" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardRefunds", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Order Refunds",
          slug: "_ecommerce_gift_card_order_refunds",
          description: "Audited full refunds for orders settled without Stripe.",
          adminSection: "commerce",
          readOnly: true,
          fields: [
            { name: "orderId", label: "Order ID", type: "text", required: true },
            { name: "adminActor", label: "Administrator", type: "text" },
            { name: "reason", label: "Reason", type: "text" }
          ],
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardOrderRefunds", idColumn: "orderId" }
        });
        collections.push({
          name: "Product Tags",
          slug: "_ecommerce_tags",
          description: "Custom tags for grouping products",
          adminSection: "commerce",
          fields: [
            { name: "id", label: "ID", type: "text", required: true },
            { name: "name", label: "Tag Name", type: "text", required: true },
            { name: "color", label: "Color", type: "text", defaultValue: "blue" }
          ],
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "tags",
            idColumn: "id"
          }
        });
        const addressFields = [
          { name: "name", label: "Name", type: "text" },
          { name: "line1", label: "Address Line 1", type: "text" },
          { name: "line2", label: "Address Line 2", type: "text" },
          { name: "city", label: "City", type: "text" },
          { name: "state", label: "State/Province", type: "text" },
          { name: "postalCode", label: "Postal Code", type: "text" },
          { name: "country", label: "Country", type: "text" }
        ];
        const orderFields = [
          { name: "id", label: "Order ID", type: "text", required: true },
          { name: "cartId", label: "Cart", type: "relation", relationTo: "_ecommerce_carts" },
          { name: "checkoutSessionId", label: "Checkout Session ID", type: "text" },
          { name: "paymentProvider", label: "Payment Provider", type: "text" },
          { name: "status", label: "Status", type: "select", options: ["draft", "pending", "paid", "fulfilled", "cancelled", "partially_refunded", "refunded"], required: true, defaultValue: "draft" },
          { name: "subtotalAmount", label: "Item Subtotal (Cents)", type: "number" },
          { name: "creditApplied", label: "Store Credit Used (Cents)", type: "number" },
          { name: "discountCode", label: "Discount Code", type: "text" },
          { name: "discountAmount", label: "Code Discount (Cents)", type: "number" },
          { name: "giftCardId", label: "Gift Card ID", type: "text" },
          { name: "giftCardApplied", label: "Gift Card Used (Cents)", type: "number" },
          { name: "giftCardRefundedCents", label: "Gift Card Refunded (Cents)", type: "number" },
          { name: "totalAmount", label: "Provider Charge (Cents)", type: "number", required: true },
          { name: "providerRefundedCents", label: "Provider Refunded (Cents)", type: "number" },
          { name: "paymentIntentId", label: "Payment Intent ID", type: "text" },
          { name: "referralCode", label: "Referral Code", type: "text" },
          { name: "referralRewardCents", label: "Referral Reward (Cents)", type: "number" },
          { name: "customerEmail", label: "Customer Email", type: "text" },
          {
            name: "items",
            label: "Order Items",
            type: "array",
            fields: [
              { name: "productId", label: "Product ID", type: "text", required: true },
              { name: "variantId", label: "Variant ID", type: "text" },
              { name: "quantity", label: "Quantity", type: "number", required: true },
              { name: "priceAtPurchase", label: "Price At Purchase (Cents)", type: "number", required: true }
            ]
          },
          { name: "shippingAddress", label: "Shipping Address", type: "group", fields: addressFields },
          { name: "billingAddress", label: "Billing Address", type: "group", fields: addressFields }
        ];
        collections.push({
          name: "Orders",
          slug: "_ecommerce_orders",
          description: "E-commerce transactions",
          adminSection: "commerce",
          readOnly: true,
          fields: orderFields,
          // In a real implementation we would use `nativeSchemaMapping` to point to the plugin's schema.ts
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "orders",
            idColumn: "id"
          }
        });
      }
      for (const collection of collections) {
        if (collection.nativeSchemaMapping?.schemaPath !== "@talisman-cms/plugin-ecommerce/schema") continue;
        collection.access = { read: "admin", create: "admin", update: "admin", delete: "admin" };
        if (collection.slug === "_ecommerce_carts" || collection.slug === "_ecommerce_customers") {
          collection.readOnly = true;
        }
      }
      return {
        ...talismanConfig,
        collections
      };
    },
    endpoints: [
      {
        path: "/ecommerce/account",
        entrypoint: accountEndpointPath,
        public: true
      },
      {
        path: "/ecommerce/discount",
        entrypoint: discountEndpointPath,
        public: true
      },
      {
        path: "/ecommerce/gift-cards",
        entrypoint: giftCardsEndpointPath,
        public: true
      },
      {
        path: "/ecommerce/gift-cards-admin",
        entrypoint: adminGiftCardsEndpointPath
      },
      {
        path: "/ecommerce/promotions",
        entrypoint: adminPromotionsEndpointPath
      },
      {
        path: "/ecommerce/cart",
        entrypoint: cartEndpointPath,
        public: true
      },
      {
        path: "/ecommerce/checkout",
        entrypoint: checkoutEndpointPath,
        public: true
      },
      {
        path: "/ecommerce/test-checkout",
        entrypoint: adminTestCheckoutEndpointPath
      },
      {
        path: "/ecommerce/reconcile",
        entrypoint: adminReconcileEndpointPath
      },
      {
        path: "/ecommerce/fulfillment",
        entrypoint: adminFulfillmentEndpointPath
      },
      {
        path: "/ecommerce/order",
        entrypoint: orderEndpointPath,
        public: true
      },
      {
        path: "/ecommerce/webhooks/stripe",
        entrypoint: webhookEndpointPath,
        public: true
      }
    ]
  };
};
export {
  AdminTestPaymentAdapter,
  InventoryDO,
  StripePaymentAdapter,
  bindCommerceApi,
  createEcommerceLayoutBlocks,
  ecommercePlugin,
  reconcileCommerce
};
