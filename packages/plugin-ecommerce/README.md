# @talisman-cms/plugin-ecommerce

Commerce for Talisman CMS: a product catalog in D1, a cookie-keyed basket, hosted Stripe Checkout, shopper accounts, promotions, gift cards, order fulfillment and order emails. It all runs in the site's own Cloudflare Worker. Public checkout is off until you enable it; read [PRODUCTION_READINESS.md](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-ecommerce/PRODUCTION_READINESS.md) before taking live orders. Prices, credit and payments are in one store currency, USD unless `TALISMAN_COMMERCE_CURRENCY` sets another, and the store's delivery countries, shipping rates and Stripe Tax mode are Worker settings too; see [Currency, delivery, shipping and tax](#currency-delivery-shipping-and-tax).

## Quick start

### 1. Install

```bash
pnpm add talisman-cms @talisman-cms/plugin-ecommerce @astrojs/cloudflare react react-dom @tanstack/react-router drizzle-orm@rc
pnpm add -D wrangler
```

`react`, `react-dom`, `@tanstack/react-router` and `drizzle-orm` are peer dependencies. The commerce admin screens run inside the CMS admin with the app's copies, so list them in the app's own `package.json`. `drizzle-orm@rc` is Drizzle's release-candidate tag, which the packages are built on (`1.0.0-rc.4` at this release); a bare `drizzle-orm` would install the 0.45 release, which they no longer work with. With pnpm, a site that imports `drizzle-orm` itself next to the packages' tables should also depend on `zod@^3.25`: Drizzle 1.0 lists zod as an optional peer, and pnpm otherwise installs a second `drizzle-orm` copy against the newest zod for the site, whose types do not mix with the packages' copy.

### 2. Register the plugin

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import talismanCms from 'talisman-cms';
import { LocalAuthAdapter } from 'talisman-cms/auth/local';
import { ecommercePlugin } from '@talisman-cms/plugin-ecommerce';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [
    talismanCms({
      auth: LocalAuthAdapter(),
      plugins: [ecommercePlugin()]
    })
  ]
});
```

| Option | Default | Effect |
| --- | --- | --- |
| `productsCollectionSlug` | `'products'` | The collection shown as Products. The plugin creates it, mapped to the native `_ecommerce_products` table, unless the site defines one with this slug. Baskets and checkout always read `_ecommerce_products`. |
| `injectCollections` | `true` | Registers the native commerce tables (variants, stock, carts, orders, shoppers, promotions, gift cards) as admin-only collections under **Commerce**, the admin section this plugin provides. With `false` the tables still exist but are hidden from the admin; the section, its workspace and the product editor's options panel stay. |
| `adminPages` | none | Overrides for the Orders, Promotions, Gift cards and Test checkout links: each a path relative to the admin path, such as `extensions/orders`, or an absolute path on the site. The defaults are `extensions/commerce-orders` and so on, so they follow a custom `adminPath`. A full URL fails the build. |
| `adminTestCheckout` | `false` | Adds the admin-only **Test checkout** screen and `/admin/api/ecommerce/test-checkout`, which place orders with a simulated payment. See [Admin test checkout](#admin-test-checkout). |
| `emailTemplates` | none | A module, as a package specifier or an absolute path, that replaces the order confirmation, shipment and gift card claim emails. See [Order emails](#order-emails). |

### 3. Bindings and migrations

The plugin uses the CMS's Worker bindings (see the Talisman CMS README): `DB` (D1, required) holds the commerce tables, and `EMAIL` (a `[[send_email]]` binding) sends shopper sign-in links and order emails. It adds no binding of its own.

The plugin ships its D1 migrations in its `drizzle/` folder as drizzle-kit writes them from `src/schema.ts`, plus a hand-written migration with the commerce triggers. Registering the plugin makes the integration copy the core's and the plugin's migrations into the one folder the `DB` binding's `migrations_dir` points at, `node_modules/.talisman-cms/migrations`, on every `astro dev`, `astro build`, `astro sync` or `astro check`. Run `astro sync` (or a build) first, then apply every migration:

```bash
pnpm exec astro sync
pnpm exec wrangler d1 migrations apply DB --local   # local development
pnpm exec wrangler d1 migrations apply DB --remote  # production database
```

The plugin needs the core's migrations and its own applied, in that order: its shopper accounts reference the core's user table, and every read fails on a database without its tables. Run the duplicate checks under [Hosted Stripe checkout](#hosted-stripe-checkout) before enabling checkout.

### 4. Worker settings

Settings are read at request time with `readSetting` from `talisman-cms/env`. Put secrets in Worker secrets or `.dev.vars`, never in `astro.config`, CMS globals or browser code.

| Setting | Default | Purpose |
| --- | --- | --- |
| `TALISMAN_COMMERCE_CHECKOUT_ENABLED` | off | `true` enables the public checkout and discount preview routes and the checkout action. Otherwise both routes answer HTTP 503 "Checkout is disabled" and the action refuses with `FORBIDDEN`, before the basket is read. |
| `TALISMAN_COMMERCE_STRIPE_MODE` | `test` | `live` accepts real payments and requires an `sk_live_...` key. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | none | Stripe secret key for the mode (`sk_test_...` or `sk_live_...`) and the webhook signing secret (`whsec_...`). Stripe is unavailable unless both are set. |
| `TALISMAN_COMMERCE_LOCAL_STRIPE_SECRET_KEY`, `TALISMAN_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET` | none | Test-mode fallbacks for local development. Ignored in live mode. |
| `TALISMAN_COMMERCE_CURRENCY` | `usd` | The store currency, an ISO 4217 code such as `eur` or `JPY`. Every amount is an integer in its minor units. See [Store settings](#store-settings). |
| `TALISMAN_COMMERCE_DELIVERY_COUNTRIES` | any country | The ISO 3166-1 alpha-2 codes of the countries the store delivers to, such as `US, CA`. |
| `TALISMAN_COMMERCE_SHIPPING_RATES` | no shipping charge | A JSON list of up to 10 shipping rates. See [Shipping rates](#shipping-rates). |
| `TALISMAN_COMMERCE_TAX` | `none` | `stripe-inclusive` or `stripe-exclusive` calculates tax with Stripe Tax. See [Tax](#tax). |
| `TALISMAN_COMMERCE_TAX_CODE`, `TALISMAN_COMMERCE_SHIP_FROM_COUNTRY` | none | The Stripe product tax code for every item, and the country the goods ship from, for Stripe Tax. |
| `TALISMAN_COMMERCE_GIFT_CARDS_ENABLED` | off | `true` enables gift card sales. They also need checkout enabled, the key below and a store currency of USD. |
| `TALISMAN_COMMERCE_GIFT_CARD_KEY` | none | 64 hex characters that encrypt gift card codes. Keep it stable and backed up. |
| `TALISMAN_COMMERCE_GIFT_CARD_PREVIOUS_KEYS` | none | Comma-separated older keys of 64 hex characters that still decrypt codes after a key rotation. See [Key rotation](#key-rotation). |
| `TALISMAN_COMMERCE_REFERRALS_ENABLED` | off | `true` turns new referral attribution on while no referral settings are saved in the admin. A saved policy wins in both directions. See [Referral credit](#referral-credit). |
| `TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS`, `TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS` | `1000`, `5000` | Referral terms until an admin saves referral settings, in the store currency's minor units despite their names. The reward must be at most half the minimum, or new referrals are paused. |
| `TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS` | `30` | Days after payment that referral awards stay pending before the scheduled job may release them (1–365). |
| `TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD`, `TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS` | `10`, `30` | The most approved referrals one referrer can have recorded within the rolling period (1–10000, and 1–365 days). |
| `TALISMAN_EMAIL_FROM`, `TALISMAN_PUBLIC_ORIGIN` | none | Sender and storefront origin for sign-in links and order emails; gift card claim links need an https origin. `TALISMAN_COMMERCE_EMAIL_FROM` and `TALISMAN_COMMERCE_PUBLIC_ORIGIN` override them for shopper mail. |
| `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` | `200` | Store-wide cap on sign-in emails per 24 hours. |
| `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` | a quarter of the limit | The part of the daily cap kept for addresses with a verified account or a purchased order. A whole number from 0 to the limit minus 1. |
| `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY`, `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` | none | Cloudflare Turnstile keys for the sign-in bot check. The site key is public; the secret is a Worker secret. Set both or neither. See [Sign-in email limits and bot check](#sign-in-email-limits-and-bot-check). |
| `TALISMAN_COMMERCE_STORE_NAME`, `TALISMAN_COMMERCE_STORE_LEGAL_NAME`, `TALISMAN_COMMERCE_STORE_ADDRESS`, `TALISMAN_COMMERCE_SUPPORT_EMAIL` | see [Order emails](#order-emails) | The store details that order emails show. |
| `TALISMAN_COMMERCE_TERMS_URL`, `TALISMAN_COMMERCE_RETURNS_URL`, `TALISMAN_COMMERCE_WARRANTY_URL` | none | The policy links in order confirmations: an https URL or a path on the public origin. |

Deployments configured before the rename can keep the `GALAXY_` names of these settings; a `GALAXY_` value is read when the `TALISMAN_` one is missing or blank. A number setting that is blank or not a whole number in its range means its default. The currency, delivery, shipping and tax settings are stricter: blank means unset, but any other invalid value closes checkout with HTTP 503 until it is fixed (see [Store settings](#store-settings)).

### 5. Scheduled job

The plugin registers a scheduled job with the CMS through `Plugin.scheduled`; the module is `@talisman-cms/plugin-ecommerce/scheduled`. On every cron tick it runs `reconcileCommerce` with the payment providers configured in the Worker, `runtimePaymentAdapters(env)`, which settles checkouts whose webhook was missed, releases old checkout locks, records and reverses tax, releases held referral awards and retries order emails, and then `purgeStaleCommerceData`, which deletes shopper data past its retention period. The two steps are independent: a failure in one never skips the other. A failure is logged as `[Commerce] Checkout reconciliation failed` or `[Commerce] Data retention cleanup failed`, and the invocation is recorded as failed, so alert on failed scheduled invocations of the Worker.

The site runs the job by naming a Worker entry that exports the CMS's scheduled handler next to Astro's fetch handler, and by setting a cron trigger, at least every ten minutes:

```ts
// src/worker.ts
import { handle } from '@astrojs/cloudflare/handler';
import { scheduled } from 'talisman-cms/worker';

export default { fetch: handle, scheduled };
```

```toml
# wrangler.toml
main = "./src/worker.ts"

