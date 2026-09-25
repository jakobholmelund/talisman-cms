# Talisman Stripe sync

`@talisman-cms/plugin-stripe` links Talisman CMS collections to Stripe customers, products, or prices. When an editor saves a record, the plugin creates or updates the matching Stripe resource and stores its Stripe ID on the record. It can also receive signed Stripe webhooks and give admins a small, allow-listed proxy to the Stripe API.

Payments do not need this package: `@talisman-cms/plugin-ecommerce` runs hosted checkout, orders, and its own Stripe webhook.

## Installation

```bash
pnpm add @talisman-cms/plugin-stripe
```

The package runs inside the Talisman CMS Worker, so it needs `talisman-cms` and `astro` 7 in the same project.

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
        { name: 'email', label: 'Email', type: 'text', required: true },
        { name: 'name', label: 'Name', type: 'text' },
      ] },
    ],
    plugins: [
      stripePlugin({
        sync: [{
          collection: 'members',
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
- **Delete.** Customers are deleted in Stripe, which also cancels their subscriptions. Products and prices are archived (`active: false`), because Stripe cannot delete prices or products that have prices. Only CMS admins can delete a linked record.
- **Errors.** If Stripe rejects a create or update, the error is logged and the CMS still saves; the next save sends the fields again. A Stripe resource created for a save that the CMS then fails to store is not removed.

The Stripe ID is stored in the record's `stripeID` data field. Set `stripeIdField` in a sync entry to use another name. It is not added as a form field. The plugin always takes it from the stored record, so the value is available through the CMS API but cannot be edited.

### Native tables

For a collection with `nativeSchemaMapping`, the ID must be stored in a column of the mapped Drizzle table. Add a text column, for example `stripeID: text('stripe_id')`, and migrate the database, or set `stripeIdField` to the column's property name. Without that column the ID could not be stored and each save would create another Stripe resource, so the plugin refuses every save to the collection with a clear error. plugin-ecommerce's `products` table has no such column, so do not sync it; plugin-ecommerce sends product details to Stripe Checkout with each order and does not need Stripe products.

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
