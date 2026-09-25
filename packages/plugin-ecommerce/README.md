# Code-first catalog, then Commerce editing

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

The plugin groups native records under **Commerce**: products and catalog setup, shoppers and carts, promotions and referrals, gift card activity, and audit records. It also provides four task-focused screens inside the Talisman CMS admin shell: orders and fulfillment, promotions, gift cards, and test checkout. Registering `ecommercePlugin()` adds them to the Commerce workspace. The site still provides its public storefront, basket, checkout, and account pages.

```js
ecommercePlugin()
```

The default paths are `/admin/extensions/commerce-orders`, `/admin/extensions/commerce-promotions`, `/admin/extensions/commerce-gift-cards`, and `/admin/extensions/commerce-test-checkout`. A store can override task links with same-origin `adminPages` paths when it has a genuinely store-specific workflow. The plugin owns the protected commerce APIs and shared operation screens. No database migration is needed for this UI change.

# Shared component inventory

## Hosted Stripe checkout

`ecommercePlugin()` provides the cart, checkout, order status, and Stripe webhook routes. An app only needs to register the plugin and render its own cart and checkout pages. The separate `plugin-stripe` package handles Stripe resource sync and is not required for payments.

Apply Talisman CMS migrations through `0018_entry_revision_integrity.sql`. The cart lives in D1 and is keyed by a 30-day, HTTP-only, SameSite browser cookie. A cart version prevents concurrent edits from overwriting each other. Starting checkout locks the cart, creates a 30-minute hosted Stripe session, and atomically reserves component and ordinary stock before returning the payment URL. A cancelled or expired session releases stock and unlocks the same cart. A paid webhook closes the cart and records one payment even if Stripe retries the event.

After a confirmed real payment, the plugin links the paid order and basket to a shopper account. It creates a passwordless account for a first-time checkout email, or reuses the account for an existing email. A signed-in shopper's order stays on their authenticated account even if they enter a different checkout email. Shopper accounts live separately from CMS administrator users. **Payment and basket possession do not sign a shopper in.** The browser calls `requestCustomerEmailSignIn(email)` and receives a one-time link at that address; the storefront renders `/account/verify?token=...` and calls `verifyCustomerEmailSignIn(token)` when the shopper confirms. The link expires after 15 minutes and can be used once. The resulting HTTP-only shopper session lasts 30 days. `GET /api/ecommerce/account` reads the current account and `DELETE` signs out, clearing both shopper and basket cookies. An expired shopper session cannot use its old basket cookie to access an account basket. A storefront with a verified sign-up or SSO flow can pass the authenticated account ID to `api.carts.getOrCreate(sessionToken, accountId)` to attach the current guest basket. If both the guest and account baskets contain items, the API preserves them until the shopper explicitly chooses one with `chooseCustomerBasket('browser' | 'account')`.

Email sign-in uses the Resend HTTP API when `RESEND_API_KEY`, `GALAXY_COMMERCE_EMAIL_FROM`, and `GALAXY_COMMERCE_PUBLIC_ORIGIN` are configured as Worker bindings. The public origin must match the request origin; it prevents links from being built from an untrusted Host header. Configure a verified sender domain before enabling account sign-in. The account API returns the same accepted response for known and unknown addresses and limits each account to three requests per ten minutes. Migration `0016_verified_customer_sessions.sql` revokes old unverified sessions created by the previous basket-based activation flow. The old `activateNewCustomerAccount` helper no longer grants access.

Configure Worker secrets at runtime:

