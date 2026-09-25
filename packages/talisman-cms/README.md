# Talisman CMS

Talisman CMS is a Cloudflare-native CMS integration for Astro. The release checks in this repository use Astro 7.

Licensed under Apache-2.0; see `LICENSE.md` in the package.

Drop in a beautifully designed, premium React dashboard directly into your Astro app. Manage content backed by Drizzle ORM on D1, store media in R2, and fetch your content via our ultra-low latency KV edge cache SDK.

## Features

- **Astro integration:** Admin routes, an Astro content loader, a Dev Toolbar app, and Cloudflare Worker support. Astro 7 with `@astrojs/cloudflare` v14 is covered by the release build.
- **Built-In Dev Toolbar App:** Injected automatically into the Astro Dev Toolbar during local development with 1-click admin navigation, the current route path, and an inspector that outlines layout blocks marked with `data-talisman-block`.
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
migrations_dir = "node_modules/talisman-cms/drizzle"

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
- `KV` (optional): read-through cache for collection, global, and `depth: 0` entry reads. Without it, reads go to D1.
- `IMAGES` (optional): responsive WebP variants; see [Public site performance](#public-site-performance).
- `QUEUE` (optional Queue producer): used only by `getClient(env).tasks.enqueueImageProcessing()`. The CMS does not include a queue consumer.

The Worker must use the `nodejs_compat` flag with a compatibility date of at least `2024-09-23`.

### Database migrations

`migrations_dir` points at the SQL migrations shipped in the installed package, relative to `wrangler.toml`. The folder also creates the tables used by `@talisman-cms/plugin-ecommerce`, so apply all of it even if the site does not register that plugin. Apply the migrations through `0019_shared_customer_identity.sql` to the D1 database before deploying the matching Worker:

```sh
pnpm exec wrangler d1 migrations apply DB --local   # local development
pnpm exec wrangler d1 migrations apply DB --remote  # production database
```

Wrangler reads one `migrations_dir` per binding. If the site has its own migrations, add a second `[[d1_databases]]` entry for the same database with another binding name, the app's folder, and its own `migrations_table`. Then apply each set by binding name (`DB`, then `APP_DB`). Keep the CMS on the `DB` binding and the default `d1_migrations` table; moving it to another table on an existing database would re-run migrations that were already applied.

```toml
[[d1_databases]]
binding = "APP_DB"
database_name = "my-site-db"
database_id = "<same D1 database ID>"
migrations_dir = "migrations"
migrations_table = "app_migrations"
```

When upgrading an existing database, run these checks before applying the new migrations. Each must return no rows; resolve any duplicates first. Migration `0018` adds a unique revision-number index, and `0019` allows only one CMS user per email regardless of letter case.

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
```

Migration `0019` adds the session column the local and hybrid adapters now read, so their sign-ins fail until it is applied. It also lowercases stored CMS emails and links verified ecommerce shoppers to the shared user identity described below.

### Secrets and first admin

The local adapter needs two distinct Worker secrets: `GALAXY_AUTH_SECRET` (at least 32 random characters, retained for sessions) and `GALAXY_AUTH_SETUP_TOKEN` (at least 32 random characters, needed only for first-admin setup). For local development, put them in `.dev.vars` and keep that file out of version control:

```text
# Each must be a distinct random value of at least 32 characters.
# Generate with: openssl rand -hex 32
GALAXY_AUTH_SECRET=
GALAXY_AUTH_SETUP_TOKEN=
```

Fill in both values before starting the dev server; never copy example or placeholder values. For production, set each with `wrangler secret put`, using values generated for that environment.

Open `/admin` and enter the setup token, then a name, email, and a password of 12–128 characters, to create the first admin. Remove `GALAXY_AUTH_SETUP_TOKEN` from production after setup. The hybrid and Access-only adapters below do not use the setup token; their admins come from the Cloudflare Access allowlist. An admin can create, change roles, disable, enable, and remove editor/admin accounts in **Users**, and reset their passwords; CMS accounts cannot sign up publicly. Shopper sign-in through the ecommerce plugin adds users with the `customer` role, which cannot open the CMS. Role changes and password resets revoke existing sessions. The current admin and the last active admin are protected from losing admin access. Users can change their own password in **Account**. CMS login sessions expire after 12 hours. Keep `GALAXY_AUTH_SECRET` stable across deployments; replacing it invalidates sessions.

### Admin screens and API clients

The [admin coverage audit](https://github.com/jakobholmelund/talisman-cms/blob/main/packages/talisman-cms/docs/admin-coverage.md) in the source repository lists supported screens and remaining API/UI gaps.

For direct admin API clients, versioned entry updates, publish/archive actions, and revision restores require `expectedRevisionId` in the JSON body. Read the current `latestRevisionId` from the entry GET response before changing it. A stale revision returns HTTP 409 and a missing revision ID returns HTTP 428. The admin editor supplies this automatically.

### Optional Cloudflare Access gate

Each installing project can protect its CMS admin path and all child paths with its own Cloudflare Access application. Set `GALAXY_ACCESS_TEAM_DOMAIN` to that project's `https://<team>.cloudflareaccess.com` URL and `GALAXY_ACCESS_AUDIENCE` to its application AUD tag. If either is set, the CMS requires both, verifies the Access JWT in the Worker, and requires its email to match the local account email. When using a custom `adminPath`, pass the same path to `LocalAuthAdapter(adminPath)`. Public media, cart, checkout, and Stripe webhook routes live under `/api` and must remain outside the Access application. Stripe webhooks authenticate with their signature; checkout remains disabled by default.

For Cloudflare Access login without a separate CMS password, use `AccessAuthAdapter` from `talisman-cms/auth/access` as the integration's `auth` option. Set both Access values above and `GALAXY_ACCESS_ADMIN_EMAILS` to a comma-separated list of allowed admin emails; optional `GALAXY_ACCESS_EDITOR_EMAILS` grants editor access. The Worker grants no access when either Access value or an email allowlist is missing. Protect both the admin base path and its child paths with a self-hosted Access application. This adapter does not use the local account tables, password setup or `GALAXY_AUTH_SECRET`.

For local editor passwords with Cloudflare SSO for admins, use `HybridAuthAdapter` from `talisman-cms/auth/hybrid`. Configure `GALAXY_AUTH_SECRET` and the Access team domain, audience, and admin email allowlist. Protect only `<adminPath>/sso` with a Cloudflare Access application; leave the rest of `<adminPath>` reachable so editors can see the local login. Every CMS API route still requires a CMS session. The SSO route verifies the Access JWT, then marks its new CMS session as Cloudflare authenticated. Admin sessions require that marker and a currently allowlisted email. In this mode, local password accounts are editors; admins sign in through Cloudflare. In **Users**, an admin can add editors, give a verified shopper editor access by setting a password with **Add editor**, and revoke CMS access; users are not removed, so the shared identity remains. Keep the auth secret stable so existing sessions remain valid. The CMS stores one user identity per verified email; the ecommerce plugin links shopper profiles to that identity while retaining separate shopper sessions. `ensureVerifiedEmailIdentity(env, email, name)` from `talisman-cms/auth/identity` finds or creates that identity for another plugin; call it only after the user has proved control of the address. New identities get the `customer` role, which has no CMS access.

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

## Public site performance

Talisman CMS keeps the admin application separate from public Astro pages. Public media URLs use immutable IDs and cache their R2 responses at the edge when the Cloudflare Cache API is available. The first request in a location still reads R2. Edge caching requires a Worker on a custom domain or route; `workers.dev` previews do not use that cache.

Use `getClient(env).entries.findBySlug('pages', slug, { depth: 0 })` for a dynamic page instead of loading the entire collection and searching it. Use `findMany('posts', { depth: 0, limit: 12 })` for bounded lists. `limit` must be a positive integer and is applied in the database before relationship resolution. Published entry reads default to published snapshots. `depth: 0` avoids relation queries and can use KV for unbounded `findMany` and `find` reads. The `0009_entry_read_indexes` migration accelerates published lists and slug lookups.

For responsive CMS images on Cloudflare, add an `IMAGES` binding to the site's Wrangler config and use `getMediaImageSrcSet(url)` from `talisman-cms/helpers` with an HTML `sizes` attribute. The media route accepts fixed widths of 320, 640, 960, 1280 and 1920 pixels, serves WebP variants, and caches each variant. Without the binding, it serves the original image. Cloudflare bills Images transformations, so review its pricing before enabling this on a production site.

Page speed also depends on each site's fonts, CSS, JavaScript, image dimensions and hosting configuration. Give images intrinsic dimensions, lazy load images below the first screen, and prioritize the main visible image. Measure production pages on mobile, tablet and desktop after adding real content.

## Search and AI discovery

`talisman-cms/seo` provides editable site defaults, optional fixed-page fields, collection SEO fields, metadata and structured-data builders, and robots/sitemap renderers. Add `createSeoGlobal({ pages: [{ key: 'home', label: 'Home' }] })` to `talismanCms({ globals })`, and spread `createSeoFields()` into collections whose entries have public pages. Editors can then set search titles, descriptions, social images and per-page noindex preferences. Read the global with `getClient(env).globals.find('site-seo')` and pass its `data` through `parseSeoSiteSettings()`.

In an Astro layout, call `resolveSeo({ siteUrl, path, site, page, publicIndexing })` and render its canonical URL, robots directive, Open Graph/Twitter metadata and `jsonLd` (escaped with `serializeJsonLd`). `seoPageFromGlobal(site, 'home')` reads the matching fixed-page override. The deployment-owned `publicIndexing` flag always wins over CMS settings when false, so an editor cannot accidentally launch a draft site. Keep an `X-Robots-Tag` noindex response header and any static-asset noindex headers in sync with that launch gate.

Use `renderRobotsTxt()` and `renderSitemapXml()` in site routes. Include only public canonical URLs in the sitemap, and return 404 for the sitemap before launch. The robots helper can control `OAI-SearchBot` separately from training crawlers (`GPTBot` and `Google-Extended`). A draft site should remain crawlable by general search crawlers so they can see `noindex`; `robots.txt` alone does not keep a URL out of results. No special AI markup or text file is required for Google AI search features. Accurate, useful visible text and matching structured data remain the priority.
