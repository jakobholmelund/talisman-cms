# Release checklist

Talisman CMS is at release candidate validation. Publish only after the gates below are complete for the target site. Public commerce checkout remains disabled until the separate [commerce launch gates](packages/plugin-ecommerce/PRODUCTION_READINESS.md) pass.

## Package gate

1. Verify every published package declares `Apache-2.0` and includes the repository's `LICENSE.md` and a copy of the root `NOTICE`. `pnpm release:check:archives` checks the metadata, the exact license text, and that each packed `NOTICE` matches the root file. After editing the root `NOTICE`, copy it into every package.
2. On a clean checkout of the release commit, run `CI=true pnpm install --frozen-lockfile` and `pnpm release:verify`. This runs the build, tests, TypeScript and Astro checks, playground build, archive checks, and UI coverage checks. The tests include `packages/talisman-cms/test/migrations.test.mjs`, which applies every migration in `packages/talisman-cms/drizzle` to an empty database and to one holding data from earlier releases. Each package's `dist/` is committed, so then run `node scripts/check-dist-drift.mjs`: it fails when the committed build output differs from the fresh build (a `.d.ts` file whose declarations only changed order does not count). If it fails, commit the rebuilt `packages/*/dist` and verify again. Also run `pnpm audit --prod --audit-level high`, which must report no high or critical advisories in production dependencies. The GitHub workflow runs all three when Actions is available. Record the command results if Actions cannot run.
3. Install the packages packed with `pnpm pack` in a project outside this workspace and import their public entry points. Test an Astro build from the packed packages for the release candidate. The smoke step of `pnpm release:verify` does this with npm and pnpm, and also checks that plugin-stripe's webhook route verifies signatures; repeat it by hand if that step was skipped with `TALISMAN_SMOKE=0`.
4. Review the version numbers and [release notes](CHANGELOG.md) for `talisman-cms` and every plugin to be published. Publish the matching set together: each plugin's `talisman-cms` peer range is taken from the core version in the workspace when it is packed. Sign in to npm with an account that can publish `talisman-cms` and the `@talisman-cms` scope; scoped packages declare public access.
5. Publish with pnpm from the repository root, first with `--dry-run`:

   ```sh
   pnpm -r --filter './packages/*' publish
   ```

   Do not use `npm publish`; each package's `prepublishOnly` script stops it. pnpm rewrites each plugin's `workspace:` ranges to the core version in the workspace and adds the repository's `LICENSE.md` to every package; npm does neither, which leaves the plugins uninstallable and every package without the license text. Every package runs its build in `prepack`, so `pnpm publish` and `pnpm pack` always build from the checked-out source before packing, and never ship a stale or missing `dist/`. A failed build stops the publish. The recursive command publishes `talisman-cms` before the plugins that depend on it and skips versions already on npm; the filter leaves out the playground. If you publish packages one at a time, run `pnpm publish` in `packages/talisman-cms` first, then in each plugin directory. pnpm's git checks expect a clean checkout of `main` that is not behind its remote. Push the release commit to `main` before publishing: the published core README links to `packages/talisman-cms/docs/admin-coverage.md` on GitHub's `main` branch, since the `docs` folder is not in the package.

## Deployment gate

The playground Wrangler files contain local placeholder D1 and KV IDs. Configure the real target resources and validate the deployment bundle before applying migrations or deploying; these files are not production manifests.

1. Back up the target D1 database and rehearse restoration. Before migration `0018`, run:

   ```sql
   SELECT entry_id, revision_number, COUNT(*) AS copies
   FROM galaxy_entry_revisions
   GROUP BY entry_id, revision_number
   HAVING COUNT(*) > 1;
   ```

   Before migration `0019`, which allows one CMS user per email regardless of letter case, run:

   ```sql
   SELECT lower(email) AS email, COUNT(*) AS copies
   FROM galaxy_auth_user
   GROUP BY lower(email)
   HAVING COUNT(*) > 1;
   ```

   Both queries must return no rows. Resolve any duplicates before applying migrations through `0021_entry_draft_slug.sql` to the remote D1 database. Apply migrations before deploying the matching Worker; without `0019`, local and hybrid CMS sign-ins fail on the new session column and shopper account reads fail on `cms_user_id`, and without `0021` every entry read and save fails on the new `draft_slug` column. Migration `0020` needs no pre-check: it adds a baseline revision to entries that have none (for example seeded rows) and unwraps double-encoded globals, and a rerun changes nothing. Migration `0021` only adds the nullable `draft_slug` column and needs no pre-check either.

   Slugs are now unique within a collection when an entry is created, renamed or published. Entries that already share a slug keep working, but publishing a draft onto a slug another published entry serves returns HTTP 409. To find shared slugs before editors run into them, run:

   ```sql
   SELECT collection_id, slug, COUNT(*) AS copies
   FROM galaxy_entries
   GROUP BY collection_id, slug
   HAVING COUNT(*) > 1;
   ```