```text
GALAXY_COMMERCE_CHECKOUT_ENABLED=true
GALAXY_COMMERCE_STRIPE_MODE=test
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Test mode is the default. To accept live payments, set `GALAXY_COMMERCE_STRIPE_MODE=live` explicitly and provide a matching `sk_live_...` key. Both Stripe secrets are required. Never place them in `astro.config`, CMS globals, or browser code. Stripe Checkout collects card details; the app should collect and validate contact and delivery details before calling `POST /api/ecommerce/checkout`.

Configure Stripe to send `checkout.session.completed`, `checkout.session.expired`, and `charge.refunded` to `/api/ecommerce/webhooks/stripe`. The completed event is accepted only when Stripe reports a paid session whose ID, amount, and currency match the order. The browser can read its own order status with `GET /api/ecommerce/order?order=...` and release an open payment session with a same-origin `POST /api/ecommerce/order` body of `{ "orderId": "..." }`. `POST /api/ecommerce/checkout` resumes an existing open Stripe session for the same cart.

The order status route also checks Stripe when an order remains pending. Call the protected `POST /admin/api/ecommerce/reconcile` endpoint for manual recovery, or run `reconcileCommerce({ env, paymentAdapters: runtimePaymentAdapters(env) })` from a scheduled Worker. It checks old pending sessions and releases orphaned `preparing:` locks only after 35 minutes, beyond the 30-minute Stripe session lifetime. Schedule it at least every ten minutes and alert on reported errors. Keep the signed webhook configured; reconciliation is a backstop.

The protected `GET /admin/api/ecommerce/fulfillment` lists recent real orders and audit records. `POST` accepts `{ "orderId": "ord_...", "carrier": "...", "trackingNumber": "...", "note": "..." }` and marks only a paid real order fulfilled. The database trigger records the administrator and rejects duplicate fulfillment or admin test orders. The CMS operation screen uses these endpoints. Connect them to the store's packing and shipping process; issuing labels and customer shipment emails are separate integrations.

## Referral credit

`@talisman-cms/plugin-ecommerce/referrals` issues a random code for each shopper account and exposes a read-only balance and activity view. A storefront can use `findReferralCode` to validate a share link and save it in an HTTP-only `talisman-referral` cookie. The public checkout route reads that cookie; callers cannot set the referral on a payment directly. By default, a first paid Stripe order of at least $50 USD creates a $10 USD credit award for the referrer and the new shopper; admins can change both amounts. Existing shoppers, self-referrals, admin test orders, failed payments, and repeat webhooks do not award credit. A full refund voids the referral and reverses both awards. A partial refund records the provider refund but retains awards until the order is fully refunded.

An administrator can manage referral availability, the reward, minimum first order, 1–90 day link lifetime, and individual shopper links through the protected promotions API. Saved settings override the `GALAXY_COMMERCE_REFERRAL_MIN_ORDER_CENTS` and `GALAXY_COMMERCE_REFERRAL_REWARD_CENTS` Worker defaults. The applicable reward is saved on the pending order so a later config change cannot alter its payout. The threshold applies to the first paid purchase's item subtotal; a smaller first purchase does not qualify later orders. Local $1 test catalog items need a lower local threshold if you want to exercise referrals through Stripe test mode.

The order records `subtotal_amount` (items), `discount_amount` (code), `credit_applied` (shopper balance), `total_amount` (Stripe charge), `payment_intent_id`, and cumulative `provider_refunded_cents`. An immutable `_ecommerce_credit_ledger` records each award, checkout reservation, release, and refund reversal; a database trigger updates the shopper's balance. A checkout reserves at most the available balance and leaves at least $0.50 for Stripe. Stripe receives the combined promotion and store credit as an exact fixed coupon. Its signed paid webhook must confirm the reduced `total_amount`; the reservation then remains spent. Cancellation restores credit once. A full provider refund restores any credit used on that order. If an awarded credit was already spent when its qualifying purchase is refunded, the account balance can go negative; later awards offset the adjustment before credit can be used again.

## Discount codes and credit vouchers

The protected `GET` and `POST /admin/api/ecommerce/promotions` endpoint provides validated administration of referral settings and discount codes. The CMS screen is at `/admin/extensions/commerce-promotions`. Administrators can create codes, edit descriptions, dates, use limits, and active status, and pause shopper referral links. Financial terms, product scope, and code type are fixed at creation; pause an old code and create a new one to change those terms. Commerce collections for policies, codes, redemptions, and the credit ledger are read-only audit views.

- **Amount:** a fixed USD amount off each eligible order.
- **Percent:** a percentage in basis points, with an optional USD cap.
- **Credit voucher:** a server-generated, random bearer code with a remaining USD balance; partial redemptions carry forward to later orders.

Codes can specify a minimum item subtotal, eligible product IDs, first-purchase eligibility, start and expiry times, total uses, and uses per shopper. One code can be used per order and it can combine with the shopper's earned store credit. The checkout server computes the discount from current product prices, then applies shopper credit, leaving at least a $0.50 USD card payment. Its D1 transaction reserves code usage, voucher balance, store credit, inventory, and the pending order together. A cancelled checkout releases all reservations. A verified paid webhook confirms the code use once. A full refund releases its use and restores voucher balance; a partial refund leaves the code use confirmed until fully refunded. The percentage and fixed offers are discounts, not cash balances.

The implementation uses USD throughout: item prices, credit balances, and Stripe coupons are all USD cents. Do not reuse the credit balance for another currency without a separate per-currency balance and ledger. Read-only Commerce collections expose referral codes, qualified referrals, and credit entries to administrators for reconciliation. Migrate the database before deploying code that reads these tables or fields.

## Gift cards

Purchased gift cards are separate from discounts and account referral credit. `POST /api/ecommerce/gift-cards` starts a standalone Stripe purchase for $5–$1,000 USD. A card is issued only after a signed, paid Checkout webhook matches the pending purchase amount, currency, and session. Duplicate webhooks cannot issue twice. The buyer returns to `/gift-cards/success` in the same browser to copy the private code and share it manually; email delivery is not configured. The buyer access cookie lasts seven days. The code is stored as a SHA-256 lookup hash plus an AES-GCM encrypted copy, using the required `GALAXY_COMMERCE_GIFT_CARD_KEY` secret (64 hex characters). Keep that key stable and backed up, or previously purchased codes cannot be displayed again.

Set `GALAXY_COMMERCE_GIFT_CARDS_ENABLED=true` only after configuring the encryption key, Stripe secrets, signed webhook, and migration. Talisman offers purchase and code-based balance lookup at `/gift-cards`; the shared CMS administration screen is at `/admin/extensions/commerce-gift-cards`. Admins can issue a card with an audit reason, suspend/reactivate cards, refund gift card tender in part, and fully refund orders paid without Stripe. Purchased cards that receive a provider refund are voided if unspent; a spent or partially refunded purchase is suspended for manual review. The admin API exposes only a card's code suffix and balance. Admin-issued codes are shown once in the issuance response.

Checkout accepts one gift card alongside one promotion code and earned shopper credit. The order records each source separately: `subtotal_amount = discount_amount + credit_applied + gift_card_applied + total_amount`. D1 triggers reserve gift card balance with the pending order and release it on cancellation or refund. A card that covers the remaining total can settle an order without a Stripe session. For a split payment, the existing Stripe Checkout adapter uses a one-time coupon to charge the card remainder; the internal order and ledgers retain the distinct promotion, credit, gift card, and provider amounts. Full provider refunds restore any gift card amount not already restored by an admin partial refund.

Gift card purchases cannot use promotions, gift cards, or referral credit, which prevents circular funding. Currency is fixed at USD. Automated recipient email, multiple gift cards on one order, and market-specific tax treatment are outside this implementation.

## Admin test provider

The `admin_test` adapter simulates a successful payment without contacting Stripe. The protected `GET /admin/api/ecommerce/test-checkout` returns the current basket quote for the CMS screen. `POST` requires a Talisman CMS administrator, a same-origin request, and the current basket cookie. It uses the same product validation, basket lock, order creation, and payment finalization as Stripe checkout. Orders and payment rows identify `admin_test` as the provider. No card is charged, sellable stock is not reduced, and test orders cannot be fulfilled. The endpoint works even when public Stripe checkout is disabled.

`PaymentProviderAdapter` handles provider session creation, expiry, and optional webhook validation. `createFromCart` selects an adapter by `providerId` and stores that choice on the order; cancellation and resumption use the stored provider. A second real payment provider can be registered alongside Stripe, but it still needs its own authenticated webhook route and shopper checkout route or provider selector. Never expose the admin test provider through a public checkout route.

Products must be active, have a positive price, and have available stock before checkout. For physical products, the checkout request must include a shipping address with name, line 1, city, postal code, and two-letter country code. Shipping is currently included in the item price. Configure taxes, shipping policy, refunds, and fulfillment before enabling live sales.

The commerce plugin can stock physical components that are used by more than one sellable variant. Apply the Talisman CMS migrations through `0008_shared_components.sql` before using this feature.

1. Create one **Product** for each frame model. Its `sku` is the model SKU.
2. Create a **Product Variant Value** for each sellable frame and lens choice. Its `sku` identifies that finished choice.
3. Create **Shared Components** for physical stock, such as a frame body and a lens pair. Each component has its own SKU and available quantity.
4. Add **Variant Components** rows for every part consumed by each variant value. For example, Mycelium + Golden Hour can consume one Mycelium frame and one Golden Hour lens pair; another frame model can consume a different frame component and the **same** lens component.

When a variant value has component rows, checkout uses its component quantities instead of its dedicated stock row. Include **all** physical parts in the bill of materials for that choice. A variant value with no component rows keeps the existing dedicated stock behavior. A component quantity is measured in the units of that component SKU: if a lens component SKU represents a pair, set its units per item to `1`.

Checkout sums component demand across the entire cart and reserves it in an atomic D1 batch with the pending order. A paid order keeps that reservation as consumed stock. Cancelling an order expires its open payment session before returning the stock; an expired Stripe Checkout session also returns it through the webhook. Cancellation restores the same persisted cart so the customer can edit it and try again. Configure Stripe's `checkout.session.expired` webhook event when using Stripe. A preparation lock left by an interrupted Worker request is released after 35 minutes only if no pending order exists, beyond the configured 30-minute Stripe session lifetime.

The current commerce plugin has one shopper-selectable variant value per cart line. Multi-axis options such as frame finish, size, and lens tint must be represented as distinct sellable values until a multi-option configurator is added. Shared components keep stock pooled even when those values belong to different products.
