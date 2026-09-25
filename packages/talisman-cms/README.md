# Talisman CMS

Talisman CMS is a Cloudflare-native CMS integration for Astro. The release checks in this repository use Astro 7.

Licensed under Apache-2.0; see `LICENSE.md` in the package.

Drop in a beautifully designed, premium React dashboard directly into your Astro app. Manage content backed by Drizzle ORM on D1, store media in R2, and fetch your content via our ultra-low latency KV edge cache SDK.

## Features

- **Astro integration:** Admin routes, an Astro content loader, a Dev Toolbar app, and Cloudflare Worker support. Astro 7 with `@astrojs/cloudflare` v14 is covered by the release build.
- **Built-In Dev Toolbar App:** Injected automatically into the Astro Dev Toolbar during local development with 1-click admin navigation, contextual route editing, and runtime status badges.
- **Astro content loaders:** `talismanLiveLoader({ collection })` reads Cloudflare data at request time. Build-time `talismanLoader()` requires a `buildEntries` callback available in Node.
- **Deep Cloudflare Integration:** Uses D1 for relational queries, R2 for Media Storage, and KV for lightning fast read-through caching.
- **Authentication:** Local email/password accounts on D1 with admin/editor roles, or a custom runtime adapter. Private routes reject requests when no adapter is configured.
- **React 19 Frontend:** Premium, glassmorphic UI built with Radix Primitives and Tailwind CSS v4, utilizing TanStack Router for rapid SPA navigation.
- **Type-Safe SDK & Actions:** Fetch content via `getClient()` or perform actions via `@talisman-cms/plugin-ecommerce/actions`.

## Installation

```bash
pnpm add talisman-cms
```

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

In each project that installs Talisman CMS, apply the migrations in `talisman-cms/drizzle` through `0018_entry_revision_integrity.sql` to its D1 database before deploying the matching Worker. Migration `0018` adds a unique revision-number index; inspect existing revisions for duplicate `(entry_id, revision_number)` values before applying it. Set two distinct Worker secrets: `GALAXY_AUTH_SECRET` (at least 32 random characters, retained for sessions) and `GALAXY_AUTH_SETUP_TOKEN` (at least 32 random characters, needed only for first-admin setup). The Worker must use the `nodejs_compat` flag with a compatibility date of at least `2024-09-23`. This repository's playground has an example in `playground/.dev.vars.example`.

Open `/admin` and enter the setup token to create the first admin. Remove `GALAXY_AUTH_SETUP_TOKEN` from production after setup. An admin can create editor/admin accounts in **Users**; accounts cannot sign up publicly. Users can change their own password in **Account**. CMS login sessions expire after 12 hours. Keep `GALAXY_AUTH_SECRET` stable across deployments; replacing it invalidates sessions.

For direct admin API clients, versioned entry updates, publish/archive actions, and revision restores require `expectedRevisionId` in the JSON body. Read the current `latestRevisionId` from the entry GET response before changing it. A stale revision returns HTTP 409 and a missing revision ID returns HTTP 428. The admin editor supplies this automatically.

### Optional Cloudflare Access gate

Each installing project can protect its CMS admin path and all child paths with its own Cloudflare Access application. Set `GALAXY_ACCESS_TEAM_DOMAIN` to that project's `https://<team>.cloudflareaccess.com` URL and `GALAXY_ACCESS_AUDIENCE` to its application AUD tag. If either is set, the CMS requires both, verifies the Access JWT in the Worker, and requires its email to match the local account email. When using a custom `adminPath`, pass the same path to `LocalAuthAdapter(adminPath)`. Public media, cart, checkout, and Stripe webhook routes live under `/api` and must remain outside the Access application. Stripe webhooks authenticate with their signature; checkout remains disabled by default.

For Cloudflare Access login without a separate CMS password, use `AccessAuthAdapter` from `talisman-cms/auth/access` as the integration's `auth` option. Set both Access values above and `GALAXY_ACCESS_ADMIN_EMAILS` to a comma-separated list of allowed admin emails; optional `GALAXY_ACCESS_EDITOR_EMAILS` grants editor access. The Worker grants no access when either Access value or an email allowlist is missing. Protect both the admin base path and its child paths with a self-hosted Access application. This adapter does not use the local account tables, password setup or `GALAXY_AUTH_SECRET`.

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
