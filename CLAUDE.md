# Working on Talisman CMS

Notes for Claude sessions in this repository. The README describes the product; this file describes how to work on it.

## Layout

- pnpm workspace (`pnpm@10.28.0`, Node 22.12 or later). Packages in `packages/`:
  - `talisman-cms`: the core. `src/` holds the integration, API handler, auth adapters, client and SEO and rich-text helpers. `ui/` holds the admin SPA, which ships as source. `drizzle/` holds the migrations, `seeds/` the demo seed, `test/` the node tests.
  - `plugin-ecommerce`, `plugin-stripe`, `plugin-analytics`, `plugin-ui-daisyui`, `plugin-ui-starwind`.
- `playground/`: a private Astro site with placeholder Wrangler resources, used by `pnpm release:verify`.
- `scripts/`: release verification, the packed-tarball smoke test, the archive check, the dist drift check and the publish script.
- Docs: `README.md`, `RELEASE.md` (publish and deploy gates), `CHANGELOG.md`, `SECURITY.md`, `ROADMAP.md`, `packages/plugin-ecommerce/PRODUCTION_READINESS.md`.

This repository is public and Apache-2.0. A private site may use these packages from a local checkout: it links them with `link:` and points its D1 `migrations_dir` at `packages/talisman-cms/drizzle`, so a change here can break it. Check such a site too when you change shared APIs, settings, cookie names or migrations. If a `CLAUDE.local.md` sits next to this file, it names the site, where it lives and how to check it. That file is kept out of git through `.git/info/exclude`; keep site names, paths and other private details there, not here.

Paths below use `<workspace>` for the folder that holds this repository, and `<scratchpad>` for the session's scratch folder.

## Build and test in a clone

`packages/*/dist` is committed, and every package's `test` script builds first, so running tests in the real repo rewrites tracked files. Build and test in an APFS clone instead, and delete the copied secrets and local Wrangler state straight after the copy:

```sh
W=<scratchpad>/verify && mkdir -p "$W"
cp -Rc <workspace>/talisman-cms "$W"/
find "$W/talisman-cms" -name node_modules -prune -o \
  \( -name '.secrets.*' -o -name '.dev.vars' -o -name '.env' -o -name '.env.*' -o -name '.wrangler' \) \
  ! -name '*.example' -prune -exec rm -rf {} +
cd "$W/talisman-cms"
export npm_config_cache="$W/npm-cache"  # ~/.npm can hold root-owned files, which break the smoke step's npm installs
CI=true pnpm install --frozen-lockfile --prefer-offline
CI=true pnpm release:verify        # build, tests, tsc, playground check and build, archives, packed smoke
node scripts/check-dist-drift.mjs  # run in a clone where your changes are staged (git add -A)
```

- The packed smoke step, the last step of `release:verify`, packs every package and installs the archives into throwaway projects in the system temp folder with npm and pnpm, so it downloads their dependencies from the npm registry and takes a few minutes. Without network access, or when the session may not contact the registry, run `TALISMAN_SMOKE=0 CI=true pnpm release:verify` instead and say in your report that the smoke step was skipped; RELEASE.md then asks for it to be repeated before publishing.
- Each Bash call starts a new shell, so set `W` and `npm_config_cache` again in later calls. The cache stays inside `$W`, outside the repository, so it never shows up in `git status`.
- One package: `pnpm --filter @talisman-cms/plugin-ecommerce test`. The tests use `node --experimental-sqlite` with an in-memory D1 shim.
- To check a site that links these packages against your change, clone it into the same folder as the CMS clone, so its `link:` paths resolve to the clone, and delete its secrets and local state there as above. `CLAUDE.local.md`, when present, has the recipe for the local site. Never read or copy back a site's secrets files.
- Browser checks run against the built playground in the clone, never in the real repository. Write a fresh throwaway `playground/.dev.vars` first, for example `printf 'TALISMAN_AUTH_SECRET=%s\nTALISMAN_AUTH_SETUP_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > playground/.dev.vars`, and write it before `pnpm --filter playground build`: the Cloudflare adapter copies it into `playground/dist/server/` at build time (after a build, copy it there by hand). Then `pnpm --filter talisman-cms db:migrate:local`, `pnpm --filter talisman-cms db:seed:ecommerce:local` and `pnpm --filter playground exec astro preview --host 127.0.0.1 --port 8787`, which runs `wrangler dev` on the built Worker as a detached daemon (`astro preview stop` ends it). `node e2e/admin-flows.mjs --base-url http://127.0.0.1:8787 --dist <clone>/playground/dist`, run from the real repository, drives the admin's editing flows in the installed Chrome with playwright-core and records the client chunk sizes; the first run against a fresh database needs the setup token in `TALISMAN_E2E_SETUP_TOKEN`. Never use `--remote`.

