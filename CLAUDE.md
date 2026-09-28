# Working on Talisman CMS

Notes for Claude sessions in this repository. The README describes the product; this file describes how to work on it.

## Layout

- pnpm workspace (`pnpm@10.28.0`, Node 22.12 or later). Packages in `packages/`:
  - `talisman-cms`: the core. `src/` holds the integration, API handler, auth adapters, client and SEO and rich-text helpers. `ui/` holds the admin SPA, which ships as source. `src/db/schema.ts` and `src/auth/local-schema.ts` are the Drizzle schema files, `drizzle/` holds the migrations drizzle-kit generates from them (`drizzle.config.ts`), `seeds/` the demo seed, `test/` the node tests.
  - `plugin-ecommerce`, `plugin-stripe`, `plugin-analytics`, `plugin-ui-daisyui`, `plugin-ui-starwind`. `plugin-ecommerce` also holds `src/schema.ts`, the commerce schema with its `relations`, `src/db.ts`, the plugin's Drizzle client with the batch helpers, `drizzle/`, its generated migrations and the hand-written trigger migration, and `src/admin/`, the Commerce admin section, its workspace and the product editor's options panel.
- `playground/`: a private Astro site with placeholder Wrangler resources, used by `pnpm release:verify`.
- `scripts/`: release verification, the migrations check (`pnpm db:check`), the packed-tarball smoke test, the archive check, the dist drift check and the publish script.
- Docs: `README.md`, `RELEASE.md` (publish and deploy gates), `CHANGELOG.md`, `SECURITY.md`, `ROADMAP.md`, `packages/plugin-ecommerce/PRODUCTION_READINESS.md`.

This repository is public and Apache-2.0. A private site may use these packages from a local checkout: it links them with `link:` and points its D1 `migrations_dir` at the folder the integration assembles from the CMS packages (`node_modules/.talisman-cms/migrations`, written by `astro sync` and every build), so a change here can break it. Check such a site too when you change shared APIs, settings, cookie names or migrations. If a `CLAUDE.local.md` sits next to this file, it names the site, where it lives and how to check it. That file is kept out of git through `.git/info/exclude`; keep site names, paths and other private details there, not here.

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
- Browser checks run against the built playground in the clone, never in the real repository. Write a fresh throwaway `playground/.dev.vars` first, for example `printf 'TALISMAN_AUTH_SECRET=%s\nTALISMAN_AUTH_SETUP_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > playground/.dev.vars`, and write it before `pnpm --filter playground build`: the Cloudflare adapter copies it into `playground/dist/server/` at build time (after a build, copy it there by hand). Then `pnpm --filter talisman-cms db:migrate:local` (the playground build wrote the assembled migrations folder its `wrangler.toml` names), `pnpm --filter talisman-cms db:seed:ecommerce:local` and `pnpm --filter playground exec astro preview --host 127.0.0.1 --port 8787`, which runs `wrangler dev` on the built Worker as a detached daemon (`astro preview stop` ends it). `node e2e/admin-flows.mjs --base-url http://127.0.0.1:8787 --dist <clone>/playground/dist`, run from the real repository, drives the admin's editing flows in the installed Chrome with playwright-core and records the client chunk sizes; the first run against a fresh database needs the setup token in `TALISMAN_E2E_SETUP_TOKEN`. Never use `--remote`.

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

## Database access

