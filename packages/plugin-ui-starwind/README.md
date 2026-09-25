# @talisman-cms/plugin-ui-starwind

Manifest-first Starwind library adapters for Talisman CMS.

## What It Adds

This plugin registers a `starwind` UI library in Talisman and ships:

- A full checked-in upstream Starwind component catalog snapshot
- Generated library registration from `catalog.manifest.json`
- Four Talisman-specific composed adapters that preserve the current runtime behavior:
  `starwindMetric`, `starwindTextLink`, `starwindSplitFeature`, and `starwindMetricsBand`

## Setup

Install the plugin and make sure the site has the Starwind styles it needs.

```bash
pnpm add @talisman-cms/plugin-ui-starwind
```

```ts
import talismanCms from 'talisman-cms';
import { starwindUiPlugin } from '@talisman-cms/plugin-ui-starwind';

talismanCms({
  plugins: [starwindUiPlugin()],
});
```

The checked-in manifest tracks these requirements:

- Install `@starwind/ui` when you want the upstream package available
- Import the Starwind CSS layer used by your site

## Mapping

The canonical source of truth is [`catalog.manifest.json`](./catalog.manifest.json). `src/generated.ts` is derived from it.

- Official upstream components are cataloged in [`catalog.upstream.json`](./catalog.upstream.json)
- The currently shipped Talisman adapters are intentionally marked as `custom` because they are composed blocks and components rather than direct one-to-one upstream exports

## Coverage

Coverage is audited against the upstream snapshot.

- Total upstream items: 46
- Complete: 0
- Partial: 0
- Unsupported: 46
- Custom Talisman items: 4

This is still full catalog coverage because every official Starwind item is explicitly classified in the manifest. The plugin keeps its current runtime behavior through the custom composed adapters until direct upstream mappings are added.

## Known Limitations

- No official Starwind upstream component is mapped directly yet.
- The current blocks and components are Talisman-specific compositions.
- The plugin does not fetch or scrape Starwind docs at runtime.

## Commands

```bash
pnpm run import-catalog
pnpm run generate
pnpm run coverage
pnpm run coverage:json
pnpm run test
```

`import-catalog` merges the checked-in upstream snapshot into the manifest while preserving handwritten adapter metadata. `generate` rewrites `src/generated.ts` and creates missing renderer stubs for supported entries. `coverage` is the CI gate.