2. Check the target Worker bindings (`DB`, `STORAGE`, and any of `KV`, `IMAGES` and `EMAIL` the site uses; the CMS no longer reads a `QUEUE` binding), compatibility date, `TALISMAN_AUTH_SECRET`, and the one-time `TALISMAN_AUTH_SETUP_TOKEN` against the [setup guide](packages/talisman-cms/README.md). Hybrid and Access-only sites use their Access settings instead of the setup token. `DevAuthAdapter` cannot be deployed: `astro build` fails with it. Keep the auth secret stable across deploys. Remove the setup token after first-admin creation. If using Workflow publishing, deploy the separate worker in `playground/wrangler.workflows.toml` with real D1 and KV bindings first; bind the site Worker to its `TalismanPublishWorkflow` class using `script_name = "talisman-cms-publishing-workflow"` and the `TALISMAN_PUBLISH_WORKFLOW` binding. Both Workers must point to the same D1 and KV resources.

   Settings, secrets and the default Workflow binding use `TALISMAN_*` names. Pre-release deployments used `GALAXY_*`; a `GALAXY_*` name is still read when its `TALISMAN_*` name is missing or blank, and the Worker logs a one-time deprecation warning. Rename each one and keep its value: add the `TALISMAN_*` secret or variable, deploy, then delete the `GALAXY_*` one, and check that the Worker log shows no deprecation warning. Database tables keep their internal `galaxy_` prefix.

   Sites that send shopper sign-in email need an email provider, normally a `[[send_email]]` binding named `EMAIL` with `TALISMAN_EMAIL_PROVIDER = "cloudflare"`, plus `TALISMAN_EMAIL_FROM` and a `TALISMAN_PUBLIC_ORIGIN` that matches the site's origin. `RESEND_API_KEY` is no longer read. Sites using `@talisman-cms/plugin-stripe` set `STRIPE_SECRET_KEY` and, for its webhook endpoint, `TALISMAN_STRIPE_WEBHOOK_SECRET` as Worker secrets; the plugin no longer reads them from `astro.config`.
3. On the deployed site, verify admin login, editor access boundaries, draft save and publish, a second editor's stale save returning HTTP 409, a published entry keeping its live URL after a draft slug change until it is published again, a signed-out request to a plugin endpoint under `<adminPath>/api/` returning HTTP 401, media upload and display, and a legacy SVG download. If the site sends shopper sign-in email, request a link and confirm it arrives. Check Worker logs and D1 errors during these steps.
4. Verify public pages and the indexing flag on the intended domain. Keep `TALISMAN_COMMERCE_CHECKOUT_ENABLED=false` until the commerce launch gates pass.

## API changes

Versioned entry `PUT`, publish/archive `POST`, and revision restore `POST` require `expectedRevisionId` in the JSON request body. Read `latestRevisionId` from `GET /admin/api/collections/:slug/entries/:id` first. A stale ID returns HTTP 409; a missing ID returns HTTP 428. An entry that has no revisions yet, such as a seeded row, may send `null` or leave the field out; its first write records a baseline revision.

Native collection writes do not use this field. Their `PUT` accepts an optional `expectedUpdatedAt`, the `updatedAt` the client loaded, and returns HTTP 409 if the record changed since. It validates and writes only the columns it sends.

Validation errors return HTTP 400 with `{ error, fieldErrors, issues }`, where `fieldErrors` maps field names to messages. Globals return `data` as a JSON object, and `POST /admin/api/globals/:slug` rejects data that is not one.

Entry responses return `slug` as the slug being edited and `publishedSlug` as the live slug, or `null` for an entry that is not published. A published entry's slug change is kept as its draft slug until the next publish. Creating an entry with, or renaming one to, a slug that another entry in the collection uses or has pending returns HTTP 409, as does publishing onto a slug another published entry serves. Client-chosen entry ids and slugs that break the format rules return HTTP 400.

`GET /admin/api/collections/:slug/entries?limit=N` (1–200) returns `{ docs, nextCursor }`; pass `nextCursor` as `cursor` for the next page. Without `limit` the response is the full array, as before. `GET .../revisions` returns revision metadata only, unless `?includeData=true`; `GET .../revisions/:revisionId` returns one revision with its data.

Other client errors return 4xx: invalid JSON or a body that is not an object 400, an unknown collection, entry or revision 404, a constraint failure 409 or 400, and a body over 2 MiB 413. Unexpected failures return a generic HTTP 500 without details; the Worker log has the error. A native collection write that sets a column outside the configured `fields` returns 400. Creating a media record through the entries API returns 403, and changing a media record's `url` or `mimeType` 400. `POST /admin/api/globals/:slug` for a slug that is neither configured nor stored creates a global, so it requires an administrator.