- The Drizzle schema files are the source of truth for the database: `packages/talisman-cms/src/db/schema.ts` and `src/auth/local-schema.ts` for the core, `packages/plugin-ecommerce/src/schema.ts` for the commerce tables. Everything the database enforces is declared there and nowhere else: columns and defaults, `.unique()`, `index` and `uniqueIndex` (partial ones with `.where(sql\`...\`)` spelled with literals, expression ones such as `lower(...)` with `sql`), `references()` with its `onDelete`, and `check()` constraints with literals. Triggers are the one exception (see Migrations). The migration tests compare the built schema with the migrated database, so a rule that is not declared fails them. A status or kind column is `text(name, { enum: CONSTANT })` with the constant exported from the schema and reused by its `check()` and by the admin field options; add a value to the constant, never to a literal list. The `relations` block at the end of the plugin schema declares a relation for every foreign key in both directions (`test/relations.test.mjs` fails when one is missing), the catalog junctions as `.through()` relations, and the links the schema keeps without a key.
- Read and write through Drizzle (`createDbClient(env)` in the core, `commerceDb(env)` from `src/db.ts` in the ecommerce plugin, and the package's `schema.ts`) wherever the query builder expresses the statement on its own: selects, inserts, updates and deletes with column conditions, `.returning()`, `onConflictDoNothing` and `onConflictDoUpdate`, and small `sql` fragments such as `version + 1`. A read that joins or nests goes through the relational query builder the plugin's client carries: `db.query.<table>.findMany({ columns, where, with, orderBy })` is one statement that returns typed nested rows (`loadBasketCatalog`, `describeOrderItems`, `loadShipments`, `loadReservations`, `readCatalog`); a relation name in `where` is an EXISTS filter, and `orderBy` takes a callback for `rowid`. Ids go through `chunked()` (80 per list, because a nested read binds a few parameters of its own under D1's limit of 100), and the chunks of several reads run as one round trip with `batchGroups(db, { name: queries })`. Take row types from the schema (`typeof table.$inferSelect`), never from a hand-written `.first<{ ... }>()` shape, and pass timestamp columns `Date` values (the schema maps them to Unix seconds).
- Raw `env.DB.prepare()` is for what the builder does not express: `INSERT ... SELECT`, correlated subqueries and JSON functions in the select list, `CASE` expressions, dynamic table or column names, the `MAX(updated_at + 1, ?)` stale-write guards, statements whose literals let SQLite use a partial index (a bound parameter does not), and a batch whose statements are such text or come from a shared helper (`fullRefundStatements`, `commerceEmailStatement`) as `D1PreparedStatement`s: a batch is one unit, so it stays on `env.DB.batch()` whole. A batch whose statements the builder expresses runs through `db.batch()` instead (variants.ts; a guard is a `db.get(sql\`...\`)` item). A raw select may also read a column list it shares with such a statement (`ORDER_AMOUNT_COLUMNS`). Column names in raw SQL are strings tsc cannot check, so a raw statement earns its place only by needing one of these; do not add raw SQL for a plain read or write. SQL that is generated as text for `wrangler d1 execute`, such as the seed file `packages/plugin-ecommerce/src/catalog.ts` writes, and the analytics plugin's reporting queries (CTEs, `UNION ALL`, `json_each`, aggregates; the plugin has no Drizzle dependency) are not database access in this sense and stay SQL.
- The packages are built on Drizzle ORM 1.0: the `devDependencies` (root `drizzle-kit`, the core, the ecommerce plugin and the playground) use Drizzle's `rc` dist-tag, which the lockfile resolves to `1.0.0-rc.4`, and the peer range is `^1.0.0-rc.4`, since a peer cannot be a tag. Never put a caret on the prerelease in a devDependency: it resolves to the newest commit build (`1.0.0-rc.5-<hash>`), while `rc` follows only the tagged release candidates. When 1.0.0 ships, move both to `^1.0.0` deliberately; the `rc` tag stays behind. The packed smoke test installs the version the workspace resolved and checks the READMEs' install steps use the devDependency's specifier. In 1.0 `drizzle()` takes no `schema`; `db.query` needs `relations` from `defineRelations`, which `createDbClient(env, relations)` passes on (the core's own reads use the select builder, `.get()`, `.all()`; the plugin's `commerceDb(env)` has both); generated SQL parenthesizes each operand of `and()`, and a failed statement, its preparation included, arrives as a `DrizzleQueryError` whose `cause` is the driver's error. Read a column's kind through `columnKind` (`packages/talisman-cms/src/db/column-kind.ts`), never by comparing `dataType` strings, which 1.0 renamed.

## Migrations

- drizzle-kit generates the migrations from the schema files; nothing is written by hand except triggers. Each package has a `drizzle.config.ts` and a `drizzle/` folder with one folder per migration, `<timestamp>_<name>/`, holding `migration.sql` and drizzle-kit's `snapshot.json` (kept in git, not published). To change the database: edit the schema, run `pnpm --filter talisman-cms db:generate --name <what_changed>` or `pnpm --filter @talisman-cms/plugin-ecommerce db:generate --name <what_changed>`, read the `migration.sql` it wrote, and commit the folder with the schema change. Never edit a migration a database has applied; after 0.1's first deployment, every change is a new migration.
- Triggers: drizzle-kit does not model them. `pnpm --filter @talisman-cms/plugin-ecommerce db:generate:custom --name <name>` writes an empty migration; put the `CREATE TRIGGER` statements in it, separated by `--> statement-breakpoint`. The commerce triggers are in `..._commerce_triggers`, and `packages/plugin-ecommerce/test/migrations.test.mjs` pins their list. SQLite drops a table's triggers with the table, so when a generated migration rebuilds a triggered table (`CREATE TABLE __new_...`, copy, `DROP TABLE`, rename), add that table's `CREATE TRIGGER` statements at the end of the same file.
- D1 rule for rebuilds: drizzle-kit opens a table rebuild with `PRAGMA foreign_keys=OFF;` and closes it with `PRAGMA foreign_keys=ON;`. D1 always enforces foreign keys inside a migration, so the rebuild fails on a populated table and `DROP TABLE` cascades into child rows. Replace the pair with one `PRAGMA defer_foreign_keys = true;` at the top of the file. The migration tests and `pnpm db:check` refuse a migration that contains `PRAGMA foreign_keys`.
- Order and names: the integration copies the core's and every plugin's migrations into one folder (`node_modules/.talisman-cms/migrations`) as flat `<timestamp>_<name>.sql` files, and wrangler applies them by the number before the first `_` and records each name. drizzle-kit's timestamps keep packages apart without coordination; a shared name or number fails the build; a name never changes once applied. Generate the core's migration before a plugin migration that references its tables. The assembler (`packages/talisman-cms/src/migrations.ts`) also accepts plain `<number>_<name>.sql` files, for plugins that write SQL by hand.
- `pnpm db:check` (a step of `release:verify`, after the build) proves the migrations match the schema: drizzle-kit's export of each schema, applied to an empty database, must give what the migrations build (tables, columns, indexes, keys, CHECKs; the plugin's triggers on top), and drizzle-kit must see no change against the last snapshot. The migration tests check the same from the built schema and that every migration applies with foreign keys on.
- drizzle-kit 1.0 shapes to know: a text primary key is written as `text PRIMARY KEY` without `NOT NULL` (SQLite then accepts a NULL id; the packages never write one); a boolean default is `false`/`true`; `.unique()` becomes an inline `UNIQUE` with an `sqlite_autoindex` name, so an index a query plan or a test names must be a named `uniqueIndex`.
- Migrations must reach a site's D1 before the Worker that needs them; RELEASE.md#deployment-gate has the order. 0.1 starts the history from an empty database: a database that applied the pre-release chain is recreated, not upgraded. Only the owner runs remote migrations, deploys or publishes.

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
