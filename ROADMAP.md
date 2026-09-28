# Roadmap

This is the plan for Talisman CMS after the 0.1 preview (`talisman-cms` 0.1.0 and the plugins at 0.0.1). Work is grouped into workstreams. Each workstream except Release and the rehearsal has a tracking issue, and each item below has its own issue. "Audit refs" are the keys of findings from the pre-release audit of 25 September 2026; the issues carry the details.

Known hardening work for the preview plugins is tracked here as the rules the code should enforce, without exploitation detail. Report new vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues. Site-specific launch work is tracked in each site's own repository.

## Done

Since the last public commit (`0d1d72d`), `main` has gained `HybridAuthAdapter`, the shared CMS identity and migration `0019`, which were added just before the pre-release audit and reviewed by it, and the fixes that followed the audit. Among other things, these changes:

- made the packages installable outside the workspace (ESM-only builds, declared peers, a packed-tarball smoke test in `pnpm release:verify`, a pnpm-only publish script, `prepack` builds and a CI check that the committed `dist/` matches the source);
- renamed settings to `TALISMAN_*`, with `GALAXY_*` still read as a fallback;
- added `HybridAuthAdapter` (local editor passwords, Cloudflare Access SSO for admins) and the shared CMS identity for shoppers, and hardened both after the audit;
- closed role and concurrency gaps in the content API: `expectedRevisionId` with 409/428, baseline revisions for seeded entries, draft slugs, unique slugs, admin-only global creation, bounded request bodies, paged lists and 4xx instead of 500;
- made media deletion remove the stored file, and cached media for an hour with ETag revalidation instead of a year;
- moved email to Cloudflare Email Service and removed Resend;
- hardened the ecommerce plugin: exported cookie names, a bounded basket API, sign-in links that create an account only when used, per-address, per-network and store-wide sign-in limits, a discount preview that answers only while checkout is enabled, and a scheduled retention purge;
- added a safe rich-text renderer, closed injection sinks in the daisyUI and Starwind plugins, and required a CMS session for plugin admin routes;
- pinned CI actions, added a production dependency audit and SECURITY.md;
- added migrations `0019` through `0030`;
- enforced the [incentives and abuse](#commerce-launch-incentives-and-abuse) rules in the ecommerce plugin without a further migration: referrals off by default with held awards, a rate-limited discount preview with one refusal, a Turnstile check and a reserved budget for sign-in email, a limit on new baskets per network, a throttled order status check and single-use Stripe coupons;
- settled the [commerce launch decisions](#commerce-launch-decisions) in the ecommerce plugin: a configurable store currency, delivery countries, shipping rates and Stripe Tax, money scaled by each currency's minor units, and Stripe's presentment currency pinned to the order currency, with migration `0025` recording shipping and tax on orders;
- built the [order operations](#commerce-launch-order-operations) in the ecommerce plugin, with migrations `0026` to `0030`: fulfillment recorded apart from payment and a server-side queue of every order to ship, dispute handling, dated refunds and an audited restock, reconciliation that backs off and parks permanent failures for review, order confirmation and shipment emails, gift card claim links, review decisions, replacement cards and key rotation, batched option saves and checkout queries, and a stock concurrency token that moves on every write.

[CHANGELOG.md](CHANGELOG.md) lists every change, the breaking changes and the upgrade steps.

## Workstreams

| Workstream | Purpose | Order and dependencies |
| --- | --- | --- |
| [Release](#release) | Publish the 0.1 preview | First. Maintainer steps only, no issues |
| [After publish](#after-publish) | One auth copy per Worker, no route generation in installed packages, then publishing from CI instead of committing `dist/` | After the first publish. The CI publish comes last, once sites install from npm |
| [Commerce launch: decisions](#commerce-launch-decisions) | Plugin support for currency, tax, shipping and delivery countries | Done before the 0.1 publish; follow-ups are listed in its items |
| [Commerce launch: order operations](#commerce-launch-order-operations) | Queue, fulfillment, refunds, reconciliation, notifications, gift cards, inventory | Done before the 0.1 publish; follow-ups are listed in its items |
| [Commerce launch: incentives and abuse](#commerce-launch-incentives-and-abuse) | Rules for referrals, discounts, sign-in email and public endpoints | Done before the 0.1 publish; follow-ups are listed in its items |
| [Commerce launch: shopper pages](#commerce-launch-shopper-pages) | Order access, basket handover, errors and catalog reads for storefronts | Checkout stays disabled until the commerce workstreams are done |
| [Commerce launch: data and GDPR](#commerce-launch-data-and-gdpr) | Shopper data export and erasure, ledger invariants, safe role defaults | Same gate |
| [Commerce launch: tests](#commerce-launch-tests) | Race and negative tests for the money paths | Alongside the fixes they cover |
| [Commerce launch: rehearsal](#commerce-launch-rehearsal) | One real low-value order end to end | Last |
| [Post-release architecture](#post-release-architecture) | Service layer, Plugin API v2, core/plugin boundary, admin UX, SSO | Service layer merge, then Plugin API v2, then the core/plugin boundary. Admin UX and SSO in parallel |
| [Maintenance](#maintenance) | Smaller fixes that fit nowhere else | Any time |

Public checkout stays off (`TALISMAN_COMMERCE_CHECKOUT_ENABLED=false`) until the commerce launch workstreams are done and the [commerce launch gates](packages/plugin-ecommerce/PRODUCTION_READINESS.md) pass.

## Release

The maintainer steps for the 0.1 preview are in [RELEASE.md](RELEASE.md): verify a clean checkout of `main` (`pnpm release:verify`, `node scripts/check-dist-drift.mjs`, `pnpm audit --prod --audit-level high`), push `main`, run `pnpm release:publish --dry-run` and then publish. Sites that upgrade apply migrations `0019` through `0030` before deploying the new Worker, as the [deployment gate](RELEASE.md#deployment-gate) describes. The incentive and abuse rules ship in the same release and need no further migration; the deployment gate lists their settings and the Stripe webhook event to add. The currency, delivery, shipping and tax settings ship in it too, with migration `0025`; a site that sets none of them behaves as before. So do the order operations, with migrations `0026` to `0030`: they add the `charge.dispute.created` webhook event, and their emails need the email settings and store details.

Three audit findings that were to be settled before the npm release are only partly fixed, and are accepted for 0.1: a built Worker still carries two copies of the auth modules, builds still print route-injection lines and the playground keeps scratch pages, and the schema types `media.updatedAt` as not null. Their remaining work is tracked below under [After publish](#after-publish) and [Maintenance](#maintenance) (`integration-contract/src-dist-dual-auth-modules`, `release-packaging/debug-leftovers`, `migrations-schema/drizzle-kit-snapshot-drift`).

## After publish

Until the packages are on npm, `packages/*/dist` is committed, so sites that link the workspace get built output. Every source change then needs a separate rebuild commit, and CI checks that the two match. Once sites install from npm, the build can move into CI at publish time.

Order: the first two items can start right after the first publish. Publishing from CI comes last, once sites have switched to the npm packages.

### Inject built routes so a Worker carries one copy of the auth code

**Why:** The integration injects the core's own routes (SSO, setup, the API handler) from `src/`, while site code imports `dist/`. A Worker therefore bundles the auth, guard and database modules twice, and a fix that reaches one copy can miss the other.

**Approach:** Build the route files as tsup entries and inject the built route when it exists, as the plugins already do, or import auth through the package's own exports (`talisman-cms/auth/local`, `talisman-cms/auth/guard`). Add a check to the packed smoke test that the auth module appears once in the built Worker.

**Audit refs:** `integration-contract/src-dist-dual-auth-modules`

**Issue:** #TBD-publish-single-auth-copy

### Keep the TanStack route generator out of installed packages

**Why:** The integration always registers `TanStackRouterVite` with the generated route tree inside the package. In a site's `node_modules` that can rewrite an installed package, and the caret range on the generator lets its output change between installs.

**Approach:** The route tree ships prebuilt. Disable generation (`enableRouteGeneration: false`, or skip the plugin) when the package is inside `node_modules`, and pin the generator version exactly.

**Audit refs:** `gap2-gap2-consumer-install-devmode/tanstack-generator-runs-on-node-modules`

**Issue:** #TBD-publish-route-generator

### Publish from CI with provenance, and stop committing `dist/`

**Why:** Publishing runs on a maintainer's machine without npm provenance, and the committed `dist/` makes every source change a two-commit change guarded by a drift check.

**Approach:** Remove `packages/*/dist` from git and ignore it. Add a publish workflow, started by a version tag, that runs `pnpm release:verify` and `pnpm release:publish --provenance` with `id-token: write` (npm trusted publishing). Keep the `prepack` builds, remove the drift check from CI and RELEASE.md, and update RELEASE.md's publishing section. Depends on sites no longer linking the workspace.

**Audit refs:** `secrets-supply-chain/ci-supply-chain-hardening`

**Issue:** #TBD-publish-ci-provenance

## Commerce launch: decisions

Before a store opens checkout, its owner decides where it sells, in which currency, how tax and shipping are charged, and what the returns policy is. Those are business decisions; the plugin has to support them. Both items below are done, so the order-operations work that touches totals can build on them.

### Make currency, tax, shipping and delivery countries configurable

**Status:** done on `main` before the 0.1 publish. Worker settings set the store currency (`TALISMAN_COMMERCE_CURRENCY`, default `usd`), the delivery countries (`TALISMAN_COMMERCE_DELIVERY_COUNTRIES`, officially assigned ISO 3166-1 codes, checked when something ships), up to ten shipping rates (`TALISMAN_COMMERCE_SHIPPING_RATES`) and the tax mode (`TALISMAN_COMMERCE_TAX`: `none`, `stripe-inclusive` or `stripe-exclusive`, with an optional `TALISMAN_COMMERCE_TAX_CODE` and `TALISMAN_COMMERCE_SHIP_FROM_COUNTRY`). A store that sets none of them behaves as before, and an invalid value closes checkout with a generic 503 and a log line. Tax is calculated with the Stripe Tax API before payment rather than with `automatic_tax`, recorded as a transaction once the order is paid and reversed in part for each refund. Orders record their shipping and tax (migration `0025`), and the redemption guards check totals that include them. The admin, the storefront components, analytics and the playground scale money by each currency's minor units. Gift cards stay in USD, the only currency their tables hold, and are refused in a store with another currency. Follow-ups are listed under [Orders queue](#orders-queue-every-order-awaiting-shipment-with-names-and-labelled-amounts), [Refunds, restocking and disputes](#refunds-restocking-and-disputes), [Reconciliation](#reconciliation-indexes-backoff-and-a-review-state-for-stuck-orders), [Validate checkout input](#validate-checkout-input-the-same-way-in-the-action-and-the-route) and [Enforce ledger and stock invariants](#enforce-ledger-and-stock-invariants-in-the-database), and the Stripe Tax setup and test-mode checks are launch gates 10 to 12 in [PRODUCTION_READINESS.md](packages/plugin-ecommerce/PRODUCTION_READINESS.md).

**Why:** A store sells in its own currency, to the countries it serves, and charges the tax and shipping its business needs, so these have to be settings rather than code, and every amount has to be scaled by its currency's minor units instead of divided by 100.

**Approach:** Add store settings (or plugin options) for the currency, the allowed delivery countries, the tax mode (Stripe Tax, or none) and shipping rates. Use the configured currency everywhere an order or gift card is created, checked or redeemed. Pass the settings to the payment session, check the country against the allowlist on the server, and record tax and shipping on the order. Format and scale money by each currency's minor units (`Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits`) in analytics, the admin and the storefront components.

**Audit refs:** `commerce-checkout/no-tax-or-shipping-in-totals`, `analytics-plugin/money-assumes-two-decimals`

**Issue:** #TBD-commerce-currency-tax-shipping

### Pin the Stripe presentment currency to the order currency

**Status:** done on `main` before the 0.1 publish. Every Checkout Session sets `currency` to the order currency and `adaptive_pricing: { enabled: false }`, and its line items and coupon use that currency, so Stripe never presents another; confirmation and refunds still compare the amount and currency with the order. The test-mode run with a card and address outside the store's country is launch gate 11 in [PRODUCTION_READINESS.md](packages/plugin-ecommerce/PRODUCTION_READINESS.md). No further migration.

**Why:** Payment confirmation and refunds compare amount and currency strictly with the order. If Stripe shows the buyer a local currency (Adaptive Pricing), a captured payment may never confirm its order.

**Approach:** Disable Adaptive Pricing for checkout sessions or set the session currency explicitly. Alternatively, compare against Stripe's source-currency fields when they are present. Cover it in a test-mode run with a card and address outside the store's country.

**Audit refs:** `commerce-checkout/presentment-currency-mismatch-risk`

**Issue:** #TBD-commerce-presentment-currency

## Commerce launch: order operations

The admin tools and background jobs a store needs to run orders every day. All items below are done on `main` before the 0.1 publish, with migrations `0026` to `0030`, and each lists the follow-ups it leaves. They were built in the suggested order: fulfillment status first (its migration replaces the guard the queue depends on), then the queue, refunds and reconciliation, and order emails before gift card delivery, which reuses the sending path.

### Record fulfillment separately from payment status

**Status:** done on `main` before the 0.1 publish. Migration `0026` adds `_ecommerce_orders.fulfillment_status` (`unfulfilled`, `partially_fulfilled` or `fulfilled`), moves the old `fulfilled` status there, and rebuilds `_ecommerce_fulfillments` so that an order can ship in several parcels and a correction row restates a shipment's carrier and tracking number with the administrator and a reason. Its guard accepts `paid` and `partially_refunded` orders and refuses pending, cancelled, refunded, disputed and admin test orders; a refund never hides a shipment. Follow-ups: a completing shipment cannot be undone, even when the first of several parcels was recorded as the last; a partial shipment has no idempotency key, so a request retried after a lost answer records a second parcel; a partly shipped order whose remaining items are refunded needs a way to close without shipping; and fulfillment rows are append-only by convention, without triggers that enforce it.

**Why:** The fulfillment guard accepts only `paid` orders, so a partially refunded order can never be shipped, and a partial refund after shipping replaces `fulfilled`. Each order also has a single immutable fulfillment row, so a wrong tracking number cannot be corrected and split shipments are impossible.

**Approach:** Add a fulfillment status (or derive it from fulfillment rows) in a new migration that replaces `_ecommerce_fulfillment_guard` and accepts `paid` and `partially_refunded`. Stop refunds from overwriting the fulfillment state. Allow several shipment rows per order and append-only correction rows that name the actor and reason. Show the shipment form for every order that can still be fulfilled.

**Audit refs:** `commerce-ledgers-accounts/partially-refunded-orders-unfulfillable`, `commerce-ledgers-accounts/fulfillment-record-immutable-single`, `admin-ui/orders-queue-truncation`

**Issue:** #TBD-commerce-fulfillment-status

### Orders queue: every order awaiting shipment, with names and labelled amounts

**Status:** done on `main` before the 0.1 publish. The Orders screen reads a server-side queue of every paid or partially refunded real order awaiting shipment, oldest first, with a server count, cursor pages of 50 and search by exact order ID or email, sent in the request body. Rows show product names, variant labels and SKUs, the labelled amounts with shipping, tax and refunds, the payment and fulfillment status, and each shipment with its corrections; shopper order reads return `fulfillmentStatus`. No migration beyond `0026`. Follow-ups: show the currency next to the amounts of the read-only Orders collection; list the gift card value and store credit that a full refund returned; show administrators by name rather than user id; let `GET` refuse email searches, which the `POST` list action keeps out of URLs; and accept the order ids that `orders.create` generates, which the shipment form refuses.

**Why:** The queue loads the 100 newest orders and counts "Needs fulfillment" in the browser from that list, so older paid orders drop out of view. Rows show raw product and variant ids and the items subtotal without a label.

**Approach:** Query unfulfilled orders separately with cursor paging and a server-side count. Join product names, variant labels and SKUs at query time. Label the items subtotal and show the charged total with the discount, credit and gift card breakdown. Each order's panel already lists these totals, with shipping and tax, in the order currency; the read-only Orders collection should show the currency next to its amounts too. Depends on the fulfillment status item.

**Audit refs:** `admin-ui/orders-queue-truncation`

**Issue:** #TBD-commerce-orders-queue

### Refunds, restocking and disputes

**Status:** done on `main` before the 0.1 publish. The webhook handles `charge.dispute.created` and `charge.dispute.closed`: a dispute holds its order as `disputed`, which the fulfillment guard refuses, and keeps its referral award pending; a won dispute gives the order back its status, and a lost one refunds it in full, reversing its referral awards and its Stripe Tax transaction. A dispute of a gift card purchase suspends its cards, and a lost one voids their unspent value. An audited **Return stock** action returns a refunded order's stock with relative updates, once per reservation row. Migration `0028` adds `_ecommerce_disputes` and `_ecommerce_restocks`. Follow-ups: decide whether a lost dispute should keep the gift card and store credit tender for review instead of returning it, as a full refund does; decide whether gift card tender can be refunded while a card's dispute is open; and show disputes on the Gift cards screen, where only the Disputes collection lists them.

**Why:** Refunds never release stock, and chargebacks are handled only for referral awards, so a disputed order can still be shipped.

**Approach:** Subscribe to `charge.dispute.created`, add a `disputed` status that the fulfillment guard rejects, and extend the `charge.dispute.closed` handling, which already reverses referral awards on a lost dispute, to the order itself, including a full reversal of its Stripe Tax transaction. Add an audited admin "restock" action for refunded orders that releases stock with relative updates.

**Audit refs:** `commerce-checkout/refund-dispute-gaps`

**Issue:** #TBD-commerce-refunds-disputes-restock

### Record the date of each provider refund

**Status:** done on `main` before the 0.1 publish. Migration `0028` adds `_ecommerce_provider_refunds`, and each rise in an order's Stripe refund total adds a row dated by its Stripe event, computed in SQL in the batch that records the total, so retries and out-of-order events add nothing; a test races two refund events on a stale order. The analytics plugin counts refunds on those dates. Follow-ups: date a lost dispute by its close in analytics, which counts it on the payment date for now, and fill `provider_refund_id` on current Stripe API versions, whose `charge.refunded` events no longer list the refunds.

**Why:** The analytics plugin can report refunds by the date they were issued once `_ecommerce_provider_refunds` exists, but nothing creates or writes that table, so reports still count refunds on the payment date.

**Approach:** Add the table in a migration (id, order, provider, provider refund id, amount, created_at, with an index on the order). In `recordProviderRefund`, insert the difference between the new cumulative refund and the stored total in the same batch, guarded so retries and out-of-order webhooks add nothing. Test two refund events racing on a stale order.

**Audit refs:** `analytics-plugin/refunds-attributed-to-payment-date`

**Issue:** #TBD-commerce-refund-dates

### Reconciliation: indexes, backoff and a review state for stuck orders

**Status:** done on `main` before the 0.1 publish. Migration `0029` adds attempt, last-attempt, last-error and review columns to orders and gift card purchases, and indexes on pending orders by age, gift card purchases by status and date, payments by order, orders by checkout session and `galaxy_auth_verification(identifier)`. A row waits 2^attempts minutes, at most six hours, between attempts, rows never tried first; a missing session, a session of the other Stripe mode and a mismatched payment park the row for review, and the scheduled run fails only for newly parked rows and transient failures. The Orders screen lists parked checkouts, whose retry or release an administrator records with a reason in `_ecommerce_reconcile_decisions`; a release never asks Stripe about a session of the other mode, and releases a completed checkout only once its payment was refunded in full or lost to a dispute. The preparing-lock query reads a range of the unique index. Tax transactions and reversals that Stripe refuses are not parked: they back off on attempt counts of their own. Follow-ups: show earlier decisions in the review panel; return `paymentUnderReview` from `listCustomerOrders`; reconcile or clean up pending gift card purchases that never recorded a session; and report the preparation and admin test passes with codes instead of raw error text.

**Why:** The scheduled reconciliation picks the oldest pending orders and gift card purchases with `LIMIT 10`. A few that always fail block newer ones, and the queries scan whole tables because indexes are missing.

**Approach:** Add attempt, last-attempt and last-error columns and order the batch so failing rows move back. Park permanent failures (missing session, live/test mismatch, amount mismatch, and a tax transaction or reversal that Stripe refuses once its 24-hour idempotency key or 90-day calculation has expired) in a review status shown in the orders queue with a release action. Add indexes on orders and gift card purchases by status and date, payments by order, sessions by checkout id and `galaxy_auth_verification(identifier)`, and replace the `LIKE 'preparing:%'` scan with a range predicate. The scheduled handler should fail only for new or transient errors.

**Audit refs:** `perf-edge/reconcile-head-of-line-blocking`, `migrations-schema/missing-indexes-reconcile-webhook`

**Issue:** #TBD-commerce-reconcile-backoff

### Answer webhook events that match no order with 200

**Status:** done on `main` before the 0.1 publish. Events that name none of the store's orders or gift card purchases are answered `200 {ignored: true}` and logged at info level with their type and id only; events for a record they cannot apply to are logged at error level and answered 200 with a reason; a refund or dispute that arrives before its payment is recorded is answered 409, so Stripe retries it; unexpected failures are answered 500. Checkout sessions put the order or purchase id on the PaymentIntent, so refunds and disputes carry it. No migration. Follow-up: payments of sessions created before this release carry no such reference, so their early refunds and disputes are ignored rather than retried.

**Why:** A refund or completed session that does not belong to this store's orders is answered with 400 on every retry, and Stripe disables endpoints that keep failing.

**Approach:** Return `200 {ignored: true}` for events without this plugin's references. Keep a non-2xx answer only for transient states worth a retry, such as a refund that arrives before the payment is finalized.

**Audit refs:** `commerce-checkout/webhook-unlinked-events-return-400`

**Issue:** #TBD-commerce-webhook-ignore-unlinked

### Order confirmation and shipment emails

**Status:** done on `main` before the 0.1 publish. Paid orders get a confirmation with the items, the labelled amounts, the shipping address and the store's legal details and policy links, on every path that confirms a payment; recorded shipments get a notice with carrier and tracking number, and a correction made once it went out sends updated details. Each email is recorded in `_ecommerce_email_deliveries` (migration `0030`) in the batch of the change that calls for it, instead of a sent-at column, sent at once under a lease and retried by `reconcileCommerce` with backoff; a failed send never fails the payment, shipment or webhook. Stores override the templates with `ecommercePlugin({ emailTemplates })` and set their details with the `TALISMAN_COMMERCE_STORE_*`, `TALISMAN_COMMERCE_SUPPORT_EMAIL` and policy link settings. Follow-ups: counsel decides whether the confirmation must carry the terms' text rather than links; emails per market language, since the defaults are in English with UTC dates; format the default confirmation's amounts by the currency's minor units; a setting that turns order emails off; and each order's email status in the orders queue.

**Why:** The plugin sends sign-in links only. Shoppers get no order confirmation and no dispatch notice, which most markets expect and which stores otherwise do by hand.

**Approach:** Send an order confirmation after payment is confirmed (webhook and reconciliation paths alike) and a shipment email when fulfillment is recorded, through the existing email provider. Make each send idempotent with a sent-at column, and let stores override the templates.

**Audit refs:** none (commerce launch gate 6 in PRODUCTION_READINESS.md)

**Issue:** #TBD-commerce-order-emails

### Deliver gift card codes by email, with an admin resend

**Status:** done on `main` before the 0.1 publish. A paid purchase emails its buyer a one-time link, valid for 7 days, to `/gift-cards/claim`, which shows the code once; only the link's hash is stored (migration `0030`), and the delivery log, instead of a `delivered_at` column, keeps duplicate webhooks from sending twice. Admin card rows show the purchase id, buyer email and claim link, and an audited resend stops earlier links only once its own email was sent. A replacement card names its purchase, so a later refund holds it too. Follow-ups: the link goes to the buyer address typed at purchase, which is not verified, so decide on a shorter lifetime or a verified address; limit balance lookups per client network, as claims are; and avoid the retried failure when two confirmations of one purchase run at once.

**Why:** A purchased code can only be shown in the browser that paid, through a seven-day cookie. A buyer who changes device or clears cookies has no way to recover it.

**Approach:** After a purchase is confirmed, email the buyer a one-time, expiring claim link (not the code) and record `delivered_at` so duplicate webhooks do not send twice. Add an audited admin action to resend the claim link, and show the purchase id and buyer email on admin card rows.

**Audit refs:** `commerce-ledgers-accounts/gift-card-single-delivery-path`

**Issue:** #TBD-commerce-gift-card-delivery

### Admin action to resolve gift card purchases held for review

**Status:** done on `main` before the 0.1 publish. Held purchases are listed under **Gift cards → Held for review**: Reinstate takes the refund not yet taken off from the card that holds the purchase's value and reactivates the cards the hold suspended, and Void voids the cards with matching reversals once no checkout in progress holds value on them. Each decision needs a reason, is recorded in `_ecommerce_gift_card_reviews` (migration `0027`), and changes nothing if a refund was recorded in between. Follow-ups: an order refund that restores value to a replaced, void card leaves value that cannot be spent (see [Enforce ledger and stock invariants](#enforce-ledger-and-stock-invariants-in-the-database)); `getPurchasedGiftCard` shows no code once a purchase is reinstated as partially refunded, although its card is active again; and the Outstanding balance tile counts active cards only.

**Why:** A refunded purchase of a partly spent card puts the card in `suspended` and the purchase in `review`, and nothing can take it out again.

**Approach:** Add an audited "resolve review" action that either reinstates the card with a balance adjustment equal to the refund or voids it with a matching reversal.

**Audit refs:** `commerce-ledgers-accounts/gift-card-review-dead-end`

**Issue:** #TBD-commerce-gift-card-review

### Versioned gift card encryption key with rotation

**Status:** done on `main` before the 0.1 publish. Codes are stored as `v2:<key id>:<iv>:<ciphertext>` with the card id as AES-GCM additional data. `TALISMAN_COMMERCE_GIFT_CARD_PREVIOUS_KEYS` keeps older keys readable, codes from before key ids stay readable, and the **Code encryption** panel on the Gift cards screen re-encrypts them with the current key. The plugin README documents the rotation. The format needs no migration. Follow-up: the gift card purchase route should answer a misconfigured key with a generic message (see [Typed errors](#typed-errors-and-safe-messages-for-checkout-and-gift-card-purchases)).

**Why:** Codes are encrypted with one key and stored without a key id, so rotating or losing the key makes every code unreadable.

**Approach:** Prefix ciphertext with a key id, read a keyring (current plus previous keys), bind the card id as AES-GCM additional data, and document rotation.

**Audit refs:** `commerce-ledgers-accounts/gift-card-key-rotation`

**Issue:** #TBD-commerce-gift-card-key-rotation

### Save variant values and their stock in one batch

**Status:** done on `main` before the 0.1 publish. `POST <adminPath>/api/ecommerce/variants` saves a value with its stock, deletes a value, and deletes a group with its values, stock and variant component rows, each in one D1 batch that checks the loaded tokens first. The product editor uses it, keeps the edits after a refusal that wrote nothing, and reloads the rows after any other outcome. No migration. Follow-ups: these changes run no collection hooks on the variant collections; groups and definitions are still created through the core API, so a lost answer there can still leave a duplicate group; and a create whose answer was lost can still be repeated, until creates take a client-chosen id.

**Why:** The variant configurator saves a value and its stock in two requests and deletes groups one row at a time. A failure halfway leaves orphans, and a retry creates duplicates.

**Approach:** Add an admin endpoint that upserts a value with its stock, and deletes a group with its values and stock, in one D1 batch.

**Audit refs:** `admin-ui/variant-configurator-nonatomic`

**Issue:** #TBD-commerce-variant-batch-save

### Move the stock concurrency token on every stock write

**Status:** done on `main` before the 0.1 publish. Every plugin write to a stock column (reservations, releases, restocks and the options endpoint) stamps `updated_at = MAX(updated_at + 1, ?)`, and native updates in the core keep moving a stamp that runs ahead of the clock forward instead of resetting it after five minutes. A test saves stale stock after a reservation in the same second and gets 409. No migration. Follow-ups: the demo seed writes millisecond stamps (see [Demo seed](#demo-seed-seconds-and-no-overwrite-of-collections)), and checkout's stock writes do not clear cached reads, so storefronts read stock with `cache: false`.

**Why:** The admin's stale-edit check compares `updated_at`. Checkout reservations and releases set `updated_at = ?` to the current second, so an admin save in the same second as a reservation keeps the same token and can overwrite the reserved stock.

**Approach:** Stamp `updated_at = MAX(updated_at + 1, ?)` in every write to a stock column (reservations, releases, refund restocks, reconciliation), as the core admin writes already do. Test an admin save and a reservation in the same second followed by the admin's stale write, which must get 409.

**Audit refs:** none (follow-up from the fix rounds)

**Issue:** #TBD-commerce-stock-concurrency-token

### Batch the checkout queries

**Status:** done on `main` before the 0.1 publish. `quote()` and `createFromCart()` read a basket's catalog in one batch of `IN` queries chunked at 90 ids and reserve stock with one statement per stock table, so a quote takes 6 statements and a checkout at most 17 for any basket, as a test counts through the D1 shim. No migration. Follow-ups: index `_ecommerce_product_variants.product_id` and `_ecommerce_product_variant_values.product_variant_id`, which each quote scans, and make `orders.cancel` set-based like the reservations.

**Why:** Quoting and creating an order run several sequential D1 queries per basket line, plus one per component, so checkout latency grows with the basket and large baskets can exceed per-request query limits.

**Approach:** Load products, variant values, variants, stock, requirements and components for the whole basket with a few `IN` queries (chunked below D1's parameter limit) or one batch, then compute in memory.

**Audit refs:** `perf-edge/checkout-n-plus-one`

**Issue:** #TBD-commerce-checkout-batched-queries

## Commerce launch: incentives and abuse

Rules that keep promotions, referrals, gift cards and the public endpoints from being turned against the store. Each item states the rule to enforce.

### Referral awards: off by default, held until the return window closes

**Status:** done on `main` before the 0.1 publish. Referrals are off unless a saved policy or `TALISMAN_COMMERCE_REFERRALS_ENABLED` enables them; the reward is at most half the minimum, which applies after the promotion discount; self-referral and repeat-buyer checks compare canonical addresses; each referrer has a cap per period (`TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD`, `TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS`); awards stay pending for `TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS` and `reconcileCommerce` releases them when the provider reports no dispute; a refund below the qualifying amount or a lost dispute (`charge.dispute.closed`) reverses them. No migration. Follow-ups: store the minimum in force at checkout on the order (needs a migration), and list a referred shopper's own welcome award in `getReferralDashboard` before a site enables referrals.

**Why:** Referral awards become spendable store credit, so the programme needs firm rules on who can earn them and when they become final, and it should run only when an operator turns it on.

**Approach:** Rules: referrals are off until an admin enables them; self-referral is refused after normalizing addresses (sub-addressing and provider-specific rules); the reward stays below the minimum order; each referrer has a cap per period; awards stay pending until a configurable return or dispute window closes and are released by the scheduled job; any refund that takes the order below the minimum, and any lost dispute, reverses them.

**Audit refs:** two `commerce-ledgers-accounts` findings on referral defaults and award reversal

**Issue:** #TBD-commerce-referral-awards

### Discount preview: rate-limited, with one generic refusal

**Status:** done on `main` before the 0.1 publish. The preview and every checkout that carries a code share 30 code checks per client network and 10 per basket per hour (HTTP 429 over either), every refused code gets 409 "This code is not valid for this order.", and the preview ignores `customerEmail`, checks order-history rules only against a signed-in account and never creates a basket. No migration.

**Why:** A discount preview should tell a shopper whether a code applies to their basket and nothing more. Like the checkout route, it answers only while checkout is enabled (`TALISMAN_COMMERCE_CHECKOUT_ENABLED=true`), so these rules must hold before a store opens checkout.

**Approach:** Rules: the preview is rate-limited per client and per basket (reuse `_ecommerce_rate_limits`); every refusal before a code is applied returns one generic message such as "not valid for this order"; the preview decides only from the basket and the signed-in shopper's own account, and rules that need order history are otherwise checked at checkout.

**Audit refs:** a `commerce-ledgers-accounts` finding on the discount preview

**Issue:** #TBD-commerce-discount-preview

### Sign-in email: bot check, and a reserved budget for existing customers

**Status:** done on `main` before the 0.1 publish. With `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY` and `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` set, a Turnstile token is verified before any counter, link or email; `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` (default a quarter of the daily limit) is kept for addresses with a verified account or an order, at most two emails per address a day; once the rest is spent every request answers `{ accepted: true, limited: true }`. The Cloudflare rule stays documented as defence in depth. No migration.

**Why:** Sign-in links are limited per address, per network and per store per day. The store-wide cap protects the sending quota, but it should not stand between existing customers and their accounts, and automated requests should be stopped before they count against it.

**Approach:** Rules: when configured, a bot check (Turnstile) passes before any email is sent; part of the daily budget is reserved for addresses that already have a verified account or an order. Document a Cloudflare rate-limiting rule on the account route as defence in depth.

**Audit refs:** a `commerce-ledgers-accounts` finding on the sign-in email limits

**Issue:** #TBD-commerce-signin-email-limits

### Rate-limit public basket writes

**Status:** done on `main` before the 0.1 publish. The cart route and the `addToCart` action allow 20 new baskets per client network per hour (HTTP 429 over the limit), and checkout never creates a basket. The Cloudflare rule in launch gate 8 stays as defence in depth. No migration.

**Why:** Each basket-creating request adds a row that stays until the 30-day purge, so basket creation needs a request-rate limit next to the per-request bounds.

**Approach:** Rule: basket-creating requests are limited per client network. Use the shared limiter (or an optional Workers rate-limit binding) in the cart route and the cart actions. As defence in depth, the plugin README and launch gate 8 in [PRODUCTION_READINESS.md](packages/plugin-ecommerce/PRODUCTION_READINESS.md) recommend a Cloudflare rate-limiting rule per client IP on every public path under `/api/ecommerce/` except `/api/ecommerce/webhooks/`; no per-IP rule may cover the Stripe webhook paths (`/api/ecommerce/webhooks/*`, `/api/stripe/webhooks`).

**Audit refs:** `perf-edge/public-cart-api-unbounded-rows`

**Issue:** #TBD-commerce-public-rate-limits

### Throttle payment-provider checks from the order status route

**Status:** done on `main` before the 0.1 publish: `GET /api/ecommerce/order`, checkout resume and session release (`POST /api/ecommerce/order`) share one slot per order, so the provider is asked at most once per order every 15 seconds, and the status route does not ask before the order is 60 seconds old. The slot is kept in `_ecommerce_rate_limits` instead of a new column. No migration.

**Why:** Status requests for a pending order should not each ask the payment provider for the checkout session.

**Approach:** Rule: at most one provider check per order per interval (15 seconds, tracked in `_ecommerce_rate_limits`), and none from the order status route for orders younger than a minute, which the webhook normally settles. The rate-limiting rule in launch gate 8 also covers `/api/ecommerce/order` as defence in depth.

**Audit refs:** `commerce-checkout/order-status-get-calls-stripe-unthrottled`

**Issue:** #TBD-commerce-order-status-throttle

### Single-use, expiring Stripe coupons

**Status:** done on `main` before the 0.1 publish. Each discounted Stripe checkout creates coupon `<order id>_discount` with `max_redemptions: 1` and `redeem_by` at the session's expiry (sessions now last 31 minutes), and the coupon is deleted when the checkout expires, is cancelled or fails. No migration.

**Why:** A checkout discount should apply to that one checkout only, and leave nothing behind in the Stripe account once the checkout ends.

**Approach:** Create coupons with `max_redemptions: 1` and `redeem_by` at the session's expiry, and delete them when the session expires or is cancelled. Alternatively pass the discount without coupons.

**Audit refs:** `commerce-checkout/stripe-coupons-reusable`

**Issue:** #TBD-commerce-single-use-coupons

## Commerce launch: shopper pages

What the plugin gives storefront pages: order access, the basket across sign-ins, error messages and catalog reads.

### Give guests an order-view credential that does not depend on the basket

**Why:** A guest's order is found through the closed basket's session token. The next new basket clears that token, and the guest can no longer open their paid order.

**Approach:** At checkout, set an HttpOnly `talisman-order-<id>` cookie with a random token and store its hash on the order (as gift card purchases do), and accept it in `findForSession`. Add a regression test: pay, start a new basket, and the order is still visible. Move the playground success page off the unauthenticated order summary.

**Audit refs:** `commerce-checkout/order-hidden-after-cart-rotation`

**Issue:** #TBD-commerce-guest-order-access

### Sign-in as another account starts a fresh basket

**Why:** When a browser's basket belongs to one account and a different account signs in, every basket request fails with "Basket belongs to another account" and nothing in the flow recovers.

**Approach:** When a sign-in link switches accounts, detach the previous account's basket from the browser token or issue a new basket cookie. Return a distinct error code so storefronts can offer to start a new basket or sign out.

**Audit refs:** `gap2-gap2-shopper-journey-runtime/claim-foreign-basket-bricks-cart`

**Issue:** #TBD-commerce-signin-rotates-basket

### Typed errors and safe messages for checkout and gift card purchases

**Why:** Unknown errors reach shoppers as raw provider or database messages, ordinary promotion refusals return 500 because the route matches message strings, and a bad gift card form returns the raw validation JSON.

**Approach:** Throw typed rejection errors from the checkout and gift card code and map them to 400 or 409 with shopper-safe messages. Log unknown errors on the server and return a generic message with a correlation id. Use `safeParse` for gift card input and answer with one readable message.

**Audit refs:** `commerce-checkout/raw-error-messages-to-shoppers`, `gap2-gap2-shopper-journey-runtime/checkout-error-mapping-500`, `gap2-gap2-shopper-journey-runtime/gift-card-raw-zod-error`

**Issue:** #TBD-commerce-typed-shopper-errors

### Validate checkout input the same way in the action and the route

**Why:** The checkout action has its own schema that passes unknown keys and unbounded address strings through to the stored order.

**Approach:** Reuse the bounded, strict `checkoutSchema` in the action and store only known address fields. The country code, delivery-country and shipping option checks already run in `createFromCart` for both.

**Audit refs:** `commerce-checkout/checkout-action-weaker-validation`

**Issue:** #TBD-commerce-checkout-action-validation

### Serialize basket updates in the CartView component

**Why:** Each click starts a whole-basket sync without waiting for the previous one, and a failed request rolls the view back over a later successful one.

**Approach:** Disable the controls or queue while a sync is in flight, and render the basket the server returns rather than a local snapshot.

**Audit refs:** `commerce-surface-stripe/cart-view-overlapping-writes`

**Issue:** #TBD-commerce-cart-view-sync

### A catalog read API for storefronts

**Why:** Storefronts that show variant pairings read the plugin's internal variant, value and component tables through the generic client, whole tables at a time, and have to guess at the schema.

**Approach:** Export a documented read API, for example `getProductConfigurations(env, productIds)`, that returns one product's (or a page's) variants, values, components and availability in a few filtered queries. Keep the table layout private.

**Audit refs:** `integration-contract/catalog-reads-internal-tables`, `perf-edge/storefront-d1-roundtrips`

**Issue:** #TBD-commerce-catalog-read-api

## Commerce launch: data and GDPR

Shopper data rights, and database rules that protect balances and roles.

### Shopper data export and anonymization

**Why:** There is no tooling to export or erase a shopper's data. Today it takes hand-written SQL, and foreign keys stop account deletion.

**Approach:** Add an audited admin action that anonymizes a shopper with updates, not deletes: tombstone the email, normalized email and name, unlink the CMS user, revoke sessions, deactivate the referral code, anonymize the linked `customer` user, and tombstone discount redemption and gift card buyer emails, while keeping ledger amounts for accounting. Add a JSON export of an account's orders, ledger, referrals and redemptions, and an optional retention job for order personal data. Update the Customers description.

**Audit refs:** `commerce-ledgers-accounts/no-shopper-data-erasure-export`

**Issue:** #TBD-commerce-shopper-erasure-export

### Enforce ledger and stock invariants in the database

**Why:** The credit and gift card ledgers can be updated or deleted, and negative stock or prices are accepted on insert, so balances rely on application discipline.

**Approach:** Add `BEFORE UPDATE` and `BEFORE DELETE` triggers that abort on both ledger tables, `BEFORE INSERT` versions of the stock guards, and non-negative price triggers. Check an order's totals (items, shipping and exclusive tax against discount, credit, gift card and charge) on every insert and update, not only when a code or gift card is reserved, and cap the sum of an order's tax reversals at what it charged.

**Audit refs:** `migrations-schema/db-invariants-incomplete`

**Issue:** #TBD-commerce-ledger-invariants

### Default new auth users to the `customer` role

**Why:** `galaxy_auth_user` now holds shoppers too, but its default role is `editor`, so any insert that forgets the role grants CMS access.

**Approach:** Set better-auth's `defaultRole` and the schema default to `customer`, keep passing `editor` or `admin` explicitly, and add a `BEFORE INSERT` trigger (or the next table rebuild) that enforces it in SQL.

**Audit refs:** `migrations-schema/auth-user-default-role-editor`

**Issue:** #TBD-auth-default-role-customer

## Commerce launch: tests

Tests for the money paths, written alongside the fixes they protect.

### Race tests and exact assertions for promotions, gift cards and credit

**Why:** Two promotion-limit tests accept either of two messages, so a use-limit regression passes. No test runs two checkouts against one code, card or balance, and one test named "concurrent" runs sequentially. Some fulfillment rejections assert no message, and one assertion tests a stub that always returns `null`.

**Approach:** Assert exact messages with eligible products; test the use-limit trigger directly; add race tests with the gated adapter for a single-use code, one gift card and one credit balance, asserting the loser's message, the expired session and unchanged balances. Add message matchers, remove the stub assertion and rename misleading tests.

**Audit refs:** `testing-quality/concurrency-and-limit-assertions-weak`, `testing-quality/weak-or-constant-assertions`

**Issue:** #TBD-commerce-tests-concurrency

### Negative tests for basket and checkout input

**Why:** Expiry and cap tests for sign-in links now exist, but no test runs checkout on a draft or zero-price product, and basket updates have no table of rejected inputs.

**Approach:** Add `createFromCart` tests for a draft product and a $0 active product ("Product is not available", "A positive price is required") and table-driven `updateItems` rejections.

**Audit refs:** `testing-quality/magic-link-and-input-negatives`

**Issue:** #TBD-commerce-tests-input-negatives

## Commerce launch: rehearsal

The last step before a store opens checkout: one real, low-value order through payment, reconciliation, fulfillment, refund and stock review (launch gate 4 in [PRODUCTION_READINESS.md](packages/plugin-ecommerce/PRODUCTION_READINESS.md)), with the store's currency, shipping and tax settings in place and after the Stripe Tax setup and test-mode checks in launch gates 10 to 12.

## Post-release architecture

Structural work that makes the next features cheaper. Order:

1. **Service layer merge.** The admin API handler and `getClient` become one layer. Start with the handler test matrix.
2. **Plugin API v2**, after the merge: typed `onInit`, migration and scheduled hooks, and an admin SDK.
3. **Core/plugin boundary**, after Plugin API v2: commerce migrations and admin screens move into the ecommerce plugin.

The admin UX overhaul and the SSO redesign can run in parallel. The admin product editor's scoped reads depend on the service layer's filtered queries.

### Service layer merge

#### Complete the admin API handler test matrix

**Status:** done on `main` before the 0.1 publish. `test/api-handler-matrix.test.mjs` runs every route against an anonymous request, an editor and an administrator, including the trailing-slash, longer-segment, extra-segment and prefixed variants of the admin-only patterns, archive and restore as an editor refused before the body is read, a restore without its token, and a create that loses a unique-constraint race (forced by a hook that commits the same id first). The harness the handler tests share moved to `test/helpers/handler-harness.mjs`.

**Why:** Handler tests now cover 409/428, globals and some editor refusals, but not archive or restore as an editor, variants of the admin-only route patterns, or a forced unique-constraint race on create. The merge needs this safety net first.

**Approach:** Extend `test/api-handler.test.mjs` to a table of every route against anonymous, editor and admin, including trailing-slash and prefix variants of the admin-only patterns, and force a UNIQUE race on entry create.

**Audit refs:** `core-api-data/handler-untested`

**Issue:** #TBD-arch-handler-test-matrix

#### Merge the admin API handler and `getClient` into one service layer

**Status:** done on `main` before the 0.1 publish. `src/service/` holds the entry, native, global, revision and collection operations once, behind `createService(env, { config, actor })`; the admin API handler is auth, routing, parsing, a pre-check of the collection's rules and one service call per route, and `getClient` is an adapter with the `system` actor. Actors carry the authorization rules (users) apart from the integrity rules (everyone); hooks run through one runner and receive `actor`, `collection` and an optional `req`; one write pipeline validates both paths; one error family maps to HTTP in one place; the cache is one module cleared from every write path, with native tables uncached by default and a per-isolate collection row memo; `where`, `sort` and `offset` are on the list route and `findMany`. `test/service-parity.test.mjs` proves the two paths equal. Follow-ups: the handler's `/api/collections` list and the globals sync still live in the handler and the globals service respectively rather than one collections service; the service is bundled twice in a Worker (once from source for the handler, once in `dist/client.js`), so its per-isolate memos exist twice.

**Why:** Hooks, validation, access rules and cache invalidation are implemented twice and behave differently. Native tables are cached in KV for an hour, and writes made by plugins or SQL never clear it. Every client read also looks up its collection row in D1 first.

**Approach:** Move entry, global and native operations into one service used by both the HTTP handler and `getClient`. Clear the cache on every write path, export an invalidation helper for plugins, and give native tables a short TTL or no cache by default. Memoize collection rows per isolate (cleared on collection writes) or skip the lookup for native tables. Add `where`, `sort` and `offset` to the shared query API.

**Audit refs:** `core-api-data/native-kv-cache-not-invalidated`, `perf-edge/storefront-d1-roundtrips`

**Issue:** #TBD-arch-service-layer-merge

#### Return concurrency tokens from every write, including globals

**Status:** partly done with the service layer merge: create, PUT, publish, archive and restore answer with `latestRevisionId`, and the SDK's `status` option publishes from the save's own revision. Remaining: the admin SPA chaining its publish from the save's revision instead of re-reading, and a token on global writes.

**Why:** Only GET returns `latestRevisionId`, so after a save the editor re-reads the entry and can publish on top of someone else's newer revision. Global writes have no token at all, so two editors saving the same global overwrite each other.

**Approach:** Return `latestRevisionId` from PUT, create, publish, archive and restore, and chain publish from the save's own revision. Add an `expectedUpdatedAt` (or revision) check to global writes, answering 409 on a stale save.

**Audit refs:** `core-api-data/write-responses-lack-revision-id`, `core-api-data/editor-creates-globals-via-slug-route`

**Issue:** #TBD-arch-write-concurrency

#### Native tables: property names for generated fields, and native relation targets

**Why:** Fields generated from Drizzle tables are named by SQL column while rows are read by JavaScript property, so columns such as `base_price` show empty. Relations that point at native tables return bare ids because only the entries table is searched.

**Approach:** Keep one property-to-column map per native table. Name generated fields by property, mark the id and timestamp columns as not required, and resolve native relation targets through their mapped tables with the target's access rules.

**Audit refs:** `core-api-data/generated-native-fields-snake-case`, `core-api-data/relation-resolution-scope`

**Issue:** #TBD-arch-native-fields-relations

#### Live loader: filters, limits and depth

**Why:** `fetchLiveCollection` ignores filters and has no limit or depth option, `fetchLiveEntry` only understands `id`, and the published mode does not apply to native collections, which have no status.

**Approach:** Support `slug`, `limit` and `depth` (default 0) filters, document that native collections have no draft or published state or filter on a configured status column, and allow draft mode only for an authenticated preview.

**Audit refs:** `core-api-data/live-loader-filter-limit`

**Issue:** #TBD-arch-live-loader

### Plugin API v2

Depends on the service layer merge.

#### Typed `onInit`, scheduled and migration hooks

**Status:** done on `main`. `Plugin.onInit` is optional and typed: it receives a `PluginConfig`, the site's options with `collections`, `globals` and `plugins` always present and `adminPath` normalized, and may mutate it or return a new one. `Plugin.scheduled: { moduleId, exportName? }` names a server module the Worker's scheduled handler runs on every cron tick; `talisman-cms/worker` exports that handler (`scheduled`) and `runScheduledJobs`, which run every plugin's job in registration order, log each failure and fail the invocation afterwards, and the integration warns when a plugin declares a job and no wrangler config has a cron trigger. The ecommerce plugin registers `@talisman-cms/plugin-ecommerce/scheduled` (reconciliation, then the retention purge), so a site exports the handler from its Worker entry instead of wiring the functions by hand. `Plugin.migrations: { dir }` names a folder of numbered SQL files; the integration copies the core's and every plugin's files into `node_modules/.talisman-cms/migrations` (the `migrationsDir` option moves it) on every `astro:config:setup`, one sequence of numbers runs across the core and every plugin, the assembler refuses a shared name or number, and the build fails while a `migrations_dir` still names the core package's own folder; `talisman-cms/migrations` exports `listMigrationSources` and `assembleMigrations`. The "Build a plugin" guide is `packages/talisman-cms/docs/build-a-plugin.md`. Follow-up: per-plugin number ranges for third-party plugins.

**Why:** `onInit` is typed as `(config: any) => any`, sites wire the ecommerce plugin's reconciliation and retention jobs into their own `scheduled` handler by hand, and plugins cannot ship migrations.

**Approach:** Type the plugin contract, add a `scheduled` hook that the integration calls from the Worker's scheduled handler, and a `migrations` hook that contributes numbered SQL files to one assembled `migrations_dir`. Write a "Build a plugin" guide.

**Audit refs:** none (audit roadmap)

**Issue:** #TBD-arch-plugin-api-v2

#### An admin SDK for plugin screens

**Status:** done on `main`. `talisman-cms/ui/sdk` gives plugin screens `adminPath`, `adminUrl`, `adminApiUrl`, `adminRequest`, `readAdminSetting` and `useAdminUser`; the ecommerce, analytics and daisyUI screens use it, and none reads the admin path from the URL any more. An `adminLinks[].href` or `routes[].path` without a leading slash is relative to the admin path, and every value is resolved against a placeholder origin at config time, so a full URL, a `//host` form or a backslash fails the build; the ecommerce and analytics links and the daisyUI preview route are declared that way.

**Why:** Plugin admin screens guess the admin base path from the URL: analytics and ecommerce fall back to `/admin` when the admin is mounted at `/`, and the daisyUI Theme Builder breaks under a nested admin path. The ecommerce plugin checks only the prefix of configured admin links, which does not guarantee that they stay on the same origin.

**Approach:** Give plugin screens the configured admin path through a shared module or context, with helpers for API and page URLs, and use it in analytics, ecommerce and the Theme Builder, including its preview route. Validate plugin admin links by resolving them against a placeholder origin and requiring the same origin.

**Audit refs:** `analytics-plugin/admin-base-root-path`, `ui-plugins/themebuilder-adminpath-assumptions`, and a `commerce-surface-stripe` finding on admin link validation

**Issue:** #TBD-arch-plugin-admin-sdk

#### Ship compiled admin components and their styles

**Why:** `./admin/*` exports map to extensionless raw TSX that only Vite's extension probing resolves, and the admin stylesheet scans only the core's `ui/` folder, so Tailwind classes used only in plugin screens are never generated.

**Approach:** Compile plugin admin components to `dist/admin/*.js` with `.d.ts` files (or map explicit `.tsx` paths), and let plugins register `@source` paths or ship their own admin CSS.

**Audit refs:** `analytics-plugin/admin-exports-extensionless-raw-tsx`

**Issue:** #TBD-arch-plugin-admin-build

### Core/plugin boundary

Depends on Plugin API v2.

#### Move commerce migrations and admin screens into the ecommerce plugin

**Status:** done on `main`. The core's migrations end at `0024`, the 0.1 baseline, which still creates the commerce tables of its time because `0019` changes CMS and commerce tables in one file and an applied file name never changes; `0025` to `0030` ship unchanged from `@talisman-cms/plugin-ecommerce/drizzle`, and `packages/plugin-ecommerce/test/migrations.test.mjs` applies the assembled sequence as wrangler does to a fresh database and to a seeded one recorded at `0024`. The admin's sections, editor panels, record describers, exposed settings and stylesheet sources are plugin hooks (`adminSections`, `adminEditorPanels`, `adminEntryDescribers`, `adminSettings`, `adminStyleSources`), `FieldDefinition.saveOnlyIfChanged` replaced the inventory special case, and the Commerce workspace, the product editor's options panel with its storefront preview, the model guide and the commerce record labels live in the plugin's `src/admin/`; the routes became `/$section/...`, so `/admin/commerce/...` URLs are unchanged, and the field normalizer had no commerce special case left. The follow-ups closed with Plugin API v2: the workspace, the describer, the model guide and the flow summary read the configured `productsCollectionSlug` from the plugin's `virtual:talisman-cms/ecommerce-admin` module, and the plugin screens take the admin path from [the admin SDK](#an-admin-sdk-for-plugin-screens). The Commerce entry still shows with `injectCollections: false`, by design: the section's tools do not depend on the injected collections, as the plugin README says.

**Why:** The core ships the commerce tables in its own migrations, and the admin hard-codes the commerce section, the variant configurator and commerce models. Sites without commerce still get its tables, and the plugin cannot evolve its schema on its own.

**Approach:** Freeze the core's commerce migrations, ship future commerce migrations from the plugin through the migrations hook, move the variant configurator, commerce models and routes into the plugin behind an editor extension point, let plugins register admin sections, and remove the commerce special case from the field normalizer.

**Audit refs:** none (audit roadmap)

**Issue:** #TBD-arch-commerce-into-plugin

### Admin UX overhaul

#### Browser tests for the admin

**Status:** done on `main` before the 0.1 publish. `e2e/admin-flows.mjs` (`pnpm e2e:admin`) drives the admin in the installed Chrome with playwright-core against a built playground served by `astro preview`: first-admin setup or sign-in, a new entry saved twice, publish, an editor who sees no publish action, a 409 conflict resolved with "Load latest version", a media upload, a variant group with stock, the storefront preview following typing, a global save and the mobile drawer; it also records the client chunk sizes of the build. The GitHub workflow's `admin-browser` job runs it after the playground build. Follow-ups: the hybrid-mode editor flow and the orders screen are not covered, and the harness is a plain node script rather than a Playwright Test suite.

**Why:** The admin SPA has no component or browser tests; coverage is the manual `docs/admin-coverage.md`. The overhaul needs a safety net.

**Approach:** Add a Playwright suite against the playground with a seeded editor and admin: sign in, edit a draft, check that publish is hidden for the editor, publish as admin, add an editor in hybrid mode and open the orders screen. Run it in CI after the playground build.

**Audit refs:** `testing-quality/no-admin-ui-or-browser-tests`

**Issue:** #TBD-admin-browser-tests

#### One field renderer for the entry and globals editors

**Status:** done on `main` before the 0.1 publish. `FieldRenderer`, `RelationshipPicker`, `RelationFieldSummary` and the relation and array helpers live in `ui/components/fields` and serve both editors and the page builder. The globals editor lost its unreachable copy of the pre-composer blocks UI (about 485 lines) and gained the media field, and both editors trim ISO dates for the date input. The storefront preview, the commerce model guide and the server error summary subscribe to the form store, so they follow typing. Collapsed page builder cards are kept under one localStorage key per entry, written only when they change, with an LRU index capped at 50 entries. Follow-up: a new entry's collapsed cards do not carry over to its saved id.

**Why:** `FieldRenderer` and `RelationshipPicker` exist twice, the globals copy carries about 485 unreachable lines, and the editors differ (globals has no media field; the entry editor does not trim ISO dates). Previews read form values during render and stop updating while typing, and every field mount writes its own localStorage key.

**Approach:** Delete the dead code, move the renderer and picker to `ui/components/fields` with one field-type switch, subscribe the previews to form values (`form.Subscribe` or a values selector), and keep collapsed state under one key per entry with an LRU cap, written only when it changes.

**Audit refs:** `admin-ui/duplicated-fieldrenderer-dead-code`, `admin-ui/stale-form-values-in-render`, `admin-ui/collapsed-state-localstorage-growth`

**Issue:** #TBD-admin-shared-field-renderer

#### Code-split the admin bundle

**Status:** done on `main` before the 0.1 publish. The router plugin's `autoCodeSplitting` gives each route's component its own chunk; the entry editor moved out of its route file into `ui/components/editor` (its loader into `ui/lib/entry-editor-data.ts`), because a route file's exports stay in the eager bundle; the rich text editor (Tiptap) and the page builder load on first use from the shared field renderer; and plugin admin pages are lazy imports in the admin-extensions virtual module, rendered inside Suspense. In the playground build the admin's entry chunk went from 1,433 KB to 294 KB, and what `/admin` loads at start from 1,433 KB to 688 KB, of which 233 KB is the `virtual:talisman-cms/config` module. Follow-ups: the collections list page stays eager because the commerce list route imports it; the config module is eager because the sidebar needs `collections`, while most of its weight is the UI library catalogs that only the editors read; zod loads at start because `lib/page-builder.ts` keeps the schema builders next to the helpers the loaders need; and Tiptap's default `injectCSS` trips a strict CSP (`injectCSS: false` with the ProseMirror base rules in `globals.css` would fix it).

**Why:** The admin ships as one chunk of about 1.16 MB, with extensions, the rich-text editor and the page builder loaded up front.

**Approach:** Enable `autoCodeSplitting` in the TanStack router plugin and lazy-load extension components, `RichTextEditor` and `PageBuilderComposer`.

**Audit refs:** `admin-ui/admin-bundle-no-splitting`

**Issue:** #TBD-admin-code-splitting

#### Mobile navigation

**Status:** done on `main` before the 0.1 publish. Below `md` the sidebar is a drawer opened by a header button with `aria-expanded` and `aria-controls`, with a backdrop and its own close button; Escape closes it, focus moves to the first link and returns to the toggle, and it closes on navigation or when the viewport grows to `md`. From `md` up the sidebar is unchanged.

**Why:** The sidebar is hidden below the `md` breakpoint and nothing replaces it.

**Approach:** Turn the header's "Menu" into a toggle that opens the sidebar as a drawer.

**Audit refs:** `admin-ui/no-mobile-nav`

**Issue:** #TBD-admin-mobile-nav

#### Accessibility of the editing flows

**Status:** done on `main` before the 0.1 publish. A static audit of the editors, the page builder, the pickers, the media and users screens and the sign-in panel found 29 gaps; 27 were fixed (one had gone with the shared renderer, one was not a gap). Busy controls keep focus (`aria-disabled`, `aria-busy`, a mounted `sr-only` status line and a handler guard instead of `disabled`); success, progress and error messages are live regions that stay mounted; the conflict panel is a focused region announced by a separate alert; the error summary's field names focus their fields; repeated buttons name their record, field or revision; the variant editor's validation marks its inputs; styled text became headings; the rich text toolbar is one tab stop with arrow keys; read-only records are a disabled fieldset; the Users screen confirms a role change from a "Change role" button; the shell has a skip link and moves focus to the main landmark on navigation; and `useModalDialog` can make the rest of the page inert. Follow-ups: the page builder still has two buttons named "Add Block" and two "Add to Slot" per slot; the media library's Refresh and "Load more" keep `disabled` while loading; the error summary cannot reach fields inside the block inspector or a preset's props; colour contrast was not measured; nothing has been checked with a screen reader yet.

**Why:** Keyboard and screen reader users lost focus on every busy button, heard no outcome of a save or publish, and could edit read-only records that the mouse could not.

**Approach:** Audit statically, apply the fixes in one pass over the shared renderer, the editors and the screens, and re-run the browser harness.

**Audit refs:** none (found during the overhaul)

**Issue:** none (done before an issue was opened)

#### Load only one product's rows in the product editor

**Status:** the query is in place (`?where[productId]=`, `where[field][in]=` and `fetchEntriesWhere` in `ui/lib/admin-api.ts`); the product editor and the relation pickers still load whole collections.

**Why:** Opening a product pages through every row of the variant, value, stock and component collections.

**Approach:** Add a filtered entries query (for example `?where[productId]=`) or a product-scoped commerce endpoint, and use it in the product editor and relation pickers. Depends on the service layer merge.

**Audit refs:** `admin-ui/unbounded-admin-fetches`

**Issue:** #TBD-admin-product-editor-reads

#### Delete media from the Media Library

**Why:** The API deletes the file, but the Media Library has no delete action.

**Approach:** Add an admin-only delete action that warns about pages still using the file and calls the existing delete route.

**Audit refs:** `core-media-render/deleted-media-still-served`

**Issue:** #TBD-admin-media-delete

### SSO redesign

#### Mint the admin session directly after Access verification

**Why:** SSO sign-in derives a password from the auth secret and the email, stores it as a credential and signs in through the password endpoint. That ties SSO to the password path, costs a password hash on every login, and ends all of the admin's other sessions.

**Approach:** Rule: an SSO-managed admin has no password credential, and the auth secret is never usable to sign in. After verifying the Access JWT, create the session through better-auth's session API, delete existing SSO credential rows, and stop revoking other sessions on every login.

**Audit refs:** `core-auth/sso-deterministic-password-credential`, `perf-edge/sso-rehash-every-login`

**Issue:** #TBD-auth-sso-direct-session

## Maintenance

Smaller fixes that fit no workstream. Take them in any order.

### Core

#### SEO URL helpers: keep every URL on the site origin

**Why:** URLs are built from editor input, and `safePath` checks that input before it is resolved, so the helpers do not guarantee that every URL stays on the site's origin. `resolveSeo` throws on a breadcrumb without a path and builds a title of only the separator and suffix when no title is set.

**Approach:** Rule: canonical, breadcrumb and sitemap URLs always resolve on the site's origin. Resolve first and compare the resolved origin in `siteUrl`. Skip breadcrumbs without a string path, and append the suffix only to a non-empty title. Add test cases.

**Audit refs:** a `core-media-render` finding on `safePath`, `core-media-render/seo-resolve-edge-cases`

**Issue:** #TBD-seo-url-guards

#### Security headers on the admin shell and API

**Why:** The admin shell shares an origin with the public site but sends no anti-framing, referrer, robots or caching headers.

**Approach:** Send `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` (ideally a full CSP), `Referrer-Policy: same-origin`, `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store` from `admin.astro` and the admin API.

**Audit refs:** `core-media-render/admin-shell-no-security-headers`

**Issue:** #TBD-admin-shell-headers

#### Media serving: transform fallback, deleted files everywhere, route tests

**Why:** A failed image transform returns 500 for every width variant and is never cached. A deleted file can still be served from other data centers' caches for up to an hour. The upload and serve routes test only two cases.

**Approach:** Catch transform errors and stream the original instead, caching the fallback briefly. Before serving from cache, check a deletion marker (for example a KV key written on delete) or purge by URL through the zone API. Add route tests for 401, 403, 413, 415, invalid ids and widths, and the fallback, and stop the test file from skipping itself.

**Audit refs:** `core-media-render/media-transform-failure-no-fallback`, `core-media-render/deleted-media-still-served`, `core-media-render/media-routes-untested`

**Issue:** #TBD-media-serve-hardening

#### Quote virtual-module specifiers with `JSON.stringify`

**Why:** The native-schemas and admin-extension virtual modules put paths and slugs inside single quotes, which breaks on Windows paths and on quotes in names.

**Approach:** Use `JSON.stringify` for every interpolated specifier and key, as the renderer module already does.

**Audit refs:** `core-media-render/virtual-module-unquoted-specifiers`

**Issue:** #TBD-virtual-module-specifiers

#### LivePreview: use Astro's `navigate`

**Why:** `LivePreview.astro` checks for `astro:navigate` on `window` and calls `window.astro.navigate`, which is not Astro's API.

**Approach:** Import `navigate` from `astro:transitions/client` when view transitions are enabled, and reload otherwise.

**Audit refs:** `core-media-render/dev-toolbar-hardcoded-misleading`

**Issue:** #TBD-live-preview-navigate

#### Quiet build logs and tidy the playground

**Why:** Every build prints "Injecting admin route/plugin route/page" with absolute paths, and the playground still has scratch pages (`test-globals`, `test-sdk`, `live-test`).

**Approach:** Log through the integration logger at debug level, and remove the scratch pages or turn them into documented examples.

**Audit refs:** `release-packaging/debug-leftovers`

**Issue:** #TBD-build-logs-playground-pages

#### Make `media.updatedAt` nullable in the schema

**Why:** `schema.ts` declares `media.updatedAt` as `notNull()`, but migration `0006` added the column as nullable, so the type is wrong for older rows.

**Approach:** Drop `.notNull()` and handle `null` where media rows are read.

**Audit refs:** `migrations-schema/drizzle-kit-snapshot-drift`

**Issue:** #TBD-schema-media-updated-at

#### Demo seed: seconds, and no overwrite of collections

**Why:** `seeds/ecommerce-demo.sql` writes millisecond timestamps into second-based columns and overwrites collection names and fields on every run. The seeds folder is published.

**Approach:** Use `strftime('%s','now')`, change the collection upsert to `ON CONFLICT DO NOTHING`, and either drop `seeds` from the published files or mark it as playground-only.

**Audit refs:** `migrations-schema/demo-seed-ms-timestamps-clobber`

**Issue:** #TBD-demo-seed-timestamps

#### Catalog seed: validate numbers and keep deleted memberships deleted

**Why:** The catalog seed writes prices and quantities into SQL without an integer check, and a re-run adds back category and tag memberships that admins removed, although the README says admin edits win.

**Approach:** Require safe non-negative integers, and emit join rows only together with a newly inserted product.

**Audit refs:** `commerce-surface-stripe/catalog-seed-raw-numerics-join-readd`

**Issue:** #TBD-catalog-seed-validation

#### Return `{ required: false }` from the setup check under hybrid auth

**Why:** The sign-in panel always asks `/api/auth/setup`, which answers 404 when the adapter is not local, so every admin load logs a failed request.

**Approach:** Answer `{ required: false }` for adapters without first-admin setup, or skip the request when the config says setup is not available.

**Audit refs:** `gap2-admin-spa-runtime/editor-noise-requests`

**Issue:** #TBD-hybrid-setup-endpoint

#### A machine-readable `code` on HTTP 409

**Why:** The admin already reads `revision_conflict`, `stale_record`, `slug_conflict` and `constraint` from 409 bodies, but the handler sends only `error`, so the admin guesses from message text.

**Approach:** Add `code` to every 409 body, optionally `fieldErrors` for constraint failures, and document it in RELEASE.md and the CHANGELOG.

**Audit refs:** none (follow-up from the fix rounds)

**Issue:** #TBD-conflict-codes

#### Accept only bare addresses in `ensureVerifiedEmailIdentity`

**Why:** The identity helper validates with a loose pattern. The ecommerce plugin already passes only bare addresses, but other callers are not protected.

**Approach:** Require `parseAddress({ email })?.email === normalized`, the rule the plugin uses, and add tests.

**Audit refs:** none (follow-up from the fix rounds)

**Issue:** #TBD-identity-bare-address

#### Document the Workers CPU needs of password sign-in

**Why:** Local and hybrid sign-in hash passwords with scrypt, which exceeds the Workers Free CPU limit, and nothing says so.

**Approach:** State in the README and the auth setup guide that local and hybrid auth need Workers Paid (or a CPU limit of at least about 100 ms).

**Audit refs:** `core-auth/scrypt-cpu-vs-workers-free-plan`, `perf-edge/sso-rehash-every-login`

**Issue:** #TBD-docs-auth-cpu

### Analytics plugin

#### Ask: say when a period is unsupported, and keep partial answers

**Why:** Questions about other periods are quietly mapped to one of the six supported ones. Missing Cloudflare settings produce a generic 502 that also discards the sales answer, and upstream errors return raw messages.

**Approach:** Have the planner return `unsupported` for other periods and say so. Treat configuration errors as known (503 with a setup message), use `Promise.allSettled` so sales data survives a traffic failure, and return a generic upstream message instead of the raw error. Document the three Cloudflare settings traffic needs.

**Audit refs:** `analytics-plugin/unsupported-periods-silently-mapped`, `analytics-plugin/ask-traffic-errors-generic`, `gap2-admin-spa-runtime/editor-noise-requests`

**Issue:** #TBD-analytics-ask-errors

#### Bound the cost of commerce reports and Ask

**Why:** Commerce queries build a CTE over all orders and payments before filtering by period. Ask has no rate limit or cache, runs an unused Core Web Vitals query for each range, and calls Workers AI without a timeout.

**Approach:** Filter payments by date inside the CTE with a supporting index, cache results briefly on the server, add a `skipVitals` option, a per-user throttle for Ask and a timeout around `ai.run`.

**Audit refs:** `analytics-plugin/commerce-full-scan-per-request`, `analytics-plugin/ask-no-rate-limit-unused-vitals`, `perf-edge/external-fetch-timeouts`

**Issue:** #TBD-analytics-query-cost

#### Clear KPI definitions and complete daily charts

**Why:** Average order value and order counts include fully refunded orders without saying so. Daily charts skip days without sales, hide dates when there are many points, and the traffic dashboard does not say dates are UTC.

**Approach:** Exclude fully refunded orders from AOV (or report them separately) and state the definition. Zero-fill every UTC day in the window, always label the first and last bars, and add the UTC note to the traffic dashboard.

**Audit refs:** `analytics-plugin/aov-includes-refunded-orders`, `analytics-plugin/trend-chart-gaps-and-utc`

**Issue:** #TBD-analytics-kpis-charts

#### Leave admin and API paths out of traffic

**Why:** The traffic query filters only on site and time, so admin page views count as site traffic if the beacon reaches admin pages.

**Approach:** Exclude the admin path prefix in the GraphQL filter, and send `Cache-Control: no-transform` on admin HTML so Cloudflare does not inject the beacon there.

**Audit refs:** `analytics-plugin/traffic-includes-admin-paths`

**Issue:** #TBD-analytics-traffic-filter

#### Match the Beacon component to Cloudflare's snippet

**Why:** `Beacon.astro` emits a module script without `defer`, unlike Cloudflare's snippet, and nothing renders or tests it.

**Approach:** Emit `<script is:inline defer src=... data-cf-beacon=...>`, render it in the playground and add a container render test.

**Audit refs:** `analytics-plugin/beacon-untested-module-script`

**Issue:** #TBD-analytics-beacon

#### Test the analytics route handlers

**Why:** No test covers the routes' admin-role check, origin, content-type and size validation, or error mapping.

**Approach:** Stub the auth, config and `cloudflare:workers` modules (or inject dependencies) and assert the status for anonymous, editor, admin and cross-origin requests.

**Audit refs:** `analytics-plugin/route-handlers-untested`

**Issue:** #TBD-analytics-route-tests

### Other plugins

#### Timeouts and a current API version for plugin-stripe's client

**Why:** plugin-stripe creates its Stripe client without timeout or retry settings and with API version `2022-08-01`.

**Approach:** Set `timeout`, `maxNetworkRetries` and a current `apiVersion`, as the ecommerce plugin's adapter does.

**Audit refs:** `perf-edge/external-fetch-timeouts`

**Issue:** #TBD-stripe-client-timeouts

#### daisyUI renderers: keep state inside each block

**Why:** The theme-controller block switches the whole page's theme, the accordion shares one radio name across instances, and RadioGroup and Rating inputs have no name.

**Approach:** Render the theme controller unchecked or scope it with `data-theme` on a wrapper, and give each group a per-instance name, as the modal already does.

**Audit refs:** `ui-plugins/interactive-renderers-global-state`

**Issue:** #TBD-ui-renderers-scoped-state

#### Render tests for the UI plugins

**Why:** Sanitizer, Theme Builder and entrypoint tests exist, but nothing renders the renderers, tests the theme API's authorization, or checks that complete catalog items point at real files.

**Approach:** Add Astro container render tests with hostile strings, a theme API authorization test, and a check that every complete item's file exists without a stub marker.

**Audit refs:** `ui-plugins/tests-bookkeeping-only`

**Issue:** #TBD-ui-plugin-render-tests

#### daisyUI: declare daisyUI as a dev dependency

**Why:** The `theme-defaults` script and its drift test find daisyUI through the playground and skip when it is missing, because the plugin does not declare it.

**Approach:** Add `daisyui` as a dev dependency of the plugin, at the version that the generated `themeDefaults.ts` records. Whenever the file is regenerated for a new daisyUI release, update the version in NOTICE and copy NOTICE into every package.

**Audit refs:** none (follow-up from the fix rounds)

**Issue:** #TBD-daisyui-notice-devdep

### Tooling

#### Measure test coverage

**Why:** Tests import tsup bundles without source maps, so there is no coverage signal for the critical paths.

**Approach:** Build test bundles with source maps (or test `src` directly), add c8 with thresholds for `src/auth` and the ecommerce money modules, and publish the report in CI.

**Audit refs:** `testing-quality/coverage-unmeasurable-on-bundles`

**Issue:** #TBD-coverage-with-sourcemaps

#### Dependency hygiene

**Why:** `pnpm audit` still reports high advisories in development tooling, core declares `sirv` and plugin-stripe declares `zod` without using them, and nothing keeps dependencies current.

**Approach:** Add `pnpm.overrides` for the affected transitive packages, remove unused dependencies, add knip or depcheck to CI, and add a Dependabot configuration for npm and GitHub Actions.

**Audit refs:** `secrets-supply-chain/dev-toolchain-advisories`, `secrets-supply-chain/unused-and-masking-deps`, `secrets-supply-chain/ci-supply-chain-hardening`

**Issue:** #TBD-dependency-hygiene
