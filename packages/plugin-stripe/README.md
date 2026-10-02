# Talisman Stripe sync

`@talisman-cms/plugin-stripe` links Talisman CMS collections to Stripe customers, products, or prices. When an editor saves a record, the plugin creates or updates the matching Stripe resource and stores its Stripe ID on the record. Failed syncs refuse the CMS write and explain how to retry. It can also receive signed Stripe webhooks and give admins a small, allow-listed proxy to the Stripe API.

Payments do not need this package: `@talisman-cms/plugin-ecommerce` runs hosted checkout, orders, and its own Stripe webhook.

## Installation

```bash
pnpm add @talisman-cms/plugin-stripe drizzle-orm@rc
```

The package runs inside the Talisman CMS Worker, so it needs `talisman-cms`, `astro` 7, and Drizzle ORM `^1.0.0-rc.4` in the same project. The workspace uses the `rc` tag (currently `1.0.0-rc.4`), as the core does.

## Configuration

Register the plugin after any plugin that defines the collections it syncs:

```ts
import { defineConfig } from 'astro/config';
import talismanCms from 'talisman-cms';
import { stripePlugin } from '@talisman-cms/plugin-stripe';

export default defineConfig({
  integrations: [talismanCms({
    collections: [
      { name: 'Members', slug: 'members', fields: [
        { name: 'memberKey', label: 'Immutable member key', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'text', required: true },
        { name: 'name', label: 'Name', type: 'text' },
      ] },
    ],
    plugins: [
      stripePlugin({
        sync: [{
          collection: 'members',
          identityField: 'memberKey',
          stripeResourceType: 'customers',
          stripeResourceTypeSingular: 'customer',
          fields: [
            { fieldPath: 'email', stripeProperty: 'email' },
            { fieldPath: 'name', stripeProperty: 'name' },
          ],
        }],
      }),
    ],
  })],
});
```

| Option | Default | Effect |
| --- | --- | --- |
| `sync` | `[]` | Collections to link to Stripe (see below). |
| `rest`, `restMethods` | `false`, `[]` | Opens `/admin/api/stripe/rest` for the listed Stripe SDK methods. |
| `webhooksModule` | none | `{ moduleId, exportName }` of a server module that exports your webhook handlers. |
| `webhookEndpoint` | `true` if `webhooksModule` is set | Serves the public `/api/stripe/webhooks` endpoint. |
| `logs` | `false` | Logs each sync and webhook event. |

`astro.config` holds no Stripe secrets. The old `stripeSecretKey` and `stripeWebhooksEndpointSecret` options are ignored with a warning; remove them and set the Worker secrets below.

## Worker secrets

The plugin reads its secrets from the Worker environment on each request. They never enter `astro.config` or the server bundle.

