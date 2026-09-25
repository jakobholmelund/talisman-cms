# Commerce production readiness review

Reviewed against the Talisman Cloudflare Worker integration on 25 September 2026.

## Decision

The plugin is suitable for a controlled production deployment with public checkout **disabled**. It is **not ready to accept live orders**. The technical payment safeguards below passed local integration tests, but live payments, tax and delivery policies, operational fulfillment, and a real catalog still need end-to-end verification.

## Safeguards checked

| Area | Evidence and current behavior |
| --- | --- |
| Account ownership | A paid order or a used sign-in link may create or link a shopper account, but the cart cookie cannot activate it. Asking for a link creates no account; the link row keeps only the token hash and the address. A one-time emailed link is consumed before the account is created or linked and a shopper session is issued, and only then is the account linked to the shared CMS user for that email. A link is sent only to a bare address, never to one with a display name. First-order promotions and referrals depend on purchase history, not on whether an account exists. A new user gets the `customer` role, which has no CMS access. Migration `0016` revokes earlier sessions on unverified accounts. |
| Checkout integrity | D1 transactions reserve stock, credit, promotions, and gift card tender with the pending order. Stripe completion must match the stored session, amount, currency, and payment status. Duplicate events do not create a second payment. |
| Recovery | The order status route and a ten-minute scheduled Worker reconcile pending Stripe sessions when a webhook is missed. Orphaned preparation locks are released after the configured Stripe session lifetime; gift card purchases are also reconciled. |
| Fulfillment | Migration `0017` restricts fulfillment to a paid, real order and records the administrator, note, and optional carrier and tracking number. Admin test orders cannot be fulfilled. |
| Access | Commerce admin routes require the CMS administrator role and same-origin mutations. Customer cookies are HTTP-only and account link tokens are stored as hashes. An order's status and cancellation are available only to the basket or signed-in account that placed it. The simulated `admin_test` payment provider exists only on sites that set `ecommercePlugin({ adminTestCheckout: true })`, and only the admin route registers it. |
| Basket abuse | The public basket API accepts at most 50 lines of 1 to 99 units, rejects bodies over 64 KB, and stores only catalog products and variants; a product with variant groups is accepted, and sold, only as one of its variant values, never at its base price or as a group that has values. A rejected request creates no basket and reading never creates one. `purgeStaleCommerceData`, run from the scheduled Worker, deletes guest baskets idle for 30 days. The API has no rate limit of its own. |
| Verification | `pnpm --filter @talisman-cms/plugin-ecommerce test` passed 108 tests. Route tests cover Stripe signature verification (valid, wrong secret, stale timestamp, changed payload and replay), the checkout-disabled gate on the checkout route, checkout action and gift card purchase, order ownership, basket limits, variant choice, and sign-in links and their preview. The Talisman TypeScript check, Astro production build and a Wrangler deployment dry run passed at the original review. No live payment or remote migration was performed. |

## Launch gates

1. Apply Talisman CMS migrations through `0024_shopper_sign_in_tokens.sql` to the remote D1 database **before** deploying the new Worker; shopper account reads fail without `0019`, and shopper sign-in fails without `0024`. Rehearse rollback from a D1 backup. First confirm that both duplicate checks return no rows. `0018` adds a unique revision index, and `0019` allows one CMS user per email regardless of letter case:

   ```sql
   SELECT entry_id, revision_number, COUNT(*) AS copies
   FROM galaxy_entry_revisions GROUP BY entry_id, revision_number HAVING COUNT(*) > 1;

   SELECT lower(email) AS email, COUNT(*) AS copies
   FROM galaxy_auth_user GROUP BY lower(email) HAVING COUNT(*) > 1;
   ```
2. Replace draft product concepts with verified, saleable products. Confirm actual USD prices, component bills of materials, available stock, images, fit and optical claims, and a physical packing sample.
3. Choose the countries served, delivery charge and time promises, tax treatment, returns and refund policy, and customer contact channel. The current checkout accepts a two-letter country code and treats delivery as included in item prices; it does not calculate tax or shipping.
4. Configure live Stripe keys and a signed webhook for completion, expiry, and refunds. Run a real low-value order through payment, reconciliation, fulfillment, refund, and inventory review before opening checkout broadly.
5. Configure an email provider (a Cloudflare Email Service `[[send_email]]` binding named `EMAIL` on an onboarded sending domain, or a custom provider), the `TALISMAN_EMAIL_FROM` sender and the `TALISMAN_PUBLIC_ORIGIN`. Turn off any provider feature that stores message content, because sign-in links are bearer credentials for 15 minutes. Prove that the checkout email receives a one-time sign-in link and an unrelated browser cannot use the cart cookie to enter that account. Review `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` (default 200 sign-in emails a day) against the provider's quota.
6. Assign staff to inspect the admin order queue, pack and label shipments, tell customers about dispatch, resolve failed deliveries, handle refunds, and monitor webhook and scheduled Worker failures. The plugin records fulfillment but does not buy labels or send shipment or order confirmation emails.
7. Keep `TALISMAN_COMMERCE_CHECKOUT_ENABLED=false` until these gates pass. Enable gift card sales separately only after their key backup and purchase, delivery, and refund procedures are tested.
8. Add a Cloudflare rate limiting rule, keyed on the client IP, for `/api/ecommerce/*` and `/_actions/*`. The basket and sign-in APIs need no session, and the plugin bounds each request but not the request rate.

Talisman deployment steps and secret names are in its `DEPLOYMENT.md`. This review covers the code and local integration; it does not certify the merchant's legal, tax, product, or operational readiness.
