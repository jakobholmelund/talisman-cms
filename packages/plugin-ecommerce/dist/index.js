import {
  AdminTestPaymentAdapter
} from "./chunk-FK3KKBW6.js";
import {
  bindCommerceApi,
  reconcileCommerce
} from "./chunk-NKRAW7IR.js";
import {
  CART_MAX_LINES,
  CART_MAX_LINE_QUANTITY,
  TaxCalculationError
} from "./chunk-4OZ23J3X.js";
import "./chunk-BVMDOVSS.js";
import "./chunk-25X32EKO.js";
import "./chunk-AVWDMCNG.js";
import {
  StripePaymentAdapter,
  TaxAddressError
} from "./chunk-IN4CG7W7.js";
import {
  shippingOptionsFor
} from "./chunk-3RWEM2DK.js";
import "./chunk-YHTTKGNB.js";
import {
  deliverPendingCommerceEmails
} from "./chunk-QVDRNSCF.js";
import "./chunk-7CFKBAUU.js";
import "./chunk-LCILI57I.js";
import "./chunk-GNU6N22K.js";
import {
  StoreSettingsError,
  readStoreCurrency,
  readStoreSettings
} from "./chunk-WHUJCCDD.js";
import "./chunk-3MXMGN5I.js";
import {
  COUNTRY_CODES,
  isCountryCode
} from "./chunk-USNNZXV4.js";
import {
  commerceDb
} from "./chunk-SXQHVX4E.js";
import {
  carts,
  categories,
  components,
  creditLedger,
  customerAccounts,
  customerSessions,
  customers,
  discountCodeCreations,
  discountCodes,
  discountRedemptions,
  disputes,
  emailDeliveries,
  emailRecoveryDecisions,
  giftCardClaims,
  giftCardCodeReplacements,
  giftCardLedger,
  giftCardOrderRefunds,
  giftCardPurchases,
  giftCardRedemptions,
  giftCardRefunds,
  giftCardReviews,
  giftCards,
  inspectionStock,
  orders,
  parcelContents,
  productVariantValues,
  productVariants,
  products,
  providerRefunds,
  purchaseOrderEvents,
  purchaseOrderLines,
  purchaseOrders,
  reconcileDecisions,
  recoveryCases,
  recoveryEvents,
  recoveryInspections,
  recoveryPaymentEvents,
  recoveryPayments,
  recoveryReceipts,
  recoveryShipments,
  referralCodes,
  referralSettings,
  referrals,
  replenishmentDeliveries,
  replenishmentDeliveryEvents,
  replenishmentPolicies,
  restocks,
  returnExchangePreferences,
  returnInspections,
  returnReceipts,
  returnRefundDecisions,
  returnRequestEvents,
  returnRequestReasons,
  returnRequestReceipts,
  returnRequests,
  returnStock,
  signInTokens,
  stockMovements,
  stocks,
  stocktakes,
  supplierIssueEvents,
  supplierIssues,
  supplierRevisions,
  suppliers,
  tags,
  variantComponents,
  variants
} from "./chunk-PLAJXKV3.js";
import "./chunk-NQUBOBQT.js";
import "./chunk-XJTZUPZM.js";
import {
  SUPPORTED_CURRENCIES,
  currencyMinorUnits,
  formatMoney,
  fromMinorUnits,
  isSupportedCurrency,
  minimumChargeAmount,
  toMinorUnits
} from "./chunk-HNDRZISR.js";
import "./chunk-C66AEOTN.js";

// src/index.ts
import { nativeFields } from "talisman-cms/fields";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

// src/identity-email-change.ts
import { and, eq, inArray, sql } from "drizzle-orm";
var identityEmailChange = async (env, change) => {
  const { userId, oldEmail, newEmail, condition } = change;
  const db = commerceDb(env);
  const now = /* @__PURE__ */ new Date();
  return [
    db.delete(customerSessions).where(and(inArray(
      customerSessions.accountId,
      db.select({ id: customerAccounts.id }).from(customerAccounts).where(eq(customerAccounts.cmsUserId, userId))
    ), condition)).getSQL(),
    db.delete(signInTokens).where(and(inArray(signInTokens.emailNormalized, [oldEmail.toLowerCase(), newEmail]), condition)).getSQL(),
    db.update(customerAccounts).set({
      email: newEmail,
      emailNormalized: newEmail,
      emailVerifiedAt: now,
      updatedAt: now,
      sessionVersion: sql`${customerAccounts.sessionVersion} + 1`
    }).where(and(eq(customerAccounts.cmsUserId, userId), condition)).getSQL()
  ];
};

