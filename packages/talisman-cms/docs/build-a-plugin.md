# Build a plugin

A Talisman CMS plugin is a function that returns a `Plugin` object. A site registers it in `astro.config`:

```js
import talismanCms from 'talisman-cms';
import { reviewsPlugin } from 'my-reviews-plugin';

export default defineConfig({
  integrations: [talismanCms({ plugins: [reviewsPlugin({ moderation: true })] })]
});
```

The plugin object is read once, at config time, in Node. Everything that must run in the Worker or in the admin's browser bundle is named by a module specifier the site's build can resolve, never by an inline function: the object does not survive the server build. The `@talisman-cms/plugin-ecommerce` package is the reference implementation; the smaller `@talisman-cms/plugin-analytics` shows the same shapes with less code. The core README's [plugin admin extension points](../README.md#plugin-admin-extension-points) section is the reference list of the admin fields; this guide is the walk-through.

## The plugin object

```ts
import type { Plugin, PluginConfig } from 'talisman-cms';

export function reviewsPlugin(options: { moderation?: boolean } = {}): Plugin {
  return {
    name: 'my-reviews-plugin',
    onInit(config: PluginConfig) { /* add collections, globals and hooks */ },
    endpoints: [{ path: '/reviews/approve', entrypoint: routeEntrypoint('approve') }],
    adminUi: [{ path: 'reviews', label: 'Reviews', componentPath: 'my-reviews-plugin/admin/Reviews' }],
    migrations: { dir: migrationsDir() },
    scheduled: { moduleId: 'my-reviews-plugin/scheduled' },
  };
}
```

`name` is the package name. It appears in build errors, in the admin ("Provided by my-reviews-plugin") and in the scheduled job log, and the migrations assembler records it as the source of each file.

### `onInit`

`onInit(config)` runs once, in registration order, when `talismanCms()` is called. It receives a `PluginConfig`: the site's options with `collections`, `globals` and `plugins` always present as arrays and `adminPath` normalized (`/admin` by default, `/` for a root admin, otherwise a leading slash and no trailing one). The plugin may mutate that object and return nothing, or return a new object; the next plugin sees the result, and the integration uses what the last plugin left. The options object the site passed in is never changed.

Use it to:

- add collections and globals, for example a collection mapped to a Drizzle table the plugin ships (`nativeSchemaMapping`), with its fields read from the table's columns (`nativeFields(table, picks)` from `talisman-cms/fields`), placed in a section with `adminSection`;
- attach `runtimeHooks` to a collection the site defined, as the Stripe plugin does for the collections it syncs;
- read what the plugins before yours registered (`config.plugins.some((plugin) => plugin.name === '@talisman-cms/plugin-ecommerce')`) and adapt.

Do not read settings or secrets in `onInit`: it runs on the developer's machine and in CI, not in the Worker. Settings are read at request time with `readSetting` from `talisman-cms/env`.

### Collections, globals and fields

A collection the plugin adds is an ordinary `CollectionConfig`. Fields come from the same `FieldDefinition` set the site uses; `saveOnlyIfChanged` marks a native column that server code moves in place, so the editor sends it only when the user changed it. `access` and `readOnly` apply to admin users; server code calling `getClient(env)` acts as `system` and bypasses them. Blocks, components and UI libraries (`blocks`, `components`, `uiLibraries`) are described in [the UI library manifest workflow](ui-library-manifest-workflow.md).

## Server code

### Collection hooks

