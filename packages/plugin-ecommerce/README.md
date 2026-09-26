# @talisman-cms/plugin-ecommerce

Commerce for Talisman CMS: a product catalog in D1, a cookie-keyed basket, hosted Stripe Checkout, shopper accounts, promotions, gift cards and order fulfillment. It all runs in the site's own Cloudflare Worker. Public checkout is off until you enable it; read [PRODUCTION_READINESS.md](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-ecommerce/PRODUCTION_READINESS.md) before taking live orders. Prices, credit and payments are in one store currency, USD unless `TALISMAN_COMMERCE_CURRENCY` sets another, and the store's delivery countries, shipping rates and Stripe Tax mode are Worker settings too; see [Currency, delivery, shipping and tax](#currency-delivery-shipping-and-tax).

## Quick start

### 1. Install

```bash
pnpm add talisman-cms @talisman-cms/plugin-ecommerce @astrojs/cloudflare react react-dom @tanstack/react-router drizzle-orm
pnpm add -D wrangler
```

`react`, `react-dom`, `@tanstack/react-router` and `drizzle-orm` are peer dependencies. The commerce admin screens run inside the CMS admin with the app's copies, so list them in the app's own `package.json`.

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
| `injectCollections` | `true` | Registers the native commerce tables (variants, stock, carts, orders, shoppers, promotions, gift cards) as admin-only collections under **Commerce**. With `false` the tables still exist but are hidden from the admin. |
| `adminPages` | none | Same-origin overrides for the Orders, Promotions, Gift cards and Test checkout links. |
| `adminTestCheckout` | `false` | Adds the admin-only **Test checkout** screen and `/admin/api/ecommerce/test-checkout`, which place orders with a simulated payment. See [Admin test checkout](#admin-test-checkout). |

### 3. Bindings and migrations

The plugin uses the CMS's Worker bindings (see the Talisman CMS README): `DB` (D1, required) holds the commerce tables, and `EMAIL` (a `[[send_email]]` binding) sends shopper sign-in links. It adds no binding of its own.

The commerce tables are created by the migrations that ship in `talisman-cms`, not in this package. With `migrations_dir = "node_modules/talisman-cms/drizzle"` on the `DB` binding, apply every migration in that folder before deploying the Worker:

```bash
pnpm exec wrangler d1 migrations apply DB --local   # local development
pnpm exec wrangler d1 migrations apply DB --remote  # production database
```

The plugin needs at least `0025_order_shipping_and_tax.sql`: shopper account reads fail without `0019`, shopper sign-in fails without `0024`, and every order read fails without `0025`, whose shipping and tax columns the plugin's `orders` table names. Run the duplicate checks under [Hosted Stripe checkout](#hosted-stripe-checkout) first when upgrading an existing database.

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
| `TALISMAN_COMMERCE_REFERRALS_ENABLED` | off | `true` turns new referral attribution on while no referral settings are saved in the admin. A saved policy wins in both directions. See [Referral credit](#referral-credit). |
| `TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS`, `TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS` | `1000`, `5000` | Referral terms until an admin saves referral settings, in the store currency's minor units despite their names. The reward must be at most half the minimum, or new referrals are paused. |
| `TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS` | `30` | Days after payment that referral awards stay pending before the scheduled job may release them (1–365). |
| `TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD`, `TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS` | `10`, `30` | The most approved referrals one referrer can have recorded within the rolling period (1–10000, and 1–365 days). |
| `TALISMAN_EMAIL_FROM`, `TALISMAN_PUBLIC_ORIGIN` | none | Sender and storefront origin for sign-in links. `TALISMAN_COMMERCE_EMAIL_FROM` and `TALISMAN_COMMERCE_PUBLIC_ORIGIN` override them for shopper mail. |
| `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` | `200` | Store-wide cap on sign-in emails per 24 hours. |
| `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` | a quarter of the limit | The part of the daily cap kept for addresses with a verified account or a purchased order. A whole number from 0 to the limit minus 1. |
| `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY`, `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` | none | Cloudflare Turnstile keys for the sign-in bot check. The site key is public; the secret is a Worker secret. Set both or neither. See [Sign-in email limits and bot check](#sign-in-email-limits-and-bot-check). |

Deployments configured before the rename can keep the `GALAXY_` names of these settings; a `GALAXY_` value is read when the `TALISMAN_` one is missing or blank. A number setting that is blank or not a whole number in its range means its default. The currency, delivery, shipping and tax settings are stricter: blank means unset, but any other invalid value closes checkout with HTTP 503 until it is fixed (see [Store settings](#store-settings)).

### 5. Storefront pages

The plugin injects the API routes below; the site renders its own pages. Stripe returns shoppers to `/checkout/success?order=<id>` and `/checkout/cancel?order=<id>` on the request origin, so provide both. Email sign-in links open `/account/verify`, gift card buyers return to `/gift-cards/success`, and `CartView` links to `/shop`, `/checkout` and `/checkout/cancel`.

| Route | Access | Purpose |
| --- | --- | --- |
| `GET`, `POST /api/ecommerce/cart` | public | Read or replace the basket. New baskets are limited per client network. See [Basket limits](#basket-limits). |
| `POST /api/ecommerce/checkout` | public, enable flag | Start or resume hosted Stripe Checkout from the shopper's open basket. |
| `POST /api/ecommerce/discount` | public, enable flag | Preview a discount or gift card code against the basket, within a code-check budget. See [Discount preview](#discount-preview). |
| `GET`, `POST /api/ecommerce/order` | the placing basket or account | Order status, or release an open payment session. |
| `POST /api/ecommerce/webhooks/stripe` | Stripe-signed | Payment completion, expiry, refunds and disputes. |
| `/api/ecommerce/account`, `/api/ecommerce/gift-cards` | public | Shopper sign-in, gift card purchase and balance. |
| `/admin/api/ecommerce/fulfillment`, `reconcile`, `promotions`, `gift-cards-admin` | CMS admin | The commerce admin screens. `test-checkout` is added with `adminTestCheckout: true`. |

### 6. Components and helpers

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
- The package root, for server code: besides `ecommercePlugin`, `bindCommerceApi`, `reconcileCommerce`, the payment adapters and the `PaymentProviderAdapter` type, it exports `readStoreSettings`, `readStoreCurrency`, `StoreSettingsError`, `shippingOptionsFor`, `COUNTRY_CODES`, `isCountryCode`, the money helpers, `TaxCalculationError`, `TaxAddressError` and the types `StoreSettings`, `ShippingRate`, `TaxSettings`, `ShippingOption`, `TaxCalculation` and `TaxCalculationParams`. See [Currency, delivery, shipping and tax](#currency-delivery-shipping-and-tax).
- `@talisman-cms/plugin-ecommerce/browser`: `startCheckout`, `getOrderStatus`, `cancelCheckout`, the shopper account helpers (`requestCustomerEmailSignIn(email, { turnstileToken })`, `readCustomerSignInToken`, `previewCustomerSignIn`, `verifyCustomerEmailSignIn`, `getCustomerAccount`, `signOutCustomerAccount` and `chooseCustomerBasket`), `CART_UPDATED_EVENT` and `dispatchCartUpdated`. `startAdminTestCheckout(input, { adminPath })` needs `adminTestCheckout: true`; pass `adminPath` when the CMS is not at `/admin`.
- `@talisman-cms/plugin-ecommerce/cookies`: the basket and gift card cookie names, `readCartSessionToken` and `ensureCartSession`.
- `@talisman-cms/plugin-ecommerce/actions`: the `getCart`, `addToCart`, `clearCart` and `checkout` Astro actions. `addToCart` and `checkout` throw `ActionError` `TOO_MANY_REQUESTS` over the basket and code-check limits.
- `@talisman-cms/plugin-ecommerce/accounts`: server helpers for shopper sign-in, including `requestCustomerEmailSignIn`, `shopperSignInBotCheck(env)` and `normalizeShopperEmail`.
- `@talisman-cms/plugin-ecommerce/referrals`: referral helpers, including `getReferralPolicy`, `getReferralDashboard`, `findReferralCode`, `releaseReferralAwards`, `reverseReferralForOrder`, `referralTermsError`, `referralNetAmount`, `referralOrderQualifies`, `referralReversalStatements` and `canonicalEmail`, the defaults `REFERRAL_HOLD_DAYS`, `REFERRAL_MAX_PER_PERIOD` and `REFERRAL_PERIOD_DAYS`, and the types `ReferralPolicy`, `ReferralDashboard` and `ReferralReleaseResult`. See [Referral credit](#referral-credit).
- `@talisman-cms/plugin-ecommerce/api`: `bindCommerceApi({ env, paymentAdapters })`, `reconcileCommerce` and `purgeStaleCommerceData` for server code and the scheduled Worker, and `TaxCalculationError`.

The components use Tailwind utility classes, including `brand-*` colors, and `CartBadge` reads Worker bindings from `cloudflare:workers`. Code that only renders must read a basket with `api.carts.find`, never `api.carts.getOrCreate`: `getOrCreate` creates a basket for a new token and moves a signed-in shopper's basket to it.

### Basket limits

A basket holds at most 50 lines (`CART_MAX_LINES`) of 1 to 99 units each (`CART_MAX_LINE_QUANTITY`); `bindCommerceApi().carts.updateItems` enforces this for every caller. The cart route answers HTTP 413 to a request body over 64 KB and HTTP 400 to other violations; the actions answer `BAD_REQUEST`. A line must name a product in `_ecommerce_products` that is not archived, so draft products can go in a concept basket. Its `variantId` must be a variant value of that product, or a legacy variant group of it (a group with no values). A product that has variant groups is sold only as one of its variants: a line without a `variantId`, or naming a group that has values, is refused ("Cart items must choose one of the variants of ..."), and the quote and checkout refuse such a line saved earlier with "Select an option for ..." (HTTP 409 from the checkout route), before anything is reserved. Lines already in the basket are not checked again, so a shopper can still change or remove a product that was archived later. Only `productId`, `variantId` and `quantity` are stored. A rejected request creates no basket and sets no cookie, and reading never creates one.

Creating a basket is limited to 20 new baskets per client network per hour (`NEW_BASKETS_PER_NETWORK_PER_HOUR`); a client network is an IPv4 address or an IPv6 /64, taken from `CF-Connecting-IP`. The cart route and the `addToCart` action share the limit, and count only a request that creates a basket, after its items pass validation. Over the limit the route answers HTTP 429 `{ "error": "Too many new baskets. Please try again later." }` with `Retry-After: 3600`, the action throws `ActionError` `TOO_MANY_REQUESTS`, and neither writes a basket row or cookie; show the message to the shopper. Changes to an open basket, reads, and emptying a basket that does not exist are never counted or refused. A request without a client IP, as in local development, is not limited. The checkout route and action use only an existing open basket and never create one.

The plugin's own limits cover basket creation, code checks, sign-in email and provider checks per order from the order status route, checkout resume and session release. As defence in depth, also add a Cloudflare rate limiting rule, keyed on the client IP, for every public path under `/api/ecommerce/` except `/api/ecommerce/webhooks/` (today `account`, `cart`, `checkout`, `discount`, `gift-cards` and `order`, for every request method), and for `/_actions/*` if the site uses the plugin's Astro actions. Leave the Stripe webhook paths `/api/ecommerce/webhooks/*` and `/api/stripe/webhooks` out of every per-IP rule: Stripe sends webhooks from a small set of addresses, so a per-IP limit would drop deliveries. Launch gate 8 in [PRODUCTION_READINESS.md](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-ecommerce/PRODUCTION_READINESS.md) has the details.

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

Save the output as SQL and apply it to the same database as the CMS. Read native products through `getClient(env).entries.findMany('products')` and content through its configured collection. Native Commerce edits are visible immediately; content collections use the CMS publish action before the public site reads the new version. Source files are first-run defaults, not a live file editor.

Product image URLs are stored as a string array. The Commerce editor presents each URL as a media row and converts it back to a string on save.

## Commerce admin workspace

The plugin groups native records under **Commerce**: products and catalog setup, shoppers and carts, promotions and referrals, gift card activity, and audit records. It also provides task-focused screens inside the Talisman CMS admin shell: orders and fulfillment, promotions, and gift cards. Registering `ecommercePlugin()` adds them to the Commerce workspace; `ecommercePlugin({ adminTestCheckout: true })` adds the Test checkout screen as well. The site still provides its public storefront, basket, checkout, and account pages.

```js
ecommercePlugin()
```

The default paths are `/admin/extensions/commerce-orders`, `/admin/extensions/commerce-promotions`, and `/admin/extensions/commerce-gift-cards`, plus `/admin/extensions/commerce-test-checkout` when enabled. A store can override task links with same-origin `adminPages` paths when it has a genuinely store-specific workflow. The plugin owns the protected commerce APIs and shared operation screens. No database migration is needed for this UI change. The screens scale and format money by its currency's minor units: **Promotions** in the store currency, **Orders** in each order's currency and **Gift cards** in USD.

## Hosted Stripe checkout

`ecommercePlugin()` provides the cart, checkout, order status, and Stripe webhook routes. An app only needs to register the plugin and render its own cart and checkout pages. The separate `plugin-stripe` package handles Stripe resource sync and is not required for payments.

Apply Talisman CMS migrations through `0025_order_shipping_and_tax.sql` before deploying the plugin's Worker; shopper account reads fail without `0019`, shopper sign-in fails without `0024`, and order reads fail without `0025`. `0025` needs no check. On an existing database, these checks must return no rows first. The first guards `0018`'s unique revision index, the second `0019`, which allows one CMS user per email regardless of letter case, and the third `0023`, which allows one published entry per slug in a collection:

```sql
SELECT entry_id, revision_number, COUNT(*) AS copies
FROM galaxy_entry_revisions GROUP BY entry_id, revision_number HAVING COUNT(*) > 1;

SELECT lower(email) AS email, COUNT(*) AS copies
FROM galaxy_auth_user GROUP BY lower(email) HAVING COUNT(*) > 1;

SELECT collection_id, slug, COUNT(*) AS copies
FROM galaxy_entries WHERE status = 'published' GROUP BY collection_id, slug HAVING COUNT(*) > 1;
```

The cart lives in D1 and is keyed by a 30-day, HTTP-only, SameSite browser cookie. A cart version prevents concurrent edits from overwriting each other. Starting checkout locks the cart, creates a 31-minute hosted Stripe session, and atomically reserves component and ordinary stock before returning the payment URL. A cancelled or expired session releases stock and unlocks the same cart. A paid webhook closes the cart and records one payment even if Stripe retries the event.

Shoppers can register before buying with a passwordless email link. Asking for a link creates no account: the plugin stores the SHA-256 hash of the one-time token and the address it was sent to, and creates the account for that address, already verified, or reuses the existing one only when the link is used. After a confirmed real payment, the plugin also links the paid order and basket to a shopper account, creating one for a first-time checkout email. A signed-in shopper's order stays on their authenticated account even if they enter a different checkout email. When a shopper confirms an emailed link, the plugin links their account to the CMS's shared user identity for that email (`ensureVerifiedEmailIdentity` from `talisman-cms/auth/identity`). A new address becomes a CMS user with the `customer` role, which appears in **Users** but cannot open the CMS. An editor or admin who shops with the same address keeps one identity and their CMS role. Migration `0019` links shoppers verified before the upgrade in the same way. Shopper sessions and cookies remain separate from CMS sessions. **Payment and basket possession do not sign a shopper in.** The browser calls `requestCustomerEmailSignIn(email)` and receives a one-time link at that address. The link opens `/account/verify#token=...`: the token is in the URL fragment, so browsers never send it to the server and it stays out of request logs. The storefront's verify page calls `readCustomerSignInToken()` from `@talisman-cms/plugin-ecommerce/browser`, which reads the token, removes it from the address bar, and still accepts `?token=` links sent before this change. Before the shopper confirms, the page can call `previewCustomerSignIn(token)` to show which account the link opens (see [Sign-in link preview](#sign-in-link-preview)). The page then calls `verifyCustomerEmailSignIn(token)` when the shopper confirms. The link expires after 15 minutes and can be used once. The resulting HTTP-only shopper session lasts 30 days. `GET /api/ecommerce/account` reads the current account and `DELETE` signs out, clearing both shopper and basket cookies. An expired shopper session cannot use its old basket cookie to access an account basket. A storefront with a verified sign-up or SSO flow can pass the authenticated account ID to `api.carts.getOrCreate(sessionToken, accountId)` to attach the current guest basket. If both the guest and account baskets contain items, the API preserves them until the shopper explicitly chooses one with `chooseCustomerBasket('browser' | 'account')`.

Sign-in links are sent with the CMS email provider from `talisman-cms/email/runtime`: by default a Cloudflare Email Service `[[send_email]]` binding named `EMAIL`, or a provider registered with `talismanCms({ email })` (see the Talisman CMS README). Configure these Worker settings:

- `TALISMAN_EMAIL_PROVIDER=cloudflare` selects the binding explicitly. With the setting unset, a registered provider is used, then the `EMAIL` binding.
- `TALISMAN_EMAIL_FROM` is the sender, for example `Shop <no-reply@shop.example>`. Its display name is the shop name in the message. `TALISMAN_COMMERCE_EMAIL_FROM` overrides it for shopper mail.
- `TALISMAN_EMAIL_REPLY_TO` (optional) receives replies.
- `TALISMAN_PUBLIC_ORIGIN` is the storefront origin used in links, for example `https://shop.example`. `TALISMAN_COMMERCE_PUBLIC_ORIGIN` overrides it. It must match the request origin, which keeps links from being built from an untrusted Host header.
- `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` (optional, default 200) caps sign-in emails across the store per 24 hours, and `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` (optional) keeps part of it for existing customers. See [Sign-in email limits and bot check](#sign-in-email-limits-and-bot-check).
- `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY` and the secret `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` (optional, set together) require a Cloudflare Turnstile check before a link is sent.

The `GALAXY_` names of these settings still work. Resend is no longer built in; register it or any other HTTP email API as a custom provider. Without a provider, sender or matching origin, the account API answers HTTP 503 "Email sign-in is unavailable" and logs which part is missing. When the provider refuses a message, it answers 503 and logs the provider's error code, never the address, link or token. Every message carries `Auto-Submitted: auto-generated` so vacation responders do not reply to it. The account API returns the same accepted response for known, unknown, rate-limited and suppressed addresses. Only a bare address is accepted: one with a display name, such as `Name <shopper@example.com>`, or with a second recipient gets HTTP 400 "Valid email required", and a link always goes to exactly the lowercased address. The API limits each address to three links per ten minutes and each source IP to 20 requests per hour; IPv6 addresses count per /64 prefix. Once the general part of the daily limit is spent, every request gets HTTP 200 `{ "accepted": true, "limited": true }` until the 24-hour window ends, and only existing customers are still sent a link. These counters are kept in the plugin's `_ecommerce_rate_limits` table, apart from the rate limits of CMS sign-in, which better-auth prunes on its own schedule. The plugin sends no order, shipment or gift card email.

Migration `0016_verified_customer_sessions.sql` revokes old unverified sessions created by the previous basket-based activation flow. The old `activateNewCustomerAccount` helper no longer grants access. Migration `0024_shopper_sign_in_tokens.sql` moves sign-in links that have not expired to the new link table, so they keep working after the upgrade.

`purgeStaleCommerceData` deletes sign-in links, with the address they were sent to, a day after they expired or were used, and shopper request counters a day after their window. It also deletes the accounts that earlier versions created for every sign-in request: accounts that were never verified, are at least a day old, and have no order, session, open basket, credit, referral or discount use.

Configure Worker secrets at runtime:

```text
TALISMAN_COMMERCE_CHECKOUT_ENABLED=true
TALISMAN_COMMERCE_STRIPE_MODE=test
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Test mode is the default. To accept live payments, set `TALISMAN_COMMERCE_STRIPE_MODE=live` explicitly and provide a matching `sk_live_...` key. Both Stripe secrets are required. Never place them in `astro.config`, CMS globals, or browser code. Stripe Checkout collects card details; the app should collect and validate contact and delivery details before calling `POST /api/ecommerce/checkout`. The `checkout` action from `@talisman-cms/plugin-ecommerce/actions` starts the same Stripe checkout behind the same enable flag, but validates less than the route: it does not limit field lengths or drop unknown address fields. Both refuse a country code that is not officially assigned, an undeliverable country and an unavailable shipping option, which `createFromCart` checks for every caller. Validate the address in the storefront before calling the action.

Configure Stripe to send `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed` to `/api/ecommerce/webhooks/stripe`. An open dispute holds its order as `disputed`, which cannot ship. A dispute closed as won, or an inquiry closed, gives the order back its status; a lost one refunds the order in full, which also voids its referral, reverses released awards and reverses its tax. The completed event is accepted only when Stripe reports a paid session whose ID, amount, and currency match the order; sessions are created in the order currency with Adaptive Pricing off, so they always can (see [Presentment currency](#presentment-currency)). The browser can read its own order status with `GET /api/ecommerce/order?order=...` and release an open payment session with a same-origin `POST /api/ecommerce/order` body of `{ "orderId": "..." }`. `POST /api/ecommerce/checkout` resumes an existing open Stripe session for the same cart.

The order status route also checks Stripe when an order remains pending, at most once per order every 15 seconds and only once the order is 60 seconds old; the webhook normally settles an order before then. Other status requests return the stored status with the same response shape. Without a webhook, a paid order therefore shows as pending until it is 60 seconds old, and after that for up to about 15 seconds longer than the provider reports; set storefront polling timeouts with both in mind. Checkout resume and session release (`POST /api/ecommerce/order`) share the same slot per order, without the minimum age: while it is taken they change nothing and answer HTTP 429 with `Retry-After: 15` (the `checkout` action throws `TOO_MANY_REQUESTS`) and "The payment session was checked moments ago. Please try again in 15 seconds." The shopper can retry after 15 seconds (`Retry-After`). Server code that handles shopper requests through `bindCommerceApi` passes `{ limitProviderChecks: true }` to `orders.resumeFromCart` (a limited call returns `providerCheckLimited: true`) and to `orders.cancel` (a limited call throws `ProviderCheckLimitedError`), and leaves `orders.reconcilePending` to reconciliation; without the option these methods ask the provider on every call. Reconciliation, gift-card orders and simulated `admin_test` orders are not limited by this. Call the protected `POST /admin/api/ecommerce/reconcile` endpoint for manual recovery, or run `reconcileCommerce({ env, paymentAdapters: runtimePaymentAdapters(env) })` from a scheduled Worker. It checks old pending sessions, releases orphaned `preparing:` locks only after 35 minutes, beyond the 31-minute Stripe session lifetime, records and reverses tax that was not recorded or reversed in time (see [Tax](#tax)), and releases held referral awards. Each result has an `id` and a `status`: the record's status after the check, `preparation_checked`, `unchanged`, `tax_recorded` or `tax_reversed` for an order's tax, one of `referral_released`, `referral_void` and `referral_held` for a referral, or `error`. Treat only `error` as a failure. Schedule it at least every ten minutes and alert on reported errors. Keep the signed webhook configured; reconciliation is a backstop, and the status route no longer asks the provider on every request.

The protected `GET /admin/api/ecommerce/fulfillment` lists recent real orders and audit records. `POST` accepts `{ "orderId": "ord_...", "carrier": "...", "trackingNumber": "...", "note": "..." }` and marks only a paid real order fulfilled. The database trigger records the administrator and rejects duplicate fulfillment or admin test orders. The CMS operation screen uses these endpoints. Connect them to the store's packing and shipping process; issuing labels and customer shipment emails are separate integrations.

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

`CartView.astro` and `CartItemCard.astro` take the store currency as their `currency` prop (see [Components and helpers](#6-components-and-helpers)).

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
2. **After payment.** When a payment is confirmed, the plugin records a Stripe Tax transaction from the calculation, with the order id as its reference, and stores `tax_transaction_id`. A failure is logged (`[Commerce] The tax transaction of order <id> was not recorded: <cause>`) and never fails the confirmation; `reconcileCommerce` records the transaction later, dated at the payment (`posted_at`) so its tax falls in the payment's period.
3. **Refunds.** Refunds are mirrored by partial reversals of the transaction, tax included, up to what has been refunded: the gift card and provider amounts together once the order is `refunded`, otherwise its provider and gift card refunds so far. Each `charge.refunded` webhook reverses what is new; `reconcileCommerce` reverses gift card tender refunds, refunds of gift-card-only orders and any reversal that failed. A reversal is recorded in `_ecommerce_tax_reversals` before Stripe is asked, under a reference that names the order and the total it brings the reversals to, which is also Stripe's idempotency key, so no refund is reversed twice. One whose request failed stays pending and is sent again, unchanged, by `reconcileCommerce` after five minutes. A failure is logged (`[Commerce] The tax reversal of order <id> was not recorded: <cause>`) and never fails the webhook.

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

The order status route (`GET /api/ecommerce/order`), `getOrderStatus` from `/browser` and `listCustomerOrders` from `/accounts` return `shippingAmount`, `shippingLabel`, `taxAmount` and `taxBehavior` (`'inclusive'`, `'exclusive'` or `null`) with the order's other amounts and its `currency`. The admin **Orders** screen lists each order's items subtotal, discount, store credit, shipping with its label, tax (or "Tax (included)"), gift card and charged total, and the read-only Orders collection shows the shipping and tax fields.

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

- **Gift cards are USD only.** Migration `0015` keeps gift cards and their purchases in USD, so a store whose currency is not USD refuses to issue them (HTTP 400 "Gift cards are available only in stores that use USD" from the admin gift card route), to sell them (the same from `POST /api/ecommerce/gift-cards`) and to redeem them (the 409 refusal above), until those tables are rebuilt for other currencies. Balance lookups, tender refunds and refunds of gift-card-only orders still work for existing cards. The **Gift cards** screen says so and disables **Issue**.
- **Choose the currency before the first order, and keep it.** Store credit balances, referral terms, discount values and voucher balances are plain amounts without a currency, so after a change they are read in the new currency. Do not change `TALISMAN_COMMERCE_CURRENCY` once orders, gift cards, store credit or discount codes exist. Orders keep their own currency, which confirmation and refunds use.
- **Only supported currencies.** The store currency must be in `SUPPORTED_CURRENCIES`. Each of them has a known Stripe minimum charge, and `Intl` and Stripe agree on its minor units. Other codes close checkout like any invalid setting. That includes typos, currencies whose minor units differ (Stripe takes ISK in two-decimal form while `Intl` shows no decimals), and three-decimal currencies such as KWD, which Stripe takes only in steps of ten.
- **Promotion limits are sized for two-decimal currencies.** Discount values, referral rewards and minimum orders keep their upper limits in minor units, for example at most 100,000 for a referral reward. In a currency with low-value units, such as INR or THB, those limits are worth less.
- **The discount preview has no destination.** Its `creditApplied` and `cardAmount` leave out shipping and tax, so checkout's credit and amount to pay can differ once rates or exclusive tax apply.
- **A lost dispute does not reverse tax.** It voids the order's referral (see [Referral credit](#referral-credit)) but leaves its tax transaction as it is; reverse the tax in Stripe Tax by hand. [PRODUCTION_READINESS.md](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-ecommerce/PRODUCTION_READINESS.md#known-limits) lists the other known limits.

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

**Daily budget.** `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` (default 200) is the total per 24-hour window. `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` (default a quarter of the limit, rounded down, so 50 of 200) is kept for addresses with a verified shopper account or a purchased order (paid, fulfilled, partially refunded or refunded; admin test orders do not count); a value that is not a whole number from 0 to the limit minus 1 means the default. The rest, the general pool, serves every address. Once the general pool is spent, every request answers HTTP 200 `{ "accepted": true, "limited": true }`, whatever the address. Only existing customers are then sent a link, from the reserve, each address at most twice per 24 hours. The customer lookup and the send from the reserve run after the response through the Worker's `waitUntil`, so the answer takes the same time for every address, and a failed send there is logged, not returned. Show a neutral message for `limited: true`, such as "Sign-in emails are limited today". Each limited request logs `[commerce] Daily sign-in email limit reached` with `{ pool: 'general' }`. The counters are `shopper-email:daily` (the general pool) and `shopper-email:reserved` in `_ecommerce_rate_limits`. The reserve is shared by all existing customers; the per-IP limit, the bot check and the Cloudflare rule bound how fast it is used.

On the server, `requestCustomerEmailSignIn(env, email, linkForToken, sendLink, sourceIp, { waitUntil, onLimitedSendError })` from `@talisman-cms/plugin-ecommerce/accounts` returns `{ limited }`. Without `waitUntil`, the reserve's lookup and send run before the call returns. `CustomerEmailLimitError` is still exported but no longer thrown.

**Bot check.** Set `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY` (public) and the Worker secret `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` together to require a Cloudflare Turnstile check; blank counts as unset. With the secret set, the account route verifies the request's `turnstileToken` with Cloudflare siteverify before any counter, link or email. It sends the secret, the token and the `CF-Connecting-IP` address, waits at most 5 seconds and fails closed. It accepts only `success: true`; a hostname that siteverify reports must equal the host of `TALISMAN_PUBLIC_ORIGIN` (or `TALISMAN_COMMERCE_PUBLIC_ORIGIN`), and a reported action must be `shopper-sign-in`. Cloudflare's published test secret keys skip those two comparisons and are accepted only while the public origin is a local development host (`localhost`, `127.0.0.1`, `[::1]`, or a name ending in `.localhost` or `.test`). A missing or failed check answers HTTP 403 `{ "error": "The security check failed. Please try again." }` and logs `[commerce] Email sign-in bot check refused` with a code (`missing_token`, `rejected`, `unavailable`, `hostname_mismatch`, `action_mismatch` or `test_key`) and Cloudflare's error codes. A secret without a site key answers 503 "Email sign-in is unavailable" and logs `[commerce] Email sign-in bot check is not configured` with `turnstile_site_key_missing`; a site key without the secret turns nothing on.

The storefront renders the widget when `shopperSignInBotCheck(env)` returns `{ provider: 'turnstile', siteKey, action }` (it returns `null` unless both keys are set), with that `action`, and sends the token with `requestCustomerEmailSignIn(email, { turnstileToken })` from `@talisman-cms/plugin-ecommerce/browser`. Reset the widget after each attempt, since a token can be verified once. Create the widget in Managed mode for the storefront's hostname. The Cloudflare rate limiting rule on `/api/ecommerce/account` (see [Basket limits](#basket-limits)) stays as defence in depth.

## Referral credit

`@talisman-cms/plugin-ecommerce/referrals` issues a random code for a shopper account while referrals are on and exposes a read-only balance and activity view. A storefront can use `findReferralCode` to validate a share link and save it in an HTTP-only `talisman-referral` cookie. The public checkout route reads that cookie; callers cannot set the referral on a payment directly. The rules:

- **Off by default.** Referrals run only when an administrator saves a policy that enables them or, while nothing is saved, `TALISMAN_COMMERCE_REFERRALS_ENABLED` is `true`. A saved policy wins over the Worker setting in both directions.
- **Terms.** By default a qualifying first order of at least 5000 earns 1000 of credit for the referrer and for the new shopper, both in the store currency's minor units ($50 and $10 in USD). The reward may be at most half the minimum first order. The admin refuses to enable a larger reward, and terms from Worker settings or an older saved row that break the rule pause new referrals; `termsError` says why.
- **First purchase.** A referral is attributed to a paid Stripe order whose subtotal less the promotion discount reaches the minimum, when neither the buyer's account nor any of its addresses has an earlier paid, fulfilled or refunded order (admin test orders do not count). A shopper who signed up or asked for a sign-in link first still qualifies, as a guest or signed in. When two checkouts by the same shopper overlap, only the first one paid is attributed.
- **Self-referral.** The buyer must not be the referrer. Addresses are compared exactly and in canonical form: lowercased and trimmed, a `+suffix` dropped on every domain, and for `gmail.com` and `googlemail.com` dots dropped and the domain treated as `gmail.com` (`canonicalEmail`). The checkout email, the signed-in account's email and the payment provider's email are compared with the referrer's address and with earlier purchasers, at checkout and again at payment.
- **Cap.** Payment records a referral only while the referrer has fewer than `TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD` (default 10) approved referrals created within `TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS` (default 30). Referrer accounts whose addresses share a canonical form share one cap, and a voided referral frees its place.
- **Hold and release.** Payment records the referral as pending and credits nothing. After `TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS` (default 30) the scheduled `reconcileCommerce`, or `releaseReferralAwards(options, { now, limit })`, releases the award: the referrer gets a `referral_award` and the new shopper a `welcome_award`, once each, whether or not new referrals are still enabled. An open dispute keeps the award pending, and so does a Stripe order while no Stripe adapter is passed, since only the adapter can report disputes. Pending awards are not spendable.
- **Reversal.** An order keeps its referral while it is paid, fulfilled or partially refunded and its net amount (subtotal less the promotion discount, provider refunds and gift card refunds) reaches both twice the award's reward and the current minimum order, counted only up to what the order qualified with at checkout. A provider refund, full or partial, or a gift card tender refund that takes the order below that amount voids the referral and reverses released awards once (`referral_reversal`, `welcome_reversal`). So does a lost dispute (`charge.dispute.closed` with status `lost`). A refund that leaves enough paid changes nothing, and changing the terms alone never voids or reverses an award. Shipping and tax count toward neither the minimum nor the net amount, and a refund counts in full against the items even when it returned shipping or tax. Gift-card-only orders are never attributed.

`getReferralPolicy(env)` (and `referralPolicy(env)` for the Worker settings alone) returns `{ enabled, switchedOn, termsError, source, rewardCents, minOrderCents, attributionDays, holdDays, maxPerPeriod, periodDays }`. `enabled` means new referrals are attributed: the switch is on and the terms are valid. `switchedOn` is the switch as saved, or as the Worker setting gives it; `source` is `'saved'` or `'settings'`; the hold, cap and period always come from Worker settings. `getReferralDashboard(env, accountId)` returns `code`, which is `null` while referrals are off and the shopper has none (no code is created then; an existing one is still returned), `codeActive`, `creditBalance` (spendable ledger credit, without pending awards), `activity`, and `earned`: the awards the account earned as a referrer, each with `state` (`'pending'`, `'released'` or `'void'`) and `releasesAt`, the earliest release date of a pending award. `earned` does not list the shopper's own welcome award.

An administrator can manage referral availability, the reward, minimum first order, 1–90 day link lifetime, and individual shopper links through the protected promotions API. The **Promotions** screen shows whether saved or Worker settings apply, any terms error, and the hold, cap and period as read-only values. Saved settings override the `TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS` and `TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS` Worker defaults; settings can be saved with the switch off whatever the terms. The applicable reward is saved on the pending order so a later config change cannot alter its payout. The threshold applies to the first paid purchase's subtotal less the promotion discount; a smaller first purchase does not qualify later orders. Local $1 test catalog items need a lower local threshold, and a reward at most half of it, if you want to exercise referrals through Stripe test mode.

The order records `subtotal_amount` (items), `discount_amount` (code), `credit_applied` (shopper balance), `shipping_amount`, `tax_amount`, `total_amount` (Stripe charge), `payment_intent_id`, and cumulative `provider_refunded_cents` (see [Order totals](#order-totals)). An immutable `_ecommerce_credit_ledger` records each award, checkout reservation, release, and refund reversal; a database trigger updates the shopper's balance. A checkout reserves at most the available balance, uses credit for items only, and leaves at least Stripe's minimum charge for the currency to pay (`minimumChargeAmount`, 50 cents in USD). Stripe receives the combined promotion and store credit as an exact fixed coupon (see [Single-use checkout coupons](#single-use-checkout-coupons)). Its signed paid webhook must confirm the reduced `total_amount`; the reservation then remains spent. Cancellation restores credit once. A full provider refund restores any credit used on that order. If a released award was already spent when a refund reverses it, the account balance can go negative; later awards offset the adjustment before credit can be used again.

## Discount codes and credit vouchers

The protected `GET` and `POST /admin/api/ecommerce/promotions` endpoint provides validated administration of referral settings and discount codes. The CMS screen is at `/admin/extensions/commerce-promotions`. Administrators can create codes, edit descriptions, dates, use limits, and active status, and pause shopper referral links. Financial terms, product scope, and code type are fixed at creation; pause an old code and create a new one to change those terms. Commerce collections for policies, codes, redemptions, and the credit ledger are read-only audit views.

- **Amount:** a fixed amount off each eligible order, in the store currency.
- **Percent:** a percentage in basis points, with an optional cap in the store currency.
- **Credit voucher:** a server-generated, random bearer code with a remaining balance in the store currency; partial redemptions carry forward to later orders.

Codes can specify a minimum item subtotal, eligible product IDs, first-purchase eligibility, start and expiry times, total uses, and uses per shopper. A first-purchase code is refused once the shopper's email or account has a paid, fulfilled or refunded order (admin test orders do not count), or while another first-purchase code is reserved for that email; signing up does not count as a purchase. One code can be used per order and it can combine with the shopper's earned store credit. The checkout server computes the discount from current product prices, then applies shopper credit, leaving at least Stripe's minimum charge for the currency to pay. Its D1 transaction reserves code usage, voucher balance, store credit, inventory, and the pending order together. A cancelled checkout releases all reservations. A verified paid webhook confirms the code use once. A full refund releases its use and restores voucher balance; a partial refund leaves the code use confirmed until fully refunded. The percentage and fixed offers are discounts, not cash balances.

### Discount preview

`POST /api/ecommerce/discount` with `{ "code": "...", "giftCardCode": "..." }` prices a discount code, a gift card or both against the shopper's basket, only while checkout is enabled. It checks, in order: the checkout flag (503 "Checkout is disabled"), same origin (403), and the body (400 "Enter a discount or gift card code"), and before it reads the basket, the [store settings](#store-settings) (503 "Checkout is temporarily unavailable."). Codes may be up to 200 characters. The answer's `creditApplied` and `cardAmount` leave out shipping and tax, which depend on the destination.

- **Limits.** The preview and every checkout that carries a `discountCode` or `giftCardCode`, through the route or the `checkout` action, share one code-check budget: 30 per client network (an IPv4 address or an IPv6 /64, from `CF-Connecting-IP`) and 10 per basket per hour, in fixed one-hour windows in `_ecommerce_rate_limits`. Over either limit the routes answer HTTP 429 `{ "error": "Too many code checks. Please try again later." }` and the action throws `ActionError` `TOO_MANY_REQUESTS`. A checkout without a code is not counted. Without a client IP, as in local development, only the basket limit applies. The limits are code constants, not settings; handle a 429 from checkout as well as from the preview.
- **One refusal.** Every refusal of an entered code, in the preview and at checkout, answers HTTP 409 `{ "error": "This code is not valid for this order.", "field": "code" }` (or `"field": "giftCardCode"`), including one used up while the order is reserved, and in the preview a code of the wrong shape. At checkout, a discount code over 32 characters or a gift card code over 37 fails input validation first: the route answers HTTP 400 "Invalid checkout details" and the action an input validation error. The `checkout` action throws `ActionError` `CONFLICT` with the same message. The reason stays on the server in `DiscountCodeRefusal` and `GiftCardRefusal`, which carry a reason code; `codeRefusalBody(error)` from `/promotions` maps them to the shopper-facing body, and `evaluateDiscountCode` and `evaluateGiftCard` keep their detailed messages for other callers.
- **What it decides from.** The preview uses only the basket and the signed-in shopper's own account. It accepts `customerEmail` but ignores it. First-order and per-customer rules are checked in the preview only for a signed-in shopper, against that account; for a guest they are checked at checkout with the checkout email, so a guest's preview can show a price for a code that checkout then refuses. The preview links a browser basket to a signed-in account like the cart route, and never creates a basket: 404 "Basket not found" without a basket cookie, and 409 "Basket is not available for discounts" for a missing, empty or locked basket.

Item prices, credit balances, discount values and Stripe coupons are amounts in the store currency's minor units (see [Money in minor units](#money-in-minor-units)). Credit balances and discount values carry no currency of their own, so keep the store currency once they exist; selling in several currencies would need a separate balance and ledger per currency. Read-only Commerce collections expose referral codes, qualified referrals, and credit entries to administrators for reconciliation. Migrate the database before deploying code that reads these tables or fields.

## Gift cards

Purchased gift cards are separate from discounts and account referral credit. They are kept in USD only, so they work only in a store whose currency is USD (see [Limits](#limits)). `POST /api/ecommerce/gift-cards` starts a standalone Stripe purchase for $5–$1,000 USD. A card is issued only after a signed, paid Checkout webhook matches the pending purchase amount, currency, and session. Duplicate webhooks cannot issue twice. The buyer returns to `/gift-cards/success` in the same browser to copy the private code and share it manually; email delivery is not configured. The buyer access cookie lasts seven days. The code is stored as a SHA-256 lookup hash plus an AES-GCM encrypted copy, using the required `TALISMAN_COMMERCE_GIFT_CARD_KEY` secret (64 hex characters). Keep that key stable and backed up, or previously purchased codes cannot be displayed again.

Set `TALISMAN_COMMERCE_GIFT_CARDS_ENABLED=true` only after configuring the encryption key, Stripe secrets, signed webhook, and migration. Talisman offers purchase and code-based balance lookup at `/gift-cards`; the shared CMS administration screen is at `/admin/extensions/commerce-gift-cards`. Admins can issue a card with an audit reason, suspend/reactivate cards, refund gift card tender in part, and fully refund orders paid without Stripe. Purchased cards that receive a provider refund are voided if unspent; a spent or partially refunded purchase is suspended for manual review. The admin API exposes only a card's code suffix and balance. Admin-issued codes are shown once in the issuance response.

Checkout accepts one gift card alongside one promotion code and earned shopper credit. The order records each source separately: `subtotal_amount + shipping_amount + tax_amount (when exclusive) = discount_amount + credit_applied + gift_card_applied + total_amount`. A gift card is a means of payment, so it can pay for shipping and tax too and never lowers the taxed amount. D1 triggers reserve gift card balance with the pending order and release it on cancellation or refund. A card that covers the remaining total can settle an order without a Stripe session. For a split payment, the existing Stripe Checkout adapter uses a single-use coupon to charge the card remainder; the internal order and ledgers retain the distinct promotion, credit, gift card, and provider amounts. Full provider refunds restore any gift card amount not already restored by an admin partial refund.

### Single-use checkout coupons

Each discounted Stripe checkout (a promotion, store credit or gift card applied) creates one coupon with the id `<order id>_discount` (`checkoutCouponId(orderId)` from `@talisman-cms/plugin-ecommerce/adapters/stripe`), `max_redemptions: 1` and `redeem_by` at the session's `expires_at`. Checkout Sessions for plugin orders last 31 minutes, because Stripe needs at least 30 minutes after creation and the coupon is created first. The coupon is deleted when its order is cancelled (by the `checkout.session.expired` webhook, by reconciliation, or by a shopper or admin cancel), when a session expires for an order that was never recorded, and when checkout fails after the session was requested. Deletion is best effort: a failure logs `[commerce] Checkout discount could not be discarded` with the provider, error name and code, and never blocks releasing stock, credit, gift card or promotion reservations; the coupon still cannot be redeemed after its `redeem_by`. Coupons created by earlier versions have random ids and are not deleted automatically; unused ones can be deleted in the Stripe dashboard.

Gift card purchases cannot use promotions, gift cards, or referral credit, which prevents circular funding. They are not taxed: tax applies when a card pays for an order. Gift cards and their purchases are in USD only. Automated recipient email, multiple gift cards on one order, and market-specific tax treatment of gift card sales are outside this implementation.

## Admin test checkout

The admin test checkout is off by default. Enable it with `ecommercePlugin({ adminTestCheckout: true })` on a site whose administrators need to exercise checkout without charging a card. It adds the **Test checkout** screen and the protected `/admin/api/ecommerce/test-checkout` route. Without the option, neither is injected and the simulated provider is never registered.

The `admin_test` adapter simulates a successful payment without contacting Stripe. The protected `GET /admin/api/ecommerce/test-checkout` returns the current basket quote for the CMS screen. `POST` requires a Talisman CMS administrator, a same-origin request, and the current basket cookie. It uses the same product validation, basket lock, order creation, and payment finalization as Stripe checkout. Orders and payment rows identify `admin_test` as the provider. No card is charged, sellable stock is not reduced, and test orders cannot be fulfilled. The endpoint works even when public Stripe checkout is disabled.

`PaymentProviderAdapter` handles provider session creation, expiry, and optional webhook validation. Two optional methods support the rules above: `getDisputeStatus(paymentIntentId)` returns `'none'`, `'open'` or `'lost'`, and referral awards are released only after it answers `'none'`; `discardCheckoutDiscount(orderId)` deletes the provider-side discount of an expired or cancelled checkout and resolves when there is nothing to delete. `StripePaymentAdapter` implements both. `createFromCart` selects an adapter by `providerId` and stores that choice on the order; cancellation and resumption use the stored provider. Without a `providerId` it uses the only registered adapter, but never `admin_test`. A second real payment provider can be registered alongside Stripe, but it still needs its own authenticated webhook route and shopper checkout route or provider selector. `runtimePaymentAdapters(env)` returns only real providers (Stripe when configured). The admin test route adds `AdminTestPaymentAdapter` itself, and the public checkout route and action always request `stripe`. Public order status checks never settle a pending `admin_test` order. Placing the test order again from the same basket completes an interrupted one, and the basket's owner can cancel it with `cancelCheckout`. Unless the caller registered `AdminTestPaymentAdapter`, `reconcileCommerce` cancels one left pending for 15 minutes, which unlocks the basket, and it keeps reconciling the real orders behind it. Never register it for a public route. Test orders include the store's shipping charge but are never taxed.

`createCheckoutSession` receives the order's `currency`, a lowercase ISO 4217 code in which the provider must charge and in no other, and, when they apply, the order's `shipping` (`{ label, amount, description? }`) and exclusive `tax` (`{ amount }`). The provider charges the items plus a shipping and tax amount above 0, less `creditApplied`, `discountApplied` and `giftCardApplied`; a payment of any other amount or currency does not confirm the order. Three optional methods take part in [tax](#tax): `calculateTax(params)` takes `TaxCalculationParams` and returns a `TaxCalculation` `{ id, amountTotal, taxAmountExclusive, taxAmountInclusive }`, rejecting with `TaxAddressError` when it cannot place the address; `recordTaxTransaction({ orderId, calculationId })` returns `{ transactionId }`; and `reverseTaxTransaction({ orderId, transactionId, amount, reference })` returns `{ reversalId }`, where `amount` is positive and tax included and `reference` names that reversal only. A provider without all three cannot take orders while a tax mode is set. `StripePaymentAdapter` implements them with Stripe Tax calculations, transactions created from the calculation with the order id as reference and `tax-transaction:<order id>` as idempotency key, and partial reversals with a negative `flat_amount` and the reference as idempotency key.

Products must be active, have a positive price, and have available stock before checkout. For physical products, the checkout request must include a shipping address with name, line 1, city, postal code, and a two-letter country code the store delivers to. Without `TALISMAN_COMMERCE_SHIPPING_RATES`, shipping is included in the item price. Configure the store settings, shipping policy, refunds, and fulfillment before enabling live sales.

## Shared component inventory

The commerce plugin can stock physical components that are used by more than one sellable variant. Apply the Talisman CMS migrations through `0008_shared_components.sql` before using this feature.

1. Create one **Product** for each frame model. Its `sku` is the model SKU.
2. Create a **Product Variant Value** for each sellable frame and lens choice. Its `sku` identifies that finished choice.
3. Create **Shared Components** for physical stock, such as a frame body and a lens pair. Each component has its own SKU and available quantity.
4. Add **Variant Components** rows for every part consumed by each variant value. For example, Mycelium + Golden Hour can consume one Mycelium frame and one Golden Hour lens pair; another frame model can consume a different frame component and the **same** lens component.

When a variant value has component rows, checkout uses its component quantities instead of its dedicated stock row. Include **all** physical parts in the bill of materials for that choice. A variant value with no component rows keeps the existing dedicated stock behavior. A component quantity is measured in the units of that component SKU: if a lens component SKU represents a pair, set its units per item to `1`.

Checkout sums component demand across the entire cart and reserves it in an atomic D1 batch with the pending order. A paid order keeps that reservation as consumed stock. Cancelling an order expires its open payment session before returning the stock; an expired Stripe Checkout session also returns it through the webhook. Cancellation restores the same persisted cart so the customer can edit it and try again. Configure Stripe's `checkout.session.expired` webhook event when using Stripe. A preparation lock left by an interrupted Worker request is released after 35 minutes only if no pending order exists, beyond the configured 31-minute Stripe session lifetime.

The current commerce plugin has one shopper-selectable variant value per cart line. Multi-axis options such as frame finish, size, and lens tint must be represented as distinct sellable values until a multi-option configurator is added. Shared components keep stock pooled even when those values belong to different products.
