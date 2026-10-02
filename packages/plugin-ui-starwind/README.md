# @talisman-cms/plugin-ui-starwind

**Two custom Talisman blocks and two custom components, styled with Tailwind CSS. No upstream Starwind component is implemented.** The `starwind` library ID and existing slugs are retained for stored content, while the editor names the library **Starwind (Talisman compositions)** and labels each item **(custom)**.

This package does not import `@starwind/ui`, require Starwind styles, or provide its 46 upstream components. The checked-in upstream snapshot is an inventory of unsupported entries, not a list of available page-builder items.

## Shipped compositions

| Kind | Stable slug | Editor name | Content and composition |
| --- | --- | --- | --- |
| Block | `starwindSplitFeature` | Split Feature (custom) | `eyebrow`, required `title` and `description`, optional `mediaUrl` and `mediaAlt`; `links` accepts Text Link, `metrics` accepts Metric Stat |
| Block | `starwindMetricsBand` | Metrics Band (custom) | required `title`, optional `description`; `items` accepts Metric Stat |
| Component | `starwindMetric` | Metric Stat (custom) | required `value` and `label`, optional `summary`; Growth Metric example preset |
| Component | `starwindTextLink` | Text Link (custom) | required `label` and `href` |

Both blocks accept inline components and saved component presets in their slots. These are editorial and storefront compositions, with responsive layouts, wrapping text and visible keyboard focus on links. They do not add commerce behavior or enable checkout. `starwindUiPlugin()` registers only this library; it adds no endpoint, global or admin screen.

## Setup

Install in an existing Talisman Astro site with Tailwind CSS v4.1 or later (the consumer checks use v4.3.3):

```bash
pnpm add @talisman-cms/plugin-ui-starwind
```

```ts
import talismanCms from 'talisman-cms';
import { starwindUiPlugin } from '@talisman-cms/plugin-ui-starwind';

talismanCms({
  plugins: [starwindUiPlugin()],
  collections: [{
    slug: 'pages',
    name: 'Pages',
    fields: [{
      name: 'layout',
      label: 'Page Layout',
      type: 'blocks',
      blocksFromPlugins: ['starwindSplitFeature', 'starwindMetricsBand'],
    }],
  }],
});
```

The renderer scan is the library's only setup requirement. For a stylesheet at `src/styles/global.css`, add:

```css
@import "tailwindcss";
@source "../../node_modules/@talisman-cms/plugin-ui-starwind/src/renderers";
```

Adjust the path relative to your stylesheet. Tailwind normally ignores dependencies in `node_modules`; installing the plugin alone does not produce its CSS. Import the stylesheet in your layout. The manifest includes this actual requirement, with no optional upstream package or style requirements.

## Editing and rendering

Choose **Split Feature (custom)** or **Metrics Band (custom)** from the block library. Use the block inspector for its content, then add inline components or a saved preset from the outline's slots. Text Link is suitable for Split Feature's `links`; Metric Stat is suitable for both metric slots. Create reusable content in **Component Presets**, choosing **Starwind (Talisman compositions)** and the component type. The Growth Metric definition is an example; saved preset records supply the actual preset references used by the renderer.

Render page entries using the core renderer. For saved presets, pass a map of fetched `_ui_component_presets` records so the core resolves their serialized props:

```astro
---
import BlocksRenderer from 'talisman-cms/render/BlocksRenderer.astro';
import { buildPresetMap } from 'talisman-cms/render';
const { blocks, presetEntries } = Astro.props;
---
<BlocksRenderer blocks={blocks} presetsById={buildPresetMap(presetEntries)} />
```

The plugin registers the module paths automatically. You can also import any shipped renderer directly from `@talisman-cms/plugin-ui-starwind/renderers/StarwindMetric.astro` (or the other filenames in `src/renderers`). Blocks rendered directly still use the registered core slot renderers.

Text is escaped by Astro, and malformed non-text values are omitted. Text Link supports relative URLs, fragments, queries, HTTP(S), `mailto` and `tel`. An empty or unsupported URL renders the label as plain text; an empty label renders nothing. The exported `safeHref(value, fallback = '#')` helper retains its existing fallback API. Image sources accept relative and HTTP(S) URLs. Describe meaningful images with `mediaAlt`; an empty description makes the image decorative (`alt=""`). Existing content can add this optional field without a data migration.

## Catalog and coverage

[`catalog.manifest.json`](./catalog.manifest.json) is the registration source of truth, and `src/generated.ts` is generated from it. [`catalog.upstream.json`](./catalog.upstream.json) is the checked-in upstream inventory. No scraping or upstream downloads occur.

| Scope | Complete | Partial | Unsupported |
| --- | ---: | ---: | ---: |
| Upstream Starwind snapshot (46 entries) | 0 | 0 | 46 |

The four shipped compositions have `catalogOrigin: "custom"`. Their implementation status applies only to these Talisman compositions. Unsupported upstream entries have no renderer, adapter or setup requirements and are never registered. Passing the coverage command means the catalog is classified and shipped renderers exist; it does not mean upstream component support is complete.

## Verification commands

Run builds and tests in a sanitized repository copy as described in the root contribution instructions:

```bash
pnpm run import-catalog
pnpm run generate
pnpm run coverage
pnpm run coverage:json
pnpm run test
pnpm run test:packed
```

`import-catalog` merges the local snapshot while preserving custom metadata. `generate` checks every supported renderer before writing registrations and never creates a placeholder. `coverage` distinguishes upstream implementation from shipped custom compositions and fails for a missing renderer or generated stub.

`test` includes a real Astro build and Chrome browser checks of all four renderers, inline and saved-preset composition, hostile or malformed content, links, image descriptions, repeat instances, keyboard navigation and narrow-screen layout. Set `CHROME_PATH` when Chrome is not at the platform default. `test:packed` sequentially packs core and this plugin, installs one disposable npm consumer using pinned workspace versions, and repeats the checks with Tailwind scanning only the installed renderer source. It requires registry access and removes its own consumer and cache afterwards. The render harness supplies virtual registries from the real generated module paths; it does not test the admin integration.

For the actual page builder, prepare a fresh local playground build, apply its existing migrations locally and start its preview as the root instructions describe. Then run:

```bash
STARWIND_E2E_BASE_URL=http://127.0.0.1:8793 \
STARWIND_E2E_SETUP_TOKEN=<fresh-playground-setup-token> pnpm run test:editor
```

This local-only flow creates a throwaway admin if needed, authors a metric preset, composes both custom blocks with inline components and a preset, saves and reloads the page, and removes its created page and preset. It reports shared core picker issues separately. It uses fixed test account credentials and is intended for a disposable database. No publication, remote migration, payment, email or deployment gate is exercised by these checks.