[triggers]
crons = ["*/10 * * * *"]
```

The handler runs the job of every plugin that declares one, in registration order, and fails the invocation when any job failed. The integration warns at build time when a plugin declares a job and no wrangler config names a cron trigger. `reconcileCommerce`, `deliverPendingCommerceEmails` and `purgeStaleCommerceData` stay exported from `@talisman-cms/plugin-ecommerce/api` for server code and for a scheduled handler of your own; a site that keeps its own handler calls them itself and leaves the CMS's out.

### 6. Storefront pages

The plugin injects the API routes below; the site renders its own pages. Stripe returns shoppers to `/checkout/success?order=<id>` and `/checkout/cancel?order=<id>` on the request origin, so provide both. Email sign-in links open `/account/verify`, gift card buyers return to `/gift-cards/success`, emailed gift card claim links open `/gift-cards/claim` (see [Gift card claim links](#gift-card-claim-links)), and `CartView` links to `/shop`, `/checkout` and `/checkout/cancel`.

| Route | Access | Purpose |
| --- | --- | --- |
| `GET`, `POST /api/ecommerce/cart` | public | Read or replace the basket. New baskets are limited per client network. See [Basket limits](#basket-limits). |
| `POST /api/ecommerce/checkout` | public, enable flag | Start or resume hosted Stripe Checkout from the shopper's open basket. |
| `POST /api/ecommerce/discount` | public, enable flag | Preview a discount or gift card code against the basket, within a code-check budget. See [Discount preview](#discount-preview). |
| `GET`, `POST /api/ecommerce/order` | the placing basket or account | Order status, or release an open payment session. |
| `POST /api/ecommerce/webhooks/stripe` | Stripe-signed | Payment completion, expiry, refunds and disputes. See [Stripe events](#stripe-events). |
| `/api/ecommerce/account`, `/api/ecommerce/gift-cards` | public | Shopper sign-in, gift card purchase, balance and claim links. |
| `/admin/api/ecommerce/fulfillment`, `orders-admin`, `reconcile`, `promotions`, `gift-cards-admin`, `variants` | CMS admin | The commerce admin screens and the product editor's options and stock. `reconcile` also lists checkouts parked for review and retries or releases them. `test-checkout` is added with `adminTestCheckout: true`. |

### 7. Components and helpers

```astro
---
import CartBadge from '@talisman-cms/plugin-ecommerce/components/CartBadge.astro';
---
<CartBadge server:defer />
```

- **`CartBadge.astro`** links to the basket and shows its item count. Props: `href` (`/cart`), `label`, `activePaths`, `class`, `activeClass`, `inactiveClass`, `badgeClass` and `eventName`. It reads the basket and shopper cookies and never creates or changes a basket. Rendered as a server island, it sends `Cache-Control: private, no-store`. It updates when the page dispatches `CART_UPDATED_EVENT`.
- **`CartView.astro`** is an editable basket. Props: `items`, `locked`, `pendingOrderId`, `itemCount`, `requiresShipping`, `subtotal` and `currency`. The page builds `items` from the basket and catalog. Each item has `key`, `productId`, `variantId`, `quantity`, `productName`, `variantLabel`, `imageUrl`, `unitPrice`, `lineTotal`, `type`, `stockLabel` and `href`. Quantity changes are posted to `/api/ecommerce/cart`. `currency` (default `usd`) is the currency whose minor units the prices are in; a store that sells in another currency passes it, for example the `currency` of `api.carts.quote(cartId)` or `readStoreSettings(env).currency`, or the prices are formatted as USD.
- **`CartItemCard.astro`** renders one server-side line (`item`, `locked`, `currency`).
- `@talisman-cms/plugin-ecommerce/money`: `formatMoney`, `currencyMinorUnits`, `toMinorUnits`, `fromMinorUnits` and `minimumChargeAmount`. The module has no imports, so browser and admin bundles can use it. See [Money in minor units](#money-in-minor-units).
- The package root, for server code: besides `ecommercePlugin`, `bindCommerceApi`, `reconcileCommerce`, `deliverPendingCommerceEmails`, the payment adapters and the `PaymentProviderAdapter`, `PaymentReferences` and `CommerceEmailTemplates` types, it exports `readStoreSettings`, `readStoreCurrency`, `StoreSettingsError`, `shippingOptionsFor`, `COUNTRY_CODES`, `isCountryCode`, the money helpers, `TaxCalculationError`, `TaxAddressError` and the types `StoreSettings`, `ShippingRate`, `TaxSettings`, `ShippingOption`, `TaxCalculation` and `TaxCalculationParams`. See [Currency, delivery, shipping and tax](#currency-delivery-shipping-and-tax).
- `@talisman-cms/plugin-ecommerce/browser`: `startCheckout`, `getOrderStatus`, `cancelCheckout`, the shopper account helpers (`requestCustomerEmailSignIn(email, { turnstileToken })`, `readCustomerSignInToken`, `previewCustomerSignIn`, `verifyCustomerEmailSignIn`, `getCustomerAccount`, `signOutCustomerAccount` and `chooseCustomerBasket`), the gift card claim helpers `readGiftCardClaimToken` and `claimGiftCardCode`, `CART_UPDATED_EVENT` and `dispatchCartUpdated`. `startAdminTestCheckout(input, { adminPath })` needs `adminTestCheckout: true`; pass `adminPath` when the CMS is not at `/admin`.
- `@talisman-cms/plugin-ecommerce/cookies`: the basket and gift card cookie names, `readCartSessionToken` and `ensureCartSession`.
- `@talisman-cms/plugin-ecommerce/actions`: the `getCart`, `addToCart`, `clearCart` and `checkout` Astro actions. `addToCart` and `checkout` throw `ActionError` `TOO_MANY_REQUESTS` over the basket and code-check limits.
- `@talisman-cms/plugin-ecommerce/accounts`: server helpers for shopper sign-in, including `requestCustomerEmailSignIn`, `shopperSignInBotCheck(env)` and `normalizeShopperEmail`.
- `@talisman-cms/plugin-ecommerce/referrals`: referral helpers, including `getReferralPolicy`, `getReferralDashboard`, `findReferralCode`, `releaseReferralAwards`, `reverseReferralForOrder`, `referralTermsError`, `referralNetAmount`, `referralOrderQualifies`, `referralReversalStatements` and `canonicalEmail`, the defaults `REFERRAL_HOLD_DAYS`, `REFERRAL_MAX_PER_PERIOD` and `REFERRAL_PERIOD_DAYS`, and the types `ReferralPolicy`, `ReferralDashboard` and `ReferralReleaseResult`. See [Referral credit](#referral-credit).
- `@talisman-cms/plugin-ecommerce/api`: `bindCommerceApi({ env, paymentAdapters })`, `reconcileCommerce`, `deliverPendingCommerceEmails` and `purgeStaleCommerceData` for server code and a scheduled handler of your own, `TaxCalculationError`, `PARKED_CHECKOUT_MESSAGE`, `ReconcileFailure` with the types `ReconcileFailureCode` and `ReconcileResult`, and the webhook errors `WebhookSignatureError`, `WebhookRetryLaterError` and `WebhookMismatchError`.
- `@talisman-cms/plugin-ecommerce/scheduled`: `scheduled`, the plugin's scheduled job, which the CMS handler from `talisman-cms/worker` runs on every cron tick. See [Scheduled job](#5-scheduled-job).
- `@talisman-cms/plugin-ecommerce/fulfillment`: the orders queue and shipments (see [Orders and fulfillment](#orders-and-fulfillment)). `@talisman-cms/plugin-ecommerce/order-adjustments`: restocks and the full refund statements (see [Refunds, disputes and restock](#refunds-disputes-and-restock)). `@talisman-cms/plugin-ecommerce/gift-cards`: gift card issue, review, claim links and key rotation (see [Gift cards](#gift-cards)). `@talisman-cms/plugin-ecommerce/emails`: the email templates and their types (see [Order emails](#order-emails)).

The components use Tailwind utility classes, including `brand-*` colors, and `CartBadge` reads Worker bindings from `cloudflare:workers`. Code that only renders must read a basket with `api.carts.find`, never `api.carts.getOrCreate`: `getOrCreate` creates a basket for a new token and moves a signed-in shopper's basket to it.

### Basket limits

A basket holds at most 50 lines (`CART_MAX_LINES`) of 1 to 99 units each (`CART_MAX_LINE_QUANTITY`); `bindCommerceApi().carts.updateItems` enforces this for every caller. The cart route answers HTTP 413 to a request body over 64 KB and HTTP 400 to other violations; the actions answer `BAD_REQUEST`. A line must name a product in `_ecommerce_products` that is not archived, so draft products can go in a concept basket. Its `variantId` must be a variant value of that product, or a legacy variant group of it (a group with no values). A product that has variant groups is sold only as one of its variants: a line without a `variantId`, or naming a group that has values, is refused ("Cart items must choose one of the variants of ..."), and the quote and checkout refuse such a line saved earlier with "Select an option for ..." (HTTP 409 from the checkout route), before anything is reserved. Lines already in the basket are not checked again, so a shopper can still change or remove a product that was archived later. Only `productId`, `variantId` and `quantity` are stored. A rejected request creates no basket and sets no cookie, and reading never creates one.

Creating a basket is limited to 20 new baskets per client network per hour (`NEW_BASKETS_PER_NETWORK_PER_HOUR`); a client network is an IPv4 address or an IPv6 /64, taken from `CF-Connecting-IP`. The cart route and the `addToCart` action share the limit, and count only a request that creates a basket, after its items pass validation. Over the limit the route answers HTTP 429 `{ "error": "Too many new baskets. Please try again later." }` with `Retry-After: 3600`, the action throws `ActionError` `TOO_MANY_REQUESTS`, and neither writes a basket row or cookie; show the message to the shopper. Changes to an open basket, reads, and emptying a basket that does not exist are never counted or refused. A request without a client IP, as in local development, is not limited. The checkout route and action use only an existing open basket and never create one.

The plugin's own limits cover basket creation, code checks, sign-in email, gift card claims and provider checks per order from the order status route, checkout resume and session release. As defence in depth, also add a Cloudflare rate limiting rule, keyed on the client IP, for every public path under `/api/ecommerce/` except `/api/ecommerce/webhooks/` (today `account`, `cart`, `checkout`, `discount`, `gift-cards` and `order`, for every request method), and for `/_actions/*` if the site uses the plugin's Astro actions. Leave the Stripe webhook paths `/api/ecommerce/webhooks/*` and `/api/stripe/webhooks` out of every per-IP rule: Stripe sends webhooks from a small set of addresses, so a per-IP limit would drop deliveries. Launch gate 8 in [PRODUCTION_READINESS.md](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-ecommerce/PRODUCTION_READINESS.md) has the details.

## Code-first catalog, then Commerce editing

Use `@talisman-cms/plugin-ecommerce/catalog` when a site starts with product data in code. It exports two reusable helpers:

- `createCommerceCatalogSeedSql(seed)` generates an idempotent SQLite/D1 import for products, categories, variants, purchasable values, components, and optional content entries. Run it after the Talisman CMS migrations. Existing rows are left intact, so later admin edits win.
- `commerceContentCollection({ name, slug, fields })` registers a site-specific collection under **Commerce** for content that does not belong in the native product schema, such as product stories or a lens preview. Configure it in `talismanCms({ collections: [...] })`.

```js
import { createCommerceCatalogSeedSql } from '@talisman-cms/plugin-ecommerce/catalog';

const sql = createCommerceCatalogSeedSql({
  products: [{
    id: 'frame-01', name: 'Frame 01', slug: 'frame-01',
    images: ['/images/frame-01.jpg'], status: 'draft', basePrice: 0
  }],
  content: [{
    collection: { name: 'Frame Stories', slug: 'frame-stories' },
    entries: [{ id: 'story-frame-01', slug: 'frame-01', data: { slug: 'frame-01', story: 'A design study.' } }]
  }]
});
process.stdout.write(sql);
```

Save the output as SQL and apply it to the same database as the CMS. Read the catalog with `readCatalog` (below) and content through its configured collection. Native Commerce edits are visible immediately; content collections use the CMS publish action before the public site reads the new version. Source files are first-run defaults, not a live file editor.

Product image URLs are stored as a string array. The Commerce editor presents each URL as a media row and converts it back to a string on save.

### Read the catalog

`readCatalog(env, { status })` from the same module reads the catalog for a storefront in one statement: every product with its variant groups, each with its definition, its values, their stock rows and bills of materials, and the product's categories and tags, oldest first; `status: ['active']` narrows the products. The rows are typed from the schema (`CatalogProduct`) and come straight from D1, without the KV cache, so a Commerce edit shows on the next request. One call serves every product a page shows:

```ts
import { readCatalog } from '@talisman-cms/plugin-ecommerce/catalog';

const products = await readCatalog(env, { status: ['active'] });
const frame = products.find((product) => product.slug === 'frame-01');
const pairings = frame?.variants.flatMap((group) => group.values.map((value) => ({
  id: value.id, name: `${group.variant?.name ?? group.name}: ${value.value}`, sku: value.sku,
  available: value.stock?.quantity ?? 0, parts: value.requirements.length,
})));
```

For other reads, `@talisman-cms/plugin-ecommerce/schema` exports the tables and their `relations`, and `createDbClient(env, relations)` from `talisman-cms/client` gives `db.query.<table>` with `with:` nesting across every foreign key (an order's `fulfillments`, `disputes` and `account`, a product's `categories` through the junction, a shopper account's `cmsUser` in the CMS user table) next to the select builder.

## Commerce admin workspace

The plugin provides the admin's **Commerce** section (`Plugin.adminSections`): the sidebar entry, the routes `/admin/commerce`, `/admin/commerce/<slug>` and `/admin/commerce/<slug>/<id>`, and the workspace page, which groups the native records into products and catalog setup, shoppers and carts, promotions and referrals, gift card activity, and audit records. Every plugin collection is tagged with `adminSection: 'commerce'`, a site-defined products collection included. The section is admin-only: editors do not see the workspace, and get the commerce collections they may read under Collections. The plugin also provides the product editor's **Options & stock** panel and the storefront preview (`adminEditorPanels`), the model guide shown on the other catalog records, and the labels of commerce records in relation pickers and summaries (`adminEntryDescribers`); without the plugin the admin has no Commerce section. Prices in the admin show in the store currency, which the admin page exposes to the screens from `TALISMAN_COMMERCE_CURRENCY` (`adminSettings`).

It also provides task-focused screens inside the Talisman CMS admin shell: orders and fulfillment, promotions, and gift cards. Registering `ecommercePlugin()` adds them to the Commerce workspace; `ecommercePlugin({ adminTestCheckout: true })` adds the Test checkout screen as well. The site still provides its public storefront, basket, checkout, and account pages.

```js
ecommercePlugin()
```

The default paths are `/admin/extensions/commerce-orders`, `/admin/extensions/commerce-promotions`, and `/admin/extensions/commerce-gift-cards`, plus `/admin/extensions/commerce-test-checkout` when enabled, under the default admin path; they follow a custom `adminPath`. A store can override task links with same-origin `adminPages` paths when it has a genuinely store-specific workflow. The plugin owns the protected commerce APIs and shared operation screens. The screens scale and format money by its currency's minor units: **Promotions** in the store currency, **Orders** in each order's currency and **Gift cards** in USD.

The **Orders** screen is the store's daily queue: every order awaiting shipment, with its items, amounts and shipments (see [Orders and fulfillment](#orders-and-fulfillment)), each order's disputes and **Return stock** (see [Refunds, disputes and restock](#refunds-disputes-and-restock)), and the checkouts whose payment check is parked for review (see [Reconciliation backoff and parked checkouts](#reconciliation-backoff-and-parked-checkouts)). The **Gift cards** screen adds purchases held for review, replacement cards, claim link resends and the code encryption panel (see [Gift cards](#gift-cards)). The read-only collections **Provider Refunds**, **Disputes**, **Restocks**, **Gift Card Reviews**, **Gift Card Claim Links**, **Order Emails** and **Payment Check Decisions** keep the records of these actions.

### Product options and stock

The product editor's **Options & stock** saves through `POST <adminPath>/api/ecommerce/variants`, an administrator-only, same-origin endpoint, so upgrade `talisman-cms` and this plugin together. The body's `action` names the change, and each change is one D1 batch, so a failure writes nothing and a retry cannot create a second value:

- `saveValue` takes `groupId`, `value` (`value`, `sku`, `image` and `priceOverride`, plus `id` and `expectedUpdatedAt` for a saved value) and, optionally, `stock` (`quantity`, plus `id` and `expectedUpdatedAt` for a saved row). It creates a value with its stock row, or updates a value and, only when `stock` is sent, its stock quantity.
- `deleteValue` takes `valueId` and deletes the value with its stock row and its variant component rows.
- `deleteGroup` takes `groupId` and deletes the group with its values, their stock rows and their variant component rows. The shared components themselves stay.

A saved row must come with the `updatedAt` the editor loaded: a stale one, or a row that is gone, gets HTTP 409 with the core's stale message and `code: 'stale_record'`, and nothing is written; a missing token gets 428. Invalid input gets 400, a SKU another value uses 409, a delete of a value or group that does not exist 404, and a failed batch 500. After a committed change the endpoint clears the core's cached reads of the rows it wrote with `invalidateEntryCache` from `talisman-cms/client`; a failed clear is logged, and those reads expire within an hour. These changes run no collection hooks registered on the variant, value, stock or variant component collections. The editor keeps its edits after a refusal that wrote nothing; after a stale token, a missing row or an unknown outcome it loads the saved rows and says so.

Every write to a stock column, by checkout reservations and releases, restocks and this endpoint, moves the row's `updated_at` by at least one second (`MAX(updated_at + 1, now)`), so an admin stock save loaded before a reservation in the same second gets 409. Quoting and checkout read a basket's catalog in one batch and reserve stock with one statement per stock table, a fixed number of statements whatever the size of the basket. Checkout's stock writes do not clear cached reads, so storefronts read stock with `cache: false`, for example `getClient(env).entries.findMany('_ecommerce_stocks', { depth: 0, cache: false })`.

## Hosted Stripe checkout

`ecommercePlugin()` provides the cart, checkout, order status, and Stripe webhook routes. An app only needs to register the plugin and render its own cart and checkout pages. The separate `plugin-stripe` package handles Stripe resource sync and is not required for payments.

Apply the migrations (the core's, then the plugin's, from the assembled folder) before deploying the plugin's Worker; [Bindings and migrations](#3-bindings-and-migrations) describes the folder.

The cart lives in D1 and is keyed by a 30-day, HTTP-only, SameSite browser cookie. A cart version prevents concurrent edits from overwriting each other. Starting checkout locks the cart, creates a 31-minute hosted Stripe session, and atomically reserves component and ordinary stock before returning the payment URL. A cancelled or expired session releases stock and unlocks the same cart. A paid webhook closes the cart and records one payment even if Stripe retries the event.

Shoppers can register before buying with a passwordless email link. Asking for a link creates no account: the plugin stores the SHA-256 hash of the one-time token and the address it was sent to, and creates the account for that address, already verified, or reuses the existing one only when the link is used. After a confirmed real payment, the plugin also links the paid order and basket to a shopper account, creating one for a first-time checkout email. A signed-in shopper's order stays on their authenticated account even if they enter a different checkout email. When a shopper confirms an emailed link, the plugin links their account to the CMS's shared user identity for that email (`ensureVerifiedEmailIdentity` from `talisman-cms/auth/identity`). A new address becomes a CMS user with the `customer` role, which appears in **Users** but cannot open the CMS. An editor or admin who shops with the same address keeps one identity and their CMS role. Migration `0019` links shoppers verified before the upgrade in the same way. Shopper sessions and cookies remain separate from CMS sessions. **Payment and basket possession do not sign a shopper in.** The browser calls `requestCustomerEmailSignIn(email)` and receives a one-time link at that address. The link opens `/account/verify#token=...`: the token is in the URL fragment, so browsers never send it to the server and it stays out of request logs. The storefront's verify page calls `readCustomerSignInToken()` from `@talisman-cms/plugin-ecommerce/browser`, which reads the token, removes it from the address bar, and still accepts `?token=` links sent before this change. Before the shopper confirms, the page can call `previewCustomerSignIn(token)` to show which account the link opens (see [Sign-in link preview](#sign-in-link-preview)). The page then calls `verifyCustomerEmailSignIn(token)` when the shopper confirms. The link expires after 15 minutes and can be used once. The resulting HTTP-only shopper session lasts 30 days. `GET /api/ecommerce/account` reads the current account and `DELETE` signs out, clearing both shopper and basket cookies. An expired shopper session cannot use its old basket cookie to access an account basket. A storefront with a verified sign-up or SSO flow can pass the authenticated account ID to `api.carts.getOrCreate(sessionToken, accountId)` to attach the current guest basket. If both the guest and account baskets contain items, the API preserves them until the shopper explicitly chooses one with `chooseCustomerBasket('browser' | 'account')`.

Sign-in links are sent with the CMS email provider from `talisman-cms/email/runtime`: by default a Cloudflare Email Service `[[send_email]]` binding named `EMAIL`, or a provider registered with `talismanCms({ email })` (see the Talisman CMS README). Configure these Worker settings:

- `TALISMAN_EMAIL_PROVIDER=cloudflare` selects the binding explicitly. With the setting unset, a registered provider is used, then the `EMAIL` binding.
- `TALISMAN_EMAIL_FROM` is the sender, for example `Shop <no-reply@shop.example>`. Its display name is the shop name in the message. `TALISMAN_COMMERCE_EMAIL_FROM` overrides it for shopper mail.
- `TALISMAN_EMAIL_REPLY_TO` (optional) receives replies.
- `TALISMAN_PUBLIC_ORIGIN` is the storefront origin used in links, for example `https://shop.example`. `TALISMAN_COMMERCE_PUBLIC_ORIGIN` overrides it. It must match the request origin, which keeps links from being built from an untrusted Host header.
- `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` (optional, default 200) caps sign-in emails across the store per 24 hours, and `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` (optional) keeps part of it for existing customers. See [Sign-in email limits and bot check](#sign-in-email-limits-and-bot-check).
- `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY` and the secret `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` (optional, set together) require a Cloudflare Turnstile check before a link is sent.

The `GALAXY_` names of these settings still work. Resend is no longer built in; register it or any other HTTP email API as a custom provider. Without a provider, sender or matching origin, the account API answers HTTP 503 "Email sign-in is unavailable" and logs which part is missing. When the provider refuses a message, it answers 503 and logs the provider's error code, never the address, link or token. Every message carries `Auto-Submitted: auto-generated` so vacation responders do not reply to it. The account API returns the same accepted response for known, unknown, rate-limited and suppressed addresses. Only a bare address is accepted: one with a display name, such as `Name <shopper@example.com>`, or with a second recipient gets HTTP 400 "Valid email required", and a link always goes to exactly the lowercased address. The API limits each address to three links per ten minutes and each source IP to 20 requests per hour; IPv6 addresses count per /64 prefix. Once the general part of the daily limit is spent, every request gets HTTP 200 `{ "accepted": true, "limited": true }` until the 24-hour window ends, and only existing customers are still sent a link. These counters are kept in the plugin's `_ecommerce_rate_limits` table, apart from the rate limits of CMS sign-in, which better-auth prunes on its own schedule. Order confirmations, shipment notices and gift card claim links go through the same provider and sender; see [Order emails](#order-emails).

Sign-in links are stored in `_ecommerce_sign_in_tokens`, by hash. The earlier basket-based activation flow is gone: `activateNewCustomerAccount` no longer grants access.

`purgeStaleCommerceData`, which the [scheduled job](#5-scheduled-job) runs after reconciliation, deletes sign-in links, with the address they were sent to, a day after they expired or were used, and shopper request counters a day after their window. It also deletes the accounts that earlier versions created for every sign-in request: accounts that were never verified, are at least a day old, and have no order, session, open basket, credit, referral or discount use.

Configure Worker secrets at runtime:

```text
TALISMAN_COMMERCE_CHECKOUT_ENABLED=true
TALISMAN_COMMERCE_STRIPE_MODE=test
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Test mode is the default. To accept live payments, set `TALISMAN_COMMERCE_STRIPE_MODE=live` explicitly and provide a matching `sk_live_...` key. Both Stripe secrets are required. Never place them in `astro.config`, CMS globals, or browser code. Stripe Checkout collects card details; the app should collect and validate contact and delivery details before calling `POST /api/ecommerce/checkout`. The `checkout` action from `@talisman-cms/plugin-ecommerce/actions` starts the same Stripe checkout behind the same enable flag, but validates less than the route: it does not limit field lengths or drop unknown address fields. Both refuse a country code that is not officially assigned, an undeliverable country and an unavailable shipping option, which `createFromCart` checks for every caller. Validate the address in the storefront before calling the action.

Configure Stripe to send `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed` to `/api/ecommerce/webhooks/stripe`. An open dispute holds its order as `disputed`, which cannot ship. A dispute closed as won, or an inquiry closed, gives the order back its status; a lost one refunds the order in full, which also voids its referral, reverses released awards and reverses its tax (see [Refunds, disputes and restock](#refunds-disputes-and-restock)). Checkout sessions put the order or gift card purchase id on the PaymentIntent, so refunds and disputes carry it; [Stripe events](#stripe-events) says how the endpoint answers each event. The completed event is accepted only when Stripe reports a paid session whose ID, amount, and currency match the order; sessions are created in the order currency with Adaptive Pricing off, so they always can (see [Presentment currency](#presentment-currency)). The browser can read its own order status with `GET /api/ecommerce/order?order=...` and release an open payment session with a same-origin `POST /api/ecommerce/order` body of `{ "orderId": "..." }`. `POST /api/ecommerce/checkout` resumes an existing open Stripe session for the same cart.

The order status route also checks Stripe when an order remains pending, at most once per order every 15 seconds and only once the order is 60 seconds old; the webhook normally settles an order before then. Other status requests return the stored status with the same response shape. Without a webhook, a paid order therefore shows as pending until it is 60 seconds old, and after that for up to about 15 seconds longer than the provider reports; set storefront polling timeouts with both in mind. Checkout resume and session release (`POST /api/ecommerce/order`) share the same slot per order, without the minimum age: while it is taken they change nothing and answer HTTP 429 with `Retry-After: 15` (the `checkout` action throws `TOO_MANY_REQUESTS`) and "The payment session was checked moments ago. Please try again in 15 seconds." The shopper can retry after 15 seconds (`Retry-After`). Server code that handles shopper requests through `bindCommerceApi` passes `{ limitProviderChecks: true }` to `orders.resumeFromCart` (a limited call returns `providerCheckLimited: true`) and to `orders.cancel` (a limited call throws `ProviderCheckLimitedError`), and leaves `orders.reconcilePending` to reconciliation; without the option these methods ask the provider on every call. Reconciliation, gift-card orders and simulated `admin_test` orders are not limited by this. The plugin's [scheduled job](#5-scheduled-job) runs `reconcileCommerce({ env, paymentAdapters: runtimePaymentAdapters(env) })` on every cron tick, and the protected `POST /admin/api/ecommerce/reconcile` endpoint runs it for manual recovery. It checks old pending sessions, releases orphaned `preparing:` locks only after 35 minutes, beyond the 31-minute Stripe session lifetime, records and reverses tax that was not recorded or reversed in time (see [Tax](#tax)), releases held referral awards and retries order emails (see [Order emails](#order-emails)). Each result has an `id` and a `status`: the record's status after the check, `preparation_checked`, `unchanged`, `tax_recorded` or `tax_reversed` for an order's tax, one of `referral_released`, `referral_void` and `referral_held` for a referral, an email status for an email, or `error`, with an admin-safe `error` message and, for a checkout or a tax attempt, a `code`. Treat only `error` as a failure. Run the cron at least every ten minutes and alert on failed scheduled invocations. Keep the signed webhook configured; reconciliation is a backstop, and the status route no longer asks the provider on every request. [Reconciliation backoff and parked checkouts](#reconciliation-backoff-and-parked-checkouts) describes how failing checkouts are retried and when they wait for an administrator.

The admin **Orders** screen and `/admin/api/ecommerce/fulfillment` list the orders to ship and record shipments; see [Orders and fulfillment](#orders-and-fulfillment). Connect them to the store's packing and shipping process; issuing labels is a separate integration.

### Stripe events

Checkout sessions put `metadata.orderId`, or `metadata.giftCardPurchaseId` for a gift card purchase, on the PaymentIntent, so the charge, its refunds and its disputes carry the store's reference. The webhook answers each event as follows:

- An event that names none of the store's orders or gift card purchases, such as another integration's, is answered HTTP 200 `{ "success": true, "event": "...", "ignored": true }` and changes nothing. It is logged at info level as `[commerce] Stripe event ignored`, with its type and id only.
- An event for one of the store's records that cannot be applied, and that no retry would change, is answered 200 with `"ignored": true` and a `reason`: `amount_mismatch`, `currency_mismatch`, `session_mismatch`, `order_cancelled`, `refund_mismatch`, `purchase_mismatch`, `purchase_not_pending` or `payment_not_recorded`. It is logged at error level as `[commerce] Stripe event does not match the store records`, with its type, id and reason.
- A refund or dispute of an order or gift card purchase whose payment is not recorded yet is answered HTTP 409 `{ "error": "...", "retry": true }`, so Stripe sends it again later.
- A refused signature is answered 400, and any other failure 500 with a generic message, logged as `[commerce] Stripe webhook failed`. Before this release every failure was answered 400.

Stripe retries an answer other than 2xx for up to three days, and can disable an endpoint that keeps failing. Alert on the two error-level log lines, and on repeated 409s, which mean a pending order or purchase that reconciliation has not settled. Checkout sessions created before this release carry no PaymentIntent metadata, so an early refund or dispute of one of their payments is ignored rather than retried. `ValidatedWebhookEvent` gains an optional `id` and `created`, and `PaymentProviderAdapter` an optional `getPaymentReferences(paymentIntentId)`, which returns the references a payment carries so that a dispute of a payment the store has not recorded yet can be told from another integration's; `StripePaymentAdapter` implements it.

### Reconciliation backoff and parked checkouts

`reconcileCommerce` takes up to `limit` (default 10, at most 20) pending orders and as many pending gift card purchases per run: rows never tried first, then those tried longest ago. Each attempt is recorded on the row (migration `0029`), and the row then waits 2^attempts minutes, at most six hours, before its next one, so rows that keep failing never hold back newer ones. Failures are reported by code, never with the provider's text:

- Permanent failures park the row for review: `session_missing` (Stripe answers that the checkout session does not exist), `session_mode_mismatch` (a session of the other Stripe mode than `TALISMAN_COMMERCE_STRIPE_MODE`, recognised by its `cs_test_` or `cs_live_` id before Stripe is asked, once Stripe is configured) and `payment_mismatch` (a completed payment whose amount, currency or payment does not match).
- Transient failures back off: `provider_not_configured` (Stripe is not configured, which includes a missing or wrong `TALISMAN_COMMERCE_STRIPE_MODE` for the key), `provider_unavailable`, `provider_refused` and `failed`.

The attempt that parks a row reports `error` with its `code` and `parked: true`. A parked row is not selected again, so it is reported once, also when runs overlap, and a scheduled run fails only for newly parked rows and transient failures. A parked checkout keeps its stock, credit, promotion and gift card reservations, and its basket stays locked. Shopper routes never ask Stripe about it: `GET /api/ecommerce/order` returns the stored status with `paymentUnderReview: true`, and checkout resume, the `checkout` action and `POST /api/ecommerce/order` answer HTTP 409 (the action `CONFLICT`) with `PARKED_CHECKOUT_MESSAGE`, "The store is reviewing the payment for this checkout. Contact the store to release it." Checkout resume answers the same when its own check fails permanently, and the release route for a session of the other Stripe mode, before the row is parked. `getPurchasedGiftCard` returns `paymentUnderReview` too. When the status route's check fails, it now returns the stored status instead of HTTP 409 with the provider's text.

The tax passes back off the same way, on counts of their own: an order's count covers recording its tax transaction and reversing its refunds, and a reversal's own count covers sending it. Failures at payment and refund time count too, and a success clears the count. Tax records and reversals are never parked: one that keeps failing, such as one whose calculation has expired, is tried and reported again after waits that grow to six hours.

The admin **Orders** screen lists parked checkouts under **Payment checks parked for review**. `GET /admin/api/ecommerce/reconcile` returns them as `{ storeMode, parkedCount, parked }`: at most 100, longest parked first, each with its failure and the Stripe mode of its session, without session ids or addresses. `POST` with `{ "action": "retry" | "release", "kind": "order" | "gift_card_purchase", "id": "...", "reason": "..." }` acts on one, with a reason of 8–500 characters. A `POST` without an action still runs reconciliation; invalid input gets HTTP 400 and a refused action 409. Each decision is recorded with the administrator's user id, the reason and the failure the row was parked with, in `_ecommerce_reconcile_decisions` (the read-only **Payment Check Decisions** collection), in the batch that carries it out. Keep shopper personal data out of the reasons.

- **Retry** returns the row to reconciliation with its attempts reset, so the next run checks it first. A failure that is still permanent parks it again.
- **Release** cancels the pending order, which returns its reservations and unlocks the basket, or cancels the gift card purchase. It never asks Stripe about a session of the other mode (check that session in that mode's Stripe dashboard first; a paid one must be refunded there), but it needs Stripe configured. Any other session is asked about: an open one is expired, and one Stripe no longer has counts as closed. A session of the other mode, or one Stripe no longer has, may still be paid until it expires, so its release is refused (409) until 35 minutes after the checkout started. A completed checkout is released only once Stripe reports its payment refunded in full or lost to a dispute; only where Stripe names no payment to check does `"confirmPaymentReturned": true` stand in for that. The result's `paymentReturned` is `'refunded'`, `'dispute_lost'`, `'confirmed'` or `null`.

`orders.cancel(id, { reviewRelease })` performs the release of an order; `reviewRelease` carries the administrator's decision and is meant for that route only. `PaymentProviderAdapter` adds an optional `getRefundStatus(paymentIntentId)`, returning `'none'`, `'partial'` or `'full'`, which `StripePaymentAdapter` implements. `reconcileGiftCardPurchase` accepts a missing adapter and returns `{ status: 'pending', review: true }` for a parked purchase without asking Stripe.

## Currency, delivery, shipping and tax

The store's currency, delivery countries, shipping rates and tax mode are Worker settings. A store that sets none of them sells in USD, delivers to any country and charges no shipping or tax.

### Store settings

```toml
[vars]
TALISMAN_COMMERCE_CURRENCY = "usd"
TALISMAN_COMMERCE_DELIVERY_COUNTRIES = "US, CA"
# Amounts are in the currency's minor units: 800 is $8.00.
TALISMAN_COMMERCE_SHIPPING_RATES = '''
[
  { "id": "standard", "label": "Standard shipping", "amount": 800, "freeOver": 10000, "minDays": 3, "maxDays": 7 },
  { "id": "express", "label": "Express shipping", "amount": 2500, "countries": ["US"], "minDays": 1, "maxDays": 2 }
]
'''
TALISMAN_COMMERCE_TAX = "stripe-exclusive"
TALISMAN_COMMERCE_TAX_CODE = "txcd_99999999"
TALISMAN_COMMERCE_SHIP_FROM_COUNTRY = "US"
```

| Setting | Default | Value |
| --- | --- | --- |
| `TALISMAN_COMMERCE_CURRENCY` | `usd` | An ISO 4217 code in any case, such as `eur` or `JPY`, stored and sent to Stripe in lowercase. It must be one of the supported currencies: aed, aud, bgn, brl, cad, chf, czk, dkk, eur, gbp, hkd, huf, inr, jpy, mxn, myr, nok, nzd, pln, ron, sek, sgd, thb and usd. |
| `TALISMAN_COMMERCE_DELIVERY_COUNTRIES` | any country | Officially assigned ISO 3166-1 alpha-2 codes in any case, separated by commas and/or whitespace, or a list value such as `["US", "CA"]`. Stored in uppercase, in the order given, without duplicates. See [Delivery countries](#delivery-countries). |
| `TALISMAN_COMMERCE_SHIPPING_RATES` | no shipping charge | A JSON list of at most 10 rates, as text or as a list value (a TOML array of inline tables). See [Shipping rates](#shipping-rates). |
| `TALISMAN_COMMERCE_TAX` | `none` | `none`, `stripe-inclusive` (prices include tax) or `stripe-exclusive` (tax is added to prices), in any case. See [Tax](#tax). |
| `TALISMAN_COMMERCE_TAX_CODE` | the Stripe account's default | The Stripe product tax code for every item: `txcd_` and eight digits, such as `txcd_99999999`. |
| `TALISMAN_COMMERCE_SHIP_FROM_COUNTRY` | none | An officially assigned country code in any case, sent to Stripe Tax as the country the goods ship from. |

**Invalid settings close checkout.** Unlike the other settings, these are checked strictly. Blank counts as unset, but a value of the wrong type (a number or list where text is expected), a malformed or unassigned code, a list with no entries and a rate with an unknown or invalid field are refused rather than ignored, so a typo never changes what the store charges. The tax code and ship-from country are checked even while the tax mode is `none`. The checkout route and action and the discount preview read the settings before they read any basket or account; gift card sales and issuing, and the admin test checkout, read them before they write anything. A refused value makes them answer HTTP 503 `{ "error": "Checkout is temporarily unavailable." }` (the `checkout` action throws `ActionError` `SERVICE_UNAVAILABLE` with that message) and log `[Commerce] Store settings are invalid: <message>`. The message names the setting, for a rate also its position and field (`TALISMAN_COMMERCE_SHIPPING_RATES[1].amount: ...`), and quotes the value; shoppers never see it. Webhooks and reconciliation keep settling existing orders in their stored currency meanwhile.

`readStoreSettings(env)` returns the checked settings as a `StoreSettings` object, `{ currency, deliveryCountries, shippingRates, tax }`: `deliveryCountries` is `null` when unset, `shippingRates` is a list of `ShippingRate` objects (empty when unset; optional fields left out are `null`), and `tax` is a `TaxSettings` object, `{ mode, taxCode, shipFromCountry }`. It throws `StoreSettingsError` for an invalid value. `readStoreCurrency(env)` reads and checks the currency alone, for pages that only show prices, so a mistake in another setting closes checkout without stopping them. So do `api.carts.quote`, `api.orders.createFromCart`, `evaluateDiscountCode` and the functions that issue, sell or redeem a gift card, which read the settings themselves; server code that calls them should show shoppers a generic message for that error.

### Money in minor units

Every amount is an integer in the minor units of its currency, as `Intl.NumberFormat` defines them: cents for USD, yen for JPY (no decimals). That covers product prices and price overrides, discount values, credit and voucher balances, the referral reward and minimum (whose settings and columns keep their `_CENTS` names), shipping rates and every order amount. Admin fields that hold such amounts are labelled "(smallest currency unit)". The CMS admin page renders the store currency as `<meta name="talisman-commerce-currency" content="usd">`, which the **Promotions** and **Gift cards** screens and the product editor read; the **Promotions** forms take amounts in major units, such as 12.50, with the currency's step and the server's bounds.

`@talisman-cms/plugin-ecommerce/money` has no imports, so storefront and admin bundles can use it; the package root exports the same functions:

- `formatMoney(amount, currency, locale = 'en-US')`: `formatMoney(1250, 'usd')` is "$12.50" and `formatMoney(1250, 'jpy')` is "¥1,250".
- `currencyMinorUnits(currency)`: 2 for USD, 0 for JPY.
- `SUPPORTED_CURRENCIES` and `isSupportedCurrency(currency)`: the currencies a store can use.
- `toMinorUnits(major, currency)` and `fromMinorUnits(amount, currency)` convert between major and minor units.
- `minimumChargeAmount(currency)`: Stripe's minimum card charge in the currency, or 50 for a currency missing from its table (Stripe still enforces its own minimum). Store credit, discount codes and a gift card that pays part of an order always leave at least this much to pay.

`CartView.astro` and `CartItemCard.astro` take the store currency as their `currency` prop (see [Components and helpers](#7-components-and-helpers)).

### Delivery countries

Checkout accepts only the 249 officially assigned ISO 3166-1 alpha-2 codes, in any case, and stores them in uppercase. Reserved, user-assigned and withdrawn codes, such as `UK`, `EU` or `XK`, get HTTP 400 "Enter a valid country code". This applies to the shipping and the billing country, also to a shipping address sent for a basket with nothing to ship.

`TALISMAN_COMMERCE_DELIVERY_COUNTRIES` applies only when the basket needs shipping: the shipping country must be one of the codes, or checkout answers HTTP 400 "We do not deliver to this country". A basket with nothing to ship is not checked against the list. The billing country is checked as a code but never restricted to the list. Unset, any assigned code is accepted. The checkout route, the `checkout` action, `createFromCart` and the admin test checkout apply the same rules, for every payment provider.

`COUNTRY_CODES` lists the assigned codes, sorted, and `isCountryCode(code)` checks one; it is case-sensitive, so trim and uppercase input first. Both come from the package root, which is not meant for browser bundles: build a country select on the server from `readStoreSettings(env).deliveryCountries`, or from `COUNTRY_CODES` when that is `null`.

### Shipping rates

`TALISMAN_COMMERCE_SHIPPING_RATES` lists the rates checkout offers, in order:

| Field | Required | Value |
| --- | --- | --- |
| `id` | yes | 1–40 characters from `a-z`, `0-9`, `_` and `-`, unique among the rates. Checkout requests and orders name the rate by it. |
| `label` | yes | 1–100 characters after trimming, shown to shoppers, on the Stripe payment page and on the order. |
| `amount` | yes | The charge in minor units, a whole number from 0. |
| `countries` | no | The codes of the countries the rate serves, in any case. When delivery countries are set, each must be one of them. Left out, the rate serves every delivery country, or every country. |
| `freeOver` | no | A positive amount in minor units: the rate is free once the items total after discounts reaches it. |
| `minDays`, `maxDays` | no | The delivery estimate in business days, 1–365, with `minDays` at most `maxDays`. Either may be set alone. |

A field set to `null` counts as left out. An unknown field, such as a misspelt `free_over`, an empty list of rates and an empty `countries` list are refused like any invalid setting.

An order that ships pays the rate the shopper chose with `shippingRateId`, or else the first rate that serves the shipping country. When no rate serves the country, checkout answers HTTP 400 "We do not deliver to this country", even without `TALISMAN_COMMERCE_DELIVERY_COUNTRIES`; an unknown id, or a rate that does not serve the country, gets HTTP 400 "This shipping option is not available for your country". A blank id counts as no choice, and the id is ignored when nothing ships or the store has no rates; those orders pay no shipping. Rates apply to every payment provider, the simulated `admin_test` one too. `shippingRateId` is accepted by the checkout route body (up to 40 characters), the `checkout` action, `startCheckout` and `startAdminTestCheckout` from `/browser`, and `api.orders.createFromCart`.

Stripe charges shipping above 0 as a line item of its own, named after the rate's label, with the delivery estimate ("Delivery in 3–7 business days") as its description. Free shipping adds no line. The order records `shipping_amount`, `shipping_rate_id` and `shipping_label`.

`shippingOptionsFor(readStoreSettings(env), country, itemsAmount)` lists a destination's options, so a storefront can offer them before checkout: the rates that serve `country`, in order, each as a `ShippingOption` `{ id, label, amount, description, freeOver, minDays, maxDays }`, where `amount` is what the shopper pays for items worth `itemsAmount` (the items total after discounts, in minor units) and `description` the delivery estimate or `null`. Checkout charges the same, and takes the first option when the shopper sends none. The list is empty for a country the store does not deliver to and for a store without rates.

### Tax

With `TALISMAN_COMMERCE_TAX` set to a Stripe mode, checkout calculates the tax with [Stripe Tax](https://docs.stripe.com/tax) through the payment adapter:

- `stripe-exclusive`: tax is added to the prices. The shopper pays it, and the Stripe session charges it as a line item named "Tax".
- `stripe-inclusive`: the prices and shipping rates include tax. Stripe Tax works out the part that is tax, which the order records; no amount changes.

Before setting either mode, activate Stripe Tax in the Stripe Dashboard: set the origin address, add a registration for every place where the store must collect tax, and set a default product tax code unless `TALISMAN_COMMERCE_TAX_CODE` is set. Stripe Tax calculates no tax for a place without a registration.

1. **Before payment.** Checkout calculates the tax after the discount and store credit and before the basket is locked, so a failure reserves nothing. Each product line is sent at its total less its share of the discount and of the credit, which are spread over the lines in proportion to their totals (a discount code limited to some products over those only), in whole minor units. Lines left at 0 are left out. Stripe takes no line at 0, so when the discount and credit leave every line at 0 and shipping is charged, the shipping is the calculation's only line, under Stripe's shipping tax code `txcd_92010001`. Lines are named `L<n>:<product id>` (and `:<variant id>`) in Stripe Tax. A shipping charge is sent as the shipping cost, together with the tax behaviour, and the tax code and ship-from country when they are set. The address is the shipping address when the order ships, otherwise the billing address, which must then have a country; the shopper's name is never sent. The order records `tax_amount`, `tax_behavior` (`inclusive` or `exclusive`) and `tax_calculation_id`. `automatic_tax` stays off, so the session charges exactly the order's total.
2. **After payment.** When a payment is confirmed, the plugin records a Stripe Tax transaction from the calculation, with the order id as its reference, and stores `tax_transaction_id`. A failure is logged (`[Commerce] The tax transaction of order <id> was not recorded: <cause>`) and never fails the confirmation; `reconcileCommerce` records the transaction later, dated at the payment (`posted_at`) so its tax falls in the payment's period, and waits longer after each failed attempt (see [Reconciliation backoff and parked checkouts](#reconciliation-backoff-and-parked-checkouts)).
3. **Refunds.** Refunds are mirrored by partial reversals of the transaction, tax included, up to what has been refunded: the gift card and provider amounts together once the order is `refunded`, otherwise its provider and gift card refunds so far. Each `charge.refunded` webhook reverses what is new; `reconcileCommerce` reverses gift card tender refunds, refunds of gift-card-only orders and any reversal that failed. A reversal is recorded in `_ecommerce_tax_reversals` before Stripe is asked, under a reference that names the order and the total it brings the reversals to, which is also Stripe's idempotency key, so no refund is reversed twice. One whose request failed stays pending and is sent again, unchanged, by `reconcileCommerce` after five minutes, and after longer waits if it keeps failing. A failure is logged (`[Commerce] The tax reversal of order <id> was not recorded: <cause>`) and never fails the webhook. A lost dispute leaves the order `refunded`, so its tax is reversed in full the same way.

A discount code and store credit lower the taxed amount. A gift card is a means of payment, not a price reduction: it never lowers the taxed amount, and it can pay the tax. Checkout calculates the tax through the adapter that takes the payment, and through the Stripe adapter for an order a gift card pays in full; simulated `admin_test` orders are never taxed, and gift card purchases are not taxed. A payment adapter without `calculateTax`, `recordTaxTransaction` and `reverseTaxTransaction` cannot take orders while a tax mode is set: checkout answers 503 (see [Admin test checkout](#admin-test-checkout) for the adapter methods). While a tax mode is set, a storefront must send a billing address with a country for a basket with nothing to ship, and should let the shopper correct an address that Stripe Tax cannot place.

### Order totals

Every order amount is in the order currency's minor units, worked out in this order:

- the items at their prices, less the discount code's amount: the items after discounts;
- shipping: the rate's charge, or 0 when the items after discounts reach its `freeOver`, when the store has no rates or when nothing ships;
- store credit, which pays for items only: at most the shopper's balance and the items after discounts, and it leaves at least the currency's minimum charge to pay, counting the shipping;
- exclusive tax, calculated on the items less the discount and credit, and on the shipping;
- a gift card, which pays for what is then due, shipping and tax included, and leaves nothing or at least the minimum charge;
- `total_amount`, the rest, which the payment provider charges.

The order stores them as `subtotal_amount`, `discount_amount`, `credit_applied`, `shipping_amount`, `tax_amount` with `tax_behavior`, `gift_card_applied` and `total_amount`, and they balance: `subtotal_amount + shipping_amount + tax_amount (when exclusive) = discount_amount + credit_applied + gift_card_applied + total_amount`. The discount and gift card redemption guards refuse to reserve a code or card for an order that does not balance. Stripe receives the items, the shipping and tax lines, and one single-use coupon for the discount, credit and gift card together.

The order status route (`GET /api/ecommerce/order`), `getOrderStatus` from `/browser` and `listCustomerOrders` from `/accounts` return `shippingAmount`, `shippingLabel`, `taxAmount` and `taxBehavior` (`'inclusive'`, `'exclusive'` or `null`) with the order's other amounts and its `currency`. The admin **Orders** screen lists each order's items subtotal, discount, store credit, shipping with its label, tax (or "Tax included in the prices"), gift card, charged total and refunds, and the read-only Orders collection shows the shipping and tax fields. The order confirmation email lists the same amounts.

### Presentment currency

Stripe Checkout Sessions are created with `currency` set to the order currency and `adaptive_pricing: { enabled: false }`, and every line item and the coupon use that currency. Stripe therefore never shows the buyer a local currency, whatever the account's Adaptive Pricing setting in the Dashboard, and a captured payment always has the amount and currency that confirmation and refunds compare with the order.

### Shopper messages

| Answer | Checkout route | `checkout` action | When |
| --- | --- | --- | --- |
| "Checkout is temporarily unavailable." | 503 | `SERVICE_UNAVAILABLE` | A store setting is invalid. The discount preview, gift card sales and issuing, and the admin test checkout answer the same. |
| "Enter a valid country code" | 400 | `BAD_REQUEST` | The shipping or billing country is not an officially assigned code. |
| "We do not deliver to this country" | 400 | `BAD_REQUEST` | The basket ships and its country is not a delivery country, or no shipping rate serves it. |
| "This shipping option is not available for your country" | 400 | `BAD_REQUEST` | `shippingRateId` names no rate, or one that does not serve the country. |
| "A billing address is required to calculate tax" | 400 | `BAD_REQUEST` | A tax mode is set, nothing ships, and the billing address has no country. |
| "Tax cannot be calculated for this address. Check it and try again." | 400 | `BAD_REQUEST` | Stripe Tax cannot place the address, for example a US address with an invalid ZIP code. |
| "Tax could not be calculated. Please try again." | 503 | `SERVICE_UNAVAILABLE` | Any other tax failure. The Worker log has `[Commerce] Tax could not be calculated for basket <id>: <cause>`. |
| "This code is not valid for this order." | 409 | `CONFLICT` | A gift card code in a store whose currency is not USD, like any other refused code (`"field": "giftCardCode"`). |

The admin test checkout route answers the country and shipping refusals with 400 as well. `TaxCalculationError` (from the package root and `/api`) carries the 503 tax message, and `calculateTax` rejects with `TaxAddressError` for an address the provider cannot place.

### Limits

- **Gift cards are USD only.** The gift card tables keep cards and their purchases in USD (a CHECK constraint), so a store whose currency is not USD refuses to issue them (HTTP 400 "Gift cards are available only in stores that use USD" from the admin gift card route), to sell them (the same from `POST /api/ecommerce/gift-cards`) and to redeem them (the 409 refusal above), until those tables are rebuilt for other currencies. Balance lookups, tender refunds and refunds of gift-card-only orders still work for existing cards. The **Gift cards** screen says so and disables **Issue**.
- **Choose the currency before the first order, and keep it.** Store credit balances, referral terms, discount values and voucher balances are plain amounts without a currency, so after a change they are read in the new currency. Do not change `TALISMAN_COMMERCE_CURRENCY` once orders, gift cards, store credit or discount codes exist. Orders keep their own currency, which confirmation and refunds use.
- **Only supported currencies.** The store currency must be in `SUPPORTED_CURRENCIES`. Each of them has a known Stripe minimum charge, and `Intl` and Stripe agree on its minor units. Other codes close checkout like any invalid setting. That includes typos, currencies whose minor units differ (Stripe takes ISK in two-decimal form while `Intl` shows no decimals), and three-decimal currencies such as KWD, which Stripe takes only in steps of ten.
- **Promotion limits are sized for two-decimal currencies.** Discount values, referral rewards and minimum orders keep their upper limits in minor units, for example at most 100,000 for a referral reward. In a currency with low-value units, such as INR or THB, those limits are worth less.
- **The discount preview has no destination.** Its `creditApplied` and `cardAmount` leave out shipping and tax, so checkout's credit and amount to pay can differ once rates or exclusive tax apply. [PRODUCTION_READINESS.md](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-ecommerce/PRODUCTION_READINESS.md#known-limits) lists the other known limits.

## Orders and fulfillment

An order's `status` is its payment status: `pending`, `paid`, `partially_refunded`, `refunded`, `disputed` or `cancelled` (`draft` and the legacy `fulfilled` stay readable). Whether it shipped is its `fulfillmentStatus` (the `fulfillment_status` column): `unfulfilled`, `partially_fulfilled` or `fulfilled`. A refund or dispute changes only the payment status, so it never hides a shipment. `_ecommerce_fulfillments` rows are only ever added: an order can ship in several parcels, and a correction restates a shipment's carrier and tracking number in a new row with the administrator and a reason, keeping the shipment as first recorded. Shipments and corrections count in the order they were written, whatever the clock of the Worker that wrote them said.

- A shipment needs a paid or partially refunded real order that has not shipped in full, a note of 8–500 characters and an administrator. Pending, cancelled, refunded, disputed and admin test orders cannot ship; a database trigger enforces the same rules.
- A shipment completes the order unless it is recorded as one parcel of several. A completing shipment is final: the order leaves the queue, and no further parcel can be recorded for it.
- A correction is allowed whatever the payment status, but not on an admin test order. It restates both values, so a value left out is cleared, and needs a carrier or a tracking number and a reason of 8–500 characters.

The admin **Orders** screen reads its queue from the server. **Awaiting shipment**, the default view, lists every paid or partially refunded real order not yet shipped in full, oldest first, with a count of all of them; **All recent orders** lists real orders past checkout, newest first. Pages hold 50 orders, and a search finds an exact order ID or email address. Each order shows product names, variant labels and SKUs from the current catalog, its labelled amounts, its payment and fulfillment status, and each shipment with its corrections. **This shipment completes the order** is ticked by default, and the screen asks before it completes an order that already has a partial shipment.

`GET /admin/api/ecommerce/fulfillment` takes `view` (`awaiting`, the default, or `recent`), `cursor`, `limit` (1–100, default 50) and `query` (an exact order id or an email address), and returns `{ view, pageSize, awaitingCount, nextCursor, orders }`. Each order has `status`, `fulfillmentStatus`, `canShip`, `items` (with `productName`, `variantLabel`, `sku`, `unitAmount` and `lineTotal`), `amounts` (`{ key, label, cents }`, deductions negative) and `shipments`, each with the carrier and tracking number in force, the `recorded` ones and its `corrections`, in the order written. `POST` takes a JSON body with an `action`:

- `{ "action": "list", "view": "awaiting", "query": "..." }` returns the same page as `GET`. The admin screen reads the queue this way, so an address it searches for stays out of request URLs and the logs that keep them; API clients should search by email this way too.
- `{ "action": "ship", "orderId": "ord_...", "carrier": "...", "trackingNumber": "...", "note": "...", "completesOrder": false }` records a shipment; `completesOrder` defaults to `true`. A body without an action that names an `orderId` records a completing shipment, as before.
- `{ "action": "correct", "fulfillmentId": "ful_...", "carrier": "...", "trackingNumber": "...", "reason": "..." }` appends a correction.

Invalid input gets HTTP 400 (it was 409), a refused write 409 and a failed read 500. `@talisman-cms/plugin-ecommerce/fulfillment` exports the same functions: `listCommerceOrdersAdmin(env, options)`, `fulfillCommerceOrder(env, actor, input)`, which returns `fulfillmentStatus` next to the payment `status`, and `correctCommerceFulfillment(env, actor, input)`, with `FulfillmentInputError`, `ORDERS_PAGE_SIZE` and `ORDERS_PAGE_MAX`. `bindCommerceApi().orders.updateStatus(id, 'fulfilled', details)` records a completing shipment and leaves `status` as it is. A recorded shipment, and a correction made once its notice went out, emails the buyer (see [Order emails](#order-emails)).

Storefronts read `fulfillmentStatus` from `GET /api/ecommerce/order` and `listCustomerOrders`. A shipped order keeps its payment status, so code that checked `status === 'fulfilled'` reads `fulfillmentStatus` instead.

## Refunds, disputes and restock

Refund a Stripe payment in Stripe; the `charge.refunded` webhook records it. Each rise in an order's refund total adds a row to `_ecommerce_provider_refunds` (the read-only **Provider Refunds** collection), dated by the Stripe event that reported it, in the batch that records the new total, so a retried or out-of-order event adds nothing and the rows of an order add up to its `provider_refunded_cents`. The analytics plugin counts refunds on those dates. `provider_refund_id` is filled only on Stripe API versions before 2022-11-15, whose events list the charge's refunds. A refund never returns stock by itself.

**Disputes.** `charge.dispute.created` records the dispute in `_ecommerce_disputes` (the read-only **Disputes** collection) and moves a paid or partially refunded order to `disputed`, which cannot ship and leaves **Awaiting shipment**; the order keeps its referral, but the award is not released while the dispute is open, and a refund recorded meanwhile leaves the order disputed. When the dispute closes with an outcome other than lost, such as won or a closed inquiry, and no other dispute of the order is open, the order gets back its status from before the dispute, or `partially_refunded` or `refunded` if refunds were recorded meanwhile. A lost dispute refunds the order in full, as a full refund does: its promotion and gift card redemptions are refunded, the store credit it used goes back to the shopper, its referral is voided with released awards reversed, and its tax transaction is reversed. `provider_refunded_cents` stays as it was, since Stripe made no refund.

A dispute of a gift card purchase holds the purchase for review and suspends every card it funds, replacements included; a won dispute ends the hold, and a lost one voids the cards and reverses what is left on them, once no checkout in progress holds value on them (until then the event is answered 409 and retried). Value already spent on orders stays spent. Respond to disputes in Stripe; each order's panel on the **Orders** screen lists its disputes. `disputed` counts as a purchase for first-order codes, referrals and the reserved sign-in budget.

**Restock.** An administrator returns a refunded order's stock from its panel on the **Orders** screen (**Return stock**), with a reason of 8–500 characters. Every reservation row of a refunded order can go back at once, or chosen rows of it or of a partially refunded one; nothing is ticked in advance, and the form says when the order shipped or lost a dispute. Each row goes back once, added to the current stock, and is recorded with the administrator and the reason in `_ecommerce_restocks` (the read-only **Restocks** collection). Pending, cancelled, paid, disputed and admin test orders are refused. `POST /admin/api/ecommerce/orders-admin` serves the panel: `{ "action": "list", "orderIds": ["ord_..."] }` returns each order's status, fulfillment status, restock mode (`'all'`, `'choose'` or `null`), disputes and reservation rows, and `{ "action": "restock", "orderId": "ord_...", "reason": "...", "reservations": [{ "type": "inventory", "id": "..." }] }` returns stock, where each reservation's `type` is `inventory` or `component`; without `reservations`, which only a refunded order allows, every row not yet returned goes back. A refusal gets HTTP 409, invalid input 400 and any other failure 500 with a generic message, logged as `[commerce] Restock failed`. `@talisman-cms/plugin-ecommerce/order-adjustments` exports `restockOrder`, `getOrderAdjustmentsAdmin`, `fullRefundStatements`, `OrderAdjustmentInputError` and `OrderAdjustmentRefusedError`.

## Order emails

The plugin sends three kinds of email through the CMS email provider of `talisman-cms/email/runtime` (the Cloudflare Email Service binding, a registered custom provider, or the console provider on localhost), from `TALISMAN_COMMERCE_EMAIL_FROM` or `TALISMAN_EMAIL_FROM`:

- **Order confirmation**, once a payment is confirmed, on every path that confirms it: the Stripe webhook, reconciliation, the order status route and checkout of an order a gift card pays in full. It lists the order number and date, the items with their current catalog names, quantities and line prices, the amounts as the admin **Orders** screen labels them, worded for the buyer, the shipping address, and the store details and policy links set below. Admin test orders get none, and neither does an order refunded before its confirmation went out; a dispute opened meanwhile does not stop it.
- **Shipment notice**, when a shipment is recorded, with the carrier and tracking number in force and whether more parcels follow. A correction made once the notice went out, or while it is being sent, sends an **Updated shipping details** email; a notice not sent yet carries the correction anyway.
- **Gift card claim email**, when a gift card purchase is paid: a one-time link to the code, never the code itself. See [Gift card claim links](#gift-card-claim-links).

Each email has a row in `_ecommerce_email_deliveries` (the read-only **Order Emails** collection), written in the batch of the change that calls for it, so duplicate webhooks and the reconciliation path send one email. It is sent right after that batch, under a five-minute lease, and a failed send never fails the payment, shipment or webhook. `reconcileCommerce` retries failed emails, at most five per run, earliest due first, waiting 10 minutes after the first failure and twice as long after each further one, up to 12 hours; an email is given up after 10 attempts or 7 days. Emails that wait for a setting keep their place and never hold back the others. Delivery is at least once: if a Worker stops after the provider accepted an email but before recording it, the email is sent again once the lease has passed. Rows, results and logs hold ids and error codes, never an address; the recipient is read from the order or purchase when the email is sent. Orders paid and cards bought before the upgrade get no email.

`reconcileCommerce` reports each email it tries as `<kind>:<subject id>`, where the subject is the order, shipment, correction or gift card purchase, with the status `email_sent`, `email_retry` (tried again later), `email_cancelled` or `email_undeliverable` (final: no longer due, or a suppressed or invalid address), or `error` for what needs an operator: email that is not configured (one result with the id `commerce_emails` for each missing setting, counting the waiting emails), a sender the provider refuses, and an email given up. `deliverPendingCommerceEmails({ env }, { limit })`, from the package root and `/api`, runs the retries on their own (default 10, at most 50). A failed immediate send is logged as `[commerce] Email not sent`, with ids and codes only.

| Setting | Default | Purpose |
| --- | --- | --- |
| `TALISMAN_COMMERCE_STORE_NAME` | the sender's display name, else the public origin's host | The store name in subjects and headings. |
| `TALISMAN_COMMERCE_STORE_LEGAL_NAME` | the store name | The seller's legal name in the confirmation. |
| `TALISMAN_COMMERCE_STORE_ADDRESS` | none | The seller's postal address, with a line break between lines. |
| `TALISMAN_COMMERCE_SUPPORT_EMAIL` | the `TALISMAN_EMAIL_REPLY_TO` address | A bare address that the emails give for questions; when set, it is also their Reply-To. |
| `TALISMAN_COMMERCE_TERMS_URL`, `TALISMAN_COMMERCE_RETURNS_URL`, `TALISMAN_COMMERCE_WARRANTY_URL` | none | Links to the terms of sale, the returns and right of withdrawal page and the warranty page: an https URL or a path on the public origin. |

Gift card claim emails also need an https `TALISMAN_PUBLIC_ORIGIN` (or `TALISMAN_COMMERCE_PUBLIC_ORIGIN`); http is accepted only on localhost. Without one the claim email waits and the scheduled run reports it; order emails are unaffected. An invalid support address or link is left out, with a warning in the Worker log. The confirmation links to the policy pages rather than carrying their text. Turn off any provider feature that stores message content, since claim links are bearer links for 7 days.

**Templates.** `ecommercePlugin({ emailTemplates })` names a module, as a package specifier or an absolute path, for example `fileURLToPath(new URL('./src/lib/commerce-emails.ts', import.meta.url))`. It exports any of `orderConfirmation`, `shipment` and `giftCardClaim`; the others keep the default. Each is `(email, defaults) => { subject, text, html? }`, or a promise of it, where `email` is the email's data and `defaults` the default message. The data has `store` (`name`, `legalName`, `address`, `supportEmail`, `termsUrl`, `returnsUrl`, `warrantyUrl` and `origin`) and:

- order confirmation: `order`, with `id`, `placedAt`, `currency`, `items` (`name`, `productName`, `variantLabel`, `sku`, `quantity`, `unitCents` and `lineCents`), `amounts` (`{ key, label, cents }`) and `shippingAddress`;
- shipment: `order` (`id`, `placedAt`), `shipment` (`id`, `shippedAt`, `carrier`, `trackingNumber`, `completesOrder` and `earlierShipments`) and `update`, true for the updated details;
- gift card claim: `purchase` (`id`, `amountCents`, `currency`) and `claim` (`url`, `expiresAt`).

The subject must be one line, and the text part is required. A template that throws or returns anything else is logged, and the default is sent. `@talisman-cms/plugin-ecommerce/emails` exports the `CommerceEmailTemplates` type and the data types, `renderCommerceEmail`, which builds the text and HTML parts in the style of the CMS's emails, `formatMoney`, `formatDate`, `formatAddress`, `emailLink` and the default templates. The defaults are in English, with dates in UTC. `formatMoney` formats an amount in its currency's minor units, as `/money` does. In the confirmation's `amounts`, deductions are negative, and `taxIncluded` shows tax already inside the item prices, so a template that adds the amounts up leaves it out.

## Sign-in link preview

A storefront can show which account a sign-in link opens before the shopper confirms, so a shopper who forwarded or mixed up links does not sign in to the wrong account. `previewCustomerSignIn(token)` from `@talisman-cms/plugin-ecommerce/browser` sends this same-origin request:

```http
POST /api/ecommerce/account
Content-Type: application/json

{ "token": "<one-time token>", "preview": true }
```

A usable link answers HTTP 200 with the address it was sent to, masked: `{ "email": "j•••@example.com" }`. The link stays usable, no session or cookie is created, and no account is created. A used, expired or unknown token answers HTTP 400 `{ "error": "This sign-in link is invalid or has expired." }`, the same answer a sign-in with that token gets. Links are sent to any valid address and create nothing until they are used, so neither answer shows whether an address has an account. Previews are limited like sign-in requests, to 20 per hour per source IP (IPv6 per /64) in their own budget, and answer HTTP 429 beyond that. A request with any `preview` value other than `false` is a preview, so a malformed flag never uses the link. Previews and link use need no Turnstile token.

## Sign-in email limits and bot check

Sign-in email requests (`POST /api/ecommerce/account` with `{ email }`) are checked in this order: same origin (403), the email configuration (503 "Email sign-in is unavailable"), the address format (400 "Valid email required"), the optional Turnstile check (403), then the counters and the send.

**Limits.** Each address can ask for three links per ten minutes, and each source IP (IPv6 per /64) for 20 per hour. The per-address limit is an atomic counter in `_ecommerce_rate_limits`, next to the count of recent links, and counters that concern an address hold only a SHA-256 hash of the normalized address. A request over one of these limits gets the normal answer and sends nothing.

**Daily budget.** `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` (default 200) is the total per 24-hour window. `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` (default a quarter of the limit, rounded down, so 50 of 200) is kept for addresses with a verified shopper account or a purchased order (paid, fulfilled, partially refunded, refunded or disputed; admin test orders do not count); a value that is not a whole number from 0 to the limit minus 1 means the default. The rest, the general pool, serves every address. Once the general pool is spent, every request answers HTTP 200 `{ "accepted": true, "limited": true }`, whatever the address. Only existing customers are then sent a link, from the reserve, each address at most twice per 24 hours. The customer lookup and the send from the reserve run after the response through the Worker's `waitUntil`, so the answer takes the same time for every address, and a failed send there is logged, not returned. Show a neutral message for `limited: true`, such as "Sign-in emails are limited today". Each limited request logs `[commerce] Daily sign-in email limit reached` with `{ pool: 'general' }`. The counters are `shopper-email:daily` (the general pool) and `shopper-email:reserved` in `_ecommerce_rate_limits`. The reserve is shared by all existing customers; the per-IP limit, the bot check and the Cloudflare rule bound how fast it is used.

On the server, `requestCustomerEmailSignIn(env, email, linkForToken, sendLink, sourceIp, { waitUntil, onLimitedSendError })` from `@talisman-cms/plugin-ecommerce/accounts` returns `{ limited }`. Without `waitUntil`, the reserve's lookup and send run before the call returns. `CustomerEmailLimitError` is still exported but no longer thrown.

**Bot check.** Set `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY` (public) and the Worker secret `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` together to require a Cloudflare Turnstile check; blank counts as unset. With the secret set, the account route verifies the request's `turnstileToken` with Cloudflare siteverify before any counter, link or email. It sends the secret, the token and the `CF-Connecting-IP` address, waits at most 5 seconds and fails closed. It accepts only `success: true`; a hostname that siteverify reports must equal the host of `TALISMAN_PUBLIC_ORIGIN` (or `TALISMAN_COMMERCE_PUBLIC_ORIGIN`), and a reported action must be `shopper-sign-in`. Cloudflare's published test secret keys skip those two comparisons and are accepted only while the public origin is a local development host (`localhost`, `127.0.0.1`, `[::1]`, or a name ending in `.localhost` or `.test`). A missing or failed check answers HTTP 403 `{ "error": "The security check failed. Please try again." }` and logs `[commerce] Email sign-in bot check refused` with a code (`missing_token`, `rejected`, `unavailable`, `hostname_mismatch`, `action_mismatch` or `test_key`) and Cloudflare's error codes. A secret without a site key answers 503 "Email sign-in is unavailable" and logs `[commerce] Email sign-in bot check is not configured` with `turnstile_site_key_missing`; a site key without the secret turns nothing on.

The storefront renders the widget when `shopperSignInBotCheck(env)` returns `{ provider: 'turnstile', siteKey, action }` (it returns `null` unless both keys are set), with that `action`, and sends the token with `requestCustomerEmailSignIn(email, { turnstileToken })` from `@talisman-cms/plugin-ecommerce/browser`. Reset the widget after each attempt, since a token can be verified once. Create the widget in Managed mode for the storefront's hostname. The Cloudflare rate limiting rule on `/api/ecommerce/account` (see [Basket limits](#basket-limits)) stays as defence in depth.

## Referral credit

`@talisman-cms/plugin-ecommerce/referrals` issues a random code for a shopper account while referrals are on and exposes a read-only balance and activity view. A storefront can use `findReferralCode` to validate a share link and save it in an HTTP-only `talisman-referral` cookie. The public checkout route reads that cookie; callers cannot set the referral on a payment directly. The rules:

- **Off by default.** Referrals run only when an administrator saves a policy that enables them or, while nothing is saved, `TALISMAN_COMMERCE_REFERRALS_ENABLED` is `true`. A saved policy wins over the Worker setting in both directions.
- **Terms.** By default a qualifying first order of at least 5000 earns 1000 of credit for the referrer and for the new shopper, both in the store currency's minor units ($50 and $10 in USD). The reward may be at most half the minimum first order. The admin refuses to enable a larger reward, and terms from Worker settings or an older saved row that break the rule pause new referrals; `termsError` says why.
- **First purchase.** A referral is attributed to a paid Stripe order whose subtotal less the promotion discount reaches the minimum, when neither the buyer's account nor any of its addresses has an earlier paid, fulfilled, refunded or disputed order (admin test orders do not count). A shopper who signed up or asked for a sign-in link first still qualifies, as a guest or signed in. When two checkouts by the same shopper overlap, only the first one paid is attributed.
- **Self-referral.** The buyer must not be the referrer. Addresses are compared exactly and in canonical form: lowercased and trimmed, a `+suffix` dropped on every domain, and for `gmail.com` and `googlemail.com` dots dropped and the domain treated as `gmail.com` (`canonicalEmail`). The checkout email, the signed-in account's email and the payment provider's email are compared with the referrer's address and with earlier purchasers, at checkout and again at payment.
- **Cap.** Payment records a referral only while the referrer has fewer than `TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD` (default 10) approved referrals created within `TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS` (default 30). Referrer accounts whose addresses share a canonical form share one cap, and a voided referral frees its place.
- **Hold and release.** Payment records the referral as pending and credits nothing. After `TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS` (default 30) the scheduled `reconcileCommerce`, or `releaseReferralAwards(options, { now, limit })`, releases the award: the referrer gets a `referral_award` and the new shopper a `welcome_award`, once each, whether or not new referrals are still enabled. An open dispute keeps the award pending: one recorded on the order as `disputed`, or one the payment provider reports. So does a Stripe order while no Stripe adapter is passed, since only the adapter can report disputes. Pending awards are not spendable.
- **Reversal.** An order keeps its referral while it is paid, fulfilled, partially refunded or disputed and its net amount (subtotal less the promotion discount, provider refunds and gift card refunds) reaches both twice the award's reward and the current minimum order, counted only up to what the order qualified with at checkout. A provider refund, full or partial, or a gift card tender refund that takes the order below that amount voids the referral and reverses released awards once (`referral_reversal`, `welcome_reversal`). So does a lost dispute (`charge.dispute.closed` with status `lost`). A refund that leaves enough paid changes nothing, and changing the terms alone never voids or reverses an award. Shipping and tax count toward neither the minimum nor the net amount, and a refund counts in full against the items even when it returned shipping or tax. Gift-card-only orders are never attributed.

`getReferralPolicy(env)` (and `referralPolicy(env)` for the Worker settings alone) returns `{ enabled, switchedOn, termsError, source, rewardCents, minOrderCents, attributionDays, holdDays, maxPerPeriod, periodDays }`. `enabled` means new referrals are attributed: the switch is on and the terms are valid. `switchedOn` is the switch as saved, or as the Worker setting gives it; `source` is `'saved'` or `'settings'`; the hold, cap and period always come from Worker settings. `getReferralDashboard(env, accountId)` returns `code`, which is `null` while referrals are off and the shopper has none (no code is created then; an existing one is still returned), `codeActive`, `creditBalance` (spendable ledger credit, without pending awards), `activity`, and `earned`: the awards the account earned as a referrer, each with `state` (`'pending'`, `'released'` or `'void'`) and `releasesAt`, the earliest release date of a pending award. `earned` does not list the shopper's own welcome award.

An administrator can manage referral availability, the reward, minimum first order, 1–90 day link lifetime, and individual shopper links through the protected promotions API. The **Promotions** screen shows whether saved or Worker settings apply, any terms error, and the hold, cap and period as read-only values. Saved settings override the `TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS` and `TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS` Worker defaults; settings can be saved with the switch off whatever the terms. The applicable reward is saved on the pending order so a later config change cannot alter its payout. The threshold applies to the first paid purchase's subtotal less the promotion discount; a smaller first purchase does not qualify later orders. Local $1 test catalog items need a lower local threshold, and a reward at most half of it, if you want to exercise referrals through Stripe test mode.

The order records `subtotal_amount` (items), `discount_amount` (code), `credit_applied` (shopper balance), `shipping_amount`, `tax_amount`, `total_amount` (Stripe charge), `payment_intent_id`, and cumulative `provider_refunded_cents` (see [Order totals](#order-totals)). An immutable `_ecommerce_credit_ledger` records each award, checkout reservation, release, and refund reversal; a database trigger updates the shopper's balance. A checkout reserves at most the available balance, uses credit for items only, and leaves at least Stripe's minimum charge for the currency to pay (`minimumChargeAmount`, 50 cents in USD). Stripe receives the combined promotion and store credit as an exact fixed coupon (see [Single-use checkout coupons](#single-use-checkout-coupons)). Its signed paid webhook must confirm the reduced `total_amount`; the reservation then remains spent. Cancellation restores credit once. A full provider refund, or a lost dispute, restores any credit used on that order. If a released award was already spent when a refund reverses it, the account balance can go negative; later awards offset the adjustment before credit can be used again.

## Discount codes and credit vouchers

The protected `GET` and `POST /admin/api/ecommerce/promotions` endpoint provides validated administration of referral settings and discount codes. The CMS screen is at `/admin/extensions/commerce-promotions`. Administrators can create codes, edit descriptions, dates, use limits, and active status, and pause shopper referral links. Financial terms, product scope, and code type are fixed at creation; pause an old code and create a new one to change those terms. Commerce collections for policies, codes, redemptions, and the credit ledger are read-only audit views.

- **Amount:** a fixed amount off each eligible order, in the store currency.
- **Percent:** a percentage in basis points, with an optional cap in the store currency.
- **Credit voucher:** a server-generated, random bearer code with a remaining balance in the store currency; partial redemptions carry forward to later orders.

Codes can specify a minimum item subtotal, eligible product IDs, first-purchase eligibility, start and expiry times, total uses, and uses per shopper. A first-purchase code is refused once the shopper's email or account has a paid, fulfilled, refunded or disputed order (admin test orders do not count), or while another first-purchase code is reserved for that email; signing up does not count as a purchase. One code can be used per order and it can combine with the shopper's earned store credit. The checkout server computes the discount from current product prices, then applies shopper credit, leaving at least Stripe's minimum charge for the currency to pay. Its D1 transaction reserves code usage, voucher balance, store credit, inventory, and the pending order together. A cancelled checkout releases all reservations. A verified paid webhook confirms the code use once. A full refund, or a lost dispute, releases its use and restores voucher balance; a partial refund leaves the code use confirmed until fully refunded. The percentage and fixed offers are discounts, not cash balances.

### Discount preview

`POST /api/ecommerce/discount` with `{ "code": "...", "giftCardCode": "..." }` prices a discount code, a gift card or both against the shopper's basket, only while checkout is enabled. It checks, in order: the checkout flag (503 "Checkout is disabled"), same origin (403), and the body (400 "Enter a discount or gift card code"), and before it reads the basket, the [store settings](#store-settings) (503 "Checkout is temporarily unavailable."). Codes may be up to 200 characters. The answer's `creditApplied` and `cardAmount` leave out shipping and tax, which depend on the destination.

- **Limits.** The preview and every checkout that carries a `discountCode` or `giftCardCode`, through the route or the `checkout` action, share one code-check budget: 30 per client network (an IPv4 address or an IPv6 /64, from `CF-Connecting-IP`) and 10 per basket per hour, in fixed one-hour windows in `_ecommerce_rate_limits`. Over either limit the routes answer HTTP 429 `{ "error": "Too many code checks. Please try again later." }` and the action throws `ActionError` `TOO_MANY_REQUESTS`. A checkout without a code is not counted. Without a client IP, as in local development, only the basket limit applies. The limits are code constants, not settings; handle a 429 from checkout as well as from the preview.
- **One refusal.** Every refusal of an entered code, in the preview and at checkout, answers HTTP 409 `{ "error": "This code is not valid for this order.", "field": "code" }` (or `"field": "giftCardCode"`), including one used up while the order is reserved, and in the preview a code of the wrong shape. At checkout, a discount code over 32 characters or a gift card code over 37 fails input validation first: the route answers HTTP 400 "Invalid checkout details" and the action an input validation error. The `checkout` action throws `ActionError` `CONFLICT` with the same message. The reason stays on the server in `DiscountCodeRefusal` and `GiftCardRefusal`, which carry a reason code; `codeRefusalBody(error)` from `/promotions` maps them to the shopper-facing body, and `evaluateDiscountCode` and `evaluateGiftCard` keep their detailed messages for other callers.
- **What it decides from.** The preview uses only the basket and the signed-in shopper's own account. It accepts `customerEmail` but ignores it. First-order and per-customer rules are checked in the preview only for a signed-in shopper, against that account; for a guest they are checked at checkout with the checkout email, so a guest's preview can show a price for a code that checkout then refuses. The preview links a browser basket to a signed-in account like the cart route, and never creates a basket: 404 "Basket not found" without a basket cookie, and 409 "Basket is not available for discounts" for a missing, empty or locked basket.

Item prices, credit balances, discount values and Stripe coupons are amounts in the store currency's minor units (see [Money in minor units](#money-in-minor-units)). Credit balances and discount values carry no currency of their own, so keep the store currency once they exist; selling in several currencies would need a separate balance and ledger per currency. Read-only Commerce collections expose referral codes, qualified referrals, and credit entries to administrators for reconciliation. Migrate the database before deploying code that reads these tables or fields.

## Gift cards

Purchased gift cards are separate from discounts and account referral credit. They are kept in USD only, so they work only in a store whose currency is USD (see [Limits](#limits)). `POST /api/ecommerce/gift-cards` starts a standalone Stripe purchase for $5–$1,000 USD. A card is issued only after a signed, paid Checkout webhook matches the pending purchase amount, currency, and session. Duplicate webhooks cannot issue twice. The buyer is emailed a one-time link that shows the code (see [Gift card claim links](#gift-card-claim-links)), and can also return to `/gift-cards/success` in the same browser to copy it while the seven-day buyer access cookie lasts. The code is stored as a SHA-256 lookup hash plus an AES-GCM encrypted copy tied to the card, using the required `TALISMAN_COMMERCE_GIFT_CARD_KEY` secret (64 hex characters). Keep that key, and any previous keys, backed up, or previously purchased codes cannot be displayed again; [Key rotation](#key-rotation) describes how to change it.

Set `TALISMAN_COMMERCE_GIFT_CARDS_ENABLED=true` only after configuring the encryption key, Stripe secrets, signed webhook, and migration. Talisman offers purchase and code-based balance lookup at `/gift-cards`; the shared CMS administration screen is at `/admin/extensions/commerce-gift-cards`. Admins can issue a card with an audit reason, replace a purchased card, suspend and reactivate cards, resend claim links, refund gift card tender in part, and fully refund orders paid without Stripe. A provider refund settles a purchase at once when it is refunded in full and its cards were never spent; otherwise it holds the purchase for an administrator's decision (see [Gift card refunds and review](#gift-card-refunds-and-review)). The admin API exposes only a card's code suffix and balance. Admin-issued codes are shown once in the issuance response.

Checkout accepts one gift card alongside one promotion code and earned shopper credit. The order records each source separately: `subtotal_amount + shipping_amount + tax_amount (when exclusive) = discount_amount + credit_applied + gift_card_applied + total_amount`. A gift card is a means of payment, so it can pay for shipping and tax too and never lowers the taxed amount. D1 triggers reserve gift card balance with the pending order and release it on cancellation or refund. A card that covers the remaining total can settle an order without a Stripe session. For a split payment, the existing Stripe Checkout adapter uses a single-use coupon to charge the card remainder; the internal order and ledgers retain the distinct promotion, credit, gift card, and provider amounts. Full provider refunds restore any gift card amount not already restored by an admin partial refund.

### Gift card claim links

When a purchase is paid, its buyer is emailed a one-time link, valid for 7 days, to `/gift-cards/claim#token=...` on the public origin. The token is in the URL fragment, so it never reaches the server or its logs, and only its SHA-256 hash is stored, in `_ecommerce_gift_card_claims` (migration `0030`, the read-only **Gift Card Claim Links** collection). The link is made when the email is sent and revoked if the send fails, so every email carries a new one. The storefront serves `/gift-cards/claim`: it reads the token with `readGiftCardClaimToken()` from `/browser`, which also removes it from the address bar, and calls `claimGiftCardCode(token)` only when the shopper asks to see the code, so a link scanner that opens the page does not use it up. That request, `POST /api/ecommerce/gift-cards` with `{ "action": "claim", "token": "..." }`, answers the code, balance and currency once. A used, expired, revoked or unknown link, and one whose card is no longer active, gets HTTP 400 "This gift card link has already been used or has expired. Ask the store to send a new one." Claims are limited to 20 per client network per hour (HTTP 429), and a key or database problem answers 503 and leaves the link unused. `claimGiftCardCode` rejects with the server's message, `status` (0 when the connection failed) and `retryable`, which is true while the link was not used (a failed connection, 429 or 5xx), so the page can offer another try; otherwise the page explains how to get a new link. Claims work while checkout is disabled, since the card was already paid for, and the `/gift-cards/success` page keeps working in the paying browser.

The **Gift cards** screen shows each card's purchase id, buyer email, newest claim link (one the buyer can still use comes first) and claim email status. **Resend claim link** emails a new link for the card that holds the purchase's value, with a reason of 8–500 characters that the link records with the administrator: `{ "action": "resendClaimLink", "data": { "purchaseId": "gp_...", "reason": "..." } }` on `/admin/api/ecommerce/gift-cards-admin`, or `resendGiftCardClaimLink(env, actor, input)` from `/gift-cards`. Only once its email is sent do the purchase's earlier unused links stop working and a claim email still waiting for a retry get cancelled (`superseded`). A resend that fails changes nothing else: earlier links keep working, the automatic email keeps its retries, and the error says so. A resend is refused while the automatic claim email is being sent, and while the card is not active.

### Gift card refunds and review

A Stripe refund of a gift card purchase holds the purchase for review at each new refund total, a resolved one included: its status becomes `review`, and every active card it funds, replacements included, is suspended and marked as held. A purchase refunded in full whose cards were never spent on an order is settled at once: what is left on them is reversed and they are voided. A purchase with no card left closes as `refunded` or `partially_refunded`, and a void card stays void.

The **Gift cards** screen lists held purchases under **Held for review**: the amount, what was refunded and how much of it is already taken off the cards, the card that holds the purchase's value (its suffix, status and balance, and whether it is a replacement), what was spent on orders, what checkouts in progress hold, and the replacements issued. An administrator decides with a reason of 8–500 characters and a confirmation:

- **Reinstate** takes the refund not yet taken off from the card that holds the purchase's value, as a `purchase_reversal` ledger entry, and lifts the hold: the cards the hold suspended become active again, and a card an administrator suspended stays suspended. The card's balance must cover the refund.
- **Void** voids the purchase's cards and reverses what is left on them. It cannot be undone, and waits while a checkout in progress holds value on the cards.

Either way the purchase becomes `partially_refunded` or `refunded` by its refund total, and `_ecommerce_gift_card_reviews` (the read-only **Gift Card Reviews** collection) records who decided, why and the amounts. The API is `{ "action": "resolveReview", "data": { "purchaseId": "gp_...", "outcome": "reinstate" | "void", "reason": "...", "refundedCents": 500 } }` on `/admin/api/ecommerce/gift-cards-admin`, or `resolveGiftCardReview(env, actor, input)` from `/gift-cards`. `refundedCents` is the refund total the administrator saw: if a refund was recorded since, the action fails and changes nothing. A purchase held by an open payment dispute is left out of the list and cannot be resolved until the dispute closes (see [Refunds, disputes and restock](#refunds-disputes-and-restock)). Suspending a card is always possible; reactivating a purchased card or a replacement needs its purchase paid or resolved, so it is refused while the purchase is held. Cards that earlier releases suspended for a refund are not marked as held, so Reinstate leaves them suspended; reactivate them under **Issued cards**. `giftCardPurchaseHoldStatements(env, purchaseId, timestamp)` from `/gift-cards` applies a purchase's hold to every card it funds, for code that holds a purchase in the same batch as its own change.

### Replacement cards

A card that support issues in place of a purchased one, for example after its code was lost, names the purchase: enter its id under **Replaces purchase** when issuing a card, or pass `replacesPurchaseId` to `issueAdminGiftCard(env, actor, { amountCents, reason, replacesPurchaseId })`. Its amount must equal what is left on the purchase's cards, which are emptied and voided in the same batch, so the lost code and its claim links stop working and a purchase never funds two spendable cards; the old card need not be suspended first. A replacement is issued only for a paid purchase, or a partially refunded one with nothing left to decide, and only while no checkout in progress holds value on its cards. A later refund of the purchase holds the replacement too, and `getPurchasedGiftCard` no longer shows the code of the card that was replaced. Resend the claim link from the replacement's row to email the buyer its code. Goodwill on top of the value left needs a separate card without `replacesPurchaseId`.

### Key rotation

Codes are stored as `v2:<key id>:<iv>:<ciphertext>`: AES-GCM under `TALISMAN_COMMERCE_GIFT_CARD_KEY`, with the card id as additional data, so a ciphertext copied to another card does not decrypt. The key id is the first 16 hex characters of the SHA-256 of the key's bytes, so rotation needs no id setting. Codes stored before key ids, as `<iv>:<ciphertext>`, stay readable with the current or a previous key. To rotate the key:

1. Generate a key with `openssl rand -hex 32`.
2. Set it as `TALISMAN_COMMERCE_GIFT_CARD_KEY` and add the current key to `TALISMAN_COMMERCE_GIFT_CARD_PREVIOUS_KEYS`, a comma-separated list, in one secrets update, or add the current key to the list before you replace it.
3. The **Code encryption** panel of the **Gift cards** screen shows the current key id (check it with `printf '%s' "$KEY" | xxd -r -p | shasum -a 256 | cut -c1-16`) and counts the codes stored under a previous key and those without a key id. **Re-encrypt with the current key** moves them to the current key; so does calling `reencryptGiftCardCodes(env, { after, limit })` from `/gift-cards` until its `next` is `null`. Codes that no configured key decrypts are listed in `failed` and left as they are. `getGiftCardKeyStatus(env)` returns the key id and the counts.
4. Remove a previous key once nothing needs it, and keep a backup of every retired key for as long as a D1 Time Travel restore could bring back rows encrypted with it.

A lost key only stops codes from being shown; balances and redemption use the code hashes. A malformed previous key makes gift card purchases refuse before payment. A Worker from before this release cannot show a code issued or re-encrypted in the new format, so re-encrypt older codes only once a rollback is no longer planned.

### Single-use checkout coupons

Each discounted Stripe checkout (a promotion, store credit or gift card applied) creates one coupon with the id `<order id>_discount` (`checkoutCouponId(orderId)` from `@talisman-cms/plugin-ecommerce/adapters/stripe`), `max_redemptions: 1` and `redeem_by` at the session's `expires_at`. Checkout Sessions for plugin orders last 31 minutes, because Stripe needs at least 30 minutes after creation and the coupon is created first. The coupon is deleted when its order is cancelled (by the `checkout.session.expired` webhook, by reconciliation, or by a shopper or admin cancel), when a session expires for an order that was never recorded, and when checkout fails after the session was requested. Deletion is best effort: a failure logs `[commerce] Checkout discount could not be discarded` with the provider, error name and code, and never blocks releasing stock, credit, gift card or promotion reservations; the coupon still cannot be redeemed after its `redeem_by`. Coupons created by earlier versions have random ids and are not deleted automatically; unused ones can be deleted in the Stripe dashboard.

Gift card purchases cannot use promotions, gift cards, or referral credit, which prevents circular funding. They are not taxed: tax applies when a card pays for an order. Gift cards and their purchases are in USD only. Sending a card to a recipient other than the buyer, multiple gift cards on one order, and market-specific tax treatment of gift card sales are outside this implementation.

## Admin test checkout

The admin test checkout is off by default. Enable it with `ecommercePlugin({ adminTestCheckout: true })` on a site whose administrators need to exercise checkout without charging a card. It adds the **Test checkout** screen and the protected `/admin/api/ecommerce/test-checkout` route. Without the option, neither is injected and the simulated provider is never registered.

The `admin_test` adapter simulates a successful payment without contacting Stripe. The protected `GET /admin/api/ecommerce/test-checkout` returns the current basket quote for the CMS screen. `POST` requires a Talisman CMS administrator, a same-origin request, and the current basket cookie. It uses the same product validation, basket lock, order creation, and payment finalization as Stripe checkout. Orders and payment rows identify `admin_test` as the provider. No card is charged, sellable stock is not reduced, and test orders cannot be fulfilled. The endpoint works even when public Stripe checkout is disabled.

`PaymentProviderAdapter` handles provider session creation, expiry, and optional webhook validation. Four optional methods support the rules above: `getDisputeStatus(paymentIntentId)` returns `'none'`, `'open'` or `'lost'`, and referral awards are released only after it answers `'none'`; `discardCheckoutDiscount(orderId)` deletes the provider-side discount of an expired or cancelled checkout and resolves when there is nothing to delete; `getRefundStatus(paymentIntentId)` returns `'none'`, `'partial'` or `'full'`, so that an administrator can release a parked checkout whose payment was refunded; and `getPaymentReferences(paymentIntentId)` returns the `{ orderId, giftCardPurchaseId }` a payment carries, or `null`, for dispute events. `StripePaymentAdapter` implements all four. `createFromCart` selects an adapter by `providerId` and stores that choice on the order; cancellation and resumption use the stored provider. Without a `providerId` it uses the only registered adapter, but never `admin_test`. A second real payment provider can be registered alongside Stripe, but it still needs its own authenticated webhook route and shopper checkout route or provider selector. `runtimePaymentAdapters(env)` returns only real providers (Stripe when configured). The admin test route adds `AdminTestPaymentAdapter` itself, and the public checkout route and action always request `stripe`. Public order status checks never settle a pending `admin_test` order. Placing the test order again from the same basket completes an interrupted one, and the basket's owner can cancel it with `cancelCheckout`. Unless the caller registered `AdminTestPaymentAdapter`, `reconcileCommerce` cancels one left pending for 15 minutes, which unlocks the basket, and it keeps reconciling the real orders behind it. Never register it for a public route. Test orders include the store's shipping charge but are never taxed.

`createCheckoutSession` receives the order's `currency`, a lowercase ISO 4217 code in which the provider must charge and in no other, and, when they apply, the order's `shipping` (`{ label, amount, description? }`) and exclusive `tax` (`{ amount }`). The provider charges the items plus a shipping and tax amount above 0, less `creditApplied`, `discountApplied` and `giftCardApplied`; a payment of any other amount or currency does not confirm the order. Three optional methods take part in [tax](#tax): `calculateTax(params)` takes `TaxCalculationParams` and returns a `TaxCalculation` `{ id, amountTotal, taxAmountExclusive, taxAmountInclusive }`, rejecting with `TaxAddressError` when it cannot place the address; `recordTaxTransaction({ orderId, calculationId })` returns `{ transactionId }`; and `reverseTaxTransaction({ orderId, transactionId, amount, reference })` returns `{ reversalId }`, where `amount` is positive and tax included and `reference` names that reversal only. A provider without all three cannot take orders while a tax mode is set. `StripePaymentAdapter` implements them with Stripe Tax calculations, transactions created from the calculation with the order id as reference and `tax-transaction:<order id>` as idempotency key, and partial reversals with a negative `flat_amount` and the reference as idempotency key.

Products must be active, have a positive price, and have available stock before checkout. For physical products, the checkout request must include a shipping address with name, line 1, city, postal code, and a two-letter country code the store delivers to. Without `TALISMAN_COMMERCE_SHIPPING_RATES`, shipping is included in the item price. Configure the store settings, shipping policy, refunds, and fulfillment before enabling live sales.

## Shared component inventory

The commerce plugin can stock physical components that are used by more than one sellable variant.

1. Create one **Product** for each frame model. Its `sku` is the model SKU.
2. Create a **Product Variant Value** for each sellable frame and lens choice. Its `sku` identifies that finished choice.
3. Create **Shared Components** for physical stock, such as a frame body and a lens pair. Each component has its own SKU and available quantity.
4. Add **Variant Components** rows for every part consumed by each variant value. For example, Mycelium + Golden Hour can consume one Mycelium frame and one Golden Hour lens pair; another frame model can consume a different frame component and the **same** lens component.

When a variant value has component rows, checkout uses its component quantities instead of its dedicated stock row. Include **all** physical parts in the bill of materials for that choice. A variant value with no component rows keeps the existing dedicated stock behavior. A component quantity is measured in the units of that component SKU: if a lens component SKU represents a pair, set its units per item to `1`. Deleting a variant value or group in the product editor also deletes its variant component rows; the shared components stay.

Checkout sums component demand across the entire cart and reserves it in an atomic D1 batch with the pending order. A paid order keeps that reservation as consumed stock. Cancelling an order expires its open payment session before returning the stock; an expired Stripe Checkout session also returns it through the webhook. Cancellation restores the same persisted cart so the customer can edit it and try again. Configure Stripe's `checkout.session.expired` webhook event when using Stripe. A preparation lock left by an interrupted Worker request is released after 35 minutes only if no pending order exists, beyond the configured 31-minute Stripe session lifetime.

The current commerce plugin has one shopper-selectable variant value per cart line. Multi-axis options such as frame finish, size, and lens tint must be represented as distinct sellable values until a multi-option configurator is added. Shared components keep stock pooled even when those values belong to different products.