// src/index.ts
var ADMIN_OPTIONS_MODULE = "virtual:talisman-cms/ecommerce-admin";
var EMAIL_TEMPLATES_MODULE = "virtual:talisman-cms/ecommerce-emails";
function emailTemplatesModule(path) {
  if (path === void 0) return "export const emailTemplates = null;";
  if (typeof path !== "string" || !path.trim() || path.startsWith("./") || path.startsWith("../")) {
    throw new TypeError("[plugin-ecommerce] emailTemplates must be a package specifier or an absolute path.");
  }
  return `export * as emailTemplates from ${JSON.stringify(path)};`;
}
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
function resolveAdminOrdersEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-admin-orders");
}
function resolveAdminVariantsEndpointPath() {
  return resolveRouteEntrypoint("ecommerce-admin-variants");
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
function resolveMigrationsDir() {
  return fileURLToPath(new URL("../drizzle/", import.meta.url));
}
function resolveAdminSourceDir() {
  return fileURLToPath(new URL("../src/admin/", import.meta.url));
}
var ADMIN_SCHEMA_PATH = "@talisman-cms/plugin-ecommerce/schema";
var INVENTORY_FIELDS_BY_EXPORT = {
  products: ["inventoryQuantity"],
  productVariants: ["inventoryQuantity"],
  stocks: ["quantity"],
  components: ["quantity"]
};
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
  const adminTestCheckout = config?.adminTestCheckout === true;
  const emailTemplatesSource = emailTemplatesModule(config?.emailTemplates);
  const cartEndpointPath = resolveCartEndpointPath();
  const checkoutEndpointPath = resolveCheckoutEndpointPath();
  const adminReconcileEndpointPath = resolveAdminReconcileEndpointPath();
  const adminFulfillmentEndpointPath = resolveAdminFulfillmentEndpointPath();
  const adminOrdersEndpointPath = resolveAdminOrdersEndpointPath();
  const adminVariantsEndpointPath = resolveAdminVariantsEndpointPath();
  const orderEndpointPath = resolveOrderEndpointPath();
  const accountEndpointPath = resolveAccountEndpointPath();
  const discountEndpointPath = resolveDiscountEndpointPath();
  const giftCardsEndpointPath = resolveGiftCardsEndpointPath();
  const adminGiftCardsEndpointPath = resolveAdminGiftCardsEndpointPath();
  const adminPromotionsEndpointPath = resolveAdminPromotionsEndpointPath();
  const adminOperationsEndpointPath = resolveRouteEntrypoint("ecommerce-admin-operations");
  const webhookEndpointPath = resolveWebhookEndpointPath();
  const blocks = createEcommerceLayoutBlocks(productsSlug);
  const adminPageDefinitions = [
    { key: "attention", path: "commerce-attention", component: "Attention", label: "Needs attention", description: "Find payment reviews, email failures, held cards, and orders waiting to ship." },
    { key: "emails", path: "commerce-emails", component: "EmailRecovery", label: "Email recovery", description: "Review failed notices and request an audited retry." },
    { key: "stock", path: "commerce-stock", component: "StockOverview", label: "Stock overview", description: "Find unavailable choices and low shared component stock." },
    { key: "returns", path: "commerce-returns", component: "Returns", label: "Returns", description: "Review customer return requests and pending inspections." },
    { key: "recoveries", path: "commerce-recoveries", component: "Recoveries", label: "Parcels & exchanges", description: "Resolve lost or damaged parcels, send replacements and arrange equal-price exchanges." },
    { key: "refunds", path: "commerce-refunds", component: "RefundFollowUp", label: "Refund follow-up", description: "Resolve received returns against confirmed refund records." },
    { key: "replenishment", path: "commerce-replenishment", component: "Replenishment", label: "Replenishment", description: "Set stock targets and track expected supplier deliveries." },
    { key: "purchasing", path: "commerce-purchasing", component: "PurchaseOrders", label: "Purchase orders", description: "Manage suppliers, purchase stock and receive partial deliveries." },
    { key: "report", path: "commerce-report", component: "OperationsReport", label: "Operations reporting", description: "Track shipping turnaround, return reasons and outstanding deliveries." },
    { key: "exports", path: "commerce-exports", component: "OperationsExports", label: "Operations exports", description: "Download filtered order, return and stock records." },
    { key: "orders", path: "commerce-orders", component: "Orders", label: "Orders & fulfillment", description: "Review paid orders and record shipments." },
    { key: "promotions", path: "commerce-promotions", component: "Promotions", label: "Promotions & referrals", description: "Create discounts and manage referral rewards." },
    { key: "giftCards", path: "commerce-gift-cards", component: "GiftCards", label: "Gift cards", description: "Issue cards, check balances, and manage refunds." },
    { key: "testCheckout", path: "commerce-test-checkout", component: "TestCheckout", label: "Test checkout", description: "Exercise checkout without charging a card." }
  ].filter((page) => page.key !== "testCheckout" || adminTestCheckout);
  return {
    name: "@talisman-cms/plugin-ecommerce",
    migrations: { dir: resolveMigrationsDir() },
    scheduled: { moduleId: "@talisman-cms/plugin-ecommerce/scheduled" },
    identityEmailChange: { moduleId: "@talisman-cms/plugin-ecommerce" },
    // The hrefs are relative to the admin path; the integration resolves them and refuses a value
    // that is not a path on the site, so an `adminPages` override is passed through as given.
    adminLinks: adminPageDefinitions.map((page) => ({
      section: "commerce",
      label: page.label,
      description: page.description,
      href: config?.adminPages?.[page.key] || `extensions/${page.path}`
    })),
    adminUi: adminPageDefinitions.map((page) => ({
      path: page.path,
      label: page.label,
      section: "commerce",
      componentPath: `@talisman-cms/plugin-ecommerce/admin/${page.component}`
    })),
    // The Commerce section: its sidebar entry and routes, the workspace page, the product editor's
    // Options & stock panel, the model guide for the other catalog records, and the record labels.
    adminSections: [{
      id: "commerce",
      label: "Commerce",
      description: "Manage products, catalog structure, inventory, and orders.",
      icon: "shopping-cart",
      adminOnly: true,
      componentPath: "@talisman-cms/plugin-ecommerce/admin/CommerceWorkspace",
      emptyState: {
        title: "No commerce models registered",
        body: 'Enable the ecommerce plugin or tag a collection with `adminSection: "commerce"`.'
      }
    }],
    adminCollectionViews: [{ slug: productsSlug, nativeSchemaExport: "products", componentPath: "@talisman-cms/plugin-ecommerce/admin/ProductCatalogue" }],
    adminEditorPanels: [
      { id: "commerce-model-guide", placement: "before-fields", sections: ["commerce"], componentPath: "@talisman-cms/plugin-ecommerce/admin/CommerceModelGuidePanel" },
      { id: "commerce-product-options", placement: "after-form", slugs: [productsSlug], componentPath: "@talisman-cms/plugin-ecommerce/admin/ProductOptionsPanel" }
    ],
    adminEntryDescribers: [{ modulePath: "@talisman-cms/plugin-ecommerce/admin/commerce-models" }],
    // The store currency, read by the admin screens from the page's meta tag.
    adminSettings: ["COMMERCE_CURRENCY"],
    adminStyleSources: [resolveAdminSourceDir()],
    blocks,
    vite: {
      plugins: [{
        name: "talisman-cms-ecommerce-admin-options",
        resolveId(id) {
          if (id === ADMIN_OPTIONS_MODULE) return `\0${ADMIN_OPTIONS_MODULE}`;
        },
        load(id) {
          if (id === `\0${ADMIN_OPTIONS_MODULE}`) {
            return `export const adminTestCheckout = ${adminTestCheckout};
export const productsCollectionSlug = ${JSON.stringify(productsSlug)};`;
          }
        }
      }, {
        name: "talisman-cms-ecommerce-email-templates",
        resolveId(id) {
          if (id === EMAIL_TEMPLATES_MODULE) return `\0${EMAIL_TEMPLATES_MODULE}`;
        },
        load(id) {
          if (id === `\0${EMAIL_TEMPLATES_MODULE}`) return emailTemplatesSource;
        }
      }]
    },
    onInit: (talismanConfig) => {
      const collections = talismanConfig.collections || [];
      const existingProductsCollection = collections.find((c) => c.slug === productsSlug);
      const hasProductsCollection = Boolean(existingProductsCollection);
      if (existingProductsCollection && !existingProductsCollection.adminSection) {
        existingProductsCollection.adminSection = "commerce";
      }
      if (!hasProductsCollection) {
        const productFields = nativeFields(products, [
          "id",
          "name",
          "slug",
          { name: "sku", label: "SKU" },
          { name: "description", type: "textarea" },
          { name: "images", label: "Product Images", type: "array", fields: [{ name: "url", label: "Image URL", type: "media", required: true }] },
          ...inject ? [
            { name: "categoryIds", label: "Categories", type: "relation", relationTo: "_ecommerce_categories", hasMany: true },
            { name: "tagIds", label: "Tags", type: "relation", relationTo: "_ecommerce_tags", hasMany: true }
          ] : [],
          { name: "basePrice", label: "Base Price (smallest currency unit)" },
          { name: "isPhysical", label: "Is Physical Product" },
          "inventoryQuantity",
          { name: "type", label: "Product Type" },
          "status"
        ]);
        const productSections = { name: "About this product", description: "About this product", slug: "About this product", sku: "About this product", images: "Images", basePrice: "Pricing", isPhysical: "Selling & shipping", type: "Selling & shipping", status: "Selling & shipping", categoryIds: "Organisation", tagIds: "Organisation" };
        for (const field of productFields) Object.assign(field, { editorSection: productSections[field.name] || "Advanced", editorHidden: field.name === "inventoryQuantity" || field.name === "id" });
        productFields.sort((a, b) => ["About this product", "Images", "Pricing", "Selling & shipping", "Organisation", "Advanced"].indexOf(productSections[a.name] || "Advanced") - ["About this product", "Images", "Pricing", "Selling & shipping", "Organisation", "Advanced"].indexOf(productSections[b.name] || "Advanced"));
        const labels = { isPhysical: { label: "Requires shipping" }, sku: { label: "SKU (optional)" }, type: { label: "Selling format", optionLabels: { standard: "One-time purchase", digital: "Digital download", subscription: "Subscription" } }, status: { label: "Visibility", optionLabels: { draft: "Draft \u2014 hidden from shoppers", active: "Available in store", archived: "Archived \u2014 hidden from shoppers" } } };
        for (const field of productFields) if (labels[field.name]) Object.assign(field, labels[field.name]);
        const handle = productFields.find((field) => field.name === "slug");
        if (handle) Object.assign(handle, { label: "URL name", adminPresentation: "slug", generateFrom: "name" });
        const price = productFields.find((field) => field.name === "basePrice");
        if (price) Object.assign(price, { label: "Price", adminPresentation: "money" });
        const gallery = productFields.find((field) => field.name === "images");
        if (gallery) Object.assign(gallery, { adminPresentation: "gallery" });
        collections.push({
          name: "Products",
          singularName: "Product",
          editorCreateNext: "commerce-product-options",
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
          fields: nativeFields(variants, [
            "id",
            "name"
          ]),
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
          fields: nativeFields(productVariants, [
            "id",
            { name: "productId", label: "Product", type: "relation", relationTo: "products" },
            { name: "variantId", label: "Variant Definition", type: "relation", relationTo: "_ecommerce_variants" },
            { name: "name", label: "Display Name" },
            { name: "sku", label: "SKU" },
            { name: "priceOverride", label: "Price Override (smallest currency unit)" },
            "inventoryQuantity"
          ]),
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
          fields: nativeFields(productVariantValues, [
            "id",
            { name: "productVariantId", label: "Product Variant Group", type: "relation", relationTo: "_ecommerce_product_variants" },
            "value",
            { name: "sku", label: "SKU" },
            { name: "image", label: "Variant Image URL", type: "media" },
            { name: "priceOverride", label: "Price Override (smallest currency unit)" }
          ]),
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
          fields: nativeFields(stocks, [
            "id",
            { name: "productVariantValueId", label: "Product Variant Value", type: "relation", relationTo: "_ecommerce_product_variant_values" },
            "quantity"
          ]),
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
          fields: nativeFields(components, [
            "id",
            { name: "sku", label: "Component SKU" },
            "name",
            { name: "quantity", label: "Available Quantity" }
          ]),
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
          fields: nativeFields(variantComponents, [
            "id",
            { name: "productVariantValueId", label: "Purchasable Variant Value", type: "relation", relationTo: "_ecommerce_product_variant_values" },
            { name: "componentId", label: "Shared Component", type: "relation", relationTo: "_ecommerce_components" },
            { name: "quantity", label: "Units per Item" }
          ]),
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
          fields: nativeFields(categories, [
            "id",
            "name",
            "slug",
            { name: "description", type: "textarea" },
            { name: "image", label: "Category Image URL", type: "media" },
            { name: "parentId", label: "Parent Category", type: "relation", relationTo: "_ecommerce_categories" }
          ]),
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
          fields: nativeFields(carts, [
            "id",
            "sessionToken",
            "userId",
            "checkoutSessionId",
            { name: "items", label: "Cart Items", type: "array", fields: [
              { name: "productId", label: "Product ID", type: "text", required: true },
              { name: "variantId", label: "Variant ID", type: "text" },
              { name: "quantity", label: "Quantity", type: "number", required: true, defaultValue: 1 }
            ] },
            "closed",
            "closedAt"
          ]),
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
          fields: nativeFields(customers, [
            "id",
            "name",
            "email",
            "stripeCustomerId",
            "userId"
          ]),
          nativeSchemaMapping: {
            schemaPath: "@talisman-cms/plugin-ecommerce/schema",
            exportName: "customers",
            idColumn: "id"
          }
        });
        collections.push({
          name: "Shopper Accounts",
          slug: "_ecommerce_customer_accounts",
          description: "Shopper accounts from a used email sign-in link or a confirmed payment. A verified shopper shares the CMS user for that email, shown in Users with the customer role.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(customerAccounts, [
            "id",
            "email",
            "name",
            { name: "creditBalance", label: "Store Credit Balance (smallest currency unit)" }
          ]),
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
          fields: nativeFields(referralCodes, [
            "code",
            { name: "accountId", label: "Shopper Account ID" },
            "active"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "referralCodes", idColumn: "code" }
        });
        collections.push({
          name: "Qualified Referrals",
          slug: "_ecommerce_referrals",
          description: "First paid purchases attributed to a referral code. An approved referral is pending until its awards appear in the credit ledger; a void one earns nothing.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(referrals, [
            "id",
            "code",
            "referrerAccountId",
            "referredAccountId",
            "orderId",
            { name: "rewardCents", label: "Reward (smallest currency unit)" },
            "status"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "referrals", idColumn: "id" }
        });
        collections.push({
          name: "Store Credit Ledger",
          slug: "_ecommerce_credit_ledger",
          description: "Auditable awards, checkout reserves, releases, and refund reversals",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(creditLedger, [
            "id",
            { name: "accountId", label: "Shopper Account ID" },
            "orderId",
            "kind",
            { name: "amountCents", label: "Amount (smallest currency unit)" }
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "creditLedger", idColumn: "id" }
        });
        collections.push({
          name: "Referral Settings",
          slug: "_ecommerce_referral_settings",
          description: "Referral terms. Edit through the Commerce Promotions admin page.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(referralSettings, [
            "id",
            "enabled",
            { name: "rewardCents", label: "Reward (smallest currency unit)" },
            { name: "minOrderCents", label: "Minimum Order (smallest currency unit)" },
            { name: "attributionDays", label: "Attribution Window (Days)" }
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "referralSettings", idColumn: "id" }
        });
        collections.push({
          name: "Discount Codes",
          slug: "_ecommerce_discount_codes",
          description: "Offers and credit vouchers. Edit through the Commerce Promotions admin page.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(discountCodes, [
            "code",
            "description",
            "type",
            "value",
            { name: "remainingCents", label: "Remaining Credit (smallest currency unit)" },
            "active"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "discountCodes", idColumn: "code" }
        });
        collections.push({
          name: "Discount Code Creations",
          slug: "_ecommerce_discount_code_creations",
          description: "Original creation requests used to recover interrupted promotion saves.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(discountCodeCreations, ["id", "code", "actor", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "discountCodeCreations", idColumn: "id" }
        });
        collections.push({
          name: "Discount Redemptions",
          slug: "_ecommerce_discount_redemptions",
          description: "Reserved and confirmed code uses for payment reconciliation.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(discountRedemptions, [
            "id",
            "code",
            "orderId",
            { name: "amountCents", label: "Discount (smallest currency unit)" },
            "status"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "discountRedemptions", idColumn: "id" }
        });
        collections.push({
          name: "Gift Cards",
          slug: "_ecommerce_gift_cards",
          description: "Purchased and administrator-issued stored value. Manage through the Gift Cards admin page.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(giftCards, [
            "id",
            "codeSuffix",
            "source",
            { name: "initialCents", label: "Issued (smallest currency unit)" },
            { name: "balanceCents", label: "Balance (smallest currency unit)" },
            "status",
            { name: "replacesPurchaseId", label: "Replaces Purchase" }
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCards", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Code Replacements",
          slug: "_ecommerce_gift_card_code_replacements",
          description: "Staff-issued code replacements. Balances and order histories stay on the original card.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(giftCardCodeReplacements, [
            "id",
            "cardId",
            "previousReplacementId",
            "previousCodeSuffix",
            "newCodeSuffix",
            { name: "balanceCents", label: "Balance at Replacement (smallest currency unit)" },
            "actor",
            "reason",
            "createdAt"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardCodeReplacements", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Purchases",
          slug: "_ecommerce_gift_card_purchases",
          description: "Payment and refund status for purchased cards.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(giftCardPurchases, [
            "id",
            "buyerEmail",
            { name: "amountCents", label: "Amount (smallest currency unit)" },
            "status",
            { name: "providerRefundedCents", label: "Refunded (smallest currency unit)" },
            { name: "refundAdjustedCents", label: "Refund Taken Off Cards (smallest currency unit)" }
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardPurchases", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Ledger",
          slug: "_ecommerce_gift_card_ledger",
          description: "Auditable issuance, reservations, releases, and reversals.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(giftCardLedger, [
            "id",
            { name: "cardId", label: "Gift Card ID" },
            "orderId",
            "kind",
            { name: "amountCents", label: "Amount (smallest currency unit)" }
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardLedger", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Redemptions",
          slug: "_ecommerce_gift_card_redemptions",
          description: "Reserved and confirmed gift card uses.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(giftCardRedemptions, [
            "id",
            { name: "cardId", label: "Gift Card ID" },
            "orderId",
            { name: "amountCents", label: "Amount (smallest currency unit)" },
            "status"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardRedemptions", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Refunds",
          slug: "_ecommerce_gift_card_refunds",
          description: "Administrator-approved gift card tender refunds with reasons.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(giftCardRefunds, [
            "id",
            { name: "cardId", label: "Gift Card ID" },
            "orderId",
            { name: "amountCents", label: "Amount (smallest currency unit)" },
            { name: "adminActor", label: "Administrator" },
            "reason"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardRefunds", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Reviews",
          slug: "_ecommerce_gift_card_reviews",
          description: "Administrator decisions on refunded gift card purchases, with reasons.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(giftCardReviews, [
            "id",
            "purchaseId",
            { name: "cardId", label: "Gift Card ID" },
            "outcome",
            { name: "refundedCents", label: "Refunded (smallest currency unit)" },
            { name: "adjustmentCents", label: "Taken Off Cards (smallest currency unit)" },
            { name: "adminActor", label: "Administrator" },
            "reason"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardReviews", idColumn: "id" }
        });
        collections.push({
          name: "Provider Refunds",
          slug: "_ecommerce_provider_refunds",
          description: "Payment provider refunds with the date each was issued, as recorded from Stripe.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(providerRefunds, [
            "id",
            "orderId",
            "provider",
            "providerRefundId",
            { name: "amountCents", label: "Amount (smallest currency unit)" }
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "providerRefunds", idColumn: "id" }
        });
        collections.push({
          name: "Disputes",
          slug: "_ecommerce_disputes",
          description: "Payment disputes on orders and gift card purchases. Respond to them in Stripe.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(disputes, [
            { name: "id", label: "Dispute ID" },
            "orderId",
            "giftCardPurchaseId",
            { name: "amountCents", label: "Amount (smallest currency unit)" },
            "currency",
            "reason",
            "status",
            { name: "statusBefore", label: "Status Before the Dispute" }
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "disputes", idColumn: "id" }
        });
        collections.push({
          name: "Restocks",
          slug: "_ecommerce_restocks",
          description: "Stock of refunded orders returned by an administrator, with reasons.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(restocks, [
            "id",
            "orderId",
            { name: "targetType", label: "Stock Type" },
            { name: "targetId", label: "Stock ID" },
            "quantity",
            { name: "adminActor", label: "Administrator" },
            "reason"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "restocks", idColumn: "id" }
        });
        collections.push({
          name: "Gift Card Order Refunds",
          slug: "_ecommerce_gift_card_order_refunds",
          description: "Audited full refunds for orders settled without Stripe.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(giftCardOrderRefunds, [
            "orderId",
            { name: "adminActor", label: "Administrator" },
            "reason"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardOrderRefunds", idColumn: "orderId" }
        });
        collections.push({
          name: "Gift Card Claim Links",
          slug: "_ecommerce_gift_card_claims",
          description: "One-time links emailed to buyers to show their gift card code, with who resent a link and why.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(giftCardClaims, [
            "id",
            "purchaseId",
            { name: "cardId", label: "Gift Card ID" },
            { name: "expiresAt", label: "Expires" },
            { name: "usedAt", label: "Used" },
            { name: "revokedAt", label: "Revoked" },
            { name: "createdBy", label: "Resent By" },
            "reason"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "giftCardClaims", idColumn: "id" }
        });
        collections.push({
          name: "Suppliers",
          slug: "_ecommerce_suppliers",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(suppliers, ["id", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "suppliers", idColumn: "id" }
        });
        collections.push({
          name: "Supplier History",
          slug: "_ecommerce_supplier_revisions",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(supplierRevisions, ["id", "supplierId", "expectedVersion", "name", "contact", "address", "active", "actor", "reason", "fingerprint", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "supplierRevisions", idColumn: "id" }
        });
        collections.push({
          name: "Purchase Orders",
          slug: "_ecommerce_purchase_orders",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(purchaseOrders, ["id", "supplierId", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "purchaseOrders", idColumn: "id" }
        });
        collections.push({
          name: "Purchase History",
          slug: "_ecommerce_purchase_order_events",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(purchaseOrderEvents, ["id", "purchaseOrderId", "expectedVersion", "status", "reference", "expectedDate", { name: "lines", type: "array" }, { name: "supplier", type: "group" }, "actor", "reason", "fingerprint", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "purchaseOrderEvents", idColumn: "id" }
        });
        collections.push({
          name: "Purchase Lines",
          slug: "_ecommerce_purchase_order_lines",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(purchaseOrderLines, ["id", "purchaseOrderId", "lineIndex", "deliveryId"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "purchaseOrderLines", idColumn: "id" }
        });
        collections.push({ name: "Returned Replacement Receipts", slug: "_ecommerce_recovery_receipts", readOnly: true, adminSection: "commerce", fields: nativeFields(recoveryReceipts, ["id", "shipmentId", "quantity", "actor", "reason", "fingerprint", "createdAt", "redactedAt"]), nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "recoveryReceipts", idColumn: "id" } });
        collections.push({ name: "Replacement Inspections", slug: "_ecommerce_recovery_inspections", readOnly: true, adminSection: "commerce", fields: nativeFields(recoveryInspections, ["id", "receiptId", "quantity", "disposition", "restock", "stock", "actor", "reason", "fingerprint", "createdAt", "redactedAt"]), nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "recoveryInspections", idColumn: "id" } });
        collections.push({ name: "Exchange Upgrade Payments", slug: "_ecommerce_recovery_payments", readOnly: true, adminSection: "commerce", fields: nativeFields(recoveryPayments, ["id", "caseId", "expectedVersion", "provider", "paymentId", "amountMinor", "currency", "actor", "reason", "fingerprint", "createdAt", "redactedAt"]), nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "recoveryPayments", idColumn: "id" } });
        collections.push({ name: "Exchange Payment Events", slug: "_ecommerce_recovery_payment_events", readOnly: true, adminSection: "commerce", fields: nativeFields(recoveryPaymentEvents, ["id", "paymentId", "kind", "createdAt"]), nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "recoveryPaymentEvents", idColumn: "id" } });
        collections.push({
          name: "Parcel and Exchange Cases",
          slug: "_ecommerce_recovery_cases",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(recoveryCases, ["id", "orderId", "kind", "fulfillmentId", "sourceShipmentId", "receiptId", "lineIndex", "quantity", "target", "actor", "reason", "fingerprint", "createdAt", "redactedAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "recoveryCases", idColumn: "id" }
        });
        collections.push({
          name: "Replacement Shipments",
          slug: "_ecommerce_recovery_shipments",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(recoveryShipments, ["id", "caseId", "expectedVersion", "quantity", "stock", "carrier", "trackingNumber", "actor", "reason", "fingerprint", "createdAt", "redactedAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "recoveryShipments", idColumn: "id" }
        });
        collections.push({
          name: "Parcel and Exchange History",
          slug: "_ecommerce_recovery_events",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(recoveryEvents, ["id", "caseId", "expectedVersion", "kind", "status", "shipmentId", "carrier", "trackingNumber", "actor", "reason", "fingerprint", "createdAt", "redactedAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "recoveryEvents", idColumn: "id" }
        });
        collections.push({
          name: "Supplier Delivery Issues",
          slug: "_ecommerce_supplier_issues",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(supplierIssues, ["id", "purchaseLineId", "kind", "quantity", "expectedPurchaseVersion", "expectedDeliveryVersion", "actor", "reason", "fingerprint", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "supplierIssues", idColumn: "id" }
        });
        collections.push({
          name: "Supplier Issue History",
          slug: "_ecommerce_supplier_issue_events",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(supplierIssueEvents, ["id", "issueId", "expectedVersion", "status", "actor", "reason", "fingerprint", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "supplierIssueEvents", idColumn: "id" }
        });
        collections.push({
          name: "Return Categories",
          slug: "_ecommerce_return_request_reasons",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(returnRequestReasons, ["requestId", "code"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "returnRequestReasons", idColumn: "requestId" }
        });
        collections.push({
          name: "Return Refund Decisions",
          slug: "_ecommerce_return_refund_decisions",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(returnRefundDecisions, ["id", "receiptId", "expectedVersion", "status", "amountMinor", { name: "allocations", type: "array", label: "Confirmed refund allocations" }, "actor", "reason", "fingerprint", "createdAt", "redactedAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "returnRefundDecisions", idColumn: "id" }
        });
        collections.push({
          name: "Replenishment Policies",
          slug: "_ecommerce_replenishment_policies",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(replenishmentPolicies, ["id", "targetType", "targetId", "minimumQuantity", "targetQuantity", "enabled", "expectedVersion", "actor", "reason", "fingerprint", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "replenishmentPolicies", idColumn: "id" }
        });
        collections.push({
          name: "Expected Deliveries",
          slug: "_ecommerce_replenishment_deliveries",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(replenishmentDeliveries, ["id", "targetType", "targetId", "quantity", "supplier", "reference", "expectedDate", "actor", "reason", "fingerprint", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "replenishmentDeliveries", idColumn: "id" }
        });
        collections.push({
          name: "Delivery Receipts",
          slug: "_ecommerce_replenishment_delivery_events",
          readOnly: true,
          adminSection: "commerce",
          fields: nativeFields(replenishmentDeliveryEvents, ["id", "deliveryId", "kind", "movementId", "expectedVersion", "actor", "reason", "fingerprint", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "replenishmentDeliveryEvents", idColumn: "id" }
        });
        collections.push({
          name: "Order Emails",
          slug: "_ecommerce_email_deliveries",
          description: "Order confirmations, shipment notices and gift card claim emails, with their delivery status and last error code.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(emailDeliveries, [
            "id",
            "kind",
            { name: "subjectId", label: "Order, Shipment or Purchase ID" },
            "status",
            "attempts",
            "lastError",
            { name: "sentAt", label: "Sent" }
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "emailDeliveries", idColumn: "id" }
        });
        collections.push({
          name: "Email Recovery History",
          slug: "_ecommerce_email_recovery_decisions",
          description: "Staff requests to retry a failed order or shipment notice, with its earlier error and attempt count.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(emailRecoveryDecisions, ["id", "emailId", "actor", "reason", "priorAttempts", "priorError", "createdAt"]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "emailRecoveryDecisions", idColumn: "id" }
        });
        collections.push({
          name: "Product Tags",
          slug: "_ecommerce_tags",
          description: "Custom tags for grouping products",
          adminSection: "commerce",
          fields: nativeFields(tags, [
            "id",
            { name: "name", label: "Tag Name" },
            "color"
          ]),
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
        const orderFields = nativeFields(orders, [
          { name: "id", label: "Order ID" },
          { name: "cartId", label: "Cart", type: "relation", relationTo: "_ecommerce_carts" },
          "checkoutSessionId",
          "paymentProvider",
          { name: "status", label: "Payment Status", type: "select", options: ["draft", "pending", "paid", "fulfilled", "cancelled", "partially_refunded", "refunded", "disputed"] },
          "fulfillmentStatus",
          { name: "subtotalAmount", label: "Item Subtotal (smallest currency unit)" },
          { name: "shippingLabel", label: "Shipping Option" },
          "shippingRateId",
          { name: "shippingAmount", label: "Shipping (smallest currency unit)" },
          { name: "taxAmount", label: "Tax (smallest currency unit)" },
          { name: "taxBehavior", label: "Tax Behavior (inclusive or exclusive)" },
          "taxCalculationId",
          "taxTransactionId",
          { name: "creditApplied", label: "Store Credit Used (smallest currency unit)" },
          "discountCode",
          { name: "discountAmount", label: "Code Discount (smallest currency unit)" },
          "giftCardId",
          { name: "giftCardApplied", label: "Gift Card Used (smallest currency unit)" },
          { name: "giftCardRefundedCents", label: "Gift Card Refunded (smallest currency unit)" },
          { name: "totalAmount", label: "Provider Charge (smallest currency unit)" },
          { name: "providerRefundedCents", label: "Provider Refunded (smallest currency unit)" },
          "paymentIntentId",
          "referralCode",
          { name: "referralRewardCents", label: "Referral Reward (smallest currency unit)" },
          "customerEmail",
          { name: "items", label: "Order Items", type: "array", fields: [
            { name: "productId", label: "Product ID", type: "text", required: true },
            { name: "variantId", label: "Variant ID", type: "text" },
            { name: "quantity", label: "Quantity", type: "number", required: true },
            { name: "priceAtPurchase", label: "Price At Purchase (smallest currency unit)", type: "number", required: true }
          ] },
          { name: "shippingAddress", type: "group", fields: addressFields },
          { name: "billingAddress", type: "group", fields: addressFields }
        ]);
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
        collections.push({
          name: "Payment Check Decisions",
          slug: "_ecommerce_reconcile_decisions",
          description: "Administrator retries and releases of checkouts parked for review, with reasons.",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(reconcileDecisions, [
            "id",
            "orderId",
            { name: "purchaseId", label: "Gift Card Purchase ID" },
            "action",
            { name: "failure", label: "Parked For" },
            "paymentReturned",
            { name: "adminActor", label: "Administrator" },
            "reason"
          ]),
          nativeSchemaMapping: { schemaPath: "@talisman-cms/plugin-ecommerce/schema", exportName: "reconcileDecisions", idColumn: "id" }
        });
      }
      if (inject) {
        collections.push({
          name: "Parcel Contents",
          slug: "_ecommerce_parcel_contents",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(parcelContents, ["id", "orderId", "fulfillmentId", "source", "actor", "reason", "createdAt"]),
          nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "parcelContents", idColumn: "id" }
        });
        collections.push({
          name: "Return Receipts",
          slug: "_ecommerce_return_receipts",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(returnReceipts, ["id", "orderId", "actor", "reason", "createdAt"]),
          nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "returnReceipts", idColumn: "id" }
        });
        collections.push({ name: "Exchange Preferences", slug: "_ecommerce_return_exchange_preferences", adminSection: "commerce", readOnly: true, fields: nativeFields(returnExchangePreferences, ["requestId", "lineIndex", { name: "target", label: "Preferred replacement", type: "group" }]), nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "returnExchangePreferences", idColumn: "requestId" } });
        collections.push({ name: "Return Requests", slug: "_ecommerce_return_requests", adminSection: "commerce", readOnly: true, fields: nativeFields(returnRequests, ["id", "orderId", "reason", "createdAt"]), nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "returnRequests", idColumn: "id" } });
        collections.push({ name: "Return Request Decisions", slug: "_ecommerce_return_request_events", adminSection: "commerce", readOnly: true, fields: nativeFields(returnRequestEvents, ["id", "requestId", "status", "actorKind", "actor", "reason", "customerMessage", "createdAt"]), nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "returnRequestEvents", idColumn: "id" } });
        collections.push({ name: "Return Request Receipts", slug: "_ecommerce_return_request_receipts", adminSection: "commerce", readOnly: true, fields: nativeFields(returnRequestReceipts, ["receiptId", "requestId"]), nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "returnRequestReceipts", idColumn: "receiptId" } });
        collections.push({
          name: "Return Stock",
          slug: "_ecommerce_return_stock",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(returnStock, ["id", "orderId", "receiptId", "reservationType", "reservationId", "targetType", "targetId", "quantity"]),
          nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "returnStock", idColumn: "id" }
        });
        collections.push({
          name: "Return Inspections",
          slug: "_ecommerce_return_inspections",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(returnInspections, ["id", "receiptId", "orderId", "actor", "reason", "createdAt"]),
          nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "returnInspections", idColumn: "id" }
        });
        collections.push({
          name: "Inspection Stock",
          slug: "_ecommerce_inspection_stock",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(inspectionStock, ["id", "inspectionId", "orderId", "reservationType", "reservationId", "targetType", "targetId", "quantity"]),
          nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "inspectionStock", idColumn: "id" }
        });
        collections.push({
          name: "Stocktakes",
          slug: "_ecommerce_stocktakes",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(stocktakes, ["id", "actor", "reason", "createdAt"]),
          nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "stocktakes", idColumn: "id" }
        });
        collections.push({
          name: "Stock Movements",
          slug: "_ecommerce_stock_movements",
          adminSection: "commerce",
          readOnly: true,
          fields: nativeFields(stockMovements, ["id", "targetType", "targetId", "kind", "delta", "beforeQuantity", "afterQuantity", "actor", "reason", "createdAt"]),
          nativeSchemaMapping: { schemaPath: ADMIN_SCHEMA_PATH, exportName: "stockMovements", idColumn: "id" }
        });
      }
      for (const collection of collections) {
        if (collection.nativeSchemaMapping?.schemaPath !== ADMIN_SCHEMA_PATH) continue;
        collection.access = { read: "admin", create: "admin", update: "admin", delete: "admin" };
        if (collection.slug === "_ecommerce_carts" || collection.slug === "_ecommerce_customers") {
          collection.readOnly = true;
        }
        if (!collection.adminSection) collection.adminSection = "commerce";
        const inventoryFields = INVENTORY_FIELDS_BY_EXPORT[collection.nativeSchemaMapping.exportName] || [];
        for (const field of collection.fields || []) {
          if (inventoryFields.includes(field.name)) {
            field.saveOnlyIfChanged = true;
            field.readOnly = true;
            field.defaultValue = 0;
            if (!field.label.includes("use Stock overview")) field.label = `${field.label} \xB7 use Stock overview`;
          }
        }
      }
      return {
        ...talismanConfig,
        collections
      };
    },
    endpoints: [
      { path: "/ecommerce/returns", entrypoint: resolveRouteEntrypoint("ecommerce-returns"), public: true },
      { path: "/ecommerce/operations", entrypoint: adminOperationsEndpointPath },
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
      ...adminTestCheckout ? [{
        path: "/ecommerce/test-checkout",
        entrypoint: resolveAdminTestCheckoutEndpointPath()
      }] : [],
      {
        path: "/ecommerce/reconcile",
        entrypoint: adminReconcileEndpointPath
      },
      {
        path: "/ecommerce/fulfillment",
        entrypoint: adminFulfillmentEndpointPath
      },
      {
        // The orders screen's disputes and restocks.
        path: "/ecommerce/orders-admin",
        entrypoint: adminOrdersEndpointPath
      },
      {
        // The product editor's variant configurator saves values with their stock here.
        path: "/ecommerce/variants",
        entrypoint: adminVariantsEndpointPath
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
  CART_MAX_LINES,
  CART_MAX_LINE_QUANTITY,
  COUNTRY_CODES,
  SUPPORTED_CURRENCIES,
  StoreSettingsError,
  StripePaymentAdapter,
  TaxAddressError,
  TaxCalculationError,
  bindCommerceApi,
  createEcommerceLayoutBlocks,
  currencyMinorUnits,
  deliverPendingCommerceEmails,
  ecommercePlugin,
  formatMoney,
  fromMinorUnits,
  identityEmailChange,
  isCountryCode,
  isSupportedCurrency,
  minimumChargeAmount,
  readStoreCurrency,
  readStoreSettings,
  reconcileCommerce,
  shippingOptionsFor,
  toMinorUnits
};
