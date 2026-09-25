# UI Library Manifest Workflow

Talisman UI library plugins are manifest-first.

The checked-in manifest is the canonical authoring surface for a UI library plugin. Generated source such as `src/generated.ts` is derived from it and must not become the source of truth again.

## Schema

Each plugin keeps:

- `catalog.upstream.json`: the upstream catalog snapshot used for import and coverage checks
- `catalog.manifest.json`: the canonical manifest that classifies every upstream item and any Talisman-specific custom items

Manifest entries must include:

- `upstreamItemId`
- `upstreamItemName`
- `kind`
- `category`
- `variants`
- `setupRequirements`
- `relationships`
- `coverageStatus`
- `rendererTarget` when the item renders in Talisman
- `adapter` when the item is exported to Talisman

`coverageStatus` is one of:

- `complete`: adapter metadata exists, renderer mapping exists, and the entry is exportable
- `partial`: explicitly classified, but still missing some adapter or renderer work
- `unsupported`: intentionally not exported, but still accounted for in coverage

Custom Talisman-only adapters stay in the same manifest with `catalogOrigin: "custom"`. They do not count toward upstream coverage totals.

## Update Flow

1. Refresh `catalog.upstream.json` from a manually prepared upstream metadata source.
2. Run `pnpm run import-catalog` in the plugin package.
3. Classify any new manifest entries and add adapter metadata where needed.
4. Run `pnpm run generate`.
5. Run `pnpm run coverage` and `pnpm run test`.

The import step must preserve handwritten adapter metadata. New upstream items should default to `unsupported` until they are intentionally promoted.

## Generated vs Handwritten

Use normal generated stubs when the item can be represented as:

- Plain Talisman block or component fields
- Standard renderer module mapping
- Presets that serialize to plain props

Use advanced adapters only when the item needs:

- Custom editor modules
- Custom serializer modules
- Non-standard renderer behavior beyond a normal Astro renderer mapping

If an entry is marked `complete`, the manifest must include enough metadata for generation to produce a valid adapter and renderer mapping.

## Coverage Policy

Coverage commands must report:

- Total upstream items
- Complete count
- Partial count
- Unsupported count
- Missing or unclassified items
- Custom item count

Coverage is a release gate. CI must fail when:

- An upstream item exists in `catalog.upstream.json` but not in the manifest
- A manifest entry is missing required metadata
- An entry marked `complete` has no adapter or renderer mapping
- A manifest entry claims to be upstream but no longer exists in the upstream snapshot

Human-readable output is the default. `--json` output is the machine-checkable form for automation.

## Renderer And Editor Contract

Blocks and components generated from the manifest must still compile down to the existing Talisman runtime shape:

- Blocks become `UiLibraryBlockAdapter`
- Components become `UiLibraryComponentAdapter`
- Presets are flattened onto the library definition
- `source.plugin`, `source.library`, and `source.item` are filled from manifest metadata

Block slot relationships belong in the manifest. Generation resolves those relationships into `componentsFromPlugins` slugs using the referenced manifest entries.
