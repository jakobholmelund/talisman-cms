# @talisman-cms/plugin-ui-starwind

Four page-builder blocks and components for Talisman CMS, registered as the `starwind` UI library. They are Talisman's own Astro components written with Tailwind utility classes; they do not use `@starwind/ui` components. The package also keeps a snapshot of the upstream Starwind UI catalog, so future adapters can be tracked against it. No upstream component is mapped yet.

## What It Adds

`starwindUiPlugin()` (plugin name `@talisman-cms/plugin-ui-starwind`) registers one UI library and nothing else: no global, admin screen, endpoint or page.

| Kind | Name | Fields |
| --- | --- | --- |
| UI library | `starwind` ("Starwind UI") | |
| Block | `starwindSplitFeature` ("Split Feature") | `eyebrow`, `title`, `description`, `mediaUrl`; slots `links` (`starwindTextLink`) and `metrics` (`starwindMetric`) |
| Block | `starwindMetricsBand` ("Metrics Band") | `title`, `description`; slot `items` (`starwindMetric`) |
| Component | `starwindMetric` ("Metric Stat") | `value`, `label`, `summary`; preset `starwind-growth-metric` |
| Component | `starwindTextLink` ("Text Link") | `label`, `href` |

Add the block slugs to a `blocks` field's `blocksFromPlugins`, and render entries with `talisman-cms/render/BlocksRenderer.astro`, which finds the plugin's renderers in `@talisman-cms/plugin-ui-starwind/renderers/*`. The renderers use fixed slate and cyan Tailwind colours, so the site's Tailwind build must scan them; with Tailwind v4, add an `@source` line that points at `node_modules/@talisman-cms/plugin-ui-starwind/src/renderers`. Links pass through `safeHref`, which is also exported: relative, `http(s)`, `mailto` and `tel` URLs are kept and anything else becomes `#`.

## Setup

Install the plugin. The renderers need only Tailwind CSS.

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

The checked-in manifest lists two optional requirements for future upstream adapters; the current components need neither:

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

Every upstream item is classified in the manifest, but none is implemented: the 46 upstream items are `unsupported`, and the plugin's four items are the `custom` Talisman components above.

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