## `dist/` policy

- Commit source changes first, one commit per fix group. Then rebuild once in the real repo with `CI=true pnpm -r --filter='!playground' build`, run `node scripts/check-dist-drift.mjs`, and commit the output separately as "Rebuild package dist output".
- The drift check accepts rebuilt `.d.ts` files whose members only changed order, and puts back their committed copy. Do not commit that noise.
- `ui/` ships as source and needs no rebuild.
- This policy stays until the "Publish from CI" item in ROADMAP.md's "After publish" workstream is done. That item comes after the first npm publish and after sites have switched to the npm packages.

## Commits

- One focused commit per fix group on `main`. Never push unless asked.
- Author and committer are both `Jakob Holmelund <jakobholmelund@users.noreply.github.com>`. The global git config may hold another address, so set both explicitly:

  ```sh
  GIT_COMMITTER_NAME="Jakob Holmelund" GIT_COMMITTER_EMAIL="jakobholmelund@users.noreply.github.com" \
    git commit --author="Jakob Holmelund <jakobholmelund@users.noreply.github.com>" -m "..."
  git log -1 --format='%an <%ae> | %cn <%ce>'
  ```

- Commit messages are an imperative subject, optionally with a short body. Docs (CHANGELOG, RELEASE, READMEs) go in their own commit when they cover several groups.

## Settings

- Worker settings, secrets and the default Workflow binding use `TALISMAN_*` names. A `GALAXY_*` name is still read when the `TALISMAN_*` one is missing or blank, with a one-time deprecation warning. Read settings through `readSetting` and `readBinding` in `packages/talisman-cms/src/env.ts`, and never add new `GALAXY_*` names.
- Database tables keep their `galaxy_` prefix. Do not rename tables.

## Migrations

- `packages/talisman-cms/drizzle/NNNN_name.sql` are hand-written SQL files applied with `wrangler d1 migrations apply`. The Drizzle schema is a query-builder view; it does not model triggers, CHECKs or partial indexes. The core currently also owns the ecommerce tables.
- For a new migration: take the next number, add one entry to `drizzle/meta/_journal.json` (next `idx`, `when` one higher than the last), add it to `test/migrations.test.mjs` and to any plugin test migration lists, and describe it in RELEASE.md (deployment gate step 1, with a read-only pre-check if it adds a unique index), the CHANGELOG and the core README's migrations section. When parallel groups work on migrations, add each file exactly once.
- Migrations must reach a site's D1 before the Worker that needs them; 0.1 adds `0019` to `0030`. The order and pre-checks are in RELEASE.md#deployment-gate. Only the owner runs remote migrations, deploys or publishes.

## Publishing

Follow RELEASE.md: `pnpm release:publish --dry-run`, then `pnpm release:publish` from a clean, pushed `main`. Never use `npm publish` or `--no-git-checks`. Publishing is the owner's step.

## Owner decisions

- Email goes only through Cloudflare Email Service. Resend support was removed; do not add it back.
- The daisyUI and Starwind plugins stay in this repository as packages.
- The ecommerce plugin keeps checkout disabled unless `TALISMAN_COMMERCE_CHECKOUT_ENABLED` is `true`. Keep that default until the commerce launch workstreams in ROADMAP.md are done.

## Public repository

- No secrets, personal email addresses, real resource ids or production domains in commits, issues or docs. Two uses are deliberate and stay: the contact address in SECURITY.md, and the domain and addresses that tests use as fixtures (`packages/*/test/`). Do not replace them.
- Write abuse-related issues and roadmap items as the rule to enforce, not as steps to exploit or as a description of how today's code can be misused. Do not tie known weaknesses to any live deployment; site-specific work belongs in that site's private repository.
- New vulnerabilities are reported privately as SECURITY.md describes, not in public issues.

## Roadmap and audit context

- ROADMAP.md lists the workstreams, their order and an issue per item. Its "Audit refs" are finding keys from the pre-release audit of 25 September 2026. The full audit records lived in a session scratchpad and are not kept; each issue carries the context it needs.
- If ROADMAP.md still shows `#TBD-<id>` placeholders, its issues have not been created yet. Leave the placeholders in place; the maintainer replaces them in one pass when the issues are created.
- Site-specific work, including a site's deploy and release checklist, is tracked in that site's own repository (see `CLAUDE.local.md`), not here.

## How to work

- Use one workflow per workstream (or per tracking issue). Group the findings that share a fix, and make each group one commit.
- Verify every group in a clone as described above, including the checks of a site that links these packages when shared code changed, before committing in the real repo.
- After the source commits, rebuild `dist/` and commit it separately, then update CHANGELOG and RELEASE.md where behaviour or deployment steps changed.
- Report owner actions (dashboard changes, remote migrations, secrets, deploys, publishing) instead of doing them.
