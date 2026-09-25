# @talisman-cms/plugin-ui-daisyui

Manifest-first daisyUI library adapters for Talisman CMS.

## What It Adds

This plugin registers a `daisyui` UI library in Talisman and ships:

- Source-mapped adapters for every upstream daisyUI catalog item in the checked-in manifest
- One Talisman-specific composed block, `daisyFeatureGrid`, built from the upstream Card adapter
- Renderer wiring and preset exports generated from `catalog.manifest.json`

## Setup

Install the plugin and make sure the site already has daisyUI available in its Tailwind pipeline.

```bash
pnpm add @talisman-cms/plugin-ui-daisyui
```

```ts
import talismanCms from 'talisman-cms';
import { daisyUiPlugin } from '@talisman-cms/plugin-ui-daisyui';

talismanCms({
  plugins: [daisyUiPlugin()],
});
```

The checked-in manifest tracks these requirements:

- Install `daisyui`
- Enable the daisyUI plugin in your Tailwind or Astro CSS pipeline
- Optionally configure a daisyUI theme

With the Tailwind v4 setup already used in this repo, that means:

```ts
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
```

```css
@import "tailwindcss";
@plugin "daisyui";
```

## Mapping

The canonical source of truth is [`catalog.manifest.json`](./catalog.manifest.json). `src/generated.ts` is derived from it.

- `accordion` -> `daisyAccordionList`
- `button` -> `daisyButtonAction`
- `alert` -> `daisyAlertNotice`
- `avatar` -> `daisyAvatarProfile`
- `badge` -> `daisyBadgePill`
- `breadcrumbs` -> `daisyBreadcrumbTrail`
- `calendar` -> `daisyCalendarCard`
- `card` -> `daisyFeatureCard`
- `chat-bubble` -> `daisyChatBubble`
- `collapse` -> `daisyCollapsePanel`
- `countdown` -> `daisyCountdownTimer`
- `diff` -> `daisyDiffCompare`
- `divider` -> `daisyDividerRule`
- `drawer` -> `daisyDrawerShell`
- `dropdown` -> `daisyDropdownMenu`
- `hero` -> `daisyHeroBanner`
- `indicator` -> `daisyIndicatorBadge`
- `join` -> `daisyJoinGroup`
- `kbd` -> `daisyKeycap`
- `link` -> `daisyTextLink`
- `list` -> `daisyItemList`
- `loading` -> `daisyLoadingIndicator`
- `mask` -> `daisyMaskFrame`
- `menu` -> `daisyMenuList`
- `mockup-browser` -> `daisyMockupBrowser`
- `mockup-code` -> `daisyMockupCode`
- `mockup-phone` -> `daisyMockupPhone`
- `mockup-window` -> `daisyMockupWindow`
- `modal` -> `daisyModalDialog`
- `navbar` -> `daisyNavbarBar`
- `pagination` -> `daisyPaginationNav`
- `progress` -> `daisyProgressBar`
- `rating` -> `daisyRatingStars`
- `skeleton` -> `daisySkeletonBlock`
- `stack` -> `daisyStackDeck`
- `stat` -> `daisyStatCard`
- `status` -> `daisyStatusDot`
- `steps` -> `daisyStepsList`
- `swap` -> `daisySwapToggle`
- `table` -> `daisyDataTable`
- `tabs` -> `daisyTabsNav`
- `text-rotate` -> `daisyTextRotate`
- `theme-controller` -> `daisyThemeController`
- `timeline` -> `daisyTimelineTrack`
- `toast` -> `daisyToastStack`
- `tooltip` -> `daisyTooltipHint`
- `carousel` -> `daisyCarouselStrip`
- `checkbox` -> `daisyCheckboxField`
- `dock` -> `daisyDockNav`
- `fab` -> `daisyFabButton`
- `fieldset` -> `daisyFieldsetGroup`
- `file-input` -> `daisyFileInputField`
- `filter` -> `daisyFilterChips`
- `footer` -> `daisyFooterLinks`
- `hover-3d-card` -> `daisyHoverTiltCard`
- `hover-gallery` -> `daisyHoverGallery`
- `input` -> `daisyTextInput`
- `label` -> `daisyFieldLabel`
- `radial-progress` -> `daisyRadialProgress`
- `radio` -> `daisyRadioGroup`
- `range` -> `daisyRangeSlider`
- `select` -> `daisySelectField`
- `textarea` -> `daisyTextareaField`
- `toggle` -> `daisyToggleSwitch`
- `validator` -> `daisyValidatorMessage`
- `grid` -> `daisyFeatureGrid` as a Talisman-only composed block

## Coverage

Coverage is audited against [`catalog.upstream.json`](./catalog.upstream.json).

- Total upstream items: 65
- Complete: 65
- Partial: 0
- Unsupported: 0
- Custom Talisman items: 1

`complete` means the manifest entry is classified, has adapter metadata, and has a renderer mapping.

## Known Limitations

- All upstream daisyUI items in the checked-in catalog are now mapped and classified as `complete`.
- `daisyFeatureGrid` is a Talisman composition, not a direct upstream daisyUI catalog item.
- Some highly interactive or form-heavy daisyUI patterns are represented as pragmatic Talisman-friendly previews rather than full behavior clones.
- The plugin does not fetch upstream docs at runtime; refreshes happen through the import workflow.

## Commands

```bash
pnpm run import-catalog
pnpm run generate
pnpm run coverage
pnpm run coverage:json
pnpm run test
```

`import-catalog` merges the checked-in upstream snapshot into the manifest while preserving handwritten adapter metadata. `generate` rewrites `src/generated.ts` and creates missing renderer stubs for supported entries. `coverage` is the CI gate.
