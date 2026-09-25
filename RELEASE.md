# Release checklist

Talisman CMS is at release candidate validation. Publish only after the gates below are complete for the target site. Public commerce checkout remains disabled until the separate [commerce launch gates](packages/plugin-ecommerce/PRODUCTION_READINESS.md) pass.

## Package gate

1. Verify every published package declares `Apache-2.0` and includes the repository's `LICENSE.md`. `pnpm release:check:archives` checks both the metadata and exact license text.
2. On a clean checkout of the release commit, run `CI=true pnpm install --frozen-lockfile` and `pnpm release:verify`. This runs the build, tests, TypeScript and Astro checks, playground build, archive checks, and UI coverage checks. The GitHub workflow uses the same command when Actions is available. Record the command result if Actions cannot run.
3. Install the packed packages in a project outside this workspace and import their public entry points. Test an Astro build from the packed packages for the release candidate.
4. Review the version numbers and [release notes](CHANGELOG.md) for `talisman-cms` and every plugin to be published. Publish the matching set together: plugins depend on the exact packed core version. Sign in to npm with an account that can publish `talisman-cms` and the `@talisman-cms` scope; scoped packages declare public access.

## Deployment gate

The playground Wrangler files contain local placeholder D1 and KV IDs. Configure the real target resources and validate the deployment bundle before applying migrations or deploying; these files are not production manifests.

1. Back up the target D1 database and rehearse restoration. Before migration `0018`, run:

   ```sql
   SELECT entry_id, revision_number, COUNT(*) AS copies
   FROM galaxy_entry_revisions
   GROUP BY entry_id, revision_number
   HAVING COUNT(*) > 1;
   ```

   Resolve any duplicates before applying migrations through `0018_entry_revision_integrity.sql` to the remote D1 database. Apply migrations before deploying the matching Worker.
2. Check the target Worker bindings, compatibility date, `GALAXY_AUTH_SECRET`, and the one-time `GALAXY_AUTH_SETUP_TOKEN` against the [setup guide](packages/talisman-cms/README.md). Keep the auth secret stable across deploys. Remove the setup token after first-admin creation. If using Workflow publishing, deploy the separate worker in `playground/wrangler.workflows.toml` with real D1 and KV bindings first; bind the site Worker to its `TalismanPublishWorkflow` class using `script_name = "talisman-cms-publishing-workflow"` and the `GALAXY_PUBLISH_WORKFLOW` binding. Both Workers must point to the same D1 and KV resources.
3. On the deployed site, verify admin login, editor access boundaries, draft save and publish, a second editor's stale save returning HTTP 409, media upload and display, and a legacy SVG download. Check Worker logs and D1 errors during these steps.
4. Verify public pages and the indexing flag on the intended domain. Keep `GALAXY_COMMERCE_CHECKOUT_ENABLED=false` until the commerce launch gates pass.

## API change

Versioned entry `PUT`, publish/archive `POST`, and revision restore `POST` require `expectedRevisionId` in the JSON request body. Read `latestRevisionId` from `GET /admin/api/collections/:slug/entries/:id` first. A stale ID returns HTTP 409; a missing ID returns HTTP 428. Native collection writes do not use this field.
