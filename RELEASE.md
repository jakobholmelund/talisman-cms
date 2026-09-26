# Release checklist

Talisman CMS is at release candidate validation. Publish only after the gates below are complete for the target site. Public commerce checkout remains disabled until the separate [commerce launch gates](packages/plugin-ecommerce/PRODUCTION_READINESS.md) pass.

## Package gate

1. Verify every published package declares `Apache-2.0` and includes the repository's `LICENSE.md` and a copy of the root `NOTICE`. `pnpm release:check:archives` checks the metadata, the exact license text, and that each packed `NOTICE` matches the root file. After editing the root `NOTICE`, copy it into every package.
2. On a clean checkout of the release commit, run `CI=true pnpm install --frozen-lockfile` and `pnpm release:verify`. This runs the build, tests, TypeScript and Astro checks, playground build, archive checks, and UI coverage checks. The tests include `packages/talisman-cms/test/migrations.test.mjs`, which applies every migration in `packages/talisman-cms/drizzle` to an empty database and to one holding data from earlier releases. Each package's `dist/` is committed, so then run `node scripts/check-dist-drift.mjs`: it fails when the committed build output differs from the fresh build. TypeScript prints inferred types with their members in varying order, so a rebuilt `.d.ts` file that differs only in the order of the members of one union, or of the members directly inside one `{ … }` block, does not count. The check lists those files and puts back their committed copy, so the working tree is clean again for publishing. Any other change, such as a union member or property that moves to another declaration, fails the check. If it fails, commit the rebuilt `packages/*/dist` and verify again. Also run `pnpm audit --prod --audit-level high`, which must report no high or critical advisories in production dependencies. The GitHub workflow runs all three when Actions is available. Record the command results if Actions cannot run.
3. Install the packages packed with `pnpm pack` in a project outside this workspace and import their public entry points. Test an Astro build from the packed packages for the release candidate. The smoke step of `pnpm release:verify` does this with npm and pnpm, and also checks that plugin-stripe's webhook route verifies signatures; repeat it by hand if that step was skipped with `TALISMAN_SMOKE=0`.
4. Review the version numbers and [release notes](CHANGELOG.md) for `talisman-cms` and every plugin to be published, including the list of breaking changes. Publish the matching set together: each plugin's `talisman-cms` peer range is taken from the core version in the workspace when it is packed. Sign in to npm with an account that can publish `talisman-cms` and the `@talisman-cms` scope; scoped packages declare public access.
5. Publish from the repository root with `pnpm release:publish`, first as a dry run:

   ```sh
   pnpm release:publish --dry-run
   pnpm release:publish
   ```

   The script runs `pnpm -r --filter './packages/*' publish` and passes its arguments on, for example `--otp=<code>`. Every package runs its build in `prepack`, so `pnpm publish` and `pnpm pack` always build from the checked-out source before packing, and never ship a stale or missing `dist/`. A failed build stops the publish. Those builds can print some `.d.ts` files with their members in another order, and pnpm refuses to publish from a working tree with changes. The script therefore lists and puts back those files before and after publishing, as `scripts/check-dist-drift.mjs` does. It also fails when the build it packed differs from the committed `dist/`: commit and push the rebuilt output, then run the dry run again. Do not work around a refused publish with `--no-git-checks`.

   Do not use `npm publish`; each package's `prepublishOnly` script stops it. pnpm rewrites each plugin's `workspace:` ranges to the core version in the workspace and adds the repository's `LICENSE.md` to every package; npm does neither, which leaves the plugins uninstallable and every package without the license text. The recursive command publishes `talisman-cms` before the plugins that depend on it and skips versions already on npm; the filter leaves out the playground. If you publish packages one at a time, run `pnpm publish` in `packages/talisman-cms` first, then in each plugin directory, and run `node scripts/check-dist-drift.mjs` from the repository root before each `pnpm publish`. pnpm's git checks expect a clean checkout of `main` that is not behind its remote. Push the release commit to `main` before publishing: the published core README links to `packages/talisman-cms/docs/admin-coverage.md` on GitHub's `main` branch, since the `docs` folder is not in the package.

## Deployment gate

