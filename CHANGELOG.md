# Changelog

## Release candidate: talisman-cms 0.1.0 and plugins 0.0.1

- Initial publishable Talisman CMS packages for Astro and Cloudflare D1, with optional R2 media and KV caching.
- Draft, publish, archive, and restore transitions retain revisions atomically. Admin API clients now send `expectedRevisionId`; stale changes return HTTP 409.
- Media uploads accept bounded raster images validated by file signature. Legacy active uploads are served as downloads with restrictive headers.
- Collection access rules restrict native commerce tables to administrators. Cart and customer records are read-only in the generic CMS editor.
- Adds the analytics plugin and package archive checks to CI. Package manifests and archives use Apache-2.0.
- Adds `HybridAuthAdapter` (`talisman-cms/auth/hybrid`): local passwords for editors and Cloudflare Access SSO for allowlisted admins. The new `<adminPath>/sso` route (normally `/admin/sso`) verifies the Access JWT and issues the admin's CMS session; protect only that path with Access.
- Adds `talisman-cms/auth/identity`. Its `ensureVerifiedEmailIdentity` finds or creates the single CMS user for a verified email. New users get the `customer` role, which has no CMS access.
- Migration `0019_shared_customer_identity.sql` adds `galaxy_auth_session.auth_method` and `_ecommerce_customer_accounts.cms_user_id`, lowercases CMS user emails, and enforces one CMS user per email regardless of letter case. It links shoppers who have already verified their email to `customer` users. It fails if two CMS users' emails differ only by case; run the pre-check in the [release checklist](RELEASE.md) first.
- Shoppers can create an account by requesting an email sign-in link before any purchase. Requests are limited to 20 per source IP per hour, in addition to three per account per ten minutes. Verifying the link links the shopper to the shared CMS identity; shopper sessions remain separate from CMS sessions.
- **Users** can change roles, disable, enable, and remove local accounts. In hybrid mode it adds editors, grants a verified shopper editor access with a password, and revokes CMS access instead of removing the shared identity.

### Content and API

- Entries created outside the editor (seeds, imports, raw SQL) can now be edited and published. The first save or publish of such an entry records its stored state as revision 1 in the same batch, and the request may send `expectedRevisionId: null` or leave it out. Entries that already have revisions still need `expectedRevisionId`: a missing ID returns HTTP 428 and a stale one HTTP 409.
- Migration `0020_revision_baseline_and_globals.sql` adds a baseline revision for every entry that has none, pins the published revision of published entries, and unwraps globals stored as JSON text inside a JSON string. It only changes rows that still need it, so a rerun changes nothing.
- Required text, textarea, select, date, color, media and single-relation fields reject blank or whitespace-only values, and required rich text fields reject empty documents. This applies on create, update and publish; publishing also validates the entry's draft against the collection's required fields.
- Validation errors for entries and globals return HTTP 400 with `{ error, fieldErrors, issues }`. `error` is a summary message instead of `Validation Error`, and `fieldErrors` lists messages by field name (a dotted path for nested fields).
- Globals are stored as a single JSON object. The API and `getClient().globals` always return `data` as an object, including rows and cache entries written by earlier versions. `POST /admin/api/globals/:slug` rejects data that is not a JSON object.
- Native collection updates accept `expectedUpdatedAt` and return HTTP 409 if the record changed since it was loaded. An update validates and writes only the columns it sends, and the response reports `updatedAt` as stored.
- Fields generated from native tables no longer mark `NOT NULL` columns that have a database default as required.
- The KV cache is best-effort: a failed KV read or write falls through to D1 instead of failing the request. `getClient` accepts the request's execution context so cache fills finish after the response (inside the Worker it is otherwise taken from `cloudflare:workers`). A fill is dropped when the content it read was changed or hard-deleted while the read was in flight, so stale content is not cached for the TTL.

### Admin

