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

The release build is validated with Astro 7. Apply D1 migrations through `0019_shared_customer_identity.sql` before deploying the matching Worker; without `0019`, local and hybrid CMS sign-ins and shopper account reads fail. Public commerce checkout remains disabled pending the separate [commerce launch gates](packages/plugin-ecommerce/PRODUCTION_READINESS.md).
