# Talisman CMS

Talisman CMS is a Cloudflare-native CMS integration for Astro. The release checks in this repository use Astro 7.

Licensed under Apache-2.0; see `LICENSE.md` in the package.

Drop in a beautifully designed, premium React dashboard directly into your Astro app. Manage content backed by Drizzle ORM on D1, store media in R2, and fetch your content via our ultra-low latency KV edge cache SDK.

## Features

- **Astro integration:** Admin routes, an Astro content loader, a Dev Toolbar app, and Cloudflare Worker support. Astro 7 with `@astrojs/cloudflare` v14 is covered by the release build.
- **Built-In Dev Toolbar App:** Added to the Astro Dev Toolbar under `astro dev`. It links to the admin at the configured `adminPath` and to each configured collection and global, lists the registered UI libraries, checks the `DB` binding through the CMS health route, shows the current route path, and has an inspector that outlines layout blocks marked with `data-talisman-block`.
- **Astro content loaders:** `talismanLiveLoader({ collection })` reads Cloudflare data at request time. Build-time `talismanLoader()` requires a `buildEntries` callback available in Node.
- **Deep Cloudflare Integration:** Uses D1 for relational queries, R2 for Media Storage, and KV for lightning fast read-through caching.
- **Authentication:** Local email/password accounts on D1 with admin/editor roles, Cloudflare Access sign-in (alone or for admins alongside local editors), or a custom runtime adapter. Private routes reject requests when no adapter is configured.
- **React 19 Frontend:** Premium, glassmorphic UI built with Radix Primitives and Tailwind CSS v4, utilizing TanStack Router for rapid SPA navigation.
- **Type-Safe SDK & Actions:** Fetch content via `getClient()` or perform actions via `@talisman-cms/plugin-ecommerce/actions`.

## Installation

```bash
pnpm add talisman-cms @astrojs/cloudflare react react-dom
pnpm add -D wrangler
```

`react` and `react-dom` are peer dependencies: the admin dashboard uses the app's copies, so install them in the app even if it has no React components of its own.

## Basic Setup

Add the CMS to your `astro.config.mjs` and use the local adapter:

```ts
import { defineConfig } from 'astro/config';
import talismanCms from 'talisman-cms';
import { LocalAuthAdapter } from 'talisman-cms/auth/local';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [
    talismanCms({
      auth: LocalAuthAdapter()
    })
  ]
});
```

### Worker bindings

The CMS reads its Cloudflare resources from these fixed binding names. Add them to the site's `wrangler.toml`:

```toml
name = "my-site"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "my-site-db"
database_id = "<D1 database ID>"
migrations_dir = "node_modules/.talisman-cms/migrations"

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "my-site-media"

[[kv_namespaces]]
binding = "KV"
id = "<KV namespace ID>"

[images]
binding = "IMAGES"
```