- Entry editor: after the first save of a new entry, Save and Publish work without reloading (no more 428 "expectedRevisionId is required"), and publishing a new entry and then saving no longer returns 409.
- Entry editor: when a save is refused because the entry or record changed elsewhere (409), your edits stay in the form. You can load the latest version, copy your changes, or put back only the fields you changed. Other fields keep their latest values, so another editor's changes and stock reserved by checkouts are not overwritten. A refused Publish, Archive or Restore with no unsaved edits loads the latest version and asks you to retry.
- Entry editor: saving a native record, such as a product, sends the `updatedAt` it loaded, so stale saves are refused. Stock and inventory quantities are sent only when you change them, in the product form and in the options & stock section, so editing a product no longer overwrites stock that checkout has reserved. Native records no longer request revision history.
- Entry editor: validation errors show readable messages (never "[object Object]") under each field, in the block inspector, and in a summary that names the field. Blocks with invalid fields are marked in the page outline. Server, network and expired-session errors are explained in plain words.
- Entry editor: warns before leaving or reloading with unsaved changes, and asks before restoring a revision over unsaved edits. Edits made in the raw JSON view are kept when switching back to the form.
- Entry editor: Publish and Archive no longer add an extra draft revision when there are no unsaved changes.
- Entry editor: media fields upload to and browse the media library under the configured admin path, and Browse loads the library once instead of sending requests in a loop.
- Globals: saving a global with configured fields keeps the saved values in the form, so a second save no longer undoes the first, and the **Updated** time refreshes. Validation errors are shown next to each field and in a summary under the form.
- Globals: the raw JSON editor for globals without configured fields keeps what you type, saves exactly that document, keeps the **Saved** notice visible, and refuses JSON that is not an object with a clear message.
- Editors no longer see screens they cannot use: **New Global**, **Users**, **Ask Analytics** and the admin-only commerce tools. Opening one directly explains that admin access is required. The sidebar instead links editors to the commerce content collections they can edit.
- With hybrid auth, **Sign out** for Cloudflare SSO admins also ends the Cloudflare Access session. The button and the **Account** page say so, and a failed sign-out is reported. With Access auth, the "not authorized" screen offers a link to sign out of Cloudflare Access.
- **Users** reports a successful role change or access revocation as successful, shows server warnings (for example when existing sessions could not be ended), and refreshes the list after a failed action. It can re-enable a disabled account that no longer has CMS access, such as a disabled shopper account.

### Authentication and users

- Sign-in rate limits are kept per client, keyed on `CF-Connecting-IP`, instead of in one shared bucket; `X-Forwarded-For` is ignored. The Cloudflare SSO sign-in is not subject to other clients' limits, so failed password attempts can no longer lock the SSO admin out, and it no longer rewrites the admin's stored credential on every sign-in.
- Password sign-in no longer reveals which emails belong to admins or shoppers. In hybrid mode an admin or shopper email gets the same HTTP 401 "Invalid email or password" as a wrong password, instead of a 403. With plain `LocalAuthAdapter`, a `customer` account that still has a password gets that 401 and no session.
- Admin actions reject a non-string `userId` or `role` with HTTP 400.
- CMS sessions end 7 days after sign-in, even if they are used continuously. The 12-hour inactivity timeout still applies.
- Fixed: changing a user's role (including **Revoke CMS access** in hybrid mode), resetting a password, granting editor access or disabling a user no longer returns a server error after the change is saved, and the user's existing CMS sessions are ended as intended. If ending them fails, the auth API returns 200 with a `warning` field, because the change itself was saved. Role changes and disabling still take effect immediately.
- A disabled account that lost CMS access keeps the `customer` role and can be re-enabled with **Enable** (`admin/unban-user`) without gaining CMS access; it gets none until an admin grants a role. **Add editor** on such an account while it is still disabled returns HTTP 409 and asks you to enable it first.

### Settings

- Worker settings and the default Workflow binding are renamed from `GALAXY_*` to `TALISMAN_*`, for example `TALISMAN_AUTH_SECRET`, `TALISMAN_ACCESS_*`, `TALISMAN_COMMERCE_*` and `TALISMAN_PUBLISH_WORKFLOW`. A `GALAXY_*` name is still read when its `TALISMAN_*` name is missing or blank, and the Worker logs a one-time deprecation warning. To migrate, rename each key and keep its value.
- New `talisman-cms/env` export for plugins and sites: `readSetting(env, name)` and `readBinding(env, name)` read `TALISMAN_<name>` and fall back to `GALAXY_<name>`.
- Setting values are trimmed, and a blank value counts as unset.
- Live preview: the admin now broadcasts `TALISMAN_ENTRY_SAVED`. `LivePreview` accepts both the `TALISMAN_ENTRY_*` and the old `GALAXY_ENTRY_*` message types; custom preview listeners should switch to `TALISMAN_ENTRY_*`.
- The `galaxy_` database table prefix is internal and permanent; no migration is needed.