The playground Wrangler files contain local placeholder D1 and KV IDs. Configure the real target resources and validate the deployment bundle before applying migrations or deploying; these files are not production manifests.

1. Back up the target D1 database, rehearse restoration, and apply the new migrations before deploying the matching Worker. This release adds `0019_shared_customer_identity.sql` through `0024_shopper_sign_in_tokens.sql`. Run the commands from the site's project, where `DB` is the binding whose `migrations_dir` points at the CMS migrations:

   1. Record a restore point: `pnpm exec wrangler d1 time-travel info <database>` prints the current bookmark. Keep it until the deployed site passes step 4. Restoring it with `pnpm exec wrangler d1 time-travel restore <database> --bookmark=<bookmark>` also discards every write made after it.
   2. List the pending migrations with `pnpm exec wrangler d1 migrations list DB --remote`.
   3. Run the read-only checks below for the pending migrations with `pnpm exec wrangler d1 execute DB --remote --command "<query>"`. Each must return no rows; resolve what they find first.
   4. Apply the migrations with `pnpm exec wrangler d1 migrations apply DB --remote`. Wrangler applies them in order and rolls back a migration that fails, keeping the ones before it; fix the cause and run the command again.
   5. Check that `migrations list` reports nothing pending.

   Before migration `0018`, if it is still pending:

   ```sql
   SELECT entry_id, revision_number, COUNT(*) AS copies
   FROM galaxy_entry_revisions
   GROUP BY entry_id, revision_number
   HAVING COUNT(*) > 1;
   ```

   Before migration `0019`, which allows one CMS user per email regardless of letter case:

   ```sql
   SELECT lower(email) AS email, COUNT(*) AS copies
   FROM galaxy_auth_user
   GROUP BY lower(email)
   HAVING COUNT(*) > 1;
   ```

   Before migration `0023`, which allows one published entry per slug in a collection:

   ```sql
   SELECT collection_id, slug, COUNT(*) AS copies
   FROM galaxy_entries
   WHERE status = 'published'
   GROUP BY collection_id, slug
   HAVING COUNT(*) > 1;
   ```

   What each new migration does:

   - `0019` lowercases every stored CMS user email and adds a unique index on it, so it fails while its check returns rows: change the email of, or remove, all but one account for each address. It adds `galaxy_auth_session.auth_method` and `_ecommerce_customer_accounts.cms_user_id`, and links shoppers who have already verified their email to `customer` users. Without it, local and hybrid CMS sign-ins fail on the new session column and shopper account reads fail on `cms_user_id`.
   - `0020` needs no check. It adds a baseline revision to entries that have none (for example seeded rows), pins the published revision of published entries, and unwraps globals stored as JSON text inside a JSON string. It only changes rows that still need it, so a rerun changes nothing.
   - `0021` needs no check. It only adds the nullable `galaxy_entries.draft_slug` column. Without it, every entry read and save fails.
   - `0022` needs no check. It keeps global data that is not a JSON object, such as a list, under a `value` key (`[1,2]` becomes `{"value":[1,2]}`), where reads would otherwise return `{}`. Site code that reads such a global then reads `data.value`. To see the rows it looks at, run `SELECT slug, data FROM galaxy_globals WHERE CASE WHEN json_valid(data) THEN json_type(data) <> 'object' ELSE 1 END;`. A listed row that holds a JSON object as encoded text is left as it is.
   - `0023` adds a unique index on the slug of published entries in each collection, so it fails while its check returns rows. For each slug it lists, rename all but one of the entries in the CMS and publish them again, or unpublish them.
   - `0024` needs no check. It adds the ecommerce plugin's `_ecommerce_sign_in_tokens` and `_ecommerce_rate_limits` tables and an index on order emails. It copies shopper sign-in links that have not expired into the new link table, so they keep working after the upgrade, and moves the shopper sign-in request counters out of `galaxy_auth_rate_limit` into `_ecommerce_rate_limits`. It also drops and recreates the `_ecommerce_discount_reserve_guard` trigger, so that first-order codes check the shopper's past orders instead of whether an account row exists. Without it, shopper sign-in fails (requesting, previewing and using a link), `purgeStaleCommerceData` throws, and the old trigger keeps refusing first-order codes to any shopper who has an account. Once the new Worker runs, the scheduled `purgeStaleCommerceData` also deletes the never-verified shopper accounts that earlier versions created for each link request; the [release notes](CHANGELOG.md#ecommerce-plugin) list which ones.

   The migrations folder also creates the ecommerce plugin's tables, so apply every migration even if the site does not use that plugin.

   Slugs are now unique within a collection when an entry is created, renamed or published, and slugs chosen by API clients must follow the format rules. Entries that already share a slug keep working, but publishing a draft onto a slug another published entry serves returns HTTP 409. An entry whose slug breaks the rules can still be saved while its slug is unchanged. These optional read-only queries find both cases before editors run into them:

   ```sql
   SELECT collection_id, slug, COUNT(*) AS copies
   FROM galaxy_entries
   GROUP BY collection_id, slug
   HAVING COUNT(*) > 1;

   SELECT c.slug AS collection, e.id, e.slug
   FROM galaxy_entries e JOIN galaxy_collections c ON c.id = e.collection_id
   WHERE e.slug = '' OR length(e.slug) > 200
     OR e.slug GLOB '*[^A-Za-z0-9/_.~:-]*'
     OR e.slug GLOB '/*' OR e.slug GLOB '*/' OR e.slug GLOB '*//*'
     OR ('/' || e.slug || '/') GLOB '*/./*' OR ('/' || e.slug || '/') GLOB '*/../*';
   ```

   The second query also lists slugs with letters outside ASCII, such as `ü`, which the rules allow; check those rows by eye.
2. Check the target Worker bindings (`DB`, `STORAGE`, and any of `KV`, `IMAGES` and `EMAIL` the site uses; the CMS no longer reads a `QUEUE` binding), compatibility date, `TALISMAN_AUTH_SECRET`, and the one-time `TALISMAN_AUTH_SETUP_TOKEN` against the [setup guide](packages/talisman-cms/README.md). Hybrid and Access-only sites use their Access settings instead of the setup token. `DevAuthAdapter` cannot be deployed: `astro build` fails with it. Keep the auth secret stable across deploys. Remove the setup token after first-admin creation. If using Workflow publishing, configure the separate worker in `playground/wrangler.workflows.toml` with real D1 and KV bindings, and bind the site Worker to its `TalismanPublishWorkflow` class using `script_name = "talisman-cms-publishing-workflow"` and the `TALISMAN_PUBLISH_WORKFLOW` binding. Both Workers must point to the same D1 and KV resources.

   Settings, secrets and the default Workflow binding use `TALISMAN_*` names. Pre-release deployments used `GALAXY_*`; a `GALAXY_*` name is still read when its `TALISMAN_*` name is missing or blank, and the Worker logs a one-time deprecation warning. Before deploying, add each `TALISMAN_*` secret or variable with the value of its `GALAXY_*` name. After the deploy, check that the Worker log shows no deprecation warning, and delete the `GALAXY_*` names once you no longer need to roll back to a pre-release Worker, which reads only those names. A number or `true`/`false` in `wrangler.toml` `[vars]` is read as text, so `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT = 500` and `= "500"` both work; a list or table is ignored, with a warning in the Worker log. Database tables keep their internal `galaxy_` prefix.

   Sites that send shopper sign-in email need an email provider, normally a `[[send_email]]` binding named `EMAIL` with `TALISMAN_EMAIL_PROVIDER = "cloudflare"`, plus `TALISMAN_EMAIL_FROM` and a `TALISMAN_PUBLIC_ORIGIN` that matches the site's origin. `RESEND_API_KEY` is no longer read. The Cloudflare Turnstile check for shopper sign-in is optional: set `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY` as a variable and `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY` as a secret together, or neither, because the secret alone makes email sign-in answer HTTP 503. Sites using `@talisman-cms/plugin-stripe` set `STRIPE_SECRET_KEY` and, for its webhook endpoint, `TALISMAN_STRIPE_WEBHOOK_SECRET` as Worker secrets; the plugin no longer reads them from `astro.config`.

   Sites using `@talisman-cms/plugin-ecommerce` decide whether referrals run after the upgrade. They are off unless a saved policy or `TALISMAN_COMMERCE_REFERRALS_ENABLED = "true"` enables them, and a saved policy wins. Check the saved policy with the read-only query `SELECT enabled, reward_cents, min_order_cents FROM _ecommerce_referral_settings`: a row with `enabled = 1` keeps referrals on, so clear **Enable new referral awards** under **Commerce → Promotions** after the deploy if they should stay off. Sites that take Stripe payments add `charge.dispute.closed` to the events of the webhook endpoint at `/api/ecommerce/webhooks/stripe`, and keep the scheduled Worker calling `reconcileCommerce` with the Stripe adapter, which releases held referral awards. These rules need no migration beyond `0024`.
3. Deploy from the same release commit: first the publishing Workflow Worker, if the site uses one, then the site Worker. Deploy only after steps 1 and 2 are complete. The new Worker fails without the migrations, and the Stripe plugin answers HTTP 503 until its secrets are set.
4. On the deployed site, verify admin login, editor access boundaries, draft save and publish, a second editor's stale save returning HTTP 409, a published entry keeping its live URL after a draft slug change until it is published again, a signed-out request to a plugin endpoint under `<adminPath>/api/` returning HTTP 401, media upload and display, and a legacy SVG download. If the site sends shopper sign-in email, request a link, confirm it arrives, and use it to sign in; with the Turnstile keys set, the form shows the check and a request without a token gets HTTP 403. Check Worker logs and D1 errors during these steps.
5. Verify public pages and the indexing flag on the intended domain. Keep `TALISMAN_COMMERCE_CHECKOUT_ENABLED=false` until the commerce launch gates pass.

## API changes

Versioned entry `PUT`, publish/archive `POST`, and revision restore `POST` require `expectedRevisionId` in the JSON request body. Read `latestRevisionId` from `GET /admin/api/collections/:slug/entries/:id` first. A stale ID returns HTTP 409; a missing ID returns HTTP 428. An entry that has no revisions yet, such as a seeded row, may send `null` or leave the field out; its first write records a baseline revision.

Native collection writes do not use this field. Their `PUT` accepts an optional `expectedUpdatedAt`, the `updatedAt` the client loaded, and returns HTTP 409 if the record changed since. It validates and writes only the columns it sends.

HTTP 409 has more than one cause: a stale `expectedRevisionId` or `expectedUpdatedAt`, a slug conflict, or a unique or foreign-key constraint. Clients should reload the entry only for a stale edit, and otherwise show the response's `error` message.

Validation errors return HTTP 400 with `{ error, fieldErrors, issues }`, where `fieldErrors` maps field names to messages. Globals return `data` as a JSON object, and `POST /admin/api/globals/:slug` rejects data that is not one.

Entry responses return `slug` as the slug being edited and `publishedSlug` as the live slug, or `null` for an entry that is not published. A published entry's slug change is kept as its draft slug until the next publish. Creating an entry with, or renaming one to, a slug that another entry in the collection uses or has pending returns HTTP 409, as does publishing onto a slug another published entry serves. Client-chosen entry ids and slugs that break the format rules return HTTP 400.

With a publishing Workflow binding, publish and archive `POST`s wait up to 10 seconds for the Workflow. One still running then returns HTTP 202 with the entry as stored before the transition and a `message`; the Workflow finishes on its own, so reload the entry later.

`GET /admin/api/collections/:slug/entries?limit=N` (1–200) returns `{ docs, nextCursor }`; pass `nextCursor` as `cursor` for the next page. Without `limit` the response is the full array, as before. `GET .../revisions` returns revision metadata only, unless `?includeData=true`; `GET .../revisions/:revisionId` returns one revision with its data.

Other client errors return 4xx: invalid JSON or a body that is not an object 400, an unknown collection, entry or revision 404, a constraint failure 409 or 400, and a body over 2 MiB 413. Unexpected failures return a generic HTTP 500 without details; the Worker log has the error. A native collection write that sets a column outside the configured `fields` returns 400. Creating a media record through the entries API returns 403, and changing a media record's `url` or `mimeType` 400. `POST /admin/api/globals/:slug` for a slug that is neither configured nor stored creates a global, so it requires an administrator.