Hooks live in a server module and are registered by reference: `{ moduleId, exportName, factory, args }` in a collection's `runtimeHooks`. With `factory: true` the export is called with `args` and returns the hooks object. Hooks receive `{ data, operation, originalDoc, actor, req, collection }` and run for admin API writes and `getClient` writes alike; the core README's [server SDK section](../README.md#server-sdk-actors-and-hooks) lists the phases and the error classes a hook may throw.

### Endpoints

`endpoints` are Astro API routes the integration injects. `path` is relative to `/api`: an endpoint is served at `<adminPath>/api/<path>` and requires a CMS session, or at `/api/<path>` for anyone when `public` is true. The entrypoint is an absolute file path; a plugin resolves it next to its built output, falling back to the source for a linked checkout:

```ts
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function routeEntrypoint(name: string) {
  let path = fileURLToPath(new URL(`./routes/${name}.js`, import.meta.url));
  if (!existsSync(path)) path = fileURLToPath(new URL(`./routes/${name}.ts`, import.meta.url));
  return path;
}
```

A private endpoint checks the session itself, so it stays private even when reached through another route: `authorizeCmsRequest(request)` from `talisman-cms/auth/guard` answers with `{ response }` to return when the request is refused, and `{ user }` otherwise; pass `'admin'` as the second argument for admin-only work. Bindings and settings come from `cloudflare:workers` (`const { env } = await import('cloudflare:workers')`) and `readSetting(env, 'REVIEWS_LOCALE')`, which reads `TALISMAN_REVIEWS_LOCALE`. To read or write CMS records with the caller's rules, use `getClient(env, ctx, { actor: userActor(user, request) })` from `talisman-cms/client`.

### Pages

`routes` are Astro pages. A `path` without a leading slash is relative to the admin path and needs a CMS session, so a page such as `daisyui-preview` is served at `/admin/daisyui-preview` and cannot be prerendered; `public: true` opens it. A path with a leading slash is used as given, and a page outside the admin path is public. A value that is not a path on the site, such as a URL with a scheme or host, fails the build.

### Scheduled jobs

A plugin that needs a cron job registers a module: `scheduled: { moduleId: 'my-reviews-plugin/scheduled' }` (`exportName` defaults to `scheduled`). The export is a function of one event:

```ts
import type { ScheduledJob } from 'talisman-cms/worker';

export const scheduled: ScheduledJob = async ({ cron, scheduledTime, env, waitUntil }) => {
  // env holds the Worker bindings; waitUntil keeps the invocation alive for work after the return.
};
```

Every registered job runs on every cron tick, in registration order. A job that throws is logged as `[talisman-cms] <plugin> scheduled job failed: <message>` and never skips the next one; after the run, one error naming the failed plugins is thrown, so Cloudflare records the invocation as failed. A job that must run on some ticks only checks `cron`.

The Cloudflare adapter's default Worker entry has no scheduled handler, so a site names its own entry in `wrangler.toml` and adds a trigger:

```toml
main = "./src/worker.ts"

[triggers]
crons = ["*/10 * * * *"]
```

```ts
// src/worker.ts
import { handle } from '@astrojs/cloudflare/handler';
import { scheduled } from 'talisman-cms/worker';

export default { fetch: handle, scheduled };
```

The integration warns at build time when a plugin declares a job and no wrangler config has a cron trigger. A site with jobs of its own runs them through `runScheduledJobs`, also exported from `talisman-cms/worker`, or calls the plugin jobs from its own handler.

### Migrations

A plugin that owns tables ships their migrations: `migrations: { dir }` names an absolute folder holding them as drizzle-kit writes them, one `<timestamp>_<name>/` folder per migration with a `migration.sql` inside (plain `<number>_<name>.sql` files are accepted too). The integration copies the core's migrations and every plugin's into one folder in the site on each config setup, as flat `.sql` files, and `wrangler d1 migrations apply` reads that folder in the order of the number before the first `_`. drizzle-kit's timestamps keep packages apart, two packages cannot ship the same name or number, and a file name never changes once a database has applied it. A plugin table may reference a core table, such as `galaxy_auth_user`, by importing it from `talisman-cms/auth/local-schema`; drizzle-kit writes the foreign key without creating the table. `talisman-cms/migrations` exports `listMigrationSources` and `assembleMigrations` for tests that apply the assembled sequence. The core README's [database migrations](../README.md#database-migrations) section describes the site side.

## Admin screens

The admin is a React single-page app. A plugin adds to it through fields of the plugin object; every `componentPath` and `modulePath` is a module specifier the site's build resolves, and page components load when first shown.

- `adminUi`: pages at `<adminPath>/extensions/<path>`, listed in the sidebar, or under a section's workspace when `section` names one.
- `adminSections`, `adminEditorPanels`, `adminEntryDescribers`, `adminSettings` and `adminStyleSources`: a section next to Collections with its own workspace, panels in the entry editor, record labels for pickers and summaries, display settings exposed to the admin page, and folders Tailwind scans. The core README's [extension points](../README.md#plugin-admin-extension-points) section has each contract.
- `adminLinks`: task links shown in a section's workspace. An `href` without a leading slash is relative to the admin path (`extensions/reviews`); one with a leading slash is used as given; anything else fails the build.

### The admin SDK

Plugin screens never guess the admin path from the URL. `talisman-cms/ui/sdk` gives them:

| Export | What it is |
| --- | --- |
| `adminPath` | The configured admin path, `/admin` by default or `/` for a root admin. |
| `adminUrl(path?)` | A page under the admin path: `adminUrl('extensions/reviews')`; `adminUrl()` is the admin itself. |
| `adminApiUrl(path)` | An endpoint under the admin path: `adminApiUrl('reviews/approve')`. |
| `adminRequest(path, init?)` | `fetch` of an admin endpoint with the session cookie, a JSON body when `body` is given, the JSON result, and an `Error` carrying the server's `error` text when the response is not ok. |
| `readAdminSetting(name)` | A setting the plugin exposed with `adminSettings`, by its name without `TALISMAN_`. |
| `useAdminUser()` | The signed-in user (`role`, `email`) from the router context. |

```tsx
import { adminRequest, useAdminUser } from 'talisman-cms/ui/sdk';

export default function Reviews() {
  const user = useAdminUser();
  const approve = (id: string) => adminRequest(`reviews/approve`, { body: { id } });
  ...
}
```

Admin code may import the admin's own building blocks through `talisman-cms/ui/*`, such as `talisman-cms/ui/components/ui/button`, and TanStack Router's `Link` with the admin's typed routes (`to="/extensions/$extensionPath"`).

### Passing options to admin code

Admin components are compiled into the site's browser bundle, so they cannot read the plugin object. A plugin passes what its screens need through a Vite virtual module it registers in `vite.plugins`:

```ts
const OPTIONS_MODULE = 'virtual:my-reviews-plugin/admin';
// in the plugin object
vite: {
  plugins: [{
    name: 'my-reviews-plugin-admin-options',
    resolveId(id) { if (id === OPTIONS_MODULE) return `\0${OPTIONS_MODULE}`; },
    load(id) { if (id === `\0${OPTIONS_MODULE}`) return `export const moderation = ${options.moderation === true};`; },
  }]
}
```

Declare the module in the package's `env.d.ts` so the admin code type-checks, and keep secrets out of it: the admin bundle is a public static asset.

## Packaging

- Server code (the plugin factory, hooks, endpoints, scheduled jobs) is built to `dist/` with `.d.ts` files and listed in `exports`; the build marks `cloudflare:workers`, `astro` and the `virtual:talisman-cms/*` modules external, because the site's build provides them.
- Admin code ships as source: `"./admin/*": "./src/admin/*"` in `exports` and `src/admin` in `files`. The site's Vite compiles it with the admin, so it may import `talisman-cms/ui/*` and the virtual modules; declare those in `env.d.ts`.
- Migrations ship as files: `drizzle` in `files`.
- `talisman-cms`, `react` and `react-dom` are peer dependencies. Plugin admin code must use the site's React instance, which the integration's Vite config already dedupes.

## Testing

Plugin tests are `node:test` files run with `node --experimental-sqlite --test test/*.test.mjs` after a build, and they import from `dist/`. `node:sqlite` stands in for D1: the ecommerce plugin's tests open an in-memory database, apply the plugin's migrations with `test/helpers/migrations.mjs`, and wrap it in a small object with D1's `prepare`, `bind`, `all`, `first`, `run` and `batch` (see `test/reconcile.test.mjs`). Config-time behaviour is tested by calling `talismanCms({ plugins: [plugin] }).hooks['astro:config:setup']` with stand-ins for Astro's helpers, as `packages/talisman-cms/test/integration-plugin-contract.test.mjs` does, and reading the virtual modules the integration registered. Browser behaviour is checked against a built playground with the admin harness (`pnpm e2e:admin`).

## Checklist

- `name` is the package name, and every module reference is a specifier or an absolute file path the site can resolve.
- `onInit` only shapes configuration; nothing in it reads the environment.
- Private endpoints call `authorizeCmsRequest`; public ones are marked `public`.
- Admin screens use `talisman-cms/ui/sdk` for every URL and request, and admin links are admin-relative.
- Migrations take the next number across every registered package, and applied file names never change.
- A scheduled job tolerates being run every tick, and the README tells the site to wire `talisman-cms/worker` and a cron trigger.
- The package README documents the plugin's settings, bindings and migrations.