### Email

- New `talisman-cms/email` export, safe to import outside the Worker. It provides the `EmailProvider` interface, `EmailDeliveryError` (with a `code` and `retryable`), `sendEmail`, which blocks header injection and adds `Auto-Submitted: auto-generated` and `X-Talisman-Email` headers, `parseAddress`, the Cloudflare Email Service `send_email` provider, a console provider that runs only on localhost, `renderTransactionalEmail`, `escapeHtml` and `customEmail()`.
- New Worker-only `talisman-cms/email/runtime` export with `getEmailProvider(env)` and `sendConfiguredEmail(env, message)`. `TALISMAN_EMAIL_PROVIDER` chooses the provider (`cloudflare`, `console`, `custom` or `none`), configured by `TALISMAN_EMAIL_FROM`, `TALISMAN_EMAIL_REPLY_TO`, `TALISMAN_PUBLIC_ORIGIN` and `TALISMAN_EMAIL_BINDING` (default `EMAIL`). With the setting unset, a registered provider is used, then a binding named `EMAIL`.
- New `email` integration option registers a custom email provider: `talismanCms({ email: customEmail({ moduleId, exportName, args }) })` is validated when the config loads and served to the Worker as `virtual:talisman-cms/email`.

### Ecommerce plugin

- Breaking: shopper sign-in email goes through the Talisman CMS email provider, by default a Cloudflare Email Service `[[send_email]]` binding named `EMAIL`. Built-in Resend support and `RESEND_API_KEY` are removed; register Resend or another HTTP email API as a custom provider.
- The sign-in sender falls back from `TALISMAN_COMMERCE_EMAIL_FROM` to `TALISMAN_EMAIL_FROM`, and the public origin from `TALISMAN_COMMERCE_PUBLIC_ORIGIN` to `TALISMAN_PUBLIC_ORIGIN`. A trailing slash on the origin is accepted.
- Breaking for custom verify pages: sign-in links carry the token in the URL fragment (`/account/verify#token=…`), so it never reaches the server or its logs. Use the new `readCustomerSignInToken()` from `@talisman-cms/plugin-ecommerce/browser`, which also accepts older `?token=` links and removes the token from the address bar.
- When a sign-in email cannot be sent, the account API returns HTTP 503 with a readable message instead of 400. Logs include only the provider's error codes, never addresses, links or tokens. Suppressed recipients get the normal accepted response.
- New store-wide daily limit on sign-in emails, `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` (default 200). Once it is reached, the API returns HTTP 503 and `requestCustomerEmailSignIn` throws `CustomerEmailLimitError`. The per-IP sign-in limit counts IPv6 addresses per /64 prefix.
- Breaking: `GET` and `POST /api/ecommerce/cart` return only `{ id, items, locked }`. The basket session token, account id and payment session id are no longer in the response.
- `GET /api/ecommerce/cart` no longer creates a basket or sets the basket cookie. Without a basket it returns `{ id: null, items: [], locked: false }`, and the first `POST` that adds items creates the basket. Cross-origin `POST`s no longer set the cookie either.
- `POST /api/ecommerce/cart` rejects bodies over 64 KiB (413), non-JSON bodies and a non-array `items` (400) before creating a basket. Posting an empty item list with no basket writes nothing.
- New `purgeStaleCommerceData({ env, now?, batchSize? })` export from `@talisman-cms/plugin-ecommerce/api` for scheduled Workers. It deletes guest baskets idle for 30 days, shopper sessions and email sign-in links one day after they expire, are used or are signed out, expired CMS sessions, and auth rate-limit rows older than 24 hours. Deletes run in bounded batches, and the call throws if any table fails. Run it from your scheduled Worker next to `reconcileCommerce`.
- New `@talisman-cms/plugin-ecommerce/cookies` export with the basket and gift card cookie names (`talisman-cart` and `talisman-gift-<purchase id>`). Cookies set under the old `galaxy-cart` and `galaxy-gift-` names are still read, and a legacy basket cookie is adopted once.
- The shipped `CartBadge` and `CartView` components import their helpers by package name, so they work when installed from npm. `CartView` escapes its JSON data island, and `CartBadge` only reads the basket, so it no longer re-keys a signed-in shopper's basket.
- Commerce settings (checkout and gift card flags, Stripe mode and local test secrets, gift card key, referral defaults, email sender and public origin) are read as `TALISMAN_COMMERCE_*` and fall back to `GALAXY_COMMERCE_*`.
- `createCommerceCatalogSeedSql` gives each imported content entry a published baseline revision.
- The Shopper Accounts collection description now says shoppers share the CMS user for their email.
- **Test checkout** no longer shows a stray "0" when the basket is empty.

