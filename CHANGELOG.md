# Changelog

## Release candidate: talisman-cms 0.1.0 and plugins 0.0.1

- Initial publishable Talisman CMS packages for Astro and Cloudflare D1, with optional R2 media and KV caching.
- Draft, publish, archive, and restore transitions retain revisions atomically. Admin API clients now send `expectedRevisionId`; stale changes return HTTP 409.
- Media uploads accept bounded raster images validated by file signature. Legacy active uploads are served as downloads with restrictive headers.
- Collection access rules restrict native commerce tables to administrators. Cart and customer records are read-only in the generic CMS editor.
- Adds the analytics plugin and package archive checks to CI. Package manifests and archives use Apache-2.0.

The release build is validated with Astro 7. Apply D1 migrations through `0018_entry_revision_integrity.sql` before deploying the matching Worker. Public commerce checkout remains disabled pending the separate [commerce launch gates](packages/plugin-ecommerce/PRODUCTION_READINESS.md).
