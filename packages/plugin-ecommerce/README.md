# @talisman-cms/plugin-ecommerce

Commerce for Talisman CMS: a product catalog in D1, a cookie-keyed basket, hosted Stripe Checkout, shopper accounts, promotions, gift cards and order fulfillment. It all runs in the site's own Cloudflare Worker. Public checkout is off until you enable it; read [PRODUCTION_READINESS.md](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-ecommerce/PRODUCTION_READINESS.md) before taking live orders. Prices, credit and payments are USD only.

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

The plugin needs at least `0024_shopper_sign_in_tokens.sql`: shopper account reads fail without `0019`, and shopper sign-in fails without `0024`. Run the duplicate checks under [Hosted Stripe checkout](#hosted-stripe-checkout) first when upgrading an existing database.

### 4. Worker settings

Settings are read at request time with `readSetting` from `talisman-cms/env`. Put secrets in Worker secrets or `.dev.vars`, never in `astro.config`, CMS globals or browser code.

| Setting | Default | Purpose |
| --- | --- | --- |
| `TALISMAN_COMMERCE_CHECKOUT_ENABLED` | off | `true` enables the public checkout and discount preview routes and the checkout action. Otherwise both routes answer HTTP 503 "Checkout is disabled" and the action refuses with `FORBIDDEN`, before the basket is read. |
| `TALISMAN_COMMERCE_STRIPE_MODE` | `test` | `live` accepts real payments and requires an `sk_live_...` key. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | none | Stripe secret key for the mode (`sk_test_...` or `sk_live_...`) and the webhook signing secret (`whsec_...`). Stripe is unavailable unless both are set. |
| `TALISMAN_COMMERCE_LOCAL_STRIPE_SECRET_KEY`, `TALISMAN_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET` | none | Test-mode fallbacks for local development. Ignored in live mode. |
| `TALISMAN_COMMERCE_GIFT_CARDS_ENABLED` | off | `true` enables gift card sales. They also need checkout enabled and the key below. |
| `TALISMAN_COMMERCE_GIFT_CARD_KEY` | none | 64 hex characters that encrypt gift card codes. Keep it stable and backed up. |
| `TALISMAN_COMMERCE_REFERRALS_ENABLED` | off | `true` turns new referral attribution on while no referral settings are saved in the admin. A saved policy wins in both directions. See [Referral credit](#referral-credit). |
| `TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS`, `TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS` | `1000`, `5000` | Referral terms until an admin saves referral settings. The reward must be at most half the minimum, or new referrals are paused. |
| `TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS` | `30` | Days after payment that referral awards stay pending before the scheduled job may release them (1–365). |
| `TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD`, `TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS` | `10`, `30` | The most approved referrals one referrer can have recorded within the rolling period (1–10000, and 1–365 days). |
| `TALISMAN_EMAIL_FROM`, `TALISMAN_PUBLIC_ORIGIN` | none | Sender and storefront origin for sign-in links. `TALISMAN_COMMERCE_EMAIL_FROM` and `TALISMAN_COMMERCE_PUBLIC_ORIGIN` override them for shopper mail. |
| `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` | `200` | Store-wide cap on sign-in emails per 24 hours. |
| `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` | a quarter of the limit | The part of the daily cap kept for addresses with a verified account or a purchased order. A whole number from 0 to the limit minus 1. |
| `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY`, `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` | none | Cloudflare Turnstile keys for the sign-in bot check. The site key is public; the secret is a Worker secret. Set both or neither. See [Sign-in email limits and bot check](#sign-in-email-limits-and-bot-check). |

Deployments configured before the rename can keep the `GALAXY_` names of these settings; a `GALAXY_` value is read when the `TALISMAN_` one is missing or blank. A number setting that is blank or not a whole number in its range means its default.

### 5. Storefront pages

The plugin injects the API routes below; the site renders its own pages. Stripe returns shoppers to `/checkout/success?order=<id>` and `/checkout/cancel?order=<id>` on the request origin, so provide both. Email sign-in links open `/account/verify`, gift card buyers return to `/gift-cards/success`, and `CartView` links to `/shop`, `/checkout` and `/checkout/cancel`.

| Route | Access | Purpose |
| --- | --- | --- |
| `GET`, `POST /api/ecommerce/cart` | public | Read or replace the basket. New baskets are limited per client network. See [Basket limits](#basket-limits). |
| `POST /api/ecommerce/checkout` | public, enable flag | Start or resume hosted Stripe Checkout from the shopper's open basket. |
| `POST /api/ecommerce/discount` | public, enable flag | Preview a discount or gift card code against the basket, within a code-check budget. See [Discount preview](#discount-preview). |
| `GET`, `POST /api/ecommerce/order` | the placing basket or account | Order status, or release an open payment session. |
| `POST /api/ecommerce/webhooks/stripe` | Stripe-signed | Payment completion, expiry, refunds and closed disputes. |
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
- **`CartView.astro`** is an editable basket. Props: `items`, `locked`, `pendingOrderId`, `itemCount`, `requiresShipping` and `subtotal`. The page builds `items` from the basket and catalog. Each item has `key`, `productId`, `variantId`, `quantity`, `productName`, `variantLabel`, `imageUrl`, `unitPrice`, `lineTotal`, `type`, `stockLabel` and `href`. Quantity changes are posted to `/api/ecommerce/cart`.
- **`CartItemCard.astro`** renders one server-side line (`item`, `locked`).
- `@talisman-cms/plugin-ecommerce/browser`: `startCheckout`, `getOrderStatus`, `cancelCheckout`, the shopper account helpers (`requestCustomerEmailSignIn(email, { turnstileToken })`, `readCustomerSignInToken`, `previewCustomerSignIn`, `verifyCustomerEmailSignIn`, `getCustomerAccount`, `signOutCustomerAccount` and `chooseCustomerBasket`), `CART_UPDATED_EVENT` and `dispatchCartUpdated`. `startAdminTestCheckout(input, { adminPath })` needs `adminTestCheckout: true`; pass `adminPath` when the CMS is not at `/admin`.
- `@talisman-cms/plugin-ecommerce/cookies`: the basket and gift card cookie names, `readCartSessionToken` and `ensureCartSession`.
- `@talisman-cms/plugin-ecommerce/actions`: the `getCart`, `addToCart`, `clearCart` and `checkout` Astro actions. `addToCart` and `checkout` throw `ActionError` `TOO_MANY_REQUESTS` over the basket and code-check limits.
- `@talisman-cms/plugin-ecommerce/accounts`: server helpers for shopper sign-in, including `requestCustomerEmailSignIn`, `shopperSignInBotCheck(env)` and `normalizeShopperEmail`.
- `@talisman-cms/plugin-ecommerce/referrals`: referral helpers, including `getReferralPolicy`, `getReferralDashboard`, `findReferralCode`, `releaseReferralAwards`, `reverseReferralForOrder`, `referralTermsError`, `referralNetAmount`, `referralOrderQualifies`, `referralReversalStatements` and `canonicalEmail`, the defaults `REFERRAL_HOLD_DAYS`, `REFERRAL_MAX_PER_PERIOD` and `REFERRAL_PERIOD_DAYS`, and the types `ReferralPolicy`, `ReferralDashboard` and `ReferralReleaseResult`. See [Referral credit](#referral-credit).
- `@talisman-cms/plugin-ecommerce/api`: `bindCommerceApi({ env, paymentAdapters })`, `reconcileCommerce` and `purgeStaleCommerceData` for server code and the scheduled Worker.

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

The default paths are `/admin/extensions/commerce-orders`, `/admin/extensions/commerce-promotions`, and `/admin/extensions/commerce-gift-cards`, plus `/admin/extensions/commerce-test-checkout` when enabled. A store can override task links with same-origin `adminPages` paths when it has a genuinely store-specific workflow. The plugin owns the protected commerce APIs and shared operation screens. No database migration is needed for this UI change.

## Hosted Stripe checkout

`ecommercePlugin()` provides the cart, checkout, order status, and Stripe webhook routes. An app only needs to register the plugin and render its own cart and checkout pages. The separate `plugin-stripe` package handles Stripe resource sync and is not required for payments.

Apply Talisman CMS migrations through `0024_shopper_sign_in_tokens.sql` before deploying the plugin's Worker; shopper account reads fail without `0019`, and shopper sign-in fails without `0024`. On an existing database, these checks must return no rows first. The first guards `0018`'s unique revision index, the second `0019`, which allows one CMS user per email regardless of letter case, and the third `0023`, which allows one published entry per slug in a collection:

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

Test mode is the default. To accept live payments, set `TALISMAN_COMMERCE_STRIPE_MODE=live` explicitly and provide a matching `sk_live_...` key. Both Stripe secrets are required. Never place them in `astro.config`, CMS globals, or browser code. Stripe Checkout collects card details; the app should collect and validate contact and delivery details before calling `POST /api/ecommerce/checkout`. The `checkout` action from `@talisman-cms/plugin-ecommerce/actions` starts the same Stripe checkout behind the same enable flag, but validates less than the route: it does not limit field lengths, check the two-letter country code, or drop unknown address fields. Validate the address in the storefront before calling it.

Configure Stripe to send `checkout.session.completed`, `checkout.session.expired`, `charge.refunded` and `charge.dispute.closed` to `/api/ecommerce/webhooks/stripe`. A closed dispute with status `lost` voids the order's referral and reverses released awards; other statuses are acknowledged and ignored. The completed event is accepted only when Stripe reports a paid session whose ID, amount, and currency match the order. The browser can read its own order status with `GET /api/ecommerce/order?order=...` and release an open payment session with a same-origin `POST /api/ecommerce/order` body of `{ "orderId": "..." }`. `POST /api/ecommerce/checkout` resumes an existing open Stripe session for the same cart.

The order status route also checks Stripe when an order remains pending, at most once per order every 15 seconds and only once the order is 60 seconds old; the webhook normally settles an order before then. Other status requests return the stored status with the same response shape. Without a webhook, a paid order therefore shows as pending until it is 60 seconds old, and after that for up to about 15 seconds longer than the provider reports; set storefront polling timeouts with both in mind. Checkout resume and session release (`POST /api/ecommerce/order`) share the same slot per order, without the minimum age: while it is taken they change nothing and answer HTTP 429 with `Retry-After: 15` (the `checkout` action throws `TOO_MANY_REQUESTS`) and "The payment session was checked moments ago. Please try again in 15 seconds." The shopper can retry after 15 seconds (`Retry-After`). Server code that handles shopper requests through `bindCommerceApi` passes `{ limitProviderChecks: true }` to `orders.resumeFromCart` (a limited call returns `providerCheckLimited: true`) and to `orders.cancel` (a limited call throws `ProviderCheckLimitedError`), and leaves `orders.reconcilePending` to reconciliation; without the option these methods ask the provider on every call. Reconciliation, gift-card orders and simulated `admin_test` orders are not limited by this. Call the protected `POST /admin/api/ecommerce/reconcile` endpoint for manual recovery, or run `reconcileCommerce({ env, paymentAdapters: runtimePaymentAdapters(env) })` from a scheduled Worker. It checks old pending sessions, releases orphaned `preparing:` locks only after 35 minutes, beyond the 31-minute Stripe session lifetime, and releases held referral awards. Each result has an `id` and a `status`: the record's status after the check, `preparation_checked`, `unchanged`, one of `referral_released`, `referral_void` and `referral_held` for a referral, or `error`. Treat only `error` as a failure. Schedule it at least every ten minutes and alert on reported errors. Keep the signed webhook configured; reconciliation is a backstop, and the status route no longer asks the provider on every request.

The protected `GET /admin/api/ecommerce/fulfillment` lists recent real orders and audit records. `POST` accepts `{ "orderId": "ord_...", "carrier": "...", "trackingNumber": "...", "note": "..." }` and marks only a paid real order fulfilled. The database trigger records the administrator and rejects duplicate fulfillment or admin test orders. The CMS operation screen uses these endpoints. Connect them to the store's packing and shipping process; issuing labels and customer shipment emails are separate integrations.

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
- **Terms.** By default a qualifying first order of at least $50 USD earns $10 USD credit for the referrer and for the new shopper. The reward may be at most half the minimum first order. The admin refuses to enable a larger reward, and terms from Worker settings or an older saved row that break the rule pause new referrals; `termsError` says why.
- **First purchase.** A referral is attributed to a paid Stripe order whose subtotal less the promotion discount reaches the minimum, when neither the buyer's account nor any of its addresses has an earlier paid, fulfilled or refunded order (admin test orders do not count). A shopper who signed up or asked for a sign-in link first still qualifies, as a guest or signed in. When two checkouts by the same shopper overlap, only the first one paid is attributed.
- **Self-referral.** The buyer must not be the referrer. Addresses are compared exactly and in canonical form: lowercased and trimmed, a `+suffix` dropped on every domain, and for `gmail.com` and `googlemail.com` dots dropped and the domain treated as `gmail.com` (`canonicalEmail`). The checkout email, the signed-in account's email and the payment provider's email are compared with the referrer's address and with earlier purchasers, at checkout and again at payment.
- **Cap.** Payment records a referral only while the referrer has fewer than `TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD` (default 10) approved referrals created within `TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS` (default 30). Referrer accounts whose addresses share a canonical form share one cap, and a voided referral frees its place.
- **Hold and release.** Payment records the referral as pending and credits nothing. After `TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS` (default 30) the scheduled `reconcileCommerce`, or `releaseReferralAwards(options, { now, limit })`, releases the award: the referrer gets a `referral_award` and the new shopper a `welcome_award`, once each, whether or not new referrals are still enabled. An open dispute keeps the award pending, and so does a Stripe order while no Stripe adapter is passed, since only the adapter can report disputes. Pending awards are not spendable.
- **Reversal.** An order keeps its referral while it is paid, fulfilled or partially refunded and its net amount (subtotal less the promotion discount, provider refunds and gift card refunds) reaches both twice the award's reward and the current minimum order, counted only up to what the order qualified with at checkout. A provider refund, full or partial, or a gift card tender refund that takes the order below that amount voids the referral and reverses released awards once (`referral_reversal`, `welcome_reversal`). So does a lost dispute (`charge.dispute.closed` with status `lost`). A refund that leaves enough paid changes nothing, and changing the terms alone never voids or reverses an award. Gift-card-only orders are never attributed.

`getReferralPolicy(env)` (and `referralPolicy(env)` for the Worker settings alone) returns `{ enabled, switchedOn, termsError, source, rewardCents, minOrderCents, attributionDays, holdDays, maxPerPeriod, periodDays }`. `enabled` means new referrals are attributed: the switch is on and the terms are valid. `switchedOn` is the switch as saved, or as the Worker setting gives it; `source` is `'saved'` or `'settings'`; the hold, cap and period always come from Worker settings. `getReferralDashboard(env, accountId)` returns `code`, which is `null` while referrals are off and the shopper has none (no code is created then; an existing one is still returned), `codeActive`, `creditBalance` (spendable ledger credit, without pending awards), `activity`, and `earned`: the awards the account earned as a referrer, each with `state` (`'pending'`, `'released'` or `'void'`) and `releasesAt`, the earliest release date of a pending award. `earned` does not list the shopper's own welcome award.

An administrator can manage referral availability, the reward, minimum first order, 1–90 day link lifetime, and individual shopper links through the protected promotions API. The **Promotions** screen shows whether saved or Worker settings apply, any terms error, and the hold, cap and period as read-only values. Saved settings override the `TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS` and `TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS` Worker defaults; settings can be saved with the switch off whatever the terms. The applicable reward is saved on the pending order so a later config change cannot alter its payout. The threshold applies to the first paid purchase's subtotal less the promotion discount; a smaller first purchase does not qualify later orders. Local $1 test catalog items need a lower local threshold, and a reward at most half of it, if you want to exercise referrals through Stripe test mode.

The order records `subtotal_amount` (items), `discount_amount` (code), `credit_applied` (shopper balance), `total_amount` (Stripe charge), `payment_intent_id`, and cumulative `provider_refunded_cents`. An immutable `_ecommerce_credit_ledger` records each award, checkout reservation, release, and refund reversal; a database trigger updates the shopper's balance. A checkout reserves at most the available balance and leaves at least $0.50 for Stripe. Stripe receives the combined promotion and store credit as an exact fixed coupon (see [Single-use checkout coupons](#single-use-checkout-coupons)). Its signed paid webhook must confirm the reduced `total_amount`; the reservation then remains spent. Cancellation restores credit once. A full provider refund restores any credit used on that order. If a released award was already spent when a refund reverses it, the account balance can go negative; later awards offset the adjustment before credit can be used again.

## Discount codes and credit vouchers

The protected `GET` and `POST /admin/api/ecommerce/promotions` endpoint provides validated administration of referral settings and discount codes. The CMS screen is at `/admin/extensions/commerce-promotions`. Administrators can create codes, edit descriptions, dates, use limits, and active status, and pause shopper referral links. Financial terms, product scope, and code type are fixed at creation; pause an old code and create a new one to change those terms. Commerce collections for policies, codes, redemptions, and the credit ledger are read-only audit views.

- **Amount:** a fixed USD amount off each eligible order.
- **Percent:** a percentage in basis points, with an optional USD cap.
- **Credit voucher:** a server-generated, random bearer code with a remaining USD balance; partial redemptions carry forward to later orders.

Codes can specify a minimum item subtotal, eligible product IDs, first-purchase eligibility, start and expiry times, total uses, and uses per shopper. A first-purchase code is refused once the shopper's email or account has a paid, fulfilled or refunded order (admin test orders do not count), or while another first-purchase code is reserved for that email; signing up does not count as a purchase. One code can be used per order and it can combine with the shopper's earned store credit. The checkout server computes the discount from current product prices, then applies shopper credit, leaving at least a $0.50 USD card payment. Its D1 transaction reserves code usage, voucher balance, store credit, inventory, and the pending order together. A cancelled checkout releases all reservations. A verified paid webhook confirms the code use once. A full refund releases its use and restores voucher balance; a partial refund leaves the code use confirmed until fully refunded. The percentage and fixed offers are discounts, not cash balances.

### Discount preview

`POST /api/ecommerce/discount` with `{ "code": "...", "giftCardCode": "..." }` prices a discount code, a gift card or both against the shopper's basket, only while checkout is enabled. It checks, in order: the checkout flag (503 "Checkout is disabled"), same origin (403), and the body (400 "Enter a discount or gift card code"). Codes may be up to 200 characters.

- **Limits.** The preview and every checkout that carries a `discountCode` or `giftCardCode`, through the route or the `checkout` action, share one code-check budget: 30 per client network (an IPv4 address or an IPv6 /64, from `CF-Connecting-IP`) and 10 per basket per hour, in fixed one-hour windows in `_ecommerce_rate_limits`. Over either limit the routes answer HTTP 429 `{ "error": "Too many code checks. Please try again later." }` and the action throws `ActionError` `TOO_MANY_REQUESTS`. A checkout without a code is not counted. Without a client IP, as in local development, only the basket limit applies. The limits are code constants, not settings; handle a 429 from checkout as well as from the preview.
- **One refusal.** Every refusal of an entered code, in the preview and at checkout, answers HTTP 409 `{ "error": "This code is not valid for this order.", "field": "code" }` (or `"field": "giftCardCode"`), including one used up while the order is reserved, and in the preview a code of the wrong shape. At checkout, a discount code over 32 characters or a gift card code over 37 fails input validation first: the route answers HTTP 400 "Invalid checkout details" and the action an input validation error. The `checkout` action throws `ActionError` `CONFLICT` with the same message. The reason stays on the server in `DiscountCodeRefusal` and `GiftCardRefusal`, which carry a reason code; `codeRefusalBody(error)` from `/promotions` maps them to the shopper-facing body, and `evaluateDiscountCode` and `evaluateGiftCard` keep their detailed messages for other callers.
- **What it decides from.** The preview uses only the basket and the signed-in shopper's own account. It accepts `customerEmail` but ignores it. First-order and per-customer rules are checked in the preview only for a signed-in shopper, against that account; for a guest they are checked at checkout with the checkout email, so a guest's preview can show a price for a code that checkout then refuses. The preview links a browser basket to a signed-in account like the cart route, and never creates a basket: 404 "Basket not found" without a basket cookie, and 409 "Basket is not available for discounts" for a missing, empty or locked basket.

The implementation uses USD throughout: item prices, credit balances, and Stripe coupons are all USD cents. Do not reuse the credit balance for another currency without a separate per-currency balance and ledger. Read-only Commerce collections expose referral codes, qualified referrals, and credit entries to administrators for reconciliation. Migrate the database before deploying code that reads these tables or fields.

## Gift cards

Purchased gift cards are separate from discounts and account referral credit. `POST /api/ecommerce/gift-cards` starts a standalone Stripe purchase for $5–$1,000 USD. A card is issued only after a signed, paid Checkout webhook matches the pending purchase amount, currency, and session. Duplicate webhooks cannot issue twice. The buyer returns to `/gift-cards/success` in the same browser to copy the private code and share it manually; email delivery is not configured. The buyer access cookie lasts seven days. The code is stored as a SHA-256 lookup hash plus an AES-GCM encrypted copy, using the required `TALISMAN_COMMERCE_GIFT_CARD_KEY` secret (64 hex characters). Keep that key stable and backed up, or previously purchased codes cannot be displayed again.

Set `TALISMAN_COMMERCE_GIFT_CARDS_ENABLED=true` only after configuring the encryption key, Stripe secrets, signed webhook, and migration. Talisman offers purchase and code-based balance lookup at `/gift-cards`; the shared CMS administration screen is at `/admin/extensions/commerce-gift-cards`. Admins can issue a card with an audit reason, suspend/reactivate cards, refund gift card tender in part, and fully refund orders paid without Stripe. Purchased cards that receive a provider refund are voided if unspent; a spent or partially refunded purchase is suspended for manual review. The admin API exposes only a card's code suffix and balance. Admin-issued codes are shown once in the issuance response.

Checkout accepts one gift card alongside one promotion code and earned shopper credit. The order records each source separately: `subtotal_amount = discount_amount + credit_applied + gift_card_applied + total_amount`. D1 triggers reserve gift card balance with the pending order and release it on cancellation or refund. A card that covers the remaining total can settle an order without a Stripe session. For a split payment, the existing Stripe Checkout adapter uses a single-use coupon to charge the card remainder; the internal order and ledgers retain the distinct promotion, credit, gift card, and provider amounts. Full provider refunds restore any gift card amount not already restored by an admin partial refund.

### Single-use checkout coupons

Each discounted Stripe checkout (a promotion, store credit or gift card applied) creates one coupon with the id `<order id>_discount` (`checkoutCouponId(orderId)` from `@talisman-cms/plugin-ecommerce/adapters/stripe`), `max_redemptions: 1` and `redeem_by` at the session's `expires_at`. Checkout Sessions for plugin orders last 31 minutes, because Stripe needs at least 30 minutes after creation and the coupon is created first. The coupon is deleted when its order is cancelled (by the `checkout.session.expired` webhook, by reconciliation, or by a shopper or admin cancel), when a session expires for an order that was never recorded, and when checkout fails after the session was requested. Deletion is best effort: a failure logs `[commerce] Checkout discount could not be discarded` with the provider, error name and code, and never blocks releasing stock, credit, gift card or promotion reservations; the coupon still cannot be redeemed after its `redeem_by`. Coupons created by earlier versions have random ids and are not deleted automatically; unused ones can be deleted in the Stripe dashboard.

Gift card purchases cannot use promotions, gift cards, or referral credit, which prevents circular funding. Currency is fixed at USD. Automated recipient email, multiple gift cards on one order, and market-specific tax treatment are outside this implementation.

## Admin test checkout

The admin test checkout is off by default. Enable it with `ecommercePlugin({ adminTestCheckout: true })` on a site whose administrators need to exercise checkout without charging a card. It adds the **Test checkout** screen and the protected `/admin/api/ecommerce/test-checkout` route. Without the option, neither is injected and the simulated provider is never registered.

The `admin_test` adapter simulates a successful payment without contacting Stripe. The protected `GET /admin/api/ecommerce/test-checkout` returns the current basket quote for the CMS screen. `POST` requires a Talisman CMS administrator, a same-origin request, and the current basket cookie. It uses the same product validation, basket lock, order creation, and payment finalization as Stripe checkout. Orders and payment rows identify `admin_test` as the provider. No card is charged, sellable stock is not reduced, and test orders cannot be fulfilled. The endpoint works even when public Stripe checkout is disabled.

`PaymentProviderAdapter` handles provider session creation, expiry, and optional webhook validation. Two optional methods support the rules above: `getDisputeStatus(paymentIntentId)` returns `'none'`, `'open'` or `'lost'`, and referral awards are released only after it answers `'none'`; `discardCheckoutDiscount(orderId)` deletes the provider-side discount of an expired or cancelled checkout and resolves when there is nothing to delete. `StripePaymentAdapter` implements both. `createFromCart` selects an adapter by `providerId` and stores that choice on the order; cancellation and resumption use the stored provider. Without a `providerId` it uses the only registered adapter, but never `admin_test`. A second real payment provider can be registered alongside Stripe, but it still needs its own authenticated webhook route and shopper checkout route or provider selector. `runtimePaymentAdapters(env)` returns only real providers (Stripe when configured). The admin test route adds `AdminTestPaymentAdapter` itself, and the public checkout route and action always request `stripe`. Public order status checks never settle a pending `admin_test` order. Placing the test order again from the same basket completes an interrupted one, and the basket's owner can cancel it with `cancelCheckout`. Unless the caller registered `AdminTestPaymentAdapter`, `reconcileCommerce` cancels one left pending for 15 minutes, which unlocks the basket, and it keeps reconciling the real orders behind it. Never register it for a public route.

Products must be active, have a positive price, and have available stock before checkout. For physical products, the checkout request must include a shipping address with name, line 1, city, postal code, and two-letter country code. Shipping is currently included in the item price. Configure taxes, shipping policy, refunds, and fulfillment before enabling live sales.

## Shared component inventory

The commerce plugin can stock physical components that are used by more than one sellable variant. Apply the Talisman CMS migrations through `0008_shared_components.sql` before using this feature.

1. Create one **Product** for each frame model. Its `sku` is the model SKU.
2. Create a **Product Variant Value** for each sellable frame and lens choice. Its `sku` identifies that finished choice.
3. Create **Shared Components** for physical stock, such as a frame body and a lens pair. Each component has its own SKU and available quantity.
4. Add **Variant Components** rows for every part consumed by each variant value. For example, Mycelium + Golden Hour can consume one Mycelium frame and one Golden Hour lens pair; another frame model can consume a different frame component and the **same** lens component.

When a variant value has component rows, checkout uses its component quantities instead of its dedicated stock row. Include **all** physical parts in the bill of materials for that choice. A variant value with no component rows keeps the existing dedicated stock behavior. A component quantity is measured in the units of that component SKU: if a lens component SKU represents a pair, set its units per item to `1`.

Checkout sums component demand across the entire cart and reserves it in an atomic D1 batch with the pending order. A paid order keeps that reservation as consumed stock. Cancelling an order expires its open payment session before returning the stock; an expired Stripe Checkout session also returns it through the webhook. Cancellation restores the same persisted cart so the customer can edit it and try again. Configure Stripe's `checkout.session.expired` webhook event when using Stripe. A preparation lock left by an interrupted Worker request is released after 35 minutes only if no pending order exists, beyond the configured 31-minute Stripe session lifetime.

The current commerce plugin has one shopper-selectable variant value per cart line. Multi-axis options such as frame finish, size, and lens tint must be represented as distinct sellable values until a multi-option configurator is added. Shared components keep stock pooled even when those values belong to different products.