| Secret | Needed for | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | sync, REST proxy | The same secret that plugin-ecommerce reads. |
| `TALISMAN_STRIPE_SECRET_KEY` | optional | Takes precedence over `STRIPE_SECRET_KEY`, so this plugin can use a separate [restricted key](https://docs.stripe.com/keys#limit-access). |
| `TALISMAN_STRIPE_WEBHOOK_SECRET` | webhook endpoint | The signing secret of the `/api/stripe/webhooks` endpoint in Stripe. |

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put TALISMAN_STRIPE_WEBHOOK_SECRET
```

For `astro dev`, put test-mode values in `.dev.vars`.

Without the key, a save that would call Stripe is refused with `STRIPE_SECRET_KEY is not set`, and the REST proxy answers `503`. Without the webhook secret, the webhook endpoint answers `503`. The plain `STRIPE_WEBHOOK_SECRET` is not used here, because it is the signing secret of plugin-ecommerce's endpoint and each Stripe endpoint has its own.

## What it syncs

Sync is one-way, from the CMS to Stripe. Changes made in the Stripe Dashboard are not copied back.

- **Save.** The mapped `fields` are sent to Stripe. A record without a Stripe ID creates a new resource, and its ID is saved with the record. A linked record updates its resource. A save that sets none of the mapped fields makes no Stripe call.
- **Delete.** Stripe removal completes before the CMS delete. A Stripe failure refuses the CMS delete with an error; retrying a successful removal after a failed CMS delete is safe. Customers are deleted in Stripe, which also cancels their subscriptions. Products and prices are archived (`active: false`), because Stripe cannot delete prices or products that have prices. Only CMS admins can delete a linked record.
- **Errors.** Stripe failures refuse the CMS save with an editor-visible message. Correct definitive validation/authentication failures and save again. For uncertain connection/server failures, retry the **unchanged mapped fields** within 23 hours. Changing the pending payload is refused. Concurrent saves are refused while an operation holds its one-minute lease. There is no background worker that silently retries or overwrites an editor's data.
- **Recovery.** A durable Drizzle journal records the operation key, payload hash, attempts, outcome, CMS record ID and confirmed Stripe ID. If Stripe creates a resource but the CMS write fails, the resource stays tracked and the next save with the same identity reuses it. If the Stripe result cannot be written to the journal, the next attempt after the lease expires uses the same idempotency key. Uncertain operations older than 23 hours stop for administrator reconciliation; they never issue a fresh create automatically.

### Stable identities and migrations

Set `identityField` to a stored, immutable, unique business key, such as a generated member key or catalog SKU. Supply it on the first synced save and retain it for retries. Do not use mutable email addresses or names. A new unlinked record without this identity is refused before Stripe is called. Changing an existing identity is refused, including on saves without mapped fields. A journal identity bound to one CMS record cannot be used to create another. Deletion keeps a tombstone: use a new identity for a new resource. Existing linked records without an identity can continue using their stored CMS record ID and Stripe ID.

The plugin registers its `drizzle/` migrations whenever `sync` is nonempty. Run `astro sync` or build to assemble migrations into the CMS's configured migration folder, then apply migrations **before** deploying the Worker. The generated migrations create `_stripe_sync` and `_stripe_sync_operations`; they have no dependencies on core or commerce tables. Keep these tables with your CMS backups. Missing tables or DB binding refuse the save. Never truncate the journal or reset operation keys to retry a failed create.

This journal is an audit/recovery mechanism, not a transaction across Stripe and D1. The resource can be ahead of the CMS after a failed CMS write, or deleted/archived while a failed CMS delete leaves the record. Retry the same record/identity to finish; do not create a replacement. If the CMS saved but the audit binding failed, the error explicitly says the record was saved: reload it and have an administrator inspect the journal. Abandoned creates stay visible as unbound journal records; the administrator must complete the original save or verify and remove/archive that Stripe resource, retaining the audit. Do not change the Stripe account or switch test/live mode on an existing journal; use a separate CMS database for each account/mode.

### Administrator reconciliation

With sync enabled, admins can `GET <adminPath>/api/stripe/sync` to inspect the latest 100 resource records and 100 operations, ordered by update time. An unbound record has no `docId`; pending/blocked operations include the operation UUID and safe error category. Payloads and secrets are not stored. Business identities are hashed. Inspect a specific resource's history through a server-side Drizzle query of `stripeOperations` exported from `@talisman-cms/plugin-stripe/schema` when the recent list is insufficient.

For a pending/blocked create or update, find the resource in Stripe's request logs (the idempotency key is `talisman-sync-<operation>`). New resources and updates carry `metadata.talisman_sync_operation`. An admin can `POST <adminPath>/api/stripe/sync` with `{ "operation": "<operation UUID>", "stripeId": "cus_..." }`. The endpoint retrieves the resource with the Worker key and verifies its operation metadata before recording recovery. It never creates a resource. Unknown IDs and mismatched metadata are refused. A confirmed product/price archive can also be reconciled by its stored ID and `active: false`. Retry the original CMS save/delete afterward.

Customer DELETE is inherently idempotent: retry the original administrator CMS delete; Stripe's `resource_missing` response counts as confirmation that it was removed. If a customer delete reaches the retry cutoff, the same admin reconciliation endpoint verifies that the journal's original customer ID is deleted or missing in Stripe before confirming the deletion. Do not reset an uncertain **create** as absent: Stripe may have executed it despite the failed response. If no successful result can be verified, keep it blocked and investigate with Stripe; creating a replacement is not an automatic recovery option.

Stripe clients explicitly use a **10,000 ms timeout per attempt and one network retry** (up to two attempts, plus SDK backoff). They retain the supported **`2022-08-01` API version** already used by this plugin, deliberately overriding the newer SDK's default to preserve customer/product/price and allow-listed proxy behavior. Webhook payload versions remain controlled by the Stripe endpoint. See [Stripe API versioning](https://docs.stripe.com/api/versioning), [SDK network retries](https://github.com/stripe/stripe-node#network-retries), and [Stripe idempotency rules](https://docs.stripe.com/api/errors#idempotent-requests). Stripe can prune keys after 24 hours and cache failed responses, including 500s; the plugin's 23-hour cutoff leaves a margin and requires verified recovery instead of guessing.

Prices retain their existing Stripe semantics: amount, currency and product are immutable on an existing price. Such changes fail visibly; the plugin does not silently replace a price or create another product. Create a separate price record with a new identity when appropriate.

The Stripe ID is stored in the record's `stripeID` data field. Set `stripeIdField` in a sync entry to use another name. It is not added as a form field. The plugin always takes it from the stored record, so the value is available through the CMS API but cannot be edited.

### Native tables

For a collection with `nativeSchemaMapping`, the ID must be stored in a column of the mapped Drizzle table. Add a text column, for example `stripeID: text('stripe_id')`, and migrate the database, or set `stripeIdField` to the column's property name. The configured `identityField` must also name a stored column. Without the ID column the ID could not be stored and each save would create another Stripe resource, so the plugin refuses every save to the collection with a clear error. plugin-ecommerce's `products` table has no such column, so do not sync it; plugin-ecommerce sends product details to Stripe Checkout with each order and does not need Stripe products.

## Webhooks

Export the handlers from a server module, either one function for every event or an object keyed by event type:

```ts
// src/stripe-webhooks.ts
export const stripeWebhooks = {
  'customer.updated': async (event) => { /* write to D1 */ },
};
```

```ts
import { fileURLToPath } from 'node:url';

stripePlugin({
  webhooksModule: {
    moduleId: fileURLToPath(new URL('./src/stripe-webhooks.ts', import.meta.url)),
    exportName: 'stripeWebhooks',
  },
})
```

In the Stripe Dashboard, add an endpoint for `https://<your-site>/api/stripe/webhooks` with the events you handle, and store its signing secret as `TALISMAN_STRIPE_WEBHOOK_SECRET`. The endpoint verifies each signature before a handler runs. It answers `500` when a handler throws, so Stripe retries the event. Handlers that write to D1 directly do not run the collection hooks, so they cannot start a sync loop.

## REST proxy

```ts
stripePlugin({ rest: true, restMethods: ['customers.retrieve', 'products.list'] })
```

CMS admins can then `POST /admin/api/stripe/rest` with `{ "stripeMethod": "customers.retrieve", "stripeArgs": ["cus_..."] }`. Methods that are not listed are refused, and the endpoint is not added when the list is empty.

## Security notes

- Keys come only from Worker secrets. Values in `astro.config` are ignored and never compiled into the bundle.
- Stripe IDs are read only from the stored record. A `stripeID` or the retired `skipSync` flag sent by the admin form or an API client is ignored, so an editor cannot point a record at another Stripe resource or skip a sync.
- Deleting a linked record requires the CMS admin role, which the plugin checks in addition to the CMS. The delete is refused while the key is missing, so a record is not removed without its Stripe resource.
- The REST proxy is admin-only and runs only the listed methods, but each runs with the full key. List only the methods you need, and consider a restricted key in `TALISMAN_STRIPE_SECRET_KEY`.
- The webhook endpoint is public. It is added only when enabled, and it processes only events signed with its own secret.