- `DB` (D1, required): content, auth and commerce tables. Setup and sign-in fail without it.
- `STORAGE` (R2, required for media): uploads return HTTP 503 without it.
- `KV` (optional): read-through cache for collection, global, and `depth: 0` entry reads of server code. Without it, reads go to D1. Entries and globals are cached for an hour and cleared by every write through the admin API or `getClient`; native collections are cached only when a read passes `cache: true`, for a minute, because plugin SQL writes them without clearing anything. Server code that writes rows to D1 directly calls `invalidateEntryCache(env, collectionSlug, ids)`, `invalidateGlobalCache(env, slug)` or `invalidateCollectionCache(env)` from `talisman-cms/client` once the write has committed.
- `IMAGES` (optional): responsive WebP variants; see [Public site performance](#public-site-performance).
- `TALISMAN_PUBLISH_WORKFLOW` (optional Workflow binding): runs publish and archive transitions. Change the name with the integration's `publishing.workflowBinding` option. Without it, transitions run in the request.
- `EMAIL` (optional `[[send_email]]` binding): sends transactional email, such as the ecommerce plugin's shopper sign-in links, order confirmations, shipment notices and gift card claim links. See [Email](#email).

The CMS reads no other binding. It uses no Queue, so a `QUEUE` producer added for an earlier version can be removed. `@astrojs/cloudflare` may ask for a `SESSION` KV namespace for Astro's own sessions; the CMS does not use it.

The Worker must use the `nodejs_compat` flag with a compatibility date of at least `2024-09-23`.

### Setting names

Talisman settings and the default Workflow binding use the `TALISMAN_` prefix. Pre-release deployments used `GALAXY_` for the same names, for example `GALAXY_AUTH_SECRET`. A `GALAXY_` name is still read when its `TALISMAN_` name is missing or blank, and the Worker logs one deprecation warning. To migrate, rename each key and keep its value; for example, keep the same auth secret so sessions stay valid. Plugins can read settings the same way with `readSetting(env, 'AUTH_SECRET')` and `readBinding(env, 'PUBLISH_WORKFLOW')` from `talisman-cms/env`.

The `galaxy_` prefix on CMS database tables, such as `galaxy_entries` and `galaxy_auth_user`, is internal and permanent. Migrations keep these names; do not rename the tables.

### Settings reference

Set secrets with `wrangler secret put` in production and in `.dev.vars` locally, and other settings under `[vars]`. Every `TALISMAN_` name below is also read under its old `GALAXY_` name; the `STRIPE_` and `CLOUDFLARE_ANALYTICS_` names have no other form.

| Setting | Secret | Read by | Purpose |
| --- | --- | --- | --- |
| `TALISMAN_AUTH_SECRET` | yes | core: local and hybrid auth | Signs CMS sessions. At least 32 random characters; keep it stable across deploys. See [Secrets and first admin](#secrets-and-first-admin). |
| `TALISMAN_AUTH_SETUP_TOKEN` | yes | core: local auth | One-time token for creating the first admin. Remove it after setup. |
| `TALISMAN_ACCESS_TEAM_DOMAIN`, `TALISMAN_ACCESS_AUDIENCE` | no | core: Access gate, Access and hybrid auth | The Cloudflare Access team URL and application AUD tag. Set both or neither. See [Optional Cloudflare Access gate](#optional-cloudflare-access-gate). |
| `TALISMAN_ACCESS_ADMIN_EMAILS` | no | core: Access and hybrid auth | Comma-separated admin allowlist. |
| `TALISMAN_ACCESS_EDITOR_EMAILS` | no | core: Access auth | Optional comma-separated editor allowlist. |
| `TALISMAN_EMAIL_PROVIDER` | no | core: email | `cloudflare`, `custom`, `console` or `none`. See [Email](#email). |
| `TALISMAN_EMAIL_BINDING` | no | core: email | Name of the `send_email` binding when it is not `EMAIL`. |
| `TALISMAN_EMAIL_FROM`, `TALISMAN_EMAIL_REPLY_TO` | no | core: email | Default sender and optional Reply-To. |
| `TALISMAN_PUBLIC_ORIGIN` | no | core: email; ecommerce | The site's public origin, used to build links. |
| `TALISMAN_COMMERCE_CHECKOUT_ENABLED` | no | ecommerce | `true` turns checkout on. Off by default. |
| `TALISMAN_COMMERCE_STRIPE_MODE` | no | ecommerce | `test` (default) or `live`. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | yes | ecommerce; the key also plugin-stripe | Stripe API key and the signing secret of the ecommerce webhook endpoint. |
| `TALISMAN_COMMERCE_LOCAL_STRIPE_SECRET_KEY`, `TALISMAN_COMMERCE_LOCAL_STRIPE_WEBHOOK_SECRET` | yes | ecommerce | Test-mode fallbacks for local development, used only when the mode is `test` and the plain Stripe secrets are unset. |
| `TALISMAN_COMMERCE_CURRENCY` | no | ecommerce; core: admin | The store currency, an ISO 4217 code that the ecommerce plugin supports, such as `eur` (default `usd`). Commerce amounts are integers in its minor units, and the admin shows them in it. |
| `TALISMAN_COMMERCE_DELIVERY_COUNTRIES` | no | ecommerce | ISO 3166-1 alpha-2 codes of the countries the store delivers to, such as `US, CA`. Unset: any country. |
| `TALISMAN_COMMERCE_SHIPPING_RATES` | no | ecommerce | A JSON list of up to 10 shipping rates. Unset: no shipping charge. |
| `TALISMAN_COMMERCE_TAX` | no | ecommerce | `none` (default), `stripe-inclusive` or `stripe-exclusive`: tax calculated with Stripe Tax. |
| `TALISMAN_COMMERCE_TAX_CODE`, `TALISMAN_COMMERCE_SHIP_FROM_COUNTRY` | no | ecommerce | Optional Stripe product tax code for every item, and the country the goods ship from. |
| `TALISMAN_COMMERCE_EMAIL_FROM`, `TALISMAN_COMMERCE_PUBLIC_ORIGIN` | no | ecommerce | Override `TALISMAN_EMAIL_FROM` and `TALISMAN_PUBLIC_ORIGIN` for shopper email. |
| `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` | no | ecommerce | Store-wide cap on sign-in emails per 24 hours (default 200). |
| `TALISMAN_COMMERCE_EMAIL_RESERVED_DAILY` | no | ecommerce | Part of the daily cap kept for shoppers with a verified account or an order (default a quarter of it). |
| `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY` | no | ecommerce | Cloudflare Turnstile site key for the shopper sign-in check. Set together with the secret. |
| `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` | yes | ecommerce | Turnstile secret; with it set, email sign-in requests need a valid token. |
| `TALISMAN_COMMERCE_GIFT_CARDS_ENABLED` | no | ecommerce | `true` turns gift card purchases on, together with checkout. |
| `TALISMAN_COMMERCE_GIFT_CARD_KEY` | yes | ecommerce | 64 hex characters that encrypt gift card codes. Keep it stable and backed up. |
| `TALISMAN_COMMERCE_GIFT_CARD_PREVIOUS_KEYS` | yes | ecommerce | Comma-separated older gift card keys that still decrypt codes after a key rotation; keep them only until every code is re-encrypted. |
| `TALISMAN_COMMERCE_STORE_NAME`, `TALISMAN_COMMERCE_STORE_LEGAL_NAME`, `TALISMAN_COMMERCE_STORE_ADDRESS` | no | ecommerce | The store's name, legal name and postal address, with a line break between address lines, as order emails show them. |
| `TALISMAN_COMMERCE_SUPPORT_EMAIL` | no | ecommerce | The support address shown in order emails, and their Reply-To. Unset, the emails show the `TALISMAN_EMAIL_REPLY_TO` address. |
| `TALISMAN_COMMERCE_TERMS_URL`, `TALISMAN_COMMERCE_RETURNS_URL`, `TALISMAN_COMMERCE_WARRANTY_URL` | no | ecommerce | Links to the terms of sale, the returns and right of withdrawal page and the warranty page in order confirmations: an https URL or a path on the public origin. |
| `TALISMAN_COMMERCE_REFERRALS_ENABLED` | no | ecommerce | `true` turns referrals on while no referral settings are saved in the admin. Off by default. |
| `TALISMAN_COMMERCE_REFERRAL_REWARD_CENTS`, `TALISMAN_COMMERCE_REFERRAL_MIN_ORDER_CENTS` | no | ecommerce | Referral defaults in the store currency's minor units; settings saved in the admin override them. The reward must be at most half the minimum. |
| `TALISMAN_COMMERCE_REFERRAL_HOLD_DAYS`, `TALISMAN_COMMERCE_REFERRAL_MAX_PER_PERIOD`, `TALISMAN_COMMERCE_REFERRAL_PERIOD_DAYS` | no | ecommerce | Days referral awards stay pending (default 30), and the cap of referrals per referrer (default 10) per period (default 30 days). |
| `TALISMAN_STRIPE_SECRET_KEY` | yes | plugin-stripe | Optional restricted key that takes precedence over `STRIPE_SECRET_KEY`. |
| `TALISMAN_STRIPE_WEBHOOK_SECRET` | yes | plugin-stripe | Signing secret of the `/api/stripe/webhooks` endpoint. |
| `CLOUDFLARE_ANALYTICS_ACCOUNT_ID`, `CLOUDFLARE_ANALYTICS_SITE_TAG` | no | plugin-analytics | Web Analytics account and site. |
| `CLOUDFLARE_ANALYTICS_API_TOKEN` | yes | plugin-analytics | API token with Account Analytics: Read. |

The ecommerce currency, delivery, shipping and tax settings are checked strictly: an invalid value closes checkout with HTTP 503 instead of falling back to a default. The plugin READMEs describe their settings in full: [ecommerce](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-ecommerce/README.md), [Stripe sync](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-stripe/README.md) and [analytics](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/plugin-analytics/README.md).

### Email

The CMS sends no email itself. Plugins send transactional email through `talisman-cms/email/runtime`, which picks the provider with the `TALISMAN_EMAIL_PROVIDER` setting:

- `cloudflare`: [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) through a `[[send_email]]` binding named `EMAIL`, or the name in `TALISMAN_EMAIL_BINDING`. It must be a `send_email` binding; the names of other common bindings, such as `DB`, `KV`, `STORAGE`, `SESSION` and `QUEUE`, are refused. Email Sending needs the Workers Paid plan and a sending domain on Cloudflare DNS.
- `custom`: the provider registered with the integration's `email` option (below).
- `console`: prints each message, links included, to the Worker log instead of sending it. It runs only when `TALISMAN_PUBLIC_ORIGIN` is a `localhost` origin.
- `none`: email is off.

When the setting is unset, a registered custom provider is used, then a binding named `EMAIL`. An unknown value turns email off and logs one error. Set it explicitly in production.

```toml
[vars]
TALISMAN_EMAIL_PROVIDER = "cloudflare"
TALISMAN_EMAIL_FROM = "My Shop <no-reply@example.com>"
TALISMAN_EMAIL_REPLY_TO = "hello@example.com"
TALISMAN_PUBLIC_ORIGIN = "https://example.com"

[[send_email]]
name = "EMAIL"
allowed_sender_addresses = ["no-reply@example.com"]
```

`TALISMAN_EMAIL_FROM` is the default sender and `TALISMAN_EMAIL_REPLY_TO` the optional Reply-To. `TALISMAN_PUBLIC_ORIGIN` is the site's public origin; plugins build links from it rather than from the request's Host header. Every message has a plain-text part and an `Auto-Submitted: auto-generated` header; custom headers must be `X-` headers, and line breaks in the subject, headers or addresses are rejected. A failed send throws `EmailDeliveryError` with a `code` such as `not_configured`, `recipient_suppressed`, `rate_limited` or `quota_exceeded`, plus the provider's own code. Its message never contains addresses or content, so it can be logged. `wrangler dev` and `astro dev` with the Cloudflare adapter simulate the binding and send nothing; with `remote = true` on the binding, local development sends real mail, so never commit that.

To use another email service, write a provider module in the site and register it. The export is called once in the Worker with `args`, and must return a function that builds the provider from the Worker env for each request, or returns null when the service is not configured. Arguments are written into the build, so pass the names of Worker secrets, never their values:

```ts
// src/email/postmark.ts
import { EmailDeliveryError } from 'talisman-cms/email';
import type { EmailProviderFactory } from 'talisman-cms/email';

export const postmarkEmail = ({ tokenVar = 'POSTMARK_TOKEN' } = {}): EmailProviderFactory => (env) => {
  const token = env[tokenVar];
  if (typeof token !== 'string' || !token) return null;
  return {
    id: 'postmark',
    async send(message) {
      const response = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ /* map message.from, to, replyTo, subject, text, html and headers */ }),
      });
      if (!response.ok) throw new EmailDeliveryError(response.status === 429 ? 'rate_limited' : 'unknown', `Postmark returned ${response.status}`, 'postmark', String(response.status));
      return { provider: 'postmark' };
    },
  };
};
```

```ts
// astro.config.mjs
import { fileURLToPath } from 'node:url';
import { customEmail } from 'talisman-cms/email';

talismanCms({
  email: customEmail({
    moduleId: fileURLToPath(new URL('./src/email/postmark.ts', import.meta.url)),
    exportName: 'postmarkEmail',
    args: [{ tokenVar: 'POSTMARK_TOKEN' }],
  }),
});
```

`moduleId` must be a package name or an absolute path. Plugins can set the same option from `onInit`. Resend is not built in; register it the same way if you use it.

### Database migrations

The CMS and its plugins ship their D1 migrations as numbered `.sql` files. Wrangler applies one folder per binding, so on every config setup (`astro dev`, `astro build`, `astro sync` and `astro check`) the integration copies the core's files and those of every registered plugin into one folder in the project, `node_modules/.talisman-cms/migrations` by default, and logs what it wrote. `migrations_dir` points at that folder, relative to `wrangler.toml`. Run `pnpm exec astro sync` (or a build) first, then apply the migrations before deploying the Worker that needs them:

```sh
pnpm exec astro sync
pnpm exec wrangler d1 migrations apply DB --local   # local development
pnpm exec wrangler d1 migrations apply DB --remote  # production database
```

The folder is written by the build, so it is not committed. The assembled set depends on the plugins registered in `astro.config`: `talisman-cms` ships `0000` to `0024`, and `@talisman-cms/plugin-ecommerce` ships `0025` onwards. The core files through `0024` also create the commerce tables of their time and `0019` changes both the CMS user tables and the shopper accounts, so those files stay in the core even for a site without the plugin; wrangler records each file by name, and a file name never changes once a database has applied it. A `sources.json` beside the files names the package each one comes from. The integration fails the build when a `migrations_dir` in `wrangler.toml`, `wrangler.json` or `wrangler.jsonc` still points at the core package's own `drizzle` folder while a plugin ships migrations, and warns when no binding points at the assembled folder. The `migrationsDir` integration option moves the folder; keep `migrations_dir` in step with it.

Sites that used `migrations_dir = "node_modules/talisman-cms/drizzle"` change it to the assembled folder and run `astro sync` or a build before the next `wrangler d1 migrations apply`. A database that already applied `0000` to `0030` has nothing new to apply; the files keep their names when they move between packages.

Wrangler reads one `migrations_dir` per binding. If the site has its own migrations, add a second `[[d1_databases]]` entry for the same database with another binding name, the app's folder, and its own `migrations_table`. Then apply each set by binding name (`DB`, then `APP_DB`). Keep the CMS on the `DB` binding and the default `d1_migrations` table; moving it to another table on an existing database would re-run migrations that were already applied.

```toml
[[d1_databases]]
binding = "APP_DB"
database_name = "my-site-db"
database_id = "<same D1 database ID>"
migrations_dir = "migrations"
migrations_table = "app_migrations"
```

When upgrading an existing database, run these checks before applying the new migrations. Each must return no rows; resolve any duplicates first. Migration `0018` adds a unique revision-number index, `0019` allows only one CMS user per email regardless of letter case, and `0023` allows only one published entry per slug in a collection.

```sql
-- Before 0018_entry_revision_integrity.sql
SELECT entry_id, revision_number, COUNT(*) AS copies
FROM galaxy_entry_revisions
GROUP BY entry_id, revision_number
HAVING COUNT(*) > 1;

-- Before 0019_shared_customer_identity.sql
SELECT lower(email) AS email, COUNT(*) AS copies
FROM galaxy_auth_user
GROUP BY lower(email)
HAVING COUNT(*) > 1;

-- Before 0023_published_slug_unique.sql
SELECT collection_id, slug, COUNT(*) AS copies
FROM galaxy_entries
WHERE status = 'published'
GROUP BY collection_id, slug
HAVING COUNT(*) > 1;
```

Version 0.1.0 adds `0019_shared_customer_identity.sql` through `0030_commerce_order_emails.sql`; `0025` to `0030` ship in `@talisman-cms/plugin-ecommerce`. Migration `0019` adds the session column the local and hybrid adapters now read, so their sign-ins fail until it is applied. It also lowercases stored CMS emails and links verified ecommerce shoppers to the shared user identity described below. Migration `0020` needs no check: it records a baseline revision for entries that have none, such as seeded rows, and unwraps globals stored as double-encoded JSON. `0021` adds the draft slug column that every entry read and save needs. `0022` keeps global data that is not a JSON object, such as a list, under a `value` key, so code that reads such a global reads `data.value`. For each slug the `0023` check lists, rename all but one of the entries and publish them again, or unpublish them. `0024` adds the ecommerce plugin's sign-in link and rate-limit tables; shopper sign-in fails without it. `0025` needs no check: it adds the shipping and tax columns of ecommerce orders and a table for tax reversals, and recreates the discount and gift card redemption guards so that an order's totals include its shipping and exclusive tax. Existing orders balance as before, and the previous Worker keeps working after it; the ecommerce plugin's order reads fail without it. `0026` to `0030` need no check either: each keeps every existing row, and the previous Worker keeps working after it. `0026` records fulfillment apart from payment: it adds `_ecommerce_orders.fulfillment_status`, moves the old `fulfilled` order status there, and rebuilds `_ecommerce_fulfillments` so that an order can ship in several parcels and a shipment can be corrected. `0027` adds the columns and table for resolving gift card purchases held for review and for replacement cards. `0028` adds tables for dated provider refunds, payment disputes and restocks. `0029` adds reconciliation and tax attempt columns, a table of administrator decisions on parked checkouts, and indexes for reconciliation, the tax passes and webhook lookups. `0030` adds the delivery log of the ecommerce plugin's order emails and the gift card claim links. The ecommerce plugin's order reads fail without `0026` and `0029`, its gift card reads without `0027` and `0029`, its order refund and dispute webhooks without `0028`, and payment confirmation, shipments and gift card purchases without `0030`. The [release checklist](https://github.com/jakobholmelund/talisman-cms/blob/main/RELEASE.md#deployment-gate) describes each migration.

The migrations are hand-written SQL; the packages do not use `drizzle-kit` to generate them. The Drizzle table definitions in the core and the ecommerce plugin describe the columns the runtime queries, not the triggers, CHECK constraints or partial indexes, so they cannot produce a migration. To change the schema in this repository, add the next numbered `.sql` file to the `drizzle/` folder of the package that owns the change and its entry to that package's `drizzle/meta/_journal.json`; never edit a migration that has shipped. One sequence of numbers runs across the core and every plugin, so the next migration anywhere takes the number after the highest one in use (`0031` after this release), and the assembler refuses two files with the same name or the same number. The core's `test/migrations.test.mjs` applies its chain to an empty database and to one holding data from earlier releases; the ecommerce plugin's `test/migrations.test.mjs` assembles both sets, applies them as wrangler does to a fresh database and to a seeded one at `0024`, and checks that the result matches.

#### Plugin migrations

A plugin ships migrations by naming its folder:

```ts
import { fileURLToPath } from 'node:url';

export function myPlugin(): Plugin {
  return {
    name: 'my-plugin',
    // NNNN_name.sql files, with a drizzle/meta/_journal.json like the core's.
    migrations: { dir: fileURLToPath(new URL('../drizzle/', import.meta.url)) },
    // ...
  };
}
```

The integration lists the core's folder first, then each plugin's in registration order, and copies them all into the assembled folder. The numbers must continue the shared sequence: a plugin cannot renumber or replace a core file, and two plugins cannot share a number. The same tools are exported from `talisman-cms/migrations` for tests and scripts: `listMigrationSources(sources)` returns the files of several `{ name, dir }` sources in wrangler's order and throws on a shared name or number, and `assembleMigrations({ sources, outDir })` writes them into a folder, removing `.sql` files no source ships any more.

### Scheduled jobs

A plugin that needs a cron job declares one with `scheduled: { moduleId, exportName }` (`exportName` defaults to `scheduled`); the export is a `ScheduledJob` from `talisman-cms/worker`, a function of `{ cron, scheduledTime, env, waitUntil }`. The Cloudflare adapter's default Worker entry has no scheduled handler, so the site names its own entry in `wrangler.toml` and adds a cron trigger. The entry exports Astro's fetch handler next to the CMS's scheduled handler:

```ts
// src/worker.ts
import { handle } from '@astrojs/cloudflare/handler';
import { scheduled } from 'talisman-cms/worker';

export default { fetch: handle, scheduled };
```

```toml
main = "./src/worker.ts"

[triggers]
crons = ["*/10 * * * *"]
```

On every tick the handler runs the job of every plugin that declares one, in registration order. A job that throws is logged as `[talisman-cms] <plugin> scheduled job failed: <message>` and never skips the next one, and after the run one error naming the failed plugins is thrown, so the invocation is recorded as failed. The integration warns at build time when a plugin declares a job and no wrangler config names a cron trigger. A site with jobs of its own runs them through `runScheduledJobs`, also exported from `talisman-cms/worker`. The ecommerce plugin registers its checkout reconciliation and retention purge this way; its README says what they do.

### Secrets and first admin

The local adapter needs two distinct Worker secrets: `TALISMAN_AUTH_SECRET` (at least 32 random characters, retained for sessions) and `TALISMAN_AUTH_SETUP_TOKEN` (at least 32 random characters, needed only for first-admin setup). For local development, put them in `.dev.vars` and keep that file out of version control:

```text
# Each must be a distinct random value of at least 32 characters.
# Generate with: openssl rand -hex 32
TALISMAN_AUTH_SECRET=
TALISMAN_AUTH_SETUP_TOKEN=
```

Fill in both values before starting the dev server; never copy example or placeholder values. For production, set each with `wrangler secret put`, using values generated for that environment.

Open `/admin` and enter the setup token, then a name, email, and a password of 12–128 characters, to create the first admin. Remove `TALISMAN_AUTH_SETUP_TOKEN` from production after setup. The hybrid and Access-only adapters below do not use the setup token; their admins come from the Cloudflare Access allowlist. An admin can create, change roles, disable, enable, and remove editor/admin accounts in **Users**, and reset their passwords; CMS accounts cannot sign up publicly. Shopper sign-in through the ecommerce plugin adds users with the `customer` role, which cannot open the CMS. Role changes and password resets revoke existing sessions. The current admin and the last active admin are protected from losing admin access. Users can change their own password in **Account**. CMS login sessions expire after 12 hours. Keep `TALISMAN_AUTH_SECRET` stable across deployments; replacing it invalidates sessions.

### Admin screens and API clients

The [admin coverage audit](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/talisman-cms/docs/admin-coverage.md) in the source repository lists supported screens and remaining API/UI gaps.

For direct admin API clients, versioned entry updates, publish/archive actions, and revision restores require `expectedRevisionId` in the JSON body. Read the current `latestRevisionId` from the entry GET response before changing it, or from the response of the write that came before: create, update, publish, archive and restore all answer with the revision they made. A stale revision returns HTTP 409 and a missing revision ID returns HTTP 428. The admin editor supplies this automatically.

Entry lists take `where`, `sort` and `offset`: `GET .../entries?where[productId]=<id>&where[status][in]=draft,published&sort=-createdAt&limit=50&offset=50`. A field is a configured field or one of `id`, `slug`, `status`, `createdAt`, `updatedAt` and `publishedAt`; the operators are `eq` (the default), `ne`, `in`, `lt`, `lte`, `gt`, `gte` (numbers and dates), `contains` (a relationship with `hasMany` or an array) and `isNull`. An unknown field or a comparison the field's type does not take answers 400 with the field in `fieldErrors`. With `sort` or `offset` the list pages by offset and returns no `nextCursor`.

### Plugin admin extension points

A plugin adds screens to the admin through fields of its `Plugin` object. Every component path is a module specifier the site's build can resolve, such as a package export, and the components load lazily when first shown; the `@talisman-cms/plugin-ecommerce` package is the reference implementation, and [Build a plugin](docs/build-a-plugin.md) walks through the whole plugin contract, from `onInit` to migrations and scheduled jobs.

- `adminSections`: sections next to Collections, each with a sidebar entry and the routes `/<id>`, `/<id>/<slug>` and `/<id>/<slug>/<entryId>`. A collection joins a section by naming its `id` in `adminSection`; a collection whose section is not registered is listed under Collections. `adminOnly` keeps the workspace and its tools for admins, while editors get the section's readable collections under Collections. `componentPath` names a workspace page (default export, `AdminSectionWorkspaceProps` from `talisman-cms/ui/lib/admin-sections`: the section, its collections with item counts, its `adminLinks`, the admin base path and the user); without one the section shows the generic collection table. Ids are lowercase slugs, unique across plugins, and cannot be a built-in route (`collections`, `globals`, `media`, `users`, `account`, `extensions`, `api`).
- `adminEditorPanels`: panels the entry editor renders for matching collections, at `before-fields` (in the form card, above the fields) or `after-form` (below the form and its actions). A panel matches by `sections` (the collection's section) or `slugs`; with neither list it matches every collection. The default export receives `AdminEditorPanelProps` (from `talisman-cms/ui/components/editor/panels`): the collection, the saved entry (null before a new record's first save), the form values as they change, the loaded related records, `refreshSupportEntries(slugs)` to load related collections again, the admin base path, the section and the user.
- `adminEntryDescribers`: modules that label records in relation pickers and summaries. `describeEntry(slug, entry, entriesBySlug, ctx)` returns `{ title, subtitle, details }` for a record the plugin knows and null for any other; `supportCollections(slug, relationTargets)` names extra collections the editor of `slug` loads so those labels can name related records. The first describer that answers wins; without one the admin uses the record's `name`, `title`, `value`, `label`, `slug` or id. `ctx.readSetting(name)` reads a setting exposed with `adminSettings`.
- `adminSettings`: names of `TALISMAN_*` settings, without the prefix, that the admin page exposes as `<meta name="talisman-setting-<name in kebab case>" content="...">` for the plugin's screens. The admin page is served before sign-in, so the values are visible to anyone who can load it: name display settings only, such as a currency, never allowlists or credentials. A name that looks like a secret (SECRET, KEY, TOKEN, PASSWORD, CREDENTIAL, PRIVATE_KEY, API_KEY) is refused at config time, and a value that reads like an API key or signing secret is left out of the page.
- `adminStyleSources`: absolute directories Tailwind scans for the admin stylesheet, so plugin screens can use utility classes.
- `FieldDefinition.saveOnlyIfChanged`: the editor sends the field of a native record only when the user changed it, for values that server code moves in place (a stock count).
- `adminLinks` and `routes`: an `adminLinks[].href` or `routes[].path` without a leading slash is relative to the admin path and resolved at config time, so `extensions/orders` is `/admin/extensions/orders` under the default admin path and `/extensions/orders` for an admin at the site root. A path with a leading slash is kept as given. A full URL, a `//host` form, a backslash or an empty value fails the build with the plugin's name, so a plugin link never leaves the site's origin.

```js
const plugin = {
  name: 'my-plugin',
  onInit: (config) => config,
  adminSections: [{ id: 'reviews', label: 'Reviews', icon: 'chart', adminOnly: true,
    componentPath: 'my-plugin/admin/ReviewsWorkspace' }],
  adminEditorPanels: [{ id: 'review-preview', placement: 'after-form', slugs: ['reviews'],
    componentPath: 'my-plugin/admin/ReviewPreviewPanel' }],
  adminEntryDescribers: [{ modulePath: 'my-plugin/admin/describe' }],
  adminSettings: ['REVIEWS_LOCALE'],
};
```

Plugin admin code gets the admin's paths and session from `talisman-cms/ui/sdk` and never reads the admin path from `window.location`: `adminPath` is the configured admin path (`/admin` by default, `/` at the site root); `adminUrl(path?)` is a URL under it (`adminUrl('extensions/orders')`); `adminApiUrl(path)` is an endpoint under it (`adminApiUrl('reviews/list')` is `<adminPath>/api/reviews/list`); `adminRequest(path, { method?, body?, signal?, headers? })` makes a JSON request to that endpoint with the CMS session, GET without a body and POST with one, and throws the answer's `error` text, or "Request failed"; `readAdminSetting(name)` reads a setting exposed with `adminSettings`; and `useAdminUser()` is the signed-in user's `role` and `email`, or null. Plugin admin code may also import the admin's own building blocks through the `talisman-cms/ui/*` export, for example `talisman-cms/ui/components/ui/button`. The Commerce section, the product editor's options panel and the commerce record labels come from the ecommerce plugin this way; without it the admin has no Commerce section.

### Server SDK, actors and hooks

`getClient(env)` and the admin API are two entry points of one service. Every call carries an actor: the admin API acts as its signed-in `user`, and `getClient` as `system`, trusted server code that holds the bindings. Validation, hooks, slug uniqueness and cache invalidation apply to both; a collection's `access` and `readOnly` rules, the operations kept to administrators and the media collection's upload-only records apply to users. Server code may also leave the revision token out of an update and write native columns outside the configured fields. A plugin route that holds a CMS session gets the admin API's rules with `getClient(env, ctx, { actor: userActor(user, request) })`, and `createService(env, { config: await loadServiceConfig(), actor })` from `talisman-cms/client` gives the service itself.

Collection hooks (`beforeValidate`, `beforeChange`, `afterChange`, `beforeDelete`, `afterDelete`) run in the same order for both callers and receive `{ data, operation, originalDoc, actor, req, collection }`, where `req` is set only for admin API writes. A hook that throws one of the error classes exported from `talisman-cms/client` (`ValidationError`, `AccessDeniedError`, `NotFoundError`, `ConflictError` and the others) refuses the write with that status; any other throw answers 500 with the hook's message, and `HookError` tells an SDK caller which phase failed and whether the row was already committed.

### Optional Cloudflare Access gate

Each installing project can protect its CMS admin path and all child paths with its own Cloudflare Access application. Set `TALISMAN_ACCESS_TEAM_DOMAIN` to that project's `https://<team>.cloudflareaccess.com` URL and `TALISMAN_ACCESS_AUDIENCE` to its application AUD tag. If either is set, the CMS requires both, verifies the Access JWT in the Worker, and requires its email to match the local account email. The integration passes its `adminPath` to the adapter when the Worker loads it, so `LocalAuthAdapter()`, `HybridAuthAdapter()` and `AccessAuthAdapter()` take no path; a path passed anyway must match the integration's, or the build fails. Public media, cart, checkout, and Stripe webhook routes live under `/api` and must remain outside the Access application. Stripe webhooks authenticate with their signature; checkout remains disabled by default.

For Cloudflare Access login without a separate CMS password, use `AccessAuthAdapter` from `talisman-cms/auth/access` as the integration's `auth` option. Set both Access values above and `TALISMAN_ACCESS_ADMIN_EMAILS` to a comma-separated list of allowed admin emails; optional `TALISMAN_ACCESS_EDITOR_EMAILS` grants editor access. The Worker grants no access when either Access value or an email allowlist is missing. Protect both the admin base path and its child paths with a self-hosted Access application. This adapter does not use the local account tables, password setup or `TALISMAN_AUTH_SECRET`.

For local editor passwords with Cloudflare SSO for admins, use `HybridAuthAdapter` from `talisman-cms/auth/hybrid`. Configure `TALISMAN_AUTH_SECRET` and the Access team domain, audience, and admin email allowlist. Protect only `<adminPath>/sso` with a Cloudflare Access application; leave the rest of `<adminPath>` reachable so editors can see the local login. Every CMS API route still requires a CMS session. The SSO route verifies the Access JWT and mints the CMS session directly, marked as Cloudflare authenticated; no password is involved, an SSO-managed admin has no password credential (one stored by an earlier version is removed on the next sign-in), and the auth secret signs session cookies and nothing else. Admin sessions require that marker and a currently allowlisted email. Signing in from a second browser leaves the first session signed in, and prunes sessions that have expired or passed the age cap; sessions still end after 12 idle hours and 7 days at most. Cloudflare Access is what limits requests to the SSO route; an unverified request touches nothing. In this mode, local password accounts are editors; admins sign in through Cloudflare. In **Users**, an admin can add editors, give a verified shopper editor access by setting a password with **Add editor**, and revoke CMS access; users are not removed, so the shared identity remains. Keep the auth secret stable so existing sessions remain valid. The CMS stores one user identity per verified email; the ecommerce plugin links shopper profiles to that identity while retaining separate shopper sessions. `ensureVerifiedEmailIdentity(env, email, name)` from `talisman-cms/auth/identity` finds or creates that identity for another plugin; call it only after the user has proved control of the address. New identities get the `customer` role, which has no CMS access.

Local and hybrid password sign-in hash passwords with scrypt, which takes more CPU than the Workers Free plan allows a request; run them on Workers Paid, or with a CPU limit of at least about 100 ms. The Cloudflare SSO sign-in does no hashing.

Media uploaded before this route change may have URLs beginning `/<adminPath>/api/media/` (normally `/admin/api/media/`). Change those stored URLs to `/api/media/` before protecting the admin path with Access, including URLs copied into entry data.

Uploads accept JPEG, PNG, GIF, WebP, and AVIF images up to 10 MiB. The server checks file signatures and serves other pre-existing media as downloads. Set `access` on a collection to require administrators for generic CMS operations, for example `{ read: 'admin', create: 'admin', update: 'admin', delete: 'admin' }`. The commerce plugin applies this to its native tables; its cart and customer tables are also read-only through the generic editor.

`DevAuthAdapter` only authenticates local hosts. Custom production adapters must export a factory or value from a server module and set `__talismanAuthRuntime` to that module and export. Collection hooks likewise belong in server modules referenced by `runtimeHooks`; inline functions in Astro config are rejected during setup.

For example, export `postHooks` from `src/cms-hooks.ts`, then register it on a collection:

```ts
import { fileURLToPath } from 'node:url';

const posts = {
  name: 'Posts',
  slug: 'posts',
  fields: [{ name: 'title', label: 'Title', type: 'text', required: true }],
  runtimeHooks: [{
    moduleId: fileURLToPath(new URL('./src/cms-hooks.ts', import.meta.url)),
    exportName: 'postHooks',
  }],
};
```

The hook module is imported only into the server bundle. A hook factory can set `factory: true` and receive JSON-serializable `args`.

## Rendering rich text

`richtext` fields store the admin editor's Tiptap JSON, and editors control what is stored. Render them with `renderRichText` from `talisman-cms/richtext`, and never pass a stored value to `set:html` yourself:

```astro
---
import { renderRichText } from 'talisman-cms/richtext';
const html = renderRichText(post.data.content, { headingOffset: 1 });
---
<article set:html={html} />
```

`renderRichText` escapes all text and outputs only the editor's nodes and marks: paragraphs, headings, lists, blockquotes, code, horizontal rules, line breaks, bold, italic, underline, strike and links. Links keep relative, `http(s)`, `mailto` and `tel` targets and are dropped otherwise. A string value is shown as plain text, never as HTML. `headingOffset: 1` renders the editor's Heading 1 as `<h2>` under the page's own `<h1>`. `richTextToPlainText` returns the text on one line for excerpts and meta descriptions. Astro's `security.csp` option is a useful second layer on public pages.

Content stored as an HTML string, such as the posts from `seeds/ecommerce-demo.sql` before this release, is therefore shown with its tags as literal text. The admin editor displays such a string formatted but saves it back unchanged: it becomes Tiptap JSON only when someone edits that rich text field and saves. Opening and saving the entry, or changing only other fields, keeps the string. An edited field is stored whole as Tiptap JSON, with only the formatting the editor supports. Saving changes the draft, so publish the entry to update the live page. To fix the demo posts, rerun `pnpm --filter talisman-cms db:seed:ecommerce:local`, which replaces them. Convert other HTML-string content by editing each rich text field, or by rewriting the stored values as Tiptap JSON.

## Public site performance

Talisman CMS keeps the admin application separate from public Astro pages. Public media URLs use immutable IDs and cache their R2 responses at the edge when the Cloudflare Cache API is available. The first request in a location still reads R2. Edge caching requires a Worker on a custom domain or route; `workers.dev` previews do not use that cache.

Use `getClient(env).entries.findBySlug('pages', slug, { depth: 0 })` for a dynamic page instead of loading the entire collection and searching it. Use `findMany('posts', { depth: 0, limit: 12 })` for bounded lists, and `findMany('posts', { where: { category: 'news' }, sort: '-createdAt', limit: 12, offset: 12 })` to narrow, order and page in the database; filters read the published snapshot in the published view. `limit` must be a positive integer and is applied in the database before relationship resolution. Published entry reads default to published snapshots. `depth: 0` avoids relation queries and can use KV for unbounded, unfiltered `findMany` and `find` reads; a read with `where`, `sort` or `offset` always goes to D1. The `0009_entry_read_indexes` migration accelerates published lists and slug lookups; filters on entry data fields scan the collection, while native columns use the table's own indexes.

For responsive CMS images on Cloudflare, add an `IMAGES` binding to the site's Wrangler config and use `getMediaImageSrcSet(url)` from `talisman-cms/helpers` with an HTML `sizes` attribute. The media route accepts fixed widths of 320, 640, 960, 1280 and 1920 pixels, serves WebP variants, and caches each variant. Without the binding, it serves the original image. Cloudflare bills Images transformations, so review its pricing before enabling this on a production site.

Page speed also depends on each site's fonts, CSS, JavaScript, image dimensions and hosting configuration. Give images intrinsic dimensions, lazy load images below the first screen, and prioritize the main visible image. Measure production pages on mobile, tablet and desktop after adding real content.

## Search and AI discovery

`talisman-cms/seo` provides editable site defaults, optional fixed-page fields, collection SEO fields, metadata and structured-data builders, and robots/sitemap renderers. Add `createSeoGlobal({ pages: [{ key: 'home', label: 'Home' }] })` to `talismanCms({ globals })`, and spread `createSeoFields()` into collections whose entries have public pages. Editors can then set search titles, descriptions, social images and per-page noindex preferences. Read the global with `getClient(env).globals.find('site-seo')` and pass its `data` through `parseSeoSiteSettings()`.

In an Astro layout, call `resolveSeo({ siteUrl, path, site, page, publicIndexing })` and render its canonical URL, robots directive, Open Graph/Twitter metadata and `jsonLd` (escaped with `serializeJsonLd`). `seoPageFromGlobal(site, 'home')` reads the matching fixed-page override. The deployment-owned `publicIndexing` flag always wins over CMS settings when false, so an editor cannot accidentally launch a draft site. Keep an `X-Robots-Tag` noindex response header and any static-asset noindex headers in sync with that launch gate.

Use `renderRobotsTxt()` and `renderSitemapXml()` in site routes. Include only public canonical URLs in the sitemap, and return 404 for the sitemap before launch. The robots helper can control `OAI-SearchBot` separately from training crawlers (`GPTBot` and `Google-Extended`). A draft site should remain crawlable by general search crawlers so they can see `noindex`; `robots.txt` alone does not keep a URL out of results. No special AI markup or text file is required for Google AI search features. Accurate, useful visible text and matching structured data remain the priority.