### Stripe plugin

- Stripe secrets are read from the Worker at request time and never compiled into the server bundle: `STRIPE_SECRET_KEY` (or `TALISMAN_STRIPE_SECRET_KEY`, which takes precedence) and `TALISMAN_STRIPE_WEBHOOK_SECRET`. The `stripeSecretKey` and `stripeWebhooksEndpointSecret` options in `astro.config` are ignored with a warning.
- Syncs, the REST proxy and the webhook endpoint refuse to run until their secret is set. Saves that would call Stripe fail with a clear error, and the REST proxy and webhook endpoint return HTTP 503.
- The public `/api/stripe/webhooks` endpoint is added only when `webhooksModule` is set or `webhookEndpoint: true`. Signatures are verified with that endpoint's own signing secret.
- Stripe IDs are taken only from the stored record. `stripeID` and `skipSync` values sent by the admin form or API clients are ignored, and the plugin no longer adds hidden `stripeID`/`skipSync` fields to synced collections. The new `stripeIdField` option (default `stripeID`) names the field or column that holds the ID.
- Collections with a native table must have a column for the Stripe ID, and saves are refused without one. Previously the ID was dropped and every save created another Stripe resource.
- Deleting a record linked to Stripe requires the CMS admin role and a configured key. Linked products and prices are archived in Stripe (`active: false`) instead of deleted; customers are still deleted.
- The `./routes/*` export resolves to built files in `dist/`, and the package no longer ships or imports TypeScript source. Stripe calls use the fetch HTTP client, so they work in Workers.
- Adds a README covering installation, configuration, required secrets, what is synced, and security notes.

### UI plugins

- daisyUI and Starwind: theme values are checked against an allowlist before they reach `<style>`, on save and again when rendered. Page-builder `href` and `src` values and inline styles are sanitised. The preview page and the theme and layout APIs require a CMS session, and the preview no longer loads the Tailwind Play CDN. The `glob-test` debug route is removed, and daisyUI's MIT notice ships in `NOTICE`.

### Packaging

- `talisman-cms` declares `astro`, `drizzle-orm`, `react` and `react-dom` as peer dependencies and no longer bundles drizzle-orm. Plugins declare `talisman-cms` (`^0.1.0` when packed) and `astro` as peers, plus React or drizzle-orm where they use them. React is deduplicated for the admin SPA, which fixes a blank `/admin` under `astro dev` with installed packages.
- Packages are ESM-only, and each build clears `dist/` first. Manifests declare `repository`, `homepage`, `bugs` and Node `>=22.12.0` in `engines`.
- Publishing requires pnpm: `prepublishOnly` stops `npm publish`, which would ship unresolved `workspace:` ranges and no license text. Each package builds in `prepack`, so `pnpm pack` and `pnpm publish` always pack a fresh build.
- `pnpm release:verify` also packs every package, installs the tarballs into fresh Astro projects with npm and pnpm, builds them, imports every entry point and checks that `/admin` loads. Set `TALISMAN_SMOKE=0` to skip this step offline.

### Upgrading

The release build is validated with Astro 7.

- Apply D1 migrations through `0020_revision_baseline_and_globals.sql` before deploying the matching Worker; without `0019`, local and hybrid CMS sign-ins and shopper account reads fail. `0020` needs no pre-check and can be rerun safely.
- Rename `GALAXY_*` Worker settings, secrets and the Workflow binding to `TALISMAN_*`, keeping their values. The old names still work but log a deprecation warning.
- Shopper sign-in email needs an email provider (normally a `[[send_email]]` binding named `EMAIL`), a sender in `TALISMAN_EMAIL_FROM` or `TALISMAN_COMMERCE_EMAIL_FROM`, and a public origin in `TALISMAN_PUBLIC_ORIGIN` or `TALISMAN_COMMERCE_PUBLIC_ORIGIN`. `RESEND_API_KEY` is no longer read.
- Sites using the Stripe plugin must move its secrets from `astro.config` to Worker secrets.
- Public commerce checkout remains disabled pending the separate [commerce launch gates](packages/plugin-ecommerce/PRODUCTION_READINESS.md).
